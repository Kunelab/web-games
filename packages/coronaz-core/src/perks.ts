/**
 * The roguelite layer: what a nickname carries from raid to raid.
 *
 * Two hard rules, both about not breaking the game the simulator balanced:
 *
 * 1. Every perk is a small flat bonus with a built-in ceiling — one more hit
 *    point, one more bag slot, one reroll, one revive. Nothing multiplies,
 *    nothing stacks with itself, and the full set combined is roughly one good
 *    loot drop's worth of power. The room for that power comes from the
 *    difficulty ladder: apocalypse exists because veterans exist.
 * 2. Perks are never bought, they are earned: each one hangs off a trophy.
 *    Some trophies fall in the first evening, some take a season of raids.
 *    Trophies without a perk are pure bragging rights.
 */

/** Lifetime tallies for one nickname, the substrate every trophy reads. */
export interface CzCareerStats {
  raids: number;
  wins: number;
  deaths: number;
  escapes: number;
  kills: number;
  bossKills: number;
  searches: number;
  /** Fastest winning raid, in turns, keyed by scenario. */
  fastestWinTurns: Record<string, number>;
  /* The horde side. */
  gmRaids: number;
  gmWins: number;
  gmSpawns: number;
  /* The roster economy: rations buy characters, never stats. */
  rations: number;
  unlockedHeroes: string[];
  unlockedGm: string[];
}

export function emptyCareerStats(): CzCareerStats {
  return {
    raids: 0,
    wins: 0,
    deaths: 0,
    escapes: 0,
    kills: 0,
    bossKills: 0,
    searches: 0,
    fastestWinTurns: {},
    gmRaids: 0,
    gmWins: 0,
    gmSpawns: 0,
    rations: 0,
    unlockedHeroes: [],
    unlockedGm: []
  };
}

export type CzTrophyTier = 'facile' | 'normal' | 'exigeant';

export interface CzTrophyDef {
  key: string;
  tier: CzTrophyTier;
  /** The perk this trophy unlocks, when it unlocks one. */
  perk?: string;
  /** True when it belongs to the game master's track. */
  gm?: boolean;
  earned: (stats: CzCareerStats) => boolean;
}

/* ------------------------------ player perks ------------------------------ */

export const HERO_PERKS = {
  /** +1 max HP. */
  'tough-skin': 'tough-skin',
  /** +1 bag slot. */
  'deep-pockets': 'deep-pockets',
  /** Once per raid, a killing blow leaves you at 1 HP instead. */
  'second-wind': 'second-wind',
  /** +1 AP on the first turn of a raid. */
  sprinter: 'sprinter',
  /** +1 die against bosses. */
  'boss-slayer': 'boss-slayer',
  /** The first search of a raid always finds rarity 3 or better. */
  'lucky-find': 'lucky-find'
} as const;

export const GM_PERKS = {
  /** +4 starting budget. */
  'dark-pact': 'dark-pact',
  /** +2 income per turn. */
  overlord: 'overlord',
  /** The first spawn each phase costs 1 less (never below 1). */
  breeder: 'breeder',
  /**
   * The first rank of Carapace costs half. A discount, deliberately not a
   * freebie: handing out hide level 1 at turn one was worth 26 points of win
   * rate on the bench, which is not "a small flat bonus".
   */
  'iron-horde': 'iron-horde'
} as const;

/* -------------------------------- trophies -------------------------------- */

export const CZ_TROPHIES: readonly CzTrophyDef[] = [
  /* Survivor track: easy → grindy. */
  { key: 'first-raid', tier: 'facile', earned: (s) => s.raids >= 1 },
  { key: 'first-escape', tier: 'facile', perk: 'tough-skin', earned: (s) => s.wins >= 1 },
  { key: 'packrat', tier: 'facile', perk: 'deep-pockets', earned: (s) => s.searches >= 25 },
  { key: 'left-for-dead', tier: 'normal', perk: 'second-wind', earned: (s) => s.deaths >= 5 },
  {
    key: 'blitz',
    tier: 'normal',
    perk: 'sprinter',
    earned: (s) => (s.fastestWinTurns.escape ?? Number.POSITIVE_INFINITY) <= 8
  },
  { key: 'veteran', tier: 'normal', earned: (s) => s.raids >= 20 },
  { key: 'boss-hunter', tier: 'exigeant', perk: 'boss-slayer', earned: (s) => s.bossKills >= 10 },
  { key: 'hoarder', tier: 'exigeant', perk: 'lucky-find', earned: (s) => s.searches >= 100 },
  { key: 'centurion-z', tier: 'exigeant', earned: (s) => s.kills >= 100 },

  /* Horde track. */
  { key: 'dark-dabbler', tier: 'facile', gm: true, perk: 'dark-pact', earned: (s) => s.gmRaids >= 1 },
  { key: 'hordemaster', tier: 'normal', gm: true, perk: 'overlord', earned: (s) => s.gmWins >= 3 },
  { key: 'breeder', tier: 'exigeant', gm: true, perk: 'breeder', earned: (s) => s.gmSpawns >= 100 },
  { key: 'tyrant', tier: 'exigeant', gm: true, perk: 'iron-horde', earned: (s) => s.gmWins >= 10 }
];

export function trophiesFor(stats: CzCareerStats): string[] {
  return CZ_TROPHIES.filter((trophy) => trophy.earned(stats)).map((trophy) => trophy.key);
}

/** The hero perks a career has unlocked. */
export function heroPerksFor(stats: CzCareerStats): string[] {
  return CZ_TROPHIES.filter((trophy) => !trophy.gm && trophy.perk && trophy.earned(stats)).map(
    (trophy) => trophy.perk as string
  );
}

/** The game master perks a career has unlocked. */
export function gmPerksFor(stats: CzCareerStats): string[] {
  return CZ_TROPHIES.filter((trophy) => trophy.gm && trophy.perk && trophy.earned(stats)).map(
    (trophy) => trophy.perk as string
  );
}

export const ALL_HERO_PERKS = Object.keys(HERO_PERKS);
export const ALL_GM_PERKS = Object.keys(GM_PERKS);
