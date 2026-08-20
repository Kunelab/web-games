import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createGame,
  gameConfigSchema,
  joinHero,
  LAYOUT_IDS,
  lineOfSight,
  startGame,
  toView,
  type CzState
} from 'coronaz-core';

import { neighbourRooms, sightRooms } from './czBoard';

/**
 * The projection's geometry, checked against the board it was projected from.
 *
 * Both functions in `czBoard` answer a question the server also answers, from a
 * different source: the server reads a `Board`, the screen reads two strings of
 * boundary codes. If the two ever disagree, the game lies to the player — a legal
 * move looks illegal, or a shot the phone advertised gets refused a round trip
 * later. That is precisely the failure the attack highlight would introduce if
 * `sightRooms` drifted from `lineOfSight`, so it is pinned here across every
 * layout rather than trusted.
 *
 * Run with the fog off. With it on the two *should* disagree — the projection
 * withholds boundaries the party has not seen, and a screen must not be able to
 * infer them — and that half is asserted separately at the bottom.
 */

function game(layout: string, seed: number, fog: 'full' | 'none' = 'none'): CzState {
  const state = createGame({
    code: 'TEST',
    hostToken: 'h',
    gmToken: 'g',
    hostUserId: null,
    config: gameConfigSchema.parse({ layout, fog }),
    seed
  });
  joinHero(state, 'Testeuse', undefined);
  startGame(state, 0);
  return state;
}

describe('sightRooms agrees with the engine', () => {
  for (const layout of LAYOUT_IDS) {
    it(`${layout}: every room, every reach`, () => {
      const state = game(layout, 4242);
      // The game master's view: no fog, so the strings carry the whole board and
      // the two walks have identical information to work from.
      const view = toView(state, { kind: 'gm' });

      let checked = 0;
      for (const room of view.rooms) {
        // Every reach a weapon in this game can have, plus Suzanne's extra room.
        for (const range of [0, 1, 2, 3, 4]) {
          const mine = sightRooms(view, room.id, range);
          const theirs = lineOfSight(state.board, room.id, range);

          assert.deepEqual(
            [...mine.keys()].sort(),
            [...theirs.keys()].sort(),
            `${layout} ${room.id} at range ${range}`
          );
          for (const [id, distance] of theirs) {
            assert.equal(mine.get(id), distance, `${layout} ${room.id} → ${id} at range ${range}`);
          }
          checked += 1;
        }
      }
      assert.ok(checked > 100, 'the fixture should have exercised a real board');
    });
  }
});

describe('sightRooms, in detail', () => {
  const state = game('ville', 99);
  const view = toView(state, { kind: 'gm' });

  it('always sees the room you are standing in, at distance zero', () => {
    for (const room of view.rooms) {
      assert.equal(sightRooms(view, room.id, 0).get(room.id), 0);
    }
  });

  it('range 0 sees nothing but your own room', () => {
    for (const room of view.rooms) {
      assert.equal(sightRooms(view, room.id, 0).size, 1, room.id);
    }
  });

  it('never reports a room further than the range asked for', () => {
    for (const room of view.rooms) {
      for (const [, distance] of sightRooms(view, room.id, 2)) {
        assert.ok(distance <= 2);
      }
    }
  });

  it('grows monotonically with reach', () => {
    for (const room of view.rooms) {
      const near = sightRooms(view, room.id, 1);
      const far = sightRooms(view, room.id, 3);
      for (const id of near.keys()) assert.ok(far.has(id), `${room.id} lost sight of ${id} at longer reach`);
    }
  });

  it('sees through a window it cannot walk through', () => {
    // The v8 rule, from the screen's side: a window is see-through and not
    // passable, so at least one room in a city is visible without being reachable.
    // If this stops holding, the highlight is quietly drawing movement targets.
    let found = 0;
    for (const room of view.rooms) {
      const reachable = new Set(neighbourRooms(view, room).map((next) => next.id));
      for (const id of sightRooms(view, room.id, 1).keys()) {
        if (id !== room.id && !reachable.has(id)) found += 1;
      }
    }
    assert.ok(found > 0, 'no room was visible-but-unreachable: are there windows?');
  });
});

describe('the fog is not leaked', () => {
  it('a player early in a raid sees less than the board holds', () => {
    const state = game('ville', 7, 'full');
    const playerId = Object.keys(state.heroes)[0] ?? '';
    const hero = state.heroes[playerId];
    assert.ok(hero);

    const view = toView(state, { kind: 'player', playerId });
    // Far reach on purpose: the question is whether withheld boundaries stop the
    // rays, not whether the range does.
    const mine = sightRooms(view, hero.roomId, 6);
    const theirs = lineOfSight(state.board, hero.roomId, 6);

    for (const id of mine.keys()) {
      assert.ok(theirs.has(id), `the phone invented sight of ${id}`);
    }
    assert.ok(mine.size <= theirs.size, 'the phone saw more than the board allows');
  });
});
