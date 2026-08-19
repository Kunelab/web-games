import { itemsOfBiome } from './content/registry.js';
import {
  clampRarity,
  heroDef,
  rarityRange,
  RARITY_WEIGHTS,
  zombieDef,
  type ItemDef,
  type Rarity
} from './data.js';
import { chance, pick, rand } from './rng.js';
import { bagCapacity, makeItem, type CzState, type HeroState, type ItemInstance } from './state.js';

/**
 * Where loot comes from, and how good it is.
 *
 * Lives in its own module because both halves of the game need it and they cannot
 * import each other: searching is an action (`engine`) and killing is combat
 * (`combat`), and combat is imported *by* the engine.
 */

/** What a crate turned out to hold: which item, and how good this one is. */
export interface LootRoll {
  def: ItemDef;
  rarity: Rarity;
}

/**
 * Loot: tier first, item second, condition third.
 *
 * The tier roll uses the original's 40/30/15/10/5 curve and decides *what* turns
 * up; `lootLuck` shifts it by whole ranks. Loot fatigue then pulls it back down as
 * a hero keeps searching: the fourth crate is never as good as the first, which is
 * the heroes' half of the escalation bargain: their power plateaus at mid-game
 * while the horde keeps compounding.
 *
 * The third roll is the item's own rarity, one rank either side of its tier. It is
 * what makes a search worth watching even when the tier is one you have seen all
 * evening, and it never crosses tiers, so the curve above still owns the pacing.
 */
