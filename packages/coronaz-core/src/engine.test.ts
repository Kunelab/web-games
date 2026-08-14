import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { weaponFor } from './combat.js';
import { defaultGameConfig, gameConfigSchema } from './config.js';
import {
  archetypeOf,
  BIOME_IDS,
  BIOMES,
  itemFor,
  itemsOfBiome,
  roleOf,
  zombieFor,
  zombiesOfBiome
} from './content/registry.js';
import { ARCHETYPES, expectedDamage, ITEM_ROLES, POWER_TOLERANCE } from './content/roles.js';
import { HEROES, itemDef, rarityRange, weaponStats } from './data.js';
import {
  activateNextZombie,
  applyGmAction,
  applyHeroAction,
  beginEnemyPhase,
  endEnemyPhase,
  heroPhaseDone,
  startGame,
  startHeroPhase
} from './engine.js';
import { rollLoot } from './engine.js';
import {
  cellIndex,
  connectionsOf,
  distancesFrom,
  edgeAt,
  getRoom,
  lineOfSight,
  MAX_ROOM_CELLS,
  neighbors,
  shortestPath
} from './map.js';
import { generateBoard, LAYOUT_IDS } from './mapgen/index.js';
import { toView } from './protocol.js';
import { seedRng } from './rng.js';
import { createGame, joinHero, makeItem, spawnZombie, type CzState } from './state.js';

function newGame(configOverrides: Record<string, unknown> = {}, seed = 42): CzState {
  return createGame({
    code: 'TEST1',
    hostToken: 'host',
    gmToken: 'gm',
    hostUserId: null,
    // Side quests are off unless a test is about them: they seed extra zombies
    // and gate the exit, which turns unrelated assertions into riddles.
    config: gameConfigSchema.parse({ secondaryObjectives: 0, ...configOverrides }),
    seed
  });
}

/** Every layout, every time: a generator that only works sometimes is a bug. */
const LAYOUT_SEEDS = [1, 7, 99, 12345, 987654, 31337, 4217, 90210];

function boardsAcrossLayouts(seeds = LAYOUT_SEEDS, overrides: Record<string, unknown> = {}) {
  const boards: { layout: string; seed: number; board: ReturnType<typeof generateBoard> }[] = [];
  for (const layout of LAYOUT_IDS) {
    for (const seed of seeds) {
      const config = gameConfigSchema.parse({ layout, ...overrides });
      boards.push({ layout, seed, board: generateBoard(seedRng(seed), config) });
    }
  }
  return boards;
}

