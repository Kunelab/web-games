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
  /**
   * How close this career is, as a count against a target.
   *
   * Declared next to `earned` and never derived from it, because a boolean cannot
   * be drawn. A trophy nobody can see themselves approaching is not a goal, it is
   * a surprise — and "100 fouilles" is only motivating if the raid that ends at 72
   * says so. The end screen reads this; so does the lobby.
   *
   * `earned` stays the authority on whether it is unlocked: the two agree by
   * construction for every trophy here, and a test pins that.
   */
  progress: (stats: CzCareerStats) => { current: number; target: number; unit: string };
}

/** How far along a trophy is, clamped, for a bar. */
export function trophyRatio(trophy: CzTrophyDef, stats: CzCareerStats): number {
  if (trophy.earned(stats)) return 1;
  const { current, target } = trophy.progress(stats);
  if (target <= 0) return 0;
  return Math.max(0, Math.min(1, current / target));
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

/** A counted threshold: the shape almost every trophy has. */
function count(read: (stats: CzCareerStats) => number, target: number, unit: string) {
  return {
    earned: (stats: CzCareerStats) => read(stats) >= target,
    progress: (stats: CzCareerStats) => ({ current: read(stats), target, unit })
  };
}

export const CZ_TROPHIES: readonly CzTrophyDef[] = [
  /* Survivor track: easy → grindy. */
  { key: 'first-raid', tier: 'facile', ...count((s) => s.raids, 1, 'raid') },
  { key: 'first-escape', tier: 'facile', perk: 'tough-skin', ...count((s) => s.wins, 1, 'victoire') },
  { key: 'packrat', tier: 'facile', perk: 'deep-pockets', ...count((s) => s.searches, 25, 'fouilles') },
  { key: 'left-for-dead', tier: 'normal', perk: 'second-wind', ...count((s) => s.deaths, 5, 'chutes') },
  {
    key: 'blitz',
    tier: 'normal',
    perk: 'sprinter',
    earned: (s) => (s.fastestWinTurns.escape ?? Number.POSITIVE_INFINITY) <= 8,
    /**
     * Counted backwards, because this is the one trophy that is not an
     * accumulation: it asks for a *faster* raid, so progress is how much of the
     * gap you have closed from a first win towards eight turns. Before any win
     * there is nothing to close and it reads zero.
     */
    progress: (s) => {
      const best = s.fastestWinTurns.escape;
      if (best === undefined) return { current: 0, target: 8, unit: 'tours' };
      return { current: Math.max(0, Math.min(8, 8 - (best - 8))), target: 8, unit: 'tours' };
    }
  },
  { key: 'veteran', tier: 'normal', ...count((s) => s.raids, 20, 'raids') },
  { key: 'boss-hunter', tier: 'exigeant', perk: 'boss-slayer', ...count((s) => s.bossKills, 10, 'boss') },
  { key: 'hoarder', tier: 'exigeant', perk: 'lucky-find', ...count((s) => s.searches, 100, 'fouilles') },
  { key: 'centurion-z', tier: 'exigeant', ...count((s) => s.kills, 100, 'victimes') },

  /* Horde track. */
  { key: 'dark-dabbler', tier: 'facile', gm: true, perk: 'dark-pact', ...count((s) => s.gmRaids, 1, 'raid') },
  { key: 'hordemaster', tier: 'normal', gm: true, perk: 'overlord', ...count((s) => s.gmWins, 3, 'victoires') },
  { key: 'breeder', tier: 'exigeant', gm: true, perk: 'breeder', ...count((s) => s.gmSpawns, 100, 'invocations') },
  { key: 'tyrant', tier: 'exigeant', gm: true, perk: 'iron-horde', ...count((s) => s.gmWins, 10, 'victoires') }
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

/* ------------------------------ the ration economy ------------------------------ */

/**
 * What one raid pays into a survivor's pantry.
 *
 * This used to be the raid's *score* plus ten, and the score averages 150–220 —
 * against a roster priced 150 to 400. One evening therefore bought a character,
 * any character, and the whole unlockable roster was gone in ten or twelve nights.
 * A progression that finishes before the third weekend is the reason the third
 * weekend feels like there is nothing left to want, and it was the sharpest
 * fixable thing about the game's replay value.
 *
 * So rations are now their own small currency, unhooked from score and paid for
 * things a player can feel themselves doing: turns endured, the win, kills,
 * searches. A typical winning raid pays about forty-five, a losing one about
 * twenty-five — so the cheapest character is three or four evenings and the
 * dearest is nine or ten, and the full roster is a season rather than a fortnight.
 *
 * Losing still pays, at roughly sixty per cent. A currency you only earn by
 * winning punishes exactly the evenings that already went badly.
 */
export function raidRations(input: {
  /** Turns the raid lasted: time endured, the same for everyone at the table. */
  turns: number;
  /** Credited with the win — a forfeit is not, or forfeiting would be farming. */
  won: boolean;
  kills: number;
  searches: number;
}): number {
  return (
    RATION_SHOWING_UP +
    Math.max(0, input.turns) +
    (input.won ? RATION_WIN : 0) +
    Math.floor(Math.max(0, input.kills) / 4) +
    Math.floor(Math.max(0, input.searches) / 3)
  );
}

/** Turning up at all is worth something: a wiped raid still bought the evening. */
export const RATION_SHOWING_UP = 8;
export const RATION_WIN = 12;

/** What one raid pays the horde. Priced against the survivors' side, not above it. */
export function gmRaidRations(input: { turns: number; won: boolean; spawns: number }): number {
  return (
    RATION_SHOWING_UP +
    Math.max(0, input.turns) +
    (input.won ? RATION_WIN : 0) +
    Math.floor(Math.max(0, input.spawns) / 4)
  );
}

/* -------------------------------- the payoff -------------------------------- */

/**
 * The game master's stand-in player id in a reward list.
 *
 * He holds no seat, so he has no `playerId` — but the payoff screen highlights the
 * reader's own row, and his phone has to be able to find it. Declared here rather
 * than on either side of the socket because both of them compare against it, which
 * is exactly the kind of shared literal this package exists to hold.
 */
export const GM_REWARD_ID = '__gm';

/** A trophy as the end screen draws it: where you are, and what it would give you. */
export interface CzTrophyProgressView {
  key: string;
  tier: CzTrophyTier;
  perk?: string;
  gm?: boolean;
  current: number;
  target: number;
  unit: string;
  done: boolean;
  /** Advanced during the raid that just ended. */
  moved: boolean;
}

/**
 * What one raid earned, per player: the end-of-raid payoff screen's whole content.
 *
 * The rations were always banked and never shown. The end screen listed the
 * verdict, the scores and the awards, and said nothing about the career the raid
 * had just fed — so the single strongest retention lever in the genre was being
 * computed, written to the database, and hidden until the next lobby. A player who
 * cannot see progress has no reason to believe there is any.
 */
export interface CzRaidReward {
  playerId: string;
  name: string;
  /**
   * This row belongs to the horde's track.
   *
   * Carried so the screen can look a newly affordable id up in the right roster.
   * Without it the payoff screen has to guess, and guessing wrong means printing
   * `crypte` at somebody instead of "Seigneur des cryptes".
   */
  gm?: boolean;
  /** Rations this raid paid, and the balance afterwards. */
  rationsGained: number;
  rations: number;
  /** Trophies that fell tonight, and the perks they turned on. */
  newTrophies: string[];
  newPerks: string[];
  /** Characters this balance can now afford that it could not before. */
  affordable: { id: string; cost: number }[];
  /** The nearest three unearned trophies, closest first: the reason to come back. */
  nextTrophies: CzTrophyProgressView[];
}

/**
 * The nearest unearned trophies, closest first.
 *
 * Ranked by how far along they are rather than by tier, because "72 of 100
 * fouilles" is a better thing to show a tired table than an easier trophy they
 * have not touched. Ties break towards the cheaper tier.
 */
export function nextTrophies(stats: CzCareerStats, options: { gm?: boolean; limit?: number } = {}): CzTrophyProgressView[] {
  const wantGm = options.gm ?? false;
  const tierRank: Record<CzTrophyTier, number> = { facile: 0, normal: 1, exigeant: 2 };

  return CZ_TROPHIES.filter((trophy) => (trophy.gm ?? false) === wantGm)
    .filter((trophy) => !trophy.earned(stats))
    .map((trophy) => {
      const { current, target, unit } = trophy.progress(stats);
      return {
        key: trophy.key,
        tier: trophy.tier,
        perk: trophy.perk,
        gm: trophy.gm,
        current,
        target,
        unit,
        done: false,
        moved: false,
        ratio: trophyRatio(trophy, stats)
      };
    })
    .sort((a, b) => b.ratio - a.ratio || tierRank[a.tier] - tierRank[b.tier])
    .slice(0, options.limit ?? 3)
    .map(({ ratio: _ratio, ...view }) => view);
}

/**
 * The difference one raid made to one career.
 *
 * Takes both snapshots rather than recomputing from the raid, because "what is
 * new" is exactly a comparison and nothing else can answer it: a trophy that was
 * already held must not be announced again, and a character already owned is not
 * newly affordable.
 */
export function raidReward(input: {
  playerId: string;
  name: string;
  before: CzCareerStats;
  after: CzCareerStats;
  /** The unlockable roster, so "you can now afford" can be answered here. */
  roster: readonly { id: string; cost?: number }[];
  gm?: boolean;
}): CzRaidReward {
  const { before, after, gm = false } = input;

  const heldBefore = new Set(trophiesFor(before));
  const newTrophies = trophiesFor(after).filter((key) => !heldBefore.has(key));

  const perksBefore = new Set(gm ? gmPerksFor(before) : heroPerksFor(before));
  const newPerks = (gm ? gmPerksFor(after) : heroPerksFor(after)).filter((perk) => !perksBefore.has(perk));

  const owned = new Set(gm ? after.unlockedGm : after.unlockedHeroes);
  const affordable = input.roster
    .filter((entry) => entry.cost !== undefined && entry.cost > 0)
    .filter((entry) => !owned.has(entry.id))
    // Newly within reach: affordable now and not before. A list of everything
    // affordable would repeat itself every raid and stop meaning anything.
    .filter((entry) => (entry.cost ?? 0) <= after.rations && (entry.cost ?? 0) > before.rations)
    .map((entry) => ({ id: entry.id, cost: entry.cost ?? 0 }))
    .sort((a, b) => a.cost - b.cost);

  // Which of the near trophies actually moved tonight, so the bar can say so.
  const beforeAt = new Map(
    CZ_TROPHIES.map((trophy) => [trophy.key, trophy.progress(before).current] as const)
  );

  return {
    playerId: input.playerId,
    name: input.name,
    gm,
    rationsGained: after.rations - before.rations,
    rations: after.rations,
    newTrophies,
    newPerks,
    affordable,
    nextTrophies: nextTrophies(after, { gm, limit: 3 }).map((view) => ({
      ...view,
      moved: view.current > (beforeAt.get(view.key) ?? 0)
    }))
  };
}
