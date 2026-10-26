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

/** What one search costs, in the quota's units. */
const SEARCH_UNITS = 100;

/**
 * Takes one search from today's allowance, or says there is none left.
 *
 * One statement, so two fills asking at once cannot both take the last one:
 * the conditional upsert only increments while the count is under the budget,
 * and `changes` says whether it did. The budget is counted in searches, and the
 * units the cheap calls took (`chargeUnits`) come out of it too.
 */
export function spendSearch(db: Db, budget: number, clock: Pick<Clock, 'now'>): boolean {
  if (budget <= 0) return false;
  const day = quotaDay(clock);
  const result = db.run(sql`
    INSERT INTO "BlindtestSearchLedger" ("day", "searches") VALUES (${day}, 1)
    ON CONFLICT ("day") DO UPDATE SET "searches" = "searches" + 1
    WHERE "BlindtestSearchLedger"."searches" * ${SEARCH_UNITS} + "BlindtestSearchLedger"."units" + ${SEARCH_UNITS}
      <= ${budget * SEARCH_UNITS}
  `);
  return result.changes > 0;
}

/**
 * Records units spent on calls that cost a few rather than a hundred.
 *
 * A channel's uploads are read a page of fifty for one unit, which is what
 * makes them worth reading instead of searching. Reading a few hundred of them
 * a night still adds up, so it is counted against the same day.
 */
export function chargeUnits(db: Db, units: number, clock: Pick<Clock, 'now'>): void {
  const day = quotaDay(clock);
  db.run(sql`
    INSERT INTO "BlindtestSearchLedger" ("day", "searches", "units") VALUES (${day}, 0, ${units})
    ON CONFLICT ("day") DO UPDATE SET "units" = "units" + ${units}
  `);
}

/** Units left today under a budget of this many searches. */
export function unitsLeft(db: Db, budget: number, clock: Pick<Clock, 'now'>): number {
  const row = db.get<{ searches: number; units: number } | undefined>(
    sql`SELECT "searches", "units" FROM "BlindtestSearchLedger" WHERE "day" = ${quotaDay(clock)}`
  );
  return budget * SEARCH_UNITS - ((row?.searches ?? 0) * SEARCH_UNITS + (row?.units ?? 0));
}

/** A day's spending so far, in searches: the cheap calls count one for every hundred units. */
export function searchesOn(db: Db, day: string): number {
  const row = db.get<{ searches: number; units: number } | undefined>(
    sql`SELECT "searches", "units" FROM "BlindtestSearchLedger" WHERE "day" = ${day}`
  );
  return (row?.searches ?? 0) + Math.ceil((row?.units ?? 0) / SEARCH_UNITS);
}
