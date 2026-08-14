/**
 * The game's content: the survivors, the perks, the game master's classes — and
 * the definitions of what an item and a creature *are*.
 *
 * The items and creatures themselves are not here any more. They belong to a
 * **biome** (`content/biomes/`), because a raid can be set in a different world
 * with a different arsenal and a different bestiary, and the rules reach them
 * through *roles* and *archetypes* rather than by name. What stays here is
 * everything a biome does not change: who the survivors are, what their abilities
 * do, and the shape of an item.
 *
 * Values ported from the 2020 MySQL dump where one exists there (weapon table,
 * zombie stats, rarity weights) and completed where the original had data but no
 * rule (abilities, kill points, loadout perks).
 *
 * All HP and damage are ×10 versus the board game's printout (a pistol hits for
 * 10, a walker has 10 HP). Pure renumbering — every ratio is identical, the
 * simulator's win rates cannot move because of it — but flat bonuses become
 * legible ("+10 PV" reads; "+1 PV" reads like a rounding error) and it leaves
 * headroom for finer-grained effects later.
 */

import { allItems, allZombies } from './content/registry.js';
import type { ItemRole } from './content/roles.js';

export const STAT_SCALE = 10;

/* --------------------------------- heroes --------------------------------- */

export type HeroAbility =
  /** Ranged attacks reroll one missed die. */
  | 'marksman'
  /** +1 die in melee. */
  | 'assassin'
  /** First search each turn is free. */
  | 'scavenger'
  /** First wound each enemy phase is reduced by 10. */
  | 'tough'
  /** Medkits are free to use and heal 10 more. */
  | 'medic'
  /** First move each turn is free. */
  | 'fleet'
  /** +2 bag slots. */
  | 'mule'
  /** Their attacks never lay noise. */
  | 'silent'
  /** Can attack bare-handed: 1 die, hits on 4+, 10 damage. */
  | 'brawler'
  /** Entering a room also marks its neighbours as explored. */
  | 'scout'
  /** Heals 10 HP on every boss kill. */
  | 'grim'
  /** The first search of the raid yields two items. */
  | 'magpie'
  /** Once per raid, a spent vest survives. */
  | 'bulwark'
  /** Adrenaline shots grant one extra AP. */
  | 'adrenal'
  /** +1 die on every attack while at 20 HP or less. */
  | 'daredevil'
  /** Ranged weapons reach one room further. */
  | 'deadeye'
  /** Every kill is worth one more score point. */
  | 'trophy'
  /** Loot fatigue accrues at half speed. */
  | 'lucky'
  /** Ending the turn with AP left banks one for next turn. */
  | 'tactician'
  /** Starts armed with a pistol, immune to fungus rooms. */
  | 'veteran';

export interface HeroDef {
  id: string;
  name: string;
  hp: number;
  ability: HeroAbility;
  /**
   * The *kind* of weapon this character grew up with: +1 die whenever they fire
   * one. Small, flat, and it gives loot a second question — "is it good" and "is
   * it good FOR ME".
   *
   * A role rather than a weapon, so Charles is a marksman in every world: a raid
   * in a biome that never built a sniper rifle still has something that does that
   * job, and it is his.
   */
  favoriteWeapon: ItemRole;
  /** The three signature perks this character may pick one of. */
  personalPerks: [string, string, string];
  /** One line for the selection screen. */
  blurb: string;
  emoji: string;
  /** Rations to unlock; absent or 0 = part of the base roster. */
  cost?: number;
}