describe('board generation', () => {
  it('is fully connected, whatever the seed and whatever the layout', () => {
    for (const { layout, seed, board } of boardsAcrossLayouts()) {
      const first = board.rooms[0];
      assert(first);
      const reached = distancesFrom(board, first.id);
      assert.equal(
        reached.size,
        board.rooms.length,
        `${layout} seed ${seed} stranded ${board.rooms.length - reached.size} room(s)`
      );
    }
  });

  it('places every objective, and places the way out outdoors', () => {
    for (const { layout, seed, board } of boardsAcrossLayouts()) {
      const of = (kind: string) => board.rooms.filter((room) => room.kind === kind);
      assert.equal(of('start').length, 1, `${layout} ${seed}: one start`);
      assert.equal(of('exit').length, 1, `${layout} ${seed}: one exit`);
      assert.equal(of('spawn').length, defaultGameConfig.spawnRooms);
      assert.equal(board.rooms.filter((room) => room.hasKey).length, defaultGameConfig.keys);

      // You arrive from the street and you leave by another one.
      const start = of('start')[0];
      const exit = of('exit')[0];
      assert(start?.outdoor, `${layout} ${seed}: the raid starts outdoors`);
      assert(exit?.outdoor, `${layout} ${seed}: the way out is outdoors`);
      assert.notEqual(start.id, exit.id);
    }
  });

  it('builds an outdoors, and buildings you can walk into', () => {
    for (const { layout, seed, board } of boardsAcrossLayouts()) {
      const outdoor = board.rooms.filter((room) => room.outdoor);
      const indoor = board.rooms.filter((room) => !room.outdoor);
      assert(outdoor.length > 0, `${layout} ${seed}: nowhere outside`);
      assert(indoor.length > 0, `${layout} ${seed}: nothing to go inside`);

      // Every building is enterable, and every one of its rooms is reachable
      // without leaving it — a flat you can only cross by going back outside is
      // not a flat.
      const zones = new Set(indoor.map((room) => room.zone));
      const start = board.rooms.find((room) => room.kind === 'start');
      assert(start);
      const reached = distancesFrom(board, start.id);
      for (const zone of zones) {
        const rooms = indoor.filter((room) => room.zone === zone);
        assert(
          rooms.every((room) => reached.has(room.id)),
          `${layout} ${seed}: building ${zone} is not reachable`
        );
      }
    }
  });

  it('gives a building one of each room it should have one of', () => {
    // The three-fridges bug, tested at its root: a dwelling has one kitchen, and
    // a house has one bathroom, because the programme says so.
    for (const { layout, seed, board } of boardsAcrossLayouts()) {
      const zones = new Set(board.rooms.filter((room) => !room.outdoor).map((room) => room.zone));
      for (const zone of zones) {
        const rooms = board.rooms.filter((room) => room.zone === zone);
        // Count *spaces*, not rooms: one kitchen may be two arch-joined cells.
        const spaces = new Set(rooms.map((room) => `${room.program}:${room.hue}:${room.floor}`));
        assert(spaces.size > 0, `${layout} ${seed}: empty building`);
        const kitchens = rooms.filter((room) => room.program === 'kitchen');
        const dwellings = new Set(kitchens.map((room) => room.floor)).size;
        assert(
          kitchens.length === 0 || dwellings <= 4,
          `${layout} ${seed}: building ${zone} has ${kitchens.length} kitchen rooms`
        );
      }
    }
  });

  it('keeps every room within the cell cap so a move stays a move', () => {
    for (const { layout, seed, board } of boardsAcrossLayouts()) {
      for (const room of board.rooms) {
        assert(
          room.cells.length >= 1 && room.cells.length <= MAX_ROOM_CELLS,
          `${layout} ${seed}: room ${room.id} owns ${room.cells.length} cells`
        );
      }
    }
  });

  it('makes open space out of arch clusters rather than giant rooms', () => {
    // The claustrophobia fix, measured: the biggest *contiguous open volume* (rooms
    // joined only by arches) has to be much larger than the biggest room.
    let biggestCluster = 0;
    for (const { board } of boardsAcrossLayouts([11, 22, 33])) {
      const seen = new Set<string>();
      for (const room of board.rooms) {
        if (seen.has(room.id)) continue;
        let cells = 0;
        const queue = [room];
        seen.add(room.id);
        while (queue.length > 0) {
          const current = queue.pop();
          if (!current) break;
          cells += current.cells.length;
          for (const link of connectionsOf(board, current)) {
            if (link.kind !== 'arch' || seen.has(link.roomId)) continue;
            seen.add(link.roomId);
            queue.push(getRoom(board, link.roomId));
          }
        }
        biggestCluster = Math.max(biggestCluster, cells);
      }
    }
    assert(
      biggestCluster >= MAX_ROOM_CELLS * 3,
      `the most open space anywhere is ${biggestCluster} cells; that is still a warren`
    );
  });

  it('is deterministic for a given seed', () => {
    const a = generateBoard(seedRng(1234), defaultGameConfig);
    const b = generateBoard(seedRng(1234), defaultGameConfig);
    assert.deepEqual(a, b);
  });

  it('pathfinds between any two rooms', () => {
    const board = generateBoard(seedRng(5), defaultGameConfig);
    const start = board.rooms.find((room) => room.kind === 'start');
    const exit = board.rooms.find((room) => room.kind === 'exit');
    assert(start && exit);

    const path = shortestPath(board, start.id, exit.id);
    assert(path !== null && path.length > 0);
    assert.equal(path.at(-1), exit.id);
  });

  it('names every room once', () => {
    // An id that collides silently rewires the board: the room index keeps one of
    // the two, and half the doors then lead somewhere that is not there.
    for (const { layout, seed, board } of boardsAcrossLayouts()) {
      const ids = new Set(board.rooms.map((room) => room.id));
      assert.equal(ids.size, board.rooms.length, `${layout} ${seed}: duplicate room id`);
    }
  });

  it('carves the grid into rooms with nothing left over and nothing shared', () => {
    for (const { layout, seed, board } of boardsAcrossLayouts([3, 41, 777, 90210])) {
      const cells = board.width * board.height;

      const owner = new Map<number, string>();
      for (const room of board.rooms) {
        for (const cell of room.cells) {
          assert(!owner.has(cell), `${layout} ${seed}: cell ${cell} claimed twice`);
          owner.set(cell, room.id);
          assert.equal(board.cellRoom[cell], room.id, 'the cell index agrees with the room');
        }
      }
      assert.equal(owner.size, cells, `${layout} ${seed} left a cell unassigned`);
      assert.equal(board.edgeRight.length, cells);
      assert.equal(board.edgeDown.length, cells);
    }
  });

  it('produces big rooms, arches and closed walls all at once', () => {
    // Over a handful of seeds, because any single map may happen to be shy.
    let big = 0;
    let arches = 0;
    let walls = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const board = generateBoard(seedRng(seed), defaultGameConfig);
      big += board.rooms.filter((room) => room.cells.length >= 2).length;
      arches += [...board.edgeRight, ...board.edgeDown].filter((code) => code === 'A').length;
      walls += [...board.edgeRight, ...board.edgeDown].filter((code) => code === '#').length;
    }
    assert(big > 0, 'no room bigger than one cell');
    assert(arches > 0, 'no open-plan connections');
    assert(walls > 0, 'no closed walls');
  });

  it('inner boundaries of one room are open, and only they are', () => {
    const board = generateBoard(seedRng(2024), defaultGameConfig);
    for (let y = 0; y < board.height; y++) {
      for (let x = 0; x < board.width; x++) {
        const cell = cellIndex(board, x, y);
        for (const [side, nx, ny] of [
          ['right', x + 1, y],
          ['down', x, y + 1]
        ] as const) {
          if (nx >= board.width || ny >= board.height) continue;
          const same = board.cellRoom[cell] === board.cellRoom[cellIndex(board, nx, ny)];
          assert.equal(
            edgeAt(board, cell, side) === 'open',
            same,
            `${side} boundary of cell ${cell} disagrees with room membership`
          );
        }
      }
    }
  });

  it('sees across an open-plan room without spending range', () => {
    // A pistol reaches one room; an arch-joined pair is two rooms, so the far
    // side is exactly at the edge of its reach however many cells wide it is.
    const board = generateBoard(seedRng(11), defaultGameConfig);
    const pairs = board.rooms
      .map((room) => ({ room, links: connectionsOf(board, room).filter((c) => c.kind === 'arch') }))
      .filter((entry) => entry.links.length > 0);
    const sample = pairs[0];
    assert(sample, 'seed 11 should produce at least one arch');

    const far = sample.links[0]?.roomId;
    assert(far);
    assert.equal(lineOfSight(board, sample.room.id, 0).has(far), false, 'range 0 stays home');
    assert(lineOfSight(board, sample.room.id, 1).has(far), 'one room of range crosses the arch');
  });
});

