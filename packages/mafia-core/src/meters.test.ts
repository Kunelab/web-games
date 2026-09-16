import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { advanceDesperation, CALM, stanceOf, type Pressure } from './social.js';
import {
  DEFAULT_PROFILE,
  EVEN_TEMPERAMENT,
  makePersonality,
  TEMPERAMENT_MAX,
  TEMPERAMENT_MIN,
  trustOf,
  type PublicInfo
} from './sim/policies.js';

/**
 * The three meters a seat reads the game through, and the coefficients that
 * make one seat feel them differently from the next.
 *
 * These are the numbers every other decision in the model is downstream of — a
 * stance is a function of desperation, a vote is a function of trust — so they
 * are worth pinning directly rather than only through the games they produce.
 */

/** A board with nothing on it; each test adds only what it is about. */
function board(over: Partial<PublicInfo> = {}): PublicInfo {
  return {
    day: 3,
    aliveSlots: [1, 2, 3, 4, 5],
    deadRoles: new Map(),
    lastNightDeathSlots: new Set(),
    nightDeathsTotal: 0,
    rampage: 0,
    votes: new Map(),
    totalDead: 0,
    trials: [],
    voteHistory: [],
    revealedMayorSlot: null,
    humanSlots: new Set(),
    trialSlot: null,
    claims: [],
    deaths: [],
    provenRoles: new Map(),
    ...over
  };
}

function pressure(over: Partial<Pressure> = {}): Pressure {
  return {
    day: 3,
    aliveCount: 10,
    votesAgainstMe: 0,
    onTrial: false,
    roleOuted: false,
    targetedLastNight: false,
    losingClock: 0,
    ...over
  };
}

describe('the panic meter', () => {
  it('is calm before the game starts', () => {
    assert.equal(advanceDesperation(0.9, pressure({ day: 0 })), CALM);
  });

  it('rises with the wagon and spikes on the stand', () => {
    const quiet = advanceDesperation(CALM, pressure());
    const wagon = advanceDesperation(CALM, pressure({ votesAgainstMe: 3 }));
    const stand = advanceDesperation(CALM, pressure({ votesAgainstMe: 3, onTrial: true }));
    assert.ok(wagon > quiet, `wagon ${wagon} should beat quiet ${quiet}`);
    assert.ok(stand > wagon, `stand ${stand} should beat wagon ${wagon}`);
  });

  it('eases as yesterday recedes, but never below the losing clock', () => {
    const panicked = advanceDesperation(CALM, pressure({ onTrial: true, votesAgainstMe: 4 }));
    const after = advanceDesperation(panicked, pressure());
    assert.ok(after < panicked, 'panic fades when the room looks away');
    assert.ok(after > 0, 'but not all the way, and not at once');
    // A board that is lost is a floor, not a mood.
    const losing = advanceDesperation(CALM, pressure({ losingClock: 0.8 }));
    assert.ok(losing >= 0.8);
    assert.ok(advanceDesperation(losing, pressure({ losingClock: 0.8 })) >= 0.8);
  });

  it('never leaves 0..1', () => {
    const worst = advanceDesperation(
      1,
      pressure({ votesAgainstMe: 99, onTrial: true, roleOuted: true, targetedLastNight: true, losingClock: 1 })
    );
    assert.ok(worst <= 1 && worst >= 0, String(worst));
  });

  /**
   * The coefficient, doing the one job it exists for: the same wagon lands
   * harder on a nervy seat than on a steady one.
   */
  it('lands harder on a nervy seat than a steady one', () => {
    const steady = advanceDesperation(CALM, pressure({ votesAgainstMe: 3 }), TEMPERAMENT_MIN);
    const average = advanceDesperation(CALM, pressure({ votesAgainstMe: 3 }), 1);
    const nervy = advanceDesperation(CALM, pressure({ votesAgainstMe: 3 }), TEMPERAMENT_MAX);
    assert.ok(steady < average && average < nervy, `${steady} < ${average} < ${nervy}`);
  });

  it('feeds the stance: a cornered town seat lies more than a calm one', () => {
    const calm = stanceOf('town', CALM, { deceit: 0.5, aggression: 0.5 });
    const cornered = stanceOf('town', 1, { deceit: 0.5, aggression: 0.5 });
    assert.ok(cornered.fakeClaim > calm.fakeClaim, 'the rope makes a townie reach for a mask');
    assert.ok(cornered.answerHonestly < calm.answerHonestly, 'and stop answering straight');
  });
});