export const HEROES: readonly HeroDef[] = [
  /* ------------------------------ base roster ----------------------------- */
  {
    id: 'charles',
    name: 'Charles',
    hp: 40,
    ability: 'marksman',
    favoriteWeapon: 'marksman',
    personalPerks: ['fetiche', 'discret', 'coriace'],
    blurb: 'Tireur d’élite. Relance un dé raté à distance.',
    emoji: '🎯'
  },
  {
    id: 'johanna',
    name: 'Johanna',
    hp: 40,
    ability: 'assassin',
    favoriteWeapon: 'blade',
    personalPerks: ['fetiche', 'brave', 'nerveux'],
    blurb: 'Ex-assassin. Un dé de plus au corps à corps.',
    emoji: '🗡️'
  },
  {
    id: 'chuck',
    name: 'Chuck',
    hp: 40,
    ability: 'scavenger',
    favoriteWeapon: 'club',
    personalPerks: ['fouineur', 'fetiche', 'lettre'],
    blurb: 'Fouineur. La première fouille du tour est gratuite.',
    emoji: '🎒'
  },
  {
    id: 'yuri',
    name: 'Yuri',
    hp: 50,
    ability: 'tough',
    favoriteWeapon: 'scatter',
    personalPerks: ['vigor', 'fetiche', 'coriace'],
    blurb: 'Marine déchu. Encaisse la première blessure de chaque assaut.',
    emoji: '🛡️'
  },
  {
    id: 'sacha',
    name: 'Sacha',
    hp: 40,
    ability: 'medic',
    favoriteWeapon: 'sidearm',
    personalPerks: ['soigneur', 'fetiche', 'vigor'],
    blurb: 'Médecin de guerre. Soins gratuits, et meilleurs.',
    emoji: '🚑'
  },
  {
    id: 'nadia',
    name: 'Nadia',
    hp: 40,
    ability: 'fleet',
    favoriteWeapon: 'smg',
    personalPerks: ['nerveux', 'fetiche', 'discret'],
    blurb: 'Messagère. Son premier déplacement du tour est gratuit.',
    emoji: '👟'
  },
  {
    id: 'marco',
    name: 'Marco',
    hp: 40,
    ability: 'mule',
    favoriteWeapon: 'chaingun',
    personalPerks: ['fetiche', 'vigor', 'arme'],
    blurb: 'Déménageur. Deux places de sac en plus.',
    emoji: '📦'
  },
  {
    id: 'ines',
    name: 'Inès',
    hp: 40,
    ability: 'silent',
    favoriteWeapon: 'smg',
    personalPerks: ['discret', 'fetiche', 'brave'],
    blurb: 'Silencieuse. Ses attaques ne font jamais de bruit.',
    emoji: '🤫'
  },
  {
    id: 'bernard',
    name: 'Bernard',
    hp: 50,
    ability: 'brawler',
    favoriteWeapon: 'club',
    personalPerks: ['brave', 'vigor', 'coriace'],
    blurb: 'Bagarreur. Se bat à mains nues s’il le faut.',
    emoji: '👊'
  },
  {
    id: 'awa',
    name: 'Awa',
    hp: 40,
    ability: 'scout',
    favoriteWeapon: 'rifle',
    personalPerks: ['fetiche', 'lettre', 'nerveux'],
    blurb: 'Vigie. Repère les salles voisines en passant.',
    emoji: '🔭'
  },

  /* --------------------------- unlockable roster -------------------------- */
  {
    id: 'viktor',
    name: 'Viktor',
    hp: 40,
    ability: 'grim',
    favoriteWeapon: 'pick',
    personalPerks: ['fetiche', 'brave', 'vigor'],
    blurb: 'Croque-mort. Chaque boss abattu lui rend 10 PV.',
    emoji: '⚰️',
    cost: 150
  },
  {
    id: 'lea',
    name: 'Léa',
    hp: 40,
    ability: 'magpie',
    favoriteWeapon: 'magnum',
    personalPerks: ['fouineur', 'fetiche', 'discret'],
    blurb: 'Chapardeuse. Sa première fouille du raid donne deux objets.',
    emoji: '🪶',
    cost: 150
  },
  {
    id: 'omar',
    name: 'Omar',
    hp: 50,
    ability: 'bulwark',
    favoriteWeapon: 'scatter',
    personalPerks: ['vigor', 'coriace', 'fetiche'],
    blurb: 'Rempart. Une fois par raid, son gilet survit à l’impact.',
    emoji: '🧱',
    cost: 200
  },
  {
    id: 'fatou',
    name: 'Fatou',
    hp: 40,
    ability: 'adrenal',
    favoriteWeapon: 'sidearm',
    personalPerks: ['soigneur', 'nerveux', 'fetiche'],
    blurb: 'Urgentiste. L’adrénaline donne un PA de plus.',
    emoji: '💉',
    cost: 200
  },
  {
    id: 'diego',
    name: 'Diego',
    hp: 40,
    ability: 'daredevil',
    favoriteWeapon: 'saw',
    personalPerks: ['fetiche', 'brave', 'nerveux'],
    blurb: 'Tête brûlée. +1 dé quand il joue sa peau (≤ 20 PV).',
    emoji: '🔥',
    cost: 250
  },
  {
    id: 'suzanne',
    name: 'Suzanne',
    hp: 40,
    ability: 'deadeye',
    favoriteWeapon: 'magnum',
    personalPerks: ['fetiche', 'discret', 'coriace'],
    blurb: 'Arquebusière. Ses armes portent une salle plus loin.',
    emoji: '🦅',
    cost: 250
  },
  {
    id: 'karim',
    name: 'Karim',
    hp: 40,
    ability: 'trophy',
    favoriteWeapon: 'rifle',
    personalPerks: ['fetiche', 'lettre', 'brave'],
    blurb: 'Chasseur de primes. Chaque victime vaut un point de plus.',
    emoji: '🏹',
    cost: 300
  },
  {
    id: 'margot',
    name: 'Margot',
    hp: 40,
    ability: 'lucky',
    favoriteWeapon: 'blade',
    personalPerks: ['fouineur', 'fetiche', 'vigor'],
    blurb: 'Chanceuse. La fatigue de fouille la rattrape deux fois moins vite.',
    emoji: '🍀',
    cost: 300
  },
  {
    id: 'ethan',
    name: 'Ethan',
    hp: 40,
    ability: 'tactician',
    favoriteWeapon: 'marksman',
    personalPerks: ['lettre', 'fetiche', 'discret'],
    blurb: 'Stratège. Un PA non dépensé se garde pour le tour suivant.',
    emoji: '♟️',
    cost: 400
  },
  {
    id: 'rosa',
    name: 'Rosa',
    hp: 40,
    ability: 'veteran',
    favoriteWeapon: 'sidearm',
    personalPerks: ['fetiche', 'coriace', 'arme'],
    blurb: 'Vétérane. Arrive armée d’une arme de poing, insensible aux spores.',
    emoji: '🎖️',
    cost: 400
  }
];

