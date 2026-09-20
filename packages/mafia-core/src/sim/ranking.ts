import type { RoleId } from '../roles.js';
import { deductions, strongest, type Deduction } from './deduce.js';
import { claimerWeight, isEvilRole, trustOf, uncontestedBadge, type PublicInfo } from './policies.js';
import { tempoReads, type TempoCode } from './tempo.js';
import { visitOdds, type VisitReason } from './visits.js';

/**
 * Who the room should be looking at, in order, and why — in both directions.
 *
 * Three things already knew something about how suspicious a seat is and none
 * of them could be read as a list. `suspicionParts` answers "how much, to this
 * reader", which is a number with no explanation attached. `deductions` answers
 * "what does the record contradict", which is an explanation with no number.
 * `visitOdds` answers "where were they at night", which is a number *and* an
 * explanation but only about movement. What was missing is the thing a table
 * actually produces after twenty minutes of arguing: a ranking, with the
 * reasons written next to each name.
 *
 * And it runs both ways on purpose. A case is a list of reasons pointing at
 * somebody; the same list with the signs reversed is a case *for* them, which
 * is the half nobody had. A seat under a wagon with three things in its favour
 * — never once seen out, cleared by a badge the room believes, a record with
 * nothing broken in it — had all three sitting on the board and no way for
 * anybody to say them out loud. That is how a town hangs its own Doctor while
 * eleven seats who could have defended it say nothing.
 *
 * The number is not the point and is deliberately not shown to anybody as a
 * number. What travels is the ordering and the reasons, because those are what
 * a person can argue with.
 */
export interface Suspect {
  slot: number;
  /** Probability this seat is a killer, 0..1, from `visitOdds` plus the board. */
  p: number;
  /** Everything pointing at them, heaviest first. */
  against: Reason[];
  /** Everything pointing away, heaviest first. */
  standing: Reason[];
}

/**
 * One line of a case, kept as a code rather than a sentence.
 *
 * The renderer lives in the app, next to the catalogue, because the same reason
 * has to come out in two languages and as three different registers: a bot
 * saying it out loud, a briefing telling a model what the board holds, and a
 * defence answering it. A string built here could only ever do one of those.
 */
export interface Reason {
  code: ReasonCode;
  /** Log-odds it contributed. Positive accuses, negative defends. */
  weight: number;
  night?: number;
  /** The other house the reason is about: a doorstep, a witness, a rival. */
  slot?: number;
  /**
   * The badge the reason is about, when it is about one.
   *
   * `uncontestedBadge` returns the role and the reason threw it away, so the
   * strongest rule in the model could only ever be said as "nobody has disputed
   * your role claim" — which is most of a sentence and none of the point. The
   * point is *which* claim, because that is the thing another seat can stand up
   * and contest.
   */
  role?: RoleId;
  /** The day the reason is about, for the tempo rules, which are about an afternoon. */
  day?: number;
  /** For `record-broken`, exactly what the graveyard caught. */
  deduction?: Deduction;
}

export type ReasonCode =
  /** Said out loud that they are one of the killers. */
  | 'confessed'
  | VisitReason['code']
  | 'accused-by'
  | 'vouched-for'
  | 'hanged-killers'
  | 'saved-killers'
  | 'badge-unchallenged'
  | 'proven-town'
  | TempoCode;

/**
 * How heavily the board's own opinions count, measured rather than argued.
 *
 * Every number here is a log-likelihood ratio fitted on the bench: how often
 * the rule fires on a killer, against how often it fires on everybody else,
 * over sixty thousand seat-days. That is the definition of the weight, so
 * fitting it is not tuning, it is *computing* it.
 *
 * The first version of this table was priced by reasoning about the game, which
 * felt careful and scored worse than useless — Brier 0.252 against 0.235 for
 * flatly announcing the base rate. Two of the six had the wrong sign and one
 * was measuring nothing at all.
 *
 * The finding worth reading twice is `badge`. An investigative claim that no
 * living seat contests was priced as mild evidence of *innocence*, on the
 * reasoning that a liar's badge tends to get challenged. The table says the
 * reverse, and loudly: it fires on 7.8% of killers and 0.5% of everybody else,
 * a log-ratio of +2.77, which is the strongest single rule in the model. The
 * reason is obvious once the number forces you to look: the seat most likely to
 * be sitting on an uncontested Sheriff badge is the one whose Sheriff is a
 * bluff, because the real Sheriff is alive, quiet, and not about to stand up
 * and contest it. That is a fact about this game, and no amount of reasoning
 * about it from first principles was going to produce the right sign.
 *
 * Caveat, stated plainly: these are fitted against a table of bots. The
 * movement rules are safe, because a killer visiting the house it kills is the
 * engine's rule and not a habit. The rules about what people *say* are only as
 * representative as the policy that says it, and they should be refitted when
 * there is a corpus of real tables to fit against.
 */
