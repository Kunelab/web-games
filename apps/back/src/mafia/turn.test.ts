// Before anything that reaches env.ts: see the file for why it must be first.
import './test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addMafiaBot, createMafiaGame, startMafia, type MafiaPlayer, type MafiaState } from 'mafia-core';

import type { Decision } from './bots.js';
import { vetTurn } from './turn.js';

/**
 * The contract this file exists for.
 *
 * Under the model mind the LLM is handed the whole action space and believed
 * about none of it. That is a nice sentence and it is worth exactly as much as
 * the test below: a hallucinated house number reaching game state is the one
 * failure in this system that a person at the table cannot tell apart from a
 * cheating bot, and it is unrecoverable once it lands.
 *
 * So every field is asked the awkward question — a target that is dead, a
 * target that is yourself, a vote before the ballot opens, a cell from a seat
 * with no keys, a sash on somebody who has none — and the answer has to be the
 * played brain's move rather than the model's.
 */
function table(players = 9): MafiaState {
  const rng = () => 0.5;
  const state = createMafiaGame({ code: 'VET0', hostToken: 'h', hostUserId: null, now: 0 });
  for (let index = 0; index < players; index++) {
    addMafiaBot(state, `t${index}`, `P${index + 1}`, (max) => Math.floor(rng() * max));
  }
  startMafia(state, 1000, rng);
  return state;
}

const seatOf = (state: MafiaState, slot: number): MafiaPlayer =>
  Object.values(state.players).find((player) => player.slot === slot)!;

/** A complete, legal turn that does nothing, standing in for the played brain. */
const FLOOR: Decision = { say: null, targetSlot: null, verdict: null, claim: null };

/** What the model asked for, with everything it did not ask for left null. */
const asked = (parts: Partial<Decision>): Decision => ({ ...FLOOR, ...parts });

