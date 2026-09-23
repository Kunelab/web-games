import { CORPSE_ONLY, ROLES, roleDef, type RoleId } from '../roles.js';
import { possibleRoles, roomForAll } from './slots.js';
import type { Claim, PublicInfo } from './policies.js';

/**
 * What the night did, held against what people said it did.
 *
 * The bench was asked why the rope kept finding town, and underneath the
 * arithmetic there was a simpler answer: the table could not catch a lie unless
 * somebody had physically *seen* it. Every piece of hard evidence in the model
 * was an observation — an investigator's check, a lookout's list, a corpse the
 * graveyard identified — so a liar at a table whose watchers were dead was
 * safe no matter what they said, and the town was left guessing and hanging its
 * own people while doing it.
 *
 * But most lies in this game do not need a witness. They need arithmetic. A
 * bodyguard who steps in front of a knife is a corpse in the morning report, so
 * "I was guarded last night" on a night when nobody died is a sentence the
 * whole room can disprove from the screen it is already looking at. Poison
 * kills at the second dawn. A seat in the cell did not visit anybody. Two
 * people cannot have been in the one cell. You cannot have called on a house
 * whose owner was already buried. None of that needs a Lookout, and none of it
 * was checked.
 *
 * The asymmetry was almost funny: `couldStillAct` existed so that a *liar*
 * would not claim to have been blackmailed at a table with no blackmailer, and
 * nothing anywhere used it to catch one who did. The bots were careful liars
 * and credulous listeners.
 *
 * So this is the deduction layer, and it is deliberately only the part that is
 * *certain*. Everything here is either impossible or all but: no probabilities,
 * no "a real Doctor would have healed the Mayor", nothing that depends on
 * reading somebody's play. That keeps it honest against a table of people, who
 * do unaccountable things for good reasons, and it keeps every finding sayable
 * in one sentence that the room can check for itself.
 */
export type Deduction =
  /** Said they were poisoned, and two dawns later they are still standing. */
  | { kind: 'poison-survived'; night: number }
  /** Called on a house whose owner was already in the ground. */
  | { kind: 'visited-a-corpse'; night: number; otherSlot: number }
  /** Wears a badge that only ever works on a corpse, and called on the living. */
  | { kind: 'visited-the-living'; night: number; otherSlot: number; role: RoleId }
  /** A bodyguard died for them on a night the report records no death. */
  | { kind: 'guarded-nobody-died'; night: number }
  /** Two seats, one cell, one night. */
  | { kind: 'two-in-one-cell'; night: number; otherSlot: number }
  /** In the cell, and out visiting, on the same night. */
  | { kind: 'acted-from-the-cell'; night: number }
  /** Claimed something done to them that nobody left alive can do. */
  | { kind: 'impossible-ailment'; ailment: NonNullable<Claim['ailment']> }
  /** Claimed a badge the published roster does not contain. */
  | { kind: 'role-not-in-play'; role: RoleId }
  /**
   * Claimed a badge the roster could have held and the graveyard has used up.
   *
   * The same arithmetic one step further on, and the harder half of it. The
   * list on the wall says one Neutral Benign and one Any Role; the graveyard
   * says the first was the Lover and the second was a Triad Enforcer; so there
   * is no longer anywhere at this table for a Jester to be, and a seat claiming
   * one is claiming something the room can check for itself. A person at a real
   * table made exactly this deduction by hand, in the square, while the board
   * had no way to hold it. See `possibleRoles`.
   */
  | { kind: 'no-slot-left'; role: RoleId }
  /**
   * More badges standing up than the deal has room for.
   *
   * `no-slot-left` is this deduction against the *graveyard*: the corpses have
   * used up every slot that could have held the badge. This is the same
   * arithmetic against the *living*, and it is the half the room actually
   * argues about, because the living answer back.
   *
   * Three seats claim an investigative badge; the roster dealt one Sheriff slot
   * and one Random Town; the identified dead already spent the Random Town. One
   * of those three is lying and nobody has seen anything. It is the plainest
   * deduction in the game and it needed a matching to make, which is why no
   * table ever made it: a person can just about do it by hand with two
   * claimants, and never with four claimants across six category slots.
   *
   * Names the others on purpose. The finding convicts a *group* and not a seat,
   * exactly like a shared cell, and a bot saying it has to be able to say who
   * else is in it, because the answer is somebody in the room and the room can
   * work out which.
   */
  | { kind: 'no-room-for-all'; role: RoleId; others: number[] }
  /** Put words in a living seat's mouth, and that seat never said them. */
  | { kind: 'relay-denied'; otherSlot: number }
  /** Bet their life on proving it by dawn, and dawn came. */
  | { kind: 'broken-promise'; night: number };

