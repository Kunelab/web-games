import { isEvilRole, type PublicInfo } from './policies.js';
import { roleDef } from '../roles.js';

/**
 * When a seat voted, not just who it voted for.
 *
 * Everything else the board reads about the square is a *closing position*:
 * `voteHistory` is one row per seat per day, written at dusk, and `buddyScore`
 * reads it for who kept ending up on the same name. That throws away the half
 * of a wagon that a person at the table actually watches. Who started it. Who
 * joined it once it was safe. Who stepped off it at the moment their vote would
 * have opened the trial.
 *
 * The record was there the whole time. `state.voteLog` has held every
 * accusation of the game in the order it was cast, withdrawals and skips
 * included, since the day it was written — and nothing in the bot model has
 * ever opened it. Which produced the one genuinely funny gap in this codebase:
 * `lateSwitch` is a personality quirk, the bots *perform* it (see
 * `SWITCH_MARGIN` in the policies), and no reader anywhere could detect it. The
 * table was doing a tell that nobody could read.
 *
 * Priced the way everything else in this model is priced: each rule fires or it
 * does not, the bench measures how often it fires on a killer against how often
 * it fires on everybody else, and the log of that ratio is the weight. See the
 * fit in `ranking.ts` and `pnpm --filter mafia-core sim --calibrate`.
 *
 * Every rule here needs the graveyard to settle it, which is the deliberate
 * limit: "you started the wagon on 7" is not evidence of anything until the
 * room knows what 7 was. So these are all *retrospective* reads, they cost
 * nothing before the first identified corpse, and they cannot be manufactured
 * by anybody's say-so — a vote is an act, timestamped by the engine, and no
 * amount of arguing changes where it landed or when.
 */
export type TempoCode =
  /** Started the wagon on a seat the graveyard then identified as a townsperson. */
  | 'led-town-wagon'
  /** Started the wagon on a seat that turned out to be a killer. */
  | 'led-killer-wagon'
  /** Stepped off a wagon that was one vote from the rope, and it held a killer. */
  | 'saved-at-the-edge';

export interface TempoRead {
  code: TempoCode;
  /** Log-odds, fitted. Positive means more likely a killer. */
  weight: number;
  day?: number;
  /** The wagon's target, for a sentence that names the day it is about. */
  at?: number;
}

/**
 * What each tell is worth, fitted on the bench rather than argued.
 *
 * Measured over 85k seat-days by emitting each candidate rule at a placeholder
 * weight and reading the log-ratios back out of `--calibrate`, which is the
 * same procedure that produced the `SAID` table in `ranking.ts`. Four rules
 * were written and two survived the measurement, which is roughly the rate that
 * exercise always returns and the reason for doing it at all.
 *
 * **Founding a wagon is the signal, and the outcome is what prices it.** A seat
 * that opened the case on somebody the graveyard then identified as a
 * townsperson fires on 6.1% of killers against 4.1% of everybody else; the same
 * rule with the verdict reversed runs 5.4% against 8.5% the other way. Both
 * directions are worth having, and they are the honest half of this file: they
 * are about *whether the case was right*, not about how anybody plays.
 *
 * **Two rules were dropped, and why is worth keeping.**
 *
 *  - `hammered-town`, the vote that actually reached the bar on a townsperson:
 *    2.8% against 3.0%, a log-ratio of -0.039, which is a rule measuring
 *    nothing at four significant figures. The reading is that the hammer is not
 *    a decision. By the time a wagon is at the bar the afternoon has already
 *    been decided by the people who built it, and whoever happens to be next is
 *    carrying nobody's intent.
 *  - `never-first`, a seat that votes every day and has never once opened a
 *    wagon: -0.302, a real regularity and the wrong kind. Evil seats in this
 *    bench run a more aggressive policy than town ones, so the rule mostly
 *    detects *which policy a bot is running*, which flatters the bench and says
 *    nothing whatever about a person. A rule has to be about the game.
 */
const FITTED: Record<TempoCode, number> = {
  'led-town-wagon': 0.383,
  'led-killer-wagon': -0.45,
  /**
   * Detected, deliberately unpriced, and the one this file was written for.
   *
   * Stepping off a wagon at the exact moment your vote would have hanged
   * somebody is the most deliberate thing a seat can do in the square, and it
   * is the classic way one killer saves another. The bench cannot price it:
   * it fires on 0.1% of killers against 0.2% of everybody else, because a bot
   * killer never boards a teammate's wagon in the first place and so is never
   * in a position to step off one. What the bench measured is townspeople
   * changing their minds, and pricing the rule off that would have bots
   * *defending* a seat for the thing this rule exists to catch.
   *
   * So it is kept at zero and reported anyway. `tempoReads` is read directly by
   * the briefing, where an unpriced observation is still worth a question, and
   * the weight is a number to fill in from a corpus of real tables rather than
   * from this one. See the same caveat at the foot of the `SAID` table.
   */
  'saved-at-the-edge': 0
};

/**
 * What one move of one ballot looked like at the second it was made.
 *
 * The log stores the move; the counts around it are what make it readable, and
 * they only exist while the log is being replayed in order. So the replay
 * produces these and everything downstream reads them instead of the raw notes.
 */
interface Moment {
  day: number;
  voterSlot: number;
  /** Where the vote landed: a house, `skip`, or nothing at all (a withdrawal). */
  to: number | 'skip' | null;
  /** Where it came from, when the seat was already voting for something. */
  from: number | 'skip' | null;
  /** Heads on the new target after the move. */
  onTo: number;
  /** Heads on the old target before the move, the seat itself included. */
  onFrom: number;
  /** What it took to open a trial that day. */
  needed: number;
}

