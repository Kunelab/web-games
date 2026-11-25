import { and, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { BlindtestFame } from 'game-core';

import type { Db } from '../db/open.js';
import { blindtestFame, blindtestSongFacts, media } from '../db/schema.js';
import { billboardRun, loadBillboard, refreshBillboard, type BillboardIndex } from './blindtest-billboard.js';
import { genreById, sourceGenreFor } from './blindtest-catalog.js';
import { fameKey } from './blindtest-fame.js';
import { mergeSongFacts, type SongFacts } from './blindtest-song-facts.js';
import { proposeForFlagged } from './blindtest-video-replace.js';
import { wikipediaSongFacts } from './blindtest-song-wiki.js';
import { musicbrainzYear } from './blindtest-years.js';

/**
 * The waiting list of the slow sources, and the worker that drains it.
 *
 * Every song of the shared catalogue is a row of `BlindtestSongFacts`, with one
 * queue per source: MusicBrainz for the year (one request a second, about ten
 * hours for the whole catalogue the first time), the song's own Wikipedia and
 * Wikidata for its charts and certifications (a few a second), and the Billboard
 * Hot 100 history (one file, every song at once). Each queue goes at its own
 * pace, survives a restart (the state is in the table), and a failed request
 * puts the song back for later rather than recording "nothing".
 *
 * What has arrived is read by the scoring (`songFame`): a round is scored with
 * whatever is known so far, and better on its next rescoring.
 */

/**
 * Asked again this long after a failed request. MusicBrainz answers "busy"
 * (503) often and briefly, so it is asked again soon; Wikimedia rarely fails,
 * and when it does it is worth waiting.
 */
const RETRY_MS: Record<Source, number> = { musicbrainz: 15 * 60 * 1000, wikipedia: 6 * 60 * 60 * 1000 };
/** How long a drained queue sleeps before looking for new songs. */
const IDLE_MS = 15 * 60 * 1000;
/** Re-read the catalogue for new rounds this often. */
const ENQUEUE_EVERY_MS = 6 * 60 * 60 * 1000;
/** Rounds with a wrong video given a proposed replacement per day. */
const REPLACE_PER_DAY = 40;
/** After a start, so a run of restarts does not spend the day's searches. */
const REPLACE_DELAY_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The Billboard history is refreshed weekly. */
const BILLBOARD_MAX_AGE_DAYS = 7;

type Source = 'musicbrainz' | 'wikipedia';

const now = () => new Date().toISOString();

/** The artist and title of a catalogue round, when it is a song with its own fame. */
export function songOf(category: string | null, answers: string): { artist: string; title: string } | null {
  const genre = category ? genreById.get(category) : undefined;
  if (!genre) return null;
  const source = sourceGenreFor(genre);
  // A work is not a song, and a classical piece's fame is its own Wikipedia's already.
  if (source.answerShape !== 'artist-title' || source.pieceFame) return null;
  try {
    const fields = JSON.parse(answers) as { key: string; value: string }[];
    const artist = fields.find((field) => field.key === 'artist')?.value?.trim() ?? '';
    const title = fields.find((field) => field.key === 'title')?.value?.trim() ?? '';
    return artist && title ? { artist, title } : null;
  } catch {
    return null;
  }
}

/** The artist's Wikidata id the fame lookup found, from its cached facts. */
function artistQidOf(cached: string): string | null {
  try {
    return (JSON.parse(cached) as { ids?: Record<string, string> }).ids?.wikidata ?? null;
  } catch {
    return null;
  }
}

/**
 * Which songs are read first: those Deezer ranks highest. Hits and oldies are
 * where a chart run or a year changes a difficulty most; an album track nobody
 * streams rarely has an article to find, and can wait.
 */
function priorityOf(cached: string): number {
  try {
    const rank = (JSON.parse(cached) as { deezerRank?: number | null }).deezerRank;
    return typeof rank === 'number' ? rank : 0;
  } catch {
    return 0;
  }
}

function parseFacts(text: string): SongFacts {
  try {
    return JSON.parse(text) as SongFacts;
  } catch {
    return {};
  }
}

/** The key a song's facts are kept under: the fame cache's, so both describe the same song. */
export function songKey(artist: string, title: string): string {
  return fameKey({ shape: 'artist-title', artist, title, piece: false });
}

/**
 * Puts every song of the shared catalogue on the waiting list, once. Cheap to
 * run again: what is already there is left alone, but an artist's Wikidata id
 * found since by the fame lookup is filled in.
 */
export function enqueueCatalogue(db: Db): number {
  const rows = db
    .select({ category: media.category, answers: media.answers })
    .from(media)
    .where(and(isNull(media.user_id), eq(media.kind, 'blindtest')))
    .all();
  let added = 0;
  const stamp = now();
  db.transaction((tx) => {
    for (const row of rows) {
      const song = songOf(row.category, row.answers);
      if (!song) continue;
      const key = songKey(song.artist, song.title);
      const cached = tx.select({ facts: blindtestFame.facts }).from(blindtestFame).where(eq(blindtestFame.key, key)).get();
      const artistQid = cached ? artistQidOf(cached.facts) : null;
      const priority = cached ? priorityOf(cached.facts) : 0;
      const result = tx
        .insert(blindtestSongFacts)
        .values({ key, artist: song.artist, title: song.title, artist_qid: artistQid, priority, updated_at: stamp })
        .onConflictDoUpdate({
          target: blindtestSongFacts.key,
          set: { artist_qid: sql`coalesce(${blindtestSongFacts.artist_qid}, ${artistQid})`, priority }
        })
        .run();
      if (result.changes > 0) added += 1;
    }
  });
  return added;
}

/** What is known about a song so far, or nothing. */
export function songFacts(db: Db, key: string): SongFacts {
  const row = db.select({ facts: blindtestSongFacts.facts }).from(blindtestSongFacts).where(eq(blindtestSongFacts.key, key)).get();
  return row ? parseFacts(row.facts) : {};
}

/** A song's facts as the scoring reads them: the best chart run and certification of any country. */
export function songFame(facts: SongFacts): Partial<BlindtestFame> {
  const runs = Object.values(facts.charts ?? {});
  const levels = Object.values(facts.certifications ?? {}).filter((level): level is number => typeof level === 'number');
  return {
    ...(typeof facts.year === 'number' ? { year: facts.year } : {}),
    ...(runs.length > 0 ? { chartPeak: Math.min(...runs.map((run) => run.peak)) } : {}),
    ...(runs.some((run) => typeof run.weeks === 'number')
      ? { chartWeeks: Math.max(...runs.map((run) => run.weeks ?? 0)) }
      : {}),
    ...(levels.length > 0 ? { certLevel: Math.max(...levels) } : {}),
    ...(typeof facts.songWikiLanguages === 'number' ? { songWikiLanguages: facts.songWikiLanguages } : {})
  };
}

function record(db: Db, key: string, found: SongFacts, set: Partial<typeof blindtestSongFacts.$inferInsert>): void {
  db.transaction((tx) => {
    const row = tx.select({ facts: blindtestSongFacts.facts }).from(blindtestSongFacts).where(eq(blindtestSongFacts.key, key)).get();
    const known = row ? parseFacts(row.facts) : {};
    tx.update(blindtestSongFacts)
      .set({ ...set, facts: JSON.stringify(mergeSongFacts(known, found)), updated_at: now() })
      .where(eq(blindtestSongFacts.key, key))
      .run();
  });
}

function nextPending(db: Db, source: Source) {
  const done = source === 'musicbrainz' ? blindtestSongFacts.musicbrainz_done : blindtestSongFacts.wikipedia_done;
  const retry = source === 'musicbrainz' ? blindtestSongFacts.musicbrainz_retry : blindtestSongFacts.wikipedia_retry;
  return db
    .select({ key: blindtestSongFacts.key, artist: blindtestSongFacts.artist, title: blindtestSongFacts.title, artistQid: blindtestSongFacts.artist_qid })
    .from(blindtestSongFacts)
    .where(and(isNull(done), or(isNull(retry), lte(retry, now()))))
    .orderBy(desc(blindtestSongFacts.priority))
    .limit(1)
    .get();
}

/** One song from one queue. Returns false when the queue is empty for now. */
export async function drainOne(db: Db, source: Source): Promise<boolean> {
  const next = nextPending(db, source);
  if (!next) return false;
  const later = new Date(Date.now() + RETRY_MS[source]).toISOString();
  // Claimed for this reader: put back as if failed until it answers, so the
  // other readers of the same queue take the next song rather than this one.
  db.update(blindtestSongFacts)
    .set(source === 'musicbrainz' ? { musicbrainz_retry: later } : { wikipedia_retry: later })
    .where(eq(blindtestSongFacts.key, next.key))
    .run();
  if (source === 'musicbrainz') {
    const year = await musicbrainzYear(next.artist, next.title);
    if (year === undefined) record(db, next.key, {}, { musicbrainz_retry: later });
    else record(db, next.key, year === null ? {} : { year, yearSource: 'musicbrainz' }, { musicbrainz_done: now(), musicbrainz_retry: null });
  } else {
    const found = await wikipediaSongFacts(next.artist, next.title, next.artistQid);
    if (found === undefined) record(db, next.key, {}, { wikipedia_retry: later });
    else record(db, next.key, found, { wikipedia_done: now(), wikipedia_retry: null });
  }
  return true;
}

/** Every song not yet read against the Billboard history, read against it. */
export function applyBillboard(db: Db, index: BillboardIndex): number {
  const pending = db
    .select({ key: blindtestSongFacts.key, artist: blindtestSongFacts.artist, title: blindtestSongFacts.title })
    .from(blindtestSongFacts)
    .where(isNull(blindtestSongFacts.billboard_done))
    .all();
  const stamp = now();
  for (const song of pending) {
    const run = billboardRun(index, song.artist, song.title);
    record(
      db,
      song.key,
      run ? { charts: { us: { peak: run.peak, weeks: run.weeks } }, year: run.firstYear, yearSource: 'billboard' } : {},
      { billboard_done: stamp }
    );
  }
  return pending.length;
}

/** How far each queue has got, for the logs and the diagnostics. */
export function queueStatus(db: Db): Record<string, number> {
  const row = db
    .select({
      songs: sql<number>`count(*)`,
      musicbrainz: sql<number>`sum(${blindtestSongFacts.musicbrainz_done} is not null)`,
      wikipedia: sql<number>`sum(${blindtestSongFacts.wikipedia_done} is not null)`,
      billboard: sql<number>`sum(${blindtestSongFacts.billboard_done} is not null)`,
      withYear: sql<number>`sum(json_extract(${blindtestSongFacts.facts}, '$.year') is not null)`,
      withChart: sql<number>`sum(json_extract(${blindtestSongFacts.facts}, '$.charts') is not null)`
    })
    .from(blindtestSongFacts)
    .get();
  return Object.fromEntries(Object.entries(row ?? {}).map(([name, value]) => [name, Number(value ?? 0)]));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms).unref());

