import type { ItemKind, Rarity, WeaponStats } from '../data.js';

/**
 * The canonical names the rules use, so a biome can replace all the content.
 *
 * A **role** is a job an item does — the thing you swing, the sidearm, the
 * marksman's rifle. A **archetype** is a job a creature does — the shambler, the
 * runner, the boss that breeds. Every rule that used to name a specific item or
 * zombie now names one of these, and a biome says what fills it.
 *
 * This layer exists because "each biome brings its own weapons and enemies" breaks
 * the game without it: twenty survivors name their favourite weapon by id
 * (`favoriteWeapon: 'sniper'`), four loadout perks hand out a specific pistol or
 * machete, and ten game-master classes discount a specific zombie. In a steampunk
 * raid none of those ids exist. Roles and archetypes are how Charles can be a
 * marksman in a world that has never heard of a sniper rifle.
 *
 * Two rules keep it honest, and both are enforced by tests:
 *
 * 1. **A role owns its tier and its power budget.** The loot curve — what turns up
 *    when — belongs to the game, not to the biome. A biome may shape a weapon's
 *    stats (dice against damage against accuracy) but not its expected damage.
 * 2. **An archetype owns its stats.** Hit points, action points, damage, points and
 *    cost are identical in every biome, because the threat curve is the spine of
 *    the whole balance. A biome gives a creature its name, its face and its
 *    behaviour flags, and that is identity enough.
 */

/* ---------------------------------- items ---------------------------------- */

export type WeaponRole =
  /** The blunt thing everyone starts with. */
  | 'club'
  /** Light, sharp, and paired: the akimbo melee. */
  | 'blade'
  /** Slow, accurate melee. */
  | 'pick'
  /** Loud, brutal, close-range melee. */
  | 'saw'
  /** The sidearm: paired, cheap, everywhere. */
  | 'sidearm'
  /** Close-range spread. */
  | 'scatter'
  /** Many dice, short reach. */
  | 'smg'
  /** The all-rounder at range. */
  | 'rifle'
  /** One heavy shot. */
  | 'magnum'
  /** The long shot. */
  | 'marksman'
  /** The room-clearer. */
  | 'flamer'
  /** The last word. */
  | 'chaingun';

export type GearRole =
  /** Absorbs one attack. */
  | 'vest'
  /** A free search per turn. */
  | 'torch'
  /** Heals. */
  | 'medkit'
  /** Buys action points. */
  | 'stim';

export type ItemRole = WeaponRole | GearRole;

export interface RoleDef {
  id: ItemRole;
  kind: ItemKind;
  /** Where it sits in the loot table: the same in every biome. */
  tier: Rarity;
  /** What it is for, in one word, for the UI when no biome is in hand. */
  label: string;
  /**
   * Expected damage of one attack with the reference weapon, in scaled units
   * (dice × chance to hit × damage). Weapons only. A biome's version of this role
   * must land within `POWER_TOLERANCE` of it — that is the whole guard against a
   * new biome quietly shipping a better arsenal than the last.
   */
  power?: number;
}

/** How far a biome's weapon may stray from its role's expected damage. */
export const POWER_TOLERANCE = 0.15;

/** Expected damage of one attack: dice × P(hit) × damage, akimbo ignored. */
export function expectedDamage(weapon: WeaponStats): number {
  return weapon.dice * ((7 - weapon.accuracy) / 6) * weapon.damage;
}

/**
 * The roles, with the tiers and power budgets taken from the 2020 table — which is
 * to say: the modern biome is the reference, and it was the reference before it had
 * a name.
 */
