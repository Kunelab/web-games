import { eq } from 'drizzle-orm';

import { db } from '../db/index.js';
import { quizCareers } from '../db/schema.js';

/**
 * The quiz wallet: tokens per nickname, accounts under `@login`.
 *
 * The quizzes already kept a history and derived careers from it, but a score in
 * a history row is a fact about an evening — spending it would rewrite the
 * leaderboard. Tokens are a second, parallel number: credited at the same moment
 * the result is written, debited by the shop, and read by nobody else.
 *
 * Deliberately the same shape as `CzCareers` and `MafiaCareers` — a JSON blob per
 * nickname — so all three wallets can be read through one adapter.
 */

export interface QuizCareerStats {
  /** Spendable balance. */
  tokens: number;
  /** Lifetime credited, so the shop can say "earned" as well as "left". */
  lifetime: number;
}

export function emptyQuizStats(): QuizCareerStats {
  return { tokens: 0, lifetime: 0 };
}

/** The ledger of a Kune login. Prefixed so it cannot collide with a nickname. */
export function quizAccountKey(login: string): string {
  return `@${login}`;
}

/** Which ledger a seat pays into: the account when signed in, the nickname otherwise. */
export function quizLedgerKey(player: { name: string; account?: string }): string {
  return player.account ? quizAccountKey(player.account) : player.name;
}

async function readStats(name: string): Promise<QuizCareerStats> {
  const key = name.trim().toLowerCase();
  const [row] = await db.select().from(quizCareers).where(eq(quizCareers.name, key)).limit(1);
  if (!row) return emptyQuizStats();
  try {
    return { ...emptyQuizStats(), ...(JSON.parse(row.stats) as Partial<QuizCareerStats>) };
  } catch {
    return emptyQuizStats();
  }
}

async function writeStats(name: string, stats: QuizCareerStats): Promise<void> {
  const key = name.trim().toLowerCase();
  const payload = JSON.stringify(stats);
  await db
    .insert(quizCareers)
    .values({ name: key, stats: payload, updated_at: new Date().toISOString() })
    .onConflictDoUpdate({
      target: quizCareers.name,
      set: { stats: payload, updated_at: new Date().toISOString() }
    });
}

export const quizCareerService = {
  async forName(name: string): Promise<QuizCareerStats> {
    return readStats(name);
  },

  /**
   * One token per point, rounded down.
   *
   * Points carry decimals — the scoring blends placement, clock and the field of
   * finishers — and a wallet with a fractional balance is a wallet nobody can
   * read. Rounding down rather than up so a round nobody scored on pays nothing.
   */
  async credit(name: string, points: number): Promise<QuizCareerStats> {
    const gained = Math.max(0, Math.floor(points));
    const stats = await readStats(name);
    if (gained === 0) return stats;

    stats.tokens += gained;
    stats.lifetime += gained;
    await writeStats(name, stats);
    return stats;
  },

  /** Spends, refusing rather than going negative. The caller has already priced it. */
  async debit(name: string, amount: number): Promise<{ ok: true; stats: QuizCareerStats } | { ok: false }> {
    const stats = await readStats(name);
    if (stats.tokens < amount) return { ok: false };

    stats.tokens -= amount;
    await writeStats(name, stats);
    return { ok: true, stats };
  }
};
