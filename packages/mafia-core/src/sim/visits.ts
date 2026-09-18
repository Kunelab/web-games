import { roleDef, ROLES, type RoleId } from '../roles.js';
import { deductions, deductionWeight } from './deduce.js';
import { isEvilRole } from './policies.js';
import type { Claim, PublicInfo } from './policies.js';

/**
 * Who was out, where they went, and what that is worth as evidence.
 *
 * The rest of the model weighs *assertions*: somebody says a thing, and the
 * board prices the thing by who said it. This weighs *movement*, which is the
 * one kind of evidence in Mafia that nobody chooses to produce. A killer has to
 * go to the house it kills, every night it kills, and that is a fact about the
 * rules rather than about anybody's honesty.
 *
 * It is Bayesian, and deliberately the plainest kind: a prior taken from the
 * roster, and one likelihood ratio per observation, added up in log space. Each
 * ratio answers one question — how much likelier is this observation if that
 * seat is a killer than if it is not — and that is a number a person can argue
 * with. A full posterior over role assignments would be stronger and would cost
 * the thing this whole codebase is built around: every finding here has to come
 * back out as a sentence a bot can say and a player can contradict. "You were
 * on the doorstep of the house that died, and you were the only one" is such a
 * sentence. "The posterior is 0.68" is not.
 *
 * Naive, in the technical sense: the observations are treated as independent
 * when they plainly are not, since a Lookout that reports a visitor often
 * reports several. That overstates confidence when a single watcher produces
 * the whole case, so the evidence from any one night is capped, which is the
 * cheap correction for exactly that correlation.
 */
export interface VisitReason {
  /** Which rule fired. Rendered into a sentence by the caller. */
  code: 'doorstep' | 'out-that-night' | 'admitted-doorstep' | 'caught-lying' | 'record-broken' | 'never-out';
  /** Its weight in log-odds. Positive means more likely a killer. */
  weight: number;
  night?: number;
  /** The house, when the rule is about one. */
  at?: number;
}

export interface VisitOdds {
  /** Log-odds that this seat is a killer, prior included. */
  logOdds: number;
  /** The same as a probability, for ranking and for calibration. */
  p: number;
  /** Every rule that fired, heaviest first, so the number can be read back. */
  reasons: VisitReason[];
}

/**
 * The likelihood ratios, in log space, and where each number comes from.
 *
 * These are priced by argument rather than fitted, because a fitted number on a
 * bench of bots would be fitting to the bots. What each one has to survive is
 * being stated out loud:
 *
 *  - **doorstep**: seen on the step of the house that died that night. A killer
 *    is there with near certainty on a night it kills; a Doctor, Lookout or
 *    Bodyguard is there only if it guessed that house out of everybody. About
 *    five to one, and it is the strongest thing in the model that is not a
 *    confession.
 *  - **out-that-night**: seen out, house unknown or not the victim's. Killers
 *    move every night and so do half the town, so this is barely evidence: it
 *    is here because *nothing* is also evidence, and the pair has to be priced
 *    together or the absence means nothing either.
 *  - **admitted-doorstep**: said themselves they went to the house that died.
 *    Weaker than being caught there, and it has to be: the seats that volunteer
 *    this are overwhelmingly the honest visiting roles explaining their night.
 *    Barely above even, and it is *still* worth having, because a liar who has
 *    to account for a sighting reaches for it.
 *  - **caught-lying**: said home, and a credible voice put them outside. Not a
 *    visit fact but a fact about visits, and the one the whole day phase is
 *    built to produce.
 *  - **record-broken**: the graveyard has contradicted something they said. See
 *    `deduce.ts`; folded in here so the ranking has one number in it.
 *  - **never-out**: not once reported outside across nights when people were
 *    watching. Weak and negative, and it only counts when there was somebody to
 *    do the watching, or it would convict the whole table of being invisible.
 *
 * The numbers themselves are **fitted, not argued**. Each is the log of how
 * often the rule fires on a killer against how often it fires on anybody else,
 * measured over sixty thousand seat-days on the bench, which is the definition
 * of a likelihood ratio rather than an approximation of one. The reasoning
 * above says what each rule is *for*; the measurement says what it is *worth*,
 * and where the two disagreed the measurement won. `caught-lying` was priced
 * at 1.3 and is really 3.2; `out-that-night` was priced at 0.18 and is really
 * 0.04, which is to say it is noise and now weighs like noise.
 *
 * They are fitted against bots, and that matters differently per rule. A killer
 * visiting the house it kills is the engine's rule, so `doorstep` transfers to
 * a table of people unchanged. `admitted-doorstep` depends on how readily the
 * honest visiting roles volunteer their night, which is a habit of the policy,
 * and should be refitted when there are real tables to fit against.
 */