/**
 * What each finding is worth, as hard evidence.
 *
 * Priced by how little room the record leaves for an innocent explanation. The
 * three impossibilities are worth most; the ones where somebody honest could
 * conceivably be caught out — a shy Doctor who purged a poison and said nothing
 * — are worth less, and a shared cell is worth least of all because it convicts
 * one of two seats without saying which.
 */
const WORTH: Record<Deduction['kind'], number> = {
  'visited-a-corpse': 2.5,
  'visited-the-living': 2.5,
  'guarded-nobody-died': 2.5,
  'acted-from-the-cell': 2.5,
  'role-not-in-play': 3,
  'no-slot-left': 3,
  'broken-promise': 2.5,
  'poison-survived': 2,
  'impossible-ailment': 2,
  'relay-denied': 1.5,
  'two-in-one-cell': 1.2,
  /**
   * Priced at the shared cell, and for the same reason: it is certain that
   * somebody in the group is lying and it does not say which one. A seat in a
   * conflict of two carries half the blame of a proven liar; the pricing does
   * not thin out further for a conflict of four, because the finding is capped
   * at three claimants anyway (see the pigeonhole) and a wider one is not
   * something a room can hold in its head or act on.
   */
  'no-room-for-all': 1.2
};

/**
 * The night a claim is *about*.
 *
 * Written down where it is known — see `Claim.night` — and guessed from the day
 * it was said otherwise, which is what everything did before that field
 * existed.
 */
function nightOf(claim: Claim): number {
  return claim.night ?? Math.max(1, claim.day - 1);
}

/** The slot accounting, kept per board. See `stillFits`. */
const SLOT_FITS = new WeakMap<PublicInfo, Set<RoleId>>();

/** The badges standing up in the room right now, and who is wearing each. */
const CROWDED = new WeakMap<PublicInfo, Map<number, number[]>>();

/**
 * Too many badges for the deal, and who is in the conflict.
 *
 * Returns, per claiming seat, the other seats it cannot be telling the truth
 * alongside. Empty for everybody when the room's claims all fit, which is the
 * ordinary case and costs one matching.
 *
 * The method is the one a person would use if they could hold it in their head.
 * Seat the identified dead and every living claim at once; if they all fit,
 * nobody is caught. If they do not, take each claim out in turn and ask whether
 * the rest fit without it: every claim that is *in* some minimal conflict is
 * one the room may argue about, and the ones that could be dropped without
 * helping are innocent of this particular arithmetic.
 *
 * Deliberately conservative in three ways, because the cost of being wrong here
 * is calling an honest badge a lie:
 *
 *  - the newest claim per seat only, since people correct themselves;
 *  - living claimants only, since a dead seat's badge is settled by its corpse
 *    and is already counted among the identified dead;
 *  - and nothing at all when the graveyard already fails to fit the roster,
 *    because then the deal has stopped explaining the table (a conversion, a
 *    promotion, an Amnesiac) and every count built on it is void. That check is
 *    `possibleRoles`' own and it is repeated here for the same reason.
 */
