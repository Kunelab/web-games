import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MafiaPlayer } from '../state.js';
import { makeBrain, worthWhispering, type Brain, type Personality, type PublicInfo } from './policies.js';

/**
 * A word said to one seat instead of to the room.
 *
 * A table talks in one room, so everything a seat knows it either shouts or
 * keeps, and that is not how people play. The sash is the standing invitation:
 * a living revealed Mayor or Marshall is the one seat the whole table knows
 * cannot be a wolf, so telling him is the cheapest way to be believed later,
 * and for an evil it is the cheapest way to buy the same thing with a lie.
 */

const seat = (slot: number, role: string): MafiaPlayer =>
  ({ slot, role, alive: true, playerId: `p${slot}` }) as unknown as MafiaPlayer;

function board(over: Partial<PublicInfo> = {}): PublicInfo {
  return {
    day: 3,
    aliveSlots: [1, 2, 3, 4, 5],
    provenRoles: new Map([[2, 'mayor']]),
    claims: [],
    ...over
  } as unknown as PublicInfo;
}

/** A plain middle-of-the-road seat: `makePersonality` on an empty profile yields NaN. */
const EVEN = { aggression: 0.5, herd: 0.5, claimRate: 0.5, deceit: 0.5, courage: 0.5 } as unknown as Personality;
const brainFor = (slot: number): Brain => makeBrain(slot, EVEN);
/** Always take the odds, so the gate under test is the interesting one. */
const willing = () => 0;

describe('a word for one seat', () => {
  it('tells a revealed sash what it really is, when it is town', () => {
    const said = worthWhispering(seat(1, 'sheriff'), brainFor(1), board(), willing);
    assert.deepEqual(said, { toSlot: 2, role: 'sheriff' });
  });

  it('says nothing when no sash is out', () => {
    const bare = board({ provenRoles: new Map() });
    assert.equal(worthWhispering(seat(1, 'sheriff'), brainFor(1), bare, willing), null);
  });

  it('says nothing on day one, when nobody has anything to tell', () => {
    assert.equal(worthWhispering(seat(1, 'sheriff'), brainFor(1), board({ day: 1 }), willing), null);
  });

  it('leans into each listener once, because the gesture is public', () => {
    const brain = brainFor(1);
    const first = worthWhispering(seat(1, 'doctor'), brain, board(), willing);
    assert.notEqual(first, null);
    brain.whispered.push(first!.toSlot);
    assert.equal(worthWhispering(seat(1, 'doctor'), brain, board(), willing), null);
  });

  /**
   * A lie told privately has to match the lie told publicly, or the Mayor is
   * holding the contradiction that hangs its author.
   */
  it('has an evil repeat the badge it is already wearing', () => {
    const wearing = board({
      claims: [{ kind: 'role-claim', claimerSlot: 1, claimedRole: 'doctor', day: 2 }] as unknown as PublicInfo['claims']
    });
    const said = worthWhispering(seat(1, 'mafioso'), brainFor(1), wearing, willing);
    assert.deepEqual(said, { toSlot: 2, role: 'doctor' });
  });

  it('keeps an evil with no claim yet quiet rather than inventing one here', () => {
    assert.equal(worthWhispering(seat(1, 'mafioso'), brainFor(1), board(), willing), null);
  });

  /** Not every seat, every day: the gesture is public and a parade is a target list. */
  it('does not fire when the dice say otherwise', () => {
    assert.equal(worthWhispering(seat(1, 'sheriff'), brainFor(1), board(), () => 0.99), null);
  });

  it('never whispers to itself', () => {
    const own = board({ provenRoles: new Map([[1, 'mayor']]) });
    assert.equal(worthWhispering(seat(1, 'mayor'), brainFor(1), own, willing), null);
  });
});
