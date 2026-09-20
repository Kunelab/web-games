/**
 * Turning the catalogue into the next round.
 *
 * Everything here runs while a round is already playing, so it has a few tens of
 * seconds and no user waiting on it, and it must never fail loudly: a draw that
 * comes back short means the buffer refills more slowly, not that the game stops.
 *
 * Three rules decide what may be served, in descending order of how badly getting
 * them wrong hurts:
 *
 *  1. **It has to play in this room's country.** The whole reason the pool stores
 *     raw territory rules instead of a verdict. One pool, many rooms, one country
 *     each.
 *  2. **It must not have been played in this session.** Deduplicated on the
 *     *recording*, never on the video id, because the same song exists under
 *     several uploads and matching on the id lets it come round twice.
 *  3. **It should not be the same artist again so soon.** Not a correctness rule,
 *     but the difference between a playlist and a shuffle that keeps landing on
 *     the same person.
 */
import { blindtest, mediaReadiness, resolveTiming, type AnswerField } from 'game-core';

import type { MediaView } from './media-service.js';
import { clipWindow } from './chorus-service.js';
import {
  cachedPool,
  enrich,
  genreById,
  poolFor,
  warmPool,
  profileFor,
  sourceGenreFor,
  type Genre,
  type PoolEntry
} from './blindtest-catalog.js';
import { libraryVideoCodes } from './blindtest-library.js';
import { playableIn } from './youtube-service.js';

export interface DrawSettings {
  genreIds: string[];
  /** The difficulty window the host set, 0 to 100. */
  difficultyMin: number;
  difficultyMax: number;
  /** ISO 3166-1 alpha-2. The host's country, because the host is the stage. */
  region: string;
}

/**
 * What this session has already used.
 *
 * Kept by the caller and passed in rather than held here, because the draw is a
 * pure-ish function of the catalogue and the history, and a module-level cache
 * keyed by session code is how that becomes a leak.
 */
export interface DrawHistory {
  /** Recording keys already played. */
  playedTracks: Set<string>;
  /** Artists in play order, most recent last. Only the tail is ever read. */
  recentArtists: string[];
}

export function emptyHistory(): DrawHistory {
  return { playedTracks: new Set(), recentArtists: [] };
}

/** No artist twice inside this many rounds. */
const ARTIST_GAP = 8;

/** And no more than this many appearances across the trailing window. */
const ARTIST_WINDOW = 20;
const ARTIST_WINDOW_MAX = 2;

/**
 * How many candidates the difficulty target chooses between.
 *
 * Taking strictly the nearest would make the slider deterministic: the same
 * settings would produce the same track every time the pool refreshed. Taking the
 * nearest few and picking among them keeps the aim while leaving the result a
 * draw rather than a lookup.
 */
const TARGET_SHORTLIST = 12;

function artistBlocked(entry: PoolEntry, history: DrawHistory): boolean {
  if (!entry.artist) return false;
  const key = entry.artist.toLowerCase();

  const recent = history.recentArtists.slice(-ARTIST_GAP);
  if (recent.includes(key)) return true;

  const window = history.recentArtists.slice(-ARTIST_WINDOW);
  return window.filter((name) => name === key).length >= ARTIST_WINDOW_MAX;
}

/**
 * A facet genre only accepts entries from the era it names.
 *
 * `yearVerified` is the important half of this test. An entry's year starts out as
 * YouTube's publication date, which for a Topic upload of a back catalogue is the
 * day the label loaded it rather than the day the record came out; only the
 * catalogue lookup in `enrich` replaces it with the real one, and often finds
 * nothing at all — which is why the test is "was it verified", not "did we try".
 * Filtering on an
 * unverified year would put a 1994 track in the 2010s and quietly empty the
 * nineties, so an entry whose year has not been checked is not eligible for an
 * era facet at all. `fillPool` verifies the pools that back one.
 */
