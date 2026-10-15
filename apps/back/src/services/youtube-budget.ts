import { sql } from 'drizzle-orm';

import { systemClock, type Clock } from '../clock.js';
import type { Db } from '../db/open.js';

/**
 * The day's allowance of YouTube searches, spent one at a time.
 *
 * `search.list` is the one expensive call in the YouTube API: a hundred units
 * against a daily ten thousand. While the endless blind test searched three
 * fixed queries per genre per day the cost bounded itself. Searching for seeds
 * from a catalogue does not: every pool that runs low asks for another search,
 * and nothing about a room that plays all evening says when to stop. So every
 * search the blind test makes goes through here first, and the day ends when
 * the budget does rather than when Google starts answering 403.
 *
 * Kept in the database rather than in memory because the box restarts, and a
 * counter that resets on boot is a counter that can spend the day twice. Which
 * database, and what time it is, are the caller's: the catalogue's own.
 */

/**
 * Google resets the quota at midnight Pacific time, so that is the day that
 * matters. `en-CA` formats as YYYY-MM-DD, which doubles as the primary key.
 */
const PACIFIC_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

export function quotaDay(clock: Pick<Clock, 'now'> = systemClock): string {
  return PACIFIC_DAY.format(clock.now());
}

/**
 * Takes one search from today's allowance, or says there is none left.
 *
 * One statement, so two fills asking at once cannot both take the last one:
 * the conditional upsert only increments while the count is under the budget,
 * and `changes` says whether it did.
 */
export function spendSearch(db: Db, budget: number, clock: Pick<Clock, 'now'>): boolean {
  if (budget <= 0) return false;
  const day = quotaDay(clock);
  const result = db.run(sql`
    INSERT INTO "BlindtestSearchLedger" ("day", "searches") VALUES (${day}, 1)
    ON CONFLICT ("day") DO UPDATE SET "searches" = "searches" + 1
    WHERE "BlindtestSearchLedger"."searches" < ${budget}
  `);
  return result.changes > 0;
}

/** A day's spending so far. */
export function searchesOn(db: Db, day: string): number {
  const row = db.get<{ searches: number } | undefined>(
    sql`SELECT "searches" FROM "BlindtestSearchLedger" WHERE "day" = ${day}`
  );
  return row?.searches ?? 0;
}
