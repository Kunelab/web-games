import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RoleId } from '../roles.js';
import { trustOf, type Claim, type PublicInfo } from './policies.js';
import { caseFor, defenceFor, rank } from './ranking.js';
import { visitOdds } from './visits.js';

function board(parts: Partial<PublicInfo> = {}): PublicInfo {
  return {
    day: 4,
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
    rolesInPlay: new Set<RoleId>(['jailor', 'doctor', 'lookout', 'mafioso', 'citizen', 'sheriff']),
    ...parts
  };
}

const said = (parts: Partial<Claim> & Pick<Claim, 'claimerSlot' | 'targetSlot' | 'kind'>): Claim => ({
  day: 4,
  truthful: false,
  ...parts
});

const codes = (reasons: { code: string }[]): string[] => reasons.map((reason) => reason.code);

describe('the movement case', () => {
  /**
   * The rule the whole visit model rests on, and the one that transfers from a
   * table of bots to a table of people unchanged: a killer has to go to the
   * house it kills.
   */
  it('weighs a doorstep far above being out in general', () => {
    const victim = { slot: 5, day: 3, phase: 'night' as const, source: null };

    const onTheStep = board({
      deaths: [victim],
      claims: [said({ claimerSlot: 2, targetSlot: 4, kind: 'sighting', night: 3, at: 5 })]
    });
    const justOut = board({
      deaths: [victim],
      claims: [said({ claimerSlot: 2, targetSlot: 4, kind: 'sighting', night: 3 })]
    });

    const damning = visitOdds(onTheStep).get(4)!;
    const idle = visitOdds(justOut).get(4)!;
    assert.ok(damning.p > idle.p, 'the doorstep of the corpse is not the same as being awake');
    assert.ok(damning.p - idle.p > 0.2, `expected a real gap, got ${(damning.p - idle.p).toFixed(3)}`);
    assert.deepEqual(codes(damning.reasons).slice(0, 1), ['doorstep']);
  });

  /**
   * One watcher naming four visitors is one witness, not four, and every one of
   * them cannot be three quarters guilty.
   */
  it('shares a doorstep between everybody reported on it', () => {
    const deaths = [{ slot: 5, day: 3, phase: 'night' as const, source: null }];
    const alone = board({
      deaths,
      claims: [said({ claimerSlot: 2, targetSlot: 4, kind: 'sighting', night: 3, at: 5 })]
    });
    const crowd = board({
      deaths,
      claims: [
        said({ claimerSlot: 2, targetSlot: 4, kind: 'sighting', night: 3, at: 5 }),
        said({ claimerSlot: 2, targetSlot: 3, kind: 'sighting', night: 3, at: 5 }),
        said({ claimerSlot: 2, targetSlot: 1, kind: 'sighting', night: 3, at: 5 })
      ]
    });

    assert.ok(
      visitOdds(alone).get(4)!.p > visitOdds(crowd).get(4)!.p,
      'being the only one on the step is worth more than being one of three'
    );
  });

  it('will not hear a witness the graveyard revealed as a killer', () => {
    const deaths = [
      { slot: 5, day: 3, phase: 'night' as const, source: null },
      { slot: 2, day: 3, phase: 'night' as const, source: null }
    ];
    const heard = board({
      deaths,
      claims: [said({ claimerSlot: 2, targetSlot: 4, kind: 'sighting', night: 3, at: 5 })]
    });
    const ignored = board({
      deaths,
      deadRoles: new Map<number, RoleId>([[2, 'mafioso']]),
      aliveSlots: [1, 3, 4],
      claims: [said({ claimerSlot: 2, targetSlot: 4, kind: 'sighting', night: 3, at: 5 })]
    });

    assert.ok(codes(visitOdds(heard).get(4)!.reasons).includes('doorstep'));
    assert.ok(!codes(visitOdds(ignored).get(4)!.reasons).includes('doorstep'), 'a revealed killer is not a witness');
  });
});