function crowdedBadges(info: PublicInfo): Map<number, number[]> {
  const cached = CROWDED.get(info);
  if (cached) return cached;

  const out = new Map<number, number[]>();
  CROWDED.set(info, out);
  if (!info.roleSlots) return out;

  const buried = [...info.deadRoles.values()];
  if (!roomForAll(info.roleSlots, buried)) return out;

  /** One badge per living seat, the last one it stood behind. */
  const claimed = new Map<number, RoleId>();
  for (const claim of info.claims) {
    if (claim.kind !== 'role-claim' || !claim.claimedRole) continue;
    if (!info.aliveSlots.includes(claim.claimerSlot)) continue;
    claimed.set(claim.claimerSlot, claim.claimedRole);
  }
  if (claimed.size < 2) return out;

  const wearing = [...claimed.entries()];
  if (roomForAll(info.roleSlots, [...buried, ...wearing.map(([, role]) => role)])) return out;

  /**
   * Which claims are actually in the way.
   *
   * A seat whose removal does not help is not part of the conflict: the room
   * would still be over-subscribed without it, so nothing about it has been
   * proved. This is the difference between naming two seats and accusing
   * everybody who ever claimed anything.
   */
  const guilty: number[] = [];
  for (const [slot] of wearing) {
    const without = wearing.filter(([other]) => other !== slot).map(([, role]) => role);
    if (roomForAll(info.roleSlots, [...buried, ...without])) guilty.push(slot);
  }

  /**
   * Nobody's single removal fixes it, which means the room is over-subscribed
   * by more than one badge. True, and not sayable: the conflict is every
   * claimant at once, no smaller group is provably in it, and a bot announcing
   * that six people cannot all be telling the truth has said something nobody
   * can act on. Left for the wider count to catch a day later, when a corpse
   * has narrowed it.
   */
  if (guilty.length < 2 || guilty.length > 3) return out;

  for (const slot of guilty) out.set(slot, guilty.filter((other) => other !== slot));
  return out;
}

/** Was this seat already buried before that night fell? */
function buriedBefore(slot: number, night: number, info: PublicInfo): boolean {
  return info.deaths.some(
    (death) => death.slot === slot && (death.day < night || (death.day === night && death.phase === 'day'))
  );
}

/** Did anybody die on that night, as the morning report told it? */
function diedThatNight(night: number, info: PublicInfo): boolean {
  return info.deaths.some((death) => death.phase === 'night' && death.day === night);
}

/**
 * Could any living role still do this to somebody?
 *
 * The same question `couldStillAct` asks about a night action, asked about the
 * effect rather than the verb, because what a seat reports is the effect. Kept
 * here rather than threaded through `policies` so the ailment table and the
 * deduction that reads it sit next to each other and cannot drift apart.
 *
 * Generous where it is unsure, on purpose: an unknown roster allows everything,
 * and so does a corpse the game refused to identify. A liar should be caught by
 * the record, not by this table being out of date.
 */
const CAUSED_BY: Partial<Record<NonNullable<Claim['ailment']>, RoleId[]>> = {
  poison: ['poisoner'],
  douse: ['arsonist'],
  silenced: ['blackmailer', 'silencer'],
  jailed: ['jailor'],
  guarded: ['bodyguard'],
  healed: ['doctor'],
  blocked: ['escort', 'consort'],
  controlled: ['witch'],
  bussed: ['bus-driver']
};

/**
 * Judged against the graveyard **as it stood that night**, which is the whole
 * difficulty of this one.
 *
 * The first shape asked whether anybody could *still* do it, using today's
 * corpses, and that brands honest seats as liars in arrears: a player healed on
 * night two by a Doctor who is killed on night five stops having been healed the
 * moment the Doctor dies. The bench caught seventeen hundred people that way and
 * it read as the deduction layer working. What makes a claim a lie is that it
 * was impossible **when it was made**, so only corpses already in the ground by
 * then may be counted.
 *
 * Generous everywhere it is unsure, on purpose: an unknown roster allows
 * everything, so does a corpse the game refused to identify, and so does an
 * effect this table has no entry for. A liar should be caught by the record and
 * not by this function being out of date.
 */
function nobodyCouldHave(ailment: NonNullable<Claim['ailment']>, night: number, info: PublicInfo): boolean {
  return nobodyLeftWith(CAUSED_BY[ailment], night, info);
}

/**
 * Of a set of roles that could explain a claim, is every one of them off the
 * board by that night?
 *
 * The shared half of `nobodyCouldHave` and `nobodyCouldVisitTheDead`, and the
 * generosity is the point: an unknown roster explains everything, and so does a
 * role that was merely *possible* at the time. Only when the record leaves no
 * candidate standing is a claim an impossibility rather than a narrowing.
 */