export const BASE_HEROES = HEROES.filter((hero) => !hero.cost);

/* ---------------------------- loadout perks -------------------------------- */

/**
 * The CoD-style pick, chosen in the lobby, per game: one signature perk from
 * the character's three, plus two from the global pool. Same law as
 * everything else in this file — flat, small, capped, and mostly "start with
 * something" or "once per raid", never a multiplier.
 */
export interface LoadoutPerkDef {
  id: string;
  label: string;
  emoji: string;
}

export const HERO_LOADOUT_PERKS: readonly LoadoutPerkDef[] = [
  /* Signature pool (assigned per character). */
  { id: 'fetiche', label: 'Fétichiste · +1 dé de plus avec l’arme fétiche', emoji: '🎯' },
  { id: 'vigor', label: 'Vigueur · +10 PV max', emoji: '❤️' },
  { id: 'nerveux', label: 'Nerveux · +1 PA au premier tour', emoji: '⚡' },
  { id: 'soigneur', label: 'Prévoyant · commence avec un kit de soin', emoji: '💊' },
  { id: 'arme', label: 'Armé · commence avec un pistolet en seconde main', emoji: '🔫' },
  { id: 'discret', label: 'Discret · la première attaque bruyante de chaque tour est silencieuse', emoji: '🤫' },
  { id: 'brave', label: 'Brave · +1 dé quand aucun allié n’est dans la salle', emoji: '🦁' },
  { id: 'fouineur', label: 'Fouineur · première fouille du raid à rareté +1', emoji: '🔦' },
  { id: 'coriace', label: 'Coriace · la première blessure du raid est réduite de 10', emoji: '🪨' },
  { id: 'lettre', label: 'Lettré · +2 points de score par objectif rempli', emoji: '📖' },

  /* Global pool (any character may pick two). */
  { id: 'sang-froid', label: 'Sang-froid · +10 PV max', emoji: '🧊' },
  { id: 'poches', label: 'Poches profondes · +1 place de sac', emoji: '👝' },
  { id: 'trousse', label: 'Trousse · commence avec un kit de soin', emoji: '🩹' },
  { id: 'injection', label: 'Seringue · commence avec une adrénaline', emoji: '💉' },
  { id: 'couteau', label: 'Second couteau · commence avec une machette en seconde main', emoji: '🔪' },
  { id: 'esquive', label: 'Esquive · la première attaque subie du raid est évitée', emoji: '💨' },
  { id: 'boussole', label: 'Boussole · les salles voisines du départ sont connues', emoji: '🧭' },
  { id: 'chasseur', label: 'Chasseur · +1 point de score par victime', emoji: '🏆' }
];

