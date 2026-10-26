import { gt, inArray, sql } from 'drizzle-orm';

import { db } from '../db/index.js';
import { mediaPlays } from '../db/schema.js';

/**
 * How often each song or question has been heard, in any game.
 *
 * Kept for the shuffle: a room that plays the same big playlist every week
 * kept hearing the same handful of songs first while dozens it had never heard
 * waited behind them, since a fair shuffle has no idea what last week dealt.
 * See `freshFirstOrder`. And, as plays lately, for the catalogue's replays;
 * see `replayWeight`.
 */

/** Plays forgotten a day: five a month. */
const FORGOTTEN_PER_DAY = 5 / 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What `recent` has come down to by `now`, from what it was when `lastPlayedAt` wrote it. */
export function drained(recent: number, lastPlayedAt: string | null, now: Date): number {
  const days = lastPlayedAt ? Math.max(0, (now.getTime() - Date.parse(lastPlayedAt)) / DAY_MS) : 0;
  return Math.max(0, recent - FORGOTTEN_PER_DAY * (Number.isFinite(days) ? days : 0));
}

/** What is being played, as the counter knows it. */
export interface Playable {
  id: number;
  kind: string;
  payload: unknown;
}

/**
 * The counter's key for an item: its recording for a blind test, the item itself otherwise.
 *
 * A song saved in two playlists, or kept in the catalogue and in a host's own
 * quiz, is one song heard. A round drawn for the endless mode has no saved item
 * yet (a negative id) but already has its video, so it is counted too.
 */
export function playKeyOf(item: Playable): string | null {
  const code = (item.payload as { code?: unknown } | null)?.code;
  if (item.kind === 'blindtest' && typeof code === 'string' && code.length > 0) return `yt:${code}`;
  return item.id > 0 ? `media:${item.id}` : null;
}

/** Counts one play of an item. Best-effort: a count that cannot be written is a play forgotten, nothing more. */
export function recordPlay(item: Playable, now: Date = new Date()): void {
  const key = playKeyOf(item);
  if (!key) return;
  const stamp = now.toISOString();
  try {
    db.insert(mediaPlays)
      .values({ key, plays: 1, recent: 1, last_played_at: stamp })
      .onConflictDoUpdate({
        target: mediaPlays.key,
        set: {
          plays: sql`${mediaPlays.plays} + 1`,
          // `drained` in SQL, so two plays at once cannot both start from the same figure.
          recent: sql`max(0, ${mediaPlays.recent} - ${FORGOTTEN_PER_DAY} * coalesce(max(0, julianday(${stamp}) - julianday(${mediaPlays.last_played_at})), 0)) + 1`,
          last_played_at: stamp
        }
      })
      .run();
  } catch {
    // Nothing waits on this.
  }
}

/** How much each item has been heard lately, by its play key: see `MediaPlays.recent`. The unheard are absent. */
export function recentPlays(now: Date = new Date()): Map<string, number> {
  const rows = db
    .select({ key: mediaPlays.key, recent: mediaPlays.recent, last_played_at: mediaPlays.last_played_at })
    .from(mediaPlays)
    .where(gt(mediaPlays.recent, 0))
    .all();
  return new Map(rows.map((row) => [row.key, drained(row.recent, row.last_played_at, now)]));
}

/** How often each of these items has been heard, by item id. Items never heard are absent. */
export function playCountsOf(items: readonly Playable[]): Map<number, number> {
  const keyed = new Map<string, number[]>();
  for (const item of items) {
    const key = playKeyOf(item);
    if (key) keyed.set(key, [...(keyed.get(key) ?? []), item.id]);
  }
  const counts = new Map<number, number>();
  const keys = [...keyed.keys()];
  // In slices: SQLite caps how many values one statement may carry.
  for (let start = 0; start < keys.length; start += 500) {
    const rows = db
      .select()
      .from(mediaPlays)
      .where(inArray(mediaPlays.key, keys.slice(start, start + 500)))
      .all();
    for (const row of rows) for (const id of keyed.get(row.key) ?? []) counts.set(id, row.plays);
  }
  return counts;
}
