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
 * All HP and damage sit on a ×10 scale versus the board game's printout, which was
 * done for legibility (a flat "+10 PV" reads; "+1 PV" reads like a rounding error)
 * and to leave headroom for finer-grained effects later.
 *
 * That headroom is now spent, and it had to be. Every value being an exact multiple
 * of ten was harmless while weapons could miss, and became the central problem when
 * they stopped: a walker had exactly 10 hit points, so every weapon in the game
 * killed one per hit and a sniper rifle threw 88 % of its damage away doing it. The
 * grid is therefore gone from the creature table and the arsenal (9, 11, 14, 21, 22,
 * 46, 58, 112...), while the scale stays. Hero hit points and the flat perk bonuses
 * are deliberately left on round numbers: they are what a player reads on his own
 * card every turn, and nothing about them was broken.
 */

import { allItems, allZombies } from './content/registry.js';
import type { ItemRole } from './content/roles.js';

export const STAT_SCALE = 10;

/* --------------------------------- heroes --------------------------------- */

/**
 * What a character *does*, as opposed to what a character's numbers are.
 *
 * Sixteen of the twenty used to be a number. Four shapes covered them all — "+1 die
 * under some condition" (marksman, assassin, daredevil, brawler), "one free action"
 * (scavenger, fleet, magpie), "one wound reduced" (tough, bulwark), and a stat tweak
 * (mule, trophy, lucky, grim, adrenal, medic) — and a playtest said, correctly, that
 * choosing between them did not feel like choosing anything. Two survivors who
 * differ by one die play identically.
 *
 * The four that were never numbers are the proof of what was missing: `silent`
 * (noise), `scout` (information), `deadeye` (reach) and `tactician` (banking a
 * point) are the ones people remember, because each one changes a decision rather
 * than a total.
 *
 * So five were rewritten, and the rule for the rewrite is the important part: the
 * *power budget does not move*. What used to be a die becomes a verb of about the
 * same worth. That is what keeps five versions of simulator balance valid — and the
 * bench confirms it, which is the only reason this was safe to do at all.
 *
 * Three were deliberately left alone. `mule` and `brawler` were the two candidates
 * for a barricade and a grapple: both would have to mutate the board mid-raid, and
 * the board carries a connectivity guarantee that windows were carefully designed
 * *not* to break. That is worth doing properly rather than cheaply. `magpie` is
 * already distinctive enough to keep.
 */