function nobodyLeftWith(candidates: readonly RoleId[] | undefined, night: number, info: PublicInfo): boolean {
  if (!candidates || !info.rolesInPlay) return false;
  const known = candidates.filter((role) => role in ROLES);
  if (known.length === 0) return false;
  const possible = known.filter((role) => info.rolesInPlay!.has(role));
  if (possible.length === 0) return true;

  const alreadyBuried = new Set<RoleId>();
  for (const [slot, role] of info.deadRoles) {
    const death = info.deaths.find((entry) => entry.slot === slot);
    if (death && death.day < night) alreadyBuried.add(role);
  }
  return possible.every((role) => alreadyBuried.has(role));
}

/**
 * The four badges whose whole job is on a slab.
 *
 * The Amnesiac takes a dead seat's role, the Coroner performs the autopsy, the
 * Janitor and the Incense Master clean the body. For all four, "I went to a
 * house whose owner was dead" is not a slip, it is the power working.
 */
const VISITS_THE_DEAD: readonly RoleId[] = ['amnesiac', 'coroner', 'janitor', 'incense-master'];

/**
 * The three of those four that can *only* ever work on a corpse.
 *
 * The Amnesiac is deliberately not here: it stops being an Amnesiac the moment
 * it remembers, so a seat that claimed the badge on day two and describes an
 * ordinary visit on night four is describing whatever it turned into. The other
 * three keep their badge all game and their power never has anywhere to go but
 * the morgue, so for them a night out among the living is not a slip of
 * phrasing, it is two claims that cannot both be true.
 */
/**
 * Re-exported from the role table, where the liar reads it too.
 *
 * A bot wearing one of these as a mask goes on filing its real movements, and
 * those name the living, so the mask and the night log refute each other in the
 * same will. The mask pickers therefore refuse to hand one out, and both ends
 * read one list rather than keeping copies that drift apart.
 */
export { CORPSE_ONLY };

/**
 * Could anybody at all have called on a corpse that night?
 *
 * `visited-a-corpse` was unconditional, and it hanged an honest man in front of
 * us. Two Amnesiacs woke on night two, both took the dead Sheriff's badge, and
 * the square was *told* so: "The Amnesiac remembered" went out with the dawn
 * report. One of them then answered the question every seat is asked — where
 * were you — with the truth, that he had gone to a house whose owner was
 * already dead, because that is the only place his power can be used. Three
 * seats read it back to him as proof of lying and the town hanged him for
 * describing his own role correctly, with the exonerating announcement sitting
 * two hours up the same log.
 *
 * So the finding now requires what the rest of this file requires: that the
 * record leave no innocent explanation. With any of the four in play the claim
 * is a narrowing and not an impossibility, which is a thing for the suspicion
 * model to weigh, not for the deduction layer to certify.
 */
function nobodyCouldVisitTheDead(night: number, info: PublicInfo): boolean {
  return nobodyLeftWith(VISITS_THE_DEAD, night, info);
}

/**
 * Everything the record contradicts about what this seat has said.
 *
 * Pure and cheap: it walks the claims board once per question and holds no
 * state, so a caller may ask about every seat on every pass the way
 * `suspicionParts` does.
 */