describe('hero actions', () => {
  it('moves through doors and refuses walls', () => {
    const state = newGame({ startingZombies: 0 });
    const { hero } = joinHero(state, 'Testeuse', undefined);
    // Pinned: seating is random, and Nadia's first move of the turn is free, so
    // an unpinned hero makes this a test of the dice rather than of the rule.
    hero.heroId = 'charles';
    startGame(state, 0);

    const room = getRoom(state.board, hero.roomId);
    const next = neighbors(state.board, room)[0];
    assert(next);

    const good = applyHeroAction(state, hero.playerId, { type: 'move', roomId: next.id });
    assert.equal(good.ok, true);
    assert.equal(hero.ap, 2);

    const wall = state.board.rooms.find(
      (candidate) =>
        !neighbors(state.board, getRoom(state.board, hero.roomId)).some((n) => n.id === candidate.id) &&
        candidate.id !== hero.roomId
    );
    assert(wall);
    const bad = applyHeroAction(state, hero.playerId, { type: 'move', roomId: wall.id });
    assert.equal(bad.ok, false);
  });

  it('searching finds loot, costs AP, and Chuck gets one free', () => {
    const state = newGame({ startingZombies: 0 });
    const { hero } = joinHero(state, 'Chuck', undefined);
    hero.heroId = 'chuck';
    startGame(state, 0);

    const free = applyHeroAction(state, hero.playerId, { type: 'search' });
    assert.equal(free.ok, true);
    assert(free.loot);
    assert.equal(hero.ap, 3, 'the scavenger’s first search is free');

    const paid = applyHeroAction(state, hero.playerId, { type: 'search' });
    assert.equal(paid.ok, true);
    assert.equal(hero.ap, 2);
    assert.equal(hero.bag.length, 2);
  });

  it('equip swaps in place and never loses an item', () => {
    const state = newGame({ startingZombies: 0 });
    const { hero } = joinHero(state, 'Testeuse', undefined);
    startGame(state, 0);

    const pistol = makeItem(state, 'pistol');
    hero.bag.push(pistol);
    const before = hero.hands[0];
    assert(before);

    const result = applyHeroAction(state, hero.playerId, { type: 'equip', uid: pistol.uid, slot: 'hand0' });
    assert.equal(result.ok, true);
    assert.equal(hero.hands[0]?.uid, pistol.uid);
    // The displaced starting weapon went where the pistol came from: the bag.
    assert(hero.bag.some((item) => item.uid === before.uid));

    const vest = makeItem(state, 'vest');
    hero.bag.push(vest);
    const wrong = applyHeroAction(state, hero.playerId, { type: 'equip', uid: vest.uid, slot: 'hand1' });
    assert.equal(wrong.ok, false, 'gear does not go in a hand');
  });

  it('a flamethrower kill is credited and spills onto the room', () => {
    const state = newGame({ startingZombies: 0 });
    const { hero } = joinHero(state, 'Pyro', undefined);
    startGame(state, 0);

    // Accuracy 1: every die hits. Damage 10: everything dies. Deterministic.
    hero.hands = [makeItem(state, 'flamethrower'), null];
    const target = spawnZombie(state, hero.roomId, 'walker');

    const result = applyHeroAction(state, hero.playerId, { type: 'attack', zombieId: target.id, hand: 0 });
    assert.equal(result.ok, true);
    assert.equal(state.zombies[target.id], undefined);
    assert.equal(hero.kills, 1);
    assert.equal(state.killsTotal, 1);
  });

  it('keys gate the exit and escaping wins', () => {
    const state = newGame({ startingZombies: 0, keys: 1 });
    const { hero } = joinHero(state, 'Fuyarde', undefined);
    startGame(state, 0);

    const exit = state.board.rooms.find((room) => room.kind === 'exit');
    assert(exit);
    hero.roomId = exit.id;

    const locked = applyHeroAction(state, hero.playerId, { type: 'exit' });
    assert.equal(locked.ok, false, 'the exit is locked until the keys are in');

    const keyRoom = state.board.rooms.find((room) => room.hasKey);
    assert(keyRoom);
    hero.roomId = keyRoom.id;
    const pickup = applyHeroAction(state, hero.playerId, { type: 'pickupKey' });
    assert.equal(pickup.ok, true);

    hero.roomId = exit.id;
    const out = applyHeroAction(state, hero.playerId, { type: 'exit' });
    assert.equal(out.ok, true);
    assert.equal(state.phase, 'won');
  });
});

