import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withEras, yearOf, type EraGenre } from './blindtest-eras.js';

const genres: EraGenre[] = [
  { id: 'rap-us' },
  { id: 'rap-fr' },
  { id: 'electro' },
  { id: 'rap-90s', facetOf: 'rap-us', yearRange: { from: 1988, to: 1999 } },
  { id: 'rap-fr-90s', facetOf: 'rap-fr', yearRange: { from: 1988, to: 1999 } },
  { id: 'dance-90s', facetOf: 'electro', yearRange: { from: 1988, to: 1999 } }
];

describe('withEras', () => {
  it('files a round in the eras of its genre its year is in', () => {
    assert.deepEqual(withEras({ code: 'x' }, 'rap-us', '1995-01-01', genres), { code: 'x', alsoIn: ['rap-90s'] });
    assert.deepEqual(withEras({ code: 'x' }, 'rap-us', '2005-01-01', genres), { code: 'x' });
    assert.deepEqual(withEras({ code: 'x' }, 'rap-us', null, genres), { code: 'x' });
  });

  it('and in the eras of its other genres, keeping those', () => {
    assert.deepEqual(withEras({ alsoIn: ['electro'] }, 'rap-us', '1993-01-01', genres), {
      alsoIn: ['electro', 'rap-90s', 'dance-90s']
    });
  });

  it('drops the eras of a genre it left, and returns the same payload when nothing changes', () => {
    assert.deepEqual(withEras({ alsoIn: ['rap-90s'] }, 'rap-fr', '1995-01-01', genres), { alsoIn: ['rap-fr-90s'] });
    const current = { alsoIn: ['rap-90s'] };
    assert.equal(withEras(current, 'rap-us', '1995-01-01', genres), current);
  });

  it('leaves what an admin ticked alone', () => {
    const ticked = { alsoIn: ['rap-90s'], alsoInBy: 'human' };
    assert.equal(withEras(ticked, 'rap-fr', '2015-01-01', genres), ticked);
  });

  it('reads the year off a date', () => {
    assert.equal(yearOf('1997-01-01'), 1997);
    assert.equal(yearOf(null), null);
    assert.equal(yearOf('soon'), null);
  });
});