/** The two-of-many half of the pick. */
export const HERO_GLOBAL_PERKS = [
  'sang-froid',
  'poches',
  'trousse',
  'injection',
  'couteau',
  'esquive',
  'boussole',
  'chasseur'
];

export function loadoutPerkDef(id: string): LoadoutPerkDef {
  const found = HERO_LOADOUT_PERKS.find((perk) => perk.id === id);
  if (!found) throw new Error(`Unknown loadout perk: ${id}`);
  return found;
}

/* --------------------------------- zombies -------------------------------- */

export interface ZombieDef {
  id: string;
  name: string;
  hp: number;
  ap: number;
  damage: number;
  /** Points a kill is worth. */
  points: number;
  /** What the game master pays to spawn one. */
  cost: number;
  /** Same colour language as the loot: grey walker, golden abomination. */
  rarity: Rarity;
  emoji: string;
  /** Counts for "kill a boss" objectives, and is announced when it arrives. */
  boss?: boolean;
  /** Spawns one of these in its own room each time it activates. */
  summons?: string;
}

/**
 * Every creature of every biome.
 *
 * The stats are the archetype's and the faces are the biome's; see
 * `content/roles.ts` for why those cannot be mixed up. Ids are unique across
 * biomes, which is what lets a saved game — a list of ids — still mean something
 * after a biome is added.
 */
export const ZOMBIES: readonly ZombieDef[] = allZombies();

export function zombieDef(id: string): ZombieDef {
  const zombie = ZOMBIES.find((candidate) => candidate.id === id);
  if (!zombie) throw new Error(`Unknown zombie: ${id}`);
  return zombie;
}

export function heroDef(id: string): HeroDef {
  const hero = HEROES.find((candidate) => candidate.id === id);
  if (!hero) throw new Error(`Unknown hero: ${id}`);
  return hero;
}

/* ---------------------------------- items --------------------------------- */

export type ItemKind = 'weapon' | 'gear';

/** 1 (commun) to 5 (légendaire). Shared language of loot, horde and UI. */
export type Rarity = 1 | 2 | 3 | 4 | 5;

export interface WeaponStats {
  /** Rooms of reach in a straight line; 0 = own room only. */
  range: number;
  dice: number;
  damage: number;
  /** A d6 ≥ this is a hit. */
  accuracy: number;
  melee: boolean;
  /** Dice double when the same weapon is held in both hands. */
  akimbo: boolean;
  /** Marks the room with noise, which is what the horde homes in on. */
  noisy: boolean;
}