describe('the trust meter', () => {
  /** Voting to spare somebody the graveyard then proved evil is the loudest tell. */
  const sparedAnEvil = board({
    deadRoles: new Map([[2, 'mafioso']]),
    trials: [{ day: 2, accusedSlot: 2, lynched: false, guiltySlots: [], innocentSlots: [4] }]
  });
  const hangedAnEvil = board({
    deadRoles: new Map([[2, 'mafioso']]),
    trials: [{ day: 2, accusedSlot: 2, lynched: true, guiltySlots: [4], innocentSlots: [] }]
  });

  it('is neutral about a seat with no record', () => {
    assert.equal(trustOf(4, board()), 0);
  });

  it('punishes protecting a proven enemy and rewards hanging one', () => {
    assert.ok(trustOf(4, sparedAnEvil) < 0, 'voting innocent on a mafioso is the loudest tell');
    assert.ok(trustOf(4, hangedAnEvil) > 0, 'and voting guilty on one earns trust');
  });

  /**
   * The coefficient: the record is public and fixed, how far it moves you is
   * not. A suspicious reader swings on one ballot; a trusting one shrugs.
   */
  it('moves a suspicious reader further than a trusting one', () => {
    const trusting = trustOf(4, sparedAnEvil, { ...EVEN_TEMPERAMENT, suspicion: TEMPERAMENT_MIN });
    const average = trustOf(4, sparedAnEvil);
    const suspicious = trustOf(4, sparedAnEvil, { ...EVEN_TEMPERAMENT, suspicion: TEMPERAMENT_MAX });
    // All negative, so "further" is further below zero.
    assert.ok(suspicious < average && average < trusting, `${suspicious} < ${average} < ${trusting}`);
    // And it never flips the sign: a tell is a tell at every temperament.
    assert.ok(trusting < 0 && suspicious < 0);
  });
});

describe('temperament', () => {
  const rolls = (count: number) => {
    let seed = 12345;
    const rng = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    return Array.from({ length: count }, () => makePersonality(DEFAULT_PROFILE, rng));
  };

  it('gives every seat all three coefficients, inside the range', () => {
    for (const person of rolls(200)) {
      for (const [name, value] of Object.entries(person.temperament)) {
        assert.ok(
          value >= TEMPERAMENT_MIN && value <= TEMPERAMENT_MAX,
          `${name} = ${value} outside ${TEMPERAMENT_MIN}..${TEMPERAMENT_MAX}`
        );
      }
    }
  });

  /** A table of one character is the thing these exist to prevent. */
  it('spreads a table across the range rather than clustering on average', () => {
    const haste = rolls(200).map((person) => person.temperament.haste);
    assert.ok(Math.min(...haste) < 0.75, 'somebody at the table is careful');
    assert.ok(Math.max(...haste) > 1.25, 'and somebody blurts');
    const spread = haste.filter((value) => value < 0.8 || value > 1.2).length / haste.length;
    assert.ok(spread > 0.25, `only ${(spread * 100).toFixed(0)}% of seats are distinctive`);
  });

  it('keeps the appetites where they always were, 0..1', () => {
    for (const person of rolls(100)) {
      for (const key of ['aggression', 'herd', 'claimRate', 'deceit', 'courage'] as const) {
        assert.ok(person[key] >= 0 && person[key] <= 1, `${key} = ${person[key]}`);
      }
    }
  });
});
