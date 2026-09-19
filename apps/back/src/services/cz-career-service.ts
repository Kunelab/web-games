import {
  emptyCareerStats,
  gmClassDef,
  gmPerksFor,
  gmRaidRations,
  heroDef,
  heroPerksFor,
  raidRations,
  raidReward,
  trophiesFor,
  GM_CLASSES,
  GM_REWARD_ID,
  HEROES,
  type CzCareerStats,
  type CzRaidReward,
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

function parseStats(blob: string | undefined): CzCareerStats {
  if (blob === undefined) return emptyCareerStats();
  try {
    return { ...emptyCareerStats(), ...(JSON.parse(blob) as Partial<CzCareerStats>) };
  } catch {
    return emptyCareerStats();
  }
}

/**
 * A detached copy, for the "before" and "after" a reward is the difference of.
 *
 * `fastestWinTurns` is copied by hand because it is the one nested object here,
 * and a shallow spread would leave both halves of the pair sharing it — the
 * before would silently gain the record the after just set.
 */
function snapshot(stats: CzCareerStats): CzCareerStats {
  return { ...stats, fastestWinTurns: { ...stats.fastestWinTurns } };
}

async function readStats(name: string): Promise<CzCareerStats> {
  const key = name.trim().toLowerCase();
  const [row] = await db.select().from(czCareers).where(eq(czCareers.name, key)).limit(1);
  return parseStats(row?.stats);
}

/**
 * Reads a ledger, changes it and writes it back, all inside one transaction.
 *
 * Rations are spent from three places — two unlocks and the shop — and credited
 * from a fourth when a raid ends. All four used to read, think, and write across
 * separate awaits, so two of them overlapping both read the same balance and the
 * later write won: a raid banking its rations could hand back rations the shop had
 * just taken, and two unlocks bought at once cost the price of one.
 *
 * better-sqlite3 is synchronous, so the transaction is the whole of the fix: there
 * is no await between the read and the write for anything to interleave at.
 *
 * `change` returns null to refuse, writing nothing — which is how a purchase the
 * balance cannot cover declines without having to look before it leaps.
 */
function mutateStats<R>(name: string, change: (stats: CzCareerStats) => R | null): R | null {
  const key = name.trim().toLowerCase();

  return db.transaction((tx) => {
    const [row] = tx.select().from(czCareers).where(eq(czCareers.name, key)).limit(1).all();
    const stats = parseStats(row?.stats);

    const result = change(stats);
    if (result === null) return null;

    const payload = JSON.stringify(stats);
    const stamp = new Date().toISOString();
    tx.insert(czCareers)
      .values({ name: key, stats: payload, updated_at: stamp })
      .onConflictDoUpdate({ target: czCareers.name, set: { stats: payload, updated_at: stamp } })
      .run();

    return result;
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
  async recordGame(state: CzState, gmLogin: string | null): Promise<CzRaidReward[]> {
    const won = state.phase === 'won';
    const rewards: CzRaidReward[] = [];

    for (const hero of Object.values(state.heroes)) {
      if (hero.isBot) continue;
      // The account wins over the nickname when the phone is logged in: rations
      // belong to a person, not to whatever name he typed tonight.
      const ledger = careerKey(hero);
      /**
       * A survivor who walked away banks what he earned and nothing more.
       *
       * He keeps his score (he did the work up to the door) and he is not counted
       * dead, because he is not: leaving early and being eaten are different
       * evenings. But the raid was not won by him, so neither the win nor its bonus
       * follows him, or forfeiting would be the cheapest way to farm a victory.
       */
      const credited = won && !hero.forfeited;

      // The before/after pair the reward is built from is taken inside the
      // transaction, so it describes this raid's own credit rather than whatever
      // the balance happened to be either side of an overlapping purchase.
      const banked = mutateStats(ledger, (stats) => {
        const before = snapshot(stats);
        // Rations are their own currency now, not the scoreboard — see `raidRations`
        // for why one raid used to buy any character in the game.
        stats.rations += raidRations({
          turns: state.turn,
          won: credited,
          kills: hero.kills,
          searches: hero.searches
        });
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
        return { before, after: snapshot(stats) };
      });

      // What to show this player before they put the phone down.
      if (banked) {
        rewards.push(
          raidReward({
            playerId: hero.playerId,
            name: hero.name,
            before: banked.before,
            after: banked.after,
            roster: HEROES
          })
        );
      }
    }

    if (state.config.mode === 'gm' && gmLogin) {
      const hordeWon = state.phase === 'lost';
      // Everything that ever stood on the board, seeds and summons included.
      const spawns = state.nextZombieId - 1;

      const banked = mutateStats(accountKey(gmLogin), (stats) => {
        const before = snapshot(stats);
        stats.gmRaids += 1;
        stats.gmWins += hordeWon ? 1 : 0;
        stats.gmSpawns += spawns;
        // The horde eats too: pressure applied is pressure paid.
        stats.rations += gmRaidRations({ turns: state.turn, won: hordeWon, spawns });
        return { before, after: snapshot(stats) };
      });

      if (banked) {
        rewards.push(
          raidReward({
            playerId: GM_REWARD_ID,
            name: gmLogin,
            before: banked.before,
            after: banked.after,
            roster: GM_CLASSES,
            gm: true
          })
        );
      }
    }

    return rewards;
  },

  /** Spends rations on a survivor. Validates ownership and price server-side. */
  async unlockHero(name: string, heroId: string): Promise<{ ok: boolean; error?: string }> {
    const definition = heroDef(heroId);
    const cost = definition.cost;
    if (!cost) return { ok: true }; // Base roster: nothing to buy.

    const outcome = mutateStats(name, (stats) => {
      if (stats.unlockedHeroes.includes(heroId)) return { ok: true as const, already: true };
      if (stats.rations < cost) {
        return { ok: false as const, error: `Il faut ${cost} rations (vous en avez ${stats.rations})` };
      }
      stats.rations -= cost;
      stats.unlockedHeroes.push(heroId);
      return { ok: true as const, already: false };
    });

    return outcome ?? { ok: false, error: 'Impossible' };
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
    const cost = definition.cost;
    if (!cost) return { ok: true };

    const outcome = mutateStats(accountKey(login), (stats) => {
      if (stats.unlockedGm.includes(classId)) return { ok: true as const };
      if (stats.rations < cost) {
        return { ok: false as const, error: `Il faut ${cost} rations (vous en avez ${stats.rations})` };
      }
      stats.rations -= cost;
      stats.unlockedGm.push(classId);
      return { ok: true as const };
    });

    return outcome ?? { ok: false, error: 'Impossible' };
  },

  async gmClassAllowed(login: string, classId: string): Promise<boolean> {
    const definition = gmClassDef(classId);
    if (!definition.cost) return true;
    const stats = await readStats(accountKey(login));
    return stats.unlockedGm.includes(classId);
  },

  /**
   * Spends rations on something this service does not know the price of.
   *
   * The two unlocks above price their own goods because the roster owns those
   * numbers. A shop item's price is the shop's, so this takes an amount and does
   * only the part that must not be done anywhere else: check the balance and
   * decrement it in the same read-modify-write.
   */
  async spend(name: string, amount: number): Promise<{ ok: boolean; balance: number }> {
    const spent = mutateStats(name, (stats) => {
      if (stats.rations < amount) return null;
      stats.rations -= amount;
      return { balance: stats.rations };
    });

    // Refused: report the balance as it stands, which is what the caller prices
    // its "you are short by" message from.
    return spent ? { ok: true, balance: spent.balance } : { ok: false, balance: await this.balance(name) };
  },

  /** The spendable balance alone, without deriving trophies and perks for it. */
  async balance(name: string): Promise<number> {
    return (await readStats(name)).rations;
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
