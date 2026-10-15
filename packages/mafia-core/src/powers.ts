import type { DeathSource } from './messages.js';
import { familyOf, roleDef, type NightActionType, type RoleId } from './roles.js';

/**
 * The powers worked without stepping out: the porch, the vest, the slab, the
 * cell and the memory.
 *
 * The engine's movement pass and every alibi the bots weigh read this one list.
 * An autopsy is performed on a slab, not on a doorstep; a keeper works the cell
 * from his own house; the Amnesiac remembers a corpse from his chair. None of
 * them is a journey any watcher sees, and a seat claiming one of these badges
 * that was seen at a living door was somewhere else doing something else.
 */
export const HOMEBOUND: ReadonlySet<NightActionType> = new Set<NightActionType>([
  'alert',
  'vest',
  'autopsy',
  'jail-execute',
  'remember'
]);

/**
 * Does this role spend its nights at home?
 *
 * A Veteran sits on his porch with a rifle and a Survivor puts on a vest; a role
 * with no night action at all does not get up either. Nobody wearing one of these
 * badges can honestly say they were at somebody else's door, which matters most
 * to the seats that are lying: a Witch bluffing Veteran answered "where were
 * you" with the truth — it had been out controlling somebody — and told the room
 * it had been turning a house over while claiming the one role that never leaves
 * its own. A bluff has to be consistent with itself or it is not a bluff, it is
 * a confession with extra steps.
 */
export function staysHome(role: RoleId): boolean {
  const action = roleDef(role).nightAction;
  return action === null || HOMEBOUND.has(action);
}

/**
 * How hard each weapon hits, by the name the dawn report signs it with.
 *
 * Read against `ARMOUR`: a strike of 1 is stopped by any armour, 2 goes through
 * all of it but an alerted porch, 3 through everything. The night pushes these
 * and the endgame weighs them, from this one table: a rule that guessed "a
 * killer kills" would hand the arsonist's win to the mass murderer standing in
 * front of a night-immune seat he can never touch.
 */
export const STRIKE = {
  mafia: 1,
  triad: 1,
  vigilante: 1,
  serialKiller: 1,
  massMurderer: 1,
  poison: 2,
  veteran: 2,
  arsonist: 3,
  electromaniac: 3,
  jailor: 3,
  kidnapper: 3
} as const satisfies Partial<Record<DeathSource, number>>;

export type Weapon = keyof typeof STRIKE;

/** What a seat wears against a strike tonight. */
export const ARMOUR = { immune: 1, vest: 1, alert: 2 } as const;

/** The strongest strike a heal or a guard can still stop: the fire and the cell are beyond them. */
export const SAVEABLE_STRIKE = 2;

/**
 * Poison is already inside: armour is irrelevant to it. A doctor's purge is not,
 * which is why its strike stays at 2 rather than going through everything.
 */
export function piercesArmour(weapon: DeathSource): boolean {
  return weapon === 'poison';
}

/** The weapon a role's own night swings, or null for a role that never kills. */
export function weaponOf(role: RoleId): Weapon | null {
  switch (role) {
    case 'vigilante':
      return 'vigilante';
    case 'serial-killer':
      return 'serialKiller';
    case 'mass-murderer':
      return 'massMurderer';
    case 'arsonist':
      return 'arsonist';
    case 'poisoner':
      return 'poison';
    case 'electromaniac':
      return 'electromaniac';
  }
  const action = roleDef(role).nightAction;
  if (action === 'jail-execute') return role === 'jailor' ? 'jailor' : 'kidnapper';
  if (action === 'alert') return 'veteran';
  if (action === 'kill') {
    const family = familyOf(role);
    if (family === 'mafia' || family === 'triad') return family;
  }
  return null;
}

/**
 * What a role's worst night can put through a door, for the endgame's
 * arithmetic: its weapon's strike, or past any armour for a weapon that
 * ignores armour.
 */
export function effectiveStrikeOf(role: RoleId): number {
  const weapon = weaponOf(role);
  if (weapon === null) return 0;
  return piercesArmour(weapon) ? ARMOUR.alert + 1 : STRIKE[weapon];
}
