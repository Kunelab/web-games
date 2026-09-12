import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { answerFieldSchema, sessionConfigSchema, type AnswerField, type SessionConfig } from 'game-core';

import type { MediaView } from '../services/media-service.js';
import {
  BUZZ_ARBITRATION_MS,
  advance,
  buzz,
  closeAnswers,
  createSession,
  expireBuzzWindow,
  joinSession,
  nextDeadline,
  resolveBuzzRace,
  submitAnswer,
  toRoundView,
  type SessionState
} from './session.js';

/**
 * The buzzer race.
 *
 * Worth testing at this level rather than through the smoke run because almost
 * everything that can be wrong here is a *rule* rather than a route: who may
 * answer, what a wrong press costs, and which of three live deadlines the server
 * should be waiting on. None of those show up in a screenshot, and two of them
 * (the arbitration order, the early close) only ever happen in the milliseconds
 * between two phones.
 */

/** Built through the schema so the fixtures carry every default the matcher reads. */
function field(overrides: Partial<AnswerField> & { key: string; value: string }): AnswerField {
  return answerFieldSchema.parse(overrides);
}

const FIELDS: AnswerField[] = [
  field({ key: 'title', label: 'Titre', value: 'Dune', points: 10 }),
  field({ key: 'year', label: 'Année', value: '1984', points: 5 })
];

function media(overrides: Partial<MediaView> = {}): MediaView {
  return {
    id: 1,
    user_id: null,
    kind: 'quiz',
    title: 'Item',
    category: null,
    date: null,
    answers: FIELDS,
    payload: { question: 'Quel film ?' },
    timing: null,
    effectiveTiming: { answerMs: 30_000, revealMs: 5_000 },
    readiness: { ready: true, missing: [] },
    created_at: null,
    last_modified: null,
    ...overrides
  };
}

function config(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return sessionConfigSchema.parse({ buzzer: true, autoAdvance: false, ...overrides });
}

/** A session already in its answering phase, with one seat per name. */
function playing(names: string[], overrides: Partial<SessionConfig> = {}, item = media()) {
  const state = createSession({
    playlistName: 'Test',
    playlistId: null,
    hostUserId: null,
    items: [item],
    config: config(overrides),
    existingCodes: new Set()
  });

  const ids = names.map((name) => {
    const result = joinSession(state, name, undefined);
    assert.ok(result.player, `could not seat ${name}`);
    return result.player.id;
  });

  advance(state, () => item, 1_000);
  assert.equal(state.round?.phase, 'answering');
  return { state, ids };
}

/** Press, then close the arbitration window, which is what actually decides it. */
function pressAndSettle(state: SessionState, playerId: string, at: number) {
  const roundId = state.round?.id ?? '';
  const result = buzz({ state, playerId, roundId, claimedAt: at, receivedAt: at });
  resolveBuzzRace(state, at + BUZZ_ARBITRATION_MS);
  return result;
}

/** One answer, with the claim and the arrival at the same moment. */
function answer(state: SessionState, playerId: string, fieldKey: string, value: string, at: number) {
  return submitAnswer({
    state,
    playerId,
    roundId: state.round?.id ?? '',
    fieldKey,
    value,
    claimedAt: at,
    receivedAt: at
  });
}

const CONTEXT = { imageUrl: (source: string) => source };

