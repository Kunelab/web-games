import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RoleId } from '../roles.js';
import type { Claim, PublicInfo } from './policies.js';
import { visitOdds } from './visits.js';

/**
 * The honest Vigilante, who used to be the most suspicious seat at the table
 * for having done its job.
 *
 * It shoots a mafioso, it is on that doorstep, and the only sentence the board
 * had for it was `account`/`visited` — priced at +0.8 by `visits`, identically
 * to a mafioso caught on the same step, because nothing looked at what the
 * house turned out to be. Meanwhile nothing in `deduce` could ever confirm it,
 * so being right bought nothing at all.
 */
const said = (p: Partial<Claim> & Pick<Claim, 'claimerSlot' | 'targetSlot' | 'kind'>): Claim => ({
  day: 4,
  truthful: false,
  ...p
});

function board(parts: Partial<PublicInfo> = {}): PublicInfo {
  return {
    day: 4,
    aliveSlots: [1, 2, 3, 4, 5],
    deadRoles: new Map<number, RoleId>([[6, 'mafioso']]),
    lastNightDeathSlots: new Set(),
    nightDeathsTotal: 1,
    rampage: 0,
    votes: new Map(),
    totalDead: 1,
    trials: [],
    voteHistory: [],
    revealedMayorSlot: null,
    humanSlots: new Set(),
    trialSlot: null,
    claims: [],
    deaths: [{ slot: 6, day: 3, phase: 'night', source: 'vigilante' }],
    provenRoles: new Map<number, RoleId>(),
    rolesInPlay: new Set<RoleId>(['vigilante', 'doctor', 'mafioso', 'citizen', 'sheriff']),
    ...parts
  } as unknown as PublicInfo;
}

const codes = (info: PublicInfo, slot: number): string[] =>
  visitOdds(info).get(slot)?.reasons.map((reason) => reason.code) ?? [];

describe('a killing the dawn report signs for', () => {
  it('still condemns an unexplained doorstep admission', () => {
    // The control: same admission, nothing vouching for why they were there.
    const info = board({
      claims: [said({ claimerSlot: 1, targetSlot: 6, kind: 'account', account: 'visited', night: 3 })]
    });
    assert.ok(codes(info, 1).includes('admitted-doorstep'), 'an unexplained doorstep is still the doorstep');
  });

  it('stops condemning it once the record has explained it', () => {
    /**
     * `provenRoles` only holds a killing badge when the report credited that
     * weapon and the corpse came up evil, so this is not "they said so".
     */
    const info = board({
      claims: [said({ claimerSlot: 1, targetSlot: 6, kind: 'account', account: 'visited', night: 3 })],
      provenRoles: new Map<number, RoleId>([[1, 'vigilante']])
    });
    assert.ok(
      !codes(info, 1).includes('admitted-doorstep'),
      'a doorstep the graveyard has already explained is not evidence of anything'
    );
  });
});