export interface GearStats {
  /** Absorbs one attack entirely, then needs re-equipping. */
  vest?: boolean;
  /** One free search per turn while equipped. */
  flashlight?: boolean;
  /** Consumable: heals this many HP for 1 AP, then is spent. */
  heal?: number;
  /** Consumable: grants this many AP for free, then is spent. */
  adrenaline?: number;
}

export interface ItemDef {
  id: string;
  name: string;
  kind: ItemKind;
  /**
   * Where the item sits in the loot table: *when* it starts turning up, not how
   * good the one you found is. A dropped instance rolls its own rarity within
   * one rank of this, so a common minigun and an epic machete both exist while
   * the 2020 table still decides that miniguns are a late-game problem.
   */
  tier: Rarity;
  emoji: string;
  /** Weapons only. The printed stats, at rarity == tier. */
  weapon?: WeaponStats;
  /** Gear only. The printed stats, at rarity == tier. */
  gear?: GearStats;
}

/** The rarity's colour language, Fortnite-style, shared by loot and horde. */
export const RARITY_META: Record<Rarity, { label: string; color: string }> = {
  1: { label: 'Commun', color: '#9aa0a6' },
  2: { label: 'Peu commun', color: '#3fb950' },
  3: { label: 'Rare', color: '#4f9cf0' },
  4: { label: 'Épique', color: '#b06ae0' },
  5: { label: 'Légendaire', color: '#e8a33d' }
};

/**
 * Every item of every biome, the modern one included — whose twelve weapons and
 * four pieces of gear are the 2020 balance table, column for column, damage ×10.
 *
 * A biome supplies the item; its *role* supplies the tier, so no biome can move a
 * weapon up the loot curve. Look one up by id (a save file holds ids), or ask for
 * a role in a biome with `itemFor`.
 */
export const ITEMS: readonly ItemDef[] = allItems();