function inEra(entry: PoolEntry, genre: Genre): boolean {
  if (!genre.yearRange) return true;
  if (!entry.yearVerified || entry.year === null) return false;
  return entry.year >= genre.yearRange.from && entry.year <= genre.yearRange.to;
}

function eligible(entry: PoolEntry, genre: Genre, settings: DrawSettings, history: DrawHistory): boolean {
  if (!playableIn(entry.restriction, settings.region)) return false;
  if (history.playedTracks.has(entry.trackKey)) return false;
  if (!inEra(entry, genre)) return false;
  if (artistBlocked(entry, history)) return false;
  /**
   * The difficulty window is a filter, not only an aim.
   *
   * `pickForTarget` sorts by distance to the round's target, which keeps the
   * *ordering* right but will happily return the nearest thing available even
   * when that is nowhere near the window. A room asking for 90 to 100 over a
   * small pool was therefore served household names, and the count on the setup
   * screen — which did apply the window — described a different game from the
   * one being dealt.
   */
  if (entry.difficulty < settings.difficultyMin || entry.difficulty > settings.difficultyMax) return false;
  return true;
}

/**
 * How many rounds of each selected genre are available to this room right now.
 *
 * Feeds the setup screen's live count, which is the one thing that turns an
 * abstract set of filters into something a host can judge before committing a
 * room full of people to it. Also the early warning for a rotted playlist: a
 * genre that reports nothing has a source that needs replacing.
 */
export function countAvailable(settings: DrawSettings): {
  perGenre: { genreId: string; available: number | null }[];
  total: number;
  pending: number;
} {
  const history = emptyHistory();
  const perGenre: { genreId: string; available: number | null }[] = [];

  /**
   * Counted across genres rather than summed per genre.
   *
   * A facet and its parent share a pool, so selecting "Rap US" and "Rap 2010s"
   * offers each entry once and not twice. Summing the per-genre figures claimed
   * otherwise and overstated exactly the case a host is most likely to pick.
   */
  const counted = new Set<string>();
  let pending = 0;

  for (const genreId of settings.genreIds) {
    const genre = genreById.get(genreId);
    if (!genre) continue;

    const pool = cachedPool(genreId);
    if (pool === null) {
      // Not here yet. Ask for it, report it as unknown, and let the screen say so.
      warmPool(genreId);
      perGenre.push({ genreId, available: null });
      pending += 1;
      continue;
    }

    let available = 0;
    for (const entry of pool) {
      // The window is part of eligibility now, so this counts exactly what a draw
      // would be allowed to serve.
      if (!eligible(entry, genre, settings, history)) continue;
      available += 1;
      counted.add(entry.trackKey);
    }

    perGenre.push({ genreId, available });
  }

  return { perGenre, total: counted.size, pending };
}

/**
 * Picks one entry for a target difficulty.
 *
 * The target is rolled fresh per round inside the host's window, so a wide window
 * genuinely mixes easy and hard rounds rather than settling at its average.
 */
function pickForTarget(candidates: PoolEntry[], target: number): PoolEntry | null {
  if (candidates.length === 0) return null;

  const byDistance = [...candidates].sort(
    (left, right) => Math.abs(left.difficulty - target) - Math.abs(right.difficulty - target)
  );
  const shortlist = byDistance.slice(0, TARGET_SHORTLIST);
  return shortlist[Math.floor(Math.random() * shortlist.length)] ?? null;
}

/**
 * The genre this round comes from.
 *
 * Weighted by how much each genre actually has to offer rather than uniform,
 * because a room that picks "rap US" and "metal" should not get half its rounds
 * from a pool a tenth the size of the other. Genres with nothing left simply
 * carry no weight and drop out.
 */
