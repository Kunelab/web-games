import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { gameConfigSchema } from './config.js';
import { beginEnemyPhase, endEnemyPhase, gmIncome, spawnReinforcements, startGame } from './engine.js';
import { CZ_EVENTS, EVENT_FROM_TURN } from './events.js';
import { connectionsOf, passable } from './map.js';
import { createGame, joinHero, visibleRooms, type CzState } from './state.js';

/**
 * The district's weather.
 *
 * Three claims worth pinning, in descending order of how badly they would hurt:
 *
 * 1. **No event touches a wall.** The generator guarantees the world is one
 *    connected place and windows were carefully designed not to break that. An
 *    event that sealed a door could stand a raid up on an unreachable exit, which
 *    is unlosable-and-unwinnable at once, and it would be nearly impossible to
 *    reproduce from a bug report.
 * 2. **They cancel out.** The whole argument for adding weather without re-tuning
 *    five versions of difficulty balance is that the set is built in opposing
 *    pairs. If somebody adds a seventh event on the horde's side, that argument
 *    quietly stops being true — so it is asserted rather than described.
 * 3. **They last one turn.** Nothing compounds; a blackout cannot become the raid.
 */

function game(overrides: Record<string, unknown> = {}): CzState {
  const state = createGame({
    code: 'TEST',
    hostToken: 'h',
    gmToken: 'g',
    hostUserId: null,
    config: gameConfigSchema.parse({ startingZombies: 0, secondaryObjectives: 0, ...overrides }),
    seed: 1234
  });
  joinHero(state, 'Testeuse', undefined);
  startGame(state, 0);
  return state;
}

/** Walks a raid forward until the roll produces the event asked for. */
function untilEvent(state: CzState, id: string, limit = 400): boolean {
  for (let turn = 0; turn < limit; turn++) {
    beginEnemyPhase(state, 0);
    if (state.event === id) return true;
    endEnemyPhase(state, 0);
    if (state.phase !== 'heroes') return false;
  }
  return false;
}

describe('the set stays balanced', () => {
  it('pulls both ways in equal numbers', () => {
    const heroes = CZ_EVENTS.filter((event) => event.favours === 'heroes').length;
    const horde = CZ_EVENTS.filter((event) => event.favours === 'horde').length;
    assert.equal(
      heroes,
      horde,
      'the events are only free of the difficulty ladder because they cancel: ' +
        `${heroes} favour the survivors and ${horde} the horde`
    );
  });

  it('every event is announced', () => {
    for (const event of CZ_EVENTS) {
      assert.ok(event.name.length > 0, event.id);
      assert.ok(event.blurb.length > 0, `${event.id} has no line to show anybody`);
      assert.ok(event.emoji.length > 0, event.id);
    }
  });
});

describe('nothing touches the walls', () => {
  it('the board is exactly as connected after a hundred turns of weather', () => {
    const state = game();
    const before = state.board.rooms.map(
      (room) =>
        `${room.id}:${connectionsOf(state.board, room)
          .map((connection) => connection.roomId)
          .sort()
          .join(',')}`
    );

    for (let turn = 0; turn < 100; turn++) {
      beginEnemyPhase(state, 0);
      spawnReinforcements(state);
      endEnemyPhase(state, 0);
      if (state.phase !== 'heroes') break;
    }

    const after = state.board.rooms.map(
      (room) =>
        `${room.id}:${connectionsOf(state.board, room)
          .map((connection) => connection.roomId)
          .sort()
          .join(',')}`
    );
    assert.deepEqual(after, before, 'an event changed the map');
  });

  it('every boundary is still one of the four legal kinds', () => {
    const state = game();
    for (let turn = 0; turn < 60; turn++) {
      beginEnemyPhase(state, 0);
      endEnemyPhase(state, 0);
      if (state.phase !== 'heroes') break;
    }
    for (const room of state.board.rooms) {
      for (const connection of connectionsOf(state.board, room)) {
        assert.ok(passable(connection.kind), `${room.id} → ${connection.roomId} is ${connection.kind}`);
      }
    }
  });
});

describe('one turn only', () => {
  it('an event is cleared when the survivors get the board back', () => {
    const state = game();
    let sawOne = false;
    for (let turn = 0; turn < 200; turn++) {
      beginEnemyPhase(state, 0);
      if (state.event) sawOne = true;
      endEnemyPhase(state, 0);
      if (state.phase !== 'heroes') break;
      assert.equal(state.event, null, 'the weather outlasted its turn');
    }
    assert.ok(sawOne, 'the fixture never rolled an event at all');
  });

  it('nothing happens before the third turn', () => {
    for (let seed = 1; seed < 40; seed++) {
      const state = createGame({
        code: 'TEST',
        hostToken: 'h',
        gmToken: 'g',
        hostUserId: null,
        config: gameConfigSchema.parse({ startingZombies: 0 }),
        seed
      });
      joinHero(state, 'Testeuse', undefined);
      startGame(state, 0);
      // Turn 1 and 2: the opening is enough to deal with on its own.
      for (let turn = 1; turn < EVENT_FROM_TURN; turn++) {
        beginEnemyPhase(state, 0);
        assert.equal(state.event, null, `seed ${seed} rolled weather on turn ${state.turn}`);
        endEnemyPhase(state, 0);
      }
    }
  });

  it('the host can turn the whole thing off', () => {
    const state = game({ events: false });
    for (let turn = 0; turn < 120; turn++) {
      beginEnemyPhase(state, 0);
      assert.equal(state.event, null);
      endEnemyPhase(state, 0);
      if (state.phase !== 'heroes') break;
    }
  });
});

