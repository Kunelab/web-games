import { roleDef } from '../roles.js';
import { isEvilRole, type PublicInfo } from './policies.js';
import { bladesDealt, campOf, type Camp } from './slots.js';

/**
 * How much time the town has left, counted rather than felt.
 *
 * `parityPressure` has always been the town's sense of the clock and it was a
 * mood: four rungs, 1 / 0.6 / 0.3 / 0, read off one pooled count of killers.
 * That is enough to make a seat play faster and not enough to make it play
 * *correctly*, because the three things a person at a real table says out loud
 * on the last afternoons are all quantities and none of them were computed:
 *
 *  - **"We have one mislynch left."** A wrong rope costs two heads, this seat
 *    and tonight's, and the margin falls by two. A correct rope costs two heads
 *    and takes a killer with it, so the margin does not move at all. Which
 *    makes the margin a *budget*, and the number of wrong ropes it will still
 *    pay for is the single most useful number on the board.
 *  - **"Skipping is cheaper than hanging the wrong man."** Nobody in this
 *    codebase knew that, and the old clock said the opposite. A thrown-away
 *    afternoon costs one head, not two: the night still comes, but nobody
 *    hanged a townsperson to reach it. At a margin of two, hanging wrong loses
 *    the game today and skipping leaves a game to play tomorrow with a day more
 *    evidence. The bots were told a wasted day was the disaster.
 *  - **"They are not one side."** Parity is a *family's* win condition. Three
 *    mafiosi at seven alive is a rope away from over; three unrelated solo
 *    killers at seven alive is a different problem, because none of them wins
 *    by standing level with the town. The old count added all of them together
 *    and panicked at the sum.
 *
 *    The bench had something to say about that, and it is the reason `nightly`
 *    exists. Splitting the clock by faction and stopping there made the town
 *    *relaxed* about lone killers, who reach no parity, and solo wins went up
 *    five points in a single run. A camp that cannot win by arithmetic still
 *    swings a knife every night, so the cost of a wasted afternoon is counted
 *    in knives and the wall at two seats is counted as an ending like any
 *    other. Being right about the win condition and wrong about the clock is
 *    still wrong.
 *
 * Everything here is arithmetic over the published roster and the identified
 * graveyard, both of which are printed on a screen every player is looking at.
 * That is what makes it endgame reasoning available from day two rather than
 * from six seats left: a person reads the list on the first morning, and so
 * does this.
 */
export interface TownClock {
  /** Seats standing. */
  alive: number;
  /** Killers the room should still expect to be alive, in total. */
  blades: number;
  /**
   * The largest bloc that would win by reaching parity, and which one it is.
   *
   * `null` when the only killers left are solos, which is the case the pooled
   * count got most wrong: nobody wins by standing next to the last townsperson.
   */
  bloc: { camp: Camp; size: number } | null;
  /** Heads between the town and the end, whichever end comes first. */
  margin: number;
  /**
   * Heads the town loses for every afternoon it wastes: the rope plus the night.
   *
   * Not always two. Every camp still standing swings its own knife after dark,
   * so a table holding a family and two lone killers loses four heads to a
   * wasted day and the town has a quarter of the time it thinks it has. This is
   * the number that was missing when the parity clock was split by faction: a
   * solo killer reaches no parity and was therefore read as no hurry at all,
   * and the bench answered immediately, with solo wins up five points.
   */
  nightly: number;
  /**
   * Wrong ropes the town can still afford, the answer to "how many mistakes".
   *
   * Zero means today's rope decides the game, which is what LyLo has always
   * meant and what the room should be told in those words.
   */
  mislynches: number;
  /** Thrown-away afternoons it can still afford, which is always the larger number. */
  skips: number;
  /**
   * The same thing as the old four-rung ladder, 0 comfortable to 1 at the bell.
   *
   * Kept because fifteen call sites are tuned against it and their thresholds
   * mean something. What changed underneath is that the rungs are now read off
   * the mislynch budget instead of off a raw head count, so 0.6 means "one
   * mistake left" at every table size rather than "margin of three".
   */
  pressure: number;
}

