import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { __testing } from './blindtest-catalog.js';

const { withoutArtistPrefix } = __testing;

describe('withoutArtistPrefix', () => {
  it('drops an artist the model repeated inside the title', () => {
    // Seen live: both fields right, and the title one unwinnable, because a
    // player who types the actual song name is missing the artist.
    assert.equal(withoutArtistPrefix('Action Bronson – Easy Rider', 'Action Bronson'), 'Easy Rider');
    assert.equal(withoutArtistPrefix('Dax - Still D.R.E. Remix', 'Dax'), 'Still D.R.E. Remix');
  });

  it('ignores case, accents and punctuation in the comparison', () => {
    assert.equal(withoutArtistPrefix('ORELSAN : Basique', 'OrelSan'), 'Basique');
  });

  it('leaves a title alone when the prefix is not the artist', () => {
    assert.equal(withoutArtistPrefix('Smells Like Teen Spirit', 'Nirvana'), 'Smells Like Teen Spirit');
    assert.equal(withoutArtistPrefix('Us - Them', 'Pink Floyd'), 'Us - Them');
  });

  it('keeps a track genuinely named after a separator it needs', () => {
    // The whole title is the answer here; only an exact artist prefix is dropped.
    assert.equal(withoutArtistPrefix('Bohemian Rhapsody - Remastered', 'Queen'), 'Bohemian Rhapsody - Remastered');
  });
});