describe('enemy phase', () => {
  it('the AI closes in and attacks', () => {
    const state = newGame({ startingZombies: 0, heroPhaseSeconds: 0 });
    const { hero } = joinHero(state, 'Appât', undefined);
    startGame(state, 0);

    // A runner two rooms away: 2 AP reach the hero's room or bite on arrival.
    const path = state.board.rooms.filter((room) => room.id !== hero.roomId);
    const room = path.find((candidate) => {
      const steps = shortestPath(state.board, candidate.id, hero.roomId);
      return steps !== null && steps.length === 2;
    });
    assert(room);
    const runner = spawnZombie(state, room.id, 'runner');

    applyHeroAction(state, hero.playerId, { type: 'ready' });
    assert.equal(heroPhaseDone(state), true);
    beginEnemyPhase(state, 0);

    const more = activateNextZombie(state);
    assert.equal(more, false, 'one zombie, fully activated');
    // Two rooms of distance, two AP: it is either on the hero or biting them.
    const closed = state.zombies[runner.id]?.roomId === hero.roomId;
    const bit = hero.hp < hero.maxHp;
    assert(closed || bit);
  });

  it('the game master pays for spawns and cannot overdraw', () => {
    const state = newGame({ mode: 'gm', reinforcement: 0, startingZombies: 0 });
    const { hero } = joinHero(state, 'Proie', undefined);
    startGame(state, 0);
    applyHeroAction(state, hero.playerId, { type: 'ready' });
    beginEnemyPhase(state, 0);

    const opening = state.gmBudget;
    assert(opening >= 2 && opening < 8, `turn-one income is modest, got ${opening}`);
    const spawnRoom = state.board.rooms.find((room) => room.kind === 'spawn');
    assert(spawnRoom);

    const boss = applyGmAction(state, { type: 'gmSpawn', roomId: spawnRoom.id, def: 'boss' });
    assert.equal(boss.ok, false, 'a colossus is beyond a turn-one purse');

    const walker = applyGmAction(state, { type: 'gmSpawn', roomId: spawnRoom.id, def: 'walker' });
    assert.equal(walker.ok, true);
    assert.equal(state.gmBudget, opening - 1);
  });
});

