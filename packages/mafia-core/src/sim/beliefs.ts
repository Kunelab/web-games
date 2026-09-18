/**
 * What one seat believes about everybody else, as a number.
 *
 * `rank` reads the board the way the whole table reads it: what was said, who
 * was seen, what the graveyard settled. It is public, it is calibrated, and it
 * is the same for everybody. This is the other half — the same board *from one
 * chair*, with the two things that chair knows and nobody else does:
 *
 *  - **its own eyes.** A Sheriff's check, an Investigator's trade, a Consigliere
 *    naming a role outright. The board cannot hold these without leaking them,
 *    so every seat has always had to reason about its own findings separately,
 *    and every decision did it slightly differently.
 *  - **last night's arithmetic.** Somebody was attacked: a doctor knows because
 *    it stopped the knife, a survivor knows because it woke up, and everybody
 *    knows when there is a body. So somebody still alive did it, and the seats
 *    that could not have are crossed off. At fifteen alive that narrows nothing.
 *    At three it is the whole game, and it is the deduction a person makes
 *    instantly and this table could not make at all: reported from a real
 *    endgame where the Doctor healed the Serial Killer two nights running while
 *    the Vigilante sat on a bullet, because the only number either of them read
 *    said the killer was the most trustworthy seat at the table.
 *
 * Deliberately deterministic: no rng anywhere in here. A belief is a reading of
 * a board, and two seats reading the same board with the same knowledge must
 * reach the same number — it is the decisions on top that are allowed to be
 * temperamental. That is also what makes it testable, and what lets the bench
 * ask whether a 0.9 really is nine times in ten.
 *
 * Costs one `rank` per board and one pass per seat, both memoised against the
 * board object, which is rebuilt whenever anything it reads changes.
 */
import type { DeathSource } from '../messages.js';
import { roleDef, type RoleId } from '../roles.js';
import type { MafiaPlayer } from '../state.js';
import { isEvilRole, sheriffSuspects, type PublicInfo } from './policies.js';
import { rank } from './ranking.js';

/** Why a seat is where it is, strongest first. Rendered by the phrasebook. */
export type BeliefWhy =
  /** Nobody else alive could have made last night's attack. */
  | { code: 'only-one-left'; night: number }
  /** Two seats left who could have, and no way yet to tell which. */
  | { code: 'one-of-two'; night: number; other: number }
  /** This seat's own investigation. */
  | { code: 'my-check'; evil: boolean }
  /** Somebody tried to kill this seat last night. */
  | { code: 'attacked'; night: number }
  /** The board, as everybody reads it. */
  | { code: 'record' };

export interface Belief {
  slot: number;
  /** How likely this seat is on a killing side, 0..1, from this reader's chair. */
  odds: number;
  because: BeliefWhy[];
}

/**
 * Nothing is ever certain at this table.
 *
 * A Godfather reads innocent to a Sheriff, a framed townie reads guilty, and a
 * seat that looks like the only possible killer may be the second victim of a
 * night nobody has explained yet. Every reading is clamped away from 0 and 1 so
 * that no amount of confidence turns into arithmetic that cannot be argued with.
 */
const FLOOR = 0.02;
const CEILING = 0.98;

const clamp = (odds: number): number => Math.min(CEILING, Math.max(FLOOR, odds));

/** The public reading, kept per board rather than recomputed per seat. */
const PUBLIC = new WeakMap<PublicInfo, Map<number, number>>();

function publicOdds(info: PublicInfo): Map<number, number> {
  const cached = PUBLIC.get(info);
  if (cached) return cached;
  const built = new Map(rank(info).map((suspect) => [suspect.slot, suspect.p]));
  PUBLIC.set(info, built);
  return built;
}

/** And the private reading, per board and per chair. */
const PRIVATE = new WeakMap<PublicInfo, Map<number, Map<number, Belief>>>();

