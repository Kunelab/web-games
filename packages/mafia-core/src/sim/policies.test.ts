import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toPublicInfo } from '../observe.js';
import type { RoleId } from '../roles.js';
import { createMafiaGame, playerBySlot, type MafiaPlayer, type MafiaState } from '../state.js';
import {
  bindPersonalities,
  buddyScore,
  claimerWeight,
  contradicted,
  decideNightTarget,
  feelPressure,
  losingClock,
  makeBrain,
  steadyVote,
  suspicionParts,
  type Claim,
  type PublicInfo
} from './policies.js';

/** A table of the given roles, already mid-game on day `day`. */
function table(roles: RoleId[], day = 2): MafiaState {
  const state = createMafiaGame({ code: 'POL', hostToken: 'h', hostUserId: null, now: 0 });
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

const claim = (parts: Partial<Claim> & Pick<Claim, 'claimerSlot' | 'targetSlot' | 'kind'>): Claim => ({
  day: 2,
  truthful: false,
  ...parts
});

describe('the claims board', () => {
  /**
   * The afternoon loop this whole layer exists for: somebody is asked to account
   * for their night, says they stayed home, and a watcher puts them on a
   * doorstep. Only a *sighting* closes it — the first version accepted any
   * credible accusation and cost the town nine points of correct lynches,
   * because it punished honest seats who happened to be framed.
   */
  it('catches a false account, but only on movement evidence', () => {
    const state = table(['citizen', 'lookout', 'mafioso', 'doctor', 'sheriff']);
    const board = (claims: Claim[]): PublicInfo => toPublicInfo(state, claims, []);

    const saidHome = claim({ claimerSlot: 3, targetSlot: 3, kind: 'account', account: 'home' });

    assert.equal(contradicted(3, board([saidHome])), false, 'an unchallenged account stands');

    const merelyAccused = board([saidHome, claim({ claimerSlot: 2, targetSlot: 3, kind: 'accuse' })]);
    assert.equal(contradicted(3, merelyAccused), false, 'suspicion is not testimony');

    const seenOut = board([saidHome, claim({ claimerSlot: 2, targetSlot: 3, kind: 'sighting' })]);
    assert.equal(contradicted(3, seenOut), true, 'a sighting against "I was home" is the catch');
  });

  it('admitting you went out cannot be contradicted', () => {
    const state = table(['citizen', 'lookout', 'doctor']);
    const board = toPublicInfo(
      state,
      [
        claim({ claimerSlot: 3, targetSlot: 1, kind: 'account', account: 'visited' }),
        claim({ claimerSlot: 2, targetSlot: 3, kind: 'sighting' })
      ],
      []
    );
    assert.equal(contradicted(3, board), false, 'the honest answer carries no trap');
  });

  it('a discredited witness cannot catch anybody', () => {
    const state = table(['citizen', 'lookout', 'mafioso', 'doctor']);
    // Slot 2 accused slot 4, slot 4 died town: slot 2 is a proven liar, weight 0.
    state.players.s4.alive = false;
    const board = toPublicInfo(
      state,
      [
        claim({ claimerSlot: 2, targetSlot: 4, kind: 'accuse' }),
        claim({ claimerSlot: 3, targetSlot: 3, kind: 'account', account: 'home' }),
        claim({ claimerSlot: 2, targetSlot: 3, kind: 'sighting' })
      ],
      []
    );
    assert.equal(contradicted(3, board), false, 'a burnt witness is not a witness');
  });
});

describe('desperation in play', () => {
  it('rises for a seat with the town closing in, and eases when it lets go', () => {
    const state = table(['mafioso', 'citizen', 'citizen', 'citizen', 'doctor', 'sheriff']);
    const brain = makeBrain(1, { aggression: 0.5, herd: 0.5, claimRate: 0.7, deceit: 0.5, courage: 0.5 });
    const self = playerBySlot(state, 1)!;

    // Three seats pointing at house 1.
    state.votes = { s2: 's1', s3: 's1', s4: 's1' };
    const hot = feelPressure(self, brain, toPublicInfo(state, [], []), new Set());
    assert.equal(hot.agenda, 'family');
    assert.ok(hot.desperation > 0.3, 'a wagon registers');
    assert.ok(hot.stance.fakeClaim > 0, 'and it reaches for a mask');

    state.votes = {};
    const cooled = feelPressure(self, brain, toPublicInfo(state, [], []), new Set());
    assert.ok(cooled.desperation < hot.desperation, 'the wagon rolled off');
  });

  it('an ignored jester is the desperate one', () => {
    const state = table(['jester', 'citizen', 'citizen', 'citizen', 'doctor'], 3);
    const jester = playerBySlot(state, 1)!;

    const ignored = losingClock(jester, 'jester', toPublicInfo(state, [], []), new Set());
    state.votes = { s2: 's1', s3: 's1', s4: 's1' };
    const wanted = losingClock(jester, 'jester', toPublicInfo(state, [], []), new Set());

    assert.ok(ignored > wanted, 'attention is what he is short of, not safety');
  });

  /**
   * The buddy tell only means anything if it fires on a real pair and stays
   * quiet on a coincidence, so both halves are worth a test: a nudge that never
   * triggers is dead weight in the scoring, and one that triggers on two days of
   * agreement is how a town lynches itself for no reason.
   */
  it('reads two seats who never vote for each other and often vote together', () => {
    const state = table(['mafioso', 'mafioso', 'citizen', 'citizen', 'citizen', 'doctor'], 5);
    // Slots 1 and 2 spent four days agreeing and never once crossed.
    const voteHistory = [
      { day: 1, voterSlot: 1, targetSlot: 5 },
      { day: 1, voterSlot: 2, targetSlot: 5 },
      { day: 2, voterSlot: 1, targetSlot: 4 },
      { day: 2, voterSlot: 2, targetSlot: 4 },
      { day: 3, voterSlot: 1, targetSlot: 6 },
      { day: 3, voterSlot: 2, targetSlot: 3 },
      { day: 4, voterSlot: 1, targetSlot: 3 },
      { day: 4, voterSlot: 2, targetSlot: 3 }
    ];
    const info = { ...toPublicInfo(state, [], []), voteHistory };

    assert.ok(buddyScore(1, info) > 0.5, 'a bonded pair shows up');
    assert.ok(buddyScore(2, info) > 0.5, 'and it shows up from either side');
  });

  it('does not call a pair on one afternoon of agreement', () => {
    const state = table(['mafioso', 'mafioso', 'citizen', 'citizen', 'citizen', 'doctor'], 5);
    const info = {
      ...toPublicInfo(state, [], []),
      voteHistory: [
        { day: 1, voterSlot: 1, targetSlot: 5 },
        { day: 1, voterSlot: 2, targetSlot: 5 },
        { day: 2, voterSlot: 1, targetSlot: 4 },
        { day: 2, voterSlot: 2, targetSlot: 4 }
      ]
    };
    assert.equal(buddyScore(1, info), 0, 'two days is a coincidence, not a pattern');
  });

  it('clears a pair the moment one of them votes the other', () => {
    const state = table(['citizen', 'citizen', 'citizen', 'citizen', 'citizen', 'doctor'], 5);
    const info = {
      ...toPublicInfo(state, [], []),
      voteHistory: [
        { day: 1, voterSlot: 1, targetSlot: 5 },
        { day: 1, voterSlot: 2, targetSlot: 5 },
        { day: 2, voterSlot: 1, targetSlot: 4 },
        { day: 2, voterSlot: 2, targetSlot: 4 },
        { day: 3, voterSlot: 1, targetSlot: 6 },
        { day: 3, voterSlot: 2, targetSlot: 6 },
        // And then one of them turned on the other, which is the whole point.
        { day: 4, voterSlot: 1, targetSlot: 2 },
        { day: 4, voterSlot: 2, targetSlot: 3 }
      ]
    };
    assert.equal(buddyScore(1, info), 0, 'they crossed, so they are not a pair');
  });

  it('a thinning family feels the board even with nothing pointed at it', () => {
    const state = table(['mafioso', 'citizen', 'citizen', 'citizen', 'citizen', 'doctor']);
    const lonely = playerBySlot(state, 1)!;
    const alone = losingClock(lonely, 'family', toPublicInfo(state, [], []), new Set());
    const supported = losingClock(lonely, 'family', toPublicInfo(state, [], []), new Set([2, 3]));
    assert.ok(alone > supported, 'numbers are the family clock');
  });
});

/** A middling personality: the herd factor is all `suspicionParts` reads off it. */
const HERD_HALF = { aggression: 0.5, herd: 0.5, claimRate: 0.5, deceit: 0.5, courage: 0.5 };

describe('two seats claiming one unique role', () => {
  /**
   * The table that prompted this: two Jailor claims, the town hangs one of them
   * and it is a Triad, then the town hangs the other one, who was the real
   * Jailor.
   *
   * The second hanging is the defect. Once the graveyard has shown that one of
   * the two was lying, and which one, the question the room was arguing about
   * has been answered: the survivor's claim is corroborated, not merely no
   * longer contested. Before this the penalty simply stopped applying, which
   * returned them to the middle of the pack with a warm wagon still on them.
   */
  function suspicionOfSurvivor(deadRole: RoleId | null): number {
    // Slot 1 judges. Slots 2 and 3 both claim Jailor; 3 is dead when given a role.
    const state = table(['sheriff', 'jailor', 'consigliere', 'citizen', 'citizen']);
    const judge = playerBySlot(state, 1);
    const corpse = playerBySlot(state, 3);
    if (!judge || !corpse) throw new Error('the table is missing a seat');

    if (deadRole !== null) {
      corpse.alive = false;
      corpse.role = deadRole;
      state.deaths.push({
        playerId: corpse.playerId,
        day: 2,
        phase: 'day',
        cause: { k: 'mafia.cause.lynched' },
        role: deadRole,
        hidden: false
      });
    }

    const claims: Claim[] = [
      claim({ claimerSlot: 2, targetSlot: 2, kind: 'role-claim', claimedRole: 'jailor' }),
      claim({ claimerSlot: 3, targetSlot: 3, kind: 'role-claim', claimedRole: 'jailor' })
    ];

    bindPersonalities([makeBrain(judge.slot, HERD_HALF)]);
    return suspicionParts(2, judge, toPublicInfo(state, claims, []), () => 0).evidence;
  }

  it('makes a claimant look bad while the rival is still alive', () => {
    assert.ok(suspicionOfSurvivor(null) > 1, 'a contested unique claim is evidence against both of them');
  });

  it('clears the survivor once the rival is hanged and turns out to be evil', () => {
    const contested = suspicionOfSurvivor(null);
    const settled = suspicionOfSurvivor('consigliere');
    assert.ok(settled < contested, 'the cost of the contest has to be gone');
    assert.ok(settled < 0, `and the survivor should read as cleared, got ${settled}`);
  });

  it('does not clear them when the rival turned out to be town', () => {
    // A town seat that fake-claimed proves nothing about the other claimant.
    assert.ok(suspicionOfSurvivor('doctor') >= 0, 'an innocent corpse is not corroboration');
  });

  it('still condemns a seat claiming a role that is already in the ground', () => {
    const state = table(['sheriff', 'jailor', 'consigliere', 'citizen', 'citizen']);
    const judge = playerBySlot(state, 1);
    const corpse = playerBySlot(state, 3);
    if (!judge || !corpse) throw new Error('the table is missing a seat');

    corpse.alive = false;
    corpse.role = 'jailor';
    state.deaths.push({
      playerId: corpse.playerId,
      day: 2,
      phase: 'day',
      cause: { k: 'mafia.cause.lynched' },
      role: 'jailor',
      hidden: false
    });

    const claims: Claim[] = [claim({ claimerSlot: 2, targetSlot: 2, kind: 'role-claim', claimedRole: 'jailor' })];
    bindPersonalities([makeBrain(judge.slot, HERD_HALF)]);
    assert.ok(suspicionParts(2, judge, toPublicInfo(state, claims, []), () => 0).evidence >= 3);
  });
});

describe('a second look at the ballot', () => {
  /**
   * The complaint this answers: a bot never switched its vote, and could not be
   * argued with before the trial.
   *
   * Nothing about the decision was ever sticky. `pickVote` holds no state and
   * never consults the seat's own standing vote, so it would happily change its
   * mind. It was simply never asked again: the one guaranteed day turn lands
   * between 5% and 45% of the phase, which is before the ear has turned a single
   * human sentence into a claim, and the second turn was a 40% coin flip.
   */
  function board(state: MafiaState, claims: Claim[], votes: Record<string, string> = {}): PublicInfo {
    state.votes = votes;
    return toPublicInfo(state, claims, []);
  }

  function seat(state: MafiaState, slot: number): MafiaPlayer {
    const player = playerBySlot(state, slot);
    if (!player) throw new Error('no seat ' + slot);
    bindPersonalities([makeBrain(player.slot, HERD_HALF)]);
    return player;
  }

  it('casts a vote when the seat has none standing', () => {
    const state = table(['sheriff', 'citizen', 'mafioso', 'doctor', 'citizen']);
    const self = seat(state, 1);
    assert.deepEqual(steadyVote(self, board(state, []), null, 3, () => 0), { slot: 3, skip: false });
  });

  it('leaves a standing vote alone when the proposal is no better', () => {
    const state = table(['sheriff', 'citizen', 'mafioso', 'doctor', 'citizen']);
    const self = seat(state, 1);
    // Nothing on the board, so 3 and 4 look identical: jitter must not move it.
    assert.deepEqual(
      steadyVote(self, board(state, []), 4, 3, () => 0),
      { slot: null, skip: false },
      'a weathervane is worse than a stubborn seat'
    );
  });

  it('switches when the board turns up a real case', () => {
    const state = table(['sheriff', 'citizen', 'mafioso', 'doctor', 'citizen']);
    const self = seat(state, 1);
    const claims: Claim[] = [
      claim({ claimerSlot: 2, targetSlot: 3, kind: 'accuse' }),
      claim({ claimerSlot: 5, targetSlot: 3, kind: 'accuse' })
    ];
    assert.deepEqual(steadyVote(self, board(state, claims), 4, 3, () => 0), { slot: 3, skip: false });
  });

  /**
   * The deadlock, which is the one case worth crossing the floor for: two seats
   * level at the bell means nobody hangs and the night side keeps a free day.
   */
  it('breaks a tie towards the seat it actually suspects', () => {
    const state = table(['sheriff', 'citizen', 'mafioso', 'doctor', 'citizen']);
    const self = seat(state, 1);
    const claims: Claim[] = [
      claim({ claimerSlot: 2, targetSlot: 3, kind: 'accuse' }),
      claim({ claimerSlot: 5, targetSlot: 3, kind: 'accuse' })
    ];
    // 3 and 4 are level on two votes each, and only 3 has a case against it.
    const votes = { s2: 's3', s5: 's3', s3: 's4', s4: 's4' };
    assert.deepEqual(
      steadyVote(self, board(state, claims, votes), 4, 4, () => 0),
      { slot: 3, skip: false },
      'the tie should break towards the evidence'
    );
  });

  it('does not break a tie towards a seat nobody has a case against', () => {
    const state = table(['sheriff', 'citizen', 'mafioso', 'doctor', 'citizen']);
    const self = seat(state, 1);
    const votes = { s2: 's3', s5: 's3', s3: 's4', s4: 's4' };
    assert.equal(
      steadyVote(self, board(state, [], votes), 4, 3, () => 0).slot,
      null,
      'a tie-break is not a licence to guess'
    );
  });

  /**
   * And the other half of it: they do not pass often enough when the square has
   * found nothing at all.
   */
  it('votes to hang nobody when the board holds no case against anyone', () => {
    // Twelve alive, so the parity clock is not pressing and a skip is honest.
    const state = table([
      'sheriff', 'citizen', 'mafioso', 'doctor', 'citizen', 'lookout',
      'escort', 'citizen', 'godfather', 'citizen', 'jailor', 'citizen'
    ]);
    const self = seat(state, 1);
    assert.deepEqual(steadyVote(self, board(state, []), null, null, () => 0), { slot: null, skip: true });
  });

  it('but never at the parity clock, where a wasted day loses the game', () => {
    // Three alive, so one more empty afternoon hands it to whoever kills at night.
    const state = table(['sheriff', 'citizen', 'mafioso', 'doctor', 'citizen']);
    for (const slot of [4, 5]) {
      const dead = playerBySlot(state, slot);
      if (dead) dead.alive = false;
    }
    const self = seat(state, 1);
    assert.equal(
      steadyVote(self, board(state, []), null, null, () => 0).skip,
      false,
      'a town seat at the parity clock must not help the day end early'
    );
  });

  it('holds its vote rather than passing once it has already accused somebody', () => {
    const state = table(['sheriff', 'citizen', 'mafioso', 'doctor', 'citizen']);
    const self = seat(state, 1);
    assert.deepEqual(
      steadyVote(self, board(state, []), 3, null, () => 0),
      { slot: null, skip: false },
      'an empty proposal is not a retraction'
    );
  });
});

describe('what the record proves', () => {
  /**
   * The deduction a person makes without thinking and the bots never made: the
   * dawn report says the Veteran shot the Sheriff, the Sheriff’s will says
   * "night 2: I went to 4", so 4 is the Veteran. Read off the board, so it works
   * from a bot’s rendered will and from a person’s will once the ear has read it.
   */
  function porch(): { state: MafiaState; info: PublicInfo } {
    const state = table(['citizen', 'sheriff', 'veteran', 'citizen', 'mafioso', 'doctor'], 3);
    const sheriff = playerBySlot(state, 2);
    if (!sheriff) throw new Error('no sheriff');
    sheriff.alive = false;
    sheriff.isBot = true;
    sheriff.lastWill = 'rendered from intel';
    sheriff.intel.push({ night: 2, kind: 'went', targetSlot: 4, value: 'went' });
    state.deaths.push({
      playerId: sheriff.playerId,
      day: 2,
      phase: 'night',
      cause: { k: 'mafia.cause.killedBy' },
      source: 'veteran',
      role: 'sheriff',
      hidden: false
    });
    return { state, info: toPublicInfo(state, [], []) };
  }

  it('names the veteran from a corpse’s last journey', () => {
    const { info } = porch();
    assert.equal(info.provenRoles.get(4), 'veteran');
  });

  it('and then nobody visits that porch', () => {
    const { state, info } = porch();
    const doctor = playerBySlot(state, 6);
    if (!doctor) throw new Error('no doctor');
    bindPersonalities([makeBrain(doctor.slot, HERD_HALF)]);
    const brain = makeBrain(doctor.slot, HERD_HALF);
    for (let i = 0; i < 20; i++) {
      const target = decideNightTarget(doctor, brain, info, [1, 4, 5], 'heal', new Set(), [], () => i / 20);
      assert.notEqual(target, 4, 'the proven veteran is never a night target');
    }
  });

  it('a dead sheriff’s record accuses for it', () => {
    const state = table(['citizen', 'sheriff', 'mafioso', 'citizen'], 3);
    const sheriff = playerBySlot(state, 2);
    if (!sheriff) throw new Error('no sheriff');
    sheriff.alive = false;
    sheriff.isBot = true;
    sheriff.lastWill = 'rendered from intel';
    sheriff.intel.push({ night: 2, kind: 'sheriff', targetSlot: 3, value: 'suspect' });
    state.deaths.push({
      playerId: sheriff.playerId,
      day: 2,
      phase: 'night',
      cause: { k: 'mafia.cause.killedBy' },
      source: 'mafia',
      role: 'sheriff',
      hidden: false
    });

    const info = toPublicInfo(state, [], []);
    const accusation = info.claims.find((claim) => claim.claimerSlot === 2 && claim.kind === 'accuse');
    assert.equal(accusation?.targetSlot, 3, 'the will is on the board under the dead seat');

    const judge = playerBySlot(state, 1);
    if (!judge) throw new Error('no judge');
    bindPersonalities([makeBrain(judge.slot, HERD_HALF)]);
    assert.ok(suspicionParts(3, judge, info, () => 0).evidence >= 3, 'and it is read as a town corpse’s testimony');
  });

  it('a person’s private record is not their will', () => {
    const state = table(['citizen', 'sheriff', 'mafioso', 'citizen'], 3);
    const sheriff = playerBySlot(state, 2);
    if (!sheriff) throw new Error('no sheriff');
    sheriff.alive = false;
    sheriff.isBot = false;
    sheriff.lastWill = 'I saw nothing.';
    sheriff.intel.push({ night: 2, kind: 'sheriff', targetSlot: 3, value: 'suspect' });
    state.deaths.push({
      playerId: sheriff.playerId,
      day: 2,
      phase: 'night',
      cause: { k: 'mafia.cause.killedBy' },
      source: 'mafia',
      role: 'sheriff',
      hidden: false
    });
    const info = toPublicInfo(state, [], []);
    assert.equal(
      info.claims.some((claim) => claim.claimerSlot === 2),
      false,
      'what a person learned and did not write down stays theirs'
    );
  });

  it('a living sheriff whose accusation hanged a mafioso is a proven sheriff', () => {
    const state = table(['citizen', 'sheriff', 'mafioso', 'citizen'], 3);
    const wolf = playerBySlot(state, 3);
    if (!wolf) throw new Error('no wolf');
    wolf.alive = false;
    state.deaths.push({
      playerId: wolf.playerId,
      day: 2,
      phase: 'day',
      cause: { k: 'mafia.cause.lynched' },
      role: 'mafioso',
      hidden: false
    });
    const claims: Claim[] = [
      claim({ claimerSlot: 2, targetSlot: 2, kind: 'role-claim', claimedRole: 'sheriff' }),
      claim({ claimerSlot: 2, targetSlot: 3, kind: 'accuse' })
    ];
    const info = toPublicInfo(state, claims, []);
    assert.equal(info.provenRoles.get(2), 'sheriff');
    assert.ok(claimerWeight(2, info) >= 2, 'and the badge is the loudest voice in the room');
  });
});
