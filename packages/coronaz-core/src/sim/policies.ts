import { itemDef, weaponStats, zombieDef } from '../data.js';
import type { HeroAction } from '../engine.js';
import { getRoom, lineOfSight, neighbors, shortestPath } from '../map.js';
import { rand, randInt } from '../rng.js';
import {
  bagCapacity,
  objectivesDone,
  type CzState,
  type HeroState,
  type ItemInstance,
  type ZombieState
} from '../state.js';

/**
 * Player bots on two axes, because that is how real tables vary:
 *
 * - A **mindset** is a play style: how long you loot, how far you detour for a
 *   kill. Styles are not skill — a master rusher exists, so does a newbie one.
 * - A **skill** is decision quality: whether you remember the free equip, use
 *   the medkit, kite instead of standing in the horde, focus fire, split the
 *   objectives — and how often you just do something daft (the blunder roll).
 *
 * Newbie is not "random": it is a player who fights what is in front of them
 * and walks at the goal, but forgets their inventory, over-loots, never kites
 * and fumbles a third of their decisions. Master adds what a talking table
 * adds: focus fire and splitting up for different keys.
 *
 * Blunder rolls draw from the game's own seeded RNG, so a (seed, party) pair
 * replays identically.
 */

export interface Mindset {
  /** Keep searching until a hand holds a weapon scoring at least this. */
  gearGoal: number;
  /** Total searches this hero is willing to spend a life on. */
  maxSearches: number;
  /** Willingness to detour toward kills that no objective demands. */
  aggression: number;
}

export const PLAYER_MINDSETS: Record<string, Mindset> = {
  /* gearGoal is expected damage per attack, in the ×10 stat scale. */
  /** Straight for the objectives, fights only what blocks the way. */
  rusher: { gearGoal: 11, maxSearches: 2, aggression: 0.1 },
  /** Guns first, questions later. */
  fighter: { gearGoal: 22, maxSearches: 4, aggression: 1 },
  /** Strips the map before doing the job. */
  looter: { gearGoal: 34, maxSearches: 9, aggression: 0.3 },
  /** The table that talks to each other. */
  balanced: { gearGoal: 24, maxSearches: 6, aggression: 0.5 }
};

export const playerMindsetNames = Object.keys(PLAYER_MINDSETS);

export interface SkillProfile {
  /** Chance per decision to replace the right move with a fumble. */
  blunder: number;
  /** Chance to bother with a beneficial free equip when one exists. */
  equips: number;
  usesConsumables: boolean;
  /** Repositions away from the horde in survival scenarios. */
  kites: boolean;
  /** Prefers targets it can finish this attack. */
  focusFire: boolean;
  /** Splits the team across different keys instead of herding. */
  coordinates: boolean;
  /** Extra searches past the mindset's budget: shiny-loot syndrome. */
  greed: number;
}

export const SKILLS: Record<string, SkillProfile> = {
  newbie: {
    blunder: 0.3,
    equips: 0.45,
    usesConsumables: false,
    kites: false,
    focusFire: false,
    coordinates: false,
    greed: 4
  },
  advanced: {
    blunder: 0.12,
    equips: 0.8,
    usesConsumables: true,
    kites: false,
    focusFire: false,
    coordinates: false,
    greed: 2
  },
  /** The calibration reference: the balance targets are defined against this. */
  expert: { blunder: 0, equips: 1, usesConsumables: true, kites: true, focusFire: false, coordinates: false, greed: 0 },
  master: { blunder: 0, equips: 1, usesConsumables: true, kites: true, focusFire: true, coordinates: true, greed: 0 }
};

export const skillNames = Object.keys(SKILLS);

/**
 * Expected damage of one attack with this weapon: dice × P(hit) × damage.
 *
 * Reads the *instance*, because rarity moves those numbers now: a bot that
 * scored the printed stats would swap a beautiful machete for a chipped one and
 * the bench would be measuring a mistake rather than the balance.
 */
