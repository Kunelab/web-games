import { zombieDef, ZOMBIES } from '../data.js';
import { GM_ORDERS, GM_UPGRADES, type GmAction } from '../engine.js';
import { shortestPath } from '../map.js';
import { chance } from '../rng.js';
import { activeHeroes, type CzState } from '../state.js';

/**
 * Game master bots, a skill ladder like the players':
 *
 * - The **newbie** spawns walkers at a random spawn room, buys nothing
 *   permanent, and some phases simply forgets to spend at all.
 * - The **aggressor** (advanced) converts every point into bodies at the
 *   nearest spawn room, immediately. Constant pressure, no compounding.
 * - The **economist** (expert) plays the brief the design gives a human GM:
 *   cheap blockers early, one rank of Carapace, then quality.
 * - The **master** does all of that and also reads the board: reinforcements
 *   land at the spawn room nearest the heroes' *next objective*, cutting the
 *   route instead of chasing the heels.
 *
 * All are asked for one action at a time until they return null; the shared
 * zombie AI then moves what is on the board, standing in for a GM who
 * micro-moves competently.
 */

export type GmMindset = 'newbie' | 'aggressor' | 'economist' | 'master';
export const gmMindsetNames: GmMindset[] = ['newbie', 'aggressor', 'economist', 'master'];

/** The spawn room the heroes will regret most: the one nearest to them. */
function bestSpawnRoom(state: CzState): string | null {
  const heroes = activeHeroes(state);
  const spawns = state.board.rooms.filter((room) => room.kind === 'spawn');
  if (heroes.length === 0 || spawns.length === 0) return spawns[0]?.id ?? null;

  const scored = spawns
    .map((room) => ({
      id: room.id,
      distance: Math.min(...heroes.map((hero) => shortestPath(state.board, room.id, hero.roomId)?.length ?? 99))
    }))
    .sort((a, b) => a.distance - b.distance);
  return scored[0]?.id ?? null;
}

/** Zombies close enough that one extra AP each turns into bites this phase. */
function hordeAtTheDoor(state: CzState): number {
  const heroes = activeHeroes(state);
  return Object.values(state.zombies).filter((zombie) =>
    heroes.some((hero) => {
      const path = shortestPath(state.board, zombie.roomId, hero.roomId);
      return path !== null && path.length <= 1;
    })
  ).length;
}

/** Best unit at most `budget`, biggest first: quality beats quantity late. */
function bestAffordable(budget: number): string | null {
  const affordable = [...ZOMBIES].filter((def) => def.cost <= budget).sort((a, b) => b.cost - a.cost);
  return affordable[0]?.id ?? null;
}

/** The spawn room that cuts the heroes' route: nearest to their next objective. */
function cuttingSpawnRoom(state: CzState): string | null {
  const spawns = state.board.rooms.filter((room) => room.kind === 'spawn');
  if (spawns.length === 0) return null;

  const keyRooms = state.board.rooms.filter((room) => room.hasKey).map((room) => room.id);
  const targets =
    keyRooms.length > 0
      ? keyRooms
      : [state.board.rooms.find((room) => room.kind === 'exit')?.id].filter((id): id is string => id !== undefined);
  if (targets.length === 0) return bestSpawnRoom(state);

  const scored = spawns
    .map((room) => ({
      id: room.id,
      distance: Math.min(...targets.map((target) => shortestPath(state.board, room.id, target)?.length ?? 99))
    }))
    .sort((a, b) => a.distance - b.distance);
  return scored[0]?.id ?? null;
}

export function decideGmAction(state: CzState, mindset: GmMindset): GmAction | null {
  if (state.phase !== 'enemy') return null;

  if (mindset === 'newbie') {
    // Some phases the points just sit there, unspent. Ask anyone who has taught
    // a friend to run the horde.
    if (chance(state.rng, 0.3)) return null;
    const spawns = state.board.rooms.filter((room) => room.kind === 'spawn');
    const room = spawns[Math.floor(spawns.length / 2)];
    if (room && state.gmBudget >= zombieDef('walker').cost) {
      return { type: 'gmSpawn', roomId: room.id, def: 'walker' };
    }
    return null;
  }

  const spawnRoom = mindset === 'master' ? cuttingSpawnRoom(state) : bestSpawnRoom(state);
  if (!spawnRoom) return null;

  // Rush pays whenever it converts directly into attacks.
  if (!state.gmRush && state.gmBudget >= GM_ORDERS.rush.cost + 2 && hordeAtTheDoor(state) >= 2) {
    return { type: 'gmOrder', order: 'rush' };
  }

  if (mindset === 'aggressor') {
    // Everything into bodies, cheapest pressure first: two runners over one brute.
    if (state.gmBudget >= zombieDef('runner').cost * 2) {
      return { type: 'gmSpawn', roomId: spawnRoom, def: 'runner' };
    }
    if (state.gmBudget >= zombieDef('walker').cost) {
      return { type: 'gmSpawn', roomId: spawnRoom, def: 'walker' };
    }
    return null;
  }

  /* The economist and the master share the wallet discipline; the master's
   * edge is where the bodies land (chosen above). A raid lasts ten turns, so
   * "late game" is turn six: the banking window is short and the upgrades have
   * to start paying by mid-raid. */

  // Turns 1–2: runners for tempo (they cross the map while heroes still loot),
  // banking whatever is left.
  if (state.turn <= 2) {
    const bodies = Object.values(state.zombies).length;
    if (bodies < state.turn + 3 && state.gmBudget >= zombieDef('runner').cost) {
      return { type: 'gmSpawn', roomId: spawnRoom, def: 'runner' };
    }
    return null;
  }

  // One rank of hide is the whole shopping list: it doubles a runner's life
  // against starting weapons and pays for itself within two phases. Deeper
  // compounding never matures in a ten-turn raid; bodies do.
  if (state.gmUpgrades.hide < 1 && state.gmBudget >= GM_UPGRADES.hide.cost(0) + zombieDef('runner').cost) {
    return { type: 'gmUpgrade', upgrade: 'hide' };
  }

  // The rest becomes quality, spent down to a small float.
  const unit = bestAffordable(state.gmBudget);
  if (unit) {
    return { type: 'gmSpawn', roomId: spawnRoom, def: unit };
  }

  return null;
}
