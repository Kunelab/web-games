import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AnswerField } from '../media/answer-field.js';
import { buildLeaderboard, scoreRound, scoringConfigSchema, type ScoredSubmission } from './score.js';

const START = 1_000_000;
const ANSWER_MS = 30_000;

function field(key: string, points: number, directBonus = 0): AnswerField {
  return { key, label: key, value: key, aliases: [], points, tolerance: 0.17, directBonus };
}

function submission(
  overrides: Partial<ScoredSubmission> & Pick<ScoredSubmission, 'playerId' | 'fieldKey'>
): ScoredSubmission {
  return { answeredAt: START, correct: true, direct: false, ...overrides };
}

// Position only, so the ordering assertions are not clouded by either speed term.
const positionOnly = scoringConfigSchema.parse({ speedBonusMax: 0, relativeSpeedBonusMax: 0 });

describe('scoreRound', () => {
  it('rewards position above all else', () => {
    const fields = [field('title', 10)];
    const scores = scoreRound(
      [
        submission({ playerId: 'first', fieldKey: 'title', answeredAt: START + 100 }),
        submission({ playerId: 'second', fieldKey: 'title', answeredAt: START + 200 }),
        submission({ playerId: 'third', fieldKey: 'title', answeredAt: START + 300 })
      ],
      fields,
      START,
      ANSWER_MS,
      positionOnly
    );

    assert.deepEqual(
      scores.map((score) => score.playerId),
      ['first', 'second', 'third']
    );
    assert.equal(scores[0]?.total, 10);
    assert.equal(scores[1]?.total, 7);
    assert.equal(scores[2]?.total, 5);
  });

  it('scores position per field, not per round', () => {
    // The heart of the model: two players can each be first at something.
    const fields = [field('title', 10), field('artist', 10)];
    const scores = scoreRound(
      [
        submission({ playerId: 'alice', fieldKey: 'title', answeredAt: START + 100 }),
        submission({ playerId: 'bob', fieldKey: 'title', answeredAt: START + 500 }),
        submission({ playerId: 'bob', fieldKey: 'artist', answeredAt: START + 200 }),
        submission({ playerId: 'alice', fieldKey: 'artist', answeredAt: START + 900 })
      ],
      fields,
      START,
      ANSWER_MS,
      positionOnly
    );

    const alice = scores.find((score) => score.playerId === 'alice');
    const bob = scores.find((score) => score.playerId === 'bob');
    // Each took first on one field and second on the other.
    assert.equal(alice?.total, 17);
    assert.equal(bob?.total, 17);
  });

  it('separates players by speed once position no longer does', () => {
    // Flat multipliers, so position contributes nothing and the speed term is the
    // only thing left to rank on.
    const flat = scoringConfigSchema.parse({
      speedBonusMax: 2,
      relativeSpeedBonusMax: 0,
      positionMultipliers: [1, 1]
    });
    const scores = scoreRound(
      [
        submission({ playerId: 'fast', fieldKey: 'title', answeredAt: START + 1_000 }),
        submission({ playerId: 'slow', fieldKey: 'title', answeredAt: START + 29_000 })
      ],
      [field('title', 5)],
      START,
      ANSWER_MS,
      flat
    );

    const fast = scores.find((score) => score.playerId === 'fast')?.total ?? 0;
    const slow = scores.find((score) => score.playerId === 'slow')?.total ?? 0;
    assert.ok(fast > slow);
    // And the whole speed term stays within its configured ceiling.
    assert.ok(fast - slow <= 2);
  });

  it('keeps position dominant over speed', () => {
    // The property that matters: answering first but slowly must still beat
    // answering second at the last possible instant.
    const config = scoringConfigSchema.parse({ speedBonusMax: 1 });
    const scores = scoreRound(
      [
        submission({ playerId: 'first-but-slow', fieldKey: 'title', answeredAt: START + 28_000 }),
        submission({ playerId: 'second', fieldKey: 'title', answeredAt: START + 29_000 })
      ],
      [field('title', 10)],
      START,
      ANSWER_MS,
      config
    );

    assert.equal(scores[0]?.playerId, 'first-but-slow');
  });

  it('awards the direct bonus only when the choices were skipped', () => {
    const fields = [field('answer', 3, 3)];

    const direct = scoreRound(
      [submission({ playerId: 'gambler', fieldKey: 'answer', direct: true })],
      fields,
      START,
      ANSWER_MS,
      positionOnly
    );
    const revealed = scoreRound(
      [submission({ playerId: 'safe', fieldKey: 'answer', direct: false })],
      fields,
      START,
      ANSWER_MS,
      positionOnly
    );

    assert.equal(direct[0]?.total, 6);
    assert.equal(revealed[0]?.total, 3);
  });

  it('counts only a player first correct answer for a field', () => {
    const scores = scoreRound(
      [
        submission({ playerId: 'p1', fieldKey: 'title', answeredAt: START + 100 }),
        submission({ playerId: 'p1', fieldKey: 'title', answeredAt: START + 200 })
      ],
      [field('title', 10)],
      START,
      ANSWER_MS,
      positionOnly
    );

    assert.equal(scores.length, 1);
    assert.equal(scores[0]?.entries.length, 1);
    assert.equal(scores[0]?.total, 10);
  });

  it('does not let a duplicate submission steal the next position', () => {
    // p1 answering twice must not push p2 from second to third.
    const scores = scoreRound(
      [
        submission({ playerId: 'p1', fieldKey: 'title', answeredAt: START + 100 }),
        submission({ playerId: 'p1', fieldKey: 'title', answeredAt: START + 150 }),
        submission({ playerId: 'p2', fieldKey: 'title', answeredAt: START + 200 })
      ],
      [field('title', 10)],
      START,
      ANSWER_MS,
      positionOnly
    );

    assert.equal(scores.find((score) => score.playerId === 'p2')?.total, 7);
  });

  it('applies the wrong answer penalty', () => {
    const config = scoringConfigSchema.parse({
      speedBonusMax: 0,
      relativeSpeedBonusMax: 0,
      wrongAnswerPenalty: 2
    });
    const scores = scoreRound(
      [submission({ playerId: 'p1', fieldKey: 'title', correct: false })],
      [field('title', 10)],
      START,
      ANSWER_MS,
      config
    );

    assert.equal(scores[0]?.total, -2);
    assert.equal(scores[0]?.penalties, 2);
  });

  it('scores a memory panel as one race per item', () => {
    const panel = [field('a', 1), field('b', 1), field('c', 1)];
    const scores = scoreRound(
      [
        submission({ playerId: 'p1', fieldKey: 'a', answeredAt: START + 100 }),
        submission({ playerId: 'p1', fieldKey: 'b', answeredAt: START + 200 }),
        submission({ playerId: 'p2', fieldKey: 'a', answeredAt: START + 300 })
      ],
      panel,
      START,
      ANSWER_MS,
      positionOnly
    );

    // p1: first on a and b. p2: second on a.
    assert.equal(scores.find((score) => score.playerId === 'p1')?.total, 2);
    assert.equal(scores.find((score) => score.playerId === 'p2')?.total, 0.7);
  });

  it('awards a perfect round bonus only for every field', () => {
    const config = scoringConfigSchema.parse({
      speedBonusMax: 0,
      relativeSpeedBonusMax: 0,
      perfectRoundBonus: 5
    });
    const fields = [field('title', 1), field('artist', 1)];

    const complete = scoreRound(
      [submission({ playerId: 'p1', fieldKey: 'title' }), submission({ playerId: 'p1', fieldKey: 'artist' })],
      fields,
      START,
      ANSWER_MS,
      config
    );
    const partial = scoreRound([submission({ playerId: 'p2', fieldKey: 'title' })], fields, START, ANSWER_MS, config);

    assert.equal(complete[0]?.perfectBonus, 5);
    assert.equal(partial[0]?.perfectBonus, 0);
  });

  it('is deterministic when two players answer on the same millisecond', () => {
    const submissions: ScoredSubmission[] = [
      submission({ playerId: 'zoe', fieldKey: 'title', answeredAt: START + 500 }),
      submission({ playerId: 'adam', fieldKey: 'title', answeredAt: START + 500 })
    ];
    const fields = [field('title', 10)];

    const first = scoreRound(submissions, fields, START, ANSWER_MS, positionOnly);
    // Reversed input: the result must not depend on arrival order.
    const second = scoreRound([...submissions].reverse(), fields, START, ANSWER_MS, positionOnly);

    assert.deepEqual(first, second);
    // Tie broken by player id.
    assert.equal(first[0]?.playerId, 'adam');
  });

  it('returns nothing when nobody answered', () => {
    assert.deepEqual(scoreRound([], [field('title', 10)], START, ANSWER_MS, positionOnly), []);
  });

  describe('relative speed', () => {
    // Position and the clock silenced, so only the race between players is left.
    const relativeOnly = scoringConfigSchema.parse({
      speedBonusMax: 0,
      relativeSpeedBonusMax: 2,
      positionMultipliers: [1, 1, 1]
    });

    it('pays the fastest in full and the slowest nothing', () => {
      const scores = scoreRound(
        [
          submission({ playerId: 'fast', fieldKey: 'title', answeredAt: START + 1_000 }),
          submission({ playerId: 'middle', fieldKey: 'title', answeredAt: START + 2_000 }),
          submission({ playerId: 'slow', fieldKey: 'title', answeredAt: START + 3_000 })
        ],
        [field('title', 5)],
        START,
        ANSWER_MS,
        relativeOnly
      );

      assert.equal(scores.find((score) => score.playerId === 'fast')?.total, 7);
      assert.equal(scores.find((score) => score.playerId === 'middle')?.total, 6);
      assert.equal(scores.find((score) => score.playerId === 'slow')?.total, 5);
    });

    it('pays a lone correct answer in full, however slow it was', () => {
      // The reason this term exists: on a hard round the only player who knew it
      // takes twenty seconds, and the clock alone would barely reward them.
      const scores = scoreRound(
        [submission({ playerId: 'only', fieldKey: 'title', answeredAt: START + 29_000 })],
        [field('title', 5)],
        START,
        ANSWER_MS,
        relativeOnly
      );

      assert.equal(scores[0]?.total, 7);
    });

    it('is reported separately from the clock bonus', () => {
      const config = scoringConfigSchema.parse({ speedBonusMax: 1, relativeSpeedBonusMax: 1 });
      const scores = scoreRound(
        [
          submission({ playerId: 'a', fieldKey: 'title', answeredAt: START + 15_000 }),
          submission({ playerId: 'b', fieldKey: 'title', answeredAt: START + 30_000 })
        ],
        [field('title', 10)],
        START,
        ANSWER_MS,
        config
      );

      const entry = scores.find((score) => score.playerId === 'a')?.entries[0];
      // Half the window gone, so half the clock bonus; fastest of the two, so all
      // of the relative one.
      assert.equal(entry?.speedBonus, 0.5);
      assert.equal(entry?.relativeSpeedBonus, 1);
    });
  });

  describe('combo', () => {
    const comboConfig = scoringConfigSchema.parse({
      speedBonusMax: 0,
      relativeSpeedBonusMax: 0,
      combo: { enabled: true }
    });

    function winRound(streak: number) {
      return scoreRound(
        [
          submission({ playerId: 'streaker', fieldKey: 'title', answeredAt: START + 100 }),
          submission({ playerId: 'other', fieldKey: 'title', answeredAt: START + 200 })
        ],
        [field('title', 10)],
        START,
        ANSWER_MS,
        comboConfig,
        { comboLengths: new Map([['streaker', streak]]) }
      );
    }

    it('pays nothing on a first win and climbs from the second', () => {
      assert.equal(winRound(0).find((score) => score.playerId === 'streaker')?.total, 10);
      assert.equal(winRound(1).find((score) => score.playerId === 'streaker')?.total, 11);
      assert.equal(winRound(2).find((score) => score.playerId === 'streaker')?.total, 12);
    });

    it('stops at the configured ceiling', () => {
      const far = winRound(30).find((score) => score.playerId === 'streaker');
      assert.equal(far?.comboMultiplier, 2);
      assert.equal(far?.total, 20);
    });

    it('extends the winner streak and ends everyone else', () => {
      const scores = winRound(2);
      assert.equal(scores.find((score) => score.playerId === 'streaker')?.comboLength, 3);
      assert.equal(scores.find((score) => score.playerId === 'other')?.comboLength, 0);
    });

    it('gives a tied round to nobody', () => {
      const scores = scoreRound(
        [
          submission({ playerId: 'a', fieldKey: 'title', answeredAt: START + 100 }),
          submission({ playerId: 'b', fieldKey: 'artist', answeredAt: START + 100 })
        ],
        [field('title', 10), field('artist', 10)],
        START,
        ANSWER_MS,
        comboConfig,
        { comboLengths: new Map([['a', 4]]) }
      );

      // Both earned ten. The totals differ, because "a" still carries the
      // multiplier from the streak they arrived with, and that is exactly why the
      // winner is decided on what was earned: a tie must not extend a streak.
      assert.equal(scores[0]?.earned, scores[1]?.earned, 'the round is tied on merit');
      assert.ok(scores.every((score) => score.comboLength === 0));
    });

    it('does nothing at all while disabled', () => {
      const off = scoreRound(
        [submission({ playerId: 'streaker', fieldKey: 'title' })],
        [field('title', 10)],
        START,
        ANSWER_MS,
        positionOnly,
        { comboLengths: new Map([['streaker', 5]]) }
      );
      assert.equal(off[0]?.total, 10);
      assert.equal(off[0]?.comboMultiplier, 1);
    });
  });

  describe('comeback', () => {
    const comebackConfig = scoringConfigSchema.parse({
      speedBonusMax: 0,
      relativeSpeedBonusMax: 0,
      comeback: { enabled: true }
    });

    /** Four players: the last one is 80% behind, the third is 10% behind. */
    const standings = new Map([
      ['leader', 100],
      ['second', 95],
      ['third', 90],
      ['last', 20]
    ]);

    it('multiplies what the bottom of the field earns', () => {
      const scores = scoreRound(
        [submission({ playerId: 'last', fieldKey: 'title' })],
        [field('title', 10)],
        START,
        ANSWER_MS,
        comebackConfig,
        { previousTotals: standings }
      );

      // 80% behind, so 1.5 after the ceiling: earned still has to be earned.
      assert.equal(scores[0]?.comebackMultiplier, 1.5);
      assert.equal(scores[0]?.total, 15);
    });

    it('leaves the leader alone', () => {
      const scores = scoreRound(
        [submission({ playerId: 'leader', fieldKey: 'title' })],
        [field('title', 10)],
        START,
        ANSWER_MS,
        comebackConfig,
        { previousTotals: standings }
      );
      assert.equal(scores[0]?.total, 10);
    });

    it('ignores someone who is last but not far behind', () => {
      // A close game must not hand a bonus to whoever is momentarily fourth.
      const close = new Map([
        ['a', 100],
        ['b', 98],
        ['c', 96],
        ['d', 95]
      ]);
      const scores = scoreRound(
        [submission({ playerId: 'd', fieldKey: 'title' })],
        [field('title', 10)],
        START,
        ANSWER_MS,
        comebackConfig,
        { previousTotals: close }
      );
      assert.equal(scores[0]?.comebackMultiplier, 1);
    });

    it('stays out of a game too small for a bottom third', () => {
      const duel = new Map([
        ['a', 100],
        ['b', 0]
      ]);
      const scores = scoreRound(
        [submission({ playerId: 'b', fieldKey: 'title' })],
        [field('title', 10)],
        START,
        ANSWER_MS,
        comebackConfig,
        { previousTotals: duel }
      );
      assert.equal(scores[0]?.total, 10);
    });

    it('never multiplies a penalty', () => {
      const config = scoringConfigSchema.parse({
        speedBonusMax: 0,
        relativeSpeedBonusMax: 0,
        wrongAnswerPenalty: 2,
        comeback: { enabled: true }
      });
      const scores = scoreRound(
        [submission({ playerId: 'last', fieldKey: 'title', correct: false })],
        [field('title', 10)],
        START,
        ANSWER_MS,
        config,
        { previousTotals: standings }
      );

      // Helping the player at the back must not mean punishing them harder.
      assert.equal(scores[0]?.total, -2);
    });
  });

  it('keeps fractional points rather than rounding them away', () => {
    const scores = scoreRound(
      [
        submission({ playerId: 'first', fieldKey: 'title', answeredAt: START + 100 }),
        submission({ playerId: 'second', fieldKey: 'title', answeredAt: START + 200 })
      ],
      [field('title', 3)],
      START,
      ANSWER_MS,
      scoringConfigSchema.parse({ speedBonusMax: 0, relativeSpeedBonusMax: 0 })
    );

    // 3 × 0.7 is 2.1, and it stays 2.1.
    assert.equal(scores.find((score) => score.playerId === 'second')?.total, 2.1);
  });
});

describe('buildLeaderboard', () => {
  it('ranks by total', () => {
    const rows = buildLeaderboard(
      new Map([
        ['a', 10],
        ['b', 30],
        ['c', 20]
      ])
    );
    assert.deepEqual(
      rows.map((row) => [row.playerId, row.rank]),
      [
        ['b', 1],
        ['c', 2],
        ['a', 3]
      ]
    );
  });

  it('gives tied players the same rank', () => {
    const rows = buildLeaderboard(
      new Map([
        ['a', 10],
        ['b', 10],
        ['c', 5]
      ])
    );
    assert.equal(rows[0]?.rank, 1);
    assert.equal(rows[1]?.rank, 1);
    assert.equal(rows[2]?.rank, 3);
  });
});