export function rollLoot(state: CzState, hero?: HeroState): LootRoll {
  const total = RARITY_WEIGHTS.reduce((sum, weight) => sum + weight, 0);
  let roll = Math.floor(total * rand(state.rng));
  let rank = 0;
  for (let i = 0; i < RARITY_WEIGHTS.length; i++) {
    roll -= RARITY_WEIGHTS[i] ?? 0;
    if (roll < 0) {
      rank = i;
      break;
    }
  }

  /**
   * Where you are standing, which is now half the question.
   *
   * The bonus is spent as a *chance of one rank*, not as a fraction of a rank:
   * ranks are what the loot table is made of, and a "0.35 of a rank" would have to
   * round to something, at which point half the table's values do nothing at all. So
   * +0.8 in a pharmacy is a four-in-five chance of the next tier up, +1 in an
   * armoury is a certainty, and -0.2 in the middle of a road is a one-in-five chance
   * of the tier below.
   */
  const here = hero ? state.board.rooms.find((room) => room.id === hero.roomId) : undefined;
  const bonus = (here?.loot ?? 0) + (here?.kind === 'start' ? START_LOOT_BONUS : 0);
  if (bonus > 0 && chance(state.rng, Math.min(1, bonus))) rank += 1;
  else if (bonus < 0 && chance(state.rng, Math.min(1, -bonus))) rank -= 1;

  // Margot's charm bends the fatigue curve, never the table itself.
  const fatigueStep = hero && heroDef(hero.heroId).ability === 'lucky' ? 8 : 4;
  const fatigue = hero ? Math.floor(hero.searches / fatigueStep) : 0;
  // The Fouineur loadout perk lifts the raid's first crate by one rank.
  const fouineur = hero?.loadout.includes('fouineur') && hero.searches === 1 ? 1 : 0;
  let tier = Math.min(4, Math.max(0, rank + state.config.lootLuck - fatigue + fouineur)) + 1;

  // Lucky find: the raid's first crate is never junk. One guaranteed floor, once,
  // which is a good start and not a build.
  if (hero?.perks.includes('lucky-find') && hero.searches === 1) {
    tier = Math.max(tier, 3);
  }

  /**
   * The pity floor: nobody's first three finds are all junk.
   *
   * The bench measured a 57-point spread in win rate between a table forced to open
   * well and one forced to open badly on the same preset, and the spread was
   * lopsided: good luck bought nine points, bad luck cost forty-seven. That is not
   * "loot decides the evening", it is "the bottom of the table ends it" - three
   * survivors holding nothing but tier-1 weapons cannot clear a room whatever they
   * do, so the raid is lost before anyone makes a decision.
   *
   * So the third draw of a hero's raid is floored at tier 2 if the first two gave
   * nothing better. It touches only the disaster case: a hero who has already found
   * anything decent never notices this code, and the ceiling is untouched, because
   * the ceiling was never the problem.
   */
  if (hero && hero.lootsDrawn === PITY_DRAWS - 1 && hero.bestTierFound < 2) {
    tier = Math.max(tier, 2);
  }

  /**
   * The bench's thumb on the scale.
   *
   * A raid's outcome depends enormously on the first few finds, and an average
   * measured over hundreds of games hides that completely. `forcedLuck` pins a
   * hero's opening haul to the best or the worst the table can produce, so the
   * simulator can report the spread between a blessed run and a cursed one instead
   * of only their mean. It is set by the simulator and by tests; nothing in a real
   * raid ever writes it.
   */
  const drawn = hero?.lootsDrawn ?? 0;
  if (hero?.forcedLuck && drawn < FORCED_LUCK_DRAWS) {
    tier = hero.forcedLuck === 'lucky' ? 5 : 1;
  }
  if (hero) {
    hero.lootsDrawn = drawn + 1;
    hero.bestTierFound = Math.max(hero.bestTierFound, tier);
  }

  const candidates = itemsOfBiome(state.config.biome).filter((item) => item.tier === tier);
  const def = pick(state.rng, candidates);

  // Condition. Luck tilts it both ways, and a bad roll on a good tier is still a
  // good find: the tier is the pacing, this is the texture.
  const upChance = 0.22 + Math.max(0, state.config.lootLuck) * 0.06;
  const downChance = Math.max(0.05, 0.28 - state.config.lootLuck * 0.06);
  const condition = rand(state.rng);
  let wobble = condition < upChance ? 1 : condition < upChance + downChance ? -1 : 0;
  if (hero?.forcedLuck && drawn < FORCED_LUCK_DRAWS) {
    wobble = hero.forcedLuck === 'lucky' ? 1 : -1;
  }

  const range = rarityRange(def.tier);
  const rarity = clampRarity(Math.min(range.max, Math.max(range.min, def.tier + wobble)));
  // The treasure quest watches the best thing anyone has turned up.
  if (rarity > state.bestRarityFound) state.bestRarityFound = rarity;
  return { def, rarity };
}

/** How many of a hero's first finds `forcedLuck` decides. */
export const FORCED_LUCK_DRAWS = 6;

/** How many opening draws the pity floor watches. */
export const PITY_DRAWS = 3;

/**
 * What the room everyone starts in is worth on top of its programme.
 *
 * The first search of a raid happens here, usually on turn one with three action
 * points and nothing but a bat, and it sets the tone of the whole evening. A small
 * thumb on that scale is worth more than the same thumb anywhere else.
 */
export const START_LOOT_BONUS = 0.15;

/**
 * What a corpse leaves behind.
 *
 * The 2020 game gave loot only for searching, which made a room full of zombies
 * pure cost: you spent action points to remove a threat and got nothing for it.
 * Now killing pays too, more for the big things, and it goes straight into the
 * killer's bag, so it is a reward and not another errand. A full bag simply loses
 * it, which is its own argument for the deep-pockets perk.
 */
export function dropFromKill(state: CzState, hero: HeroState, zombieDefId: string): ItemInstance | null {
  const def = zombieDef(zombieDefId);
  const odds = 0.1 + def.rarity * 0.05;
  if (!(def.boss || rand(state.rng) < odds)) return null;
  if (hero.bag.length >= bagCapacity(hero)) return null;

  const roll = rollLoot(state, hero);
  const item = makeItem(state, roll.def.id, roll.rarity);
  hero.bag.push(item);
  return item;
}