describe('objectives and escalation', () => {
  it('a boss objective seeds a boss and gates the exit', () => {
    // Seed chosen so the drawn objective is the boss hunt.
    let state = newGame({ secondaryObjectives: 1, keys: 1, startingZombies: 0 });
    for (let seed = 1; !state.objectives.some((o) => o.kind === 'boss'); seed++) {
      state = newGame({ secondaryObjectives: 1, keys: 1, startingZombies: 0 }, seed);
    }

    const boss = Object.values(state.zombies).find((zombie) => zombie.def === 'boss');
    assert(boss, 'the objective spawned its boss');

    const { hero } = joinHero(state, 'Chasseuse', undefined);
    startGame(state, 0);

    // Keys done, objective not: the door stays shut.
    const keyRoom = state.board.rooms.find((room) => room.hasKey);
    assert(keyRoom);
    hero.roomId = keyRoom.id;
    applyHeroAction(state, hero.playerId, { type: 'pickupKey' });

    const exit = state.board.rooms.find((room) => room.kind === 'exit');
    assert(exit);
    hero.roomId = exit.id;
    hero.ap = 3;
    const blocked = applyHeroAction(state, hero.playerId, { type: 'exit' });
    assert.equal(blocked.ok, false, 'the exit waits for the objective');

    // Kill the boss deterministically, then leave.
    hero.hands = [makeItem(state, 'flamethrower'), null];
    boss.roomId = hero.roomId;
    while (state.zombies[boss.id]) {
      hero.ap = 3;
      applyHeroAction(state, hero.playerId, { type: 'attack', zombieId: boss.id, hand: 0 });
    }
    assert.equal(
      state.objectives.every((objective) => objective.done),
      true
    );

    hero.ap = 3;
    const out = applyHeroAction(state, hero.playerId, { type: 'exit' });
    assert.equal(out.ok, true);
    assert.equal(state.phase, 'won');
  });

  it('a screamer summons when it activates', () => {
    const state = newGame({ startingZombies: 0 });
    const { hero } = joinHero(state, 'Appât', undefined);
    startGame(state, 0);

    const screamer = spawnZombie(state, hero.roomId, 'screamer');
    applyHeroAction(state, hero.playerId, { type: 'ready' });
    beginEnemyPhase(state, 0);
    activateNextZombie(state);

    const walkers = Object.values(state.zombies).filter((zombie) => zombie.def === 'walker');
    assert.equal(walkers.length, 1, 'one walker bred by the scream');
    assert(state.zombies[screamer.id], 'the screamer itself survives');
  });

  it('late spawns arrive as elites, endless never wins', () => {
    const state = newGame({ scenario: 'endless', startingZombies: 0, escalation: 2 });
    joinHero(state, 'Increvable', undefined);
    startGame(state, 0);

    state.turn = 15;
    const late = spawnZombie(state, state.board.rooms[0]?.id ?? '', 'walker');
    assert(late.maxHp > 1, 'a turn-15 walker is not a turn-1 walker');

    // Endless has no win path: survival extraction never fires.
    beginEnemyPhase(state, 0);
    endEnemyPhase(state, 0);
    assert.equal(state.phase, 'heroes');
  });

  it('loot fatigue drags a veteran scavenger back to common finds', () => {
    const state = newGame({ startingZombies: 0, lootLuck: 2 });
    const { hero } = joinHero(state, 'Pilleuse', undefined);
    startGame(state, 0);

    hero.searches = 12;
    // Luck 2 minus fatigue 3: every roll lands at or below its raw tier.
    for (let i = 0; i < 20; i++) {
      const roll = rollLoot(state, hero);
      assert(roll.def.tier <= 4, `fatigued loot stays humble, got tier ${roll.def.tier}`);
    }
  });

  it('a dropped item rolls its own rarity, never more than one rank out', () => {
    const state = newGame({ startingZombies: 0 });
    const { hero } = joinHero(state, 'Pilleuse', undefined);
    startGame(state, 0);

    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const roll = rollLoot(state, hero);
      const range = rarityRange(roll.def.tier);
      assert(
        roll.rarity >= range.min && roll.rarity <= range.max,
        `${roll.def.id} (tier ${roll.def.tier}) dropped at rarity ${roll.rarity}`
      );
      if (roll.rarity !== roll.def.tier) seen.add(roll.rarity - roll.def.tier);
      hero.searches = 0; // fatigue is not what this test is about
    }
    assert.deepEqual([...seen].sort(), [-1, 1], 'both a worse and a better roll happen');
  });

  it('rarity moves a weapon’s numbers, and the fight reads them', () => {
    const bat = itemDef('bat');
    // The bat hits on 3+; a rank up buys the threshold, a rank down sells it.
    assert.equal(weaponStats(bat, 1)?.accuracy, 3);
    assert.equal(weaponStats(bat, 2)?.accuracy, 2);
    // A chipped flamethrower has accuracy to give up, so it gives that up first
    // and keeps its terrifying damage.
    const flamer = itemDef('flamethrower');
    assert.equal(weaponStats(flamer, 4)?.accuracy, 2);
    assert.equal(weaponStats(flamer, 4)?.damage, 100);

    // Where the threshold has nowhere left to go, the rank pays in damage. No
    // item in the table is at either bound, and the point is that none can be.
    const perfect = { ...flamer, tier: 4 as const };
    assert.equal(weaponStats(perfect, 5)?.damage, 110);
    const hopeless = { ...flamer, weapon: { ...flamer.weapon!, accuracy: 5 } };
    assert.equal(weaponStats(hopeless, 4)?.damage, 90);

    // And the resolver uses the instance, not the printout: a legendary sniper
    // hits on 2+, so this shot cannot miss what a common one would.
    const state = newGame({ startingZombies: 0 });
    const { hero } = joinHero(state, 'Tireuse', undefined);
    startGame(state, 0);
    hero.hands = [makeItem(state, 'sniper', 5), null];
    const chosen = weaponFor(hero, 0);
    assert(!('error' in chosen));
    assert.equal(chosen.weapon.accuracy, 2);
    assert.equal(chosen.rarity, 5);
  });

  it('akimbo shoots as well as its worse half', () => {
    const state = newGame({ startingZombies: 0 });
    const { hero } = joinHero(state, 'Deux mains', undefined);
    startGame(state, 0);

    hero.hands = [makeItem(state, 'pistol', 3), makeItem(state, 'pistol', 1)];
    const chosen = weaponFor(hero, 2);
    assert(!('error' in chosen));
    assert.equal(chosen.rarity, 1);
    // Two dice printed, doubled by akimbo, at the chipped pistol's accuracy.
    assert.equal(chosen.dice, 4);
    assert.equal(chosen.weapon.accuracy, 5);
  });
});