export function weaponScore(item: ItemInstance): number {
  const weapon = weaponStats(itemDef(item.def), item.rarity);
  if (!weapon) return 0;
  const hitChance = (7 - weapon.accuracy) / 6;
  return weapon.dice * hitChance * weapon.damage * (weapon.akimbo ? 1.15 : 1);
}

function bestHandScore(hero: HeroState): number {
  return Math.max(...hero.hands.map((item) => (item ? weaponScore(item) : 0)), 0);
}

/** The hand an attack should use, best expected damage first. */
function bestHand(hero: HeroState, melee: boolean): { hand: 0 | 1 | 2; score: number } | null {
  const options: { hand: 0 | 1 | 2; score: number }[] = [];
  const [left, right] = hero.hands;

  for (const [item, hand] of [
    [left, 0],
    [right, 1]
  ] as const) {
    if (!item) continue;
    const def = itemDef(item.def);
    if (!def.weapon) continue;
    if (melee && !def.weapon.melee) continue;
    if (!melee && def.weapon.melee) continue;
    options.push({ hand, score: weaponScore(item) });
  }

  if (left && right && left.def === right.def && itemDef(left.def).weapon?.akimbo) {
    const def = itemDef(left.def);
    if (def.weapon && def.weapon.melee === melee) {
      // The pair fires at the worse gun's quality, so score the worse gun.
      const worse = left.rarity <= right.rarity ? left : right;
      options.push({ hand: 2, score: weaponScore(worse) * 2 });
    }
  }

  options.sort((a, b) => b.score - a.score);
  return options[0] ?? null;
}

/**
 * Target selection. Everyone prioritises a wanted boss; a focus-firing master
 * also prefers what they can finish this attack, because a dead zombie deals no
 * damage and a wounded one deals all of it.
 */
function pickTarget(state: CzState, hero: HeroState, targets: ZombieState[], skill: SkillProfile): ZombieState | null {
  if (targets.length === 0) return null;
  const bossWanted = state.objectives.some((objective) => objective.kind === 'boss' && !objective.done);
  const punch = Math.max(bestHand(hero, true)?.score ?? 0, bestHand(hero, false)?.score ?? 0);

  const sorted = [...targets].sort((a, b) => {
    const aBoss = zombieDef(a.def).boss ? 1 : 0;
    const bBoss = zombieDef(b.def).boss ? 1 : 0;
    if (bossWanted && aBoss !== bBoss) return bBoss - aBoss;

    if (skill.focusFire) {
      const aKill = a.hp <= Math.ceil(punch) ? 1 : 0;
      const bKill = b.hp <= Math.ceil(punch) ? 1 : 0;
      if (aKill !== bKill) return bKill - aKill;
    }

    return a.hp - b.hp || a.id.localeCompare(b.id);
  });
  return sorted[0] ?? null;
}

/**
 * Where this hero is trying to be.
 *
 * A coordinating team hands out the keys round-robin so five people do not walk
 * to the same room; everyone else herds to the nearest one, which is exactly
 * what a table that is not talking does.
 */
