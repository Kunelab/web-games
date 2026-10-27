import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { alsoInOf, genreKeyOf, genreKeysOf, mediaDifficulty, selectByGenre } from './selection.js';

function item(id: number, category: string | null, difficulty?: number | null) {
  return { id, category, payload: difficulty === undefined ? {} : { difficulty } };
}

describe('selectByGenre', () => {
  it("keeps an item listed in another genre too, in that genre's window", () => {
    const stromae = { id: 1, category: 'chanson-fr', payload: { difficulty: 40, alsoIn: ['electro'] } };
    const items = [stromae, item(2, 'chanson-fr', 40)];
    assert.deepEqual(
      selectByGenre(items, [{ category: 'electro', difficultyMin: 0, difficultyMax: 100 }]).map((entry) => entry.id),
      [1]
    );
    assert.deepEqual(selectByGenre(items, [{ category: 'electro', difficultyMin: 50, difficultyMax: 100 }]), []);
    // Kept once, whichever of its genres let it in.
    assert.deepEqual(
      selectByGenre(items, [
        { category: 'electro', difficultyMin: 0, difficultyMax: 100 },
        { category: 'chanson-fr', difficultyMin: 0, difficultyMax: 100 }
      ]).map((entry) => entry.id),
      [1, 2]
    );
  });

  it('keeps only the genres listed', () => {
    const items = [item(1, 'rap-fr', 10), item(2, 'rock', 10), item(3, 'rap-fr', 20)];
    const kept = selectByGenre(items, [{ category: 'rap-fr', difficultyMin: 0, difficultyMax: 100 }]);
    assert.deepEqual(
      kept.map((entry) => entry.id),
      [1, 3]
    );
  });

  it('applies each genre its own window', () => {
    const items = [item(1, 'rap-fr', 10), item(2, 'rap-fr', 80), item(3, 'rock', 10), item(4, 'rock', 80)];
    const kept = selectByGenre(items, [
      { category: 'rap-fr', difficultyMin: 0, difficultyMax: 30 },
      { category: 'rock', difficultyMin: 50, difficultyMax: 100 }
    ]);
    assert.deepEqual(
      kept.map((entry) => entry.id),
      [1, 4]
    );
  });

  it('keeps an item with no difficulty whatever the window', () => {
    const items = [item(1, 'quiz'), item(2, 'quiz', null), item(3, 'quiz', 90)];
    const kept = selectByGenre(items, [{ category: 'quiz', difficultyMin: 0, difficultyMax: 20 }]);
    assert.deepEqual(
      kept.map((entry) => entry.id),
      [1, 2]
    );
  });

  it('groups the items without a category under the empty key', () => {
    const items = [item(1, null, 50), item(2, 'rock', 50)];
    const kept = selectByGenre(items, [{ category: '', difficultyMin: 0, difficultyMax: 100 }]);
    assert.deepEqual(
      kept.map((entry) => entry.id),
      [1]
    );
  });

  it('reads a window dragged past itself in order', () => {
    const items = [item(1, 'rock', 40), item(2, 'rock', 90)];
    const kept = selectByGenre(items, [{ category: 'rock', difficultyMin: 60, difficultyMax: 20 }]);
    assert.deepEqual(
      kept.map((entry) => entry.id),
      [1]
    );
  });

  it('keeps the bounds inclusive', () => {
    const items = [item(1, 'rock', 20), item(2, 'rock', 60)];
    const kept = selectByGenre(items, [{ category: 'rock', difficultyMin: 20, difficultyMax: 60 }]);
    assert.equal(kept.length, 2);
  });
});

describe('the keys it reads', () => {
  it('reads a difficulty only when it is a number', () => {
    assert.equal(mediaDifficulty({ payload: { difficulty: 35 } }), 35);
    assert.equal(mediaDifficulty({ payload: { difficulty: '35' } }), null);
    assert.equal(mediaDifficulty({ payload: null }), null);
  });

  it('matches a category as stored', () => {
    assert.equal(genreKeyOf({ category: 'Années 80' }), 'Années 80');
    assert.equal(genreKeyOf({ category: null }), '');
  });
});

describe('genreKeysOf', () => {
  it('lists the own genre first, then the others once each', () => {
    assert.deepEqual(genreKeysOf({ category: 'pop', payload: { alsoIn: ['electro', 'pop', 'electro', ''] } }), [
      'pop',
      'electro'
    ]);
    assert.deepEqual(genreKeysOf({ category: null, payload: {} }), ['']);
  });

  it('reads a malformed list as none', () => {
    assert.deepEqual(alsoInOf({ alsoIn: 'electro' }), []);
    assert.deepEqual(alsoInOf(null), []);
    assert.deepEqual(alsoInOf({ alsoIn: [3, 'rock'] }), ['rock']);
  });
});
