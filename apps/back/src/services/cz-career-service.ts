import {
  emptyCareerStats,
  finalScores,
  gmClassDef,
  gmPerksFor,
  heroDef,
  heroPerksFor,
  trophiesFor,
  type CzCareerStats,
  type CzState
} from 'coronaz-core';
import { eq } from 'drizzle-orm';

import { db } from '../db/index.js';
import { czCareers } from '../db/schema.js';

/**
 * The roguelite's memory: lifetime CoronaZ tallies per nickname.
 *
 * Nicknames are the identity here for the same reason they are in the quiz
 * careers — players join from phones without accounts, and "Max" is the same
 * Max every Saturday. The game master is recorded under the host account's
 * login, so his dark career follows him too.
 *
 * Trophies and perks are pure functions over these numbers (coronaz-core owns
 * them), recomputed on every read: storing them would freeze yesterday's
 * thresholds into everyone's rows.
 */

export interface CzCareerView {
  name: string;
  stats: CzCareerStats;
  trophies: string[];
  heroPerks: string[];
  gmPerks: string[];
}

async function readStats(name: string): Promise<CzCareerStats> {
  const key = name.trim().toLowerCase();
  const [row] = await db.select().from(czCareers).where(eq(czCareers.name, key)).limit(1);
  if (!row) return emptyCareerStats();
  try {
    return { ...emptyCareerStats(), ...(JSON.parse(row.stats) as Partial<CzCareerStats>) };
  } catch {
    return emptyCareerStats();
  }
}

async function writeStats(name: string, stats: CzCareerStats): Promise<void> {
  const key = name.trim().toLowerCase();
  const payload = JSON.stringify(stats);
  await db
    .insert(czCareers)
    .values({ name: key, stats: payload, updated_at: new Date().toISOString() })
    .onConflictDoUpdate({
      target: czCareers.name,
      set: { stats: payload, updated_at: new Date().toISOString() }
    });
}

export const czCareerService = {
  /** The perks a survivor walks in with, for cz:join. */
  async heroPerks(name: string): Promise<string[]> {
    return heroPerksFor(await readStats(name));
  },

  /** The perks a game master brings, resolved from the host account's login. */
  async gmPerks(login: string): Promise<string[]> {
    return gmPerksFor(await readStats(login));
  },

  /**
   * Banks a finished raid into every participant's career.
   *
   * Called once per game, right where the results row is written; the state is
   * about to be deleted, so this is the only moment these numbers exist.
   */
  async recordGame(state: CzState, gmLogin: string | null): Promise<void> {
    const won = state.phase === 'won';
    // Rations track the scoreboard: playing earns, winning earns more. Bots eat
    // nothing — their careers would otherwise hoard the pantry.
    const scores = new Map(finalScores(state).map((score) => [score.playerId, score.score]));

    for (const hero of Object.values(state.heroes)) {
      if (hero.isBot) continue;
      const stats = await readStats(hero.name);
      stats.rations += Math.max(0, Math.round(scores.get(hero.playerId) ?? 0)) + (won ? 10 : 0);
      stats.raids += 1;
      stats.wins += won ? 1 : 0;
      stats.deaths += hero.alive ? 0 : 1;
      stats.escapes += hero.escaped ? 1 : 0;
      stats.kills += hero.kills;
      stats.bossKills += hero.bossKills;
      stats.searches += hero.searches;
      if (won) {
        const scenario = state.config.scenario;
        const best = stats.fastestWinTurns[scenario];
        stats.fastestWinTurns[scenario] = best === undefined ? state.turn : Math.min(best, state.turn);
      }
      await writeStats(hero.name, stats);
    }

    if (state.config.mode === 'gm' && gmLogin) {
      const stats = await readStats(gmLogin);
      stats.gmRaids += 1;
      stats.gmWins += state.phase === 'lost' ? 1 : 0;
      // Everything that ever stood on the board, seeds and summons included.
      stats.gmSpawns += state.nextZombieId - 1;
      // The horde eats too: pressure applied is pressure paid.
      stats.rations += state.turn * 3 + (state.phase === 'lost' ? 15 : 0);
      await writeStats(gmLogin, stats);
    }
  },

  /** Spends rations on a survivor. Validates ownership and price server-side. */
  async unlockHero(name: string, heroId: string): Promise<{ ok: boolean; error?: string }> {
    const definition = heroDef(heroId);
    if (!definition.cost) return { ok: true }; // Base roster: nothing to buy.

    const stats = await readStats(name);
    if (stats.unlockedHeroes.includes(heroId)) return { ok: true };
    if (stats.rations < definition.cost) {
      return { ok: false, error: `Il faut ${definition.cost} rations (vous en avez ${stats.rations})` };
    }
    stats.rations -= definition.cost;
    stats.unlockedHeroes.push(heroId);
    await writeStats(name, stats);
    return { ok: true };
  },

  /** True when this nickname may play this survivor. */
  async heroAllowed(name: string, heroId: string): Promise<boolean> {
    const definition = heroDef(heroId);
    if (!definition.cost) return true;
    const stats = await readStats(name);
    return stats.unlockedHeroes.includes(heroId);
  },

  /** Spends the host's rations on a horde class. */
  async unlockGm(login: string, classId: string): Promise<{ ok: boolean; error?: string }> {
    const definition = gmClassDef(classId);
    if (!definition.cost) return { ok: true };

    const stats = await readStats(login);
    if (stats.unlockedGm.includes(classId)) return { ok: true };
    if (stats.rations < definition.cost) {
      return { ok: false, error: `Il faut ${definition.cost} rations (vous en avez ${stats.rations})` };
    }
    stats.rations -= definition.cost;
    stats.unlockedGm.push(classId);
    await writeStats(login, stats);
    return { ok: true };
  },

  async gmClassAllowed(login: string, classId: string): Promise<boolean> {
    const definition = gmClassDef(classId);
    if (!definition.cost) return true;
    const stats = await readStats(login);
    return stats.unlockedGm.includes(classId);
  },

  /** One nickname's full ledger, for the lobby and the setup screen. */
  async forName(name: string): Promise<CzCareerView> {
    const stats = await readStats(name);
    return {
      name: name.trim().toLowerCase(),
      stats,
      trophies: trophiesFor(stats),
      heroPerks: heroPerksFor(stats),
      gmPerks: gmPerksFor(stats)
    };
  },

  /** Every career, dressed with its derived trophies and perks. */
  async list(): Promise<CzCareerView[]> {
    const rows = await db.select().from(czCareers);
    return rows
      .map((row) => {
        let stats: CzCareerStats;
        try {
          stats = { ...emptyCareerStats(), ...(JSON.parse(row.stats) as Partial<CzCareerStats>) };
        } catch {
          stats = emptyCareerStats();
        }
        return {
          name: row.name,
          stats,
          trophies: trophiesFor(stats),
          heroPerks: heroPerksFor(stats),
          gmPerks: gmPerksFor(stats)
        };
      })
      .sort(
        (a, b) => b.stats.wins - a.stats.wins || b.stats.raids - a.stats.raids || a.name.localeCompare(b.name, 'fr')
      );
  }
};