const LR = {
  doorstep: 1.82,
  outThatNight: 0.04,
  admittedDoorstep: 0.8,
  caughtLying: 3.18,
  neverOut: -0.27
} as const;

/**
 * The most any single night may contribute, either way.
 *
 * The naive assumption is that observations are independent, and they are not:
 * one Lookout reporting four visitors is one witness, not four, and one seat
 * reported by three different watchers on the same night is one fact said three
 * times. Capping per night is the cheap correction, and it is the difference
 * between a model that finds killers and a model that believes whoever spoke
 * first, loudest and most often.
 */
const NIGHT_CAP = 2.2;

/** And the most the whole thing may say, so it never outranks a confession. */
const TOTAL_CAP = 3.5;

function nightOf(claim: Claim): number {
  return claim.night ?? Math.max(1, claim.day - 1);
}

/**
 * The prior: how much of this table is still killing, before anybody moves.
 *
 * Read off the roster and the graveyard rather than assumed, because the answer
 * is genuinely different at twelve seats and at twenty-four, and different
 * again once three of the killers are buried. A seat picked at random from a
 * board with two killers left among nine is a killer two times in nine, and
 * that is where every seat starts before a single observation is weighed.
 */
function priorLogOdds(info: PublicInfo): number {
  /**
   * How much of the table was killing when it sat down.
   *
   * The first version read this off `rolesInPlay`, which is wrong in a way
   * worth writing down: that set is every role the roster *could* produce, with
   * each category expanded to its whole pool, so a single "random town" slot
   * contributes a dozen entries. Taking the evil fraction of that set answers
   * "what share of the roles in this game's dictionary are evil", which is not
   * a question anybody asked. The bench showed it plainly — the model parked
   * two thirds of the table between 0.5 and 0.7 on a board whose real rate was
   * 0.38, and every band in the middle read twenty points hot.
   *
   * A constant is the honest replacement. This game deals roughly three in ten
   * against the town across its setups, that number is on every player's screen
   * as the roster, and a prior is allowed to be a known fact about the game.
   */
  const AT_THE_START = 0.35;

  const alive = Math.max(1, info.aliveSlots.length);
  const started = alive + info.totalDead;
  const buriedEvil = [...info.deadRoles.values()].filter((role) => isEvilRole(role)).length;

  /**
   * And how much of it still is, which rises as the game goes on whether
   * anybody notices or not: the town dies faster than the people killing it, so
   * a seat picked at random on day eight is far likelier to be a killer than
   * one picked on day two. Subtracting the graveyard's confirmed killers is
   * what makes that happen by arithmetic rather than by assumption.
   */
  const expected = Math.max(0.5, AT_THE_START * started - buriedEvil);
  const share = Math.max(0.03, Math.min(0.7, expected / alive));
  return Math.log(share / (1 - share));
}

/** Everyone who died on that night, as the morning report told it. */
function diedOn(night: number, info: PublicInfo): Set<number> {
  const slots = new Set<number>();
  for (const death of info.deaths) {
    if (death.phase === 'night' && death.day === night) slots.add(death.slot);
  }
  return slots;
}

/**
 * How much a witness's word is worth here, without asking `claimerWeight`.
 *
 * Deliberately not the full credibility machinery: that reads `trustOf`, which
 * reads the trial record, which this then feeds back into through the ranking —
 * and a number that is partly made of itself is not a number. What matters for
 * a movement report is narrower anyway: a corpse the graveyard vouched for is
 * worth more than a stranger, and a revealed killer is worth nothing.
 */
function witnessWeight(slot: number, info: PublicInfo): number {
  const dead = info.deadRoles.get(slot);
  if (dead) {
    if (isEvilRole(dead)) return 0;
    return roleDef(dead).faction === 'town' ? 1.2 : 0.4;
  }
  const proven = info.provenRoles.get(slot);
  if (proven) return isEvilRole(proven) ? 0 : 1.4;
  return 1;
}

/**
 * The movement case against every living seat, as log-odds and as reasons.
 *
 * One pass over the claims board per call, and the board is not large, so this
 * is cheap enough for the ranking to be rebuilt on every briefing.
 */