const SAID = {
  accusedBy: 0.3,
  /**
   * The strongest single thing on the board, and the cheapest to check.
   *
   * Heavier than an unchallenged badge, because a badge is a claim about what
   * somebody does at night and this is a claim about which side they are on,
   * made by the one person who knows for certain. A liar who says it to be
   * interesting pays the price of having said it, which is the price the room
   * would charge.
   */
  confessed: 3.0,
  vouchedFor: -0.63,
  hangedKillers: -0.09,
  savedKillers: 0.39,
  badge: 2.77,
  /**
   * Zero, measured twice, and the second most interesting number in the file.
   *
   * A role the record has signed for ought to be the strongest exoneration on
   * the board. It fires on 0.7% of killers and 0.7% of everybody else: no
   * signal at all, at four significant figures. The first reading of that was
   * that the rule was buggy, and it was — it counted proven *evils* as a reason
   * to be trusted — and fixing that moved the number from -0.004 to -0.010.
   *
   * So the rule is not broken; the belief behind it was. `provenRoles` is not a
   * proof of allegiance, it is a proof of *play*: a living seat earns it by
   * claiming a badge and then having one of its accusations put a revealed
   * killer in the ground, and a mafioso who buses a brother has done exactly
   * that on purpose. `observe.ts` says so in its own comment and the board
   * still read it as innocence. It is a bought reputation, and this is what a
   * bought reputation is worth as evidence.
   */
  provenTown: -0.01
} as const;

/**
 * How much of a voice a rule needs behind it before it counts at all.
 *
 * A threshold rather than a multiplier, and the difference mattered more than
 * it looks. Every weight in `SAID` is a likelihood ratio fitted on *whether the
 * rule fired*, so scaling one by a credibility of 2.6 claims two and a half
 * times the evidence that was ever measured. The bench caught it at the bottom
 * of the range: a seat vouched for by somebody the room believed came out at
 * 0.05, and seats at 0.05 turned out to be killers 37% of the time — which is
 * the base rate, which is to say the number was pure invention.
 *
 * So credibility decides *if* a voice is heard and the fitted ratio decides
 * what being heard is worth. Anybody the room has not written off entirely.
 */
const CREDIBLE_ENOUGH = 0.6;

/**
 * The least the ranking may ever claim about anybody. See the note in `rank`.
 *
 * Set at roughly the base rate, because that is what the measurement says a
 * seat with nothing against it actually is.
 */
const FLOOR = 0.3;

/**
 * The whole table, ranked, with both cases written out.
 *
 * Read-only: nothing here feeds back into `suspicion`, and that separation is
 * load-bearing. The voting already weighs sightings, deductions and the trust
 * meter; if the ranking fed back in, every one of those would be counted twice
 * and the loudest evidence would compound with itself. So this is what the
 * table *says*, and `suspicionParts` stays what the table *does*.
 */
