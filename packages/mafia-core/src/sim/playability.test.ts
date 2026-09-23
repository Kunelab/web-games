import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toPublicInfo } from '../observe.js';
import type { RoleId } from '../roles.js';
import { createMafiaGame, playerBySlot, type MafiaPlayer, type MafiaState } from '../state.js';
import { deductions } from './deduce.js';
import {
  contradicted,
  decideBallot,
  decideDay,
  decideNightTarget,
  DEFAULT_PROFILE,
  judgeRequest,
  makeBrain,
  suspicionParts,
  type Claim
} from './policies.js';

/**
 * What a person at the table notices, pinned down one rule at a time.
 *
 * Each case here is a move the bench measured as a tell or a fault (see
 * `Probe` and docs/mafia-bots-policy-proposals.md): a knife naming its own
 * victim, a family denying its own brother's badge, a real holder fished out by
 * a fake claim, a request refused for no reason.
 */

function table(roles: RoleId[], day = 3): MafiaState {
  const state = createMafiaGame({ code: 'PLY', hostToken: 'h', hostUserId: null, now: 0 });
  roles.forEach((role, index) => {
    const id = `s${index + 1}`;
    state.players[id] = {
      playerId: id,
      token: `t${id}`,
      name: `P${index + 1}`,
      slot: index + 1,
      isBot: true,
      connected: true,
      alive: true,
      role,
      charges: 3,
      obsessionId: null,
      revealed: false,
      doused: false,
      charged: false,
      poisonedNight: null,
      disguiseRole: null,
      bondPartnerId: null,
      bondKind: null,
      cooldownUntilDay: null,
      silencedDay: null,
      lastWill: '',
      notifications: [],
      intel: [],
      death: null
    } satisfies MafiaPlayer;
  });
  state.phase = 'day';
  state.stage = 'discussion';
  state.day = day;
  return state;
}

/** Seat `slot` died to the family last night. */
function killedLastNight(state: MafiaState, slot: number): void {
  const seat = playerBySlot(state, slot)!;
  seat.alive = false;
  state.deaths.push({
    playerId: seat.playerId,
    day: state.day - 1,
    phase: 'night',
    cause: { k: 'mafia.cause.mafia' },
    role: seat.role!,
    hidden: false,
    source: 'mafia'
  });
}

const claim = (parts: Partial<Claim> & Pick<Claim, 'claimerSlot' | 'targetSlot' | 'kind'>): Claim => ({
  day: 3,
  truthful: false,
  ...parts
});

const always = (value: number) => () => value;

const accounts = (claims: Claim[], slot: number): Claim[] =>
  claims.filter((entry) => entry.kind === 'account' && entry.claimerSlot === slot);

describe('a liar answers "where were you" in its mask', () => {
  const asked = claim({ claimerSlot: 4, targetSlot: 1, kind: 'question' });

  it('never names the house its own knife visited', () => {
    const state = table(['mafioso', 'citizen', 'doctor', 'sheriff', 'citizen']);
    killedLastNight(state, 2);
    const brain = makeBrain(1, DEFAULT_PROFILE);
    brain.wentTo = 2;
    const board = toPublicInfo(state, [asked], []);
    // Dice at zero: every honest roll comes up honest.
    const decision = decideDay(playerBySlot(state, 1)!, brain, board, new Set(), new Set([1]), always(0));
    const said = accounts(decision.publishes, 1);
    assert.equal(said.length, 1, 'it answers');
    assert.ok(
      !said.some((entry) => entry.account === 'visited' && entry.targetSlot === 2),
      'and the answer is never the corpse on the square'
    );
  });

  it('goes out if the badge it wears goes out, and stays in if it does not', () => {
    const state = table(['mafioso', 'citizen', 'doctor', 'sheriff', 'citizen']);
    killedLastNight(state, 2);
    const brain = makeBrain(1, DEFAULT_PROFILE);
    brain.wentTo = 2;

    const asDoctor = toPublicInfo(
      state,
      [claim({ claimerSlot: 1, targetSlot: 1, kind: 'role-claim', claimedRole: 'doctor', day: 2 }), asked],
      []
    );
    const doctor = accounts(decideDay(playerBySlot(state, 1)!, brain, asDoctor, new Set(), new Set([1]), always(0)).publishes, 1);
    assert.equal(doctor[0]?.account, 'visited', 'a claimed Doctor who "stayed home" has refuted its own claim');
    assert.ok(doctor[0] && asDoctor.aliveSlots.includes(doctor[0].targetSlot), 'and it names a living house');

    const asVeteran = toPublicInfo(
      state,
      [claim({ claimerSlot: 1, targetSlot: 1, kind: 'role-claim', claimedRole: 'veteran', day: 2 }), asked],
      []
    );
    const veteran = accounts(decideDay(playerBySlot(state, 1)!, brain, asVeteran, new Set(), new Set([1]), always(0)).publishes, 1);
    assert.equal(veteran[0]?.account, 'home', 'a claimed Veteran never leaves the porch');
  });
});

