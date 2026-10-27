import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findGaps, type GapRound, type GapSeed } from './blindtest-gaps.js';

const genres = [
  { id: 'pop', answerShape: 'artist-title', requestable: true },
  { id: 'rock', answerShape: 'artist-title', requestable: true },
  { id: 'classique', answerShape: 'artist-title', requestable: false },
  { id: 'films', answerShape: 'work', requestable: true }
];

function seed(genreId: string, artist: string, title: string, fame: number, source = 'deezer'): GapSeed {
  return { genreId, source, artist, title, search: title, fame, searched: false };
}

function song(category: string, artist: string): GapRound {
  return { category, answers: [{ key: 'artist', value: artist }] };
}

describe('findGaps', () => {
  it('lists a famous artist with few songs anywhere, where most of their seeds are', () => {
    const seeds = [
      ...Array.from({ length: 4 }, (_, index) => seed('pop', 'Stevie Wonder', `Hit ${index}`, 1, 'chart')),
      seed('rock', 'Stevie Wonder', 'Superstition', 0.5),
      // Famous and well stocked, across two genres.
      ...Array.from({ length: 4 }, (_, index) => seed('pop', 'Queen', `Q ${index}`, 1, 'chart'))
    ];
    const rounds = [song('rock', 'Queen'), song('pop', 'Queen'), song('pop', 'Queen'), song('rock', 'Queen')];
    const { artists } = findGaps(rounds, seeds, new Set(), genres);
    assert.deepEqual(artists, [{ artist: 'Stevie Wonder', genreId: 'pop', rounds: 0, seeds: 5, charts: 4 }]);
  });

  it('counts a round by the artist’s other names, and leaves out what was asked for', () => {
    const seeds = Array.from({ length: 4 }, (_, index) => seed('pop', 'Prince', `P ${index}`, 1, 'chart'));
    const aliased: GapRound = { category: 'pop', answers: [{ key: 'artist', value: 'TAFKAP', aliases: ['Prince'] }] };
    assert.equal(findGaps([aliased], seeds, new Set(), genres).artists[0]?.rounds, 1);
    assert.deepEqual(findGaps([], seeds, new Set(['prince']), genres).artists, []);
  });

  it('lists a famous work with no round in its genre, not one filed or of a genre nobody asks in', () => {
    const seeds = [
      seed('films', '', 'Interstellar', 0.99),
      seed('films', '', 'Titanic', 0.99),
      seed('films', '', 'Obscure', 0.5),
      seed('classique', 'Bach', 'Toccata', 1, 'chart')
    ];
    const rounds: GapRound[] = [{ category: 'films', answers: [{ key: 'work', value: 'Titanic' }] }];
    const gaps = findGaps(rounds, seeds, new Set(), genres);
    assert.deepEqual(gaps.works, [{ work: 'Interstellar', genreId: 'films', fame: 0.99, searched: false }]);
    assert.deepEqual(gaps.artists, []);
  });
});