export function itemDef(id: string): ItemDef {
  const item = ITEMS.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Unknown item: ${id}`);
  return item;
}

/* --------------------------- rarity, per instance -------------------------- */

/**
 * How far a dropped item's rarity may stray from its tier.
 *
 * One rank, deliberately. Decoupling rarity from the item is what makes every
 * crate worth opening — the same machete can be a chipped one or a beautiful
 * one — but an unbounded roll would put a legendary starting weapon in someone's
 * hands on turn one and the whole escalation curve (heroes plateau, horde
 * compounds) depends on that not happening. A legendary therefore only exists
 * for things that were already tier 4 or 5.
 */
export const RARITY_SPREAD = 1;

export function clampRarity(value: number): Rarity {
  return Math.min(5, Math.max(1, Math.round(value))) as Rarity;
}

/** The rarities a given item can actually drop at. */
export function rarityRange(tier: Rarity): { min: Rarity; max: Rarity } {
  return { min: clampRarity(tier - RARITY_SPREAD), max: clampRarity(tier + RARITY_SPREAD) };
}

/**
 * What rarity does to a weapon.
 *
 * Accuracy is the lever, because it is the only one that means roughly the same
 * thing to every weapon in the table: a rank moves the hit threshold by one, so
 * a pistol gains a third and a minigun gains a fifth rather than a flat bonus
 * doubling the minigun and vanishing on the flamethrower. Where accuracy has
 * nowhere left to go (the flamethrower already hits on 1+) the rank pays in
 * damage instead, so no rarity is ever inert.
 *
 * Bounded by construction: the spread is one rank, so the best possible roll is
 * worth about a third more damage than the printed weapon and the worst about a
 * quarter less. Never a multiplier, never a new ability.
 */
export function weaponStats(def: ItemDef, rarity: number): WeaponStats | undefined {
  const base = def.weapon;
  if (!base) return undefined;

  const delta = clampRarity(rarity) - def.tier;
  if (delta === 0) return base;

  if (delta > 0) {
    return base.accuracy > 1 ? { ...base, accuracy: base.accuracy - 1 } : { ...base, damage: base.damage + 10 };
  }
  return base.accuracy < 5
    ? { ...base, accuracy: base.accuracy + 1 }
    : { ...base, damage: Math.max(10, base.damage - 10) };
}

/**
 * What rarity does to gear.
 *
 * Every piece has to answer "what is an epic one *for*", and two of them did not:
 * a rare vest and an epic vest both ate one attack, a rare torch and an epic torch
 * both lit one free search. A rarity you can see and cannot feel is a decoration,
 * so the two binary effects were given a dial each — see `vestCharges` and
 * `torchReach` — and the numeric ones keep scaling here.
 */
export function gearStats(def: ItemDef, rarity: number): GearStats | undefined {
  const base = def.gear;
  if (!base) return undefined;

  const delta = clampRarity(rarity) - def.tier;
  if (delta === 0) return base;

  const next: GearStats = { ...base };
  if (base.heal !== undefined) next.heal = Math.max(10, base.heal + delta * 10);
  if (base.adrenaline !== undefined) next.adrenaline = Math.max(1, base.adrenaline + delta);
  return next;
}

/**
 * How many attacks a vest absorbs before it is finished. A beautiful plate is one
 * that holds twice — the difference between surviving an ambush and not.
 */
export function vestCharges(def: ItemDef, rarity: number): number {
  if (!def.gear?.vest) return 0;
  return 1 + Math.max(0, clampRarity(rarity) - def.tier);
}

/**
 * How far a torch throws light, in rooms. A plain one lights what you are standing
 * in (and pays for a free search); a good one lights the rooms next door, which on
 * a dark map is worth more than any number.
 */
export function torchReach(def: ItemDef, rarity: number): number {
  if (!def.gear?.flashlight) return 0;
  return Math.max(0, clampRarity(rarity) - def.tier);
}

/** 40/30/15/10/5, straight from the original loot query. */
export const RARITY_WEIGHTS: readonly number[] = [40, 30, 15, 10, 5];

/**
 * What every hero starts with: something to swing, nothing to brag about. Roles,
 * so the biome decides whether that is a baseball bat or a length of pipe.
 */
export const STARTING_ROLES: readonly ItemRole[] = ['club', 'blade', 'pick', 'club'];

/* ------------------------------- GM classes ------------------------------- */

/**
 * The horde's faces, Dead-by-Daylight style: each class bends one lever of the
 * existing economy or map. Same law as the survivors — flat discounts and flat
 * bonuses with ceilings, so a class is an identity, never a stat cheat.
 */
export interface GmClassDef {
  id: string;
  name: string;
  emoji: string;
  blurb: string;
  /** The three signature perks this class may pick one of. */
  personalPerks: [string, string, string];
  /** Rations to unlock; absent = base roster. */
  cost?: number;
}

export const GM_CLASSES: readonly GmClassDef[] = [
  /* ------------------------------ base roster ----------------------------- */
  {
    id: 'horde',
    name: 'La Horde',
    emoji: '🧟',
    personalPerks: ['tresor', 'dividende', 'essaim'],
    blurb: 'La référence : rien de spécial, tout en nombre.'
  },
  {
    id: 'necromancienne',
    name: 'La Nécromancienne',
    emoji: '🕯️',
    personalPerks: ['economat', 'essaim', 'tresor'],
    blurb: 'Invocations à -1 point, mais chaque créature perd 10 PV.'
  },
  {
    id: 'boucher',
    name: 'Le Boucher',
    emoji: '🪓',
    personalPerks: ['brutalite', 'tresor', 'dividende'],
    blurb: 'Les boss coûtent 2 de moins et gagnent 20 PV.'
  },
  {
    id: 'traqueur',
    name: 'Le Traqueur',
    emoji: '👣',
    personalPerks: ['clairon', 'essaim', 'dividende'],
    blurb: 'Les coureurs ne coûtent qu’1 point.'
  },
  {
    id: 'parasite',
    name: 'Le Parasite',
    emoji: '🍄',
    personalPerks: ['taniere', 'dividende', 'tresor'],
    blurb: 'Trois salles infestées : y entrer coûte 10 PV aux survivants.'
  },

  /* --------------------------- unlockable roster -------------------------- */
  {
    id: 'crypte',
    name: 'Seigneur des cryptes',
    emoji: '⚱️',
    personalPerks: ['taniere', 'essaim', 'economat'],
    blurb: 'Une salle d’apparition supplémentaire sur la carte.',
    cost: 200
  },
  {
    id: 'hurleur',
    name: 'Le Grand Hurleur',
    emoji: '📢',
    personalPerks: ['porte-voix', 'essaim', 'tresor'],
    blurb: 'Les hurleuses coûtent 2 de moins et invoquent deux zombies.',
    cost: 250
  },
  {
    id: 'general',
    name: 'Le Général',
    emoji: '🎖️',
    personalPerks: ['clairon', 'dividende', 'brutalite'],
    blurb: 'L’ordre Ruée ne coûte que 3 points.',
    cost: 300
  },
  {
    id: 'charognard',
    name: 'Le Charognard',
    emoji: '🦴',
    personalPerks: ['dividende', 'tresor', 'economat'],
    blurb: 'Chaque blessure infligée rapporte 1 point de budget.',
    cost: 350
  },
  {
    id: 'ossature',
    name: 'Colosse d’os',
    emoji: '☠️',
    personalPerks: ['forgeron', 'brutalite', 'tresor'],
    blurb: 'Les évolutions permanentes coûtent 3 de moins.',
    cost: 400
  }
];

export const BASE_GM_CLASSES = GM_CLASSES.filter((gmClass) => !gmClass.cost);

export function gmClassDef(id: string): GmClassDef {
  const found = GM_CLASSES.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Unknown GM class: ${id}`);
  return found;
}

