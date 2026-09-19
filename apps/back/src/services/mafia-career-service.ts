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

function parseStats(blob: string | undefined): MafiaCareerStats {
  if (blob === undefined) return emptyMafiaStats();
  try {
    return { ...emptyMafiaStats(), ...(JSON.parse(blob) as Partial<MafiaCareerStats>) };
  } catch {
    return emptyMafiaStats();
  }
}

/**
 * A detached copy, for the "before" and "after" a reward is the difference of.
 *
 * `unlocked` is copied by hand: a shallow spread would leave both halves sharing
 * the array, and the badge diff would find nothing new because the before had
 * quietly gained tonight's badges too.
 */
function snapshot(stats: MafiaCareerStats): MafiaCareerStats {
  return { ...stats, unlocked: [...stats.unlocked] };
}

async function readStats(name: string): Promise<MafiaCareerStats> {
  const key = name.trim().toLowerCase();
  const [row] = await db.select().from(mafiaCareers).where(eq(mafiaCareers.name, key)).limit(1);
  return parseStats(row?.stats);
}

/**
 * Reads a ledger, changes it and writes it back, all inside one transaction.
 *
 * Points are banked when a table ends and spent in the shop, and the two can
 * overlap: across separate awaits both sides read the same balance and the later
 * write won outright, so a table paying out could hand back points a purchase had
 * just taken. better-sqlite3 is synchronous, so a transaction closes the window
 * completely — there is no await between read and write to interleave at.
 *
 * `change` returns null to refuse, writing nothing.
 */
function mutateStats<R>(name: string, change: (stats: MafiaCareerStats) => R | null): R | null {
  const key = name.trim().toLowerCase();

  return db.transaction((tx) => {
    const [row] = tx.select().from(mafiaCareers).where(eq(mafiaCareers.name, key)).limit(1).all();
    const stats = parseStats(row?.stats);

    const result = change(stats);
    if (result === null) return null;

    const payload = JSON.stringify(stats);
    const stamp = new Date().toISOString();
    tx.insert(mafiaCareers)
      .values({ name: key, stats: payload, updated_at: stamp })
      .onConflictDoUpdate({ target: mafiaCareers.name, set: { stats: payload, updated_at: stamp } })
      .run();

    return result;
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

      // The before/after pair is taken inside the transaction, so it describes
      // this table's own payout rather than whatever the balance happened to be
      // either side of an overlapping purchase.
      const banked = mutateStats(ledger, (stats) => {
        // A copy, or the comparison below would be a snapshot of itself: the badge
        // diff asks what changed tonight, and it cannot ask that of one object.
        const before = snapshot(stats);
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
        return { before, after: snapshot(stats) };
      });

      if (banked) {
        rewards.push(
          mafiaReward({
            playerId: player.playerId,
            name: player.name,
            before: banked.before,
            after: banked.after,
            gained,
            total: banked.after.points
          })
        );
      }
    }

    return rewards;
  },

  /** The spendable balance. Points are earned by playing and spent in the shop. */
  async balance(name: string): Promise<number> {
    return (await readStats(name)).points;
  },

  /** Spends, refusing rather than going negative. The shop owns the price. */
  async spend(name: string, amount: number): Promise<{ ok: boolean; balance: number }> {
    const spent = mutateStats(name, (stats) => {
      if (stats.points < amount) return null;
      stats.points -= amount;
      return { balance: stats.points };
    });

    // Refused: report the balance as it stands, which is what the caller prices
    // its "you are short by" message from.
    return spent ? { ok: true, balance: spent.balance } : { ok: false, balance: await this.balance(name) };
  }
};
