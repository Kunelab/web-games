import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * The badge ladder, and the payoff screen that reads it.
 *
 * Nothing here touches the database, but importing the service opens one: the db
 * module connects at evaluation time. So the same trick the smoke runner uses —
 * point at a throwaway file, then import dynamically, because static imports are
 * hoisted above anything set in the body of the file.
 */
const directory = mkdtempSync(join(tmpdir(), 'kune-results-test-'));
process.env.DATABASE_FILE = join(directory, 'test.db');
process.env.SECRET ??= 'results-test-secret-that-is-long-enough-to-pass';
process.env.NODE_ENV = 'test';

process.on('exit', () => {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // A leftover temp file is not worth failing a passing run over.
  }
});

const { BADGE_DEFS, decorate, emptyCareer, gameReward, nextBadges } = await import('./results-service.js');
type PlayerCareer = ReturnType<typeof emptyCareer>;

/** A career with some dimensions wound forward. */
function career(overrides: Partial<PlayerCareer> = {}): PlayerCareer {
  return decorate({ ...emptyCareer('Ana'), ...overrides });
}

describe('the badge ladder', () => {
  /**
   * The invariant the whole payoff screen rests on.
   *
   * Two descriptions of one threshold can drift apart in a way nobody notices
   * until a bar sits full against a badge that never dropped, so they are checked
   * against each other across a career walked from nothing to well past every
   * threshold. This is the quiz's copy of the test CoronaZ's trophies carry, and
   * it exists for the same reason: `earned` is the authority, `progress` is what
   * gets drawn, and only a test makes them agree.
   */
  it('never disagrees with itself about whether a badge is earned', () => {
    const dimensions: (keyof PlayerCareer)[] = ['games', 'wins', 'correct', 'awards', 'bestComboEver'];

    for (const dimension of dimensions) {
      for (const value of [0, 1, 2, 3, 5, 9, 10, 11, 20, 49, 50, 99, 100, 499, 500, 1_000]) {
        const subject = career({ [dimension]: value });

        for (const badge of BADGE_DEFS) {
          const { current, target } = badge.progress(subject);
          assert.equal(
            badge.earned(subject),
            current >= target,
            `${badge.key} disagrees at ${String(dimension)}=${value} (${current}/${target})`
          );
        }
      }
    }
  });

  it('agrees with itself on the one badge counted backwards', () => {
    for (const best of [null, 5_000, 3_000, 2_999, 1_501, 1_500, 900, 0]) {
      const subject = career({ fastestEverMs: best });
      const badge = BADGE_DEFS.find((entry) => entry.key === 'lightning');
      assert.ok(badge);

      const { current, target } = badge.progress(subject);
      assert.equal(badge.earned(subject), current >= target, `lightning disagrees at ${String(best)}`);
    }
  });

  it('never draws a bar past its end, or below zero', () => {
    for (const subject of [
      career(),
      career({ games: 10_000, wins: 10_000, correct: 10_000 }),
      career({ fastestEverMs: 60_000 })
    ]) {
      for (const badge of BADGE_DEFS) {
        const { current, target } = badge.progress(subject);
        assert.ok(current >= 0, `${badge.key} went negative`);
        assert.ok(current <= target, `${badge.key} overflowed its target`);
      }
    }
  });

  it('earns nothing on an empty career', () => {
    assert.deepEqual(career().badges, []);
    assert.equal(career().title, null);
  });
});

describe('what the payoff screen shows', () => {
  it('offers the three nearest badges, closest first, and never one already held', () => {
    const subject = career({ games: 9, correct: 80, wins: 0 });
    const next = nextBadges(subject);

    assert.ok(next.length <= 3);
    assert.deepEqual(
      next.map((entry) => entry.key).filter((key) => subject.badges.includes(key)),
      [],
      'an earned badge is not something to chase'
    );

    const ratios = next.map((entry) => entry.current / entry.target);
    assert.deepEqual(
      [...ratios].sort((a, b) => b - a),
      ratios,
      'not sorted closest-first'
    );
  });

  it('names a unit the client can translate rather than a word', () => {
    for (const entry of nextBadges(career(), 20)) {
      assert.match(entry.unit, /^badge\.unit\./, `${entry.key} sent a bare word`);
    }
  });

  it('announces only what tonight actually changed', () => {
    const before = career({ games: 9, wins: 0 });
    const after = career({ games: 10, wins: 1 });

    const reward = gameReward({
      playerId: 'p1',
      name: 'Ana',
      before,
      after,
      gained: 42,
      total: 142
    });

    // "regular" is the tenth game and "first-win" is the first win: both fell
    // tonight. "first-game" was already held and must not be announced twice.
    assert.deepEqual(reward.newBadges.sort(), ['first-win', 'regular']);
    assert.equal(reward.gained, 42);
    assert.equal(reward.total, 142);
  });

  it('reports a new title only when it moved', () => {
    const still = gameReward({
      playerId: 'p1',
      name: 'Ana',
      before: career({ games: 2 }),
      after: career({ games: 3 }),
      gained: 0,
      total: 0
    });
    assert.equal(still.newTitle, null, 'nothing changed, so there is nothing to crown');

    const promoted = gameReward({
      playerId: 'p1',
      name: 'Ana',
      before: career({ games: 9 }),
      after: career({ games: 10 }),
      gained: 0,
      total: 0
    });
    assert.equal(promoted.newTitle, 'regular');
  });

  it('marks the bars this game pushed along', () => {
    const reward = gameReward({
      playerId: 'p1',
      name: 'Ana',
      before: career({ games: 1, correct: 40 }),
      after: career({ games: 2, correct: 55 }),
      gained: 10,
      total: 10
    });

    const hundred = reward.nextBadges.find((entry) => entry.key === 'hundred-right');
    assert.ok(hundred, 'a badge 55 of the way there is one of the nearest three');
    assert.equal(hundred.moved, true);
    assert.equal(hundred.current, 55);
    assert.equal(hundred.target, 100);
  });
});
