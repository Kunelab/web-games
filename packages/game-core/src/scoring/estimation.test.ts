import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AnswerField } from '../media/answer-field.js';
import { parseEstimate, scoreEstimationRound, type EstimationGuess } from './estimation.js';
import { scoringConfigSchema } from './score.js';

const config = scoringConfigSchema.parse({});

function estimateField(value: string, points = 10): AnswerField {
  return { key: 'estimate', label: '', value, aliases: [], points, tolerance: 0, directBonus: 0 };
}

function guess(playerId: string, value: number, answeredAt = 0): EstimationGuess {
  return { playerId, value, answeredAt };
}

describe('parseEstimate', () => {
  it('reads plain integers and decimals', () => {
    assert.equal(parseEstimate('42'), 42);
    assert.equal(parseEstimate('-3.5'), -3.5);
    assert.equal(parseEstimate('  1984 '), 1984);
  });

  it('accepts a comma as the decimal separator', () => {
    assert.equal(parseEstimate('3,14'), 3.14);
  });

  it('drops grouping spaces and grouping commas', () => {
    assert.equal(parseEstimate('1 234 567'), 1_234_567);
    assert.equal(parseEstimate('1,234,567'), 1_234_567);
    assert.equal(parseEstimate('1,234.5'), 1234.5);
  });

  it('refuses what is not a number', () => {
    assert.equal(parseEstimate(''), null);
    assert.equal(parseEstimate('beaucoup'), null);
    assert.equal(parseEstimate('12km'), null);
    assert.equal(parseEstimate('1.2.3'), null);
  });
});

describe('scoreEstimationRound', () => {
  it('ranks by distance, not by speed', () => {
    const scores = scoreEstimationRound(
      [
        // The fast player is far off; the slow one is close. Distance must win.
        guess('fast-far', 900, 1),
        guess('slow-close', 110, 9_999),
        guess('middle', 130, 5_000)
      ],
      estimateField('100'),
      config
    );

    assert.deepEqual(
      scores.map((score) => score.playerId),
      ['slow-close', 'middle', 'fast-far']
    );
    // Position multipliers straight from the shared config: 1, 0.7, 0.5.
    assert.equal(scores[0]?.total, 10);
    assert.equal(scores[1]?.total, 7);
    assert.equal(scores[2]?.total, 5);
  });

  it('treats over and under by the same margin as a tie, broken by nothing', () => {
    const scores = scoreEstimationRound([guess('over', 105, 2), guess('under', 95, 1)], estimateField('100'), config);

    // Both are 5 away: both take the first-position multiplier.
    assert.equal(scores.find((score) => score.playerId === 'over')?.total, 10);
    assert.equal(scores.find((score) => score.playerId === 'under')?.total, 10);
  });

  it('resumes positions after a shared one', () => {
    const scores = scoreEstimationRound(
      [guess('a', 95), guess('b', 105), guess('c', 110)],
      estimateField('100'),
      config
    );

    // a and b share first; c is third (multiplier 0.5), not second.
    assert.equal(scores.find((score) => score.playerId === 'c')?.total, 5);
  });

  it('pays half the base points again for the exact value', () => {
    const scores = scoreEstimationRound([guess('exact', 100), guess('near', 101)], estimateField('100'), config);

    assert.equal(scores.find((score) => score.playerId === 'exact')?.total, 15);
    assert.equal(scores.find((score) => score.playerId === 'near')?.total, 7);
  });

  it('scores nobody when the authored answer is not a number', () => {
    const scores = scoreEstimationRound([guess('a', 100)], estimateField('environ cent'), config);
    assert.equal(scores.length, 0);
  });

  it('feeds the shared combo machinery', () => {
    const comboConfig = scoringConfigSchema.parse({ combo: { enabled: true } });
    const scores = scoreEstimationRound(
      [guess('streaky', 100), guess('other', 200)],
      estimateField('100'),
      comboConfig,
      { comboLengths: new Map([['streaky', 2]]) }
    );

    const streaky = scores.find((score) => score.playerId === 'streaky');
    // Two wins in the bank: ×1.2 on what was earned this round.
    assert.equal(streaky?.comboMultiplier, 1.2);
    assert.equal(streaky?.comboLength, 3);
  });
});
