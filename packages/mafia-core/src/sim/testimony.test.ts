import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RoleId } from '../roles.js';
import type { IntelEntry } from '../state.js';
import { testimonyOf } from './testimony.js';

/**
 * What one night's record says out loud, kind by kind.
 *
 * The same rule wherever a record becomes words: a dead seat's will on the
 * board, a live seat reading out its night, the bench's wills and a promise
 * kept the next morning. Seat 2 is speaking throughout, about night 3.
 */
const SPEAKER = 2;
const DEALT = new Set<RoleId>(['jailor', 'arsonist', 'vigilante', 'mafioso', 'sheriff', 'citizen']);

function said(entry: Omit<IntelEntry, 'night'>) {
  return testimonyOf({ night: 3, ...entry }, SPEAKER, DEALT).map((claim) => ({
    kind: claim.kind,
    target: claim.targetSlot,
    ...(claim.at !== undefined ? { at: claim.at } : {}),
    ...(claim.account !== undefined ? { account: claim.account } : {})
  }));
}

describe('what a night record says', () => {
  it('reads a check as an accusation or a clearing', () => {
    assert.deepEqual(said({ kind: 'sheriff', targetSlot: 5, value: 'suspect' }), [{ kind: 'accuse', target: 5 }]);
    assert.deepEqual(said({ kind: 'sheriff', targetSlot: 5, value: 'clear' }), [{ kind: 'clear', target: 5 }]);
  });

  it('reads an exact role as its side, and nothing out of a stray value', () => {
    assert.deepEqual(said({ kind: 'role', targetSlot: 6, value: 'mafioso' }), [{ kind: 'accuse', target: 6 }]);
    assert.deepEqual(said({ kind: 'role', targetSlot: 6, value: 'doctor' }), [{ kind: 'clear', target: 6 }]);
    assert.deepEqual(said({ kind: 'role', targetSlot: 6, value: 'not-a-role' }), []);
  });

  it('reads a smell against the roster on the wall', () => {
    assert.deepEqual(said({ kind: 'trade', targetSlot: 4, value: 'gas' }), [{ kind: 'accuse', target: 4 }]);
    assert.deepEqual(said({ kind: 'trade', targetSlot: 4, value: 'keys' }), [{ kind: 'clear', target: 4 }]);
    assert.deepEqual(said({ kind: 'trade', targetSlot: 4, value: 'powder' }), [{ kind: 'hint', target: 4 }]);
  });

  it('names every visitor a watch saw, and never the watcher itself', () => {
    assert.deepEqual(said({ kind: 'visitors', targetSlot: 4, value: '', slots: [3, SPEAKER, 7] }), [
      { kind: 'sighting', target: 3, at: 4 },
      { kind: 'sighting', target: 7, at: 4 }
    ]);
    assert.deepEqual(said({ kind: 'visitors', targetSlot: 4, value: '', slots: [] }), []);
  });

  it('puts a tail where it ended, and says nothing of a tail that went nowhere', () => {
    assert.deepEqual(said({ kind: 'tracked', targetSlot: 6, value: '', slots: [1] }), [
      { kind: 'sighting', target: 6, at: 1 }
    ]);
    assert.deepEqual(said({ kind: 'tracked', targetSlot: 6, value: '', slots: [] }), []);
  });

  it('accounts for a journey', () => {
    assert.deepEqual(said({ kind: 'went', targetSlot: 5, value: '' }), [
      { kind: 'account', target: 5, account: 'visited' }
    ]);
  });

  it('says nothing about a night that only happened to the seat', () => {
    for (const kind of ['blocked', 'jailed', 'saved', 'doused'] as const) {
      assert.deepEqual(said({ kind, targetSlot: 5, value: '' }), [], kind);
    }
  });

  it('signs every line as worked, from that night, by the speaker', () => {
    const [claim] = testimonyOf({ night: 3, kind: 'sheriff', targetSlot: 5, value: 'suspect' }, SPEAKER, DEALT);
    assert.equal(claim?.claimerSlot, SPEAKER);
    assert.equal(claim?.night, 3);
    assert.equal(claim?.day, 3);
    assert.equal(claim?.worked, true);
    assert.equal(claim?.from, 'sheriff');
  });
});
