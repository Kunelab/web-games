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

/**
 * The things that are not weapons, and there are now nine of them rather than four.
 *
 * Four was too few in a way the loot table made structural rather than merely dull:
 * candidates are filtered by tier, so with gear only at tiers 2 and 3, **tiers 1, 4
 * and 5 could not produce a single piece of it**. Every early find was a weapon you
 * already had a better version of, and every late find was a weapon or nothing.
 *
 * The fix is a ladder per job instead of one item per job:
 *
 *  - **armour** at three rungs (`rags` 1, `vest` 3, `plate` 6) rather than one, so
 *    the stat that decides how long a survivor lives is something you improve all
 *    raid instead of a coin flip on whether the vest turned up.
 *  - **healing** at two (`bandage` 8, `medkit` 18), so the bottom of the table can
 *    still answer a wound.
 *  - **two new verbs**, because more of the same is not diversity: a `grenade`
 *    hits every creature in the room at once, and `smoke` wipes the noise off your
 *    room and the ones beside it, so the horde loses the trail.
 *
 * Both new verbs reuse machinery the game already has — the damage path a weapon
 * uses, and the noise map the horde already homes in on — rather than inventing a
 * system. A consumable that needed its own targeting screen would cost more than it
 * adds.
 *
 * Tier 5 is left as weapons only, on purpose. The documentation is explicit that
 * whether a tier-5 turns up is the single biggest swing in a raid, and putting gear
 * in that pool would dilute the one find the whole escalation curve is built around.
 */
export type GearRole =
  /** Flat damage reduction, the light rung. */
  | 'rags'
  /** Flat damage reduction, the middle rung: the classic vest. */
  | 'vest'
  /** Flat damage reduction, the heavy rung. */
  | 'plate'
  /** A free search per turn. */
  | 'torch'
  /** Heals a little, and turns up early. */
  | 'bandage'
  /** Heals. */
  | 'medkit'
  /** Buys action points. */
  | 'stim'
  /** Consumable: hurts every creature in the room at once. */
  | 'grenade'
  /** Consumable: erases the noise here and next door; the horde loses the trail. */
  | 'smoke';

export type ItemRole = WeaponRole | GearRole;

export interface RoleDef {
  id: ItemRole;
  kind: ItemKind;
  /** Where it sits in the loot table: the same in every biome. */
  tier: Rarity;
  /** What it is for, in one word, for the UI when no biome is in hand. */
  /** Catalogue key: what this job is called on a screen. */
  label: string;
  /**
   * Expected damage of one attack with the reference weapon, in scaled units
   * (dice × chance to hit × damage). Weapons only. A biome's version of this role
   * must land within `POWER_TOLERANCE` of it — that is the whole guard against a
   * new biome quietly shipping a better arsenal than the last.
   */
  power?: number;
  /**
   * Held in one hand and occupying both: no off-hand while this is out.
   *
   * On the role rather than on the biome's stat block, for the same reason `tier`
   * and `power` are: it is a *cost*, and costs belong to the game. A biome may
   * decide that its room-clearer is a flamethrower or an arc projector, but not
   * that its version of the room-clearer leaves a hand free — that would be a
   * biome shipping a strictly better arsenal, which is the thing this layer exists
   * to prevent.
   *
   * Which six are marked is the honest reading of what they are. You do not fire a
   * minigun, a combat shotgun, an assault rifle, a sniper rifle, a flamethrower or
   * a running chainsaw one-handed, and until now the game let you hold two of them
   * at once. It also gives the loadout screen a decision it never had: every
   * two-hander is tier 2 or better and every one-hander below tier 4 is cheap, so
   * "one big thing" against "two small things" is finally a question with two
   * defensible answers rather than a formality.
   */
  twoHanded?: boolean;
}

/** How far a biome's weapon may stray from its role's expected damage. */
export const POWER_TOLERANCE = 0.15;

/**
 * Expected damage of one attack.
 *
 * Every weapon connects now (accuracy 1 across the table), so this is simply dice
 * × damage and the hit-chance term is 1. It is kept as a function of the stats
 * rather than inlined because it is the one definition the power budgets, the
 * bots' weapon scoring and the ladder test all have to agree on.
 */
export function expectedDamage(weapon: WeaponStats): number {
  return weapon.dice * ((7 - weapon.accuracy) / 6) * weapon.damage;
}

