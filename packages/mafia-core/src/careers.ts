/**
 * The roguelite layer, Mafia's copy: what a nickname carries from table to table.
 *
 * Third of three, and deliberately the same shape as the other two. CoronaZ has
 * trophies over `CzCareerStats`, the quiz has badges over `PlayerCareer`, and both
 * learned the same lesson the hard way: a currency that is banked and never shown
 * is a currency nobody believes in, and a threshold nobody can see themselves
 * approaching is a surprise rather than a goal.
 *
 * Mafia had the worse version of it. Points were credited at the end of a table
 * and printed as a single running total in a footnote, and there was no ladder at
 * all — nothing to be close to, nothing to be proud of, and `unlocked` sitting in
 * the stats with nothing deriving anything from it.
 *
 * Two rules carried over from the other two:
 *
 * 1. **Badges are earned by playing and never bought.** Points buy cosmetics; they
 *    buy no badge and no advantage. Nothing here touches the balance the simulator
 *    tuned, because nothing here reaches the game at all.
 * 2. **`earned` is the authority and `progress` is what gets drawn**, declared side
 *    by side and never derived from each other, with a test holding them to the
 *    same story. A boolean cannot be drawn, and a bar that fills against a badge
 *    that never dropped is worse than no bar.
 */

/** Lifetime tallies for one nickname, the substrate every badge reads. */
export interface MafiaCareerStats {
  /** Spendable balance, and the only number the shop touches. */
  points: number;
  games: number;
  wins: number;
  /** Wins taken alone: the Jester hanged, the last blade, the Survivor. */
  soloWins: number;
  kills: number;
  /** Tables walked away from alive, won or lost. */
  survived: number;
  /** Cosmetic unlock ids, spent from `points`. */
  unlocked: string[];
}

export function emptyMafiaStats(): MafiaCareerStats {
  return { points: 0, games: 0, wins: 0, soloWins: 0, kills: 0, survived: 0, unlocked: [] };
}

export interface MafiaBadgeDef {
  key: string;
  earned: (stats: MafiaCareerStats) => boolean;
  /**
   * How close this career is, as a count against a target.
   *
   * A count and never a percentage: "17 of 25" is an argument for another table in
   * a way "68%" is not. The unit is a catalogue key rather than a word, because the
   * server owns the number and the client owns the noun.
   */
  progress: (stats: MafiaCareerStats) => { current: number; target: number; unit: string };
}

/** The common shape: a tally that climbs to a threshold. */
function count(
  of: (stats: MafiaCareerStats) => number,
  target: number,
  unit: string
): Pick<MafiaBadgeDef, 'earned' | 'progress'> {
  return {
    earned: (stats) => of(stats) >= target,
    progress: (stats) => ({ current: Math.min(of(stats), target), target, unit })
  };
}

/**
 * The ladder, declared least-prestigious first so the title is simply the last
 * badge earned. Same convention as the quiz, and it is load-bearing: `mafiaTitleFor`
 * reads the end of this list and nothing else decides what a nickname wears.
 *
 * The spread is deliberate. Two fall on a first evening, so there is something to
 * show for turning up; two want a season, so there is something left after ten.
 * `lone-wolf` sits in the middle on purpose — winning alone is rarer than winning,
 * and it is the one badge that rewards playing a role most tables dread drawing.
 */
export const MAFIA_BADGES: readonly MafiaBadgeDef[] = [
  { key: 'first-table', ...count((s) => s.games, 1, 'mafia.unit.tables') },
  { key: 'first-blood', ...count((s) => s.wins, 1, 'mafia.unit.wins') },
  { key: 'regular', ...count((s) => s.games, 10, 'mafia.unit.tables') },
  { key: 'survivor', ...count((s) => s.survived, 10, 'mafia.unit.survived') },
  { key: 'lone-wolf', ...count((s) => s.soloWins, 1, 'mafia.unit.soloWins') },
  { key: 'blooded', ...count((s) => s.kills, 10, 'mafia.unit.kills') },
  { key: 'veteran', ...count((s) => s.games, 50, 'mafia.unit.tables') },
  { key: 'executioner', ...count((s) => s.kills, 25, 'mafia.unit.kills') },
  { key: 'kingmaker', ...count((s) => s.wins, 25, 'mafia.unit.wins') },
  { key: 'legend', ...count((s) => s.wins, 50, 'mafia.unit.wins') }
];