/**
 * Heads, not weight, and the same arithmetic `voteThreshold` uses.
 *
 * The sash is worth three votes and one head, so a wagon read in weight would
 * put the bar in a different place for a Mayor's table than for anybody else's
 * and the tells would fire on the wrong moves. What a reader needs here is
 * "how close was this to a rope", which is a count of people.
 *
 * The roll is reconstructed rather than stored: every death the table was told
 * about carries the day it happened, nights included, and a night belongs to
 * the day it follows. So the seats standing when day D opened are the whole
 * table minus everybody who died before it.
 */
function aliveOnDay(day: number, info: PublicInfo): number {
  const seats = info.aliveSlots.length + info.totalDead;
  const gone = info.deaths.filter((death) => death.day < day).length;
  return Math.max(2, seats - gone);
}

const THRESHOLD = (alive: number): number => Math.floor(alive / 2) + 1;

const MOMENTS = new WeakMap<PublicInfo, Moment[]>();

/**
 * The whole game's square, replayed once per board.
 *
 * Memoised on the board object rather than on a length, because a board is
 * rebuilt whenever a vote moves and a vote moving is exactly what invalidates
 * this — the two are the same event, so the cache needs no key beyond identity.
 */
function moments(info: PublicInfo): Moment[] {
  const cached = MOMENTS.get(info);
  if (cached) return cached;

  const out: Moment[] = [];
  /** Where each seat's ballot currently sits, reset at each dawn. */
  let standing = new Map<number, number | 'skip'>();
  let onDay = -1;
  let needed = 0;

  for (const note of info.ballots ?? []) {
    if (note.day !== onDay) {
      standing = new Map();
      onDay = note.day;
      needed = THRESHOLD(aliveOnDay(note.day, info));
    }
    const from = standing.get(note.voterSlot) ?? null;
    const to: number | 'skip' | null = note.skip ? 'skip' : note.targetSlot;

    const heads = (target: number | 'skip' | null): number =>
      target === null ? 0 : [...standing.values()].filter((where) => where === target).length;

    const onFrom = heads(from);
    if (to === null) standing.delete(note.voterSlot);
    else standing.set(note.voterSlot, to);
    const onTo = heads(to);

    out.push({ day: note.day, voterSlot: note.voterSlot, to, from, onTo, onFrom, needed });
  }

  MOMENTS.set(info, out);
  return out;
}

/** A house the graveyard has settled, or null while it is still anybody's guess. */
function settled(slot: number | 'skip' | null, info: PublicInfo): 'town' | 'killer' | null {
  if (slot === null || slot === 'skip') return null;
  const role = info.deadRoles.get(slot);
  if (!role) return null;
  if (isEvilRole(role)) return 'killer';
  return roleDef(role).faction === 'town' ? 'town' : null;
}

const READS = new WeakMap<PublicInfo, Map<number, TempoRead[]>>();

/**
 * How one seat has handled its ballot, all game, as evidence.
 *
 * Each rule fires at most once. That is not a simplification, it is what the
 * weights mean: they were fitted on *whether* the rule fired over a seat's
 * whole game, so counting a seat twice for two bad wagons would be claiming
 * twice the evidence than was ever measured. The same reasoning is written out
 * at `CREDIBLE_ENOUGH` in `ranking.ts`.
 */
export function tempoReads(slot: number, info: PublicInfo): TempoRead[] {
  let perSeat = READS.get(info);
  if (!perSeat) {
    perSeat = new Map();
    READS.set(info, perSeat);
  }
  const cached = perSeat.get(slot);
  if (cached) return cached;

  const out: TempoRead[] = [];
  const seen = new Set<TempoCode>();
  const fire = (code: TempoCode, day?: number, at?: number): void => {
    if (seen.has(code)) return;
    seen.add(code);
    out.push({ code, weight: FITTED[code], ...(day === undefined ? {} : { day }), ...(at === undefined ? {} : { at }) });
  };

  for (const moment of moments(info)) {
    if (moment.voterSlot !== slot) continue;

    /**
     * First name on the wagon.
     *
     * One head on the target once this vote has landed means there was nobody
     * there before it: this seat opened the case. Skips are not wagons and a
     * withdrawal starts nothing.
     */
    if (typeof moment.to === 'number' && moment.onTo === 1) {
      const was = settled(moment.to, info);
      if (was === 'town') fire('led-town-wagon', moment.day, moment.to);
      if (was === 'killer') fire('led-killer-wagon', moment.day, moment.to);
    }

    /**
     * Off the wagon at the edge of the rope.
     *
     * The wagon had to be one short of the bar *with this seat on it*, so that
     * stepping off is the difference between a trial and no trial, and the
     * house it was pointed at has to have turned out to be a killer. Anything
     * looser than that fires on everybody who ever changed their mind.
     */
    if (
      typeof moment.from === 'number' &&
      moment.from !== moment.to &&
      moment.onFrom >= moment.needed - 1 &&
      settled(moment.from, info) === 'killer'
    ) {
      fire('saved-at-the-edge', moment.day, moment.from);
    }
  }

  perSeat.set(slot, out);
  return out;
}

/**
 * Who opened the wagon that is running right now, if anybody has.
 *
 * Not evidence and deliberately not in the table above: this is for the room's
 * own sentences. A seat that wants to ask "why are you the one who started
 * this" needs a name, and until now nothing could tell it one.
 */
export function wagonOpener(targetSlot: number, info: PublicInfo): number | null {
  for (const moment of moments(info)) {
    if (moment.day !== info.day) continue;
    if (moment.to === targetSlot && moment.onTo === 1) return moment.voterSlot;
  }
  return null;
}
