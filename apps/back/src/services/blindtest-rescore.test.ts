import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { genreById } from './blindtest-catalog.js';
import { planRescore, type RescoreRow } from './blindtest-rescore.js';

/**
 * What the rescoring script decides for each round, before it writes anything.
 *
 * The script itself loads, fetches and saves; every decision about what it may
 * change, and against which scale, is made here.
 */

const reggae = genreById.get('reggae')!;
const animeOpenings = genreById.get('anime-op')!;

/** A catalogue round as filed: the database's own timestamp in both columns. */
function row(overrides: Partial<RescoreRow> = {}): RescoreRow {
  return {
    id: 1,
    genre: reggae,
    payload: { code: 'abcdefghijk', startGuess: 40, endGuess: 60, startReveal: 59, endReveal: 71, difficulty: 30 },
    createdAt: '2026-10-01 20:00:00',
    lastModified: '2026-10-01 20:00:00',
    fame: { looked: true, model: 50 },
    durationSeconds: null,
    upload: 'video',
    chorus: null,
    hintFraction: null,
    ...overrides
  };
}

const options = { includeEdited: false, partial: false, retime: true, stored: new Map(), random: () => 0.5 };

describe('what a rescoring may change', () => {
  it('leaves alone a round a host corrected seconds after it was filed', () => {
    // Filed at the start of a reveal and corrected during it, before corrections were marked.
    const corrected = row({ lastModified: '2026-10-01T20:00:05.000Z' });
    const [plan] = planRescore([corrected], options).rows;
    assert.equal(plan?.keepDifficulty, true);
    assert.equal(plan?.keepTiming, true);
  });

  it('places a clip for the difficulty a person set, not for the one it would have been given', () => {
    // A full anime song whose chorus is known: an easy round asks the chorus, a hard one a verse.
    const handRated = row({
      genre: animeOpenings,
      payload: { ...row().payload, difficulty: 10, difficultyBy: 'human', timingBy: 'auto' },
      fame: { looked: true, model: 95, recognised: false, views: 2_000, wikiLanguages: 0, anilistMembers: 0 },
      durationSeconds: 240,
      upload: 'audio',
      chorus: { hits: [60, 120, 180], line: 'the hook', trackDuration: 240 }
    });
    const [plan] = planRescore([handRated], options).rows;
    assert.equal(plan?.keepDifficulty, true);
    assert.equal(plan?.clip?.angle, 'chorus');
  });
});

describe('the scale a rescoring uses', () => {
  /** Spreads already stored for reggae, under which a middling round reads harder than the defaults would put it. */
  const stored = new Map([['reggae', { composite: { mean: -1, sd: 1 } }]]);

  it('scores a partial run against the spreads the server uses, and saves none', () => {
    const result = planRescore([row()], { ...options, partial: true, stored });
    assert.equal(result.rows[0]?.difficulty, 28);
    assert.equal(result.calibration, null);
  });

  it('fits and offers to save the spreads on a whole run', () => {
    const result = planRescore([row()], { ...options, stored });
    assert.notEqual(result.calibration, null);
  });
});