/**
 * The roles, their tiers, and the expected damage each one is worth.
 *
 * These were the 2020 table's numbers until a playtest said the epic weapons felt
 * like junk. They were: measured per attack, tier 4 averaged 23.3 against tier 3's
 * 31.7, so a Desert Eagle lost to an AK and a sniper rifle (20.0) lost to an
 * *uncommon* chainsaw (33.3). Ten pairs were inverted, and tier 5 was a
 * flamethrower at 100 next to a minigun at 33.
 *
 * The ladder is monotone by construction (every tier's weakest weapon beats the
 * tier below's strongest, and a test proves it) and it is now **compressed**:
 *
 *   T1 = 14-24   T2 = 33-36   T3 = 45-48   T4 = 56-58   T5 = 70-72
 *
 * The top used to be twelve times the bottom (a flamethrower at 120 against a bat
 * at 10), which made the whole evening a lottery on whether a tier-5 turned up: the
 * bench measured a 57-point spread in win rate between a table forced to open well
 * and one forced to open badly, on the same preset. Five times the bottom still
 * reads as an arsenal, and the gap between finding a minigun and not finding one is
 * survivable.
 *
 * Reach is paid for out of the same budget rather than by halving it: a sniper is a
 * big single shot that needs a line, not a worse rifle. Armour-piercing is likewise
 * part of the budget, not a bonus on top: the pick, the chainsaw, the magnum and
 * the marksman rifle halve armour, which is most of what a tier-4 single shot is
 * *for*.
 */
export const ITEM_ROLES: readonly RoleDef[] = [
  { id: 'club', kind: 'weapon', tier: 1, label: 'coronaz.role.club', power: 14 },
  { id: 'blade', kind: 'weapon', tier: 1, label: 'coronaz.role.blade', power: 24 },
  { id: 'pick', kind: 'weapon', tier: 1, label: 'coronaz.role.pick', power: 22 },
  { id: 'saw', kind: 'weapon', tier: 2, label: 'coronaz.role.saw', power: 36, twoHanded: true },
  { id: 'sidearm', kind: 'weapon', tier: 2, label: 'coronaz.role.sidearm', power: 33 },
  { id: 'scatter', kind: 'weapon', tier: 2, label: 'coronaz.role.scatter', power: 34, twoHanded: true },
  { id: 'smg', kind: 'weapon', tier: 3, label: 'coronaz.role.smg', power: 48 },
  { id: 'rifle', kind: 'weapon', tier: 3, label: 'coronaz.role.rifle', power: 45, twoHanded: true },
  { id: 'magnum', kind: 'weapon', tier: 4, label: 'coronaz.role.magnum', power: 56 },
  { id: 'marksman', kind: 'weapon', tier: 4, label: 'coronaz.role.marksman', power: 58, twoHanded: true },
  { id: 'flamer', kind: 'weapon', tier: 5, label: 'coronaz.role.flamer', power: 70, twoHanded: true },
  { id: 'chaingun', kind: 'weapon', tier: 5, label: 'coronaz.role.chaingun', power: 72, twoHanded: true },

  { id: 'rags', kind: 'gear', tier: 1, label: 'coronaz.role.rags' },
  { id: 'bandage', kind: 'gear', tier: 1, label: 'coronaz.role.bandage' },
  { id: 'torch', kind: 'gear', tier: 2, label: 'coronaz.role.torch' },
  { id: 'medkit', kind: 'gear', tier: 2, label: 'coronaz.role.medkit' },
  { id: 'grenade', kind: 'gear', tier: 2, label: 'coronaz.role.grenade' },
  { id: 'vest', kind: 'gear', tier: 3, label: 'coronaz.role.vest' },
  { id: 'stim', kind: 'gear', tier: 3, label: 'coronaz.role.stim' },
  { id: 'smoke', kind: 'gear', tier: 3, label: 'coronaz.role.smoke' },
  { id: 'plate', kind: 'gear', tier: 4, label: 'coronaz.role.plate' }
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
  /**
   * Flat reduction on every hit taken, before the minimum of 1. Halved (rounded
   * down) by a weapon with `pierce`.
   */
  armor: number;
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
  /**
   * Chance, each enemy phase, that this creature wakes up with one extra point.
   *
   * The shambler's only trick, and deliberately the only one that has it. A walker
   * with one point is the most predictable thing on the board — one room, or one
   * bite, never both — and a survivor standing two rooms away is doing arithmetic
   * that is always right. One time in twenty it is wrong, which is enough to make
   * "just out of reach" a judgement rather than a calculation, and cheap enough at
   * 5 % that it never becomes the thing that kills a raid.
   *
   * Rolled per creature per phase, so a room of six walkers is a real risk rather
   * than a rounding error, and never stacks with the Tracker's noise bonus into
   * more than one extra point.
   */
  surgeChance?: number;
  /** For the game master's shop and the log, when no biome is in hand. */
  label: string;
}

