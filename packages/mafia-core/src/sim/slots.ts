import { familyOf, isSoloKiller, ROLES, roleDef, type RoleId } from '../roles.js';
import { slotPool, type SlotToken } from '../setups.js';

/**
 * What this table can still contain, counted off the list on the wall.
 *
 * The roster is public and every screen prints it, so the town has always been
 * able to do this arithmetic and never could: `rolesInPlay` is the *union* of
 * every category slot's pool, which answers "could a Jester have been dealt"
 * and not "can there still be one". Those come apart the moment a corpse is
 * identified. A roster with one Neutral Benign slot and one Any Role slot can
 * hold a Jester — until the Neutral Benign turns out to have been the Lover and
 * the Any Role turns out to have been a Triad Enforcer, at which point there is
 * no slot left that could hold one and anybody claiming the badge is claiming
 * something the room can disprove from two screens it is already looking at.
 *
 * Which is exactly what happened. On a real table a cornered Mafioso claimed
 * Jester on day four, with both of those corpses in the ground and named, and
 * the only seat who could say so was a person typing it by hand: "any role was
 * enforcer and a jester is already dead". The bots could neither make the
 * deduction nor avoid walking into it — `burnedFaces` was choosing masks off
 * the same over-generous set, so the liar picked a face that could not exist
 * and the room had no way to answer.
 *
 * The question is a matching problem and is answered as one. Each dealt slot is
 * a token with a pool of roles it could have rolled; each identified corpse
 * consumes one slot whose pool contains what it turned out to be. A role is
 * still possible when the identified dead can be assigned to slots in some way
 * that leaves a slot containing that role unassigned. Twenty-four slots and one
 * augmenting path per question, which is nothing.
 *
 * Generous wherever it is unsure, on purpose, because the cost of being wrong
 * here is calling an honest claim a lie:
 *
 *  - an unknown roster allows everything;
 *  - a corpse the game refused to identify consumes no slot;
 *  - and every role the game can *hand out after the deal* is allowed whatever
 *    the slots say. Roles move: a family promotes an heir to the knife, the
 *    lodge initiates, the cult converts, an Amnesiac remembers somebody in the
 *    ground, an Auditor rewrites a badge, and a widowed Executioner grieves
 *    into motley — which is the one that matters most here, since it is how a
 *    Jester appears at a table that never dealt one.
 */

/**
 * Roles the game hands out after the deal, and what each one comes from.
 *
 * Read off the engine's own mutations rather than reasoned about: every line
 * here is a place `player.role` is assigned outside `rollSetup`. The Amnesiac
 * is the exception that cannot be listed, because what it remembers is
 * whatever is in the ground, so it is handled separately below.
 */
const BECOMES: Partial<Record<RoleId, RoleId[]>> = {
  // A widowed executioner grieves into motley.
  executioner: ['jester'],
  // The lodge promotes when it has no master, and initiates ordinary town.
  mason: ['mason-leader'],
  'mason-leader': ['mason'],
  // An audit rewrites the badge it reads.
  auditor: ['scumbag'],
  // The cult promotes an heir when its preacher dies.
  'witch-doctor': ['cultist'],
  cultist: ['witch-doctor']
};

/** Whether this role can be reached by conversion from somewhere in the flock. */
const CONVERTS_TO: readonly RoleId[] = ['cultist', 'witch-doctor', 'mason'];

/**
 * The knife a family falls back on when its leader dies.
 *
 * Succession promotes an heir to whatever the family's killing role is, so a
 * seat can be wearing a badge its own slot never rolled. Derived from the
 * roster rather than listed, so a family that is not at this table promotes
 * nobody.
 */
function knivesOf(faction: string): RoleId[] {
  return (Object.keys(ROLES) as RoleId[]).filter(
    (role) => roleDef(role).faction === faction && roleDef(role).nightAction === 'kill'
  );
}

/**
 * Maximum matching between identified corpses and the slots that could hold
 * them, with one extra role asked for on the side.
 *
 * Returns whether every corpse *and* the extra role can be seated at once,
 * which is the whole question: if they can, some deal consistent with
 * everything the room knows still leaves room for that role.
 */
function seats(pools: readonly ReadonlySet<RoleId>[], wanted: readonly RoleId[]): boolean {
  /** Which slot each role took, by index into `wanted`. */
  const takenBy = new Array<number>(pools.length).fill(-1);

  const place = (index: number, seen: boolean[]): boolean => {
    for (let slot = 0; slot < pools.length; slot++) {
      if (seen[slot] || !pools[slot].has(wanted[index])) continue;
      seen[slot] = true;
      if (takenBy[slot] === -1 || place(takenBy[slot], seen)) {
        takenBy[slot] = index;
        return true;
      }
    }
    return false;
  };

  for (let index = 0; index < wanted.length; index++) {
    if (!place(index, new Array<boolean>(pools.length).fill(false))) return false;
  }
  return true;
}

