import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RoleId } from '../roles.js';
import type { VoteNote } from '../state.js';
import type { PublicInfo } from './policies.js';
import { tempoReads, wagonOpener } from './tempo.js';

function board(parts: Partial<PublicInfo> = {}): PublicInfo {
  return {
    day: 3,
    aliveSlots: [1, 2, 3, 4, 5, 6, 7],
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
    rolesInPlay: new Set<RoleId>(['sheriff', 'doctor', 'mafioso', 'citizen']),
    ...parts
  };
}

const vote = (day: number, voterSlot: number, targetSlot: number | null, skip = false): VoteNote => ({
  day,
  voterSlot,
  targetSlot,
  skip
});

const codes = (reads: { code: string }[]): string[] => reads.map((read) => read.code);

describe('who opened the wagon', () => {
  it('names the first vote on a house and nobody who followed it', () => {
    const info = board({
      ballots: [vote(3, 4, 6), vote(3, 2, 6), vote(3, 5, 6)]
    });
    assert.equal(wagonOpener(6, info), 4);
  });

  it('does not count a seat that arrived after the wagon was built', () => {
    const info = board({ ballots: [vote(3, 4, 6), vote(3, 2, 6)] });
    assert.notEqual(wagonOpener(6, info), 2);
  });

  /** Yesterday's wagon is not today's, and a bot asking "why did you start this" means today. */
  it('only reads the day being argued', () => {
    const info = board({ day: 3, ballots: [vote(2, 7, 6), vote(3, 4, 6)] });
    assert.equal(wagonOpener(6, info), 4);
  });

  /** A wagon that was abandoned and rebuilt still has an opener. */
  it('reopens when everybody left and somebody came back', () => {
    const info = board({
      ballots: [vote(3, 4, 6), vote(3, 4, null), vote(3, 2, 6)]
    });
    assert.equal(wagonOpener(6, info), 4, 'the first name on it is still the first name on it');
  });
});

describe('the ballot as evidence', () => {
  /** The rule that survived the fit: opening a case on somebody who turned out town. */
  it('catches the seat that started the wagon on a townsperson', () => {
    const info = board({
      deadRoles: new Map<number, RoleId>([[6, 'doctor']]),
      totalDead: 1,
      aliveSlots: [1, 2, 3, 4, 5, 7],
      deaths: [{ slot: 6, day: 3, phase: 'day', source: null }],
      ballots: [vote(3, 4, 6), vote(3, 2, 6)]
    });

    assert.deepEqual(codes(tempoReads(4, info)), ['led-town-wagon']);
    assert.deepEqual(codes(tempoReads(2, info)), [], 'joining a wagon is not opening one');
  });

  it('credits the seat that started the wagon on a killer', () => {
    const info = board({
      deadRoles: new Map<number, RoleId>([[6, 'mafioso']]),
      totalDead: 1,
      aliveSlots: [1, 2, 3, 4, 5, 7],
      deaths: [{ slot: 6, day: 3, phase: 'day', source: null }],
      ballots: [vote(3, 4, 6)]
    });

    const read = tempoReads(4, info);
    assert.deepEqual(codes(read), ['led-killer-wagon']);
    assert.ok(read[0].weight < 0, 'a case that was right is a reason to trust the seat that made it');
  });

  /**
   * Nothing fires until the graveyard settles the house, which is the whole
   * discipline of this file: a wagon is not wrong because it lost.
   */
  it('says nothing about a wagon on somebody still alive', () => {
    const info = board({ ballots: [vote(3, 4, 6), vote(3, 2, 6)] });
    assert.deepEqual(codes(tempoReads(4, info)), []);
  });

  it('says nothing about a corpse the game refused to identify', () => {
    const info = board({
      totalDead: 1,
      aliveSlots: [1, 2, 3, 4, 5, 7],
      deaths: [{ slot: 6, day: 3, phase: 'day', source: null }],
      ballots: [vote(3, 4, 6)]
    });
    assert.deepEqual(codes(tempoReads(4, info)), []);
  });

  /** A skip is not a wagon and a withdrawal opens nothing. */
  it('ignores skips and withdrawals', () => {
    const info = board({
      deadRoles: new Map<number, RoleId>([[6, 'doctor']]),
      ballots: [vote(3, 4, null, true), vote(3, 4, null)]
    });
    assert.deepEqual(codes(tempoReads(4, info)), []);
  });

  /** Fires once however many bad wagons a seat opened: the weight was fitted on "did it happen". */
  it('counts a seat once however many times the rule could fire', () => {
    const info = board({
      deadRoles: new Map<number, RoleId>([
        [6, 'doctor'],
        [7, 'citizen']
      ]),
      totalDead: 2,
      aliveSlots: [1, 2, 3, 4, 5],
      deaths: [
        { slot: 6, day: 2, phase: 'day', source: null },
        { slot: 7, day: 3, phase: 'day', source: null }
      ],
      ballots: [vote(2, 4, 6), vote(3, 4, 7)]
    });
    assert.deepEqual(codes(tempoReads(4, info)), ['led-town-wagon']);
  });
});

