// Before anything that reaches env.ts: see the file for why it must be first.
import './test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { msg } from 'i18n';
import { addMafiaBot, createMafiaGame, startMafia, type MafiaPlayer, type MafiaState, type RoleId } from 'mafia-core';

import { privateWeight, settleConfidences, willHeed, type BotMind } from './bot-mind.js';
import { BotMinds } from './bot-mind.js';

/**
 * Trust earned by outcome, which is the property the whole ledger exists for.
 *
 * The behaviour it replaces was a coin flip: a private request was granted
 * three times in four, for anybody, for ever, on the strength of having been
 * made. So the tests worth having are the ones that would have passed under
 * that arrangement and must not now — a liar getting quieter, an honest source
 * getting louder, and neither of them leaking anywhere near the public board.
 */
function table(players = 9): MafiaState {
  const rng = () => 0.5;
  const state = createMafiaGame({ code: 'CONF', hostToken: 'h', hostUserId: null, now: 0 });
  for (let index = 0; index < players; index++) {
    addMafiaBot(state, `t${index}`, `P${index + 1}`, (max) => Math.floor(rng() * max));
  }
  startMafia(state, 1000, rng);
  state.day = 3;
  return state;
}

const seatOf = (state: MafiaState, slot: number): MafiaPlayer =>
  Object.values(state.players).find((player) => player.slot === slot)!;

/**
 * Kill a seat so the graveyard can answer a confidence about it.
 *
 * `hidden` is the janitor: the corpse is in the ground and the table never
 * learned what it was, which settles nothing and is a case of its own below.
 */
function bury(state: MafiaState, slot: number, role: RoleId, hidden = false): void {
  const player = seatOf(state, slot);
  player.alive = false;
  player.role = role;
  state.deaths.push({
    playerId: player.playerId,
    day: 2,
    phase: 'night',
    cause: msg('x'),
    role,
    ...(hidden ? { hidden: true } : {})
  });
}

describe('what a whisper is worth, once the graveyard has answered', () => {
  const mindOf = (state: MafiaState, slot: number): BotMind => {
    const minds = new BotMinds();
    return minds.mind(state, seatOf(state, slot).playerId)!;
  };

  it('starts every voice at exactly nothing owed either way', () => {
    const state = table();
    const mind = mindOf(state, 1);
    assert.equal(privateWeight(mind, 4), 1, 'an unknown whisperer is neither trusted nor distrusted');
    assert.deepEqual(mind.confided, []);
  });

  it('pays a seat that named a killer, and charges one that named a neighbour', () => {
    const state = table();

    const honest = mindOf(state, 1);
    honest.confided.push({ from: 4, day: 2, kind: 'accuse', about: 6 });
    bury(state, 6, 'mafioso');
    settleConfidences(state, honest);
    assert.ok(privateWeight(honest, 4) > 1, 'they told me in the dark and they were right');
    assert.ok(honest.confided[0].settled, 'and it is banked, not counted twice');

    const misled = mindOf(state, 2);
    misled.confided.push({ from: 4, day: 2, kind: 'accuse', about: 7 });
    bury(state, 7, 'citizen');
    settleConfidences(state, misled);
    assert.ok(privateWeight(misled, 4) < 1, 'they pointed me at a neighbour');
  });

  /**
   * The same seat, worth two different things to two listeners, is the whole
   * reason this cannot live on the shared board.
   */
  it('keeps one seat honest to one listener and burnt to another', () => {
    const state = table();
    bury(state, 6, 'mafioso');

    const told = mindOf(state, 1);
    told.confided.push({ from: 4, day: 2, kind: 'accuse', about: 6 });
    settleConfidences(state, told);

    const notTold = mindOf(state, 2);
    settleConfidences(state, notTold);

    assert.ok(privateWeight(told, 4) > 1);
    assert.equal(privateWeight(notTold, 4), 1, 'a seat nobody whispered to owes nobody anything');
  });

  it('charges vouching for a killer more than accusing a townie', () => {
    const state = table();
    bury(state, 6, 'mafioso');
    bury(state, 7, 'citizen');

    const vouched = mindOf(state, 1);
    vouched.confided.push({ from: 4, day: 2, kind: 'clear', about: 6 });
    settleConfidences(state, vouched);

    const misread = mindOf(state, 2);
    misread.confided.push({ from: 4, day: 2, kind: 'accuse', about: 7 });
    settleConfidences(state, misread);

    assert.ok(
      privateWeight(vouched, 4) < privateWeight(misread, 4),
      'covering for a murderer is not the same mistake as misreading a villager'
    );
  });

  it('settles nothing on a corpse the janitor took', () => {
    const state = table();
    const mind = mindOf(state, 1);
    mind.confided.push({ from: 4, day: 2, kind: 'accuse', about: 6 });

    bury(state, 6, 'mafioso', true);

    settleConfidences(state, mind);
    assert.equal(privateWeight(mind, 4), 1, 'the table never learned what it was, so nobody earned anything');
    assert.ok(!mind.confided[0].settled, 'and the question stays open');
  });

  /**
   * The behaviour the ledger exists to make possible: trust that can be spent.
   */
  it('lets a badly misled seat refuse outright, and never refuses an unknown one flatly', () => {
    const state = table();
    const mind = mindOf(state, 1);

    // A stranger is sometimes heeded and sometimes not, which is temperament.
    const strangerGranted = [0, 0.25, 0.5, 0.75, 0.99].filter((roll) => willHeed(mind, 4, roll));
    assert.ok(strangerGranted.length > 0, 'an unknown voice is not ignored');
    assert.ok(strangerGranted.length < 5, 'nor automatically obeyed');

    mind.privateTrust.set(4, -3);
    const burntGranted = [0, 0.25, 0.5, 0.75, 0.99].filter((roll) => willHeed(mind, 4, roll));
    assert.deepEqual(burntGranted, [], 'a voice that has lied to me in the dark does not move me');

    mind.privateTrust.set(5, 3);
    const earned = [0, 0.25, 0.5, 0.75, 0.99].filter((roll) => willHeed(mind, 5, roll));
    assert.ok(earned.length >= strangerGranted.length, 'and a voice that has been right is heeded at least as often');
  });
});