/**
 * Camps the night itself has proved are still standing.
 *
 * The roster arithmetic is an expectation and the dawn report is a fact: a
 * corpse the town was told died to the Triad means a Triad is alive to have
 * killed it, whatever the graveyard has or has not identified. Cheap, public,
 * and it stops the estimate drifting below what the table can plainly see.
 *
 * Only the last two nights, because the whole point is that it is evidence
 * about *now*. A family that killed on night one and has been dead since night
 * two is not standing.
 */
function campsStillKilling(info: PublicInfo): Set<Camp> {
  const seen = new Set<Camp>();
  for (const death of info.deaths) {
    if (death.phase !== 'night' || death.source === null) continue;
    if (death.day < info.day - 2) continue;
    if (death.source === 'mafia') seen.add('mafia');
    else if (death.source === 'triad') seen.add('triad');
    else if (death.source === 'cult') seen.add('cult');
    else if (death.source !== 'vigilante' && death.source !== 'veteran' && death.source !== 'jailor') seen.add('solo');
  }
  return seen;
}

const CLOCKS = new WeakMap<PublicInfo, TownClock>();

/**
 * The clock, read once per board.
 *
 * Deliberately generous about what it does not know. An unknown roster falls
 * back to the old thirty-per-cent guess, an unidentified corpse subtracts
 * nothing, and a camp the dawn report has heard from is never counted out. The
 * cost of being wrong in the other direction is a town that believes it has
 * spare days and plays the whole midgame at the wrong speed, which is the
 * failure this replaces.
 */