describe('biomes', () => {
  it('every biome fills every role and every archetype', () => {
    for (const biome of BIOMES) {
      for (const role of ITEM_ROLES) {
        const item = itemFor(biome.id, role.id);
        assert.equal(item.kind, role.kind, `${biome.id}/${role.id} is the wrong kind of thing`);
        assert.equal(item.tier, role.tier, `${biome.id}/${role.id} moved its own tier`);
        assert.equal(roleOf(item.id), role.id, 'the role resolves back from the item');
        if (role.kind === 'weapon') assert(item.weapon, `${biome.id}/${role.id} has no weapon stats`);
        else assert(item.gear, `${biome.id}/${role.id} has no gear stats`);
      }
      for (const archetype of ARCHETYPES) {
        const zombie = zombieFor(biome.id, archetype.id);
        assert.equal(archetypeOf(zombie.id), archetype.id, 'the archetype resolves back');
        // The threat curve is the spine of the balance: a biome may not bend it.
        assert.equal(zombie.hp, archetype.hp, `${biome.id}/${archetype.id} changed its hit points`);
        assert.equal(zombie.ap, archetype.ap, `${biome.id}/${archetype.id} changed its action points`);
        assert.equal(zombie.damage, archetype.damage, `${biome.id}/${archetype.id} changed its damage`);
        assert.equal(zombie.cost, archetype.cost, `${biome.id}/${archetype.id} changed its cost`);
        assert.equal(zombie.points, archetype.points, `${biome.id}/${archetype.id} changed its points`);
        assert.equal(Boolean(zombie.boss), Boolean(archetype.boss));
      }
    }
  });

  it('no biome may ship a better arsenal than the roles allow', () => {
    // The guard rail. A new biome is content, and content is where power creep
    // gets in: this pins every weapon to its role's expected damage, so a railgun
    // can feel different from a sniper rifle without being better than one.
    for (const biome of BIOMES) {
      for (const role of ITEM_ROLES) {
        if (role.kind !== 'weapon' || role.power === undefined) continue;
        const weapon = itemFor(biome.id, role.id).weapon;
        assert(weapon);
        const power = expectedDamage(weapon);
        const drift = Math.abs(power - role.power) / role.power;
        assert(
          drift <= POWER_TOLERANCE,
          `${biome.id}/${role.id}: ${power.toFixed(1)} expected damage against a budget of ${role.power} (${(drift * 100).toFixed(0)}% out)`
        );
      }
    }
  });

  it('ids are unique across every biome, because a save file holds ids', () => {
    const items = BIOMES.flatMap((biome) => itemsOfBiome(biome.id).map((item) => item.id));
    const zombies = BIOMES.flatMap((biome) => zombiesOfBiome(biome.id).map((zombie) => zombie.id));
    assert.equal(new Set(items).size, items.length, 'two biomes share an item id');
    assert.equal(new Set(zombies).size, zombies.length, 'two biomes share a creature id');
  });

  it('a raid resolves its world once and keeps it', () => {
    const state = newGame({ biome: 'random' });
    assert.notEqual(state.config.biome, 'random', 'the biome is resolved at creation');
    assert(BIOME_IDS.includes(state.config.biome));

    // And everything the raid hands out comes from that world.
    joinHero(state, 'Testeuse', undefined);
    startGame(state, 0);
    const ids = new Set(itemsOfBiome(state.config.biome).map((item) => item.id));
    for (const hero of Object.values(state.heroes)) {
      for (const item of [...hero.hands, ...hero.gear, ...hero.bag]) {
        if (item) assert(ids.has(item.def), `${item.def} is not from ${state.config.biome}`);
      }
    }
    for (let i = 0; i < 50; i++) {
      const roll = rollLoot(state);
      assert(ids.has(roll.def.id), `${roll.def.id} is not from ${state.config.biome}`);
    }
  });

  it('a survivor’s favourite weapon is a kind, and every kind exists', () => {
    // The reason roles exist: Charles is a marksman in a world that never built a
    // sniper rifle, and the +1 die has to find him there.
    for (const hero of HEROES) {
      for (const biome of BIOMES) {
        const item = itemFor(biome.id, hero.favoriteWeapon);
        assert(item.weapon, `${hero.name}'s favourite is not a weapon in ${biome.id}`);
      }
    }
  });
});

