import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RoleId } from '../roles.js';
import type { SlotToken } from '../setups.js';
import type { PublicInfo } from './policies.js';
import { townClock } from './clock.js';

function board(parts: Partial<PublicInfo> = {}): PublicInfo {
  return {
    day: 3,
    aliveSlots: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
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
    ...parts
  };
}

/** A roster the way the setup writes one: one token per seat. */
const roster = (...roles: RoleId[]): SlotToken[] => roles;

const town = (count: number): RoleId[] => Array.from({ length: count }, () => 'citizen');

describe('the mislynch budget', () => {
  /**
   * The arithmetic the whole file exists for, checked by hand.
   *
   * Twelve alive against three mafia: a wrong rope costs the hanged townsperson
   * and tonight's, so the margin of six falls to four and then to two, and at
   * two the next wrong rope is parity. Two mistakes, and the third is the game.
   */
  it('counts the wrong ropes a town can still afford', () => {
    const info = board({
      day: 2,
      aliveSlots: Array.from({ length: 12 }, (_, index) => index + 1),
      roleSlots: roster('mafioso', 'mafioso', 'godfather', ...town(9))
    });

    const clock = townClock(info);
    assert.equal(clock.bloc?.camp, 'mafia');
    assert.equal(clock.bloc?.size, 3);
    assert.equal(clock.margin, 6);
    assert.equal(clock.mislynches, 2);
  });

  /** And it is available on the second morning, off the list on the wall. */
  it('is readable on day two, before anybody has died', () => {
    const early = townClock(
      board({ day: 2, aliveSlots: Array.from({ length: 12 }, (_, i) => i + 1), roleSlots: roster('mafioso', 'mafioso', 'godfather', ...town(9)) })
    );
    assert.ok(early.mislynches > 0 && early.blades === 3);
  });

  /** A correct rope does not spend the budget: it takes a killer with it. */
  it('does not charge the town for hanging a killer', () => {
    const before = townClock(
      board({
        day: 2,
        aliveSlots: Array.from({ length: 12 }, (_, index) => index + 1),
        roleSlots: roster('mafioso', 'mafioso', 'godfather', ...town(9))
      })
    );
    const after = townClock(
      board({
        day: 3,
        // One mafioso hanged, one townsperson knifed: ten alive, two killers.
        aliveSlots: Array.from({ length: 10 }, (_, index) => index + 1),
        totalDead: 2,
        nightDeathsTotal: 1,
        deadRoles: new Map<number, RoleId>([[11, 'mafioso']]),
        deaths: [
          { slot: 11, day: 2, phase: 'day', source: null },
          { slot: 12, day: 2, phase: 'night', source: 'mafia' }
        ],
        roleSlots: roster('mafioso', 'mafioso', 'godfather', ...town(9))
      })
    );

    assert.equal(after.margin, before.margin, 'the margin is what a correct rope is for');
  });

  /** A wrong one does. */
  it('charges the town two heads for hanging a townsperson', () => {
    const after = townClock(
      board({
        day: 3,
        aliveSlots: Array.from({ length: 10 }, (_, index) => index + 1),
        totalDead: 2,
        nightDeathsTotal: 1,
        deadRoles: new Map<number, RoleId>([[11, 'citizen']]),
        deaths: [
          { slot: 11, day: 2, phase: 'day', source: null },
          { slot: 12, day: 2, phase: 'night', source: 'mafia' }
        ],
        roleSlots: roster('mafioso', 'mafioso', 'godfather', ...town(9))
      })
    );

    assert.equal(after.margin, 4, 'six, less the rope and less the night');
    assert.equal(after.mislynches, 1);
  });
});

describe('a skip is cheaper than a wrong rope', () => {
  /**
   * The thing nothing in this codebase knew. A thrown-away afternoon costs the
   * night and nothing else, so the town can always afford more of them than it
   * can afford mistakes.
   */
  it('always leaves more skipped days than wrong ropes', () => {
    const clock = townClock(
      board({
        day: 2,
        aliveSlots: Array.from({ length: 12 }, (_, index) => index + 1),
        roleSlots: roster('mafioso', 'mafioso', 'godfather', ...town(9))
      })
    );
    assert.ok(clock.skips > clock.mislynches);
  });
});

