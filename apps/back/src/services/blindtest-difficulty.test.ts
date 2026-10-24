import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BlindtestFame } from 'game-core';

import {
  bellTarget,
  extremeDoubt,
  fitCalibrations,
  normalCdf,
  normalQuantile,
  resolveCalibration,
  scoreBreakdown,
  scoreDifficulty,
  type CalibrationSample,
  type FameAudience
} from './blindtest-difficulty.js';

/**
 * The scale against the cases it was tuned on.
 *
 * A reggae catalogue is made up here, two hundred rounds spread around what a
 * real one looks like, and the anchors are scored against its fitted spread:
 * Bob Marley at the very bottom of the scale for somebody who picked reggae, a
 * dancehall hit known in Jamaica and nowhere else at 85 to 90, a band nobody
 * has heard of above 95.
 */

/** log10 middle and spread of each figure in the made-up catalogue. */
const REGGAE = {
  deezerRank: [5.55, 0.3],
  deezerFans: [5.2, 0.8],
  frPageviews: [3.3, 1],
  enPageviews: [3.6, 1],
  wikiLanguages: [1.2, 0.45],
  lastfmListeners: [4.6, 0.8],
  views: [6.4, 1]
} as const;

/** Deterministic: rank i of n is the i-th quantile, with a decorrelating wobble per figure. */
function catalogue(genreId: string, size = 200): CalibrationSample[] {
  return Array.from({ length: size }, (_, index) => {
    const z = normalQuantile((index + 0.5) / size);
    const fame: BlindtestFame = { looked: true, upload: 'video', model: Math.min(100, Math.max(0, 50 - 18 * z)) };
    Object.entries(REGGAE).forEach(([signal, [mean, sd]], offset) => {
      const wobble = normalQuantile((((index * 37 + offset * 11) % size) + 0.5) / size) * 0.5;
      (fame as Record<string, unknown>)[signal] = Math.round(10 ** (mean + (z * 0.85 + wobble) * sd) - 1);
    });
    return { genreId, shape: 'artist-title', audience: 'any', fame };
  });
}

const fitted = fitCalibrations(catalogue('reggae'));
const reggae = (fame: BlindtestFame, audience: FameAudience = 'any') =>
  scoreBreakdown(fame, {
    shape: 'artist-title',
    audience,
    calibration: resolveCalibration(fitted, 'reggae', 'artist-title')
  });

const BOB_MARLEY: BlindtestFame = {
  looked: true,
  deezerRank: 900_000,
  deezerFans: 8_000_000,
  frPageviews: 80_000,
  enPageviews: 600_000,
  wikiLanguages: 150,
  lastfmListeners: 2_000_000,
  views: 300_000_000,
  upload: 'video',
  model: 5,
  recognised: true
};

/** Four million views, known in Jamaica: a handful of Wikipedia languages, no French article. */
const REGIONAL_HIT: BlindtestFame = {
  looked: true,
  deezerRank: 150_000,
  deezerFans: 30_000,
  frPageviews: 0,
  enPageviews: 3_000,
  wikiLanguages: 2,
  lastfmListeners: 3_000,
  views: 4_600_000,
  upload: 'video',
  model: 85,
  recognised: true
};

const NOBODY: BlindtestFame = {
  looked: true,
  deezerRank: 0,
  deezerFans: 0,
  frPageviews: 0,
  enPageviews: 0,
  wikiLanguages: 0,
  lastfmListeners: null,
  views: 3_000,
  upload: 'video',
  // The model guessing generously is exactly what used to land such a band at 30.
  model: 30,
  recognised: true
};

describe('a difficulty, for somebody who picked the genre', () => {
  it('puts the head of the genre at the very bottom of the scale', () => {
    assert.ok(reggae(BOB_MARLEY).difficulty <= 5, JSON.stringify(reggae(BOB_MARLEY)));
  });

  it('puts a hit known only in its own country near the top', () => {
    const { difficulty } = reggae(REGIONAL_HIT);
    assert.ok(difficulty >= 82 && difficulty <= 92, String(difficulty));
  });

  it('puts a band nobody has heard of above 95, whatever the model guessed', () => {
    assert.ok(reggae(NOBODY).difficulty >= 95, JSON.stringify(reggae(NOBODY)));
  });

  it('holds such a band above 95 on a Topic upload too, where most of them live', () => {
    const onTopic = reggae({ ...NOBODY, upload: 'topic' });
    assert.ok(onTopic.difficulty >= 95, JSON.stringify(onTopic));
  });

  it('spreads the genre on a bell: a middle around 50, half the rounds between 35 and 65', () => {
    const scores = catalogue('reggae')
      .map((sample) => reggae(sample.fame).difficulty)
      .sort((a, b) => a - b);
    const median = scores[Math.floor(scores.length / 2)];
    const middle = scores.filter((score) => score >= 35 && score <= 65).length / scores.length;
    assert.ok(Math.abs(median - 50) <= 6, `median ${median}`);
    assert.ok(middle >= 0.4 && middle <= 0.65, `middle share ${middle}`);
  });

  it('judges the same figures against their own genre: a metal fan count that is ordinary for pop', () => {
    const quieter = catalogue('metal').map((sample) => ({
      ...sample,
      fame: { ...sample.fame, deezerFans: Math.round((sample.fame.deezerFans ?? 0) / 10) }
    }));
    const both = fitCalibrations([...catalogue('pop'), ...quieter]);
    const band: BlindtestFame = { looked: true, deezerFans: 150_000 };
    const as = (genreId: string) =>
      scoreDifficulty(band, {
        shape: 'artist-title',
        audience: 'any',
        calibration: resolveCalibration(both, genreId, 'artist-title')
      });
    assert.ok(as('metal') < as('pop'), `metal ${as('metal')} < pop ${as('pop')}`);
  });
});