export function townClock(info: PublicInfo): TownClock {
  const cached = CLOCKS.get(info);
  if (cached) return cached;

  const alive = info.aliveSlots.length;
  const dealt = info.roleSlots ? bladesDealt(info.roleSlots) : null;

  /** What the graveyard has taken off each camp, counted only where it named the corpse. */
  const buried: Record<Camp, number> = { mafia: 0, triad: 0, cult: 0, solo: 0 };
  let buriedTotal = 0;
  for (const role of info.deadRoles.values()) {
    if (!isEvilRole(role) && roleDef(role).faction !== 'cult') continue;
    buried[campOf(role)]++;
    buriedTotal++;
  }

  const killing = campsStillKilling(info);
  const left = (camp: Camp, dealtCount: number): number => {
    const remaining = dealtCount - buried[camp];
    // The dawn report outranks the arithmetic: somebody made last night's corpse.
    return Math.max(killing.has(camp) ? 1 : 0, remaining);
  };

  let blades: number;
  let bloc: TownClock['bloc'];

  if (dealt) {
    const camps: Camp[] = ['mafia', 'triad', 'cult', 'solo'];
    const standing = camps.map((camp) => ({ camp, size: left(camp, dealt.byCamp[camp]) }));
    blades = standing.reduce((sum, entry) => sum + entry.size, 0);
    /**
     * The bloc that decides the parity clock: the biggest family, and never the
     * solos, who win nothing by being half the room.
     */
    const families = standing.filter((entry) => entry.camp !== 'solo' && entry.size >= 1);
    bloc = families.sort((left, right) => right.size - left.size)[0] ?? null;
  } else {
    /** No roster on the wall, which is every board a test builds by hand. */
    const expected = Math.max(1, Math.round((alive + info.totalDead) * 0.3));
    blades = Math.max(info.lastNightDeathSlots.size > 0 ? 1 : 0, expected - buriedTotal);
    bloc = blades >= 1 ? { camp: 'mafia', size: blades } : null;
  }

  blades = Math.max(info.lastNightDeathSlots.size > 0 ? 1 : 0, blades);

  /**
   * The roster and the graveyard agree that every knife is accounted for.
   *
   * Then there is no clock, and saying there is one is worse than saying
   * nothing: a town with nothing left to fear that still believes it is two
   * ropes from parity will hang somebody to be safe. The dawn report overrules
   * this the moment anybody dies in the dark, which is the check above.
   */
  if (blades <= 0) {
    const stopped: TownClock = {
      alive,
      blades: 0,
      bloc: null,
      margin: alive,
      nightly: 1,
      mislynches: alive,
      skips: alive,
      pressure: 0
    };
    CLOCKS.set(info, stopped);
    return stopped;
  }

  /**
   * The two ways the town runs out, and it only gets to survive both.
   *
   *  - **Parity.** A family standing level with everybody else converts it into
   *    a rope and the game is theirs, so the room needs `alive` to stay above
   *    twice the biggest bloc.
   *  - **The room itself.** At two seats the day cannot hang anybody: the bar is
   *    two votes and nobody may vote for themselves, so whoever holds the knife
   *    takes the last seat after dark. That is the wall a lone killer wins
   *    against, and it is why a Serial Killer at four alive is every bit as
   *    urgent as a family at parity even though he reaches no parity at all.
   *
   * Whichever is nearer is the clock.
   */
  const toParity = bloc ? alive - 2 * Math.ceil(bloc.size) : Number.POSITIVE_INFINITY;
  const toTheWall = alive - 2;
  const margin = Math.min(toParity, toTheWall);

  /**
   * What a wasted afternoon costs, in heads: the rope, plus what the dark takes.
   *
   * The roster can only ever say how many knives were *dealt*, and a count of
   * knives is a bad estimate of a body count. Doctors stop some, jailors hold
   * some, killers walk into each other and into a Veteran's porch, and a family
   * that spends its night blackmailing somebody kills nobody at all. Reasoning
   * from the deal alone had the clock reading four heads a night on a board
   * that was quietly losing one.
   *
   * So the roster is only the prior, and the town's own eyes overrule it. Every
   * player has watched the same dawns and counted the same bodies, and by the
   * second one "we are losing two a night" is a measurement rather than a
   * guess. Which is how a person does this, out loud, at a real table.
   */
  const nights = Math.max(0, info.day - 1);
  const camps = (bloc ? 1 : 0) + (dealt ? Math.round(left('solo', dealt.byCamp.solo)) : 0);
  const watched = nights >= 2 ? info.nightDeathsTotal / nights : Math.max(1, camps);
  const nightly = 1 + Math.min(3, Math.max(1, watched));

  /**
   * How many wrong ropes fit inside the margin.
   *
   * A mislynch costs the rope and the night and leaves the killers untouched,
   * so each one takes `nightly` off the margin; the town is dead when the
   * margin reaches zero. A correct rope costs the same heads and takes a killer
   * with it, so it does not move the margin at all, which is the whole reason
   * this is a budget rather than a countdown.
   *
   * A skip costs one head fewer, because nobody hanged a townsperson to reach
   * the night, and the room deserves to be told that separately: at a margin of
   * two, hanging the wrong man loses the game this evening and skipping leaves
   * a game to play tomorrow with a day more evidence. Nothing in this codebase
   * knew that, and the old clock said the opposite.
   */
  const mislynches = margin <= 0 ? 0 : Math.max(0, Math.ceil(margin / nightly) - 1);
  const skips = margin <= 0 ? 0 : Math.max(0, Math.ceil(margin / (nightly - 1)) - 1);

  /**
   * And the old ladder, rebuilt on the budget.
   *
   * The rungs are where they always were, and the reading underneath them is
   * the corrected one: a table with no mistakes left is at the bell whether
   * that is six seats or sixteen. The old version put the bell at a margin of
   * one, which was off by a rope — at a margin of two a wrong hanging loses
   * the game that same night, and the bots were being told to relax.
   */
  const pressure = mislynches === 0 ? 1 : mislynches === 1 ? 0.6 : mislynches === 2 ? 0.3 : 0;

  const clock: TownClock = { alive, blades, bloc, margin, nightly, mislynches, skips, pressure };
  CLOCKS.set(info, clock);
  return clock;
}

/**
 * Whether the only thing left to beat is a lone knife.
 *
 * Changes what a town should do more than anything else the clock reports: a
 * family has to be out-voted and a solo killer has to be *found*, and a town
 * that keeps no-lynching against a Serial Killer is simply feeding him. Read by
 * the day policy and said out loud in the briefing.
 */
export function soloEndgame(info: PublicInfo): boolean {
  const clock = townClock(info);
  if (clock.bloc !== null) return false;
  return clock.blades >= 1 && info.aliveSlots.length <= 6;
}