describe('a family backs its own claims', () => {
  it('never denies a brother the badge he is wearing', () => {
    const state = table(['godfather', 'mafioso', 'jailor', 'citizen', 'citizen', 'citizen']);
    const brain = makeBrain(1, DEFAULT_PROFILE);
    const board = toPublicInfo(
      state,
      [
        claim({ claimerSlot: 2, targetSlot: 2, kind: 'role-claim', claimedRole: 'jailor', day: 2 }),
        claim({ claimerSlot: 3, targetSlot: 3, kind: 'role-claim', claimedRole: 'jailor', day: 2 })
      ],
      []
    );
    const decision = decideDay(playerBySlot(state, 1)!, brain, board, new Set([2]), new Set([1, 2]), always(0));
    assert.ok(
      !decision.publishes.some((entry) => (entry.kind === 'counter-claim' || entry.kind === 'accuse') && entry.targetSlot === 2),
      'the brother is not the one named'
    );
  });

  it('invents nothing on a board where nobody is suspected yet', () => {
    const state = table(['mafioso', 'citizen', 'citizen', 'doctor', 'citizen'], 2);
    const brain = makeBrain(1, DEFAULT_PROFILE);
    const board = toPublicInfo(state, [], []);
    const decision = decideDay(playerBySlot(state, 1)!, brain, board, new Set(), new Set([1]), always(0));
    assert.ok(
      !decision.publishes.some((entry) => entry.kind === 'accuse'),
      'a cold board is where an invented accusation stands out most'
    );
  });
});

