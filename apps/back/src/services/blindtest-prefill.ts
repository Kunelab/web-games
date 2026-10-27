import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import { db } from '../db/index.js';
import { metaData } from '../db/schema.js';
import { apiSlots, env } from '../env.js';
import { GENRES, catalogAvailable, refitCalibrations } from './blindtest-catalog.js';
import { catalogueRound } from './blindtest-draw.js';
import { indexCatalogueEntry } from './blindtest-duplicates.js';
import { countLibrary, libraryVideoCodes, rememberPlayedRound } from './blindtest-library.js';
import type { VideoIndexStatus } from './blindtest-seeds.js';
import { catalogue } from './catalogue-service.js';
import { quotaDay } from './youtube-budget.js';
import { playableIn } from './youtube-service.js';

/**
 * The day's unused searches, spent on the catalogue before they lapse.
 *
 * The YouTube quota is a daily allowance that resets at midnight Pacific (9:00
 * in Paris), and it does not carry over: an evening that played twenty rounds
 * left most of it unspent, and the catalogue only ever grew by what rooms had
 * played. So in the last hours before the reset, while nobody plays, this runs
 * seed searches until the budget is gone and files what they find straight
 * into `Tout (généré)`, ready to be replayed instantly by the next room.
 *
 * ## What it gives up, and what it keeps
 *
 * The catalogue used to hold only rounds a room had heard, which is a check
 * these rows have not had. What is kept of it: a round is filed only if a model
 * read the title (a run the model did not read keeps nothing and hands its
 * seeds back), only if it plays in this deployment's region, only once (the
 * same video id and the same recording are both refused), and it goes through
 * the duplicate index like every other entry, with the genre check reading it
 * too. The admin screen is where the rest of the vetting now happens.
 *
 * ## The budget
 *
 * Only the searches left in the current quota day, less a few kept for anybody
 * who starts a game before the reset. It stops the moment the Pacific day
 * changes, so a run that goes long never spends tomorrow's allowance. The
 * model calls it makes are the other cost: about two per search, a couple of
 * hundred on a full night, on the same endpoints the Mafia bots use, at an
 * hour when no table is playing.
 */

/** Searches left unspent for a game started in the last hours before the reset. */
const PREFILL_KEEP = 3;

/**
 * The pause between two filed rounds.
 *
 * Filing enriches each round (its chorus, its artist's other names, its year),
 * and MusicBrainz asks anonymous callers for about one request a second; AniList
 * allows thirty a minute. A room never came close, drawing one round at a time,
 * and a prefill filing a thousand would.
 */
const ENRICH_GAP_MS = 1_100;
const ANIME_ENRICH_GAP_MS = 2_200;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The clock in Los Angeles, which is the one Google resets the quota by. */
const PACIFIC_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});

/**
 * How long until the quota resets.
 *
 * Read off the Pacific wall clock, so it is an hour out on the two days a year
 * the clocks change. That is harmless: the run also stops on the quota day
 * itself changing (see `prefillCatalogue`), which is exact.
 */