function pickGenre(available: { genre: Genre; entries: PoolEntry[] }[]): { genre: Genre; entries: PoolEntry[] } | null {
  const total = available.reduce((sum, bucket) => sum + bucket.entries.length, 0);
  if (total === 0) return null;

  let roll = Math.random() * total;
  for (const bucket of available) {
    roll -= bucket.entries.length;
    if (roll <= 0) return bucket;
  }
  return available[available.length - 1] ?? null;
}

/**
 * Ids for generated rounds.
 *
 * Negative and decreasing, so they cannot collide with a `Media.id` from the
 * library: an ephemeral session's lookup map holds both when a room mixes
 * generated rounds with saved ones, and a collision would serve the wrong item.
 */
let nextEphemeralId = -1;

/**
 * Moves the counter clear of ids already in use.
 *
 * Called by `GameManager.restore`. The counter is module state, so it starts at
 * -1 again after a restart while restored sessions are still holding -1, -2, -3;
 * the next top-up would then mint an id an existing round already answers to and
 * overwrite it in that session's lookup, swapping one round's audio for
 * another's answers.
 */
export function reserveEphemeralIdsBelow(lowest: number): void {
  if (lowest < nextEphemeralId) {
    nextEphemeralId = lowest - 1;
  }
}

function toMediaView(entry: PoolEntry, difficultyTarget: number): MediaView {
  const genre = genreById.get(entry.genreId);
  const plan = clipWindow(entry.durationSeconds, {
    chorus: entry.chorus,
    profile: genre ? profileFor(genre) : undefined,
    difficulty: difficultyTarget,
    hintFraction: entry.hintFraction
  });

  const answers: AnswerField[] =
    entry.answerShape === 'artist-title'
      ? [
          {
            key: 'title',
            label: 'field.title',
            value: entry.title,
            aliases: entry.titleAliases,
            points: 3,
            tolerance: 0.17,
            directBonus: 0
          },
          {
            key: 'artist',
            label: 'field.artist',
            value: entry.artist,
            // Artist spellings only. A track-title alias here would score the
            // artist's points for naming the song.
            aliases: entry.artistAliases,
            points: 2,
            tolerance: 0.17,
            directBonus: 0
          }
        ]
      : [
          {
            key: 'work',
            // The genre names itself when it can; the catch-all only covers a
            // genre added without one.
            label: genre?.workLabel ?? 'field.work',
            value: entry.work,
            aliases: entry.workAliases,
            points: 4,
            tolerance: 0.17,
            directBonus: 0
          }
        ];

  const payload = {
    code: entry.videoId,
    startGuess: plan.startGuess,
    endGuess: plan.endGuess,
    startReveal: plan.startReveal,
    endReveal: plan.endReveal,
    volume: 100,
    /**
     * The pool's own reading of how hard this one is, carried into the round.
     *
     * Not the target the round was drawn for: the target is what the session
     * asked for and the entry is what it got, and the two are only ever as close
     * as the pool allowed. Stored on the item, so it survives into the shared
     * catalogue and can be argued with at the reveal.
     */
    difficulty: Math.round(entry.difficulty)
  };

  const item = { kind: 'blindtest', timing: null, payload };
  const now = new Date().toISOString();

  return {
    id: nextEphemeralId--,
    user_id: null,
    kind: 'blindtest',
    // Librarian-facing only; players never see it. Carries the provenance so a
    // log or the host screen can say where a round came from.
    title:
      entry.answerShape === 'artist-title'
        ? `${entry.artist} - ${entry.title} [${entry.genreId}/${plan.angle}]`
        : `${entry.work} [${entry.genreId}/${plan.angle}]`,
    category: entry.genreId,
    date: entry.year ? `${entry.year}-01-01` : null,
    answers,
    payload,
    timing: null,
    effectiveTiming: resolveTiming(item),
    readiness: mediaReadiness({ kind: 'blindtest', answers, payload }),
    created_at: now,
    last_modified: now
  };
}