describe('the ranking, in both directions', () => {
  it('puts the seat with the movement case at the top', () => {
    const standing = rank(
      board({
        deaths: [{ slot: 5, day: 3, phase: 'night', source: null }],
        claims: [
          said({ claimerSlot: 2, targetSlot: 4, kind: 'sighting', night: 3, at: 5 }),
          said({ claimerSlot: 4, targetSlot: 4, kind: 'account', account: 'home', night: 3 })
        ]
      })
    );
    assert.equal(standing[0].slot, 4, 'on the corpse’s step, and claiming to have been in bed');
    assert.ok(standing[0].against.length >= 2, 'and the case has more than one thing in it');
  });

  /**
   * The half that did not exist: the same machinery read backwards is a case
   * *for* somebody, which is what a bystander needs to speak up for a seat it
   * knows nothing about.
   */
  it('builds a case for a seat nobody has anything on', () => {
    const quiet = board({
      deaths: [{ slot: 5, day: 3, phase: 'night', source: null }],
      claims: [
        // Two watched nights, so silence about house 3 means something.
        said({ claimerSlot: 2, targetSlot: 4, kind: 'sighting', night: 3, at: 5 }),
        said({ claimerSlot: 2, targetSlot: 1, kind: 'sighting', night: 2 }),
        said({ claimerSlot: 2, targetSlot: 3, kind: 'clear' })
      ]
    });

    const forThem = defenceFor(3, quiet);
    assert.ok(forThem.length > 0, 'there is something to say for them');
    assert.ok(codes(forThem).includes('vouched-for'), 'somebody the room hears has cleared them');
    assert.ok(
      forThem.every((reason) => reason.weight < 0),
      'and every line of it points away'
    );
  });

  /**
   * The floor, which the calibration run made non-negotiable: seats the ranking
   * put under 0.1 turned out to be killers 40% of the time, so it is never
   * allowed to say anybody is clear.
   */
  it('never claims anybody is innocent, however quiet they have been', () => {
    const nothing = rank(board());
    for (const suspect of nothing) {
      assert.ok(suspect.p >= 0.3, `a seat with nothing on it read as ${suspect.p.toFixed(2)}`);
    }
  });

  it('gives a bare board nothing to accuse anybody of', () => {
    assert.deepEqual(caseFor(3, board()), [], 'no evidence is not a thin case, it is no case');
  });
});

/**
 * The strongest rule in the model, and the one afternoon it got backwards.
 *
 * `SAID.badge` is +2.77 because an uncontested investigative claim tends to be
 * the bluff: the real Sheriff is alive, quiet and not standing up to argue. The
 * whole of that reasoning is about a badge that has survived a day in which
 * somebody could have objected, and nothing was checking that a day had passed.
 */
describe('a badge is only unchallenged once it has had time to be challenged', () => {
  it('says nothing about a claim made this same afternoon', () => {
    const today = board({
      day: 3,
      claims: [said({ claimerSlot: 1, targetSlot: 1, kind: 'role-claim', claimedRole: 'sheriff', day: 3 })]
    });

    /**
     * Reported from a real table: a Sheriff claimed on day 3, named a mafioso
     * and read out both its nights. The badge fired the same minute and the
     * town hanged it 21 to 1 on the strength of having spoken.
     */
    assert.ok(
      !codes(caseFor(1, today)).includes('badge-unchallenged'),
      'a claim nobody has had a turn to answer is unread, not unchallenged'
    );
  });

  it('and counts it from the next day on', () => {
    const yesterday = board({
      day: 4,
      claims: [said({ claimerSlot: 1, targetSlot: 1, kind: 'role-claim', claimedRole: 'sheriff', day: 3 })]
    });

    // The room has had a full afternoon to stand up against it and did not.
    assert.ok(
      codes(caseFor(1, yesterday)).includes('badge-unchallenged'),
      'the rule the bench fitted is still the rule, one day later'
    );
  });
});

/**
 * The other half of the night, which nothing was reading.
 *
 * `visitOdds` prices where people *went*. Who they chose to kill is a decision
 * with a motive behind it, and exactly one shape of it can be pinned on a seat.
 */
describe('who the night chose', () => {
  it('reads an accuser killed on the night of their own accusation', () => {
    const silenced = board({
      day: 4,
      claims: [said({ claimerSlot: 2, targetSlot: 4, kind: 'accuse', day: 3 })],
      deaths: [{ slot: 2, day: 3, phase: 'night', source: 'mafia' }],
      aliveSlots: [1, 3, 4, 5],
      totalDead: 1
    });

    const found = rank(silenced).find((suspect) => suspect.slot === 4);
    assert.ok(codes(found?.against ?? []).includes('accuser-silenced'));
  });

  /**
   * And not an accusation from four days earlier. A killer with other
   * priorities for three nights is not silencing anybody, and reading it that
   * way would fire on half the table by the endgame.
   */
  it('does not read a death nights after the accusation', () => {
    const later = board({
      day: 6,
      claims: [said({ claimerSlot: 2, targetSlot: 4, kind: 'accuse', day: 2 })],
      deaths: [{ slot: 2, day: 5, phase: 'night', source: 'mafia' }],
      aliveSlots: [1, 3, 4, 5],
      totalDead: 1
    });

    const found = rank(later).find((suspect) => suspect.slot === 4);
    assert.ok(!codes(found?.against ?? []).includes('accuser-silenced'));
  });

  /** A hanging is not a silencing: the room did that, in daylight, together. */
  it('only counts a death in the dark', () => {
    const hanged = board({
      day: 4,
      claims: [said({ claimerSlot: 2, targetSlot: 4, kind: 'accuse', day: 3 })],
      deaths: [{ slot: 2, day: 3, phase: 'day', source: null }],
      aliveSlots: [1, 3, 4, 5],
      totalDead: 1
    });

    const found = rank(hanged).find((suspect) => suspect.slot === 4);
    assert.ok(!codes(found?.against ?? []).includes('accuser-silenced'));
  });
});

