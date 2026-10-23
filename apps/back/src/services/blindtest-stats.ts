import { eq, sql } from 'drizzle-orm';

import { db } from '../db/index.js';
import { blindtestRoundStats } from '../db/schema.js';

/**
 * How often each catalogue round was played, and how often anybody found it.
 *
 * Kept apart from the library so the media editor can forget a round's plays
 * without the two modules loading each other. `findReviewFlags` in
 * `blindtest-library` is what reads them.
 */

/**
 * One more play of a catalogue round, and whether anybody found it.
 *
 * Counted by video id, which a generated round already has before it is filed
 * and which a correction never changes. "Found" is anybody naming any part of
 * the answer: a round where the room got the artist and missed the title was
 * still recognised.
 */
export async function recordRoundOutcome(code: string, found: boolean, now: Date = new Date()): Promise<void> {
  await db
    .insert(blindtestRoundStats)
    .values({ code, plays: 1, found: found ? 1 : 0, last_played_at: now.toISOString() })
    .onConflictDoUpdate({
      target: blindtestRoundStats.code,
      set: {
        plays: sql`${blindtestRoundStats.plays} + 1`,
        found: sql`${blindtestRoundStats.found} + ${found ? 1 : 0}`,
        last_played_at: now.toISOString()
      }
    });
}

/**
 * Forgets a round's plays, once a person has changed its clip or its difficulty.
 *
 * The plays so far were of the old clip, or against the old number, and the
 * "never found" flag they raised has been answered by the change.
 */
export async function forgetRoundOutcomes(code: string): Promise<void> {
  await db.delete(blindtestRoundStats).where(eq(blindtestRoundStats.code, code));
}
