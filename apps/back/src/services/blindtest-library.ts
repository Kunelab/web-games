import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  changedByHand,
  getMediaKind,
  normalizeAnswer,
  withHandEdits,
  type BlindtestFame,
  type BlindtestPayload
} from 'game-core';

import { cleanAliases } from '../game/session.js';

import { db } from '../db/index.js';
import { blindtestRoundStats, media, playlistItems, playlists, type MediaRow } from '../db/schema.js';
import {
  audienceOf,
  genreById,
  libraryVideoCodesIn,
  readCalibrations,
  sourceGenreFor,
  type Genre
} from './blindtest-catalog.js';
import { extremeDoubt, resolveCalibration, type ExtremeDoubt } from './blindtest-difficulty.js';
import type { DrawHistory } from './blindtest-draw.js';
import { hiddenDuplicates } from './blindtest-duplicates.js';
import { refiled, underRememberedGenre } from './blindtest-refile.js';
import { forgetRoundOutcomes } from './blindtest-stats.js';
import { toMediaView, type MediaView } from './media-service.js';

/**
 * The library the endless blind test writes into.
 *
 * Generated rounds used to exist only inside one session's state: drawn from a
 * pool, played once, and gone the moment the game was swept. Every one of them had
 * cost a YouTube search, a facts lookup and a share of a model call to work out
 * what the video actually was, and all of that was thrown away nightly.
 *
 * So a round that was genuinely played is kept. Two things follow from that and
 * both are the point:
 *
 *  - it can be corrected. A model's reading of a title is right most of the time
 *    and wrong some of the time, and until now a wrong answer was unfixable
 *    because there was nothing to fix — the round did not exist anywhere by the
 *    time anybody noticed. A row can be edited.
 *  - it accumulates. The playlist below grows by whatever the room played, so an
 *    evening of endless mode leaves a catalogue behind rather than only a
 *    scoreboard, and that catalogue is public: anybody can play it.
 *
 * ## What was played, and what the night filed
 *
 * Deliberately not everything a pool fill annotated: a fill annotates hundreds
 * of candidates per genre and a session plays a few dozen, and a pool's are
 * the leftovers of whatever a search happened to return.
 *
 * Two ways in, then. A round a room played, which a room can vouch for. And,
 * since the searches a day does not spend are lost at the quota reset, the
 * overnight prefill (`blindtest-prefill`), which spends them on seeds and files
 * what a model read, what plays here and what the catalogue does not already
 * hold. Those rows have not been heard at a reveal, which is what the
 * duplicate and genre checks on the admin screen are there to make up for.
 *
 * ## Who owns it
 *
 * Nobody, and that is load-bearing. Both the playlist and its rows are written
 * with a null `user_id`, and every ownership test in this codebase is
 * `user_id = :me` — which no number ever matches against null. So a member can
 * see the playlist (it is public) and play it, and can edit neither it nor
 * anything in it. `ownerFilter` drops the restriction entirely for an admin, so
 * an admin can do both. That is the whole of the permission model and it needed
 * no new column.
 */

/** The name the shared catalogue is created under, and found again by. */
export const EVERYTHING_PLAYLIST_NAME = 'Tout (généré)';

/**
 * The recording a saved round is of, in the draw's own key space.
 *
 * Deliberately the same shape as `trackKeyFor` in the catalogue — normalised
 * artist, then normalised title or work — and that is not a coincidence to be
 * tidied away. Two things fall out of the two key spaces being one:
 *
 *  - the playlist holds a song once, not once per upload. Deduplicating on the
 *    video id alone let the same track in twice under two YouTube uploads, which
 *    is precisely the case `trackKeyFor` exists to catch in the pool;
 *  - a session that has already played a song from the pool will not be handed
 *    it again from the library, or the other way round, because both go into
 *    the same `playedTracks` set.
 */
export function trackKeyOf(item: { answers: { key: string; value: string }[] }): string {
  const value = (key: string): string => item.answers.find((answer) => answer.key === key)?.value ?? '';
  const left = normalizeAnswer(value('artist'));
  const right = normalizeAnswer(value('title') || value('work'));
  return left ? `${left}::${right}` : right;
}

/** Every video id the shared catalogue already holds. See `libraryVideoCodesIn`. */
export function libraryVideoCodes(): Promise<Set<string>> {
  return libraryVideoCodesIn(db);
}

/**
 * What the catalogue holds, by video id and by recording.
 *
 * The video ids alone let a *twin* through: the same recording under another
 * upload (the Topic track of a song whose music video is catalogued, another
 * opening of a catalogued anime, since a work's key is the work). The draw
 * dealt those as new, and a correction made to one at the table went nowhere,
 * because the catalogue files that recording under the other video: the
 * correction matched nothing, and at the reveal the twin was found and left as
 * it was.
 */
