import { sql } from 'drizzle-orm';

import { db } from '../db/index.js';
import { env } from '../env.js';

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
 * counter that resets on boot is a counter that can spend the day twice.
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

export function quotaDay(now = new Date()): string {
  return PACIFIC_DAY.format(now);
}

/**
 * Takes one search from today's allowance, or says there is none left.
 *
 * One statement, so two fills asking at once cannot both take the last one:
 * the conditional upsert only increments while the count is under the budget,
 * and `changes` says whether it did.
 */
export function spendSearch(budget = env.BLINDTEST_SEARCH_BUDGET): boolean {
  if (budget <= 0) return false;
  const day = quotaDay();
  const result = db.run(sql`
    INSERT INTO "BlindtestSearchLedger" ("day", "searches") VALUES (${day}, 1)
    ON CONFLICT ("day") DO UPDATE SET "searches" = "searches" + 1
    WHERE "BlindtestSearchLedger"."searches" < ${budget}
  `);
  return result.changes > 0;
}

/** Today's spending, for the diagnostics endpoint. */
export function searchesToday(): { day: string; used: number; budget: number } {
  const day = quotaDay();
  const row = db.get<{ searches: number } | undefined>(
    sql`SELECT "searches" FROM "BlindtestSearchLedger" WHERE "day" = ${day}`
  );
  return { day, used: row?.searches ?? 0, budget: env.BLINDTEST_SEARCH_BUDGET };
}
