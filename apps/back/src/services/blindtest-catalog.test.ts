import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { __testing, genreById } from './blindtest-catalog.js';
import type { Annotation } from './blindtest-llm.js';
import { buildOracle } from './blindtest-seeds.js';
import type { VideoFacts } from './youtube-service.js';

const { withoutArtistPrefix, toEntry, scoreDifficulty } = __testing;

function facts(title: string, extra: Partial<VideoFacts> = {}): VideoFacts {
  return {
    videoId: 'vid',
    title,
    channel: 'Some Channel',
    description: '',
    year: 2015,
    views: 1000,
    durationSeconds: 200,
    restriction: { embeddable: true, ageRestricted: false, privacyStatus: 'public', uploadStatus: 'processed' },
    ...extra
  };
}

function annotation(extra: Partial<Annotation>): Annotation {
  return {
    kind: 'music',
    artist: '',
    answer: '',
    aliases: [],
    difficulty: 40,
    confidence: 0.9,
    hookFraction: null,
    fitsGenre: true,
    ...extra
  };
}

describe('toEntry with seeds', () => {
  const rapUs = genreById.get('rap-us')!;
  const anime = genreById.get('anime-op')!;

  it('keeps an artist the seeds list for the genre even when the model doubts it', () => {
    const oracle = buildOracle([{ artist: 'Nas', title: 'N.Y. State of Mind', aliases: [], fame: 0.8, year: null }]);
    const doubted = annotation({ artist: 'Nas', answer: 'N.Y. State of Mind', fitsGenre: false });
    const entry = toEntry(facts('Nas - N.Y. State of Mind'), rapUs, doubted, true, oracle);
    assert.equal(entry?.artist, 'Nas');
    assert.equal(entry?.seedFame, 0.8);
  });

  it('lets the model decide in classical, where the seeds are not an editor’s list', () => {
    const classical = genreById.get('classique')!;
    const oracle = buildOracle([
      { artist: 'Patty Hill', title: 'Happy Birthday to You', aliases: [], fame: 0.9, year: null }
    ]);
    const doubted = annotation({ artist: 'Patty Hill', answer: 'Happy Birthday to You', fitsGenre: false });
    assert.equal(toEntry(facts('Happy Birthday to You - Patty Hill'), classical, doubted, true, oracle), null);
  });

  it('lets the model decide for an artist the seeds also file elsewhere', () => {
    const oracle = buildOracle([{ artist: 'Taylor Swift', title: 'x', aliases: [], fame: 0.9, year: null }]);
    oracle.contested.add('taylor swift');
    const doubted = annotation({ artist: 'Taylor Swift', answer: 'Shake It Off', fitsGenre: false });
    assert.equal(toEntry(facts('Taylor Swift - Shake It Off'), rapUs, doubted, true, oracle), null);
  });

  it('still drops what neither the seeds nor the model place in the genre', () => {
    const oracle = buildOracle([{ artist: 'Nas', title: 'x', aliases: [], fame: 0.8, year: null }]);
    const pop = annotation({ artist: 'Bruno Mars', answer: 'Grenade', fitsGenre: false });
    assert.equal(toEntry(facts('Bruno Mars - Grenade'), rapUs, pop, true, oracle), null);
  });

  it('drops a scene from a seeded anime, because the seeds cannot say it is the opening', () => {
    const oracle = buildOracle([
      { artist: '', title: 'The Quintessential Quintuplets 2', aliases: [], fame: 0.7, year: 2021 }
    ]);
    const scene = annotation({ kind: 'work', answer: 'The Quintessential Quintuplets 2', fitsGenre: false });
    assert.equal(
      toEntry(facts('Love Confession | The Quintessential Quintuplets 2'), anime, scene, true, oracle),
      null
    );
  });

  it("gives a seeded work the catalogue's names and year", () => {
    const oracle = buildOracle([
      { artist: '', title: 'Attack on Titan', aliases: ['Shingeki no Kyojin'], fame: 0.9, year: 2013 }
    ]);
    const read = annotation({ kind: 'work', answer: 'Attack on Titan', aliases: [] });
    const entry = toEntry(facts('Shingeki no Kyojin OP1 Guren no Yumiya'), anime, read, true, oracle);
    assert.equal(entry?.work, 'Attack on Titan');
    assert.deepEqual(entry?.workAliases, ['Shingeki no Kyojin']);
    assert.equal(entry?.year, 2013);
    assert.equal(entry?.yearVerified, true);
  });
});

describe('scoreDifficulty', () => {
  it('matches the old blend when there is no seed', () => {
    assert.equal(scoreDifficulty(0, 11, 50, null), Math.round((0 * 3 + 50 * 2) / 5));
  });

  it('pulls a famous seed towards easy', () => {
    const without = scoreDifficulty(10, 11, 60, null);
    const famous = scoreDifficulty(10, 11, 60, 1);
    assert.ok(famous < without);
  });
});

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