export function deductions(slot: number, info: PublicInfo): Deduction[] {
  const found: Deduction[] = [];
  const mine = info.claims.filter((claim) => claim.claimerSlot === slot);
  if (mine.length === 0) return found;

  /**
   * Whether a badge still has anywhere to be, worked out once per board.
   *
   * `possibleRoles` walks a matching per role and this function is asked about
   * every seat on every decision, so the answer is computed on first ask and
   * kept with the board, which is rebuilt whenever anything it reads changes.
   */
  const stillFits = (role: RoleId): boolean => {
    if (!info.roleSlots) return true;
    let possible = SLOT_FITS.get(info);
    if (!possible) {
      possible = possibleRoles(info.roleSlots, [...info.deadRoles.values()]);
      SLOT_FITS.set(info, possible);
    }
    return possible.has(role);
  };

  const alive = info.aliveSlots.includes(slot);

  /**
   * A badge this seat has worn that only ever works on a corpse.
   *
   * Taken across every claim rather than the latest, because these three roles
   * do not change: a seat that said "Coroner" on day five was a Coroner on
   * night two as well, or it was never one at all.
   */
  const corpseOnly = mine.find(
    (claim) => claim.kind === 'role-claim' && claim.claimedRole && CORPSE_ONLY.includes(claim.claimedRole)
  )?.claimedRole;

  for (const claim of mine) {
    const night = nightOf(claim);

    if (
      claim.kind === 'account' &&
      claim.account === 'visited' &&
      buriedBefore(claim.targetSlot, night, info) &&
      nobodyCouldVisitTheDead(night, info)
    ) {
      found.push({ kind: 'visited-a-corpse', night, otherSlot: claim.targetSlot });
    }

    /**
     * The same contradiction from the other end, which nothing was catching.
     *
     * A real table watched a Framer claim the Coroner's badge and then account
     * for its nights with "Littlefinger, night two, that is where I was" —
     * Littlefinger being alive, well and sitting four seats away. Three people
     * voted guilty and every one of them gave the visit itself as the reason,
     * which is no reason at all: going to a living man's house is what almost
     * every role in this game does. The actual contradiction was that a Coroner
     * cannot go there, and nobody said it, because nothing could see it.
     *
     * Only against a seat that has never been in the ground at all, which is as
     * generous as this gets: a corpse might have been made on the very night it
     * was called on, and the two claims are then a sequence rather than a clash.
     * Read off `deaths` rather than the living roster so it shares one source
     * with `buriedBefore` above, and the two findings can never both fire.
     */
    if (
      claim.kind === 'account' &&
      claim.account === 'visited' &&
      corpseOnly &&
      !info.deaths.some((death) => death.slot === claim.targetSlot)
    ) {
      found.push({ kind: 'visited-the-living', night, otherSlot: claim.targetSlot, role: corpseOnly });
    }

    if (
      claim.kind === 'role-claim' &&
      claim.claimedRole &&
      info.rolesInPlay &&
      !info.rolesInPlay.has(claim.claimedRole)
    ) {
      found.push({ kind: 'role-not-in-play', role: claim.claimedRole });
    } else if (claim.kind === 'role-claim' && claim.claimedRole && info.roleSlots && !stillFits(claim.claimedRole)) {
      /**
       * The roster allowed it and the graveyard has since spent every slot that
       * could have been it. See `no-slot-left` and `possibleRoles`.
       *
       * Only when the first test did not already fire: a role the deal never
       * contained is the simpler sentence and the one the room checks faster.
       */
      found.push({ kind: 'no-slot-left', role: claim.claimedRole });
    } else if (claim.kind === 'role-claim' && claim.claimedRole && alive) {
      /**
       * And the same arithmetic against the living, which is the one the room
       * can answer back to. Last, because both tests above are about this seat
       * alone and this one is about a group.
       */
      const others = crowdedBadges(info).get(slot);
      if (others && others.length > 0 && !found.some((entry) => entry.kind === 'no-room-for-all')) {
        found.push({ kind: 'no-room-for-all', role: claim.claimedRole, others });
      }
    }

    if (claim.kind === 'relay' && claim.relayedFrom !== undefined) {
      /**
       * A relay the seat it is attributed to has publicly denied.
       *
       * Only a living source counts, and only an explicit denial: silence is
       * not a denial, because the seat being quoted may simply not have spoken
       * since, or may be dead, or may be perfectly happy to let the relay
       * stand. What convicts is the named seat saying it never said it.
       */
      const denied = info.claims.some(
        (other) =>
          other.claimerSlot === claim.relayedFrom &&
          other.kind === 'counter-claim' &&
          other.targetSlot === slot &&
          info.aliveSlots.includes(claim.relayedFrom)
      );
      if (denied) found.push({ kind: 'relay-denied', otherSlot: claim.relayedFrom });
    }

    if (claim.kind === 'promise' && claim.promise === 'night' && alive) {
      /**
       * The bet, once dawn has settled it.
       *
       * A promise to prove something in the dark buys the seat a day, which is
       * the whole reason to make one and the whole reason it has to cost
       * something when it is not kept.
       *
       * Kept means the seat *put something on the record* the next day: a
       * check, a doorstep, an account, a name. The first shape of this asked
       * whether the seat had become a proven role instead, which reads right
       * and is wrong, because `provenRoles` has three narrow sources and a Town
       * Crier naming itself in the dark is none of them. So the honest seats
       * who made the one promise this game is built around were being hanged
       * for keeping it. What a table actually judges is whether you did the
       * thing you said you would do, and that is what this asks.
       */
      /**
       * Kept by the kind of thing the promised role produces, not by talking.
       *
       * "Something on the record" was any accusation or account at all, so a
       * liar who promised on the stand kept the promise by naming anybody the
       * next morning, and the bench measured it: not one such promise was ever
       * judged broken, and it was the largest single credit a defence could buy.
       *
       * So the role the seat stands behind decides what counts. A check is a
       * verdict on somebody, a watch is a doorstep, a cell is a report on its
       * prisoner, a Crier's proof is naming itself. A seat with no role claimed
       * has to say what it is as well as what it found. Two cases are left open
       * rather than broken: a Veteran nobody visited has nothing to show and did
       * nothing wrong, and a seat that says it was blocked, jailed, controlled or
       * moved last night has the one excuse the room cannot check.
       */
      const later = info.claims.filter((other) => other.claimerSlot === slot && other.day > claim.day);
      const badge = [...info.claims]
        .reverse()
        .find((other) => other.kind === 'role-claim' && other.claimerSlot === slot && other.claimedRole)?.claimedRole;
      const about = (kinds: readonly string[]): boolean =>
        later.some((other) => kinds.includes(other.kind) && other.targetSlot !== slot);
      const excused =
        badge === 'veteran' ||
        later.some(
          (other) =>
            other.kind === 'ailing' &&
            (other.ailment === 'blocked' ||
              other.ailment === 'jailed' ||
              other.ailment === 'controlled' ||
              other.ailment === 'bussed')
        );
      const delivered =
        badge === 'crier'
          ? later.some((other) => other.kind === 'role-claim')
          : badge === 'sheriff' || badge === 'investigator'
            ? about(['accuse', 'clear', 'hint'])
            : badge === 'lookout' || badge === 'detective' || badge === 'spy'
              ? about(['sighting', 'accuse', 'hint'])
              : badge === 'jailor'
                ? about(['hint', 'accuse', 'clear'])
                : later.some((other) => other.kind === 'role-claim') && about(['accuse', 'clear', 'hint', 'sighting']);
      if (info.day > claim.day && !delivered && !excused && !info.provenRoles.has(slot)) {
        found.push({ kind: 'broken-promise', night: claim.day });
      }
    }

    if (claim.kind !== 'ailing' || !claim.ailment) continue;

    if (nobodyCouldHave(claim.ailment, night, info)) {
      found.push({ kind: 'impossible-ailment', ailment: claim.ailment });
    }

    if (claim.ailment === 'guarded' && !diedThatNight(night, info)) {
      found.push({ kind: 'guarded-nobody-died', night });
    }

    if (claim.ailment === 'jailed') {
      // A cell holds one. Two seats reporting the same night means one of them
      // is inventing an alibi, and the room cannot yet tell which.
      for (const other of info.claims) {
        if (other.kind !== 'ailing' || other.ailment !== 'jailed') continue;
        if (other.claimerSlot === slot || nightOf(other) !== night) continue;
        if (roleDef('jailor').unique) found.push({ kind: 'two-in-one-cell', night, otherSlot: other.claimerSlot });
        break;
      }
      // And the cell has no door: a seat that was in it went nowhere.
      if (mine.some((other) => other.kind === 'account' && other.account === 'visited' && nightOf(other) === night)) {
        found.push({ kind: 'acted-from-the-cell', night });
      }
    }

    if (claim.ailment === 'poison' && alive) {
      /**
       * Poison kills at the second dawn, so the room learns the truth of this
       * one by waiting rather than by trusting anybody.
       *
       * The out is a Doctor, who purges it — so a seat that says it was cured,
       * or anybody who says they called on that house that night, settles the
       * matter and this stays quiet. Generous on purpose: the cost of being
       * wrong here is hanging somebody the town's own Doctor saved.
       */
      const settled = info.day < claim.day + 2;
      const cured =
        mine.some((other) => other.kind === 'ailing' && other.ailment === 'healed' && nightOf(other) >= night) ||
        info.claims.some(
          (other) =>
            other.claimerSlot !== slot &&
            other.kind === 'account' &&
            other.account === 'visited' &&
            other.targetSlot === slot &&
            nightOf(other) >= night
        );
      if (!settled && !cured) found.push({ kind: 'poison-survived', night });
    }
  }

  return found;
}

