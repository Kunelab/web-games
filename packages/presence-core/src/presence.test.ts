import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  HEARTBEAT_MS,
  castKickBallot,
  createPresence,
  isPaused,
  markAway,
  markPresent,
  openKickVote,
  presenceView,
  recovering,
  resetPresence,
  tickPresence,
  type PresenceState
} from './presence.js';

/**
 * Virtual time throughout: every function here takes `now`, so a two-minute
 * absence costs a test nothing and the numbers in the rules are the numbers
 * under test.
 */
const RULES = {
  graceMs: HEARTBEAT_MS * 5,
  maxPauseMs: 150_000,
  kickAfterMs: 30_000,
  voteMs: 45_000,
  resumeCountdownMs: 4_000
};

const TABLE = ['a', 'b', 'c', 'd'];

function table(): PresenceState {
  return createPresence(RULES);
}

describe('presence', () => {
  it('shows a micro-lag without stopping anybody', () => {
    const presence = table();
    markAway(presence, 'b', 1_000);
    const midWindow = 1_000 + RULES.graceMs / 2;

    // Inside the resync window: the game runs on, and the room is told that one
    // seat is wobbling rather than being handed an overlay.
    assert.equal(tickPresence(presence, TABLE, midWindow).paused, false);
    assert.deepEqual(recovering(presence, TABLE, midWindow), ['b']);

    const view = presenceView(presence, TABLE, midWindow, 'a');
    assert.equal(view.paused, false);
    assert.deepEqual(view.waitingFor, []);
    assert.deepEqual(
      view.recovering.map((seat) => seat.seatId),
      ['b']
    );
    // And no kick is on offer for a seat nobody is even waiting on.
    assert.deepEqual(view.kickableSeatIds, []);

    // The overwhelmingly common ending: it comes back, and nothing happened.
    markPresent(presence, 'b');
    assert.deepEqual(recovering(presence, TABLE, midWindow + 1), []);
    assert.equal(isPaused(presence), false);
  });

  it('stops being patient once the resync window is spent', () => {
    const presence = table();
    markAway(presence, 'b', 1_000);

    // A phone that misses a couple of beats must not stop four other people.
    const early = tickPresence(presence, TABLE, 1_000 + RULES.graceMs - 1);
    assert.equal(early.paused, false);
    assert.equal(isPaused(presence), false);

    const late = tickPresence(presence, TABLE, 1_000 + RULES.graceMs);
    assert.equal(late.paused, true);
    assert.equal(isPaused(presence), true);
    // A seat the room is now waiting for has stopped merely recovering.
    assert.deepEqual(recovering(presence, TABLE, 1_000 + RULES.graceMs), []);
  });

  it('counts one absence across a flapping connection', () => {
    const presence = table();
    markAway(presence, 'b', 1_000);
    // A socket that retries and drops again reports away twice; the clock on the
    // absence must not restart, or the kick delay would never elapse for exactly
    // the player it exists to handle.
    assert.equal(markAway(presence, 'b', 20_000), false);
    assert.equal(presence.awaySince.b, 1_000);
  });

  it('runs a resume countdown, and every screen sees the same instant', () => {
    const presence = table();
    markAway(presence, 'b', 0);
    tickPresence(presence, TABLE, RULES.graceMs);

    markPresent(presence, 'b');
    const returning = tickPresence(presence, TABLE, 10_000);
    // Still paused, but ending: nothing may act during the countdown.
    assert.equal(returning.resumed, false);
    assert.equal(isPaused(presence), true);
    assert.equal(presence.pause?.resumesAt, 10_000 + RULES.resumeCountdownMs);

    const midway = tickPresence(presence, TABLE, 10_000 + RULES.resumeCountdownMs - 1);
    assert.equal(midway.resumed, false);

    const done = tickPresence(presence, TABLE, 10_000 + RULES.resumeCountdownMs);
    assert.equal(done.resumed, true);
    assert.equal(isPaused(presence), false);
    // The stopped time is banked, so an idle sweep can tell waiting from
    // silence. Measured from when the clock actually stopped — the grace period
    // was still play — so it is the resume instant minus that, not minus zero.
    assert.equal(presence.pausedMs, 10_000 + RULES.resumeCountdownMs - RULES.graceMs);
  });

  it('cancels the countdown when somebody drops again mid-resume', () => {
    const presence = table();
    markAway(presence, 'b', 0);
    tickPresence(presence, TABLE, RULES.graceMs);
    markPresent(presence, 'b');
    tickPresence(presence, TABLE, 10_000);
    assert.notEqual(presence.pause?.resumesAt, null);

    markAway(presence, 'c', 10_500);
    const again = tickPresence(presence, TABLE, 10_500 + RULES.graceMs);
    assert.equal(again.resumed, false);
    assert.equal(presence.pause?.resumesAt, null);
    assert.equal(isPaused(presence), true);
  });

  it('gives up on the absent and resumes once the pause is spent', () => {
    const presence = table();
    markAway(presence, 'b', 0);
    tickPresence(presence, TABLE, RULES.graceMs);

    const held = tickPresence(presence, TABLE, RULES.graceMs + RULES.maxPauseMs - 1);
    assert.equal(held.resumed, false);

    const spent = tickPresence(presence, TABLE, RULES.graceMs + RULES.maxPauseMs);
    assert.equal(spent.resumed, true);
    assert.deepEqual(spent.abandoned, ['b']);
    assert.equal(isPaused(presence), false);
  });

  it('refuses a kick until the absence has lasted', () => {
    const presence = table();
    markAway(presence, 'b', 0);
    tickPresence(presence, TABLE, RULES.graceMs);

    const tooSoon = openKickVote(presence, 'a', 'b', TABLE, RULES.kickAfterMs - 1);
    assert.deepEqual(tooSoon, { ok: false, reason: 'too-soon' });
    assert.equal(presence.vote, null);

    const allowed = openKickVote(presence, 'a', 'b', TABLE, RULES.kickAfterMs);
    assert.deepEqual(allowed, { ok: true });
  });

  it('refuses to kick the present, oneself, and a second time over', () => {
    const presence = table();
    assert.deepEqual(openKickVote(presence, 'a', 'b', TABLE, 60_000), {
      ok: false,
      reason: 'target-present'
    });
    assert.deepEqual(openKickVote(presence, 'a', 'a', TABLE, 60_000), { ok: false, reason: 'self' });
    assert.deepEqual(openKickVote(presence, 'zz', 'b', TABLE, 60_000), { ok: false, reason: 'not-seated' });

    markAway(presence, 'b', 0);
    openKickVote(presence, 'a', 'b', TABLE, 60_000);
    assert.deepEqual(openKickVote(presence, 'c', 'b', TABLE, 60_000), { ok: false, reason: 'already-open' });
  });

  it('carries a kick on a majority of everyone entitled to vote', () => {
    const presence = table();
    markAway(presence, 'b', 0);
    // Electorate is a, c, d: the accused does not vote. Two yeses carry it.
    openKickVote(presence, 'a', 'b', TABLE, 60_000);
    assert.equal(tickPresence(presence, TABLE, 60_001).kicked, null);

    castKickBallot(presence, 'c', true, TABLE);
    const carried = tickPresence(presence, TABLE, 60_002);
    assert.equal(carried.kicked, 'b');
    assert.deepEqual(presence.kicked, ['b']);
    // And the room stops waiting for a seat it has removed.
    assert.equal(presence.awaySince.b, undefined);
  });

  it('lets silence protect the accused', () => {
    const presence = table();
    markAway(presence, 'b', 0);
    openKickVote(presence, 'a', 'b', TABLE, 60_000);
    // One yes out of three entitled voters, and nobody else answers.
    const lapsed = tickPresence(presence, TABLE, 60_000 + RULES.voteMs);
    assert.equal(lapsed.voteClosed, true);
    assert.equal(lapsed.kicked, null);
    assert.deepEqual(presence.kicked, []);
  });

  it('closes early once the yeses cannot reach a majority', () => {
    const presence = table();
    markAway(presence, 'b', 0);
    openKickVote(presence, 'a', 'b', TABLE, 60_000);
    castKickBallot(presence, 'c', false, TABLE);
    castKickBallot(presence, 'd', false, TABLE);

    // Two refusals out of three: the vote is over without waiting out the clock.
    const closed = tickPresence(presence, TABLE, 60_001);
    assert.equal(closed.voteClosed, true);
    assert.equal(closed.kicked, null);
  });

  it('never pauses for a seat it kicked in the same tick', () => {
    const presence = table();
    markAway(presence, 'b', 0);
    openKickVote(presence, 'a', 'b', TABLE, 60_000);
    castKickBallot(presence, 'c', true, TABLE);

    const resolved = tickPresence(presence, TABLE, 60_001);
    assert.equal(resolved.kicked, 'b');
    assert.equal(resolved.paused, false);
    assert.equal(isPaused(presence), false);
  });

  it('waits only for the roster it is given', () => {
    const presence = table();
    // A dead player closing their laptop must not freeze the town.
    markAway(presence, 'd', 0);
    const living = ['a', 'b', 'c'];
    assert.equal(tickPresence(presence, living, RULES.graceMs).paused, false);
    assert.equal(tickPresence(presence, TABLE, RULES.graceMs).paused, true);
  });

  it('projects counts and not ballots', () => {
    const presence = table();
    markAway(presence, 'b', 0);
    tickPresence(presence, TABLE, RULES.graceMs);
    openKickVote(presence, 'a', 'b', TABLE, 60_000);
    castKickBallot(presence, 'c', false, TABLE);

    const view = presenceView(presence, TABLE, 60_000, 'c');
    assert.equal(view.vote?.yes, 1);
    assert.equal(view.vote?.no, 1);
    // Three entitled voters, so two yeses carry it: one more is needed.
    assert.equal(view.vote?.needed, 1);
    assert.equal(view.vote?.mine, false);
    assert.equal(view.paused, true);
    assert.deepEqual(
      view.waitingFor.map((seat) => seat.seatId),
      ['b']
    );
    // Nothing in the projection says who voted which way.
    assert.equal(JSON.stringify(view).includes('ballots'), false);
  });

  it('offers no kick button while a vote is already running', () => {
    const presence = table();
    markAway(presence, 'b', 0);
    const before = presenceView(presence, TABLE, 60_000, 'a');
    assert.deepEqual(before.kickableSeatIds, ['b']);

    openKickVote(presence, 'a', 'b', TABLE, 60_000);
    assert.deepEqual(presenceView(presence, TABLE, 60_000, 'a').kickableSeatIds, []);
  });

  it('forgets a restart it cannot measure, and remembers who was removed', () => {
    const presence = table();
    markAway(presence, 'b', 0);
    tickPresence(presence, TABLE, RULES.graceMs);
    presence.kicked.push('d');

    resetPresence(presence);

    // Every socket in the world is gone, so the old absence says nothing — and a
    // pause with nobody left to end it would freeze the game forever.
    assert.deepEqual(presence.awaySince, {});
    assert.equal(presence.pause, null);
    assert.deepEqual(presence.kicked, ['d']);
  });
});