/**
 * The ways a seat dies at night that mean somebody was out killing.
 *
 * `lastNightDeathSlots` holds every corpse with a night on it, and not all of
 * them were attacked: a Lover dies of grief when their partner does, a hand that
 * pulled the Jester's rope dies of remorse, and a seat that leaves the table is
 * recorded the same way. Reading any of those as an attack is how a town with
 * three seats left convinces itself, at 0.93, that the wrong one is a killer —
 * and every decision downstream reads that number.
 *
 * Only the killing sides count. A Vigilante's bullet and a Jailor's execution
 * are attacks too, but they say a *town* seat was out, which is not evidence
 * about anybody's allegiance and must not narrow anything.
 */
const EVIL_HANDS: ReadonlySet<DeathSource> = new Set<DeathSource>([
  'mafia',
  'triad',
  'cult',
  'serialKiller',
  'massMurderer',
  'arsonist',
  'electromaniac',
  'poison'
]);

/**
 * Last night, and who is left who could have done it.
 *
 * The victims are what this seat knows was attacked: the bodies everybody saw,
 * anybody it healed off a knife, and itself if it woke up having been saved.
 * The candidates are everybody still alive who is not the victim, not this seat,
 * not cleared by its own eyes, not proven town by the record, and not somewhere
 * this seat personally knows they could not kill from — a cell it holds the key
 * to, or an evening it spent keeping them busy.
 *
 * Note what is *not* a reason to be crossed off: being liked, being quiet, or
 * having voted well. Those are opinions, and an elimination built on opinions
 * is how a town convinces itself of something false with great confidence.
 */
function narrowing(
  self: MafiaPlayer,
  info: PublicInfo
): { night: number; victims: Set<number>; candidates: Set<number> } {
  // During day D, last night was night D-1: `resolveNight` stamps its intel
  // before `beginDay` moves the counter.
  const night = info.day - 1;
  const victims = new Set<number>(
    info.deaths
      .filter((death) => death.phase === 'night' && death.day === night && death.source !== null)
      .filter((death) => EVIL_HANDS.has(death.source!))
      .map((death) => death.slot)
  );
  /**
   * And what this seat knows that the square does not.
   *
   * A Doctor that stopped a knife and a seat that woke up having been stopped
   * for both know an attack happened, and neither knows whose hand it was: a
   * Vigilante having a bad night looks exactly like a family having a good one.
   * Kept anyway, because it is the same thing a person in that chair concludes,
   * and because the reading below never rests on it alone — it is the *other*
   * seats being crossed off that makes it worth anything.
   */
  for (const entry of self.intel) {
    if (entry.night === night && entry.kind === 'saved') victims.add(entry.targetSlot);
  }
  if (self.rescuedNight === night) victims.add(self.slot);

  const candidates = new Set<number>();
  if (victims.size === 0) return { night, victims, candidates };

  for (const slot of info.aliveSlots) {
    if (slot === self.slot || victims.has(slot)) continue;

    const mine = self.intel.filter((entry) => entry.targetSlot === slot);
    // My own check said town, so my own elimination believes it.
    if (mine.some((entry) => entry.kind === 'sheriff' && !sheriffSuspects(entry.value))) continue;
    if (mine.some((entry) => entry.kind === 'role' && !isEvilRole(entry.value as RoleId))) continue;
    // Somebody I held or kept busy that night was not out killing.
    if (mine.some((entry) => entry.night === night && (entry.kind === 'blocked' || entry.kind === 'jailed'))) continue;

    const proven = info.provenRoles.get(slot);
    if (proven && roleDef(proven).faction === 'town') continue;

    candidates.add(slot);
  }
  return { night, victims, candidates };
}

/**
 * Everything this seat believes about everybody still standing.
 *
 * Read in this order, strongest last, because each one is allowed to overrule
 * what came before it: the room's opinion, then this seat's own findings, then
 * the arithmetic of the night — which is last because it is the only one of the
 * three that cannot be lied to. Nothing here decides anything; `decideBallot`,
 * `pickVote` and the night powers all read it and make their own choices, which
 * is what stops one seat having two opinions at once.
 */