describe('what the engine lets a model actually do', () => {
  it('takes a legal daytime vote at its word', () => {
    const state = table();
    state.phase = 'day';
    state.stage = 'discussion';
    state.day = 3;
    state.voteOpensAt = null;
    const me = seatOf(state, 1);

    const { decision, refused } = vetTurn(state, me.playerId, asked({ targetSlot: 4 }), FLOOR);
    assert.equal(decision.targetSlot, 4);
    assert.deepEqual(refused, []);
  });

  it('refuses a vote for a house that is not at the table', () => {
    const state = table();
    state.phase = 'day';
    state.stage = 'discussion';
    state.day = 3;
    state.voteOpensAt = null;
    seatOf(state, 4).alive = false;
    const me = seatOf(state, 1);

    const dead = vetTurn(state, me.playerId, asked({ targetSlot: 4 }), FLOOR);
    assert.equal(dead.decision.targetSlot, null, 'a corpse cannot be voted for');
    assert.equal(dead.refused.length, 1);

    const nobody = vetTurn(state, me.playerId, asked({ targetSlot: 99 }), FLOOR);
    assert.equal(nobody.decision.targetSlot, null, 'nor can a house that never existed');
    assert.equal(nobody.refused.length, 1);

    const itself = vetTurn(state, me.playerId, asked({ targetSlot: 1 }), FLOOR);
    assert.equal(itself.decision.targetSlot, null, 'nor yourself');
    assert.match(itself.refused[0], /yourself/);
  });

  /**
   * The two rules a person at the table can see being broken, so the two worth
   * a test of their own: nobody hangs on the first day, and nobody votes while
   * the room is still talking.
   */
  it('refuses a vote on the first day, and one before the ballot opens', () => {
    const state = table();
    state.phase = 'day';
    state.stage = 'discussion';
    state.day = 1;
    state.voteOpensAt = null;
    const me = seatOf(state, 1);

    const dayOne = vetTurn(state, me.playerId, asked({ targetSlot: 4 }), FLOOR);
    assert.equal(dayOne.decision.targetSlot, null);
    assert.match(dayOne.refused[0], /first day/);

    state.day = 3;
    state.voteOpensAt = 10_000;
    const tooSoon = vetTurn(state, me.playerId, asked({ targetSlot: 4 }), FLOOR, 5_000);
    assert.equal(tooSoon.decision.targetSlot, null);
    assert.match(tooSoon.refused[0], /ballot/);

    const onceOpen = vetTurn(state, me.playerId, asked({ targetSlot: 4 }), FLOOR, 20_000);
    assert.equal(onceOpen.decision.targetSlot, 4, 'and allows it the moment the lock lifts');
    assert.deepEqual(onceOpen.refused, []);
  });

  it('lets a seat vote to hang nobody, but not before the ballot opens', () => {
    const state = table();
    state.phase = 'day';
    state.stage = 'discussion';
    state.day = 3;
    state.voteOpensAt = null;
    const me = seatOf(state, 1);

    const open = vetTurn(state, me.playerId, asked({ skipVote: true }), FLOOR);
    assert.equal(open.decision.skipVote, true);

    state.voteOpensAt = 10_000;
    const shut = vetTurn(state, me.playerId, asked({ skipVote: true }), FLOOR, 5_000);
    assert.equal(shut.decision.skipVote, false);
    assert.equal(shut.refused.length, 1);
  });

  it('gives the cell only to a jailor, and the sash only to who is wearing one', () => {
    const state = table();
    state.phase = 'day';
    state.stage = 'discussion';
    state.day = 3;
    state.voteOpensAt = null;
    const me = seatOf(state, 1);
    const target = seatOf(state, 5);

    me.role = 'citizen';
    const noKeys = vetTurn(state, me.playerId, asked({ jailSlot: target.slot }), FLOOR);
    assert.equal(noKeys.decision.jailSlot ?? null, null);
    assert.match(noKeys.refused[0], /cell/);

    me.role = 'jailor';
    const keys = vetTurn(state, me.playerId, asked({ jailSlot: target.slot }), FLOOR);
    assert.equal(keys.decision.jailSlot, target.slot);
    assert.deepEqual(keys.refused, []);

    const noSash = vetTurn(state, me.playerId, asked({ revealMayor: true }), FLOOR);
    assert.equal(noSash.decision.revealMayor ?? false, false, 'a jailor has nothing to reveal');

    me.role = 'mayor';
    const sash = vetTurn(state, me.playerId, asked({ revealMayor: true }), FLOOR);
    assert.equal(sash.decision.revealMayor, true);

    me.revealed = true;
    const again = vetTurn(state, me.playerId, asked({ revealMayor: true }), FLOOR);
    assert.equal(again.decision.revealMayor ?? false, false, 'and only once');
  });

  it('holds a night power to the houses the engine says it may touch', () => {
    const state = table();
    state.phase = 'night';
    state.stage = null;
    state.day = 2;
    const me = Object.values(state.players).find((player) => player.role === 'doctor' || player.role === 'sheriff');
    if (!me) return; // this deal had neither; the rule is covered by the roleless case below

    const legal = vetTurn(state, me.playerId, asked({ targetSlot: 4 }), FLOOR);
    const illegal = vetTurn(state, me.playerId, asked({ targetSlot: 99 }), FLOOR);
    assert.equal(illegal.decision.targetSlot, null, 'a house that does not exist is never a target');
    assert.match(illegal.refused[0], /not a legal target/);
    // The legal one is only asserted when the engine agrees it is legal, which
    // depends on the deal: what matters is that it was not silently rewritten.
    assert.ok(legal.decision.targetSlot === 4 || legal.refused.length === 1);
  });

  it('gives a seat with no power nothing to aim', () => {
    const state = table();
    state.phase = 'night';
    state.stage = null;
    state.day = 2;
    const me = Object.values(state.players).find((player) => player.role === 'citizen');
    if (!me) return;

    const { decision, refused } = vetTurn(state, me.playerId, asked({ targetSlot: 4 }), FLOOR);
    assert.equal(decision.targetSlot, null);
    assert.match(refused[0], /no power tonight/);
  });

  it('does not let the accused vote on its own trial', () => {
    const state = table();
    state.phase = 'day';
    state.stage = 'judgement';
    state.day = 3;
    const me = seatOf(state, 1);
    state.trial = { accusedId: me.playerId, ballots: {} };

    const own = vetTurn(state, me.playerId, asked({ verdict: 'innocent' }), FLOOR);
    assert.equal(own.decision.verdict, null);
    assert.match(own.refused[0], /accused/);

    const juror = seatOf(state, 2);
    const theirs = vetTurn(state, juror.playerId, asked({ verdict: 'guilty' }), FLOOR);
    assert.equal(theirs.decision.verdict, 'guilty');
    assert.deepEqual(theirs.refused, []);
  });

  /**
   * The property the whole design rests on: one bad field costs one field.
   *
   * An all-or-nothing rejection would be just as safe and would produce a seat
   * that does nothing at all on the turn it hallucinated, which is the failure
   * that reads from the outside as "the bots do not use their powers".
   */
  it('keeps the legal half of a half-legal turn', () => {
    const state = table();
    state.phase = 'day';
    state.stage = 'discussion';
    state.day = 3;
    state.voteOpensAt = null;
    const me = seatOf(state, 1);
    me.role = 'citizen';

    const { decision, refused } = vetTurn(
      state,
      me.playerId,
      asked({ say: 'I think it is 4', targetSlot: 4, jailSlot: 7, revealMayor: true }),
      FLOOR
    );
    assert.equal(decision.targetSlot, 4, 'the legal vote survives');
    assert.equal(decision.say, 'I think it is 4', 'and so does the line');
    assert.equal(decision.jailSlot ?? null, null, 'the cell it has no keys to does not');
    assert.equal(decision.revealMayor ?? false, false, 'nor the sash it is not wearing');
    assert.equal(refused.length, 2, 'and both refusals are on the record');
  });
});