export async function catalogueKeys(): Promise<{ codes: Set<string>; tracks: Set<string> }> {
  const codes = new Set<string>();
  const tracks = new Set<string>();
  for (const item of (await libraryRows()).map(toMediaView)) {
    const code = videoCodeOf(item.payload);
    if (code) codes.add(code);
    const key = trackKeyOf(item);
    if (key) tracks.add(key);
  }
  return { codes, tracks };
}

/** Every row of the shared catalogue. Ownerless by construction; see the header. */
async function libraryRows(): Promise<MediaRow[]> {
  return db
    .select()
    .from(media)
    .where(and(isNull(media.user_id), eq(media.kind, 'blindtest')));
}

/** Which field of a blind test payload identifies the recording. */
function videoCodeOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const code = (payload as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

/**
 * The shared playlist's id, created on first use.
 *
 * Looked up by name among the ownerless public playlists rather than kept in a
 * settings table: there is exactly one of these, it is identified by what it is,
 * and a config row to point at it would be a second thing that can be wrong.
 */
async function everythingPlaylistId(): Promise<number> {
  const [existing] = await db
    .select({ id: playlists.id })
    .from(playlists)
    .where(and(isNull(playlists.user_id), eq(playlists.name, EVERYTHING_PLAYLIST_NAME)))
    .limit(1);

  if (existing) return existing.id;

  const [created] = await db
    .insert(playlists)
    .values({ user_id: null, name: EVERYTHING_PLAYLIST_NAME, type: 'default', public: true })
    .returning({ id: playlists.id });

  if (!created) throw new Error('could not create the generated-rounds playlist');
  return created.id;
}

/**
 * Keeps a generated round, once.
 *
 * Two lookups, in the order that keeps a corrected row findable.
 *
 * The video id first, because it is the one thing about a round that a
 * correction never changes: an admin who fixes the artist on a row leaves its
 * id alone, so the same upload coming round again still lands on the row they
 * fixed rather than on a fresh wrong one beside it.
 *
 * Then the recording, which catches what the id cannot — the Topic upload and
 * the music video of one track are two ids for one song, and both were getting
 * in. A song corrected *and* then drawn under a different upload is the one gap
 * left, and it is a duplicate rather than a lost correction.
 *
 * Returns the library row, existing or new, so the caller can tell the screens
 * which entry the round in front of them belongs to.
 */
export async function rememberPlayedRound(item: MediaView): Promise<MediaView | null> {
  const code = videoCodeOf(item.payload);
  if (item.kind !== 'blindtest' || !code) return null;

  /**
   * Library rows only, which is what the null owner selects for.
   *
   * Without it a host who had saved this very track into their own library by
   * hand would have their row found here, and the round would be filed against
   * something they own and can edit — quietly making one person's private item
   * the public catalogue's entry for that song.
   */
  const [existing] = await db
    .select()
    .from(media)
    .where(
      and(isNull(media.user_id), eq(media.kind, 'blindtest'), sql`json_extract(${media.payload}, '$.code') = ${code}`)
    )
    .limit(1);

  if (existing) return toMediaView(existing);

  /**
   * And the same song under a different upload is the same song.
   *
   * The video id catches a round drawn twice; it does not catch the Topic
   * upload and the music video of one track, which are two ids for one
   * recording and were landing in the playlist as two entries with the same
   * answers. Matched on the recording instead, which is the key the pool has
   * always deduplicated on.
   *
   * A scan rather than a query, because the key is derived from a JSON column
   * and there is nothing to index. It runs once per round, over a table that
   * grows by whatever a room actually played, so the cost is a few hundred rows
   * every half a minute.
   */
  const key = trackKeyOf(item);
  if (key) {
    const twin = (await libraryRows()).map(toMediaView).find((row) => trackKeyOf(row) === key);
    if (twin) return twin;
  }

  // Filed where an admin said this artist belongs, whatever search found it.
  const filed = underRememberedGenre(item);
  const [row] = await db
    .insert(media)
    .values({
      user_id: null,
      kind: filed.kind,
      title: filed.title,
      category: filed.category,
      date: filed.date,
      answers: JSON.stringify(filed.answers),
      payload: JSON.stringify(filed.payload),
      timing: filed.timing ? JSON.stringify(filed.timing) : null
    })
    .returning();

  if (!row) return null;

  const playlistId = await everythingPlaylistId();
  const [last] = await db
    .select({ order_num: playlistItems.order_num })
    .from(playlistItems)
    .where(eq(playlistItems.playlist_id, playlistId))
    .orderBy(desc(playlistItems.order_num))
    .limit(1);

  await db
    .insert(playlistItems)
    .values({ playlist_id: playlistId, media_id: row.id, order_num: (last?.order_num ?? -1) + 1 })
    .onConflictDoNothing();

  return toMediaView(row);
}

/**
 * Writes a correction into the catalogue's copy of a round.
 *
 * The other half of catching a wrong answer at the reveal. Purging throws the
 * round away, which is right when it is unsalvageable; this is for the far
 * commoner case, where the model got the artist wrong and a person in the room
 * knows what it should be. One row fixed here is fixed for every room that is
 * dealt the song afterwards.
 *
 * Matched on the video id, which a correction never changes. Returns whether a
 * row was actually written, so the caller can tell a correction that landed
 * from one aimed at a round that was never kept.
 */
export async function correctLibraryRound(
  code: string,
  fields: { key: string; value: string; aliases?: string[] }[],
  numbers: Record<string, number | undefined> = {},
  /**
   * The genre it belongs to. The work prompt, the title's tag and the
   * difficulty follow it; see `refiled`.
   */
  genre?: Genre
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(media)
    .where(
      and(isNull(media.user_id), eq(media.kind, 'blindtest'), sql`json_extract(${media.payload}, '$.code') = ${code}`)
    )
    .limit(1);

  if (!row) return false;

  const view = toMediaView(row);
  let changed = false;
  for (const field of fields) {
    const answer = view.answers.find((candidate) => candidate.key === field.key);
    if (!answer) continue;

    const value = field.value.trim();
    if (value && answer.value !== value) {
      answer.value = value;
      changed = true;
    }

    /**
     * The accepted spellings, kept for every room afterwards.
     *
     * This is the half of a correction that outlives the argument it came from.
     * A round is marked wrong once, somebody says "that is the same film under
     * its other title", and from here on it is the same film under its other
     * title for everybody — which is a thing the model that wrote the row could
     * not have known and a thing no room should have to discover twice.
     */
    const aliases = cleanAliases(field.aliases);
    if (aliases && JSON.stringify(aliases) !== JSON.stringify(answer.aliases)) {
      answer.aliases = aliases;
      changed = true;
    }
  }

  /**
   * And the numbers in the payload: the clip window, and how hard it is.
   *
   * Same rule as the live round's: a patch that would not survive a save is
   * refused whole. Unlike the live round, the stored copy keeps no separate
   * timing — `resolveTiming` derives it from the payload on every read — so
   * correcting the window here is the whole of the fix for every future room.
   * What was moved is marked as a person's, so a rescoring leaves it alone.
   */
  const patch: Record<string, number> = {};
  for (const [key, value] of Object.entries(numbers)) {
    if (typeof value === 'number' && Number.isFinite(value)) patch[key] = Math.round(value);
  }

  let payload = view.payload;
  /** Whether the round itself changed: what it asks the room to recognise, or how hard it says that is. */
  let rejudged = false;
  if (Object.keys(patch).length > 0) {
    const merged = { ...((payload ?? {}) as Record<string, unknown>), ...patch };
    const parsed = getMediaKind('blindtest').payloadSchema.safeParse(merged);
    if (parsed.success && JSON.stringify(parsed.data) !== JSON.stringify(payload)) {
      const moved = changedByHand(payload, parsed.data);
      payload = withHandEdits(payload, parsed.data as BlindtestPayload);
      rejudged = moved.difficulty || moved.timing;
      changed = true;
    }
  }

  /**
   * The genre last, so a difficulty the host set in the same correction is
   * already marked theirs and is kept rather than measured again. A move alone
   * is not an edit: `last_modified` is stamped only when something above
   * changed. See `blindtest-refile` for why.
   */
  let category = row.category;
  let title = row.title;
  let answers = view.answers;
  let moved = false;
  if (genre) {
    const next = refiled({ ...view, title, answers, payload }, genre);
    if (
      next.category !== category ||
      next.title !== title ||
      next.payload !== payload ||
      JSON.stringify(next.answers) !== JSON.stringify(answers)
    ) {
      ({ category, title, answers, payload } = next);
      moved = true;
    }
  }

  if (!changed && !moved) return false;

  await db
    .update(media)
    .set({
      category,
      title,
      answers: JSON.stringify(answers),
      payload: JSON.stringify(payload),
      ...(changed ? { last_modified: new Date().toISOString() } : {})
    })
    .where(eq(media.id, row.id));

  if (rejudged) await forgetRoundOutcomes(code);

  return true;
}

/**
 * Throws away the library's entry for a recording.
 *
 * The room is the only thing that can tell a good round from a plausible-looking
 * wrong one, and it can only tell at the reveal — which is a moment that used to
 * pass with nowhere to put the observation. The link in the playlist goes with the
 * row, by the foreign key's cascade.
 *
 * Deleting rather than flagging: the catalogue's value is that everything in it
 * can be played, and a row kept under suspicion is a round that will be dealt to
 * somebody else before anybody gets round to judging it. What was learned is not
 * lost either way — the pool will offer the track again, and whoever keeps it the
 * next time can correct it instead.
 */
export async function purgeLibraryRound(code: string): Promise<boolean> {
  const rows = await db
    .delete(media)
    .where(
      and(isNull(media.user_id), eq(media.kind, 'blindtest'), sql`json_extract(${media.payload}, '$.code') = ${code}`)
    )
    .returning({ id: media.id });

  return rows.length > 0;
}

/**
 * A round the room has already vouched for, instead of a new one.
 *
 * The endless mode's whole cost is the search behind each round: a YouTube
 * query, a facts lookup, a chorus lookup, and a share of a model call to work
 * out what the video actually was. The catalogue is what all of that has
 * already been spent on — and every row in it was played in front of a room,
 * and may since have been corrected by hand, which is more than can be said for
 * anything a fresh draw produces.
 *
 * So half the time the buffer is filled from here. It is not a fallback for a
 * draw that failed; it is the cheaper half of an alternation that also makes
 * the catalogue worth keeping.
 *
 * Filtered to the genres this room asked for — a rap night stays a rap night —
 * and to what it has not already heard.
 *
 * Difficulty filters too, but only where there is one to filter on. A row saved
 * before the number was kept has none, and "unknown" must not read as "too hard"
 * or an evening on a narrow window would quietly stop replaying anything: those
 * rows stay eligible and the window is applied to the rest. What makes the
 * filter worth having at all is that the number on a saved row is the one a room
 * could correct — the pool's own figure is a rank among search results, this one
 * has been through the reveal.
 *
 * The rows come back with their real, positive ids, which is the point: a
 * replayed round is an ordinary library item, so it needs no saving, restores
 * after a restart like any other, and cannot be filed a second time.
 *
 * A row flagged as a possible duplicate of an older one sits out until an admin
 * settles the flag; see `duplicatesToHide`.
 *
 * `dealt` is every media id the session has already handed out, and it is the
 * hard half of "never the same song twice in one evening". The track key below
 * is the soft half: it spans both sources, so a song the catalogue supplied
 * cannot also be drawn from a pool, but it is derived from answers an admin may
 * edit mid-game. An id cannot drift.
 */
export async function replayFromLibrary(
  genreIds: readonly string[],
  history: DrawHistory,
  count: number,
  dealt: ReadonlySet<number> = new Set(),
  difficulty: { min: number; max: number } = { min: 0, max: 100 }
): Promise<MediaView[]> {
  if (count <= 0) return [];

  const wanted = new Set(genreIds);
  const rows = (await libraryRows()).map(toMediaView);
  const hidden = await hiddenDuplicates(rows).catch(() => new Set<number>());
  const pool = rows
    .filter((item) => item.readiness.ready && wanted.has(item.category ?? ''))
    .filter((item) => !dealt.has(item.id) && !hidden.has(item.id))
    .filter((item) => {
      const rating = (item.payload as { difficulty?: unknown } | null)?.difficulty;
      if (typeof rating !== 'number') return true;
      return rating >= difficulty.min && rating <= difficulty.max;
    })
    .filter((item) => {
      const key = trackKeyOf(item);
      return key !== '' && !history.playedTracks.has(key);
    });

  const picked: MediaView[] = [];
  while (picked.length < count && pool.length > 0) {
    const index = Math.floor(Math.random() * pool.length);
    const [item] = pool.splice(index, 1);
    if (!item) break;

    // The same bookkeeping a drawn round does, so the two sources cannot hand
    // the room the same song between them.
    history.playedTracks.add(trackKeyOf(item));
    const artist = item.answers.find((answer) => answer.key === 'artist')?.value;
    if (artist) history.recentArtists.push(artist.toLowerCase());

    picked.push(item);
  }

  return picked;
}

/**
 * How many catalogue rounds each genre could replay, for the setup screen.
 *
 * The pools leave out anything the catalogue already holds (a search is for
 * something new), so the count on screen has to add the catalogue back or it
 * would shrink as the catalogue grows, which is the opposite of the truth.
 * Filtered the way `replayFromLibrary` filters, minus the session history a
 * count does not have.
 */
export async function countLibrary(
  genreIds: readonly string[],
  difficulty: { min: number; max: number }
): Promise<Map<string, number>> {
  const wanted = new Set(genreIds);
  const counts = new Map<string, number>();
  const rows = (await libraryRows()).map(toMediaView);
  const hidden = await hiddenDuplicates(rows).catch(() => new Set<number>());
  for (const item of rows) {
    const genreId = item.category ?? '';
    if (!wanted.has(genreId) || !item.readiness.ready || hidden.has(item.id)) continue;
    const rating = (item.payload as { difficulty?: unknown } | null)?.difficulty;
    if (typeof rating === 'number' && (rating < difficulty.min || rating > difficulty.max)) continue;
    counts.set(genreId, (counts.get(genreId) ?? 0) + 1);
  }
  return counts;
}

/** The catalogue as it stands, oldest first. For the admin's editing screen. */
export async function listLibrary(): Promise<MediaView[]> {
  const playlistId = await everythingPlaylistId();

  /**
   * The catalogue's own rows only: ownerless blind tests.
   *
   * The playlist is an admin's to edit, and an admin's library lists everybody's
   * media, so a member's private item can be added to it. The checks and the
   * bulk label fix read this list, and without the filter "fix the old labels"
   * rewrote that member's row while every single-entry write refused to touch it.
   */
  const rows = await db
    .select({ row: media })
    .from(playlistItems)
    .innerJoin(media, eq(media.id, playlistItems.media_id))
    .where(and(eq(playlistItems.playlist_id, playlistId), isNull(media.user_id), eq(media.kind, 'blindtest')))
    .orderBy(asc(playlistItems.order_num));

  return rows.map((entry) => toMediaView(entry.row));
}

/* ------------------------------------------------------- how it went */

/** Rated at most this easy, played at least this often, and never found: worth a look. */
const REVIEW_MAX_DIFFICULTY = 40;
const REVIEW_MIN_PLAYS = 2;

export interface ReviewFlag {
  mediaId: number;
  difficulty: number;
  plays: number;
}

export interface ExtremeFlag {
  mediaId: number;
  difficulty: number;
  reason: ExtremeDoubt;
}

/**
 * Catalogue rounds at either end of the scale that nothing backs, for the admin.
 *
 * 1 to 10 for a song whose artist is famous and the song is not, 90 to 100 for
 * one millions have watched, and either end scored before any figure was kept:
 * see `extremeDoubt`. A number a person set is theirs, and never listed.
 */
export async function findExtremeFlags(): Promise<ExtremeFlag[]> {
  const calibrations = readCalibrations(db);
  const flags: ExtremeFlag[] = [];
  for (const item of await listLibrary()) {
    const payload = (item.payload ?? {}) as { difficulty?: unknown; difficultyBy?: unknown; fame?: BlindtestFame };
    if (typeof payload.difficulty !== 'number' || payload.difficultyBy === 'human') continue;
    const genre = item.category ? genreById.get(item.category) : undefined;
    if (!genre) continue;
    const source = sourceGenreFor(genre);
    const reason = extremeDoubt(payload.difficulty, payload.fame, {
      shape: source.answerShape,
      audience: audienceOf(genre),
      calibration: resolveCalibration(calibrations, source.id, source.answerShape),
      piece: source.pieceFame
    });
    if (reason) flags.push({ mediaId: item.id, difficulty: payload.difficulty, reason });
  }
  return flags;
}

/**
 * Catalogue rounds rated easy that no room has ever found.
 *
 * Either the number is wrong, and the round is harder than its fame says, or
 * the clip is: a window that opens on a logo or a spoken intro is unanswerable
 * however famous the song. Both are an admin's to fix from the editor, and
 * either fix settles the flag, since a harder number takes the round out of it
 * and a found round takes it out for good.
 */
export async function findReviewFlags(): Promise<ReviewFlag[]> {
  const stats = new Map((await db.select().from(blindtestRoundStats)).map((row) => [row.code, row]));
  const flags: ReviewFlag[] = [];
  for (const item of await listLibrary()) {
    const code = videoCodeOf(item.payload);
    const row = code ? stats.get(code) : undefined;
    const difficulty = (item.payload as { difficulty?: unknown } | null)?.difficulty;
    if (!row || typeof difficulty !== 'number') continue;
    if (row.found === 0 && row.plays >= REVIEW_MIN_PLAYS && difficulty <= REVIEW_MAX_DIFFICULTY) {
      flags.push({ mediaId: item.id, difficulty, plays: row.plays });
    }
  }
  return flags;
}
