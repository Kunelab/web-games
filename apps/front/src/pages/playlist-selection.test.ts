import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasChoices, OPEN_FILTER, playlistSelection, type Selectable } from './playlist-selection';

function item(id: number, category: string | null, difficulty?: number, ready = true): Selectable & { id: number } {
  return { id, category, payload: difficulty === undefined ? {} : { difficulty }, readiness: { ready } };
}

const playlist = [
  item(1, 'rap-fr', 10),
  item(2, 'rap-fr', 80),
  item(3, 'rock', 50),
  item(4, null),
  item(5, 'rock', 50, false)
];

describe('playlistSelection', () => {
  it('sends nothing while nothing is narrowed, so the whole playlist plays', () => {
    const selection = playlistSelection(playlist, OPEN_FILTER);
    assert.equal(selection.genres, undefined);
    assert.equal(selection.maxRounds, undefined);
    assert.equal(selection.kept, 4);
  });

  it('lists the genres kept, the media with none among them', () => {
    const selection = playlistSelection(playlist, { ...OPEN_FILTER, excluded: new Set(['rock']) });
    assert.deepEqual(selection.genres?.map((genre) => genre.category).sort(), ['', 'rap-fr']);
    assert.equal(selection.kept, 3);
  });

  it('applies the shared window to every genre, and keeps what has no difficulty', () => {
    const selection = playlistSelection(playlist, { ...OPEN_FILTER, difficulty: { min: 60, max: 20 } });
    assert.ok(selection.genres?.every((genre) => genre.difficultyMin === 20 && genre.difficultyMax === 60));
    // The easy rap clip is out, the hard one too; the rock clip and the unrated one stay.
    assert.equal(selection.kept, 2);
  });

  it('gives a genre its own window once there is one', () => {
    const selection = playlistSelection(playlist, {
      ...OPEN_FILTER,
      perGenre: { 'rap-fr': { min: 70, max: 100 }, rock: { min: 0, max: 100 }, '': { min: 0, max: 100 } }
    });
    assert.equal(selection.kept, 3);
  });

  it('asks for a length only when it is shorter than what is kept', () => {
    assert.equal(playlistSelection(playlist, { ...OPEN_FILTER, maxRounds: 2 }).maxRounds, 2);
    assert.equal(playlistSelection(playlist, { ...OPEN_FILTER, maxRounds: 10 }).maxRounds, undefined);
  });
});

describe('hasChoices', () => {
  it('has nothing to ask of a short quiz with one category and no difficulty', () => {
    assert.equal(hasChoices([item(1, 'quiz'), item(2, 'quiz')].map((entry) => ({ ...entry, payload: {} }))), false);
  });

  it('asks as soon as there are two genres', () => {
    assert.equal(hasChoices([item(1, 'a'), item(2, 'b')]), true);
  });
});