/**
 * The bestiary's skeleton: unchangeable per biome, because every simulated win
 * rate in the documentation hangs off these numbers.
 *
 * Two things changed from the 2020 stat block, for one reason. Every value used to
 * be a multiple of ten, and once weapons stopped missing that made damage a
 * threshold instead of a quantity: any weapon hitting for 10 or more killed a
 * walker outright, so a baseball bat and a sniper rifle were the same weapon
 * against the two commonest creatures on the board, and the sniper threw 88 % of
 * its damage in the bin. So:
 *
 * 1. **The grid is gone.** Hit points are 9, 11, 21, 28, 32, 46, 76, 112, 165. Same
 *    scale, same ratios to within a few percent, but overkill is no longer total
 *    and a rank of rarity is no longer the difference between one shot and two.
 * 2. **Armour exists.** A flat reduction on every single hit, which is the stat
 *    that gives a heavy weapon its job back: five dice of 12 against a colossus
 *    (armour 9) deliver 15, one shot of 58 delivers 49. Crowd weapons answer
 *    crowds, heavy weapons answer armour, and a two-handed loadout finally has to
 *    choose. A hit always does at least 1, so armour makes a weapon bad, never
 *    useless.
 */
/**
 * …and one more thing, added after a season of play: the rank and file were too
 * soft for an arsenal that had meanwhile been compressed and given armour-piercing.
 *
 * Every non-boss creature carries **+5 hit points and +1 armour** over the numbers
 * above. The armour is the load-bearing half. Three of the five had none at all, so
 * a six-dice crowd weapon deleted a room of them at no cost and the "crowd weapons
 * answer crowds, heavy weapons answer armour" trade only ever applied to bosses.
 * One point of armour off every die is close to nothing for a magnum and a great
 * deal for a minigun, which is exactly the asymmetry that was missing. Hit points
 * went up alongside it so the change reads as a tougher horde rather than purely as
 * a nerf to one class of weapon.
 *
 * Bosses and mini-bosses take **+10 %** hit points instead, rounded. They already
 * had armour, so what they needed was the extra beat of survival that keeps a boss
 * fight a fight — and a flat +5 would have been invisible on a creature with 148.
 */
export const ARCHETYPES: readonly ArchetypeDef[] = [
  { id: 'walker', hp: 14, ap: 1, damage: 10, points: 1, cost: 1, rarity: 1, armor: 1, surgeChance: 0.05, label: 'Traînard' },
  { id: 'runner', hp: 16, ap: 2, damage: 10, points: 2, cost: 2, rarity: 2, armor: 1, label: 'Coureur' },
  { id: 'horror', hp: 24, ap: 2, damage: 10, points: 2, cost: 2, rarity: 2, armor: 1, label: 'Horreur' },
  { id: 'fatty', hp: 47, ap: 1, damage: 10, points: 3, cost: 3, rarity: 3, armor: 3, label: 'Masse' },
  { id: 'mutant', hp: 34, ap: 2, damage: 20, points: 4, cost: 4, rarity: 3, armor: 2, label: 'Mutant' },
  {
    id: 'screamer',
    hp: 30,
    ap: 2,
    damage: 10,
    points: 6,
    cost: 6,
    rarity: 4,
    armor: 0,
    boss: true,
    summons: 'walker',
    label: 'Invocateur'
  },
  { id: 'brute', hp: 75, ap: 2, damage: 21, points: 8, cost: 7, rarity: 4, armor: 3, boss: true, label: 'Brute' },
  { id: 'colossus', hp: 108, ap: 1, damage: 22, points: 10, cost: 8, rarity: 5, armor: 4, boss: true, label: 'Colosse' },
  {
    id: 'abomination',
    hp: 163,
    ap: 1,
    damage: 30,
    points: 15,
    cost: 12,
    rarity: 5,
    armor: 6,
    boss: true,
    label: 'Abomination'
  }
];

export function archetypeDef(id: ZombieArchetype): ArchetypeDef {
  const found = ARCHETYPES.find((archetype) => archetype.id === id);
  if (!found) throw new Error(`Unknown archetype: ${id}`);
  return found;
}
