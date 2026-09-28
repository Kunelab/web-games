import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GENRES } from './blindtest-catalog.js';
import { answersForGenre, checkGenres, shapeOf, type GenreCheckItem } from './blindtest-genres.js';
import type { SeedIndex } from './blindtest-seeds.js';

function song(id: number, category: string, artist: string, title = `Song ${id}`): GenreCheckItem {
  return {
    id,
    category,
    answers: [
      { key: 'title', label: 'field.title', value: title },
      { key: 'artist', label: 'field.artist', value: artist }
    ]
  };
}

function work(id: number, category: string, name: string, label: string): GenreCheckItem {
  return { id, category, answers: [{ key: 'work', label, value: name }] };
}

function index(entries: { artists?: Record<string, string[]>; works?: Record<string, string[]> } = {}): SeedIndex {
  const toMap = (record: Record<string, string[]> = {}) =>
    new Map(Object.entries(record).map(([name, genres]) => [name, new Set(genres)]));
  const artists = toMap(entries.artists);
  const works = toMap(entries.works);
  const harvested = new Set([...artists.values(), ...works.values()].flatMap((genres) => [...genres]));
  return { artists, works, harvested };
}

const none = new Map<number, string>();

describe('shapeOf', () => {
  it('reads the shape off the fields', () => {
    assert.equal(shapeOf(song(1, 'pop', 'ABBA')), 'artist-title');
    assert.equal(shapeOf(work(1, 'anime-op', 'Naruto', 'field.work.animeOpening')), 'work');
    assert.equal(shapeOf({ answers: [] }), null);
  });
});

describe('checkGenres', () => {
  it('flags a genre that no longer exists', () => {
    const { flags } = checkGenres([song(1, 'disco-polo', 'ABBA')], GENRES, index(), none);
    assert.deepEqual(flags, [{ mediaId: 1, reason: 'unknown-genre', suggestions: [] }]);
  });

  it('flags a song filed under a work genre', () => {
    const { flags } = checkGenres([song(1, 'anime-op', 'YOASOBI')], GENRES, index(), none);
    assert.equal(flags[0]?.reason, 'wrong-shape');
  });

  it("flags a work whose prompt is another genre's", () => {
    const { flags } = checkGenres([work(1, 'anime-op', 'Titanic', 'field.work.film')], GENRES, index(), none);
    assert.deepEqual(flags, [{ mediaId: 1, reason: 'label-disagrees', suggestions: ['films-musique'] }]);
  });

  it('believes the seeds over the filing', () => {
    const seeds = index({ artists: { 'bruno mars': ['pop'], booba: ['rap-fr'] } });
    const { flags } = checkGenres(
      [song(1, 'rap-us', 'Bruno Mars'), song(2, 'rap-fr', 'Booba')],
      GENRES,
      {
        ...seeds,
        harvested: new Set(['pop', 'rap-fr', 'rap-us'])
      },
      none
    );
    assert.deepEqual(flags, [{ mediaId: 1, reason: 'seed-elsewhere', suggestions: ['pop'] }]);
  });

  it('says nothing about a genre that has no seeds to compare with', () => {
    // rap-us never harvested: its silence proves nothing.
    const { flags } = checkGenres(
      [song(1, 'rap-us', 'Bruno Mars')],
      GENRES,
      index({ artists: { 'bruno mars': ['pop'] } }),
      none
    );
    assert.deepEqual(flags, []);
  });

  it('counts a facet as its parent', () => {
    const seeds = { ...index({ artists: { nas: ['rap-us'] } }), harvested: new Set(['rap-us']) };
    const { flags } = checkGenres([song(1, 'rap-90s', 'Nas')], GENRES, seeds, none);
    assert.deepEqual(flags, []);
  });

  it('flags the odd one out among an artist’s entries', () => {
    const items = [song(1, 'pop', 'Daft Punk'), song(2, 'electro', 'Daft Punk'), song(3, 'electro', 'Daft Punk')];
    const { flags } = checkGenres(items, GENRES, index(), none);
    assert.deepEqual(flags, [{ mediaId: 1, reason: 'artist-elsewhere', suggestions: ['electro'] }]);
  });

  it('does not call a one-to-one split a mistake', () => {
    const items = [song(1, 'pop', 'Drake'), song(2, 'rap-us', 'Drake')];
    assert.deepEqual(checkGenres(items, GENRES, index(), none).flags, []);
  });

  it('honours a dismissal only while the genre is unchanged', () => {
    const items = [song(1, 'pop', 'Daft Punk'), song(2, 'electro', 'Daft Punk'), song(3, 'electro', 'Daft Punk')];
    assert.deepEqual(checkGenres(items, GENRES, index(), new Map([[1, 'pop']])).flags, []);
    assert.equal(checkGenres(items, GENRES, index(), new Map([[1, 'rock']])).flags.length, 1);
  });

  it('lists the old catch-all prompt separately', () => {
    const items = [
      work(1, 'anime-op', 'Naruto', 'field.work'),
      work(2, 'anime-op', 'Bleach', 'field.work.animeOpening')
    ];
    const check = checkGenres(items, GENRES, index(), none);
    assert.deepEqual(check.legacyLabels, [1]);
    assert.deepEqual(check.flags, []);
  });
});

describe('answersForGenre', () => {
  it("rewrites a stock work prompt to the genre's", () => {
    const games = GENRES.find((genre) => genre.id === 'jeux-video');
    assert.ok(games);
    const [answer] = answersForGenre([{ key: 'work', label: 'field.work', value: 'Zelda' }], games);
    assert.equal(answer?.label, 'field.work.game');
    const [moved] = answersForGenre([{ key: 'work', label: 'field.work.film', value: 'Zelda' }], games);
    assert.equal(moved?.label, 'field.work.game');
  });

  it('asks for the composer and the piece once a song moves to classical, and back', () => {
    const classical = GENRES.find((genre) => genre.id === 'classique');
    const rock = GENRES.find((genre) => genre.id === 'rock');
    assert.ok(classical && rock);
    const song = [
      { key: 'title', label: 'field.title', value: 'Boléro' },
      { key: 'artist', label: 'field.artist', value: 'Ravel' }
    ];
    const moved = answersForGenre(song, classical);
    assert.deepEqual(
      moved.map((answer) => answer.label),
      ['field.piece', 'field.composer']
    );
    assert.deepEqual(
      answersForGenre(moved, rock).map((answer) => answer.label),
      ['field.title', 'field.artist']
    );
  });

  it('leaves a hand-written prompt and other fields alone', () => {
    const games = GENRES.find((genre) => genre.id === 'jeux-video');
    assert.ok(games);
    const answers = answersForGenre(
      [
        { key: 'work', label: 'Quel jeu Nintendo ?', value: 'Zelda' },
        { key: 'title', label: 'field.title', value: 'x' }
      ],
      games
    );
    assert.deepEqual(
      answers.map((answer) => answer.label),
      ['Quel jeu Nintendo ?', 'field.title']
    );
  });
});
