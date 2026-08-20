import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GM_CLASSES, HEROES } from './data.js';
import {
  CZ_TROPHIES,
  emptyCareerStats,
  gmRaidRations,
  nextTrophies,
  raidRations,
  raidReward,
  trophiesFor,
  trophyRatio,
  type CzCareerStats
} from './perks.js';

/**
 * The roguelite layer's arithmetic.
 *
 * Two things in here are worth a test rather than a read. `progress` is a second
 * description of a threshold that `earned` already describes, so the two can
 * silently disagree — a bar that fills to 100 % next to a trophy that has not
 * unlocked, or worse, the reverse. And the ration economy is the whole pacing of
 * the game's progression, expressed as one small sum: if it drifts back towards
 * "one raid buys any character" nobody notices from reading it.
 */

function stats(overrides: Partial<CzCareerStats> = {}): CzCareerStats {
  return { ...emptyCareerStats(), ...overrides };
}

describe('every trophy agrees with its own progress bar', () => {
  for (const trophy of CZ_TROPHIES) {
    it(`${trophy.key}`, () => {
      const fresh = stats();
      const { target } = trophy.progress(fresh);
      assert.ok(target > 0, 'a target of zero cannot be drawn');

      // Unearned on a blank career, and the bar agrees.
      assert.equal(trophy.earned(fresh), false, 'earned on an empty career');
      assert.equal(trophyRatio(trophy, fresh), 0);
    });
  }

  it('a full bar means unlocked, and an unlocked trophy means a full bar', () => {
    // Walk one career from nothing to well past every threshold and check the two
    // descriptions never disagree at any point along the way.
    for (let step = 0; step <= 120; step += 1) {
      const walked = stats({
        raids: step,
        wins: step,
        deaths: step,
        kills: step,
        bossKills: step,
        searches: step,
        gmRaids: step,
        gmWins: step,
        gmSpawns: step,
        fastestWinTurns: step > 0 ? { escape: Math.max(4, 30 - step) } : {}
      });

      for (const trophy of CZ_TROPHIES) {
        const { current, target } = trophy.progress(walked);
        const full = current >= target;
        assert.equal(
          trophy.earned(walked),
          full,
          `${trophy.key} at step ${step}: earned=${trophy.earned(walked)} but bar is ${current}/${target}`
        );
      }
    }
  });
});

describe('nextTrophies', () => {
  it('never offers one already held', () => {
    const veteran = stats({ raids: 40, wins: 20, searches: 400, kills: 400, bossKills: 40, deaths: 40 });
    const held = new Set(trophiesFor(veteran));
    for (const next of nextTrophies(veteran, { limit: 99 })) {
      assert.ok(!held.has(next.key), `${next.key} is already earned`);
    }
  });

  it('keeps the two tracks apart', () => {
    const fresh = stats();
    assert.ok(nextTrophies(fresh, { limit: 99 }).every((next) => !next.gm));
    assert.ok(nextTrophies(fresh, { gm: true, limit: 99 }).every((next) => next.gm));
  });

  it('puts the closest one first', () => {
    // 90 of 100 searches beats 1 of 20 raids, even though the second is an easier tier.
    const nearly = stats({ searches: 90, raids: 1 });
    const [first] = nextTrophies(nearly, { limit: 3 });
    assert.equal(first?.key, 'hoarder');
  });

  it('honours the limit', () => {
    assert.equal(nextTrophies(stats(), { limit: 2 }).length, 2);
  });
});

describe('the ration economy', () => {
  it('a typical winning raid pays about forty-five', () => {
    const paid = raidRations({ turns: 21, won: true, kills: 11, searches: 8 });
    assert.ok(paid >= 38 && paid <= 52, `paid ${paid}`);
  });

  it('losing still pays, at roughly sixty per cent', () => {
    const won = raidRations({ turns: 20, won: true, kills: 11, searches: 8 });
    const lost = raidRations({ turns: 15, won: false, kills: 8, searches: 5 });
    assert.ok(lost > 0, 'a lost raid must still pay: it was still an evening');
    assert.ok(lost < won);
    assert.ok(lost / won > 0.45 && lost / won < 0.8, `ratio ${(lost / won).toFixed(2)}`);
  });

  it('one raid no longer buys the dearest character', () => {
    // The whole point of the rework. A very good raid against the top price.
    const generous = raidRations({ turns: 30, won: true, kills: 40, searches: 20 });
    const dearest = Math.max(...HEROES.map((hero) => hero.cost ?? 0));
    assert.ok(generous < dearest / 3, `a great raid paid ${generous} against a ${dearest} price tag`);
  });

  it('the cheapest character is a handful of evenings, not one', () => {
    const typical = raidRations({ turns: 21, won: true, kills: 11, searches: 8 });
    const cheapest = Math.min(...HEROES.filter((hero) => hero.cost).map((hero) => hero.cost ?? 0));
    const evenings = cheapest / typical;
    assert.ok(evenings >= 2.5 && evenings <= 6, `${evenings.toFixed(1)} evenings for the cheapest character`);
  });

  it('never pays a negative amount, whatever it is handed', () => {
    assert.ok(raidRations({ turns: -5, won: false, kills: -1, searches: -1 }) >= 0);
    assert.ok(gmRaidRations({ turns: -5, won: false, spawns: -1 }) >= 0);
  });

  it('the horde is paid comparably to the survivors', () => {
    const heroes = raidRations({ turns: 20, won: true, kills: 11, searches: 8 });
    const horde = gmRaidRations({ turns: 20, won: true, spawns: 40 });
    assert.ok(horde / heroes > 0.6 && horde / heroes < 1.8, `${horde} against ${heroes}`);
  });
});