/**
 * Starts the background queues. Each runs forever at its own pace; an error in
 * one is logged and the loop carries on after a pause.
 */
export function startSongFactsWorker(db: Db, log: FastifyBaseLogger, options: { billboardFile: string }): void {
  const loop = async (name: string, step: () => Promise<boolean>) => {
    for (;;) {
      try {
        if (!(await step())) await sleep(IDLE_MS);
      } catch (error) {
        log.warn({ err: error, queue: name }, 'blind test song facts: queue step failed');
        await sleep(60_000);
      }
    }
  };

  const enqueue = async () => {
    for (;;) {
      try {
        const added = enqueueCatalogue(db);
        const index = (await refreshBillboard(options.billboardFile, BILLBOARD_MAX_AGE_DAYS)) ?? loadBillboard(options.billboardFile);
        const read = index ? applyBillboard(db, index) : 0;
        log.info({ added, billboard: read, ...queueStatus(db) }, 'blind test song facts: catalogue queued');
      } catch (error) {
        log.warn({ err: error }, 'blind test song facts: queueing failed');
      }
      await sleep(ENQUEUE_EVERY_MS);
    }
  };

  /**
   * And once a day, a replacement proposed for the rounds whose video is wrong:
   * forty at most, paid for from the day's YouTube searches like any other, so
   * the night's catalogue fill keeps the rest. See `blindtest-video-replace`.
   */
  const replace = async () => {
    for (;;) {
      await sleep(REPLACE_DELAY_MS);
      try {
        const done = await proposeForFlagged({ limit: REPLACE_PER_DAY, write: true });
        log.info(done, 'blind test videos: replacements proposed');
      } catch (error) {
        log.warn({ err: error }, 'blind test videos: proposing replacements failed');
      }
      await sleep(DAY_MS - REPLACE_DELAY_MS);
    }
  };

  void enqueue();
  void replace();
  void loop('musicbrainz', () => drainOne(db, 'musicbrainz'));
  // Three readers for Wikipedia, which the module spreads over its three lanes.
  for (let lane = 0; lane < 3; lane += 1) void loop(`wikipedia-${lane}`, () => drainOne(db, 'wikipedia'));
}