export const ITEM_ROLES: readonly RoleDef[] = [
  { id: 'club', kind: 'weapon', tier: 1, label: 'Arme contondante', power: 6.67 },
  { id: 'blade', kind: 'weapon', tier: 1, label: 'Lame', power: 13.33 },
  { id: 'pick', kind: 'weapon', tier: 1, label: 'Arme perforante', power: 8.33 },
  { id: 'saw', kind: 'weapon', tier: 2, label: 'Arme lourde de mêlée', power: 33.33 },
  { id: 'sidearm', kind: 'weapon', tier: 2, label: 'Arme de poing', power: 10 },
  { id: 'scatter', kind: 'weapon', tier: 2, label: 'Tir en gerbe', power: 20 },
  { id: 'smg', kind: 'weapon', tier: 3, label: 'Automatique', power: 33.33 },
  { id: 'rifle', kind: 'weapon', tier: 3, label: 'Fusil', power: 30 },
  { id: 'magnum', kind: 'weapon', tier: 4, label: 'Gros calibre', power: 26.67 },
  { id: 'marksman', kind: 'weapon', tier: 4, label: 'Tir de précision', power: 20 },
  { id: 'flamer', kind: 'weapon', tier: 5, label: 'Arme de zone', power: 100 },
  { id: 'chaingun', kind: 'weapon', tier: 5, label: 'Arme rotative', power: 33.33 },

  { id: 'vest', kind: 'gear', tier: 3, label: 'Protection' },
  { id: 'torch', kind: 'gear', tier: 2, label: 'Éclairage' },
  { id: 'medkit', kind: 'gear', tier: 2, label: 'Soins' },
  { id: 'stim', kind: 'gear', tier: 3, label: 'Stimulant' }
];

export const WEAPON_ROLES = ITEM_ROLES.filter((role) => role.kind === 'weapon').map((role) => role.id);

export function roleDef(id: ItemRole): RoleDef {
  const found = ITEM_ROLES.find((role) => role.id === id);
  if (!found) throw new Error(`Unknown item role: ${id}`);
  return found;
}

/* --------------------------------- creatures -------------------------------- */

export type ZombieArchetype =
  'walker' | 'runner' | 'horror' | 'fatty' | 'mutant' | 'screamer' | 'brute' | 'colossus' | 'abomination';

export interface ArchetypeDef {
  id: ZombieArchetype;
  hp: number;
  ap: number;
  damage: number;
  /** Points a kill is worth. */
  points: number;
  /** What the game master pays to field one. */
  cost: number;
  /** Same colour language as the loot: grey shambler, golden abomination. */
  rarity: Rarity;
  /** Counts for "kill a boss" objectives, and is announced when it arrives. */
  boss?: boolean;
  /** Spawns one of these in its own room each time it activates. */
  summons?: ZombieArchetype;
  /** For the game master's shop and the log, when no biome is in hand. */
  label: string;
}

/**
 * The bestiary's skeleton: the 2020 stat block, unchanged, and unchangeable per
 * biome. Every simulated win rate in the documentation hangs off these numbers.
 */
export const ARCHETYPES: readonly ArchetypeDef[] = [
  { id: 'walker', hp: 10, ap: 1, damage: 10, points: 1, cost: 1, rarity: 1, label: 'Traînard' },
  { id: 'runner', hp: 10, ap: 2, damage: 10, points: 2, cost: 2, rarity: 2, label: 'Coureur' },
  { id: 'horror', hp: 20, ap: 2, damage: 10, points: 2, cost: 2, rarity: 2, label: 'Horreur' },
  { id: 'fatty', hp: 40, ap: 1, damage: 10, points: 3, cost: 3, rarity: 3, label: 'Masse' },
  { id: 'mutant', hp: 30, ap: 2, damage: 20, points: 4, cost: 4, rarity: 3, label: 'Mutant' },
  {
    id: 'screamer',
    hp: 30,
    ap: 2,
    damage: 10,
    points: 6,
    cost: 6,
    rarity: 4,
    boss: true,
    summons: 'walker',
    label: 'Invocateur'
  },
  { id: 'brute', hp: 70, ap: 2, damage: 20, points: 8, cost: 7, rarity: 4, boss: true, label: 'Brute' },
  { id: 'colossus', hp: 100, ap: 1, damage: 20, points: 10, cost: 8, rarity: 5, boss: true, label: 'Colosse' },
  {
    id: 'abomination',
    hp: 150,
    ap: 1,
    damage: 30,
    points: 15,
    cost: 12,
    rarity: 5,
    boss: true,
    label: 'Abomination'
  }
];

export function archetypeDef(id: ZombieArchetype): ArchetypeDef {
  const found = ARCHETYPES.find((archetype) => archetype.id === id);
  if (!found) throw new Error(`Unknown archetype: ${id}`);
  return found;
}