describe('who is actually threatening the town', () => {
  /** A family reaches parity. That is the clock the old count was built for. */
  it('reads the biggest family as the bloc, not every killer added up', () => {
    const clock = townClock(
      board({
        day: 2,
        aliveSlots: Array.from({ length: 9 }, (_, index) => index + 1),
        roleSlots: roster('mafioso', 'godfather', 'enforcer', 'serial-killer', ...town(5))
      })
    );

    assert.equal(clock.bloc?.camp, 'mafia');
    assert.equal(clock.bloc?.size, 2, 'the triad and the lone knife are not the mafia');
    assert.equal(clock.blades, 4, 'they are all still knives, though');
  });

  /**
   * And a table of lone killers has no parity to race for at all, so the clock
   * is the wall at two seats instead.
   */
  it('measures a table of lone knives against the wall, not against parity', () => {
    const clock = townClock(
      board({
        day: 2,
        aliveSlots: [1, 2, 3, 4, 5, 6],
        roleSlots: roster('serial-killer', 'arsonist', ...town(4))
      })
    );

    assert.equal(clock.bloc, null);
    assert.equal(clock.margin, 4, 'six alive, and at two nobody can be hanged');
  });

  /**
   * The regression the bench caught: splitting by faction and stopping there
   * told the town a Serial Killer was no hurry, and solo wins went up five
   * points. Two camps means two knives a night.
   */
  it('charges a wasted day for every camp still standing', () => {
    const one = townClock(
      board({
        day: 2,
        aliveSlots: Array.from({ length: 9 }, (_, index) => index + 1),
        roleSlots: roster('mafioso', 'godfather', ...town(7))
      })
    );
    const three = townClock(
      board({
        day: 2,
        aliveSlots: Array.from({ length: 9 }, (_, index) => index + 1),
        roleSlots: roster('mafioso', 'godfather', 'serial-killer', 'arsonist', ...town(5))
      })
    );

    assert.ok(three.nightly > one.nightly, 'three camps take more than one does');
    assert.ok(three.mislynches < one.mislynches);
  });
});

describe('what the town has actually watched', () => {
  /**
   * The roster is a prior and the dawn report is a measurement. A board that
   * has lost one head a night for four nights is losing one a night, whatever
   * the list on the wall says was dealt.
   */
  it('prefers the body count to the roster once there are nights to count', () => {
    const quiet = townClock(
      board({
        day: 5,
        aliveSlots: Array.from({ length: 12 }, (_, index) => index + 1),
        totalDead: 4,
        nightDeathsTotal: 4,
        deaths: Array.from({ length: 4 }, (_, index) => ({
          slot: 13 + index,
          day: index + 1,
          phase: 'night' as const,
          source: 'mafia' as const
        })),
        roleSlots: roster('mafioso', 'godfather', 'serial-killer', 'arsonist', ...town(11))
      })
    );

    assert.equal(quiet.nightly, 2, 'four nights and four bodies is one body a night');
  });
});

describe('a clock that has stopped', () => {
  /**
   * Every knife accounted for. Telling the town it is two ropes from parity
   * would have it hang somebody to be safe, which is the one thing left that
   * could lose the game.
   */
  it('stops pressing when the graveyard holds every killer the roster dealt', () => {
    const clock = townClock(
      board({
        day: 5,
        aliveSlots: [1, 2, 3, 4, 5, 6],
        totalDead: 2,
        deadRoles: new Map<number, RoleId>([
          [7, 'mafioso'],
          [8, 'godfather']
        ]),
        deaths: [
          { slot: 7, day: 3, phase: 'day', source: null },
          { slot: 8, day: 4, phase: 'day', source: null }
        ],
        roleSlots: roster('mafioso', 'godfather', ...town(6))
      })
    );

    assert.equal(clock.blades, 0);
    assert.equal(clock.pressure, 0);
  });

  /** Unless somebody died in the dark, which settles it whatever the arithmetic says. */
  it('never counts out a camp that killed last night', () => {
    const clock = townClock(
      board({
        day: 5,
        aliveSlots: [1, 2, 3, 4, 5, 6],
        totalDead: 3,
        lastNightDeathSlots: new Set([9]),
        nightDeathsTotal: 1,
        deadRoles: new Map<number, RoleId>([
          [7, 'mafioso'],
          [8, 'godfather']
        ]),
        deaths: [
          { slot: 7, day: 3, phase: 'day', source: null },
          { slot: 8, day: 3, phase: 'day', source: null },
          { slot: 9, day: 4, phase: 'night', source: 'mafia' }
        ],
        roleSlots: roster('mafioso', 'godfather', ...town(6))
      })
    );

    assert.ok(clock.blades >= 1, 'somebody made that corpse');
    assert.ok(clock.pressure > 0);
  });
});