export function visitOdds(info: PublicInfo): Map<number, VisitOdds> {
  const prior = priorLogOdds(info);
  const out = new Map<number, VisitOdds>();

  /** Nights somebody was watching at all, which is what makes silence mean anything. */
  const watchedNights = new Set<number>();
  for (const claim of info.claims) {
    if (claim.kind === 'sighting') watchedNights.add(nightOf(claim));
  }

  for (const slot of info.aliveSlots) {
    const reasons: VisitReason[] = [];
    /** Per night, so one loud witness cannot be counted as four. */
    const byNight = new Map<number, number>();
    const add = (reason: VisitReason): void => {
      reasons.push(reason);
      if (reason.night === undefined) return;
      byNight.set(reason.night, (byNight.get(reason.night) ?? 0) + reason.weight);
    };

    let seenOutEver = false;

    for (const claim of info.claims) {
      const night = nightOf(claim);

      if (claim.kind === 'sighting' && claim.targetSlot === slot && claim.claimerSlot !== slot) {
        const heard = witnessWeight(claim.claimerSlot, info);
        if (heard <= 0) continue;
        seenOutEver = true;
        const victims = diedOn(night, info);
        if (claim.at !== undefined && victims.has(claim.at)) {
          /**
           * Shared between everybody reported on that doorstep, because "one of
           * these four did it" is a quarter of the evidence each, and reporting
           * four names should not convict four people.
           */
          const alsoThere = new Set(
            info.claims
              .filter((other) => other.kind === 'sighting' && other.at === claim.at && nightOf(other) === night)
              .map((other) => other.targetSlot)
          );
          add({
            code: 'doorstep',
            weight: (LR.doorstep * heard) / Math.max(1, alsoThere.size),
            night,
            at: claim.at
          });
        } else {
          add({ code: 'out-that-night', weight: LR.outThatNight * heard, night });
        }
      }

      /**
       * Their own account, put against the same night's report.
       *
       * Volunteering that you called on the house that died is mostly an honest
       * visiting role explaining itself, so it is worth very little — and it is
       * not worth nothing, because it is also what a liar says once a watcher
       * has already put them there.
       */
      if (claim.kind === 'account' && claim.claimerSlot === slot && claim.account === 'visited') {
        if (diedOn(night, info).has(claim.targetSlot)) {
          /**
           * Unless the record has already signed for why they were there.
           *
           * The rule reads a doorstep admission as a liar accounting for a
           * sighting, and it is right about that most of the time. It is exactly
           * wrong about the town's own killers: a Vigilante that shot a mafioso
           * was on that step, says so, and was scored at +0.8 for it — the same
           * as a mafioso caught on the same step, because nothing here looked at
           * what the house turned out to be.
           *
           * `provenRoles` only holds a killing badge when the dawn report
           * credited that weapon and the corpse came up evil (see `observe.ts`),
           * so this is not "they said they are the Vigilante". It is the record
           * agreeing with them, and a doorstep the record has explained is not
           * evidence of anything.
           */
          const vouched = info.provenRoles.get(slot);
          const explained =
            vouched !== undefined && (vouched === 'vigilante' || vouched === 'jailor' || vouched === 'veteran');
          if (!explained) {
            add({ code: 'admitted-doorstep', weight: LR.admittedDoorstep, night, at: claim.targetSlot });
          }
        }
      }
    }

    /**
     * Said home, and put outside by somebody the room believes. Counted once
     * however many times it happened, because it is one fact about this seat.
     */
    const accounts = info.claims.filter((claim) => claim.kind === 'account' && claim.claimerSlot === slot);
    const standing = accounts[accounts.length - 1];
    if (standing?.account === 'home') {
      const contradicted = info.claims.some(
        (claim) =>
          claim.kind === 'sighting' &&
          claim.targetSlot === slot &&
          claim.claimerSlot !== slot &&
          witnessWeight(claim.claimerSlot, info) >= 1
      );
      if (contradicted) reasons.push({ code: 'caught-lying', weight: LR.caughtLying });
    }

    /** What the record itself contradicts, folded in so the ranking is one number. */
    const broken = deductionWeight(deductions(slot, info));
    if (broken > 0) reasons.push({ code: 'record-broken', weight: broken * 0.5 });

    /**
     * And never once reported outside, on nights when there was somebody to do
     * the reporting. Weak, negative, and only ever available late.
     */
    if (!seenOutEver && watchedNights.size >= 2) {
      reasons.push({ code: 'never-out', weight: LR.neverOut });
    }

    /** Each night capped before the sum, then the sum capped again. */
    let total = 0;
    for (const reason of reasons) {
      if (reason.night === undefined) total += reason.weight;
    }
    for (const [, nightTotal] of byNight) {
      total += Math.max(-NIGHT_CAP, Math.min(NIGHT_CAP, nightTotal));
    }
    total = Math.max(-TOTAL_CAP, Math.min(TOTAL_CAP, total));

    const logOdds = prior + total;
    reasons.sort((left, right) => Math.abs(right.weight) - Math.abs(left.weight));
    out.set(slot, { logOdds, p: 1 / (1 + Math.exp(-logOdds)), reasons });
  }

  return out;
}

/** Every role this table could be hiding, for a caller that wants the prior alone. */
export function evilRolesInPlay(info: PublicInfo): RoleId[] {
  const inPlay = info.rolesInPlay ?? new Set<RoleId>(Object.keys(ROLES) as RoleId[]);
  return [...inPlay].filter((role) => isEvilRole(role));
}