/**
 * The testimony nobody can cross-examine, which the case was throwing away.
 *
 * `accused-by` filtered its accusers to `aliveSlots`, so every name a dying
 * player wrote down was worth exactly nothing to the ranking. It is the one
 * accusation in this game that is expensive to make and impossible to retract,
 * and the fit says so: +1.311 against -0.255 for the same words from somebody
 * still breathing.
 */
describe('a name written down by the dead', () => {
  const graveyard = (accuser: number, role: RoleId, target: number): PublicInfo =>
    board({
      aliveSlots: [1, 2, 3, 4],
      totalDead: 1,
      deadRoles: new Map<number, RoleId>([[accuser, role]]),
      deaths: [{ slot: accuser, day: 2, phase: 'night', source: 'mafia' }],
      claims: [said({ claimerSlot: accuser, targetSlot: target, kind: 'accuse', day: 2 })]
    });

  it('counts a dead townsperson naming somebody', () => {
    const found = rank(graveyard(5, 'sheriff', 3)).find((suspect) => suspect.slot === 3);
    assert.ok(codes(found?.against ?? []).includes('named-in-a-will'));
  });

  /** A killer's will is kindling: `claimerWeight` puts a dead evil at zero. */
  it('ignores a name written down by a killer', () => {
    const found = rank(graveyard(5, 'mafioso', 3)).find((suspect) => suspect.slot === 3);
    assert.ok(!codes(found?.against ?? []).includes('named-in-a-will'));
  });

  /** And a living accuser is still the other, much cheaper rule. */
  it('is not the same reason as being accused by somebody alive', () => {
    const alive = board({
      aliveSlots: [1, 2, 3, 4, 5],
      claims: [said({ claimerSlot: 5, targetSlot: 3, kind: 'accuse', day: 2 })]
    });
    const found = rank(alive).find((suspect) => suspect.slot === 3);
    assert.ok(!codes(found?.against ?? []).includes('named-in-a-will'));
  });

  it('weighs the dead accusation far above the living one', () => {
    const dead = rank(graveyard(5, 'sheriff', 3)).find((suspect) => suspect.slot === 3);
    const willed = (dead?.against ?? []).find((reason) => reason.code === 'named-in-a-will');
    assert.ok((willed?.weight ?? 0) > 1);
  });
});

/**
 * What mercy costs, which used to be a flat rate.
 *
 * Voting innocent on somebody the graveyard later names as a killer was 2.5
 * whenever it happened. On the second afternoon, with nothing on the board, it
 * is what an honest player does; on the sixth, with three seats naming them and
 * a watcher putting them on a doorstep, nobody does it by accident.
 */
describe('the price of voting innocent on a killer', () => {
  const trial = (day: number, extra: Claim[] = []): PublicInfo =>
    board({
      day: day + 1,
      aliveSlots: [1, 2, 3, 4],
      totalDead: 1,
      deadRoles: new Map<number, RoleId>([[5, 'mafioso']]),
      deaths: [{ slot: 5, day, phase: 'day', source: null }],
      trials: [{ day, accusedSlot: 5, lynched: true, guiltySlots: [2], innocentSlots: [1] }],
      claims: extra
    });

  it('barely charges an early vote on an empty board', () => {
    const early = trustOf(1, trial(2));
    assert.ok(early > -1.2, `an honest early mercy should be cheap, got ${early}`);
  });

  it('charges the full price late, with the room pointing', () => {
    const late = trial(5, [
      said({ claimerSlot: 2, targetSlot: 5, kind: 'accuse', day: 4 }),
      said({ claimerSlot: 3, targetSlot: 5, kind: 'accuse', day: 5 }),
      said({ claimerSlot: 4, targetSlot: 5, kind: 'sighting', day: 5 })
    ]);
    assert.ok(trustOf(1, late) <= -2.4, `a late mercy against a real case is the old flat rate`);
  });

  /** And the clock alone is not the whole story: a thin case late still costs less. */
  it('charges less when the room had found nothing, however late it was', () => {
    const thin = trustOf(1, trial(5));
    const thick = trustOf(
      1,
      trial(5, [
        said({ claimerSlot: 2, targetSlot: 5, kind: 'accuse', day: 4 }),
        said({ claimerSlot: 3, targetSlot: 5, kind: 'accuse', day: 5 }),
        said({ claimerSlot: 4, targetSlot: 5, kind: 'sighting', day: 5 })
      ])
    );
    assert.ok(thin > thick);
  });

  /** Evidence that arrived after the ballot is not evidence the voter had. */
  it('does not charge for a case made after the verdict', () => {
    const later = trustOf(1, trial(2, [said({ claimerSlot: 2, targetSlot: 5, kind: 'accuse', day: 4 })]));
    assert.equal(later, trustOf(1, trial(2)));
  });
});