describe('the buzzer', () => {
  it('refuses an answer from someone who has not buzzed', () => {
    const { state, ids } = playing(['Ana', 'Bo']);

    const result = answer(state, ids[0] ?? '', 'title', 'Dune', 1_500);

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /buzzer/i);
  });

  it('leaves the simultaneous format alone when it is off', () => {
    const { state, ids } = playing(['Ana', 'Bo'], { buzzer: false });

    const result = answer(state, ids[0] ?? '', 'title', 'Dune', 1_500);

    assert.equal(result.ok, true);
    assert.equal(result.correct, true);
    assert.equal(state.round?.buzz, undefined);
  });

  it('gives the buzzer to the earliest press, not the earliest packet', () => {
    const { state, ids } = playing(['Ana', 'Bo']);
    const [ana, bo] = ids as [string, string];
    const roundId = state.round?.id ?? '';

    // Bo's packet arrives first, but Ana pressed 80ms earlier on a slower phone.
    const anaSeat = state.players[ana];
    const boSeat = state.players[bo];
    assert.ok(anaSeat && boSeat);
    anaSeat.rttMs = 200;
    boSeat.rttMs = 10;

    buzz({ state, playerId: bo, roundId, claimedAt: 1_580, receivedAt: 1_590 });
    buzz({ state, playerId: ana, roundId, claimedAt: 1_500, receivedAt: 1_600 });

    resolveBuzzRace(state, 1_900);
    assert.equal(state.round?.buzz?.holderId, ana);
  });

  it('locks everyone else out while it is held', () => {
    const { state, ids } = playing(['Ana', 'Bo']);
    const [ana, bo] = ids as [string, string];

    pressAndSettle(state, ana, 1_500);

    assert.equal(answer(state, bo, 'title', 'Dune', 1_900).ok, false);

    const holder = answer(state, ana, 'title', 'Dune', 1_900);
    assert.equal(holder.ok, true);
    assert.equal(holder.correct, true);
  });

  it('costs the round when the answer is wrong, and reopens', () => {
    const { state, ids } = playing(['Ana', 'Bo']);
    const [ana, bo] = ids as [string, string];
    const roundId = state.round?.id ?? '';

    pressAndSettle(state, ana, 1_500);
    answer(state, ana, 'title', 'Blade Runner', 1_900);

    assert.equal(state.round?.buzz?.holderId, null, 'the buzzer went back');
    assert.ok(state.round?.buzz?.spent.includes(ana), 'Ana spent her shot');

    // And she cannot buy a second go at it.
    assert.equal(buzz({ state, playerId: ana, roundId, claimedAt: 2_000, receivedAt: 2_000 }).ok, false);
    assert.equal(buzz({ state, playerId: bo, roundId, claimedAt: 2_100, receivedAt: 2_100 }).ok, true);
  });

  it('costs the round when the window runs out in silence', () => {
    const { state, ids } = playing(['Ana', 'Bo']);
    const [ana] = ids as [string, string];

    pressAndSettle(state, ana, 1_500);
    assert.equal(expireBuzzWindow(state, 20_000), true);

    assert.ok(state.round?.buzz?.spent.includes(ana));
    assert.equal(state.round?.buzz?.holderId, null);
  });

  it('closes the phase early once nobody is left who could press', () => {
    const { state, ids } = playing(['Ana', 'Bo']);
    const [ana, bo] = ids as [string, string];

    pressAndSettle(state, ana, 1_500);
    answer(state, ana, 'title', 'nope', 1_900);

    pressAndSettle(state, bo, 2_000);
    answer(state, bo, 'title', 'also nope', 2_400);

    assert.equal(state.round?.phase, 'reveal');
  });

  it('closes the phase early once every answer has been named', () => {
    const { state, ids } = playing(['Ana', 'Bo']);
    const [ana] = ids as [string, string];

    pressAndSettle(state, ana, 1_500);

    // The holder keeps the floor across a multi-answer item.
    answer(state, ana, 'title', 'Dune', 1_800);
    assert.equal(state.round?.phase, 'answering', 'one answer left, so the round is not over');
    assert.equal(state.round?.buzz?.holderId, ana, 'and she still holds it');

    answer(state, ana, 'year', '1984', 1_900);
    assert.equal(state.round?.phase, 'reveal');
  });

  it('pays face value rather than the position ladder', () => {
    const { state, ids } = playing(['Ana', 'Bo']);
    const [ana, bo] = ids as [string, string];

    // Ana takes the title, gets the year wrong, and Bo takes the year after her.
    pressAndSettle(state, ana, 1_500);
    answer(state, ana, 'title', 'Dune', 1_800);
    answer(state, ana, 'year', '1999', 1_900);

    pressAndSettle(state, bo, 2_000);
    answer(state, bo, 'year', '1984', 2_400);

    closeAnswers(state, 3_000);

    // 10 for the title, 5 for the year: no 0.7x for going second, and no clock
    // bonus for either of them.
    assert.equal(state.players[ana]?.totalScore, 10);
    assert.equal(state.players[bo]?.totalScore, 5);
  });

  it('waits on the soonest of the three deadlines', () => {
    const { state, ids } = playing(['Ana', 'Bo']);
    const [ana] = ids as [string, string];

    assert.equal(nextDeadline(state)?.kind, 'phase');

    buzz({ state, playerId: ana, roundId: state.round?.id ?? '', claimedAt: 1_500, receivedAt: 1_500 });
    assert.deepEqual(nextDeadline(state), { at: 1_500 + BUZZ_ARBITRATION_MS, kind: 'buzz-race' });

    resolveBuzzRace(state, 1_750);
    assert.equal(nextDeadline(state)?.kind, 'buzz-window');
  });

  it('leaves no deadline armed once the round is revealed', () => {
    const { state, ids } = playing(['Ana', 'Bo']);
    const [ana] = ids as [string, string];

    pressAndSettle(state, ana, 1_500);
    closeAnswers(state, 3_000);

    assert.equal(state.round?.buzz?.holderId, null);
    assert.equal(state.round?.buzz?.windowEndsAt, null);
    // autoAdvance is off in these fixtures, so the reveal has no clock either.
    assert.equal(nextDeadline(state), null);
  });

  it('is not applied to an estimation round', () => {
    const item = media({
      kind: 'estimation',
      answers: [field({ key: 'estimate', label: 'Combien ?', value: '42', points: 10 })],
      payload: { question: 'Combien ?' }
    });
    const { state, ids } = playing(['Ana', 'Bo'], {}, item);
    const ana = ids[0] ?? '';

    // No buzzing, and the number still lands: an estimation is a commitment
    // everybody makes, not a floor one person holds.
    assert.equal(answer(state, ana, 'estimate', '40', 1_500).ok, true);
    assert.equal(toRoundView(state, ana, CONTEXT)?.buzz, undefined);
  });

  it('tells each phone whether it is the one that may answer', () => {
    const { state, ids } = playing(['Ana', 'Bo']);
    const [ana, bo] = ids as [string, string];

    pressAndSettle(state, ana, 1_500);

    const hers = toRoundView(state, ana, CONTEXT)?.buzz;
    const his = toRoundView(state, bo, CONTEXT)?.buzz;

    assert.equal(hers?.holderId, ana);
    assert.equal(hers?.holderName, 'Ana');
    assert.equal(hers?.spent, false);
    assert.equal(his?.holderId, ana, 'the room can see who took it');
    assert.equal(his?.spent, false);
  });
});