describe('raidReward', () => {
  const roster = HEROES;

  it('announces a trophy only the raid that earned it', () => {
    const before = stats({ searches: 24 });
    const after = stats({ searches: 26, rations: 40 });

    const first = raidReward({ playerId: 'p1', name: 'Max', before, after, roster });
    assert.deepEqual(first.newTrophies, ['packrat']);
    assert.deepEqual(first.newPerks, ['deep-pockets']);

    // The next raid must not say it again.
    const later = raidReward({ playerId: 'p1', name: 'Max', before: after, after: stats({ searches: 30 }), roster });
    assert.deepEqual(later.newTrophies, []);
    assert.deepEqual(later.newPerks, []);
  });

  it('reports the rations the raid actually added', () => {
    const reward = raidReward({
      playerId: 'p1',
      name: 'Max',
      before: stats({ rations: 100 }),
      after: stats({ rations: 145 }),
      roster
    });
    assert.equal(reward.rationsGained, 45);
    assert.equal(reward.rations, 145);
  });

  it('names a character only on the raid that brought it into reach', () => {
    const cheapest = Math.min(...HEROES.filter((hero) => hero.cost).map((hero) => hero.cost ?? 0));

    const crossing = raidReward({
      playerId: 'p1',
      name: 'Max',
      before: stats({ rations: cheapest - 10 }),
      after: stats({ rations: cheapest + 5 }),
      roster
    });
    assert.ok(crossing.affordable.length > 0, 'crossing a price should be announced');
    assert.equal(crossing.affordable[0]?.cost, cheapest);

    // Already affordable last time: not news, or the same line would reappear
    // after every raid until it was spent and stop meaning anything.
    const already = raidReward({
      playerId: 'p1',
      name: 'Max',
      before: stats({ rations: cheapest + 5 }),
      after: stats({ rations: cheapest + 50 }),
      roster
    });
    assert.ok(!already.affordable.some((entry) => entry.cost === cheapest));
  });

  it('does not offer a character already owned', () => {
    const owned = HEROES.find((hero) => hero.cost);
    assert.ok(owned);
    const reward = raidReward({
      playerId: 'p1',
      name: 'Max',
      before: stats({ rations: 0 }),
      after: stats({ rations: 5000, unlockedHeroes: [owned.id] }),
      roster
    });
    assert.ok(!reward.affordable.some((entry) => entry.id === owned.id));
  });

  it('marks which of the near trophies moved tonight', () => {
    const reward = raidReward({
      playerId: 'p1',
      name: 'Max',
      before: stats({ searches: 10, kills: 5 }),
      after: stats({ searches: 18, kills: 5 }),
      roster
    });
    const searchy = reward.nextTrophies.find((next) => next.key === 'packrat');
    assert.ok(searchy?.moved, 'searches went up, so the searching trophy moved');
    const killy = reward.nextTrophies.find((next) => next.key === 'centurion-z');
    // It may not be in the top three at all; when it is, it must not claim to have moved.
    if (killy) assert.equal(killy.moved, false);
  });

  it('reads the horde track for a game master', () => {
    const reward = raidReward({
      playerId: '__gm',
      name: 'maxime',
      before: stats(),
      after: stats({ gmRaids: 1, rations: 40 }),
      roster: GM_CLASSES,
      gm: true
    });
    assert.deepEqual(reward.newTrophies, ['dark-dabbler']);
    assert.deepEqual(reward.newPerks, ['dark-pact']);
    assert.ok(reward.nextTrophies.every((next) => next.gm));
  });
});
