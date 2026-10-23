import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withHandEdits, type BlindtestPayload } from './blindtest.js';

const saved: BlindtestPayload = {
  code: 'abcdefghijk',
  startGuess: 40,
  endGuess: 60,
  startReveal: 59,
  endReveal: 71,
  volume: 100,
  difficulty: 30,
  difficultyBy: 'auto',
  timingBy: 'auto',
  fame: { views: 1000, looked: true }
};

describe('withHandEdits', () => {
  it('marks a difficulty a person moved as theirs, and leaves the clip automatic', () => {
    const next = withHandEdits(saved, { ...saved, difficulty: 85 });
    assert.equal(next.difficultyBy, 'human');
    assert.equal(next.timingBy, 'auto');
  });

  it('marks a moved clip as theirs', () => {
    assert.equal(withHandEdits(saved, { ...saved, startGuess: 55, endGuess: 75 }).timingBy, 'human');
  });

  it('keeps the evidence an editor that does not show it would drop', () => {
    const { fame: _fame, difficultyBy: _by, timingBy: _timing, ...shown } = saved;
    const next = withHandEdits(saved, shown);
    assert.deepEqual(next.fame, saved.fame);
    assert.equal(next.difficultyBy, 'auto');
  });

  it('counts clearing the difficulty as a person’s say', () => {
    assert.equal(withHandEdits(saved, { ...saved, difficulty: null }).difficultyBy, 'human');
  });
});