describe('game master economy', () => {
  function gmGame() {
    const state = newGame({ mode: 'gm', reinforcement: 0, startingZombies: 0 });
    const { hero } = joinHero(state, 'Proie', undefined);
    startGame(state, 0);
    applyHeroAction(state, hero.playerId, { type: 'ready' });
    beginEnemyPhase(state, 0);
    return { state, hero };
  }

  it('income accrues and carries over', () => {
    const { state, hero } = gmGame();
    const first = state.gmBudget;
    assert(first >= 2);

    endEnemyPhase(state, 0);
    startHeroPhase(state, 0);
    applyHeroAction(state, hero.playerId, { type: 'ready' });
    beginEnemyPhase(state, 0);
    assert(state.gmBudget > first, 'unspent points plus new income');
  });

  it('upgrades cost points, cap, and mark every future spawn', () => {
    const { state } = gmGame();
    state.gmBudget = 100;

    assert.equal(applyGmAction(state, { type: 'gmUpgrade', upgrade: 'claws' }).ok, true);
    const spawnRoom = state.board.rooms.find((room) => room.kind === 'spawn');
    assert(spawnRoom);
    applyGmAction(state, { type: 'gmSpawn', roomId: spawnRoom.id, def: 'walker' });

    const clawed = Object.values(state.zombies).find((zombie) => zombie.def === 'walker');
    // One claw rank = one old damage point = 10 in scaled units.
    assert.equal(clawed?.bonusDmg, 10);

    assert.equal(applyGmAction(state, { type: 'gmUpgrade', upgrade: 'claws' }).ok, true);
    assert.equal(applyGmAction(state, { type: 'gmUpgrade', upgrade: 'claws' }).ok, false, 'claws cap at two');
  });

  it('the rush order is once per phase and moves the whole horde', () => {
    const { state } = gmGame();
    state.gmBudget = 20;
    const spawnRoom = state.board.rooms.find((room) => room.kind === 'spawn');
    assert(spawnRoom);
    applyGmAction(state, { type: 'gmSpawn', roomId: spawnRoom.id, def: 'walker' });

    const zombie = Object.values(state.zombies)[0];
    assert(zombie);
    const before = zombie.ap;

    assert.equal(applyGmAction(state, { type: 'gmOrder', order: 'rush' }).ok, true);
    assert.equal(zombie.ap, before + 1);
    assert.equal(applyGmAction(state, { type: 'gmOrder', order: 'rush' }).ok, false);
  });
});