describe('a real holder is not fished out by a fake claim', () => {
  it('keeps its badge quiet while the lie is doing nothing, and jails the liar', () => {
    const state = table(['jailor', 'mafioso', 'citizen', 'citizen', 'doctor', 'citizen']);
    const brain = makeBrain(1, DEFAULT_PROFILE);
    const fresh = toPublicInfo(
      state,
      [claim({ claimerSlot: 2, targetSlot: 2, kind: 'role-claim', claimedRole: 'jailor', day: 3 })],
      []
    );
    const decision = decideDay(playerBySlot(state, 1)!, brain, fresh, new Set(), new Set(), always(0));
    assert.ok(
      !decision.publishes.some((entry) => entry.kind === 'role-claim' && entry.claimerSlot === 1),
      'standing up now would only tell the family where the real Jailor sits'
    );
    assert.equal(decision.jailSlot, 2, 'the cell answers the claim instead, at no cost');
  });

  it('stands up once the impostor uses the badge on somebody', () => {
    const state = table(['jailor', 'mafioso', 'citizen', 'citizen', 'doctor', 'citizen']);
    const brain = makeBrain(1, DEFAULT_PROFILE);
    const used = toPublicInfo(
      state,
      [
        claim({ claimerSlot: 2, targetSlot: 2, kind: 'role-claim', claimedRole: 'jailor', day: 3 }),
        claim({ claimerSlot: 2, targetSlot: 4, kind: 'accuse', day: 3 })
      ],
      []
    );
    const decision = decideDay(playerBySlot(state, 1)!, brain, used, new Set(), new Set(), always(0));
    assert.ok(
      decision.publishes.some((entry) => entry.kind === 'role-claim' && entry.claimerSlot === 1 && entry.claimedRole === 'jailor'),
      'a lie that is being used is worth the exposure'
    );
  });

  it('votes guilty on a stand claim of its own role', () => {
    const state = table(['jailor', 'mafioso', 'citizen', 'citizen', 'doctor', 'citizen']);
    state.stage = 'judgement';
    const brain = makeBrain(1, DEFAULT_PROFILE);
    const stand = toPublicInfo(
      state,
      [claim({ claimerSlot: 2, targetSlot: 2, kind: 'role-claim', claimedRole: 'jailor', day: 3 })],
      []
    );
    assert.ok(suspicionParts(2, playerBySlot(state, 1)!, stand, always(0)).hard >= 4, 'it knows that claim is a lie');
    assert.equal(decideBallot(playerBySlot(state, 1)!, brain, stand, 2, new Set(), always(0.5)), 'guilty');
  });
});

describe('a teammate asking for a house', () => {
  const state = table(['mafioso', 'godfather', 'citizen', 'sheriff', 'doctor', 'citizen']);
  const holder = playerBySlot(state, 1)!;
  const board = toPublicInfo(state, [], []);

  it('is followed unless the house has something wrong with it', () => {
    const verdict = judgeRequest(holder, makeBrain(1, DEFAULT_PROFILE), board, 4, [3, 4, 5, 6], new Set([2]));
    assert.deepEqual(verdict, { grant: true, reason: null });
  });

  it('is refused with the reason when the knife already bounced off that door, however often it is asked', () => {
    const armoured = { ...holder, bounced: [4] } as MafiaPlayer;
    const brain = makeBrain(1, DEFAULT_PROFILE);
    assert.deepEqual(judgeRequest(armoured, brain, board, 4, [3, 4, 5, 6], new Set([2])), { grant: false, reason: 'blinde' });
    assert.deepEqual(judgeRequest(armoured, brain, board, 4, [3, 4, 5, 6], new Set([2]), { repeated: true }), {
      grant: false,
      reason: 'blinde'
    });
  });

  it('gives way on a judgement call when the teammate insists', () => {
    const brain = makeBrain(1, DEFAULT_PROFILE);
    brain.lastKillTarget = 4;
    assert.deepEqual(judgeRequest(holder, brain, board, 4, [3, 4, 5, 6], new Set([2])), { grant: false, reason: 'rate' });
    assert.deepEqual(judgeRequest(holder, brain, board, 4, [3, 4, 5, 6], new Set([2]), { repeated: true }), {
      grant: true,
      reason: null
    });
  });
});

describe('a promise to prove it tonight', () => {
  const state = table(['sheriff', 'mafioso', 'citizen', 'citizen', 'veteran'], 4);
  const promised = (slot: number): Claim => claim({ claimerSlot: slot, targetSlot: slot, kind: 'promise', promise: 'night', day: 3 });
  const broken = (slot: number, claims: Claim[]): boolean =>
    deductions(slot, toPublicInfo(state, claims, [])).some((finding) => finding.kind === 'broken-promise');

  it('is kept by the kind of thing the claimed role produces', () => {
    const sheriff = [
      claim({ claimerSlot: 1, targetSlot: 1, kind: 'role-claim', claimedRole: 'sheriff', day: 3 }),
      promised(1),
      claim({ claimerSlot: 1, targetSlot: 2, kind: 'accuse', day: 4 })
    ];
    assert.equal(broken(1, sheriff), false);
  });

  it('is not kept by naming anybody at all with no badge behind it', () => {
    const liar = [promised(2), claim({ claimerSlot: 2, targetSlot: 3, kind: 'accuse', day: 4 })];
    assert.equal(broken(2, liar), true);
  });

  it('is left open for a Veteran nobody visited', () => {
    const veteran = [claim({ claimerSlot: 5, targetSlot: 5, kind: 'role-claim', claimedRole: 'veteran', day: 3 }), promised(5)];
    assert.equal(broken(5, veteran), false);
  });
});