/**
 * What the pile is worth against this seat, as hard evidence.
 *
 * Capped, and the cap is the point. Each finding here is close to certain, so
 * an uncapped sum would let three of them outweigh a Sheriff's check and turn
 * one careless afternoon of talk into an execution — and the seats that talk
 * most are the ones trying to help. The cap sits just above the single most
 * damning finding, which says what it is meant to say: the record has caught
 * you, once, and catching you twice does not make it more certain.
 */
export function deductionWeight(found: readonly Deduction[]): number {
  if (found.length === 0) return 0;
  const total = found.reduce((sum, entry) => sum + WORTH[entry.kind], 0);
  return Math.min(3.2, total);
}

/**
 * The one worth saying out loud, when a seat has been caught more than once.
 *
 * A bot cites a single reason — a paragraph of them reads as a prosecutor
 * rather than a player — so it should be the one the room can check most
 * easily, which is the same ordering as `WORTH`. Ties keep the order they were
 * found in, which is the order they were said in, and that is the one a person
 * following the afternoon would expect.
 */
export function strongest(found: readonly Deduction[]): Deduction | null {
  let best: Deduction | null = null;
  for (const entry of found) {
    if (!best || WORTH[entry.kind] > WORTH[best.kind]) best = entry;
  }
  return best;
}