export function msUntilQuotaReset(now = new Date()): number {
  const parts = Object.fromEntries(PACIFIC_CLOCK.formatToParts(now).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour) % 24;
  const elapsed = ((hour * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000 + now.getMilliseconds();
  return DAY_MS - elapsed;
}

export interface PrefillReport {
  startedAt: string;
  finishedAt: string | null;
  /** YouTube searches spent. */
  searches: number;
  /** Lookups of hits whose videos were already known, which spent none. */
  lookups: number;
  /** Artists' channels read for their hits' videos, at a unit a page. */
  channels: number;
  /** New rows in the catalogue. */
  saved: number;
  byGenre: Record<string, number>;
  /** Why it stopped. */
  stopped: string;
  /** Wikidata's list of song videos and artist channels, when the run ended. See `VideoIndexStatus`. */
  videoIndex: VideoIndexStatus | null;
  /** The most searches this run may spend, when it was given fewer than the day's. Null for the day's. */
  maxSearches: number | null;
  /** Whether it may search at all. */
  searching: boolean;
  /** What it is doing now: loading its lists, or filing a genre. Null once finished. */
  phase: 'loading' | 'filling' | null;
  /** The genre it is filing now. */
  genre: string | null;
  /** When it started filing, after its lists loaded: what its pace is measured from. */
  fillingSince: string | null;
}

/**
 * How far a running fill has to go, measured at the moment it is asked.
 *
 * Its work left is the famous songs whose videos are known and the searches it
 * may still spend; its pace is what it has done since it started filing. The
 * end is that work at that pace, which is rough: a lookup that files nothing
 * is quick, and the last genres are the slow ones.
 */
export interface PrefillProgress {
  knownVideosLeft: number;
  searchesLeft: number | null;
  /** Estimated, ISO. Null until it has done enough to have a pace. */
  expectedEnd: string | null;
}

let running: PrefillReport | null = null;
let lastReport: PrefillReport | null = null;

/** The run in progress, or the last one, for the diagnostics endpoint and the editor's banner. */
export function prefillStatus(): { running: boolean; report: PrefillReport | null; progress: PrefillProgress | null } {
  return { running: running !== null, report: running ?? lastReport, progress: running ? progressOf(running) : null };
}

/** Units of work done before a pace is worth reading. */
const PACE_AFTER = 5;

function progressOf(report: PrefillReport, now = Date.now()): PrefillProgress {
  const knownVideosLeft = catalogue.knownVideosWaiting();
  const searchesLeft = !report.searching
    ? 0
    : report.maxSearches !== null
      ? Math.max(0, report.maxSearches - report.searches)
      : Math.max(0, catalogue.searchesToday().budget - PREFILL_KEEP - catalogue.searchesToday().used);
  const done = report.lookups + report.searches;
  let expectedEnd: string | null = null;
  if (report.fillingSince && done >= PACE_AFTER) {
    const perUnit = (now - Date.parse(report.fillingSince)) / done;
    expectedEnd = new Date(now + perUnit * (knownVideosLeft + searchesLeft)).toISOString();
  }
  return { knownVideosLeft, searchesLeft: report.searching ? searchesLeft : null, expectedEnd };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Spends what is left of today's searches on the catalogue, now.
 *
 * Genre by genre, one search each in turn (or one lookup of hits whose videos
 * are already known, which spends none), the genres with the fewest catalogue
 * rows first, until the budget, the quota day or every genre's seeds run out.
 * One run at a time: a second call while one is going returns it.
 *
 * Without `searches`, only what costs no search: the hits whose videos
 * Wikidata gives, and those on the artists' channels, read at a unit a page
 * and taken out of the same day. A few hundred units where the searches for
 * the same songs would have been thousands.
 */
export async function prefillCatalogue(
  log?: FastifyBaseLogger,
  options: {
    searches?: boolean;
    /** At most this many searches, for a run started by hand to file what was asked for. */
    maxSearches?: number;
  } = {}
): Promise<PrefillReport> {
  if (running) return running;

  const report: PrefillReport = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    searches: 0,
    lookups: 0,
    channels: 0,
    saved: 0,
    byGenre: {},
    stopped: '',
    videoIndex: null,
    maxSearches: options.searches !== false && options.maxSearches !== undefined ? options.maxSearches : null,
    searching: options.searches !== false,
    phase: 'loading',
    genre: null,
    fillingSince: null
  };
  running = report;
  const day = quotaDay();
  const dayBudget = Math.max(0, env.BLINDTEST_SEARCH_BUDGET - PREFILL_KEEP);
  // The budget is the day's count to stop at: a capped run stops that many after where the day is now.
  const budget =
    report.maxSearches === null ? dayBudget : Math.min(dayBudget, catalogue.searchesToday().used + report.maxSearches);

  try {
    /**
     * Wikidata's list first, before anything that could spend a search.
     *
     * The famous songs it finds a video for cost no search at all, and while it
     * is missing they are not searched either: they wait. So the run asks for it
     * before planning anything, through every try and even right after a failed
     * one, whether it was started by hand or by the night. It goes on without
     * it, for the rest, when QLever will not answer.
     */
    await catalogue.loadVideoIndex();
    /**
     * And the charts' songs, for the same reason: the boot fetches them, and a
     * run started in the minute after it found none of them filed yet and
     * stopped at once, with nothing to look up.
     */
    await catalogue.loadCharts();

    // A facet reads its parent's pool and has no seeds of its own.
    const genres = GENRES.filter((genre) => !genre.facetOf && genre.seeds && genre.seeds.length > 0);
    const stock = await countLibrary(
      genres.map((genre) => genre.id),
      { min: 0, max: 100 }
    );
    // The genres an admin asked more of first, then the thinnest.
    const requested = catalogue.requestedGenres();
    genres.sort(
      (left, right) =>
        Number(requested.has(right.id)) - Number(requested.has(left.id)) ||
        (stock.get(left.id) ?? 0) - (stock.get(right.id) ?? 0)
    );

    /**
     * A genre is done for the night when it has nothing left, or nothing left
     * it can do without the searches that have run out. Not the whole run: a
     * genre whose hits' videos are known goes on looking them up, which costs
     * no search, after another has spent the last one.
     */
    const done = new Set<string>();
    report.phase = 'filling';
    report.fillingSince = new Date().toISOString();
    rounds: for (;;) {
      let searched = false;
      for (const genre of genres) {
        if (done.has(genre.id)) continue;
        if (quotaDay() !== day) {
          report.stopped = 'the quota day ended';
          break rounds;
        }

        report.genre = genre.id;
        const result = await catalogue.searchForCatalogue(genre.id, budget, { searches: options.searches });
        if (!result || (result.spent === 0 && result.free === 0 && result.channels === 0)) {
          done.add(genre.id);
          continue;
        }
        report.searches += result.spent;
        report.lookups += result.free;
        report.channels += result.channels;
        searched = true;
        if (result.modelDown) {
          report.stopped = 'no model answered';
          break rounds;
        }

        const before = (await libraryVideoCodes()).size;
        for (const entry of result.entries) {
          if (!playableIn(entry.restriction, env.YOUTUBE_REGION)) continue;
          const kept = await rememberPlayedRound(await catalogueRound(entry));
          if (kept) indexCatalogueEntry(kept);
          await pause(genre.section === 'anime' ? ANIME_ENRICH_GAP_MS : ENRICH_GAP_MS);
        }
        const added = (await libraryVideoCodes()).size - before;
        report.saved += added;
        report.byGenre[genre.id] = (report.byGenre[genre.id] ?? 0) + added;
      }
      if (!searched) {
        report.stopped ||=
          options.searches === false
            ? 'every genre has looked up what it could without a search'
            : catalogue.searchesToday().used >= budget
              ? 'the budget is spent'
              : 'every genre has searched its seeds';
        break;
      }
    }
  } catch (error) {
    report.stopped = `failed: ${String(error).slice(0, 200)}`;
    log?.warn({ err: error }, 'blind test prefill failed');
  } finally {
    report.videoIndex = catalogue.videoIndexStatus();
    report.finishedAt = new Date().toISOString();
    report.phase = null;
    report.genre = null;
    lastReport = report;
    running = null;
  }

  if (report.videoIndex?.failedAt) {
    log?.warn(
      { videoIndex: report.videoIndex },
      "Wikidata's list of song videos would not load: no famous song was looked up on Wikidata or an artist's channel"
    );
  }
  log?.info(
    {
      searches: report.searches,
      lookups: report.lookups,
      channels: report.channels,
      saved: report.saved,
      byGenre: report.byGenre,
      stopped: report.stopped
    },
    'blind test prefill finished'
  );

  /**
   * And each genre's spread, refitted from the rounds rescored since: the ones
   * this run filed and the ones rooms played. Once a night, at an hour nobody
   * plays, which is all a spread needs; see `refitCalibrations`.
   */
  try {
    const genres = refitCalibrations(db);
    log?.info({ genres }, 'blind test spreads refitted');
  } catch (error) {
    log?.warn({ err: error }, 'could not refit the blind test spreads');
  }
  return report;
}

/** Left in `MetaData` by the pass below, so that a restart never runs it again. */
const HIT_REOPEN_KEY = 'blindtest_hit_reopen_v1';

/**
 * Once: puts back the hits that were spent without their song being filed.
 *
 * Until a genre's famous songs were searched as themselves, they went with
 * their artist's name in a search shared with two others, and every seed of
 * the artist was spent whatever came back. That is how the Rolling Stones' 15
 * seeds were spent on a search that filed only Clairo and grandson. The hits
 * nobody ever searched need nothing: they now go first. These are the rest, and
 * the nights' prefills work through them all, hits first.
 *
 * Once, and marked done: run on every boot, it would also put back the hits the
 * new rules have since tried enough times and given up on.
 */
export async function reopenLostHitsOnce(log?: FastifyBaseLogger): Promise<void> {
  const [marker] = await db
    .select({ value: metaData.value })
    .from(metaData)
    .where(and(eq(metaData.content_id, 0), eq(metaData.key, HIT_REOPEN_KEY)))
    .limit(1);
  if (marker?.value === 'done') return;

  const reopened = await catalogue.reopenHits();
  const now = new Date().toISOString();
  await db
    .insert(metaData)
    .values({ content_id: 0, key: HIT_REOPEN_KEY, value: 'done', type: 'migration', createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: [metaData.content_id, metaData.key], set: { value: 'done', updatedAt: now } });
  log?.info({ reopened }, 'blind test hits put back for the prefill');
}

/**
 * Runs the prefill every day, `BLINDTEST_PREFILL_HOURS` before the reset.
 *
 * A boot inside the window starts it straight away, which matters on a box
 * that restarts after every power cut. Nothing is scheduled where it could not
 * work: no YouTube key, no model to read titles, or the setting at 0.
 */
export function schedulePrefill(log: FastifyBaseLogger): void {
  const lead = env.BLINDTEST_PREFILL_HOURS * 60 * 60 * 1000;
  if (lead <= 0 || !catalogAvailable() || apiSlots.length === 0) return;

  const later = (ms: number) => setTimeout(plan, Math.max(1_000, ms)).unref();
  function plan(): void {
    const toReset = msUntilQuotaReset();
    if (toReset > lead) {
      later(toReset - lead);
      return;
    }
    void prefillCatalogue(log).finally(() => {
      // Still inside today's window: wait out the reset. Past it (a long run):
      // straight to the next window, which waiting for a reset would skip.
      const left = msUntilQuotaReset();
      later(left <= lead ? left + 60_000 : left - lead);
    });
  }
  plan();
}
