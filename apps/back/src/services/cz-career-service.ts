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

/**
 * Which ledger a seat pays into: the Kune account when the socket carried a
 * logged-in session, the nickname otherwise. Accounts are prefixed so a login
 * can never collide with somebody's nickname.
 */
export function careerKey(hero: { name: string; account?: string }): string {
  return hero.account ? accountKey(hero.account) : hero.name;
}

/** The ledger of a Kune login. Prefixed so it cannot collide with a nickname. */
export function accountKey(login: string): string {
  return `@${login}`;
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
    return gmPerksFor(await readStats(accountKey(login)));
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
      // The account wins over the nickname when the phone is logged in: rations
      // belong to a person, not to whatever name he typed tonight.
      const ledger = careerKey(hero);
      const stats = await readStats(ledger);
      /**
       * A survivor who walked away banks what he earned and nothing more.
       *
       * He keeps his score (he did the work up to the door) and he is not counted
       * dead, because he is not: leaving early and being eaten are different
       * evenings. But the raid was not won by him, so neither the win nor its bonus
       * follows him, or forfeiting would be the cheapest way to farm a victory.
       */
      const credited = won && !hero.forfeited;
      stats.rations += Math.max(0, Math.round(scores.get(hero.playerId) ?? 0)) + (credited ? 10 : 0);
      stats.raids += 1;
      stats.wins += credited ? 1 : 0;
      stats.deaths += hero.alive ? 0 : 1;
      stats.escapes += hero.escaped ? 1 : 0;
      stats.kills += hero.kills;
      stats.bossKills += hero.bossKills;
      stats.searches += hero.searches;
      if (credited) {
        const scenario = state.config.scenario;
        const best = stats.fastestWinTurns[scenario];
        stats.fastestWinTurns[scenario] = best === undefined ? state.turn : Math.min(best, state.turn);
      }
      await writeStats(ledger, stats);
    }

    if (state.config.mode === 'gm' && gmLogin) {
      const stats = await readStats(accountKey(gmLogin));
      stats.gmRaids += 1;
      stats.gmWins += state.phase === 'lost' ? 1 : 0;
      // Everything that ever stood on the board, seeds and summons included.
      stats.gmSpawns += state.nextZombieId - 1;
      // The horde eats too: pressure applied is pressure paid.
      stats.rations += state.turn * 3 + (state.phase === 'lost' ? 15 : 0);
      await writeStats(accountKey(gmLogin), stats);
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

    const stats = await readStats(accountKey(login));
    if (stats.unlockedGm.includes(classId)) return { ok: true };
    if (stats.rations < definition.cost) {
      return { ok: false, error: `Il faut ${definition.cost} rations (vous en avez ${stats.rations})` };
    }
    stats.rations -= definition.cost;
    stats.unlockedGm.push(classId);
    await writeStats(accountKey(login), stats);
    return { ok: true };
  },

  async gmClassAllowed(login: string, classId: string): Promise<boolean> {
    const definition = gmClassDef(classId);
    if (!definition.cost) return true;
    const stats = await readStats(accountKey(login));
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
