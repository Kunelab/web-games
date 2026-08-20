import type { MafiaState } from 'mafia-core';
import { eq } from 'drizzle-orm';

import { db } from '../db/index.js';
import { mafiaCareers } from '../db/schema.js';

/**
 * The Mafia wallet: lifetime points per nickname (accounts under `@login`),
 * earned by playing and only by playing. The store will spend from `points`;
 * the tallies feed titles later. Same nickname-ledger design as CzCareers.
 */

export interface MafiaCareerStats {
  points: number;
  games: number;
  wins: number;
  soloWins: number;
  kills: number;
  survived: number;
  /** Cosmetic unlock ids, spent from `points`. */
  unlocked: string[];
}

export function emptyMafiaStats(): MafiaCareerStats {
  return { points: 0, games: 0, wins: 0, soloWins: 0, kills: 0, survived: 0, unlocked: [] };
}

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

export interface MafiaGameReward {
  playerId: string;
  name: string;
  gained: number;
  total: number | null;
}

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
      const gained = state.points
        .filter((entry) => entry.playerId === player.playerId)
        .reduce((sum, entry) => sum + entry.amount, 0);

      if (player.isBot) {
        rewards.push({ playerId: player.playerId, name: player.name, gained, total: null });
        continue;
      }

      const ledger = mafiaLedger(player);
      const stats = await readStats(ledger);
      stats.points += gained;
      stats.games += 1;
      if (state.winners.some((winner) => winner.playerId === player.playerId)) {
        stats.wins += 1;
        if (state.winners.some((w) => w.playerId === player.playerId && w.reason.includes('gagne seul'))) {
          stats.soloWins += 1;
        }
      }
      stats.kills += state.points.filter((e) => e.playerId === player.playerId && e.reason === 'kill').length;
      if (player.alive) stats.survived += 1;
      await writeStats(ledger, stats);

      rewards.push({ playerId: player.playerId, name: player.name, gained, total: stats.points });
    }

    return rewards;
  }
};