describe('what each one does', () => {
  it('a lull stops the reinforcements dead', () => {
    const state = game({ reinforcement: 3, escalation: 3 });
    assert.ok(untilEvent(state, 'calm'), 'never rolled a lull');
    const before = Object.keys(state.zombies).length;
    spawnReinforcements(state);
    assert.equal(Object.keys(state.zombies).length, before, 'something arrived during the lull');
  });

  it('a flare lights the whole district, and a blackout puts it out', () => {
    const lit = game({ fog: 'full' });
    assert.ok(untilEvent(lit, 'flare'), 'never rolled a flare');
    assert.equal(visibleRooms(lit).size, lit.board.rooms.length);

    const dark = game({ fog: 'full' });
    assert.ok(untilEvent(dark, 'blackout'), 'never rolled a blackout');
    // Only the rooms survivors are standing in, so at most one per survivor.
    assert.ok(visibleRooms(dark).size <= Object.keys(dark.heroes).length);
  });

  it('a blackout does not un-explore anything', () => {
    // Fog only ever recedes: temporary blindness must not erase the map.
    const state = game({ fog: 'full' });
    for (let turn = 0; turn < 200; turn++) {
      const known = state.explored.length;
      beginEnemyPhase(state, 0);
      assert.ok(state.explored.length >= known, 'the fog grew back');
      endEnemyPhase(state, 0);
      if (state.phase !== 'heroes') break;
    }
  });

  it('a siren is loud enough to outbid a firefight', () => {
    const state = game();
    assert.ok(untilEvent(state, 'siren'), 'never rolled a siren');
    const loudest = Math.max(0, ...Object.values(state.noise));
    assert.ok(loudest > 1, `an alarm measured ${loudest}, which a single gunshot matches`);
  });

  it('against a human horde, a swarm and a lull move the budget instead', () => {
    /**
     * The bug this pins: `spawnReinforcements` never runs in game-master mode — the
     * dens do not fire, the horde is bought by hand — so both of these events used to
     * announce themselves on every screen and change nothing at all. An event that
     * says "the dens spit twice this turn" and does nothing is the game lying to the
     * table, which is the exact failure the whole feature exists to avoid.
     */
    /**
     * Measured as a multiple of *that turn's* income, never against another turn's.
     * `gmIncome` climbs with the threat curve, so a swarm on turn nine and a plain
     * turn on turn five are not comparable numbers — the first draft of this test
     * compared them and failed for that reason rather than for a real one.
     */
    const paid: Partial<Record<string, number>> = {};

    for (const wanted of ['calm', 'swarm', 'siren'] as const) {
      const state = createGame({
        code: 'TEST',
        hostToken: 'h',
        gmToken: 'g',
        hostUserId: null,
        config: gameConfigSchema.parse({ mode: 'gm', startingZombies: 0, reinforcement: 0 }),
        seed: 4242
      });
      joinHero(state, 'Proie', undefined);
      startGame(state, 0);

      for (let turn = 0; turn < 400; turn++) {
        const before = state.gmBudget;
        const income = gmIncome(state);
        beginEnemyPhase(state, 0);
        if (state.event === wanted) {
          paid[wanted] = (state.gmBudget - before) / income;
          break;
        }
        endEnemyPhase(state, 0);
        if (state.phase !== 'heroes') break;
      }
      assert.ok(paid[wanted] !== undefined, `never rolled ${wanted}`);
    }

    assert.equal(paid.siren, 1, 'an ordinary turn pays the horde its income');
    assert.equal(paid.calm, 0, 'a lull pays the horde nothing');
    assert.equal(paid.swarm, 2, 'a swarm doubles it');
  });

  it('a supply drop leaves a room worth crossing the map for', () => {
    const state = game();
    const stock = new Map(state.board.rooms.map((room) => [room.id, room.finds]));
    assert.ok(untilEvent(state, 'drop'), 'never rolled a drop');

    const grown = state.board.rooms.filter((room) => room.finds > (stock.get(room.id) ?? 0));
    assert.equal(grown.length, 1, 'a drop should stock exactly one room');
    assert.ok((grown[0]?.finds ?? 0) > (stock.get(grown[0]?.id ?? '') ?? 0) + 1);
  });
});