describe('a call from a revealed ally', () => {
  it('moves a town vote that hearsay alone would not', () => {
    const state = table(['mayor', 'citizen', 'citizen', 'mafioso', 'citizen', 'doctor']);
    playerBySlot(state, 1)!.revealed = true;
    const brain = makeBrain(2, DEFAULT_PROFILE);
    const board = toPublicInfo(state, [claim({ claimerSlot: 1, targetSlot: 4, kind: 'accuse', day: 3 })], []);
    assert.ok(suspicionParts(4, playerBySlot(state, 2)!, board, always(0)).hard > 0, 'the sash pointing is something to point to');
    const decision = decideDay(playerBySlot(state, 2)!, brain, board, new Set(), new Set(), always(0.5));
    assert.equal(decision.voteSlot, 4);
  });

  it('is refused, out loud, by a seat holding its own clean check on the seat named', () => {
    const state = table(['mayor', 'sheriff', 'citizen', 'citizen', 'mafioso', 'doctor']);
    playerBySlot(state, 1)!.revealed = true;
    const sheriff = playerBySlot(state, 2)!;
    sheriff.intel.push({ night: 2, kind: 'sheriff', targetSlot: 4, value: 'clear' });
    const board = toPublicInfo(state, [claim({ claimerSlot: 1, targetSlot: 4, kind: 'accuse', day: 3 })], []);
    const decision = decideDay(sheriff, makeBrain(2, DEFAULT_PROFILE), board, new Set(), new Set(), always(0.5));
    assert.notEqual(decision.voteSlot, 4, 'its own check outweighs the call');
    assert.ok(
      decision.publishes.some((entry) => entry.kind === 'clear' && entry.targetSlot === 4),
      'and it says why, where the call was made'
    );
  });
});

