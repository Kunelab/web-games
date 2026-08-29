import { itemDef, weaponStats, zombieDef } from '../data.js';
import { BREACH_AP, type HeroAction } from '../engine.js';
import { getRoom, lineOfSight, neighbors, sealedNeighbours, shortestPath } from '../map.js';
import { rand, randInt } from '../rng.js';
import {
  activeHeroes,
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
  /**
   * Keeps formation: stays within reach of the team, closes up when the district
   * turns against them, and gives ground when badly hurt.
   *
   * The difference between four survivors and four people who happen to be in the
   * same district. Two rooms apart they can reach each other's fight in a turn;
   * five rooms apart they are four separate raids, each losing its own.
   */
  regroups: boolean;
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
    regroups: false,
    greed: 4
  },
  advanced: {
    blunder: 0.12,
    equips: 0.8,
    usesConsumables: true,
    kites: false,
    focusFire: false,
    coordinates: false,
    regroups: false,
    greed: 2
  },
  /** The calibration reference: the balance targets are defined against this. */
  expert: {
    blunder: 0,
    equips: 1,
    usesConsumables: true,
    kites: true,
    focusFire: true,
    coordinates: true,
    regroups: true,
    greed: 0
  },
  master: {
    blunder: 0,
    equips: 1,
    usesConsumables: true,
    kites: true,
    focusFire: true,
    coordinates: true,
    regroups: true,
    greed: 0
  }
};

export const skillNames = Object.keys(SKILLS);

/**
 * Expected damage of one attack with this weapon: dice × P(hit) × damage.
 *
 * Reads the *instance*, because rarity moves those numbers now: a bot that
 * scored the printed stats would swap a beautiful machete for a chipped one and
 * the bench would be measuring a mistake rather than the balance.
 */
export function weaponScore(item: ItemInstance, armor = 0): number {
  const weapon = weaponStats(itemDef(item.def), item.rarity);
  if (!weapon) return 0;
  const hitChance = (7 - weapon.accuracy) / 6;
  // Armour is per hit, so it is the *per-die* damage it eats. Scoring without it
  // would have every bot answer a colossus with a submachine gun, and then the
  // bench would be measuring a mistake rather than the design.
  const shield = weapon.pierce ? Math.floor(armor / 2) : armor;
  const perHit = Math.max(1, weapon.damage - shield);
  return weapon.dice * hitChance * perHit * (weapon.akimbo ? 1.15 : 1);
}

function bestHandScore(hero: HeroState): number {
  return Math.max(...hero.hands.map((item) => (item ? weaponScore(item) : 0)), 0);
}

/** What the thing in front of you shrugs off, 0 when nothing is in front of you. */
function armorOf(target?: ZombieState): number {
  return target ? zombieDef(target.def).armor : 0;
}

