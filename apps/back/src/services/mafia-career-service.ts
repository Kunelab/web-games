import {
  emptyMafiaStats,
  mafiaReward,
  pointsFor,
  type MafiaCareerStats,
  type MafiaReward,
  type MafiaState
} from 'mafia-core';
import { eq } from 'drizzle-orm';

import { db } from '../db/index.js';
import { mafiaCareers } from '../db/schema.js';

/**
 * The Mafia wallet: lifetime points per nickname (accounts under `@login`),
 * earned by playing and only by playing. The store spends from `points`; the
 * tallies feed the badge ladder. Same nickname-ledger design as CzCareers.
 *
 * The shape and the ladder over it live in `mafia-core/careers`, with the rest of
 * the rules: they are pure functions of these numbers, they need no database to
 * be right, and keeping them there is what lets them be tested without one. This
 * file is the part that cannot be pure — reading, writing, and banking a table.
 */

export type { MafiaCareerStats };
export { emptyMafiaStats };

export function mafiaLedger(player: { name: string; account?: string }): string {
  return player.account ? `@${player.account}` : player.name;
}

async function readStats(name: string): Promise<MafiaCareerStats> {
  const key = name.trim().toLowerCase();
  const [row] = await db.select().from(mafiaCareers).where(eq(mafiaCareers.name, key)).limit(1);
  if (!row) return emptyMafiaStats();
  try {
    return { ...emptyMafiaStats(), ...(JSON.parse(row.stats) as Partial<MafiaCareerStats>) };
  } catch {
    return emptyMafiaStats();
  }
}

async function writeStats(name: string, stats: MafiaCareerStats): Promise<void> {
  const key = name.trim().toLowerCase();
  const payload = JSON.stringify(stats);
  await db
    .insert(mafiaCareers)
    .values({ name: key, stats: payload, updated_at: new Date().toISOString() })
    .onConflictDoUpdate({
      target: mafiaCareers.name,
      set: { stats: payload, updated_at: new Date().toISOString() }
    });
}

/**
 * What one table paid, per seat.
 *
 * The wire type from `mafia-core`, re-exported under the name the manager and the
 * socket layer already use. It grew badges, a title and three bars this pass; it
 * was points and a running total, which is a receipt rather than a reason to sit
 * down again.
 */
export type MafiaGameReward = MafiaReward;

export const mafiaCareerService = {
  async forName(name: string): Promise<MafiaCareerStats> {
    return readStats(name);
  },

  /**
   * Banks a finished table into every human's career. Bots earn nothing —
   * their points exist only on the end screen, for the humans to compare.
   */
  async recordGame(state: MafiaState): Promise<MafiaGameReward[]> {
    const rewards: MafiaGameReward[] = [];

    for (const player of Object.values(state.players)) {
      const gained = pointsFor(state, player.playerId);
      const earned = state.points.filter((entry) => entry.playerId === player.playerId);

      if (player.isBot) {
        /**
         * A bot banks nothing, so both snapshots are the same and every derived
         * field comes back empty. Its row still carries what it scored, because
         * comparing yourself to the machine is half of why the table reads this.
         */
        const nothing = emptyMafiaStats();
        rewards.push(
          mafiaReward({
            playerId: player.playerId,
            name: player.name,
            before: nothing,
            after: nothing,
            gained,
            total: null
          })
        );
        continue;
      }

      const ledger = mafiaLedger(player);
      const before = await readStats(ledger);
      // A copy, or the comparison below would be a snapshot of itself: the badge
      // diff asks what changed tonight, and it cannot ask that of one object.
      const stats: MafiaCareerStats = { ...before, unlocked: [...before.unlocked] };
      stats.points += gained;
      stats.games += 1;
      if (state.winners.some((winner) => winner.playerId === player.playerId)) {
        stats.wins += 1;
        /**
         * A solo win is read off the scored entry, not off the winner's prose.
         *
         * It used to test `reason.includes('gagne seul')`, a sentence only the
         * hanged Jester's line contains — so the Executioner, the last blade
         * standing, the Arsonist, the Survivor, the lovers and every other seat
         * that wins alone banked the points and never the tally.
         */
        if (earned.some((entry) => entry.reason === 'solo-win')) stats.soloWins += 1;
      }
      stats.kills += earned.filter((entry) => entry.reason === 'kill').length;
      if (player.alive) stats.survived += 1;
      await writeStats(ledger, stats);

      rewards.push(
        mafiaReward({
          playerId: player.playerId,
          name: player.name,
          before,
          after: stats,
          gained,
          total: stats.points
        })
      );
    }

    return rewards;
  },

  /** The spendable balance. Points are earned by playing and spent in the shop. */
  async balance(name: string): Promise<number> {
    return (await readStats(name)).points;
  },

  /** Spends, refusing rather than going negative. The shop owns the price. */
  async spend(name: string, amount: number): Promise<{ ok: boolean; balance: number }> {
    const stats = await readStats(name);
    if (stats.points < amount) return { ok: false, balance: stats.points };

    stats.points -= amount;
    await writeStats(name, stats);
    return { ok: true, balance: stats.points };
  }
};
