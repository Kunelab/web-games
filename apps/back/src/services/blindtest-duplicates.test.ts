import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  findDuplicatePairs,
  groupPairs,
  levenshtein,
  pairReason,
  type DuplicateItem
} from './blindtest-duplicates.js';

function item(id: number, artist: string, title: string, code: string | null = `video${id}`): DuplicateItem {
  return { id, code, artist, title };
}

describe('pairReason', () => {
  it('flags the same upload saved twice', () => {
    assert.equal(pairReason(item(1, 'Queen', 'Bohemian Rhapsody', 'abc'), item(2, 'Queen', 'Bohemian Rhapsody', 'abc')), 'same-video');
  });

  it('flags the same recording under two uploads', () => {
    assert.equal(pairReason(item(1, 'Queen', 'Bohemian Rhapsody'), item(2, 'Queen', 'Bohemian Rhapsody')), 'same-track');
  });

  it('ignores case, accents and featuring credits', () => {
    assert.equal(pairReason(item(1, 'Beyoncé', 'Halo'), item(2, 'beyonce', 'Halo')), 'same-track');
    assert.equal(
      pairReason(item(1, 'Luis Fonsi', 'Despacito'), item(2, 'Luis Fonsi', 'Despacito ft. Daddy Yankee')),
      'same-track'
    );
  });

  it('flags a typo on one side as similar', () => {
    assert.equal(pairReason(item(1, 'Queen', 'Bohemian Rhapsody'), item(2, 'Queen', 'Bohemian Rapsody')), 'similar');
    assert.equal(pairReason(item(1, 'Queen', 'Bohemian Rhapsody'), item(2, 'Qeen', 'Bohemian Rhapsody')), 'similar');
  });

  it('does not mistake a cover for a duplicate', () => {
    // Same title, genuinely different artist: a different round, not a repeat.
    assert.equal(pairReason(item(1, 'Jeff Buckley', 'Hallelujah'), item(2, 'Leonard Cohen', 'Hallelujah')), null);
  });

  it('does not flag short strings that merely differ', () => {
    assert.equal(pairReason(item(1, 'AB', 'Go'), item(2, 'AB', 'No')), null);
  });

  it('flags work answers by the work alone', () => {
    assert.equal(pairReason(item(1, '', 'Naruto'), item(2, '', 'Naruto')), 'same-track');
    assert.equal(pairReason(item(1, '', 'Naruto'), item(2, '', 'Narutto')), 'similar');
  });

  it('never flags an entry against itself', () => {
    assert.equal(pairReason(item(1, 'Queen', 'Halo'), item(1, 'Queen', 'Halo')), null);
  });
});

describe('levenshtein', () => {
  it('measures plain distances', () => {
    assert.equal(levenshtein('queen', 'qeen', 2), 1);
    assert.equal(levenshtein('halo', 'halo', 2), 0);
  });

  it('bails out past the cap', () => {
    assert.ok(levenshtein('queen', 'metallica', 2) > 2);
  });
});

describe('findDuplicatePairs and groupPairs', () => {
  it('links a chain into one group with the strongest reason', () => {
    const items = [
      item(1, 'Queen', 'Bohemian Rhapsody', 'shared'),
      item(2, 'Queen', 'Bohemian Rhapsody', 'shared'),
      item(3, 'Queen', 'Bohemian Rapsody', 'other')
    ];
    const groups = groupPairs(findDuplicatePairs(items));
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.reason, 'same-video');
    assert.deepEqual(groups[0]?.mediaIds, [1, 2, 3]);
  });

  it('keeps unrelated pairs apart', () => {
    const items = [item(1, 'Queen', 'Halo'), item(2, 'Queen', 'Halo'), item(3, 'ABBA', 'Dancing Queen'), item(4, 'ABBA', 'Dancing Queen')];
    const groups = groupPairs(findDuplicatePairs(items));
    assert.equal(groups.length, 2);
  });

  it('returns nothing for a clean list', () => {
    const items = [item(1, 'Queen', 'Halo'), item(2, 'ABBA', 'Dancing Queen')];
    assert.deepEqual(findDuplicatePairs(items), []);
    assert.deepEqual(groupPairs([]), []);
  });
});