/**
 * The count a seat can only do because it knows what it is itself.
 *
 * Everything above this line reads the public board, which is right: a finding
 * the room cannot check is a finding a bot must not say out loud as though it
 * could. But there is one fact every seat holds that the board does not, and it
 * is the single most useful fact at the table — its own badge. The roster
 * arithmetic was run over the identified dead and the living *claims*, and the
 * observer's own role was seated nowhere, so a real Sheriff listening to
 * somebody else claim Sheriff had to work out from public evidence what it
 * already knew for certain.
 *
 * The method is the double count the question asks for. Run the same deduction
 * pass twice: once over the board as it stands, and once over a board where the
 * observer has claimed its own real badge. Anything that appears only in the
 * second run is true, is not derivable from what has been said, and is exactly
 * what this seat knows and nobody else does. In the common case that is "there
 * is no room left for your Sheriff, because I am the Sheriff"; in the wider one
 * it is a slot the roster had left open and the observer's badge has just
 * spent.
 *
 * Seated by *pretending the observer claimed it*, rather than by threading a
 * second parameter through the whole pass, because those are the same statement
 * and the first costs nothing: every count here already knows how to weigh a
 * living seat's claim. It also gets the honesty right. Announcing one of these
 * means claiming the badge out loud, and the board the bot reasons from is then
 * the board the room will actually have.
 *
 * Nothing is returned when the observer has already claimed its badge in
 * public, because then the two runs are the same run and there is no private
 * knowledge left to spend.
 */
export function privateFindings(
  mine: { slot: number; role: RoleId },
  info: PublicInfo
): { slot: number; found: Deduction[] }[] {
  const spokenAlready = info.claims.some(
    (claim) => claim.kind === 'role-claim' && claim.claimerSlot === mine.slot && claim.claimedRole === mine.role
  );
  if (spokenAlready) return [];

  const seated: PublicInfo = {
    ...info,
    claims: [
      ...info.claims,
      {
        kind: 'role-claim',
        claimerSlot: mine.slot,
        targetSlot: mine.slot,
        claimedRole: mine.role,
        day: info.day,
        truthful: true
      }
    ]
  };

  const out: { slot: number; found: Deduction[] }[] = [];
  for (const slot of info.aliveSlots) {
    if (slot === mine.slot) continue;
    const before = new Set(deductions(slot, info).map((entry) => JSON.stringify(entry)));
    const after = deductions(slot, seated).filter((entry) => !before.has(JSON.stringify(entry)));
    if (after.length > 0) out.push({ slot, found: after });
  }
  return out;
}