export function rank(info: PublicInfo): Suspect[] {
  const odds = visitOdds(info);

  return info.aliveSlots
    .map((slot) => {
      const movement = odds.get(slot);
      const reasons: Reason[] = (movement?.reasons ?? []).map((reason) => ({
        code: reason.code,
        weight: reason.weight,
        ...(reason.night === undefined ? {} : { night: reason.night }),
        ...(reason.at === undefined ? {} : { slot: reason.at })
      }));

      // The graveyard's own catch, named rather than left as a weight.
      const caught = strongest(deductions(slot, info));
      if (caught) {
        const at = reasons.findIndex((reason) => reason.code === 'record-broken');
        if (at >= 0) reasons[at] = { ...reasons[at], deduction: caught };
      }

      /**
       * Who is pointing, and how much the room thinks of them. The heaviest
       * accuser only: a chorus is one reason said several times, and listing it
       * several times is exactly the pile-on `suspicionParts` already discounts.
       */
      const accusers = info.claims
        .filter(
          (claim) => claim.kind === 'accuse' && claim.targetSlot === slot && info.aliveSlots.includes(claim.claimerSlot)
        )
        .map((claim) => ({ slot: claim.claimerSlot, heard: claimerWeight(claim.claimerSlot, info) }))
        .sort((left, right) => right.heard - left.heard)[0];
      if (accusers && accusers.heard >= CREDIBLE_ENOUGH) {
        reasons.push({ code: 'accused-by', weight: SAID.accusedBy, slot: accusers.slot });
      }

      const voucher = info.claims
        .filter(
          (claim) => claim.kind === 'clear' && claim.targetSlot === slot && info.aliveSlots.includes(claim.claimerSlot)
        )
        .map((claim) => ({ slot: claim.claimerSlot, heard: claimerWeight(claim.claimerSlot, info) }))
        .sort((left, right) => right.heard - left.heard)[0];
      if (voucher && voucher.heard >= CREDIBLE_ENOUGH) {
        reasons.push({ code: 'vouched-for', weight: SAID.vouchedFor, slot: voucher.slot });
      }

      const trust = trustOf(slot, info);
      // Scaled with the meter itself: a correct rope is now priced by how
      // divided the room was, so the old threshold described almost nobody.
      if (trust >= 1.2) reasons.push({ code: 'hanged-killers', weight: SAID.hangedKillers });
      else if (trust <= -2) reasons.push({ code: 'saved-killers', weight: SAID.savedKillers });

      /**
       * A seat that said out loud it is one of the killers.
       *
       * Public, checkable by anybody who was in the square, and the heaviest
       * single thing that can be said about a seat — which is why it is here
       * and not only in `suspicionParts`: this model is where the bots get the
       * *sentence* from, and a town that hangs a man for confessing should be
       * able to say that is what it is doing.
       */
      const confession = info.claims.find(
        (claim) =>
          claim.kind === 'role-claim' &&
          claim.claimerSlot === slot &&
          claim.claimedRole !== undefined &&
          isEvilRole(claim.claimedRole)
      );
      if (confession?.claimedRole) {
        reasons.push({ code: 'confessed', weight: SAID.confessed, role: confession.claimedRole });
      }

      const badge = uncontestedBadge(slot, info);
      if (badge !== null) reasons.push({ code: 'badge-unchallenged', weight: SAID.badge, role: badge });

      /**
       * A role the record signed for, and only when the record signed for a
       * *townie*.
       *
       * The first version fired this for any proven role at all, so a seat the
       * graveyard had proven to be a killer was handed the same reason to be
       * trusted as a revealed Mayor. The fit found it: log-ratio -0.004, fired
       * on killers and on everybody else at the identical rate, which is what a
       * rule measuring nothing looks like.
       */
      const proven = info.provenRoles.get(slot);
      if (proven && !isEvilRole(proven)) {
        reasons.push({ code: 'proven-town', weight: SAID.provenTown, slot });
      }

      /**
       * And how this seat has handled its ballot, which is the one kind of
       * evidence up here that nobody chose to produce.
       *
       * Every other rule in this block prices something somebody *said*. A vote
       * is an act, the engine timestamped it, and no amount of arguing moves
       * it. See `tempo.ts` for what each rule catches and why every one of them
       * waits for the graveyard to settle the house it is about.
       */
      for (const read of tempoReads(slot, info)) {
        reasons.push({
          code: read.code,
          weight: read.weight,
          ...(read.day === undefined ? {} : { day: read.day }),
          ...(read.at === undefined ? {} : { slot: read.at })
        });
      }

      const logOdds = (movement?.logOdds ?? 0) + reasons.filter(isSaid).reduce((sum, r) => sum + r.weight, 0);

      const against = reasons.filter((reason) => reason.weight > 0).sort((a, b) => b.weight - a.weight);
      const standing = reasons.filter((reason) => reason.weight < 0).sort((a, b) => a.weight - b.weight);

      /**
       * A floor under the score, because a quiet seat is not a cleared one.
       *
       * The calibration run is unambiguous about which half of this ranking can
       * be trusted. At the top it is very good: seats it puts above 0.9 are
       * killers 94% of the time, above 0.8 they are killers 90% of the time,
       * and those are the seats a decision ever gets made about. At the bottom
       * it is worthless. Seats it put under 0.1 turned out to be killers *40%*
       * of the time, which is the base rate, which is to say the number was not
       * measuring anything at all.
       *
       * That is not a defect to tune away, it is the game. Absence of evidence
       * against somebody in Mafia is mostly evidence that nobody was watching
       * them, and a killer who has gone unseen looks exactly like a villager
       * who has gone unseen — that is what the role is *for*. So the ranking is
       * allowed to be confident that somebody is guilty and is never allowed to
       * be confident that somebody is innocent, and the floor is what enforces
       * it.
       *
       * The consequence is deliberate and reaches all the way out to what a bot
       * may say. Nothing may cite a low score as a reason to trust a seat. A
       * *named* reason — a proven badge vouching for them, never once reported
       * outside — is still sayable and still worth hearing, because it is a
       * fact about the record rather than a hole in it.
       */
      const raw = 1 / (1 + Math.exp(-logOdds));
      return { slot, p: Math.max(FLOOR, raw), against, standing };
    })
    .sort((left, right) => right.p - left.p);
}

