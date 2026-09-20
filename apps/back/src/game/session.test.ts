import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { answerFieldSchema, sessionConfigSchema, type AnswerField, type SessionConfig } from 'game-core';

import type { MediaView } from '../services/media-service.js';
import {
  ABANDONED_ROOM_MS,
  BUZZ_ARBITRATION_MS,
  abandonIfEmpty,
  advance,
  buzz,
  correctAnswers,
  correctPayloadNumbers,
  libraryCodeOf,
  holdRound,
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
    // Copied, not shared. `FIELDS` is module state and a round holds its answers
    // by reference, so a case that corrects one would otherwise correct every
    // round built after it.
    answers: FIELDS.map((field) => ({ ...field })),
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

/**
 * The room that walked out.
 *
 * The rule exists because of what an abandoned game *does* rather than because of
 * what it holds: an auto-advancing blind test plays on to nobody, and in the
 * endless mode every one of those rounds draws another song and sends another
 * batch of titles to a model. So these cases are mostly about the two ways a
 * session can look empty without being abandoned, either of which would end a
 * game somebody was still playing.
 */
describe('a game the room left', () => {
  /** Everybody's phone goes. `advance` seats the round at t=1000. */
  function emptied(names = ['Ana', 'Bo'], overrides: Partial<SessionConfig> = {}) {
    const { state, ids } = playing(names, overrides);
    for (const id of ids) {
      const player = state.players[id];
      assert.ok(player);
      player.connected = false;
    }
    return { state, ids };
  }

  it('keeps playing while one seat is still on the line', () => {
    const { state, ids } = emptied();
    const stillHere = state.players[ids[0] ?? ''];
    assert.ok(stillHere);
    stillHere.connected = true;

    assert.equal(abandonIfEmpty(state, 1_000 + ABANDONED_ROOM_MS * 10), false);
    assert.equal(state.phase, 'playing');
  });

  it('keeps playing for the whole of the grace', () => {
    const { state } = emptied();

    // The clock starts the first time anybody looks, not when the phones went.
    assert.equal(abandonIfEmpty(state, 2_000), false);
    assert.equal(state.emptySince, 2_000);

    assert.equal(abandonIfEmpty(state, 2_000 + ABANDONED_ROOM_MS - 1), false);
    assert.equal(state.phase, 'playing');
  });

  it('ends the game once the grace has run out', () => {
    const { state } = emptied();
    abandonIfEmpty(state, 2_000);

    assert.equal(abandonIfEmpty(state, 2_000 + ABANDONED_ROOM_MS), true);
    assert.equal(state.phase, 'finished');
    assert.equal(state.round, null);
  });

  it('and does not end it twice', () => {
    const { state } = emptied();
    abandonIfEmpty(state, 2_000);
    abandonIfEmpty(state, 2_000 + ABANDONED_ROOM_MS);

    assert.equal(abandonIfEmpty(state, 2_000 + ABANDONED_ROOM_MS * 2), false);
  });

  it('starts the clock again when a phone comes back', () => {
    const { state, ids } = emptied();
    abandonIfEmpty(state, 2_000);

    const returning = state.players[ids[0] ?? ''];
    assert.ok(returning);
    returning.connected = true;
    assert.equal(abandonIfEmpty(state, 3_000), false);
    assert.equal(state.emptySince, null, 'a seat on the line clears the clock');

    // And going again re-dates the absence rather than resuming the old one.
    returning.connected = false;
    assert.equal(abandonIfEmpty(state, 4_000), false);
    assert.equal(state.emptySince, 4_000);
    assert.equal(abandonIfEmpty(state, 4_000 + ABANDONED_ROOM_MS - 1), false);
  });

  /**
   * The case that would break the oral format outright: answers are spoken, so no
   * phone ever joins, and a session with no seats at all is the normal way to play
   * the whole evening rather than a room that left.
   */
  it('never ends a game nobody ever sat down in', () => {
    const { state } = playing([]);
    assert.equal(Object.keys(state.players).length, 0);

    assert.equal(abandonIfEmpty(state, 1_000 + ABANDONED_ROOM_MS * 10), false);
    assert.equal(state.phase, 'playing');
    assert.equal(state.emptySince, null);
  });

  it('leaves a finished game alone', () => {
    const { state } = emptied();
    state.phase = 'finished';

    assert.equal(abandonIfEmpty(state, 1_000 + ABANDONED_ROOM_MS * 10), false);
  });
});

/**
 * The clock off the room.
 *
 * A pause cannot just blank the deadline, because everything this engine times
 * is a difference against `phaseStartAt`: a round held for two minutes and
 * released would come back with its whole answering window already spent, and
 * every answer after it clamped to the same instant — which is the ordering the
 * scoring is built on. So the start moves with the pause, and these cases are
 * mostly about proving that it does.
 */
describe('holding a round', () => {
  it('stops the clock and says so', () => {
    const { state } = playing(['Ana'], { buzzer: false });
    const round = state.round;
    assert.ok(round);
    const endsAt = round.phaseEndsAt;
    assert.ok(endsAt !== null);

    assert.equal(holdRound(state, true, 5_000), true);
    assert.equal(round.phaseEndsAt, null, 'no deadline while held');
    assert.equal(round.heldMs, endsAt - 5_000, 'what was left of it is kept');
    assert.equal(toRoundView(state, null, CONTEXT)?.held, true);
  });

  it('refuses an answer while it is held', () => {
    const { state, ids } = playing(['Ana'], { buzzer: false });
    holdRound(state, true, 5_000);

    const result = answer(state, ids[0] ?? '', 'title', 'Dune', 6_000);
    assert.equal(result.ok, false);
    assert.equal(state.round?.submissions.length, 0);
  });

  it('gives back the phase it took, not a new one', () => {
    const { state } = playing(['Ana'], { buzzer: false });
    const round = state.round;
    assert.ok(round);
    const startedAt = round.phaseStartAt;
    const endsAt = round.phaseEndsAt;
    assert.ok(endsAt !== null);

    // Held five seconds in, released a minute later.
    holdRound(state, true, 6_000);
    assert.equal(holdRound(state, false, 66_000), true);

    assert.equal(round.phaseStartAt, startedAt + 60_000, 'the start moved with the pause');
    assert.equal(round.phaseEndsAt, 66_000 + (endsAt - 6_000), 'and what was left is what is left');
    assert.equal(round.heldAt, null);
    assert.equal(toRoundView(state, null, CONTEXT)?.held, false);
  });

  /**
   * The point of moving the start: an answer given a second after the room comes
   * back is judged as a second in, not as a minute and a second in.
   */
  it('so an answer after it is timed from where the phase really is', () => {
    const { state, ids } = playing(['Ana'], { buzzer: false });
    holdRound(state, true, 6_000);
    holdRound(state, false, 66_000);

    const result = answer(state, ids[0] ?? '', 'title', 'Dune', 67_000);
    assert.equal(result.ok, true);

    const submission = state.round?.submissions[0];
    assert.ok(submission);
    const into = submission.answeredAt - (state.round?.phaseStartAt ?? 0);
    assert.ok(into >= 0 && into <= 7_000, `answered ${into}ms into the phase`);
  });

  it('arms no deadline at all while held', () => {
    const { state, ids } = playing(['Ana', 'Bo']);
    pressAndSettle(state, ids[0] ?? '', 1_500);
    assert.ok(nextDeadline(state), 'the buzzer window is a deadline');

    holdRound(state, true, 2_000);
    assert.equal(nextDeadline(state), null, 'the buzzer’s deadlines stop too');
  });

  it('does not hold twice, or release what was never held', () => {
    const { state } = playing(['Ana'], { buzzer: false });
    assert.equal(holdRound(state, false, 1_000), false);
    assert.equal(holdRound(state, true, 2_000), true);
    assert.equal(holdRound(state, true, 3_000), false);
  });
});

/**
 * Correcting what the answer is, mid-game.
 *
 * Deliberately does not re-score: the points are on the board and the players
 * have read them. What changes is the answer on screen and the copy the shared
 * catalogue keeps.
 */
describe('correcting a round', () => {
  it('changes the value the room is looking at', () => {
    const { state } = playing(['Ana'], { buzzer: false });
    assert.equal(correctAnswers(state, [{ key: 'title', value: 'Dune (1984)' }]), true);
    assert.equal(state.round?.answers.find((field) => field.key === 'title')?.value, 'Dune (1984)');
  });

  it('ignores a field this round does not have', () => {
    const { state } = playing(['Ana'], { buzzer: false });
    assert.equal(correctAnswers(state, [{ key: 'invented', value: 'x' }]), false);
    assert.equal(state.round?.answers.length, 2, 'and does not grow the round');
  });

  it('ignores a blank, so a cleared box is not a correction', () => {
    const { state } = playing(['Ana'], { buzzer: false });
    assert.equal(correctAnswers(state, [{ key: 'title', value: '   ' }]), false);
    assert.equal(state.round?.answers.find((field) => field.key === 'title')?.value, 'Dune');
  });

  /**
   * The other half of a correction: not what the answer is, but what counts as it.
   *
   * Tested through a real submission rather than by reading the field back,
   * because "the alias is stored" is not the claim. The claim is that a player
   * who types the other name of the thing, after the room has agreed it is the
   * other name of the thing, is marked right — in the round that is still open.
   */
  it('accepts a spelling added mid-round, at once', () => {
    const { state, ids } = playing(['Ana'], { buzzer: false });

    const before = answer(state, ids[0] ?? '', 'title', 'Duna', 1_200);
    assert.equal(before.correct, false, 'not a name of the film yet');

    assert.equal(correctAnswers(state, [{ key: 'title', value: 'Dune', aliases: ['Duna', 'Dune 1984'] }]), true);

    const after = answer(state, ids[0] ?? '', 'title', 'Duna', 1_300);
    assert.equal(after.correct, true);
  });

  it('leaves the spellings alone when none are sent, and clears them when an empty list is', () => {
    const item = media({ answers: [field({ key: 'title', value: 'Dune', aliases: ['Duna'], points: 10 })] });
    const { state } = playing(['Ana'], { buzzer: false }, item);

    correctAnswers(state, [{ key: 'title', value: 'Dune (1984)' }]);
    assert.deepEqual(state.round?.answers[0]?.aliases, ['Duna'], 'an omitted list is not an empty one');

    assert.equal(correctAnswers(state, [{ key: 'title', value: '', aliases: [] }]), true);
    assert.deepEqual(state.round?.answers[0]?.aliases, [], 'and an empty one is a real edit');
  });

  it('keeps one copy of each spelling, however many times it is typed', () => {
    const { state } = playing(['Ana'], { buzzer: false });
    correctAnswers(state, [{ key: 'title', value: 'Dune', aliases: ['  Duna  ', 'Duna', '', 'Dune 1984'] }]);
    assert.deepEqual(state.round?.answers.find((entry) => entry.key === 'title')?.aliases, ['Duna', 'Dune 1984']);
  });

  /** The clip window goes through the kind's own schema, so bad values bounce. */
  it('refuses a clip the kind would not accept', () => {
    const item = media({
      kind: 'blindtest',
      payload: { code: 'abcdefghijk', startGuess: 0, endGuess: 20, startReveal: 20, endReveal: 40, volume: 100 }
    });
    const { state } = playing(['Ana'], { buzzer: false }, item);

    assert.equal(correctPayloadNumbers(state, { startGuess: -5 }), false, 'negative is not a second');
    assert.equal(correctPayloadNumbers(state, { startGuess: 12 }), true);
    assert.equal((state.round?.payload as { startGuess: number }).startGuess, 12);
  });

  /** The difficulty rides in the same payload, and is held to the same bounds. */
  it('takes a difficulty inside the scale and refuses one outside it', () => {
    const item = media({
      kind: 'blindtest',
      payload: { code: 'abcdefghijk', startGuess: 0, endGuess: 20, startReveal: 20, endReveal: 40, volume: 100 }
    });
    const { state } = playing(['Ana'], { buzzer: false }, item);

    assert.equal(correctPayloadNumbers(state, { difficulty: 140 }), false, '140 is not a difficulty');
    assert.equal(correctPayloadNumbers(state, { difficulty: 85 }), true);
    assert.equal((state.round?.payload as { difficulty: number }).difficulty, 85);
  });
});

/**
 * Which rounds the room may correct at all.
 *
 * The rule is ownership, not the sign of an id: the shared catalogue is
 * everybody's, and somebody's own library item is not. A replayed round is the
 * case that reads wrong at a glance — a real, positive id, and still the
 * catalogue's.
 */
describe('a round the catalogue owns', () => {
  const payload = { code: 'abcdefghijk', startGuess: 0, endGuess: 20, startReveal: 20, endReveal: 40, volume: 100 };

  it('offers its entry when it was generated for this session', () => {
    const { state } = playing(['Ana'], { buzzer: false }, media({ id: -3, kind: 'blindtest', payload }));
    assert.equal(libraryCodeOf(state.round!), 'abcdefghijk');
  });

  it('offers it for a round replayed out of the catalogue, id and all', () => {
    const { state } = playing(['Ana'], { buzzer: false }, media({ id: 42, kind: 'blindtest', payload }));
    assert.equal(libraryCodeOf(state.round!), 'abcdefghijk');
  });

  it("offers nothing for somebody's own library item", () => {
    const { state } = playing(['Ana'], { buzzer: false }, media({ id: 42, user_id: 7, kind: 'blindtest', payload }));
    assert.equal(libraryCodeOf(state.round!), undefined);
  });

  it('offers nothing once the entry has been thrown away', () => {
    const { state } = playing(['Ana'], { buzzer: false }, media({ id: -3, kind: 'blindtest', payload }));
    state.round!.libraryPurged = true;
    assert.equal(libraryCodeOf(state.round!), undefined);
  });
});