describe('the ends of the scale, earned', () => {
  /**
   * A French genre whose rounds agree, so the blend spreads narrowly: rap
   * français, where an ordinary SDM song came out at 1 on SDM's name alone.
   */
  const french = {
    shape: 'artist-title' as const,
    audience: 'fr' as const,
    calibration: { composite: { mean: 0, sd: 0.5 } }
  };
  /** A star's name on a song nobody plays: everything about the artist, nothing about the song. */
  const DEEP_CUT: BlindtestFame = {
    looked: true,
    deezerRank: 350_000,
    deezerFans: 20_000_000,
    frPageviews: 2_000_000,
    views: 500_000,
    upload: 'video',
    model: 2,
    recognised: true,
    seedFame: 0.8
  };

  it('keeps an ordinary song by a famous artist off the easy end', () => {
    const scored = scoreBreakdown(DEEP_CUT, french);
    assert.equal(scored.difficulty, 15);
    assert.equal(scored.rule, 'artist-only');
  });

  it('lets it through once the song itself is a hit, by any of its own figures', () => {
    for (const hit of [{ seedFame: 0.95 }, { deezerRank: 950_000 }, { views: 100_000_000 }]) {
      const scored = scoreBreakdown({ ...DEEP_CUT, ...hit }, french);
      assert.ok(scored.difficulty <= 10, JSON.stringify({ hit, scored }));
    }
  });

  it('keeps a song with millions of views out of the 90s, whatever else the lookup found', () => {
    // A namesake with a few fans, where the real act is filed under another name.
    const scored = reggae({ ...NOBODY, deezerFans: 200, views: 8_800_000 });
    assert.equal(scored.difficulty, 85);
    assert.equal(scored.rule, 'contradicted');
  });

  it('does not read a song found nowhere as obscure, unless its views say so too', () => {
    const unfound = reggae({ ...NOBODY, views: 8_800_000 });
    assert.equal(unfound.unfound, true);
    assert.ok(unfound.difficulty < 85, JSON.stringify(unfound));
    // Few views and nothing anywhere: that one nobody knows.
    assert.equal(reggae(NOBODY).unfound, false);
  });

  it('counts a classical piece’s own Wikipedias as the song’s fame', () => {
    const piece = { looked: true, deezerFans: 1_400_000, wikiLanguages: 90, frPageviews: 60_000, model: 2 };
    const context = { shape: 'artist-title' as const, audience: 'any' as const, calibration: {} };
    assert.equal(extremeDoubt(3, piece, context), 'easy-unconfirmed');
    assert.equal(extremeDoubt(3, piece, { ...context, piece: true }), null);
  });

  it('says which stored extremes nothing backs', () => {
    const anywhere = {
      ...french,
      audience: 'any' as const,
      calibration: resolveCalibration(fitted, 'reggae', 'artist-title')
    };
    assert.equal(extremeDoubt(50, DEEP_CUT, french), null);
    assert.equal(extremeDoubt(3, DEEP_CUT, french), 'easy-unconfirmed');
    assert.equal(extremeDoubt(3, BOB_MARLEY, anywhere), null);
    assert.equal(extremeDoubt(96, NOBODY, anywhere), null);
    assert.equal(extremeDoubt(96, { ...NOBODY, deezerFans: 200, views: 8_800_000 }, anywhere), 'hard-contradicted');
    assert.equal(extremeDoubt(40, { ...NOBODY, views: 8_800_000 }, anywhere), 'not-found');
    assert.equal(extremeDoubt(96, null, anywhere), 'unscored');
    // A film's figures are the film's own: no artist to borrow fame from.
    assert.equal(extremeDoubt(3, { looked: true, tmdbVotes: 5 }, { ...anywhere, shape: 'work' }), null);
  });

  it('places a genre’s top tenth where its hits are, though its rank stops at a million', () => {
    // Bunched under the ceiling: the best rank there is sits less than one spread above the middle.
    const ranks = catalogue('rap-fr').map((sample) => ({
      ...sample,
      fame: { ...sample.fame, deezerRank: Math.min(1_000_000, (sample.fame.deezerRank ?? 0) * 3) }
    }));
    const scale = resolveCalibration(fitCalibrations(ranks), 'rap-fr', 'artist-title').deezerRank;
    assert.ok(
      scale?.top !== undefined && scale.top > scale.mean && scale.top <= Math.log10(1_000_001),
      JSON.stringify(scale)
    );
  });
});

