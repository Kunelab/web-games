import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAFIA_BADGES,
  emptyMafiaStats,
  mafiaBadgesFor,
  mafiaReward,
  mafiaTitleFor,
  nextMafiaBadges,
  type MafiaCareerStats
} from './careers.js';

/** A career with some dimensions wound forward. */
function career(overrides: Partial<MafiaCareerStats> = {}): MafiaCareerStats {
  return { ...emptyMafiaStats(), ...overrides };
}

describe('the Mafia badge ladder', () => {
  /**
   * The invariant the whole payoff screen rests on.
   *
   * Two descriptions of one threshold drift apart in a way nobody notices until a
   * bar sits full against a badge that never dropped. Same test CoronaZ's trophies
   * and the quiz's badges carry, for the same reason: `earned` decides, `progress`
   * is drawn, and only this holds them to the same story.
   */
  it('never disagrees with itself about whether a badge is earned', () => {
    const dimensions: (keyof MafiaCareerStats)[] = ['games', 'wins', 'soloWins', 'kills', 'survived'];

    for (const dimension of dimensions) {
      for (const value of [0, 1, 2, 9, 10, 11, 24, 25, 26, 49, 50, 51, 500]) {
        const stats = career({ [dimension]: value });

        for (const badge of MAFIA_BADGES) {
          const { current, target } = badge.progress(stats);
          assert.equal(
            badge.earned(stats),
            current >= target,
            `${badge.key} disagrees at ${String(dimension)}=${value} (${current}/${target})`
          );
        }
      }
    }
  });

  it('never draws a bar past its end, or below zero', () => {
    for (const stats of [career(), career({ games: 9_999, wins: 9_999, kills: 9_999, survived: 9_999 })]) {
      for (const badge of MAFIA_BADGES) {
        const { current, target } = badge.progress(stats);
        assert.ok(current >= 0, `${badge.key} went negative`);
        assert.ok(current <= target, `${badge.key} overflowed its target`);
      }
    }
  });

  it('earns nothing on an empty career', () => {
    assert.deepEqual(mafiaBadgesFor(career()), []);
    assert.equal(mafiaTitleFor(career()), null);
  });

  /**
   * The title is the last badge in the list, so the list has to be in prestige
   * order or a first-evening badge outranks a season of them.
   */
  it('wears the most prestigious badge held', () => {
    assert.equal(mafiaTitleFor(career({ games: 1 })), 'first-table');
    assert.equal(mafiaTitleFor(career({ games: 10, wins: 1 })), 'regular');
    assert.equal(mafiaTitleFor(career({ games: 60, wins: 50, kills: 30, survived: 20, soloWins: 2 })), 'legend');
  });

  it('names a unit the client can translate rather than a word', () => {
    for (const badge of MAFIA_BADGES) {
      assert.match(badge.progress(career()).unit, /^mafia\.unit\./, `${badge.key} sent a bare word`);
    }
  });
});

describe('what the Mafia payoff screen shows', () => {
  it('offers the three nearest badges, closest first, and never one already held', () => {
    const stats = career({ games: 9, wins: 1, kills: 8 });
    const held = mafiaBadgesFor(stats);
    const next = nextMafiaBadges(stats);

    assert.ok(next.length <= 3);
    assert.deepEqual(
      next.map((entry) => entry.key).filter((key) => held.includes(key)),
      [],
      'an earned badge is not something to chase'
    );

    const ratios = next.map((entry) => entry.current / entry.target);
    assert.deepEqual([...ratios].sort((a, b) => b - a), ratios, 'not sorted closest-first');
  });

  it('announces only what tonight actually changed', () => {
    const reward = mafiaReward({
      playerId: 'p1',
      name: 'Ana',
      before: career({ games: 9, wins: 0, survived: 4 }),
      after: career({ games: 10, wins: 1, survived: 5 }),
      gained: 12,
      total: 140
    });

    // The tenth table and the first win both landed tonight; "first-table" was
    // already held and must not be announced a second time.
    assert.deepEqual([...reward.newBadges].sort(), ['first-blood', 'regular']);
    assert.equal(reward.gained, 12);
    assert.equal(reward.total, 140);
  });

  it('reports a new title only when it moved', () => {
    const still = mafiaReward({
      playerId: 'p1',
      name: 'Ana',
      before: career({ games: 2 }),
      after: career({ games: 3 }),
      gained: 5,
      total: 20
    });
    assert.equal(still.newTitle, null, 'nothing changed, so there is nothing to crown');

    const promoted = mafiaReward({
      playerId: 'p1',
      name: 'Ana',
      before: career({ games: 9 }),
      after: career({ games: 10 }),
      gained: 5,
      total: 25
    });
    assert.equal(promoted.newTitle, 'regular');
  });

  it('marks the bars this table pushed along', () => {
    const reward = mafiaReward({
      playerId: 'p1',
      name: 'Ana',
      before: career({ games: 3, kills: 6 }),
      after: career({ games: 4, kills: 8 }),
      gained: 9,
      total: 40
    });

    const blooded = reward.nextBadges.find((entry) => entry.key === 'blooded');
    assert.ok(blooded, 'a badge 8 of the way to 10 is one of the nearest three');
    assert.equal(blooded.moved, true);
    assert.equal(blooded.current, 8);
    assert.equal(blooded.target, 10);
  });

  /**
   * A bot banks nothing, so its two snapshots are identical and everything
   * derived from a comparison comes back empty. Its row still carries what it
   * scored, because comparing yourself to the machine is half of why anyone reads
   * this table.
   */
  it('gives a bot a score and no progression', () => {
    const stats = career();
    const reward = mafiaReward({
      playerId: 'bot1',
      name: 'Bot',
      before: stats,
      after: stats,
      gained: 7,
      total: null
    });

    assert.equal(reward.gained, 7);
    assert.equal(reward.total, null);
    assert.deepEqual(reward.newBadges, []);
    assert.equal(reward.newTitle, null);
  });
});
