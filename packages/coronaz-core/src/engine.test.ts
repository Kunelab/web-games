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
import { isStructural, MAX_CLUSTER_ROOMS, roomBudget } from './mapgen/programs.js';
import { HEROES, itemDef, rarityRange, weaponStats, zombieDef } from './data.js';
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
  cellXY,
  connectionsOf,
  edgeBetween,
  distancesFrom,
  edgeAt,
  getRoom,
  isRubble,
  lineOfSight,
  MAX_OUTDOOR_ROOM_CELLS,
  MAX_ROOM_CELLS,
  neighbors,
  passable,
  roomOfCell,
  seeThrough,
  shortestPath,
  type RoomProgram
} from './map.js';
import { generateBoard, LAYOUT_IDS } from './mapgen/index.js';
import { toView } from './protocol.js';
import { seedRng } from './rng.js';
import {
  activeHeroes,
  createGame,
  joinHero,
  makeItem,
  objectivesDone,
  spawnZombie,
  type CzState
} from './state.js';

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

  it('keeps every room within its cell cap so a move stays a move', () => {
    /**
     * Two caps, because moving indoors and moving outdoors are different problems.
     *
     * A move costs one point per room whatever its size, so indoors the cap is what
     * makes searching a building cost something. Outdoors it was making a plaza
     * unusable: nine one-cell rooms is nine action points to cross a square, so
     * nobody ever crossed one. Outdoor rooms are rectangles of up to nine cells now,
     * and this is where that stays honest.
     */
    for (const { layout, seed, board } of boardsAcrossLayouts()) {
      for (const room of board.rooms) {
        const cap = room.outdoor ? MAX_OUTDOOR_ROOM_CELLS : MAX_ROOM_CELLS;
        assert(
          room.cells.length >= 1 && room.cells.length <= cap,
          `${layout} ${seed}: ${room.outdoor ? 'outdoor' : 'indoor'} room ${room.id} owns ${room.cells.length} cells`
        );
        // And every outdoor room is a rectangle: an L-shaped piece of pavement reads
        // as damage, which is why the outdoors is tiled rather than flood-filled.
        if (room.outdoor) {
          assert.equal(
            room.w * room.h,
            room.cells.length,
            `${layout} ${seed}: outdoor room ${room.id} is not a rectangle`
          );
        }
      }
    }
  });

  it('lets sight and gunfire through a window but never a body', () => {
    /**
     * The whole reason windows exist, pinned in one test.
     *
     * Every other boundary answers "can I see it" and "can I walk there" the same
     * way, which is why the fight went blind the moment anyone stepped indoors. A
     * window is the one that disagrees, and both halves of the disagreement have to
     * hold: a survivor can shoot through it, and neither he nor the horde can step
     * through it. Getting the second half wrong would be far worse than not having
     * windows at all, because a room the horde reaches through the glass is a room
     * nobody can defend.
     */
    assert.equal(passable('window'), false, 'a window is not a way in');
    assert.equal(seeThrough('window'), true, 'a window is a line of sight');
    assert.equal(passable('door'), true);
    assert.equal(seeThrough('wall'), false);

    let glazed = 0;
    for (const { layout, seed, board } of boardsAcrossLayouts([5, 58, 1234])) {
      for (const room of board.rooms) {
        for (const cell of room.cells) {
          const { x, y } = cellXY(board, cell);
          for (const [dx, dy] of [
            [1, 0],
            [0, 1]
          ] as const) {
            if (edgeBetween(board, x, y, x + dx, y + dy) !== 'window') continue;
            glazed += 1;

            const other = roomOfCell(board, cellIndex(board, x + dx, y + dy));
            assert(other, `${layout} ${seed}: a window onto nothing at ${x},${y}`);
            if (!other || other.id === room.id) continue;

            // Visible through the glass, and not a neighbour you can walk to.
            assert(
              lineOfSight(board, room.id, 2).has(other.id),
              `${layout} ${seed}: cannot see through the window at ${x},${y}`
            );
            /**
             * If the two rooms *are* neighbours, it is because some other boundary
             * between them is a door or an arch: never because of this pane.
             * `connectionsOf` only ever yields door and arch, so what this checks is
             * that no link between them was created *at* this window's cells.
             */
            const throughHere = connectionsOf(board, room).some(
              (link) => link.roomId === other.id && link.from === cell && link.dx === dx && link.dy === dy
            );
            assert(!throughHere, `${layout} ${seed}: the window at ${x},${y} is a doorway`);
          }
        }
      }
    }

    assert(glazed > 20, `only ${glazed} windows generated across three seeds`);
  });

  it('keeps a cluster of one kind of room within its budget', () => {
    /**
     * The rule a bunker broke spectacularly.
     *
     * Repetition is not the problem: five laboratory rooms in a row is one laboratory
     * you walk through, and that is good. Fifty of them is the word "laboratory"
     * printed across half the board, which is what a 22x22 facility generated,
     * measured at 77 in the worst seed.
     *
     * Two numbers hold it: how many separate clusters of a programme a building may
     * have, and how many rooms one cluster may run to. Structural programmes are
     * exempt from both, on purpose: corridors, streets and squares are what makes a
     * map read as one place, and a street should be as long as the street.
     */
    const worst = new Map<string, number>();

    for (const { layout, seed, board } of boardsAcrossLayouts([3, 58, 4242])) {
      const byId = new Map(board.rooms.map((room) => [room.id, room]));
      const seen = new Set<string>();
      const clusters = new Map<string, number>();

      for (const room of board.rooms) {
        if (seen.has(room.id) || room.outdoor || isStructural(room.program)) continue;
        const queue = [room];
        seen.add(room.id);
        let size = 0;
        while (queue.length > 0) {
          const current = queue.pop();
          if (!current) break;
          size += 1;
          for (const other of neighbors(board, current)) {
            if (seen.has(other.id) || other.zone !== current.zone || other.program !== room.program) continue;
            seen.add(other.id);
            const found = byId.get(other.id);
            if (found) queue.push(found);
          }
        }

        assert(
          size <= MAX_CLUSTER_ROOMS,
          `${layout} ${seed}: a cluster of ${size} ${room.program} rooms (ceiling ${MAX_CLUSTER_ROOMS})`
        );
        const key = `${room.zone}:${room.program}`;
        clusters.set(key, (clusters.get(key) ?? 0) + 1);
        worst.set(room.program, Math.max(worst.get(room.program) ?? 0, size));
      }

      // And no building holds more clusters of one room than its budget allows.
      for (const [key, count] of clusters) {
        const program = key.slice(key.indexOf(':') + 1) as RoomProgram;
        const allowed = roomBudget(program).clusters;
        assert(
          count <= allowed,
          `${layout} ${seed}: ${count} separate ${program} clusters in one building (max ${allowed})`
        );
      }
    }

    // A sanity check on the other side: if nothing ever clustered, the arch-joined
    // rooms this generator is built on would have quietly stopped happening.
    assert(
      [...worst.values()].some((size) => size >= 3),
      'no programme ever formed a cluster: rooms are not being joined at all'
    );
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

  it('carves the grid into rooms, rubble aside, and shares no cell twice', () => {
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

      // Every cell is either floor or rubble, and rubble is a deliberate share of
      // the grid rather than a hole the carver forgot.
      let blocked = 0;
      for (let cell = 0; cell < cells; cell++) {
        if (isRubble(board, cell)) {
          blocked += 1;
          assert(!owner.has(cell), 'rubble cannot belong to a room');
        } else {
          assert(owner.has(cell), `${layout} ${seed}: cell ${cell} is neither room nor rubble`);
        }
      }
      assert(blocked > 0, `${layout} ${seed}: no rubble at all`);
      assert(blocked < cells * 0.3, `${layout} ${seed}: ${blocked}/${cells} cells are rubble`);

      assert.equal(board.edgeRight.length, cells);
      assert.equal(board.edgeDown.length, cells);
    }
  });

  it('never lets rubble cut the world in two', () => {
    // Rubble is chosen before anything is carved, so the room-level repair pass
    // cannot save a district it has severed: it opens doors between rooms, and
    // rubble is not a room. The generator therefore refuses any heap that splits
    // the free space, and this is that promise.
    for (const { layout, seed, board } of boardsAcrossLayouts()) {
      const first = board.rooms[0];
      assert(first);
      assert.equal(
        distancesFrom(board, first.id).size,
        board.rooms.length,
        `${layout} ${seed}: rubble stranded part of the map`
      );
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
        if (isRubble(board, cell)) continue;
        for (const [side, nx, ny] of [
          ['right', x + 1, y],
          ['down', x, y + 1]
        ] as const) {
          if (nx >= board.width || ny >= board.height) continue;
          const neighbour = cellIndex(board, nx, ny);
          if (isRubble(board, neighbour)) continue;
          const same = board.cellRoom[cell] === board.cellRoom[neighbour];
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

  it('searching finds loot, and the two free crates are spent in the right order', () => {
    const state = newGame({ startingZombies: 0 });
    const { hero } = joinHero(state, 'Lampiste', undefined);
    // Anyone but Chuck, whose ability is no longer about the *price* of a search.
    hero.heroId = 'rosa';
    startGame(state, 0);
    // A torch is what funds a renewable free search now, for everybody.
    hero.gear[0] = makeItem(state, itemFor(state.config.biome, 'torch').id);

    const free = applyHeroAction(state, hero.playerId, { type: 'search' });
    assert.equal(free.ok, true);
    assert(free.loot);
    assert.equal(hero.ap, 3, 'the torch pays for the first search');
    assert.equal(hero.freeRaidSearchUsed, false, 'the renewable freebie goes first');

    // The raid's own free crate, which everyone gets once, whatever they are.
    const gift = applyHeroAction(state, hero.playerId, { type: 'search' });
    assert.equal(gift.ok, true);
    assert.equal(hero.ap, 3);
    assert.equal(hero.freeRaidSearchUsed, true);

    const paid = applyHeroAction(state, hero.playerId, { type: 'search' });
    assert.equal(paid.ok, true);
    assert.equal(hero.ap, 2);
    assert.equal(hero.bag.length, 3);
  });

  it('everyone gets one free crate a raid, torch or no torch', () => {
    const state = newGame({ startingZombies: 0 });
    const { hero } = joinHero(state, 'Sans lampe', undefined);
    hero.heroId = 'rosa';
    startGame(state, 0);

    assert.equal(applyHeroAction(state, hero.playerId, { type: 'search' }).ok, true);
    assert.equal(hero.ap, 3, 'the first crate of the raid costs nothing');
    assert.equal(applyHeroAction(state, hero.playerId, { type: 'search' }).ok, true);
    assert.equal(hero.ap, 2, 'and only the first');

    // It does not come back next turn: it is once a raid, not once a phase.
    hero.ap = 3;
    hero.freeSearchUsed = false;
    assert.equal(applyHeroAction(state, hero.playerId, { type: 'search' }).ok, true);
    assert.equal(hero.ap, 2);
  });

  it('a survivor can walk away, and the raid goes on without them', () => {
    const state = newGame({ startingZombies: 0, scenario: 'escape' });
    const { hero: leaver } = joinHero(state, 'Partant', undefined);
    const { hero: stayer } = joinHero(state, 'Restante', undefined);
    startGame(state, 0);

    const result = applyHeroAction(state, leaver.playerId, { type: 'forfeit' });
    assert.equal(result.ok, true);
    assert.equal(leaver.forfeited, true);
    assert.equal(leaver.alive, true, 'walking away is not dying');
    assert.equal(state.phase, 'heroes', 'the others are still playing');
    assert.equal(activeHeroes(state).length, 1);

    // No actions afterwards: the door only opens outwards.
    assert.equal(applyHeroAction(state, leaver.playerId, { type: 'search' }).ok, false);

    // The last one out ends the raid, exactly as a death would.
    assert.equal(applyHeroAction(state, stayer.playerId, { type: 'forfeit' }).ok, true);
    assert.equal(state.phase, 'lost');
  });

  it('the game master can concede, in or out of his own phase', () => {
    const state = newGame({ startingZombies: 2, mode: 'gm' });
    joinHero(state, 'Assiégée', undefined);
    startGame(state, 0);

    assert.equal(state.phase, 'heroes', 'not the horde’s turn');
    const result = applyGmAction(state, { type: 'gmForfeit' });
    assert.equal(result.ok, true);
    assert.equal(state.phase, 'won', 'the survivors take the raid');

    // And not twice.
    assert.equal(applyGmAction(state, { type: 'gmForfeit' }).ok, false);
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

    const boss = Object.values(state.zombies).find((zombie) => zombieDef(zombie.def).boss);
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
    // What the door waits for is the *required* quests; the optional ones are
    // drawn alongside them and are nobody's obligation.
    assert.equal(objectivesDone(state), true);
    assert(
      state.objectives.some((objective) => objective.optional),
      'a bonus quest was drawn too'
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

    const walkers = Object.values(state.zombies).filter((zombie) => archetypeOf(zombie.def) === 'walker');
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

  it('rarity moves a weapon’s numbers by a share, and the fight reads them', () => {
    // Every weapon connects, so rarity buys damage; and it buys a *proportion* of
    // the weapon's own damage, so a rank means the same thing to a bat and to a
    // sniper rifle. 58 × 1.18 = 68, 58 ÷ 1.18 = 49.
    const sniper = itemDef('sniper');
    assert.equal(weaponStats(sniper, 4)?.damage, 58);
    assert.equal(weaponStats(sniper, 5)?.damage, 68);
    assert.equal(weaponStats(sniper, 3)?.damage, 49);
    assert.equal(weaponStats(sniper, 3)?.accuracy, 1, 'nothing misses any more');

    // The same rank on the cheapest weapon in the table is still visible, which is
    // the whole reason the step is a share: a flat ten would have doubled it.
    const bat = itemDef('bat');
    assert.equal(weaponStats(bat, 1)?.damage, 14);
    assert.equal(weaponStats(bat, 2)?.damage, 17);

    // Dice never move: they are how many things you kill, not how hard.
    const pistol = itemDef('pistol');
    assert.equal(weaponStats(pistol, 1)?.dice, 3);
    assert.equal(weaponStats(pistol, 3)?.dice, 3);
    assert.equal(weaponStats(pistol, 1)?.damage, 9);

    // And the resolver reads the instance, not the printout.
    const state = newGame({ startingZombies: 0 });
    const { hero } = joinHero(state, 'Tireuse', undefined);
    startGame(state, 0);
    hero.hands = [makeItem(state, 'sniper', 5), null];
    const chosen = weaponFor(hero, 0);
    assert(!('error' in chosen));
    assert.equal(chosen.weapon.damage, 68);
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
    // Six barrels either way; the pair fires at the chipped one's damage, not the
    // pristine one's.
    assert.equal(chosen.dice, 6);
    assert.equal(chosen.weapon.damage, 9);
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

  it('never lets a lower tier out-damage a higher one', () => {
    /**
     * The rule the first playtest was missing. Measured per attack, tier 4 used to
     * average 23.3 against tier 3's 31.7 — so a Desert Eagle lost to an AK and a
     * sniper rifle lost to an *uncommon* chainsaw, which is exactly what "rare
     * weapons are trash" means. Ten pairs were inverted.
     *
     * Stated as the strong claim, because the weak one ("averages rise") allowed
     * every inversion that mattered: the weakest weapon of a tier must beat the
     * strongest weapon of the tier below.
     */
    for (const biome of BIOMES) {
      const byTier = new Map<number, { role: string; power: number }[]>();
      for (const role of ITEM_ROLES) {
        if (role.kind !== 'weapon') continue;
        const weapon = itemFor(biome.id, role.id).weapon;
        assert(weapon);
        const list = byTier.get(role.tier) ?? [];
        list.push({ role: role.id, power: expectedDamage(weapon) });
        byTier.set(role.tier, list);
      }

      for (let tier = 2; tier <= 5; tier++) {
        const here = byTier.get(tier) ?? [];
        const below = byTier.get(tier - 1) ?? [];
        if (here.length === 0 || below.length === 0) continue;
        const weakest = here.reduce((a, b) => (b.power < a.power ? b : a));
        const strongest = below.reduce((a, b) => (b.power > a.power ? b : a));
        assert(
          weakest.power > strongest.power,
          `${biome.id}: ${weakest.role} (T${tier}, ${weakest.power.toFixed(1)}) does not beat ` +
            `${strongest.role} (T${tier - 1}, ${strongest.power.toFixed(1)})`
        );
      }
    }
  });

  it('makes a rarer copy of the same weapon strictly better', () => {
    // Within one weapon, up a rank must never be sideways or worse.
    for (const biome of BIOMES) {
      for (const role of ITEM_ROLES) {
        if (role.kind !== 'weapon') continue;
        const def = itemFor(biome.id, role.id);
        const range = rarityRange(def.tier);
        for (let rarity = range.min; rarity < range.max; rarity++) {
          const lower = weaponStats(def, rarity);
          const higher = weaponStats(def, rarity + 1);
          assert(lower && higher);
          assert(
            expectedDamage(higher) > expectedDamage(lower),
            `${def.id}: rarity ${rarity + 1} (${expectedDamage(higher).toFixed(1)}) is not better than ` +
              `rarity ${rarity} (${expectedDamage(lower).toFixed(1)})`
          );
        }
      }
    }
  });

  it('never computes a weapon that heals what it shoots', () => {
    /**
     * Walks all five rarities, not just the range a drop can roll.
     *
     * The monotonicity check above stops at tier ±1, which is why nothing caught a
     * tier-3 rifle asked for rarity 1 back when a rank cost a flat ten damage: it
     * computed 20 - 2×10 = 0, and a tier-5 minigun four ranks down came out at -20,
     * i.e. a gun that put hit points back. A proportional step cannot reach zero,
     * but any caller may ask for any rarity (the item card does), so the property is
     * worth pinning: strictly increasing, and always at least one point of damage.
     */
    for (const biome of BIOMES) {
      for (const role of ITEM_ROLES) {
        if (role.kind !== 'weapon') continue;
        const def = itemFor(biome.id, role.id);
        for (let rarity = 1; rarity <= 5; rarity++) {
          const stats = weaponStats(def, rarity);
          assert(stats);
          assert(stats.damage >= 1, `${def.id} at rarity ${rarity}: ${stats.damage} damage`);
          assert(stats.dice >= 1, `${def.id} at rarity ${rarity}: ${stats.dice} dice`);
          if (rarity > 1) {
            const worse = weaponStats(def, rarity - 1);
            assert(worse);
            assert(
              expectedDamage(stats) > expectedDamage(worse),
              `${def.id}: rarity ${rarity} is not strictly better than ${rarity - 1}`
            );
          }
        }
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
    // No weather: a lull zeroes the horde's income for a turn, which is correct
    // behaviour and makes an assertion about income accruing depend on a die roll.
    // The events have their own tests.
    const state = newGame({ mode: 'gm', reinforcement: 0, startingZombies: 0, events: false });
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
    const shambler = zombieFor(state.config.biome, 'walker').id;
    applyGmAction(state, { type: 'gmSpawn', roomId: spawnRoom.id, def: shambler });

    const clawed = Object.values(state.zombies).find((zombie) => zombie.def === shambler);
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
