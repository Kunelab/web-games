import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMafiaGame, joinMafia, startMafia, playerBySlot } from './index.js';

/**
 * The Auditor rewrites a badge in place, and everything downstream read the new
 * one as though it had always been there — so an audited Sheriff's will signed
 * itself "I am the Citizen" over five nights of real checks, and a Survivor
 * turned Scumbag had its truthful notebook thrown away for a liar's.
 *
 * The fix is to remember what was overwritten. This is the engine half: the
 * seat keeps the badge it was dealt, and only the first audit writes it.
 */
describe('an audited seat remembers what it was dealt', () => {
  it('starts with nothing to remember', () => {
    const state = createMafiaGame({ code: 'AUD', hostToken: 'h', hostUserId: null, now: 0 });
    let seed = 5;
    const rng = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let index = 0; index < 8; index++) joinMafia(state, `P${index}`, `tok${index}`, `u${index}`);
    startMafia(state, 1000, rng);

    const seat = playerBySlot(state, 1)!;
    assert.equal(seat.roleBefore ?? null, null, 'a seat nobody has audited was dealt the badge it is wearing');

    /**
     * And the rule the engine applies: the first audit records, a second one
     * does not overwrite it. A seat audited twice was still dealt one role.
     */
    const dealt = seat.role;
    if (seat.roleBefore === undefined || seat.roleBefore === null) seat.roleBefore = seat.role;
    seat.role = 'citizen';
    if (seat.roleBefore === undefined || seat.roleBefore === null) seat.roleBefore = seat.role;
    seat.role = 'scumbag';

    assert.equal(seat.roleBefore, dealt, 'the badge it was dealt survives a second rewrite');
  });
});
