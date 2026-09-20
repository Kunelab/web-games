import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RoleId } from '../roles.js';
import type { SlotToken } from '../setups.js';
import { possibleRoles } from './slots.js';

/**
 * The roster from a real table, which is where this whole file comes from.
 *
 * Fourteen town slots, four mafia, two cult, three neutral and one Any Role.
 * The two that matter are the Neutral Benign and the Any Role: between them
 * they are the only slots on this list that could ever have produced a Jester.
 */
const TABLE: SlotToken[] = [
  'bodyguard',
  'doctor',
  'jailor',
  'mason-leader',
  'sheriff',
  'town-core',
  'town-investigative',
  'town-investigative',
  'town-killing',
  'town-killing',
  'town-power',
  'town-protective',
  'town-random',
  'town-random',
  'godfather',
  'kidnapper',
  'mafioso',
  'mafia-deception',
  'cultist',
  'witch-doctor',
  'mass-murderer',
  'witch',
  'neutral-benign',
  'any'
];

describe('what the list on the wall still allows', () => {
  it('allows a jester while both slots that could hold one are open', () => {
    assert.ok(possibleRoles(TABLE, []).has('jester'));
    assert.ok(possibleRoles(TABLE, ['sheriff', 'jailor']).has('jester'), 'town corpses say nothing about the neutrals');
  });

  /**
   * The afternoon this was written for. The Lover was named on day two and the
   * Enforcer on day three, which is both of them: from that morning on there
   * was nowhere at the table for a Jester to be, and a cornered Mafioso claimed
   * one anyway while the only seat able to say so was a person typing it.
   */
  it('and stops once the graveyard has spent both of them', () => {
    const graveyard: RoleId[] = ['witch-doctor', 'lover', 'sheriff', 'jailor', 'kidnapper', 'enforcer', 'bodyguard'];
    const possible = possibleRoles(TABLE, graveyard);
    assert.equal(possible.has('jester'), false, 'the lover took the benign slot and the enforcer took Any Role');
    assert.ok(possible.has('mafioso'), 'and the rest of the table is untouched');
  });

  /** One of the two back, and the claim is honest again. */
  it('allows it again if either slot is still unaccounted for', () => {
    const half: RoleId[] = ['witch-doctor', 'lover', 'sheriff', 'jailor', 'kidnapper', 'bodyguard'];
    assert.ok(possibleRoles(TABLE, half).has('jester'), 'Any Role is still open');
  });

  /**
   * Generosity, which is the whole discipline of this file: every uncertainty
   * has to widen the answer rather than narrow it.
   */
  it('allows everything when the roster is unknown', () => {
    assert.ok(possibleRoles([], ['sheriff']).has('jester'));
  });

  it('allows everything once the corpses stop fitting the slots', () => {
    // Two cultists on a roster with one cult slot is a conversion, not a
    // contradiction, and from there the slots prove nothing.
    const converted: RoleId[] = ['cultist', 'cultist', 'witch-doctor'];
    assert.ok(possibleRoles(TABLE, converted).has('jester'));
  });

  it('keeps a badge the game can still hand out after the deal', () => {
    // An Executioner grieves into motley, so a live Executioner slot is a live
    // Jester whatever the neutral slots have been spent on.
    const withExecutioner: SlotToken[] = ['executioner', 'godfather', 'sheriff', 'doctor'];
    assert.ok(possibleRoles(withExecutioner, []).has('jester'));
  });

  it('and lets an amnesiac dig a spent badge back up', () => {
    const withAmnesiac: SlotToken[] = ['amnesiac', 'godfather', 'sheriff', 'doctor'];
    assert.ok(possibleRoles(withAmnesiac, ['sheriff']).has('sheriff'), 'the amnesiac can remember the dead sheriff');
  });
});
