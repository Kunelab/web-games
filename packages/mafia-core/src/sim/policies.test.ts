import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toPublicInfo } from '../observe.js';
import type { RoleId } from '../roles.js';
import { createMafiaGame, playerBySlot, type MafiaPlayer, type MafiaState } from '../state.js';
import { contradicted, feelPressure, losingClock, makeBrain, type Claim, type PublicInfo } from './policies.js';

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

  it('a thinning family feels the board even with nothing pointed at it', () => {
    const state = table(['mafioso', 'citizen', 'citizen', 'citizen', 'citizen', 'doctor']);
    const lonely = playerBySlot(state, 1)!;
    const alone = losingClock(lonely, 'family', toPublicInfo(state, [], []), new Set());
    const supported = losingClock(lonely, 'family', toPublicInfo(state, [], []), new Set([2, 3]));
    assert.ok(alone > supported, 'numbers are the family clock');
  });
});