/** The game master's loadout pool: signature entries plus the global picks. */
export const GM_LOADOUT_PERKS: readonly LoadoutPerkDef[] = [
  { id: 'tresor', label: 'Trésor de guerre · +3 de budget initial', emoji: '💰' },
  { id: 'dividende', label: 'Dividende · +1 de revenu par tour', emoji: '📈' },
  { id: 'clairon', label: 'Clairon · l’ordre Ruée coûte 2 de moins', emoji: '📯' },
  { id: 'forgeron', label: 'Forgeron · les évolutions coûtent 2 de moins', emoji: '⚒️' },
  { id: 'essaim', label: 'Essaim · 2 zombies gratuits au premier assaut', emoji: '🐜' },
  { id: 'taniere', label: 'Tanière · une salle d’apparition de plus', emoji: '🕳️' },
  { id: 'economat', label: 'Économat · la première invocation du tour coûte 1 de moins', emoji: '🧾' },
  { id: 'porte-voix', label: 'Porte-voix · les hurleuses coûtent 1 de moins', emoji: '📣' },
  { id: 'brutalite', label: 'Brutalité · les boss invoqués gagnent 10 PV', emoji: '🩸' }
];

export const GM_GLOBAL_PERKS = [
  'tresor',
  'dividende',
  'clairon',
  'forgeron',
  'essaim',
  'taniere',
  'economat',
  'porte-voix',
  'brutalite'
];

export function gmLoadoutPerkDef(id: string): LoadoutPerkDef {
  const found = GM_LOADOUT_PERKS.find((perk) => perk.id === id);
  if (!found) throw new Error(`Unknown GM loadout perk: ${id}`);
  return found;
}