/** The hand an attack should use, best expected damage first. */
function bestHand(hero: HeroState, melee: boolean, target?: ZombieState): { hand: 0 | 1 | 2; score: number } | null {
  const options: { hand: 0 | 1 | 2; score: number }[] = [];
  const armor = armorOf(target);
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
    options.push({ hand, score: weaponScore(item, armor) });
  }

  if (left && right && left.def === right.def && itemDef(left.def).weapon?.akimbo) {
    const def = itemDef(left.def);
    if (def.weapon && def.weapon.melee === melee) {
      // The pair fires at the worse gun's quality, so score the worse gun.
      const worse = left.rarity <= right.rarity ? left : right;
      options.push({ hand: 2, score: weaponScore(worse, armor) * 2 });
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
/**
 * How badly somebody *else* needs this creature dead.
 *
 * Zero when it is nobody's problem but the shooter's, and rising with how hurt
 * the survivor it is standing on happens to be. This is the whole of team focus
 * fire: a creature in the room with a teammate on nine health is worth more dead
 * than a healthier target the shooter happens to be closer to, and without it two
 * survivors will cheerfully shoot past each other's fights all raid.
 */
function pressingOn(state: CzState, hero: HeroState, zombie: ZombieState): number {
  let worst = 0;
  for (const other of activeHeroes(state)) {
    if (other.playerId === hero.playerId || other.roomId !== zombie.roomId) continue;
    worst = Math.max(worst, 1 + (1 - other.hp / Math.max(1, other.maxHp)));
  }
  return worst;
}

function pickTarget(state: CzState, hero: HeroState, targets: ZombieState[], skill: SkillProfile): ZombieState | null {
  if (targets.length === 0) return null;
  const bossWanted = state.objectives.some((objective) => objective.kind === 'boss' && !objective.done);
  const punchAt = (target: ZombieState): number =>
    Math.max(bestHand(hero, true, target)?.score ?? 0, bestHand(hero, false, target)?.score ?? 0);

  const sorted = [...targets].sort((a, b) => {
    const aBoss = zombieDef(a.def).boss ? 1 : 0;
    const bBoss = zombieDef(b.def).boss ? 1 : 0;
    if (bossWanted && aBoss !== bBoss) return bBoss - aBoss;

    if (skill.focusFire) {
      const aKill = a.hp <= Math.ceil(punchAt(a)) ? 1 : 0;
      const bKill = b.hp <= Math.ceil(punchAt(b)) ? 1 : 0;
      if (aKill !== bKill) return bKill - aKill;
    }

    if (skill.focusFire) {
      // Then whoever is bleeding worst behind it.
      const aPress = pressingOn(state, hero, a);
      const bPress = pressingOn(state, hero, b);
      if (aPress !== bPress) return bPress - aPress;
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
      const mine = skill.coordinates ? assignedKey(state, hero, keyRooms) : null;
      return mine ?? nearestRoom(state, hero.roomId, keyRooms);
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

/* -------------------------------- formation ------------------------------- */

/**
 * Formation, and why there is no leash.
 *
 * The obvious version of this — keep everyone within a few rooms at all times —
 * was written, measured, and thrown away: it lost about a third of a point across
 * the whole bench and up to eighteen on the coordinating skill, whose whole plan
 * is to send survivors to different keys. Spreading out *is* the strategy in a
 * district you have to search, and holding a formation through a quiet raid buys
 * nothing but walking.
 *
 * What is worth doing is the opposite shape: no formation at all until something
 * is actually looking at them, and then closing right up. Below is that, and only
 * that.
 */

/** Shoulder to shoulder, once it is worth being shoulder to shoulder. */
const LEASH_OVERMATCHED = 1;

/** Below this share of their health, a survivor gives ground instead of trading. */
const HURT = 0.4;

/** And only when somebody is close enough for the retreat to reach them. */
const RESCUE_RANGE = 2;

/**
 * How many rooms of detour a hole in the wall has to save to be worth its turn.
 *
 * Three of those points are the breach itself; the fourth is the noise, which
 * lands in the room being opened and brings whatever is nearby to it.
 */
const BREACH_WORTH = 4;

/** How far out a survivor counts their friends, in rooms. */
const ODDS_RANGE = 2;

/**
 * How much visible menace it takes to break formation discipline open.
 *
 * One, meaning "more coming at us than we can answer". Measured in the same
 * ×10 scale on both sides: what a creature hits for against what a survivor hits
 * for, each carrying its remaining health as staying power.
 */
const GATHER_RATIO = 1.5;

/**
 * How far a survivor reads a threat as *theirs*, in rooms.
 *
 * Not as far as they can see. On an open district a street runs the width of the
 * map, so unbounded sight meant a survivor counted every creature on the far
 * pavement into their own odds and spent the raid huddling — measurably worse
 * than ignoring the whole question. What matters is what can reach them before
 * they can do anything about it, which is a turn's walk.
 */
const MENACE_RANGE = 3;

function roomsApart(state: CzState, from: string, to: string): number {
  if (from === to) return 0;
  return shortestPath(state.board, from, to)?.length ?? 99;
}

function nearestAlly(state: CzState, hero: HeroState): { ally: HeroState; distance: number } | null {
  let best: { ally: HeroState; distance: number } | null = null;
  for (const other of activeHeroes(state)) {
    if (other.playerId === hero.playerId) continue;
    const distance = roomsApart(state, hero.roomId, other.roomId);
    if (!best || distance < best.distance) best = { ally: other, distance };
  }
  return best;
}

/**
 * Whether what a survivor can see coming outweighs what is standing with them.
 *
 * Strength rather than headcount, because the two answers differ exactly where it
 * matters: six walkers is a busy afternoon and one abomination is a funeral, and
 * a rule that counts noses treats them the same. Each side is scored on what it
 * hits for plus the health it has left to keep hitting.
 *
 * Only what is *seen*. Partly because it is what the survivor could actually
 * react to — a bot flinching from a pack behind a wall is reading the state
 * rather than the room — and partly because a horde is usually somewhere, so
 * counting the unseen ones would have everybody permanently huddled.
 */
function overmatched(state: CzState, hero: HeroState): boolean {
  const sight = lineOfSight(state.board, hero.roomId, MENACE_RANGE);

  let menace = 0;
  for (const zombie of Object.values(state.zombies)) {
    if (!sight.has(zombie.roomId)) continue;
    const def = zombieDef(zombie.def);
    menace += def.damage + (zombie.bonusDmg ?? 0) + zombie.hp / 10;
  }
  if (menace === 0) return false;

  let guns = 0;
  for (const other of activeHeroes(state)) {
    if (roomsApart(state, hero.roomId, other.roomId) > ODDS_RANGE) continue;
    guns += bestHandScore(other) + other.hp / 10;
  }
  return menace > guns * GATHER_RATIO;
}

/**
 * Ground to give up, when giving ground is the play.
 *
 * Towards the team and away from the horde, and only into a room that is
 * actually empty — backing into something is not a retreat. Returns null when
 * standing still is already the best available, which is the common case in a
 * corner and the reason this cannot simply pick a neighbour.
 */
function fallBackRoom(state: CzState, hero: HeroState, ally: HeroState): string | null {
  const zombieRooms = Object.values(state.zombies).map((zombie) => zombie.roomId);
  const clear = neighbors(state.board, getRoom(state.board, hero.roomId)).filter(
    (room) => !zombieRooms.includes(room.id)
  );
  if (clear.length === 0) return null;

  const here = roomsApart(state, hero.roomId, ally.roomId);
  const scored = clear
    .map((room) => ({
      id: room.id,
      toAlly: roomsApart(state, room.id, ally.roomId),
      fromHorde: Math.min(...zombieRooms.map((other) => roomsApart(state, room.id, other)))
    }))
    .sort((a, b) => a.toAlly - b.toAlly || b.fromHorde - a.fromHorde);

  const best = scored[0];
  return best && best.toAlly < here ? best.id : null;
}

/**
 * Which key is this survivor's, on a table that divides the work.
 *
 * Handed out nearest-first rather than round-robin by seat, which is the whole
 * difference between splitting up and scattering: seat order has no idea where
 * anybody is standing, so it routinely sent the survivor by the front door
 * across the district for a key somebody else was already next to. Everyone runs
 * the same greedy pass over the same sorted crew, so they agree on the division
 * without needing to talk about it.
 *
 * Null for a survivor alone, or one who arrives after the keys are all spoken
 * for — both fall back to simply taking the nearest, which is correct for them.
 * A lone survivor obeying a rota is the worst of both: measured at ten points
 * below simply walking to the closest key.
 */
function assignedKey(state: CzState, hero: HeroState, keyRooms: string[]): string | null {
  const crew = activeHeroes(state)
    .map((other) => other.playerId)
    .sort();
  if (crew.length < 2) return null;

  const claimed = new Set<string>();
  for (const playerId of crew) {
    const who = state.heroes[playerId];
    if (!who) continue;
    let best: { room: string; distance: number } | null = null;
    for (const room of keyRooms) {
      if (claimed.has(room)) continue;
      const distance = roomsApart(state, who.roomId, room);
      if (!best || distance < best.distance || (distance === best.distance && room < best.room)) {
        best = { room, distance };
      }
    }
    if (!best) break;
    claimed.add(best.room);
    if (playerId === hero.playerId) return best.room;
  }
  return null;
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
  const vest = hero.bag.find((item) => itemDef(item.def).gear?.armor !== undefined);
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

  /**
   * The door is open: take it, and take it before anything else.
   *
   * More than half of every raid this bench loses is lost with the keys already
   * in and the side quests already done — the team wipes in a fight it had
   * finished needing to have, and not one survivor is outside when it ends. The
   * raid is won the moment somebody is out, so once the way is open, walking to
   * it is worth more than the creature in the room, the crate down the corridor
   * and the teammate two streets away.
   *
   * Placed above the fighting deliberately. A survivor beside an open exit with a
   * pack on them was choosing to swing at it, and swinging is how the pack wins:
   * stepping out ends their raid safely and banks the district for everybody,
   * which is the one thing a creature cannot answer.
   */
  const exitRoom = state.board.rooms.find((room) => room.kind === 'exit');
  const open =
    state.config.scenario === 'escape' && state.keysCollected >= state.config.keys && objectivesDone(state);
  if (open && exitRoom) {
    if (hero.roomId === exitRoom.id) return { type: 'exit' };
    const run = shortestPath(state.board, hero.roomId, exitRoom.id)?.[0];
    if (run) return { type: 'move', roomId: run };
  }

  /* ------------------------------- formation ------------------------------- */

  const mate = skill.regroups ? nearestAlly(state, hero) : null;
  const swarmed = mate !== null && overmatched(state, hero);

  /**
   * Badly hurt, and the odds are wrong: give ground rather than trade.
   *
   * Before the fight below, because the fight below has no opinion about how much
   * blood is left — it picks the best target in the room and swings, which at
   * fifteen health against three creatures is how a survivor becomes a casualty
   * and the rest of the team becomes one gun short. Only when outnumbered: a
   * hurt survivor against one walker should finish it, not lead it to the others.
   */
  if (mate && mate.distance <= RESCUE_RANGE && hero.hp <= hero.maxHp * HURT) {
    /**
     * Only backwards into somebody's arms, and only when the room is genuinely
     * losing.
     *
     * Retreat on its own measures *worse* than standing and fighting, and the
     * rules say why: creatures walk toward the nearest survivor with action
     * points of their own, so giving ground does not break contact — it spends a
     * point, keeps the wound, and hands the pack a free step. The only version
     * that pays is falling back onto a teammate near enough to make the next
     * exchange two guns against the same pack.
     */
    const pressing = Object.values(state.zombies).filter((zombie) => zombie.roomId === hero.roomId).length;
    if (pressing >= 2) {
      const ground = fallBackRoom(state, hero, mate.ally);
      if (ground) return { type: 'move', roomId: ground };
    }
  }

  // Something in the room: fight it (melee first, ranged as fallback).
  const inRoom = Object.values(state.zombies).filter((zombie) => zombie.roomId === hero.roomId);
  const roomTarget = pickTarget(state, hero, inRoom, skill);
  if (roomTarget) {
    const melee = bestHand(hero, true, roomTarget);
    const ranged = bestHand(hero, false, roomTarget);
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

  /**
   * Ranged pot-shots, and why they are fussier than they look.
   *
   * Anything in line of sight used to be fair game the moment the raid had a kill
   * objective open, which is most raids. Then windows arrived, sight lines roughly
   * doubled, and the bench fell eleven points on `cauchemar` and fourteen against an
   * aggressive game master. The cause was not the windows: it was that a bot would
   * stand in a shop spending every action point shooting walkers across the street
   * through the glass, making noise with each shot (which is what the horde homes in
   * on) and fetching no keys. Turns per raid went up by two and a half, and threat
   * compounds with turns.
   *
   * A person would not play that way, so the bench should not either. A shot at
   * something a room away is worth taking: it is arriving next turn and it will be in
   * melee with you if you let it. A shot at something three rooms away, through a
   * window, while the key is unfetched, is a way of losing slowly.
   */
  const ranged = bestHand(hero, false);
  if (ranged) {
    const weapon = hero.hands[ranged.hand === 2 ? 0 : ranged.hand];
    const range = weapon ? (itemDef(weapon.def).weapon?.range ?? 0) : 0;
    const sight = lineOfSight(state.board, hero.roomId, range);
    const killsWanted =
      state.config.scenario === 'purge' ||
      state.objectives.some((o) => (o.kind === 'kills' || o.kind === 'boss') && !o.done);
    /** Nothing left to walk towards: now a pot-shot is the best use of the turn. */
    const idle = goalRoom(state, hero, skill) === null;
    /** How far a bot will reach for a target it cannot be reached by. */
    const patience = idle || mindset.aggression >= 0.8 ? range : 1;

    /**
     * Covering fire reaches as far as the gun does.
     *
     * `patience` deliberately keeps a survivor from spending the raid shooting at
     * things across the district — but a creature standing on a teammate is not
     * that. It is the one shot nobody else can take, and the reason to carry a
     * rifle at all, so it is exempt from the discipline the rest of the range is
     * held to.
     */
    const covering = new Set(
      activeHeroes(state)
        .filter((other) => other.playerId !== hero.playerId)
        .map((other) => other.roomId)
    );
    const visible = Object.values(state.zombies).filter((zombie) => {
      const away = sight.get(zombie.roomId) ?? 99;
      return away <= patience || (covering.has(zombie.roomId) && away <= range);
    });
    const target = pickTarget(state, hero, visible, skill);
    if (target && (killsWanted || mindset.aggression >= 0.5)) {
      return { type: 'attack', zombieId: target.id, hand: ranged.hand };
    }
  }

  /**
   * Outnumbered and scattered: close right up, and let the mission wait.
   *
   * The only case where formation is allowed to override the objective, because
   * it is the only case where the objective is not the thing that decides the
   * raid. Four survivors fighting a pack in sequence, one room apart, lose to a
   * pack the same four would beat standing together — so the walk back is not a
   * detour, it is the fight.
   *
   * Deliberately *not* applied to a team that is merely spread out. A leash that
   * outranks the mission means the key-fetchers argue with it every turn: whoever
   * walks toward a key breaks the leash, walks back, and the raid rots while
   * everybody keeps formation beautifully. The plain distance is handled below,
   * where it costs a crate rather than the objective.
   */
  if (mate && swarmed && mate.distance > LEASH_OVERMATCHED) {
    const closing = shortestPath(state.board, hero.roomId, mate.ally.roomId)?.[0];
    if (closing) return { type: 'move', roomId: closing };
  }

  // Loot while it is quiet and the arsenal is still wanting. Greed pads the
  // budget: the newbie opens one more crate long after the machete question is
  // settled.
  const searchesPending = state.objectives.some((o) => o.kind === 'searches' && !o.done);
  /**
   * A full bag stops a search — unless the dealer's perk turns it into a swap.
   *
   * Without this clause `brocanteur` is a dead perk on the bench: a bot would never
   * search once its bag filled up, so the whole point of the perk (the back half of
   * a raid stops being unable to look at anything) would never be exercised and the
   * measured table would be strictly weaker than the one a human plays. Same class
   * of correction as the room-stock check above.
   */
  const canCarry = hero.bag.length < bagCapacity(hero) || hero.loadout.includes('brocanteur');
  /**
   * And nobody shops once the door is open.
   *
   * The raid is won the moment somebody is outside, so once the keys are in and
   * the side quests are done every remaining action point is either a step
   * towards the exit or a gift to the horde — and the horde compounds with the
   * turn count, so the crate is not free, it is priced in everybody's survival.
   * Without this a survivor stands beside the way out working through a gear
   * target that stopped mattering several turns ago.
   */
  const wayOut =
    state.config.scenario === 'escape' && state.keysCollected >= state.config.keys && objectivesDone(state);
  const wantsGear =
    !wayOut && (searchesPending || (handScore < mindset.gearGoal && hero.searches < mindset.maxSearches + skill.greed));
  const wantsLoot = canCarry && wantsGear;

  /**
   * A full bag is a decision, not a wall.
   *
   * The old behaviour was to stop looting entirely, which quietly capped every
   * bot's gear at whatever the first five crates happened to be — a survivor
   * carrying two spare pistols would walk past an armoury rather than put one
   * down. Dropping is free, so the only question is what is genuinely redundant:
   * a weapon that scores below what is already in both hands. Medicine, armour
   * and adrenaline are never dropped; they are why the bag exists.
   */
  if (!canCarry && wantsGear && getRoom(state.board, hero.roomId).finds > 0) {
    const deadWeight = hero.bag
      .filter((item) => itemDef(item.def).kind === 'weapon' && weaponScore(item) < handScore)
      .sort((a, b) => weaponScore(a) - weaponScore(b))[0];
    if (deadWeight) return { type: 'drop', uid: deadWeight.uid };
  }

  if (wantsLoot) {
    /**
     * Rooms run dry, so wanting to loot and being able to are two questions now.
     *
     * Both halves matter to the bench. Searching a spent room is an action the
     * engine refuses, so without the first check a bot burns its turn on nothing
     * and the simulator measures a table that never loots. And a bot that simply
     * gives up when the room is empty would under-report the rule badly, because
     * walking to a fresh room is exactly what a player does — the behaviour the
     * whole change exists to produce. A bot that cannot do it is measuring the old
     * game with the new rule's costs.
     */
    if (getRoom(state.board, hero.roomId).finds > 0) {
      return { type: 'search' };
    }

    const step = stepTowardsLoot(state, hero, skill);
    if (step) return { type: 'move', roomId: step };
  }

  // Advance the mission.
  const goal = goalRoom(state, hero, skill);
  if (goal && goal !== hero.roomId) {
    /**
     * A wall, when the way round it is long enough to be worth a sledgehammer.
     *
     * Breaking through costs the whole turn — three points, which is every point a
     * survivor has — so it only pays when the detour it removes is longer than the
     * turn it costs, plus something for the noise it makes. Four rooms is that
     * line. Below it, walking is simply better, which is why a bot that breached
     * whenever it could would be a worse bot.
     *
     * Checked before the walk rather than after, because the walk is what it
     * replaces: one turn spent opening the wall against four spent going round.
     */
    const detour = roomsApart(state, hero.roomId, goal);
    if (hero.ap >= BREACH_AP && detour >= BREACH_WORTH) {
      for (const sealed of sealedNeighbours(state.board, getRoom(state.board, hero.roomId))) {
        if (detour - (1 + roomsApart(state, sealed.id, goal)) >= BREACH_WORTH) {
          return { type: 'breach', roomId: sealed.id };
        }
      }
    }

    const path = shortestPath(state.board, hero.roomId, goal);
    const step = path?.[0];
    if (step) return { type: 'move', roomId: step };
  }

  return null;
}

/**
 * One step towards somewhere still worth searching.
 *
 * Scored rather than nearest-first: a pharmacy two rooms away beats a corridor next
 * door, which is the judgement the loot bonus was added to create in the first
 * place. Distance dominates all the same — the horde is closing, and a bot that
 * crosses a district for one extra rarity rank is not playing well.
 *
 * Only rooms the team has seen. A bot allowed to path towards loot it has no way of
 * knowing about would quietly measure a game with no fog in it.
 */
function stepTowardsLoot(state: CzState, hero: HeroState, skill: SkillProfile): string | null {
  const explored = new Set(state.explored);
  let best: { id: string; score: number } | null = null;

  for (const room of state.board.rooms) {
    if (room.finds <= 0) continue;
    if (room.id === hero.roomId) continue;
    if (!explored.has(room.id)) continue;

    const distance = shortestPath(state.board, hero.roomId, room.id)?.length ?? 99;
    if (distance > LOOT_DETOUR) continue;

    // A rank of loot is worth about one step to a greedy bot and rather less to a
    // careful one, which is the same trade `greed` already expresses elsewhere.
    const score = -distance + room.loot * (1 + skill.greed * 0.5);
    if (!best || score > best.score) best = { id: room.id, score };
  }

  if (!best) return null;
  return shortestPath(state.board, hero.roomId, best.id)?.[0] ?? null;
}

/**
 * How far a bot will walk purely to find somewhere with something left in it.
 *
 * Two, not six. Six was the first guess and the bench caught it: on a table forced
 * to open badly it cost nineteen points of win rate, because a survivor whose hands
 * never improve keeps wanting loot for its whole search budget and, with rooms
 * running dry, spends that budget *walking*. Six rooms of detour is most of a turn
 * for one crate.
 *
 * Two is "the next room, or the one after it", which is what a person does — you
 * pick over what you pass through, you do not tour a district for a bat. The bad-luck
 * case is the one the documentation already flags as where raids are actually lost,
 * so it is the one a movement rule has to be careful around.
 */
const LOOT_DETOUR = 2;

/** What a blunder looks like: aimless, wasteful, or frozen. */
function fumble(state: CzState, hero: HeroState): HeroAction | null {
  const options: (HeroAction | null)[] = [];

  const here = getRoom(state.board, hero.roomId);
  const doors = neighbors(state.board, here);
  const randomDoor = doors[randInt(state.rng, Math.max(1, doors.length))];
  if (randomDoor) options.push({ type: 'move', roomId: randomDoor.id });

  // A fumble may waste a point; it should not pick an action the engine refuses
  // outright, which would silently turn a blunder into a freeze.
  if (hero.bag.length < bagCapacity(hero) && here.finds > 0) options.push({ type: 'search' });

  // Freezing: the AP is simply not spent this decision.
  options.push(null);

  return options[randInt(state.rng, options.length)] ?? null;
}