/**
 * Draws up to `count` rounds, and records them as played.
 *
 * Mutating the history here rather than leaving it to the caller is deliberate:
 * the two must not drift, and every caller would otherwise have to remember to do
 * it. A short result is normal and means the room has exhausted what its settings
 * allow, which the caller handles by ending the run rather than by retrying.
 */
export async function drawRounds(settings: DrawSettings, history: DrawHistory, count: number): Promise<MediaView[]> {
  const drawn: MediaView[] = [];

  /**
   * Whatever is already in memory, and nothing waited for that is not.
   *
   * This used to `await poolFor` once per selected genre, which made a draw as
   * slow as the slowest pool it touched. Building one pool is several YouTube
   * searches, every configured playlist, a facts lookup over up to twelve
   * hundred ids and one model call to annotate the survivors — so a host who
   * ticked a dozen genres and pressed start was made to sit through a dozen of
   * those before the first song existed, with the room watching a spinner.
   *
   * The pools are shared, cached for a day and already warmed by the count the
   * setup screen asks for, so by the time anybody presses start most of them
   * are usually here. The ones that are not get asked for without being waited
   * on and join the next draw instead, which is the point: a genre arriving two
   * rounds late costs the room nothing, and a genre arriving before the first
   * round costs it a minute of silence.
   *
   * Only when nothing at all is ready does this wait, and then for exactly one
   * pool rather than all of them, because a session with no first round is not
   * a session.
   */
  const buckets: { genre: Genre; entries: PoolEntry[] }[] = [];
  const cold: Genre[] = [];
  for (const genreId of settings.genreIds) {
    const genre = genreById.get(genreId);
    if (!genre) continue;
    const entries = cachedPool(genreId);
    if (entries === null) {
      cold.push(genre);
      warmPool(genreId);
      continue;
    }
    buckets.push({ genre, entries });
  }

  if (buckets.length === 0) {
    for (const genre of cold) {
      const entries = await poolFor(genre.id).catch(() => [] as PoolEntry[]);
      if (entries.length > 0) {
        buckets.push({ genre, entries });
        break;
      }
    }
  }

  /**
   * What the shared catalogue already holds, which a *search* should never
   * return.
   *
   * A draw is the expensive half of the endless mode and its whole job is to
   * find something new; a track already in the catalogue is one the room can be
   * handed for nothing. Deliberately not part of `eligible`, which the setup
   * screen's count also runs: a catalogued song is still perfectly playable, so
   * hiding it from the count would understate what these settings are worth.
   *
   * Best-effort. A catalogue that cannot be read is a reason to draw a song that
   * may be a repeat, never a reason to fail to draw at all.
   */
  const catalogued = await libraryVideoCodes().catch(() => new Set<string>());

  for (let round = 0; round < count; round++) {
    const target = Math.round(
      settings.difficultyMin + Math.random() * Math.max(0, settings.difficultyMax - settings.difficultyMin)
    );

    const usable = buckets
      .map((bucket) => ({
        genre: bucket.genre,
        entries: bucket.entries.filter(
          (entry) => !catalogued.has(entry.videoId) && eligible(entry, bucket.genre, settings, history)
        )
      }))
      .filter((bucket) => bucket.entries.length > 0);

    const bucket = pickGenre(usable);
    if (!bucket) break;

    const entry = pickForTarget(bucket.entries, target);
    if (!entry) break;

    /**
     * Enrichment happens here, for one entry, rather than for the pool.
     *
     * This is the only await inside the loop and it is why the whole draw runs
     * during a round that is already playing. A chorus lookup is about 300ms, so
     * even a top-up of three costs under a second of a thirty second window.
     */
    await enrich([entry]);

    history.playedTracks.add(entry.trackKey);
    if (entry.artist) history.recentArtists.push(entry.artist.toLowerCase());

    drawn.push(toMediaView(entry, target));
  }

  return drawn;
}

/** Re-exported so the routes can describe the catalogue without importing two modules. */
export { sourceGenreFor };
export { blindtest as blindtestKind };