describe('French or worldwide fame', () => {
  /** A French rapper: everything French says famous, nothing abroad does. */
  const FRENCH_RAPPER: BlindtestFame = {
    looked: true,
    deezerRank: 950_000,
    deezerFans: 3_000_000,
    frPageviews: 120_000,
    enPageviews: 0,
    wikiLanguages: 3,
    lastfmListeners: 20_000
  };
  /** And the other way round: known everywhere but in France. */
  const ABROAD_ONLY: BlindtestFame = {
    looked: true,
    deezerRank: 120_000,
    deezerFans: 8_000,
    frPageviews: 0,
    enPageviews: 900_000,
    wikiLanguages: 90,
    lastfmListeners: 3_000_000
  };
  const score = (fame: BlindtestFame, audience: FameAudience) =>
    scoreDifficulty(fame, { shape: 'artist-title', audience, calibration: {} });

  it('counts French fame alone in the French genres', () => {
    assert.ok(score(FRENCH_RAPPER, 'fr') <= 20, String(score(FRENCH_RAPPER, 'fr')));
    assert.ok(score(ABROAD_ONLY, 'fr') >= 75, String(score(ABROAD_ONLY, 'fr')));
  });

  it('takes the better of the two everywhere else, whichever country it comes from', () => {
    assert.ok(score(ABROAD_ONLY, 'any') <= 20, String(score(ABROAD_ONLY, 'any')));
    assert.ok(score(FRENCH_RAPPER, 'any') <= 20, String(score(FRENCH_RAPPER, 'any')));
  });
});

describe('the weak signals', () => {
  const base: BlindtestFame = { looked: true, deezerRank: 400_000, deezerFans: 100_000, frPageviews: 2_000 };
  const score = (fame: BlindtestFame) =>
    scoreDifficulty(fame, { shape: 'artist-title', audience: 'any', calibration: {} });

  it('never lets views make a round easier, only harder', () => {
    assert.equal(score({ ...base, views: 2_000_000_000 }), score(base));
    assert.ok(score({ ...base, views: 2_000 }) > score(base));
  });

  it('reads a Topic upload’s views up, since the music video holds most of a song’s', () => {
    assert.ok(score({ ...base, views: 20_000, upload: 'topic' }) < score({ ...base, views: 20_000, upload: 'video' }));
  });

  it('takes "not recognised" as at least 80 from the model', () => {
    const unknown = { views: 2_000_000, model: 20, recognised: false };
    assert.ok(score(unknown) > score({ ...unknown, recognised: true }));
  });

  it('does not read a lookup whose requests all failed as "nobody has heard of it"', () => {
    assert.ok(score({ looked: true, views: 1_000, model: 50, recognised: true }) < 95);
  });

  it('lets the catalogues overrule a model that does not know an artist they do', () => {
    const known = { looked: true, deezerFans: 100_000, wikiLanguages: 4, views: 4_000, model: 90, recognised: false };
    assert.equal(scoreBreakdown(known, { shape: 'artist-title', audience: 'any', calibration: {} }).rule, null);
  });

  it('falls back on the model alone, with few views, when nothing could be looked up', () => {
    assert.ok(score({ views: 4_000, model: 90, recognised: false }) >= 95);
    assert.equal(scoreBreakdown({}, { shape: 'artist-title', audience: 'any', calibration: {} }).difficulty, 50);
  });
});

describe('the fitted spreads', () => {
  it('lend a genre with too few rounds its shape’s', () => {
    const fittedSmall = fitCalibrations([...catalogue('reggae'), ...catalogue('kpop', 10)]);
    assert.ok(!fittedSmall.get('kpop')?.deezerFans);
    assert.deepEqual(
      resolveCalibration(fittedSmall, 'kpop', 'artist-title').deezerFans,
      resolveCalibration(fittedSmall, '*artist-title', 'artist-title').deezerFans
    );
  });
});

describe('the bell the draw aims on', () => {
  it('stays in the window, and is centred like the catalogue', () => {
    let seed = 1;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const targets = Array.from({ length: 2000 }, () => bellTarget(0, 100, random));
    const mean = targets.reduce((sum, value) => sum + value, 0) / targets.length;
    assert.ok(Math.abs(mean - 50) < 2, String(mean));
    assert.ok(targets.filter((value) => value <= 10).length / targets.length < 0.06);

    for (let index = 0; index < 200; index++) {
      const target = bellTarget(90, 100, random);
      assert.ok(target >= 90 && target <= 100, String(target));
    }
  });

  it('inverts its own distribution function', () => {
    for (const p of [0.001, 0.02, 0.3, 0.5, 0.77, 0.99]) {
      assert.ok(Math.abs(normalCdf(normalQuantile(p)) - p) < 1e-5);
    }
  });
});