export type HeroAbility =
  /**
   * **Embuscade.** End the turn with an action point in hand and it becomes a held
   * shot: the first creature to step into his line of fire during the enemy phase is
   * fired on, free.
   *
   * It was +1 ranged die, and before that a reroll of a missed die — which became
   * worth nothing the day weapons stopped missing. The same budget spent on timing
   * rather than on volume, and it gives one player something to *do* during the
   * horde's phase, which until now was four seconds of watching tokens slide.
   */
  | 'marksman'
  /**
   * **Exécution.** A melee kill that leaves the room empty of creatures refunds the
   * point it cost.
   *
   * It was +1 melee die. Same class of value — she kills a little more per turn —
   * but now it is a gamble with a shape: two creatures and two points is a bet that
   * both die, and winning it buys the room *and* the step out of it.
   */
  | 'assassin'
  /**
   * **Trieur.** Their searches never turn up the bottom tier, and a room gives them
   * one more find than it has left in it.
   *
   * It was "the first search each turn is free". The second half is the interesting
   * one now that rooms run dry: they are the reason a team lingers in the armoury
   * instead of passing through, which is a decision for the whole table rather than
   * a discount for one seat.
   */
  | 'scavenger'
  /**
   * **Bouclier humain.** A wound aimed at a survivor sharing his room lands on him
   * instead, while he can still take it.
   *
   * It was "the first wound each enemy phase is reduced by 10" — a number, and one
   * nobody could see working. Roughly the same damage absorbed over a raid, except
   * now it is absorbed *for somebody*, which is the verb a co-operative game
   * actually wants and the only ability in the game that reads as an act.
   */
  | 'tough'
  /** Medkits are free to use and heal 10 more. */
  | 'medic'
  /**
   * **Course.** One point carries her two rooms instead of one — and she arrives
   * loudly, because nobody crosses a building at a run quietly.
   *
   * It was "the first move each turn is free", which is the same amount of movement
   * and none of the tension. A trade beats a discount: the horde homes in on noise,
   * so her speed is also how she gets found.
   */
  | 'fleet'
  /** +2 bag slots. */
  | 'mule'
  /** Their attacks never lay noise. */
  | 'silent'
  /** Can attack bare-handed: one die, ten damage. */
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
    personalPerks: ['fetiche', 'discret', 'vigile'],
    blurb: 'coronaz.hero.charles.blurb',
    emoji: '🎯'
  },
  {
    id: 'johanna',
    name: 'Johanna',
    hp: 40,
    ability: 'assassin',
    favoriteWeapon: 'blade',
    personalPerks: ['fetiche', 'brave', 'elan'],
    blurb: 'coronaz.hero.johanna.blurb',
    emoji: '🗡️'
  },
  {
    id: 'chuck',
    name: 'Chuck',
    hp: 40,
    ability: 'scavenger',
    favoriteWeapon: 'club',
    personalPerks: ['pilleur', 'fetiche', 'courrier'],
    blurb: 'coronaz.hero.chuck.blurb',
    emoji: '🎒'
  },
  {
    id: 'yuri',
    name: 'Yuri',
    hp: 50,
    ability: 'tough',
    favoriteWeapon: 'scatter',
    personalPerks: ['vigor', 'fetiche', 'vigile'],
    blurb: 'coronaz.hero.yuri.blurb',
    emoji: '🛡️'
  },
  {
    id: 'sacha',
    name: 'Sacha',
    hp: 40,
    ability: 'medic',
    favoriteWeapon: 'sidearm',
    personalPerks: ['soigneur', 'fetiche', 'vigor'],
    blurb: 'coronaz.hero.sacha.blurb',
    emoji: '🚑'
  },
  {
    id: 'nadia',
    name: 'Nadia',
    hp: 40,
    ability: 'fleet',
    favoriteWeapon: 'smg',
    personalPerks: ['elan', 'fetiche', 'discret'],
    blurb: 'coronaz.hero.nadia.blurb',
    emoji: '👟'
  },
  {
    id: 'marco',
    name: 'Marco',
    hp: 40,
    ability: 'mule',
    favoriteWeapon: 'chaingun',
    personalPerks: ['fetiche', 'vigor', 'courrier'],
    blurb: 'coronaz.hero.marco.blurb',
    emoji: '📦'
  },
  {
    id: 'ines',
    name: 'Inès',
    hp: 40,
    ability: 'silent',
    favoriteWeapon: 'smg',
    personalPerks: ['discret', 'fetiche', 'brave'],
    blurb: 'coronaz.hero.ines.blurb',
    emoji: '🤫'
  },
  {
    id: 'bernard',
    name: 'Bernard',
    hp: 50,
    ability: 'brawler',
    favoriteWeapon: 'club',
    personalPerks: ['brave', 'vigor', 'vigile'],
    blurb: 'coronaz.hero.bernard.blurb',
    emoji: '👊'
  },
  {
    id: 'awa',
    name: 'Awa',
    hp: 40,
    ability: 'scout',
    favoriteWeapon: 'rifle',
    personalPerks: ['fetiche', 'vigile', 'elan'],
    blurb: 'coronaz.hero.awa.blurb',
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
    blurb: 'coronaz.hero.viktor.blurb',
    emoji: '⚰️',
    cost: 150
  },
  {
    id: 'lea',
    name: 'Léa',
    hp: 40,
    ability: 'magpie',
    favoriteWeapon: 'magnum',
    personalPerks: ['pilleur', 'fetiche', 'discret'],
    blurb: 'coronaz.hero.lea.blurb',
    emoji: '🪶',
    cost: 150
  },
  {
    id: 'omar',
    name: 'Omar',
    hp: 50,
    ability: 'bulwark',
    favoriteWeapon: 'scatter',
    personalPerks: ['vigor', 'vigile', 'fetiche'],
    blurb: 'coronaz.hero.omar.blurb',
    emoji: '🧱',
    cost: 200
  },
  {
    id: 'fatou',
    name: 'Fatou',
    hp: 40,
    ability: 'adrenal',
    favoriteWeapon: 'sidearm',
    personalPerks: ['soigneur', 'elan', 'fetiche'],
    blurb: 'coronaz.hero.fatou.blurb',
    emoji: '💉',
    cost: 200
  },
  {
    id: 'diego',
    name: 'Diego',
    hp: 40,
    ability: 'daredevil',
    favoriteWeapon: 'saw',
    personalPerks: ['fetiche', 'brave', 'elan'],
    blurb: 'coronaz.hero.diego.blurb',
    emoji: '🔥',
    cost: 250
  },
  {
    id: 'suzanne',
    name: 'Suzanne',
    hp: 40,
    ability: 'deadeye',
    favoriteWeapon: 'magnum',
    personalPerks: ['fetiche', 'discret', 'vigile'],
    blurb: 'coronaz.hero.suzanne.blurb',
    emoji: '🦅',
    cost: 250
  },
  {
    id: 'karim',
    name: 'Karim',
    hp: 40,
    ability: 'trophy',
    favoriteWeapon: 'rifle',
    personalPerks: ['fetiche', 'serrurier', 'brave'],
    blurb: 'coronaz.hero.karim.blurb',
    emoji: '🏹',
    cost: 300
  },
  {
    id: 'margot',
    name: 'Margot',
    hp: 40,
    ability: 'lucky',
    favoriteWeapon: 'blade',
    personalPerks: ['pilleur', 'fetiche', 'vigor'],
    blurb: 'coronaz.hero.margot.blurb',
    emoji: '🍀',
    cost: 300
  },
  {
    id: 'ethan',
    name: 'Ethan',
    hp: 40,
    ability: 'tactician',
    favoriteWeapon: 'marksman',
    personalPerks: ['serrurier', 'fetiche', 'discret'],
    blurb: 'coronaz.hero.ethan.blurb',
    emoji: '♟️',
    cost: 400
  },
  {
    id: 'rosa',
    name: 'Rosa',
    hp: 40,
    ability: 'veteran',
    favoriteWeapon: 'sidearm',
    personalPerks: ['fetiche', 'vigile', 'courrier'],
    blurb: 'coronaz.hero.rosa.blurb',
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

/**
 * The eighteen perks.
 *
 * The old set was built from three templates and admitted it: `+N flat stat`
 * (vigor, sang-froid, poches, nerveux), `commence avec X` (soigneur, arme, trousse,
 * injection, couteau — five of eighteen), and `la première X est gratuite`
 * (coriace, esquive, discret, fouineur). Worse, three pairs were the *same perk
 * written twice*: vigor and sang-froid both read "+10 PV max", soigneur and trousse
 * both handed out a medkit, arme and couteau both filled the off hand. A pool where
 * two entries are indistinguishable is a pool with sixteen entries and a bug.
 *
 * Rebuilt on one rule, the same one behind the ability rewrite: **a perk should
 * change a decision, not a total.** That is what makes it memorable, and — because
 * the worth stays where it was — it is also what makes it free to do. The bench
 * measured the whole old set at three to four points of win rate; the whole new set
 * measures the same, which is the number that mattered.
 *
 * Two starting kits survive, one in each pool. Five was the problem, not the idea:
 * opening a raid already holding something is a real choice when it is one option
 * among many rather than a third of the menu.
 */
export const HERO_LOADOUT_PERKS: readonly LoadoutPerkDef[] = [
  /* Signature pool (assigned per character). */
  { id: 'fetiche', label: 'coronaz.perk.fetiche', emoji: '🎯' },
  { id: 'vigor', label: 'coronaz.perk.vigor', emoji: '❤️' },
  { id: 'soigneur', label: 'coronaz.perk.soigneur', emoji: '💊' },
  { id: 'discret', label: 'coronaz.perk.discret', emoji: '🤫' },
  { id: 'brave', label: 'coronaz.perk.brave', emoji: '🦁' },
  /**
   * Replaces `fouineur` (first crate of the raid at rarity +1), which paid out once
   * and then sat there. This one pays every turn and only if you go somewhere: the
   * glittering rooms stop being scenery you walk past.
   */
  { id: 'pilleur', label: 'coronaz.perk.pilleur', emoji: '💎' },
  /**
   * Replaces `lettre` (+2 score per objective), which changed a number on a screen
   * nobody saw until the raid was over. Keys are the escape scenario's spine, so
   * making them free — and showing the door — reshapes the route instead.
   */
  { id: 'serrurier', label: 'coronaz.perk.serrurier', emoji: '🔑' },
  /**
   * Replaces `coriace` (first wound of the raid reduced by 10) — a number, spent
   * once, that nobody could feel. Information instead: the dark is the game's real
   * antagonist and this is the perk that pushes it back one room.
   */
  { id: 'vigile', label: 'coronaz.perk.vigile', emoji: '👁️' },
  /**
   * New. Handing things over was already free, and it was already the best thing a
   * team could do — this lets it happen without everybody first walking into one
   * room, which is where the free action was quietly costing two moves.
   */
  { id: 'courrier', label: 'coronaz.perk.courrier', emoji: '📨' },
  /**
   * Replaces `nerveux` (+1 AP on turn one). Same free point, except it only exists
   * if you spend it walking into somewhere nobody has been — so the perk argues for
   * exploring rather than paying you for having turned up.
   */
  { id: 'elan', label: 'coronaz.perk.elan', emoji: '🥾' },

  /* Global pool (any character may pick two). */
  { id: 'poches', label: 'coronaz.perk.poches', emoji: '👝' },
  { id: 'injection', label: 'coronaz.perk.injection', emoji: '💉' },
  { id: 'esquive', label: 'coronaz.perk.esquive', emoji: '💨' },
  /**
   * Replaces `chasseur` (+1 score per kill), the last perk in the pool that moved
   * only a number on a screen nobody reads until the raid is over — and it fills a
   * hole the deduplication left behind.
   *
   * Removing the duplicate `sang-froid` took the global pool's *only* survivability
   * option with it, because the surviving copy (`vigor`) is signature-only. The bench
   * found the cost where it always shows up: a table forced to open badly lost
   * fourteen points of win rate, since a party holding nothing but tier-1 weapons
   * lives or dies on how much it can absorb.
   *
   * Not another "+10 PV max", though. Armour and hit points answer different
   * threats — a bigger pool is better against one heavy blow, a flat reduction is
   * better against a crowd of small ones — which is the whole axis v6 built the
   * armour stat around, so the two are a real choice rather than the same perk
   * twice. It folds into the plate's own `max()` rather than adding to it, for the
   * same reason two vests do not stack.
   */
  { id: 'endurci', label: 'coronaz.perk.endurci', emoji: '🪨' },
  /**
   * Replaces `couteau` (start with a machete). Clearing a room was worth points and
   * a little loot; this makes killing a way of *looting*, which is a strategy rather
   * than an item.
   */
  { id: 'charognard', label: 'coronaz.perk.charognard', emoji: '🦴' },
  /**
   * Replaces `sang-froid`, which was `vigor` with a different emoji. Positional
   * rather than statistical: it makes standing next to somebody a tactic, and it is
   * the other half of Yuri's shield.
   */
  { id: 'fantome', label: 'coronaz.perk.fantome', emoji: '👻' },
  /**
   * Replaces `trousse`, the second medkit. A full bag used to refuse the search
   * outright, so the last third of a raid was spent unable to look at anything;
   * now it is a swap, and deciding what to leave behind is the interesting part.
   */
  { id: 'brocanteur', label: 'coronaz.perk.brocanteur', emoji: '⚖️' },
  /**
   * Replaces `boussole` (the start room's neighbours are known), which was one
   * reveal at turn one and then nothing. This one keeps paying, and it points at
   * the thing the scenario is actually about.
   */
  { id: 'eclaireur', label: 'coronaz.perk.eclaireur', emoji: '🧭' }
];

/** The two-of-many half of the pick. */
export const HERO_GLOBAL_PERKS = [
  'poches',
  'injection',
  'endurci',
  'esquive',
  'charognard',
  'fantome',
  'brocanteur',
  'eclaireur'
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
  /** Flat reduction on every hit it takes; `pierce` halves it. */
  armor: number;
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
  /** Halves the target's armour, rounded down. Paid for out of the power budget. */
  pierce?: boolean;
}

export interface GearStats {
  /**
   * Flat reduction on every wound taken, before the minimum of 1. The value here is
   * what a copy at the role's own tier gives; `gearArmor` scales it by rarity, which
   * is what makes a legendary plate worth carrying over a common one.
   *
   * Replaces the old `vest: true`, which absorbed one entire attack and was
   * therefore binary: a rare vest and a legendary vest did exactly the same thing,
   * once. Omar keeps that moment as his ability, where it belongs.
   */
  armor?: number;
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
  1: { label: 'coronaz.rarity.1', color: '#9aa0a6' },
  2: { label: 'coronaz.rarity.2', color: '#3fb950' },
  3: { label: 'coronaz.rarity.3', color: '#4f9cf0' },
  4: { label: 'coronaz.rarity.4', color: '#b06ae0' },
  5: { label: 'coronaz.rarity.5', color: '#e8a33d' }
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

/**
 * What one rank of rarity multiplies a weapon's damage by.
 *
 * 1.18 is the largest step that keeps a rank *visible* on the smallest weapon in
 * the table (a 1d×14 bat reads 12 / 14 / 17) without letting two ranks jump a tier
 * band, which would put a legendary sidearm above a plain sniper rifle again.
 */
export const RARITY_STEP = 1.18;

export function clampRarity(value: number): Rarity {
  return Math.min(5, Math.max(1, Math.round(value))) as Rarity;
}

/** The rarities a given item can actually drop at. */
export function rarityRange(tier: Rarity): { min: Rarity; max: Rarity } {
  return { min: clampRarity(tier - RARITY_SPREAD), max: clampRarity(tier + RARITY_SPREAD) };
}

/**
 * What rarity does to a weapon: about 18 % of its own output per rank.
 *
 * It used to be a flat ten damage a rank, which was defensible while every number
 * in the game was a multiple of ten and the arsenal spanned 10 to 120. Two changes
 * made it incoherent. The damage grid is gone, so ten is no longer the natural
 * quantum of anything; and the tier ladder was compressed to 14-72, so a flat ten
 * on a six-dice weapon is +83 % of its whole output, which would have handed back
 * with rarity exactly what the compression took away with tier.
 *
 * A share is even-handed by construction, which was the other complaint: ten damage
 * used to be +100 % on a baseball bat and +12.5 % on a sniper rifle, so the same
 * "rank" meant two entirely different things depending on what you were holding.
 * Now every weapon gains the same *proportion*, and the whole ladder keeps its
 * shape whatever the dice count.
 *
 * Spent on damage rather than dice on purpose: dice are how many things you can
 * kill in one attack, damage is how hard a thing you can kill, and rarity should
 * make a weapon better at its own job rather than turn it into a different weapon.
 */
export function weaponStats(def: ItemDef, rarity: number): WeaponStats | undefined {
  const base = def.weapon;
  if (!base) return undefined;

  const delta = clampRarity(rarity) - def.tier;
  if (delta === 0) return base;
  return { ...base, damage: Math.max(1, Math.round(base.damage * Math.pow(RARITY_STEP, delta))) };
}

/**
 * What rarity does to gear.
 *
 * Every piece has to answer "what is an epic one *for*", and two of them did not:
 * a rare vest and an epic vest both ate one attack, a rare torch and an epic torch
 * both lit one free search. A rarity you can see and cannot feel is a decoration, so
 * the vest became armour (`gearArmor`, one point a rank, common to legendary) and
 * the torch became reach (`torchReach`), and the numeric ones keep scaling here.
 */
export function gearStats(def: ItemDef, rarity: number): GearStats | undefined {
  const base = def.gear;
  if (!base) return undefined;

  const delta = clampRarity(rarity) - def.tier;
  if (delta === 0) return base;

  const next: GearStats = { ...base };
  if (base.heal !== undefined) next.heal = Math.max(8, base.heal + delta * 8);
  if (base.adrenaline !== undefined) next.adrenaline = Math.max(1, base.adrenaline + delta);
  if (base.armor !== undefined) next.armor = Math.max(1, base.armor + delta);
  return next;
}

/**
 * How much a plate takes off every wound: one point a rank, common to legendary.
 *
 * A tier-3 vest therefore runs 1 / 2 / 3 / 4 / 5, which against a walker's ten
 * points of damage is the difference between shrugging and bleeding, and never
 * immunity. Two vests do not stack (the wound path takes the best one): a survivor
 * wearing two legendary plates would otherwise be untouchable by half the bestiary.
 */
export function gearArmor(def: ItemDef, rarity: number): number {
  const base = def.gear?.armor;
  if (base === undefined) return 0;
  return Math.max(1, base + (clampRarity(rarity) - def.tier));
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
    name: 'coronaz.gmclass.horde.name',
    emoji: '🧟',
    personalPerks: ['tresor', 'dividende', 'essaim'],
    blurb: 'coronaz.gmclass.horde.blurb'
  },
  {
    id: 'necromancienne',
    name: 'coronaz.gmclass.necromancienne.name',
    emoji: '🕯️',
    personalPerks: ['economat', 'essaim', 'tresor'],
    blurb: 'coronaz.gmclass.necromancienne.blurb'
  },
  {
    id: 'boucher',
    name: 'coronaz.gmclass.boucher.name',
    emoji: '🪓',
    personalPerks: ['brutalite', 'tresor', 'dividende'],
    blurb: 'coronaz.gmclass.boucher.blurb'
  },
  {
    id: 'traqueur',
    name: 'coronaz.gmclass.traqueur.name',
    emoji: '👣',
    personalPerks: ['clairon', 'essaim', 'dividende'],
    blurb: 'coronaz.gmclass.traqueur.blurb'
  },
  {
    id: 'parasite',
    name: 'coronaz.gmclass.parasite.name',
    emoji: '🍄',
    personalPerks: ['taniere', 'dividende', 'tresor'],
    blurb: 'coronaz.gmclass.parasite.blurb'
  },

  /* --------------------------- unlockable roster -------------------------- */
  {
    id: 'crypte',
    name: 'coronaz.gmclass.crypte.name',
    emoji: '⚱️',
    personalPerks: ['taniere', 'essaim', 'economat'],
    blurb: 'coronaz.gmclass.crypte.blurb',
    cost: 200
  },
  {
    id: 'hurleur',
    name: 'coronaz.gmclass.hurleur.name',
    emoji: '📢',
    personalPerks: ['porte-voix', 'essaim', 'tresor'],
    blurb: 'coronaz.gmclass.hurleur.blurb',
    cost: 250
  },
  {
    id: 'general',
    name: 'coronaz.gmclass.general.name',
    emoji: '🎖️',
    personalPerks: ['clairon', 'dividende', 'brutalite'],
    blurb: 'coronaz.gmclass.general.blurb',
    cost: 300
  },
  {
    id: 'charognard',
    name: 'coronaz.gmclass.charognard.name',
    emoji: '🦴',
    personalPerks: ['dividende', 'tresor', 'economat'],
    blurb: 'coronaz.gmclass.charognard.blurb',
    cost: 350
  },
  {
    id: 'ossature',
    name: 'coronaz.gmclass.ossature.name',
    emoji: '☠️',
    personalPerks: ['forgeron', 'brutalite', 'tresor'],
    blurb: 'coronaz.gmclass.ossature.blurb',
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
  { id: 'tresor', label: 'coronaz.perk.tresor', emoji: '💰' },
  { id: 'dividende', label: 'coronaz.perk.dividende', emoji: '📈' },
  { id: 'clairon', label: 'coronaz.perk.clairon', emoji: '📯' },
  { id: 'forgeron', label: 'coronaz.perk.forgeron', emoji: '⚒️' },
  { id: 'essaim', label: 'coronaz.perk.essaim', emoji: '🐜' },
  { id: 'taniere', label: 'coronaz.perk.taniere', emoji: '🕳️' },
  { id: 'economat', label: 'coronaz.perk.economat', emoji: '🧾' },
  { id: 'porte-voix', label: 'coronaz.perk.porte-voix', emoji: '📣' },
  { id: 'brutalite', label: 'coronaz.perk.brutalite', emoji: '🩸' }
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