describe('projections', () => {
  it('players never see through the fog', () => {
    const state = newGame({ startingZombies: 4 });
    const { hero } = joinHero(state, 'Aveugle', undefined);
    startGame(state, 0);

    const view = toView(state, { kind: 'player', playerId: hero.playerId });
    const hidden = view.rooms.filter((room) => room.seen === 'hidden');

    assert(hidden.length > 0, 'a fresh map should be mostly dark');
    assert(
      hidden.every((room) => room.kind === 'normal' && !room.hasKey && room.hue === 0 && room.decor === 0),
      'hidden rooms leak nothing they contain'
    );

    // Nor do the boundaries buried between two of them: a door deep in the dark
    // is withheld, while a door on the wall of a lit room is honest.
    const darkCells = new Set(hidden.flatMap((room) => room.cells));
    for (let y = 0; y < view.height; y++) {
      for (let x = 0; x < view.width; x++) {
        const cell = y * view.width + x;
        const right = x + 1 < view.width ? cell + 1 : -1;
        if (!darkCells.has(cell) || right === -1 || !darkCells.has(right)) continue;
        assert.equal(view.edgeRight[cell], '?', `cell ${cell} leaked a boundary into the dark`);
      }
    }
    assert(
      view.zombies.every((zombie) => view.rooms.find((room) => room.id === zombie.roomId)?.seen === 'visible'),
      'no zombie outside the visible rooms'
    );
  });

  it('fog modes: none lights everything, map hands out the floor plan', () => {
    const lit = newGame({ fog: 'none', startingZombies: 4 });
    const { hero: heroA } = joinHero(lit, 'Lampe', undefined);
    startGame(lit, 0);
    const litView = toView(lit, { kind: 'player', playerId: heroA.playerId });
    assert(
      litView.rooms.every((room) => room.seen === 'visible'),
      'no fog on facile'
    );
    assert.equal(litView.zombies.length, Object.keys(lit.zombies).length, 'every creature shown');

    const mapped = newGame({ fog: 'map', startingZombies: 4 });
    const { hero: heroB } = joinHero(mapped, 'Plan', undefined);
    startGame(mapped, 0);
    const mapView = toView(mapped, { kind: 'player', playerId: heroB.playerId });
    assert(
      mapView.rooms.every((room) => room.seen !== 'hidden'),
      'the layout is known'
    );
    const distant = mapView.rooms.find((room) => room.seen === 'explored');
    assert(distant, 'somewhere is out of sight');
    // The floor plan is honest: doors and features show even out of sight.
    assert(!mapView.edgeRight.includes('?') && !mapView.edgeDown.includes('?'), 'nothing withheld');
    assert(
      [...mapView.edgeRight, ...mapView.edgeDown].some((code) => code === 'D' || code === 'A'),
      'the plan shows its openings'
    );
  });

  it('the game master sees everything', () => {
    const state = newGame({ mode: 'gm', startingZombies: 4 });
    joinHero(state, 'Proie', undefined);
    startGame(state, 0);

    const view = toView(state, { kind: 'gm' });
    assert(view.rooms.every((room) => room.seen === 'visible'));
    // The opening horde scales with the party (solo here), but whatever was
    // seeded, the game master sees all of it.
    const seeded = Object.keys(state.zombies).length;
    assert(seeded > 0);
    assert.equal(view.zombies.length, seeded);
  });
});