describe('the seats that act alone read the firm part of a case', () => {
  it('does not shoot on two fresh badges agreeing, which is what a family forges', () => {
    const state = table(['vigilante', 'mafioso', 'consort', 'citizen', 'citizen', 'doctor', 'citizen']);
    const brain = makeBrain(1, DEFAULT_PROFILE);
    const board = toPublicInfo(
      state,
      [
        claim({ claimerSlot: 2, targetSlot: 2, kind: 'role-claim', claimedRole: 'sheriff', day: 2 }),
        claim({ claimerSlot: 3, targetSlot: 3, kind: 'role-claim', claimedRole: 'escort', day: 2 }),
        claim({ claimerSlot: 2, targetSlot: 4, kind: 'accuse', worked: true, from: 'sheriff', day: 3 }),
        claim({ claimerSlot: 3, targetSlot: 4, kind: 'accuse', worked: true, from: 'blocked', day: 3 })
      ],
      []
    );
    const parts = suspicionParts(4, playerBySlot(state, 1)!, board, always(0));
    assert.ok(parts.hard >= 1.5, 'a juror can point to two reports');
    assert.equal(parts.firm, 0, 'and the record has vouched for neither voice');
    const shot = decideNightTarget(playerBySlot(state, 1)!, brain, board, [2, 3, 4, 5, 6, 7], 'kill', new Set(), [], always(0));
    assert.notEqual(shot, 4, 'the gun waits for something the record has settled');
  });

  it('keeps a Doctor off a porch the square was told is armed', () => {
    const state = table(['doctor', 'veteran', 'sheriff', 'citizen', 'mafioso', 'citizen']);
    const brain = makeBrain(1, DEFAULT_PROFILE);
    const board = toPublicInfo(
      state,
      [
        claim({ claimerSlot: 2, targetSlot: 2, kind: 'role-claim', claimedRole: 'veteran', day: 2 }),
        // The loudest voice at the table, which is where the knife is expected.
        claim({ claimerSlot: 2, targetSlot: 5, kind: 'accuse', day: 2 }),
        claim({ claimerSlot: 2, targetSlot: 4, kind: 'accuse', day: 3 })
      ],
      []
    );
    const healed = decideNightTarget(playerBySlot(state, 1)!, brain, board, [2, 3, 4, 5, 6], 'heal', new Set(), [], always(0));
    assert.notEqual(healed, 2);
  });

  it('checks the seat that voted alongside a killer the graveyard just named', () => {
    const state = table(['sheriff', 'mafioso', 'godfather', 'citizen', 'citizen', 'citizen', 'doctor'], 5);
    const corpse = playerBySlot(state, 2)!;
    corpse.alive = false;
    state.deaths.push({
      playerId: corpse.playerId,
      day: 4,
      phase: 'day',
      cause: { k: 'mafia.cause.lynched' },
      role: 'mafioso',
      hidden: false
    });
    // Three days of ballots: 2 and 3 on the same house every day, never on each other; the rest scattered.
    const votes = [2, 3, 4].flatMap((day) => [
      { day, voterSlot: 2, targetSlot: 5 },
      { day, voterSlot: 3, targetSlot: 5 },
      { day, voterSlot: 4, targetSlot: day === 2 ? 6 : day === 3 ? 7 : 3 },
      { day, voterSlot: 6, targetSlot: day === 2 ? 4 : day === 3 ? 2 : 7 },
      { day, voterSlot: 7, targetSlot: day === 2 ? 3 : day === 3 ? 6 : 4 }
    ]);
    const board = toPublicInfo(state, [], votes);
    const checked = decideNightTarget(
      playerBySlot(state, 1)!,
      makeBrain(1, DEFAULT_PROFILE),
      board,
      [3, 4, 5, 6, 7],
      'investigate',
      new Set(),
      [],
      always(0.5)
    );
    assert.equal(checked, 3);
  });
});

describe('a juror is one person', () => {
  it('answers the same case the same way whatever the dice', () => {
    const state = table(['citizen', 'mafioso', 'citizen', 'citizen', 'doctor', 'citizen']);
    state.stage = 'judgement';
    const board = toPublicInfo(
      state,
      [
        claim({ claimerSlot: 3, targetSlot: 2, kind: 'accuse' }),
        claim({ claimerSlot: 4, targetSlot: 2, kind: 'accuse' }),
        claim({ claimerSlot: 5, targetSlot: 2, kind: 'accuse' })
      ],
      []
    );
    const juror = playerBySlot(state, 1)!;
    const brain = makeBrain(1, DEFAULT_PROFILE);
    const verdicts = [0, 0.3, 0.6, 0.99].map((roll) => decideBallot(juror, brain, board, 2, new Set(), always(roll)));
    assert.equal(new Set(verdicts).size, 1, verdicts.join(', '));
  });
});

describe('a misread line does not hang anybody', () => {
  it('is not caught out on an alibi the reader was guessing at', () => {
    const state = table(['citizen', 'lookout', 'mafioso', 'doctor', 'citizen']);
    const seen = claim({ claimerSlot: 2, targetSlot: 1, kind: 'sighting' });
    const sure = claim({ claimerSlot: 1, targetSlot: 1, kind: 'account', account: 'home' });
    assert.equal(contradicted(1, toPublicInfo(state, [sure, seen], [])), true, 'a sure reading is held to');
    assert.equal(
      contradicted(1, toPublicInfo(state, [{ ...sure, confidence: 0.65 }, seen], [])),
      false,
      'a guessed one is not'
    );
  });
});