function goalRoom(state: CzState, hero: HeroState, skill: SkillProfile): string | null {
  const scenario = state.config.scenario;

  if (scenario === 'escape') {
    // Only while the quota is unmet: a key past it is scenery, and a bot that
    // toured every one of them was measuring the wrong game.
    const keyRooms =
      state.keysCollected >= state.config.keys
        ? []
        : state.board.rooms.filter((room) => room.hasKey).map((room) => room.id);
    if (keyRooms.length > 0) {
      if (skill.coordinates) {
        const heroIds = Object.keys(state.heroes).sort();
        const index = Math.max(0, heroIds.indexOf(hero.playerId));
        const sortedKeys = [...keyRooms].sort();
        return sortedKeys[index % sortedKeys.length] ?? null;
      }
      return nearestRoom(state, hero.roomId, keyRooms);
    }

    const killsPending = state.objectives.some(
      (objective) => (objective.kind === 'kills' || objective.kind === 'boss') && !objective.done
    );
    if (killsPending) {
      return nearestRoom(
        state,
        hero.roomId,
        Object.values(state.zombies).map((zombie) => zombie.roomId)
      );
    }

    if (objectivesDone(state) && state.keysCollected >= state.config.keys) {
      return state.board.rooms.find((room) => room.kind === 'exit')?.id ?? null;
    }
    return null;
  }

  if (scenario === 'purge') {
    return nearestRoom(
      state,
      hero.roomId,
      Object.values(state.zombies).map((zombie) => zombie.roomId)
    );
  }

  // Survival and endless: kiting is a skill. Whoever has it repositions; whoever
  // does not stands their ground, which is why beginners die in wave games.
  if (!skill.kites) return null;
  const zombieRooms = Object.values(state.zombies).map((zombie) => zombie.roomId);
  if (zombieRooms.length === 0) return null;
  const here = getRoom(state.board, hero.roomId);
  const options = [here, ...neighbors(state.board, here)];
  const safest = options
    .map((room) => ({
      id: room.id,
      distance: Math.min(...zombieRooms.map((other) => shortestPath(state.board, room.id, other)?.length ?? 99))
    }))
    .sort((a, b) => b.distance - a.distance)[0];
  return safest && safest.id !== hero.roomId ? safest.id : null;
}

function nearestRoom(state: CzState, from: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestLength = Number.POSITIVE_INFINITY;
  for (const candidate of new Set(candidates)) {
    const path = shortestPath(state.board, from, candidate);
    if (path !== null && path.length < bestLength) {
      best = candidate;
      bestLength = path.length;
    }
  }
  return best;
}

/**
 * One decision, degraded to the player's level. The simulator and the live bot
 * driver both call this; `null` means done for the phase.
 */
export function decideHeroAction(
  state: CzState,
  hero: HeroState,
  mindset: Mindset,
  skill: SkillProfile = SKILLS.expert ?? {
    blunder: 0,
    equips: 1,
    usesConsumables: true,
    kites: true,
    focusFire: false,
    coordinates: false,
    greed: 0
  }
): HeroAction | null {
  if (state.phase !== 'heroes' || !hero.alive || hero.escaped) return null;

  const intended = intendedAction(state, hero, mindset, skill);
  if (!intended) return null;

  // The blunder roll: the right move exists, and does not happen. What happens
  // instead is what actually happens at tables: a pointless move, a pointless
  // search, or freezing with AP unspent.
  if (skill.blunder > 0 && hero.ap > 0 && rand(state.rng) < skill.blunder) {
    return fumble(state, hero);
  }

  return intended;
}

