import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { gameConfigSchema } from './config.js';
import { applyHeroAction, BREACH_AP, startGame } from './engine.js';
import { edgeBetween, getRoom, neighbors, shortestPath, type Room } from './map.js';
import { createGame, joinHero, type CzState } from './state.js';

/**
 * Breaking through a wall.
 *
 * The only action that edits the district, which makes it the only one whose
 * result has to be believed by everything that had already measured the old
 * shape — the adjacency, and every route anybody has asked for since the map was
 * drawn. Those are cached, deliberately and heavily, so this is really a test
 * that the cache lets go when the world changes under it.
 */

function raid(): CzState {
  const state = createGame({
    code: 'BREACH',
    hostToken: 'h',
    gmToken: 'g',
    hostUserId: null,
    config: gameConfigSchema.parse({ startingZombies: 0 }),
    seed: 4
  });
  joinHero(state, 'Perceuse', undefined, []);
  startGame(state, 0);
  return state;
}

/** Two rooms sharing a wall and nothing else. */
function sealedPair(state: CzState): { from: Room; into: Room } | null {
  const board = state.board;
  for (const from of board.rooms) {
    const open = new Set(neighbors(board, from).map((room) => room.id));
    for (const cell of from.cells) {
      const x = cell % board.width;
      const y = Math.floor(cell / board.width);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1]
      ] as const) {
        if (edgeBetween(board, x, y, x + dx, y + dy) !== 'wall') continue;
        const index = (y + dy) * board.width + (x + dx);
        const otherId = board.cellRoom[index];
        if (!otherId || otherId === from.id || open.has(otherId)) continue;
        const into = board.rooms.find((room) => room.id === otherId);
        if (into) return { from, into };
      }
    }
  }
  return null;
}

describe('breaking through a wall', () => {
  it('opens a way that was not there, and the map agrees afterwards', () => {
    const state = raid();
    const pair = sealedPair(state);
    assert.ok(pair, 'the fixture has no sealed pair to break through');
    const { from, into } = pair;

    const hero = Object.values(state.heroes)[0];
    assert.ok(hero);
    hero.roomId = from.id;
    hero.ap = BREACH_AP;

    // Before: no adjacency, and any route between them goes the long way round.
    assert.equal(
      neighbors(state.board, from).some((room) => room.id === into.id),
      false
    );
    const before = shortestPath(state.board, from.id, into.id)?.length ?? Infinity;

    const result = applyHeroAction(state, hero.playerId, { type: 'breach', roomId: into.id });
    assert.equal(result.ok, true, typeof result.error === 'string' ? result.error : 'breach refused');

    /**
     * The assertion that matters: the adjacency and the routes are both cached
     * against the board, and a stale cache here would leave the horde and the
     * survivors walking a wall that is no longer standing.
     */
    assert.equal(
      neighbors(state.board, getRoom(state.board, from.id)).some((room) => room.id === into.id),
      true,
      'the new doorway is not in the adjacency'
    );
    assert.equal(shortestPath(state.board, from.id, into.id)?.length, 1, 'the route did not shorten');
    assert.ok(before > 1, 'the fixture was already adjacent');
    assert.equal(hero.ap, 0);
  });

  it('costs three points and refuses when they are not there', () => {
    const state = raid();
    const pair = sealedPair(state);
    assert.ok(pair);

    const hero = Object.values(state.heroes)[0];
    assert.ok(hero);
    hero.roomId = pair.from.id;
    hero.ap = BREACH_AP - 1;

    const result = applyHeroAction(state, hero.playerId, { type: 'breach', roomId: pair.into.id });
    assert.equal(result.ok, false);
    // And the wall is still standing.
    assert.equal(
      neighbors(state.board, pair.from).some((room) => room.id === pair.into.id),
      false
    );
  });

  it('refuses a wall that is already a doorway, and rooms that do not touch', () => {
    const state = raid();
    const hero = Object.values(state.heroes)[0];
    assert.ok(hero);
    hero.ap = BREACH_AP;

    const from = getRoom(state.board, hero.roomId);
    const already = neighbors(state.board, from)[0];
    assert.ok(already, 'the fixture start has no exits');

    assert.equal(applyHeroAction(state, hero.playerId, { type: 'breach', roomId: already.id }).ok, false);
    assert.equal(applyHeroAction(state, hero.playerId, { type: 'breach', roomId: 'nowhere' }).ok, false);
    // Refused actions touch nothing.
    assert.equal(hero.ap, BREACH_AP);
  });

  it('is loud where it breaks in', () => {
    const state = raid();
    const pair = sealedPair(state);
    assert.ok(pair);

    const hero = Object.values(state.heroes)[0];
    assert.ok(hero);
    hero.roomId = pair.from.id;
    hero.ap = BREACH_AP;
    applyHeroAction(state, hero.playerId, { type: 'breach', roomId: pair.into.id });

    // The horde homes in on noise, and it lands on the far side: breaking into
    // somewhere announces you to whatever is already in there.
    assert.ok((state.noise[pair.into.id] ?? 0) > 0);
  });
});
