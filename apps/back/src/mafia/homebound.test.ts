import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addMafiaBot, createMafiaGame, type MafiaState, type RoleId } from 'mafia-core';

import { BotMinds } from './bot-mind.js';

/**
 * Not every power is a visit.
 *
 * The Veteran's alert and the Survivor's vest are a night spent at home: nobody
 * is visited, no door is knocked on, and a Lookout watching either of them sees
 * an empty porch. But the engine has only one slot to hand for a self-targeted
 * power — the seat's own — so a driver that files every night action as a
 * journey files those two as a seat visiting itself.
 *
 * That is not a cosmetic slip. It produced a will over a Veteran's own body that
 * read "Night 5: Garuda is where I will be", Garuda being the corpse; and it
 * left the seat an alibi naming itself, which it would then have had to defend
 * in the square the next morning.
 */
describe('a night spent at home', () => {
  function table(role: RoleId): { state: MafiaState; minds: BotMinds; id: string } {
    const state = createMafiaGame({ code: 'HOME1', hostToken: 'h', hostUserId: null, now: 0 });
    for (let i = 0; i < 4; i++) addMafiaBot(state, `tok${i}`, `bot${i}`, () => 0);
    for (const player of Object.values(state.players)) player.role = 'citizen';

    const seat = state.players['bot0'];
    assert.ok(seat);
    seat.role = role;
    state.phase = 'night';
    state.day = 5;

    return { state, minds: new BotMinds(), id: 'bot0' };
  }

  for (const role of ['veteran', 'survivor'] as RoleId[]) {
    it(`is not recorded as a journey for the ${role}`, () => {
      const { state, minds, id } = table(role);
      const seat = state.players[id];
      assert.ok(seat);

      // What the engine hands the driver for a self-targeted power.
      minds.wentTo(state, id, seat.slot);

      const mind = minds.mind(state, id);
      assert.ok(mind);
      assert.deepEqual(mind.went, [], 'went nowhere, so no trip is on the record');
      assert.deepEqual(mind.stayedIn, [5], 'but the night itself is remembered');
      assert.equal(mind.brain.wentTo, null, 'and there is no alibi to defend tomorrow');
    });
  }

  it('still records a real journey', () => {
    const { state, minds, id } = table('doctor');
    minds.wentTo(state, id, 3);

    const mind = minds.mind(state, id);
    assert.ok(mind);
    assert.deepEqual(mind.went, [{ night: 5, slot: 3 }]);
    assert.deepEqual(mind.stayedIn, []);
    assert.equal(mind.brain.wentTo, 3);
  });

  /**
   * The other way in. A role that does visit can still be handed its own slot —
   * a target that resolved to itself, or a fixture that passed one — and that is
   * not a journey either.
   */
  it('refuses a journey to one’s own house whatever the badge', () => {
    const { state, minds, id } = table('doctor');
    const seat = state.players[id];
    assert.ok(seat);
    minds.wentTo(state, id, seat.slot);

    const mind = minds.mind(state, id);
    assert.ok(mind);
    assert.deepEqual(mind.went, []);
    assert.equal(mind.brain.wentTo, null);
  });

  it('remembers one night once, however many times it is told', () => {
    const { state, minds, id } = table('veteran');
    const seat = state.players[id];
    assert.ok(seat);

    minds.wentTo(state, id, seat.slot);
    minds.wentTo(state, id, seat.slot);

    assert.deepEqual(minds.mind(state, id)?.stayedIn, [5]);
  });
});