export function beliefs(self: MafiaPlayer, info: PublicInfo): Map<number, Belief> {
  let perSeat = PRIVATE.get(info);
  if (!perSeat) {
    perSeat = new Map();
    PRIVATE.set(info, perSeat);
  }
  const cached = perSeat.get(self.slot);
  if (cached) return cached;

  const room = publicOdds(info);
  const narrowed = narrowing(self, info);
  const shortlist = [...narrowed.candidates];
  const out = new Map<number, Belief>();

  for (const slot of info.aliveSlots) {
    if (slot === self.slot) continue;
    const because: BeliefWhy[] = [{ code: 'record' }];
    let odds = room.get(slot) ?? 0.3;

    /**
     * What this seat saw for itself.
     *
     * An exact role outranks a suspicion: an Investigator's trade line and a
     * Consigliere's report name the badge, where a Sheriff's needle only says
     * which way it swung, and a Godfather swings it the wrong way on purpose.
     */
    const mine = self.intel.filter((entry) => entry.targetSlot === slot);
    const named = mine.find((entry) => entry.kind === 'role');
    const checked = mine.find((entry) => entry.kind === 'sheriff');
    if (named) {
      const evil = isEvilRole(named.value as RoleId);
      odds = evil ? 0.97 : 0.03;
      because.unshift({ code: 'my-check', evil });
    } else if (checked) {
      const evil = sheriffSuspects(checked.value);
      odds = evil ? 0.85 : 0.06;
      because.unshift({ code: 'my-check', evil });
    }

    /**
     * And the night, which answers a question nobody can talk their way out of.
     *
     * One name left is as close to proof as this game offers a seat that holds
     * no badge: somebody killed last night, and everybody else has been crossed
     * off for a reason that is not an opinion. Two names left is not proof and
     * is not treated as any — it is a coin, said out loud, which is worth
     * saying because a town that knows it is down to two people stops spending
     * its afternoons on the other twelve.
     */
    /**
     * Somebody tried to kill them last night.
     *
     * Weak evidence and real evidence: killers are attacked too, by each other
     * and by a Vigilante having a good night, so this halves the reading rather
     * than clearing anybody. It matters most where it is cheapest to get wrong
     * — a Doctor deciding where to stand tonight, which is a decision between
     * the living rather than a verdict about them.
     */
    if (narrowed.victims.has(slot)) {
      odds = odds * 0.5;
      because.unshift({ code: 'attacked', night: narrowed.night });
    }

    if (shortlist.length === 1 && shortlist[0] === slot) {
      odds = Math.max(odds, 0.93);
      because.unshift({ code: 'only-one-left', night: narrowed.night });
    } else if (shortlist.length === 2 && narrowed.candidates.has(slot)) {
      odds = Math.max(odds, 0.5);
      because.unshift({
        code: 'one-of-two',
        night: narrowed.night,
        other: shortlist[0] === slot ? shortlist[1] : shortlist[0]
      });
    }

    out.set(slot, { slot, odds: clamp(odds), because });
  }

  perSeat.set(self.slot, out);
  return out;
}

/** How likely one seat is a killer, from this chair. Convenience over `beliefs`. */
export function evilOdds(self: MafiaPlayer, info: PublicInfo, slot: number): number {
  return beliefs(self, info).get(slot)?.odds ?? 0;
}

/**
 * The seat this reader is surest about, when it is sure enough to act.
 *
 * `excluding` is how a family seat keeps its own brothers off its own list: the
 * arithmetic here does not know who anybody's friends are, and a mafioso that
 * deduced its way to its own Godfather would hand the game over on the strength
 * of being good at sums.
 */
export function surestSuspect(
  self: MafiaPlayer,
  info: PublicInfo,
  bar: number,
  excluding: ReadonlySet<number> = new Set()
): { slot: number; odds: number; because: BeliefWhy[] } | null {
  const best = [...beliefs(self, info).values()]
    .filter((belief) => !excluding.has(belief.slot) && belief.odds >= bar)
    .sort((left, right) => right.odds - left.odds)[0];
  return best ? { slot: best.slot, odds: best.odds, because: best.because } : null;
}