/** The reasons this file adds, as opposed to the ones `visitOdds` already summed. */
/**
 * The reasons that come from what the room *said*, rather than from the night.
 *
 * `visitOdds` already carries the movement half of the model, so only these are
 * summed on top of it — which makes this list load-bearing rather than
 * decorative: a reason missing from it is attached to the seat, printed in the
 * trace, rendered in a bot's sentence, and worth exactly nothing to the score.
 * `confessed` was priced at 3.0 and left out of here, so a man announcing he
 * was the Serial Killer moved the ranking by 0.000 and every certainty path
 * built on `rank` — the gun, the cell, the booth — ignored him.
 */
function isSaid(reason: Reason): boolean {
  return (
    reason.code === 'confessed' ||
    reason.code === 'accused-by' ||
    reason.code === 'vouched-for' ||
    reason.code === 'hanged-killers' ||
    reason.code === 'saved-killers' ||
    reason.code === 'badge-unchallenged' ||
    reason.code === 'proven-town' ||
    reason.code === 'led-town-wagon' ||
    reason.code === 'led-killer-wagon' ||
    reason.code === 'saved-at-the-edge'
  );
}

/**
 * The case against one seat, if there is one worth making.
 *
 * An accusation that cites one reason reads like a hunch and an accusation that
 * cites four reads like a prosecutor, so this hands back the top few and lets
 * the caller decide how many to say. Empty when the board holds nothing, which
 * is the answer that keeps a bot from inventing a case it does not have.
 */
export function caseFor(slot: number, info: PublicInfo, most = 3): Reason[] {
  const found = rank(info).find((suspect) => suspect.slot === slot);
  return (found?.against ?? []).slice(0, most);
}

/**
 * And the case for them, which is the half that was missing.
 *
 * Used by a seat deciding whether to stand up for somebody under a wagon: if
 * the board holds real reasons to doubt the case, a townie ought to say them,
 * and until now it could only do that for a seat the graveyard had already
 * vouched for. Three things it was never able to say: nobody has ever put them
 * outside, the badge they claimed has gone unchallenged all game, and the
 * record has caught them in nothing.
 */
export function defenceFor(slot: number, info: PublicInfo, most = 3): Reason[] {
  const found = rank(info).find((suspect) => suspect.slot === slot);
  return (found?.standing ?? []).slice(0, most);
}