describe('stepping off at the edge of the rope', () => {
  /**
   * Seven alive, so the bar is four. Three seats on the wagon means this seat's
   * vote was the rope, and it walked away from a killer.
   */
  it('catches the vote that was the difference between a trial and no trial', () => {
    const info = board({
      day: 3,
      aliveSlots: [1, 2, 3, 4, 5, 6, 7],
      deadRoles: new Map<number, RoleId>([[6, 'mafioso']]),
      ballots: [vote(3, 1, 6), vote(3, 2, 6), vote(3, 3, 6), vote(3, 3, 5)]
    });

    assert.deepEqual(codes(tempoReads(3, info)), ['saved-at-the-edge']);
  });

  it('says nothing when the wagon was nowhere near the bar', () => {
    // 1 opened it, so 3 is a follower leaving a wagon of two against a bar of four.
    const info = board({
      deadRoles: new Map<number, RoleId>([[6, 'mafioso']]),
      ballots: [vote(3, 1, 6), vote(3, 3, 6), vote(3, 3, 5)]
    });
    assert.deepEqual(codes(tempoReads(3, info)), []);
  });

  /**
   * Unpriced on purpose. The bench cannot measure it, because a bot killer
   * never boards a teammate's wagon in the first place, so the number would be
   * about townspeople changing their minds. See `FITTED`.
   */
  it('reports the tell without scoring it', () => {
    const info = board({
      deadRoles: new Map<number, RoleId>([[6, 'mafioso']]),
      ballots: [vote(3, 1, 6), vote(3, 2, 6), vote(3, 3, 6), vote(3, 3, 5)]
    });
    assert.equal(tempoReads(3, info)[0].weight, 0);
  });
});

describe('the bar the reads are measured against', () => {
  /**
   * The threshold has to fall with the graveyard. Reading day 5 against day
   * one's roll would put the edge in the wrong place all endgame, which is
   * exactly where it matters.
   */
  it('moves the bar as seats die', () => {
    const late = board({
      day: 5,
      aliveSlots: [1, 2, 3],
      totalDead: 4,
      deadRoles: new Map<number, RoleId>([[4, 'mafioso']]),
      deaths: [
        { slot: 4, day: 4, phase: 'day', source: null },
        { slot: 5, day: 3, phase: 'night', source: 'mafia' },
        { slot: 6, day: 2, phase: 'night', source: 'mafia' },
        { slot: 7, day: 2, phase: 'day', source: null }
      ],
      // Three alive on day 5: the bar is two, so one seat on the wagon is the edge.
      ballots: [vote(5, 1, 4), vote(5, 1, 2)]
    });

    // 1 both opened that wagon and walked off it, so both reads fire on the same move.
    assert.ok(codes(tempoReads(1, late)).includes('saved-at-the-edge'));
  });
});