/**
 * Every role this table can still contain, given what the graveyard has named.
 *
 * `revealed` is the identified dead only. A cleaned corpse or a body the reveal
 * policy kept quiet is not in it, and consumes nothing.
 */
export function possibleRoles(roleSlots: readonly SlotToken[], revealed: readonly RoleId[]): Set<RoleId> {
  const every = Object.keys(ROLES) as RoleId[];
  if (roleSlots.length === 0) return new Set(every);

  const pools = roleSlots.map((token) => new Set(slotPool(token)));
  const known = revealed.filter((role) => role in ROLES);

  /**
   * A graveyard the deal cannot explain, which means the deal is not the whole
   * story any more.
   *
   * Two cultists in the ground on a roster with one cult slot is not a
   * contradiction, it is a conversion — and the same goes for an initiated
   * mason, a promoted heir, a remembered badge and a rewritten one. When the
   * corpses no longer fit the slots, the slots have stopped being able to prove
   * anything, and the honest answer to every question below is "possibly".
   */
  if (!seats(pools, known)) return new Set(every);

  const possible = new Set<RoleId>();
  for (const role of every) if (seats(pools, [...known, role])) possible.add(role);

  /**
   * And then everything the game can turn one of those into.
   *
   * Run to a fixed point, because the chains are real: a slot that could be an
   * Executioner can become a Jester, and a Mason can become a Mason Leader who
   * can initiate somebody who can become a Mason Leader in turn.
   */
  const reachable = new Set<RoleId>(possible);
  for (let pass = 0; pass < 4; pass++) {
    const before = reachable.size;
    for (const role of [...reachable]) {
      for (const after of BECOMES[role] ?? []) reachable.add(after);
      // A family that exists can promote an heir to its own knife.
      const faction = role in ROLES ? roleDef(role).faction : null;
      if (faction === 'mafia' || faction === 'triad') for (const knife of knivesOf(faction)) reachable.add(knife);
      // A cult or a lodge that exists can grow, and what it grows are these.
      if (faction === 'cult') for (const grown of CONVERTS_TO) reachable.add(grown);
      if (role === 'mason-leader') reachable.add('mason');
      /**
       * And an Amnesiac takes a badge out of the ground.
       *
       * Whatever is buried can walk again, so every identified corpse's role
       * comes back into play the moment one is possible. The most generous line
       * in here and the one most likely to matter: it is also the only way a
       * role the slots have fully accounted for can honestly be claimed again.
       */
      if (role === 'amnesiac') for (const buried of known) reachable.add(buried);
    }
    if (reachable.size === before) break;
  }

  for (const role of reachable) possible.add(role);
  return possible;
}

/**
 * How many blades this table was dealt, read off the same list.
 *
 * The parity clock is the town's entire sense of how much time it has, and it
 * was a guess: thirty per cent of the seats, rounded, whatever the roster
 * actually said. On a table dealt four mafia, one triad and two neutral killers
 * that guess is four when the answer is seven, and a town that thinks it has
 * two spare days when it has none plays the whole midgame at the wrong speed.
 *
 * The list on the wall answers it exactly, and a person reading that list does
 * this arithmetic on the first morning — which is the whole of what "endgame
 * reasoning from day two" turns out to mean. A pinned slot is a known quantity;
 * a category slot is known only as far as its pool goes, so this comes back as
 * a range and never as a number pretending to be one:
 *
 *  - `sure` counts the slots whose every possible roll is a killer. A Godfather
 *    slot, a Mafia Deception slot, a Neutral Killing slot: whatever they rolled,
 *    somebody at this table is holding a knife for it.
 *  - `possible` also counts the slots that merely *might* have been one. A
 *    Neutral Benign slot is not a killer and a Neutral Random slot might be; Any
 *    Role might be anything.
 *  - `expected` is the one to read, and it is the number a player reaches
 *    without calling it arithmetic: a slot that could be six things of which two
 *    are knives is worth a third of a knife. Splitting the difference between
 *    the two bounds instead read every Random Neutral as half a killer, which is
 *    roughly double what that pool holds.
 *
 * The Cult is counted with the knives. It does not kill every night, but it
 * takes seats off the town's side one at a time, which is the same clock.
 */
export function bladesDealt(roleSlots: readonly SlotToken[]): {
  sure: number;
  possible: number;
  expected: number;
} {
  let sure = 0;
  let possible = 0;
  let expected = 0;
  for (const token of roleSlots) {
    const pool = slotPool(token).filter((role) => role in ROLES);
    if (pool.length === 0) continue;
    const blades = pool.filter(
      (role) => familyOf(role) !== null || isSoloKiller(role) || roleDef(role).faction === 'cult'
    );
    if (blades.length === pool.length) sure++;
    if (blades.length > 0) possible++;
    expected += blades.length / pool.length;
  }
  return { sure, possible, expected };
}