/** Every badge this career holds, in ladder order. */
export function mafiaBadgesFor(stats: MafiaCareerStats): string[] {
  return MAFIA_BADGES.filter((badge) => badge.earned(stats)).map((badge) => badge.key);
}

/** The title worn next to the name: the most prestigious badge held, or none. */
export function mafiaTitleFor(stats: MafiaCareerStats): string | null {
  return mafiaBadgesFor(stats).at(-1) ?? null;
}

/** How close a career is to one badge it has not earned. */
export interface MafiaBadgeProgress {
  key: string;
  current: number;
  target: number;
  /** Catalogue key for the noun, e.g. `mafia.unit.kills`. */
  unit: string;
  /** This table moved the count, so the bar can say so. */
  moved: boolean;
}

/**
 * The nearest unearned badges, closest first.
 *
 * Ranked by how far along they are rather than by prestige, because a bar at 17 of
 * 25 is a better thing to put in front of a table that has just finished than an
 * easier badge nobody has touched. Ties break towards the earlier declaration,
 * which is the cheaper badge, since the list is in prestige order.
 */
export function nextMafiaBadges(stats: MafiaCareerStats, limit = 3): MafiaBadgeProgress[] {
  return MAFIA_BADGES.filter((badge) => !badge.earned(stats))
    .map((badge, index) => {
      const { current, target, unit } = badge.progress(stats);
      const ratio = target > 0 ? Math.max(0, Math.min(1, current / target)) : 0;
      return { key: badge.key, current, target, unit, moved: false, ratio, index };
    })
    .sort((a, b) => b.ratio - a.ratio || a.index - b.index)
    .slice(0, limit)
    .map(({ ratio: _ratio, index: _index, ...view }) => view);
}

/**
 * The difference one table made to one career.
 *
 * Takes both snapshots rather than recomputing from the game, because "what is
 * new" is exactly a comparison and nothing else can answer it: a badge already
 * held must not be announced a second time, and a title that has not changed is
 * not news.
 *
 * A bot passes the same `before` and `after` and gets an empty payload, which is
 * the correct answer rather than a special case: nothing was banked, so nothing
 * changed, so there is nothing to announce. Its row still carries what it scored,
 * because comparing yourself to the machine is half of why the table looks.
 */
export function mafiaReward(input: {
  playerId: string;
  name: string;
  before: MafiaCareerStats;
  after: MafiaCareerStats;
  gained: number;
  /** The lifetime balance afterwards, or null for a seat with no ledger. */
  total: number | null;
}): {
  playerId: string;
  name: string;
  gained: number;
  total: number | null;
  newBadges: string[];
  newTitle: string | null;
  nextBadges: MafiaBadgeProgress[];
} {
  const { before, after } = input;
  const heldBefore = new Set(mafiaBadgesFor(before));
  const titleBefore = mafiaTitleFor(before);
  const titleAfter = mafiaTitleFor(after);

  return {
    playerId: input.playerId,
    name: input.name,
    gained: input.gained,
    total: input.total,
    newBadges: mafiaBadgesFor(after).filter((key) => !heldBefore.has(key)),
    newTitle: titleAfter !== titleBefore ? titleAfter : null,
    nextBadges: nextMafiaBadges(after).map((view) => {
      const was = MAFIA_BADGES.find((badge) => badge.key === view.key)?.progress(before).current ?? 0;
      return { ...view, moved: view.current > was };
    })
  };
}
