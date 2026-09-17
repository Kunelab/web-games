import { ROLES, roleDef, type RoleId } from '../roles.js';
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
  'guarded-nobody-died': 2.5,
  'acted-from-the-cell': 2.5,
  'role-not-in-play': 3,
  'broken-promise': 2.5,
  'poison-survived': 2,
  'impossible-ailment': 2,
  'relay-denied': 1.5,
  'two-in-one-cell': 1.2
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
  const causes = CAUSED_BY[ailment];
  if (!causes || !info.rolesInPlay) return false;
  const known = causes.filter((role) => role in ROLES);
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

  const alive = info.aliveSlots.includes(slot);

  for (const claim of mine) {
    const night = nightOf(claim);

    if (claim.kind === 'account' && claim.account === 'visited' && buriedBefore(claim.targetSlot, night, info)) {
      found.push({ kind: 'visited-a-corpse', night, otherSlot: claim.targetSlot });
    }

    if (
      claim.kind === 'role-claim' &&
      claim.claimedRole &&
      info.rolesInPlay &&
      !info.rolesInPlay.has(claim.claimedRole)
    ) {
      found.push({ kind: 'role-not-in-play', role: claim.claimedRole });
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
          info.aliveSlots.includes(claim.relayedFrom!)
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
      const delivered = info.claims.some(
        (other) =>
          other.claimerSlot === slot &&
          other.day > claim.day &&
          (other.kind === 'accuse' ||
            other.kind === 'clear' ||
            other.kind === 'sighting' ||
            other.kind === 'hint' ||
            other.kind === 'account' ||
            other.kind === 'role-claim')
      );
      if (info.day > claim.day && !delivered && !info.provenRoles.has(slot)) {
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