function intendedAction(state: CzState, hero: HeroState, mindset: Mindset, skill: SkillProfile): HeroAction | null {
  // A medkit at low HP beats everything else 1 AP buys — for those who remember
  // they have one.
  if (skill.usesConsumables && hero.hp <= hero.maxHp - 20 && hero.ap > 0) {
    const medkit = [...hero.bag, ...hero.gear].find((item) => item && itemDef(item.def).gear?.heal);
    if (medkit) return { type: 'use', uid: medkit.uid };
  }

  // Free: put the best weapon from the bag into the weaker hand. Equip
  // discipline is a skill; beginners run around with the machete in the bag.
  const handScore = bestHandScore(hero);
  const upgrade = hero.bag
    .filter((item) => itemDef(item.def).kind === 'weapon')
    .sort((a, b) => weaponScore(b) - weaponScore(a))[0];
  if (upgrade && weaponScore(upgrade) > handScore && rand(state.rng) < skill.equips) {
    const slot = hero.hands[0] === null ? 'hand0' : hero.hands[1] === null ? 'hand1' : 'hand0';
    return { type: 'equip', uid: upgrade.uid, slot };
  }
  const vest = hero.bag.find((item) => itemDef(item.def).gear?.vest);
  if (vest && hero.gear.some((slot) => slot === null) && rand(state.rng) < skill.equips) {
    return { type: 'equip', uid: vest.uid, slot: hero.gear[0] === null ? 'gear0' : 'gear1' };
  }

  // Out of AP: adrenaline is the only thing still playable.
  if (hero.ap <= 0) {
    if (!skill.usesConsumables) return null;
    const shot = [...hero.bag, ...hero.gear].find((item) => item && itemDef(item.def).gear?.adrenaline);
    const inDanger = Object.values(state.zombies).some((zombie) => zombie.roomId === hero.roomId);
    if (shot && inDanger) return { type: 'use', uid: shot.uid };
    return null;
  }

  // Something in the room: fight it (melee first, ranged as fallback).
  const inRoom = Object.values(state.zombies).filter((zombie) => zombie.roomId === hero.roomId);
  const roomTarget = pickTarget(state, hero, inRoom, skill);
  if (roomTarget) {
    const melee = bestHand(hero, true);
    const ranged = bestHand(hero, false);
    const choice = (melee?.score ?? 0) >= (ranged?.score ?? 0) ? melee : ranged;
    if (choice) return { type: 'attack', zombieId: roomTarget.id, hand: choice.hand };
    return null; // Unarmed against the horde: pass and pray.
  }

  // On a key, on the open exit: take it.
  const here = getRoom(state.board, hero.roomId);
  if (here.hasKey && state.config.scenario === 'escape') {
    return { type: 'pickupKey' };
  }
  if (
    here.kind === 'exit' &&
    state.config.scenario === 'escape' &&
    state.keysCollected >= state.config.keys &&
    objectivesDone(state)
  ) {
    return { type: 'exit' };
  }

  // Ranged pot-shots: when the mission wants kills, or the mindset likes them.
  const ranged = bestHand(hero, false);
  if (ranged) {
    const weapon = hero.hands[ranged.hand === 2 ? 0 : ranged.hand];
    const range = weapon ? (itemDef(weapon.def).weapon?.range ?? 0) : 0;
    const sight = lineOfSight(state.board, hero.roomId, range);
    const visible = Object.values(state.zombies).filter((zombie) => sight.has(zombie.roomId));
    const killsWanted =
      state.config.scenario === 'purge' ||
      state.objectives.some((o) => (o.kind === 'kills' || o.kind === 'boss') && !o.done);
    const target = pickTarget(state, hero, visible, skill);
    if (target && (killsWanted || mindset.aggression >= 0.5)) {
      return { type: 'attack', zombieId: target.id, hand: ranged.hand };
    }
  }

  // Loot while it is quiet and the arsenal is still wanting. Greed pads the
  // budget: the newbie opens one more crate long after the machete question is
  // settled.
  const searchesPending = state.objectives.some((o) => o.kind === 'searches' && !o.done);
  const wantsLoot =
    hero.bag.length < bagCapacity(hero) &&
    (searchesPending || (handScore < mindset.gearGoal && hero.searches < mindset.maxSearches + skill.greed));
  if (wantsLoot) {
    return { type: 'search' };
  }

  // Advance the mission.
  const goal = goalRoom(state, hero, skill);
  if (goal && goal !== hero.roomId) {
    const path = shortestPath(state.board, hero.roomId, goal);
    const step = path?.[0];
    if (step) return { type: 'move', roomId: step };
  }

  return null;
}

/** What a blunder looks like: aimless, wasteful, or frozen. */
function fumble(state: CzState, hero: HeroState): HeroAction | null {
  const options: (HeroAction | null)[] = [];

  const here = getRoom(state.board, hero.roomId);
  const doors = neighbors(state.board, here);
  const randomDoor = doors[randInt(state.rng, Math.max(1, doors.length))];
  if (randomDoor) options.push({ type: 'move', roomId: randomDoor.id });

  if (hero.bag.length < bagCapacity(hero)) options.push({ type: 'search' });

  // Freezing: the AP is simply not spent this decision.
  options.push(null);

  return options[randInt(state.rng, options.length)] ?? null;
}
