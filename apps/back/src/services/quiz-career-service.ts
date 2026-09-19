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

function parseStats(blob: string | undefined): QuizCareerStats {
  if (blob === undefined) return emptyQuizStats();
  try {
    return { ...emptyQuizStats(), ...(JSON.parse(blob) as Partial<QuizCareerStats>) };
  } catch {
    return emptyQuizStats();
  }
}

async function readStats(name: string): Promise<QuizCareerStats> {
  const key = name.trim().toLowerCase();
  const [row] = await db.select().from(quizCareers).where(eq(quizCareers.name, key)).limit(1);
  return parseStats(row?.stats);
}

/**
 * Reads a wallet, changes it and writes it back, all inside one transaction.
 *
 * A balance is the one number here that two things genuinely race for: a game
 * banking its tokens and the shop taking some out can overlap to the millisecond,
 * and the reads and writes used to be separate awaits with nothing holding them
 * together. Both sides then read the same starting balance and the later write
 * won outright — a credit could erase a purchase, or a purchase could hand back
 * money that had been spent.
 *
 * better-sqlite3 is synchronous, so a transaction is genuinely the whole of the
 * fix: nothing can interleave between the read and the write because there is no
 * await for it to interleave at.
 *
 * `change` returns null to refuse, which rolls the whole thing back and writes
 * nothing — that is how a debit against too small a balance declines without
 * having to look before it leaps.
 */
function mutateStats<R>(name: string, change: (stats: QuizCareerStats) => R | null): R | null {
  const key = name.trim().toLowerCase();

  return db.transaction((tx) => {
    const [row] = tx.select().from(quizCareers).where(eq(quizCareers.name, key)).limit(1).all();
    const stats = parseStats(row?.stats);

    const result = change(stats);
    if (result === null) return null;

    const payload = JSON.stringify(stats);
    const stamp = new Date().toISOString();
    tx.insert(quizCareers)
      .values({ name: key, stats: payload, updated_at: stamp })
      .onConflictDoUpdate({ target: quizCareers.name, set: { stats: payload, updated_at: stamp } })
      .run();

    return result;
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
    if (gained === 0) return readStats(name);

    return (
      mutateStats(name, (stats) => {
        stats.tokens += gained;
        stats.lifetime += gained;
        return { ...stats };
      }) ?? emptyQuizStats()
    );
  },

  /** Spends, refusing rather than going negative. The caller has already priced it. */
  async debit(name: string, amount: number): Promise<{ ok: true; stats: QuizCareerStats } | { ok: false }> {
    // The balance is tested inside the transaction, so the money is either there
    // and taken or not there and refused, with nothing in between for a second
    // caller to read.
    const stats = mutateStats(name, (current) => {
      if (current.tokens < amount) return null;
      current.tokens -= amount;
      return { ...current };
    });

    return stats ? { ok: true, stats } : { ok: false };
  }
};
