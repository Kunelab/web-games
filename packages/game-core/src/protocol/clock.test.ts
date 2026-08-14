import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CLAIM_TOLERANCE_MS,
  MAX_COMPENSATION_MS,
  clampAnswerTime,
  clientClockNow,
  estimateClock,
  maxCompensationMs,
  phaseProgress,
  toServerTime
} from './clock.js';

describe('estimateClock', () => {
  it('recovers a known offset from a clean sample', () => {
    // Client is 5000ms behind; round trip is 100ms, so the reply left the server
    // 50ms before the client received it.
    const estimate = estimateClock([{ clientSent: 1000, serverTime: 6050, clientReceived: 1100 }]);
    assert.equal(estimate.offsetMs, 5000);
    assert.equal(estimate.rttMs, 100);
  });

  it('prefers the lowest round trip rather than averaging', () => {
    // One badly delayed sample must not drag the estimate.
    const estimate = estimateClock([
      { clientSent: 0, serverTime: 5400, clientReceived: 800 }, // rtt 800, spiked
      { clientSent: 1000, serverTime: 6020, clientReceived: 1040 }, // rtt 40, clean
      { clientSent: 2000, serverTime: 7300, clientReceived: 2600 } // rtt 600, spiked
    ]);
    assert.equal(estimate.rttMs, 40);
    assert.equal(estimate.offsetMs, 5000);
    assert.equal(estimate.samples, 3);
  });

  it('ignores a sample whose round trip is negative', () => {
    const estimate = estimateClock([
      { clientSent: 5000, serverTime: 100, clientReceived: 1000 },
      { clientSent: 1000, serverTime: 6020, clientReceived: 1040 }
    ]);
    assert.equal(estimate.offsetMs, 5000);
  });

  it('falls back to no offset with no usable samples', () => {
    assert.deepEqual(estimateClock([]), { offsetMs: 0, rttMs: 0, samples: 0 });
  });

  it('round-trips through toServerTime', () => {
    const estimate = estimateClock([{ clientSent: 1000, serverTime: 6050, clientReceived: 1100 }]);
    assert.equal(toServerTime(estimate, 2000), 7000);
  });

  it('absorbs a client clock that is wrong by hours', () => {
    // The same clean 100ms round trip, measured on a phone whose clock is three
    // hours out. The offset takes up the whole error, so the converted time is
    // identical: a wrong clock needs no special handling, only a measured offset.
    const wrong = 3 * 3_600_000;
    const estimate = estimateClock([{ clientSent: 1000 - wrong, serverTime: 6050, clientReceived: 1100 - wrong }]);
    assert.equal(toServerTime(estimate, 2000 - wrong), 7000);
  });

  it('yields whole milliseconds from a fractional client clock', () => {
    // `clientClockNow` is sub-millisecond; the protocol is not.
    const estimate = estimateClock([{ clientSent: 1000, serverTime: 6050, clientReceived: 1100 }]);
    assert.equal(toServerTime(estimate, 2000.4), 7000);
  });
});

describe('clientClockNow', () => {
  it('never goes backwards', () => {
    assert.ok(clientClockNow() >= 0);
    assert.ok(clientClockNow() <= clientClockNow());
  });

  it('is not the wall clock, which is what makes it safe', () => {
    // Counts from process or page start, so it is nowhere near an epoch timestamp.
    // That gap is the guarantee: no setting of the wall clock can move it.
    assert.ok(clientClockNow() < Date.now() / 2);
  });
});

describe('maxCompensationMs', () => {
  it('scales with the measured round trip', () => {
    assert.equal(maxCompensationMs(40), 270);
    assert.equal(maxCompensationMs(600), 550);
  });

  it('is capped so no link buys unlimited credit', () => {
    assert.equal(maxCompensationMs(60_000), MAX_COMPENSATION_MS);
  });

  it('handles a nonsensical negative round trip', () => {
    assert.equal(maxCompensationMs(-100), 250);
  });
});

describe('clampAnswerTime', () => {
  const START = 1_000_000;
  const ANSWER_MS = 30_000;
  // A player on a 300ms round trip: 400ms of credible compensation.
  const COMP = maxCompensationMs(300);

  it('trusts an honest claim, crediting the player for their latency', () => {
    // Pressed at +5000, arrived at +5300, within the credible window.
    const result = clampAnswerTime(START + 5_000, START, START + 5_300, ANSWER_MS, COMP);
    assert.equal(result.answeredAt, START + 5_000);
    assert.equal(result.adjusted, false);
  });

  it('is what lets a laggy player beat a local one', () => {
    // The point of the whole mechanism: arrival order says local won, but the
    // players actually pressed in the other order, and that is what scores.
    const laggy = clampAnswerTime(START + 1_000, START, START + 1_300, ANSWER_MS, maxCompensationMs(600));
    const local = clampAnswerTime(START + 1_200, START, START + 1_220, ANSWER_MS, maxCompensationMs(40));
    assert.ok(laggy.answeredAt < local.answeredAt);
    assert.equal(laggy.adjusted, false);
    assert.equal(local.adjusted, false);
  });

  it('refuses a claim from before the round opened', () => {
    const result = clampAnswerTime(START - 10_000, START, START + 500, ANSWER_MS, COMP);
    assert.equal(result.adjusted, true);
    assert.ok(result.answeredAt >= START, 'never credited before the round opened');
    // Pulled up to arrival minus the credible compensation, not merely to the
    // round start, which would have handed the claim a free ten seconds.
    assert.equal(result.answeredAt, START + 500 - COMP);
  });

  it('will not credit more latency than the player demonstrably has', () => {
    // A patched client claiming the first millisecond of the round, 20s late.
    // Without this bound it would win every field in the game.
    const result = clampAnswerTime(START + 1, START, START + 20_000, ANSWER_MS, COMP);
    assert.equal(result.answeredAt, START + 20_000 - COMP);
    assert.equal(result.adjusted, true);
  });

  it('gives a cheater no advantage over an honest player on the same link', () => {
    const honest = clampAnswerTime(START + 9_800, START, START + 10_000, ANSWER_MS, COMP);
    const cheater = clampAnswerTime(START, START, START + 10_000, ANSWER_MS, COMP);
    // The cheater gains at most the compensation window, not ten seconds.
    assert.ok(honest.answeredAt - cheater.answeredAt <= COMP);
  });

  it('caps a claim shortly after arrival', () => {
    const result = clampAnswerTime(START + 9_000, START, START + 500, ANSWER_MS, COMP);
    assert.equal(result.answeredAt, START + 500 + CLAIM_TOLERANCE_MS);
    assert.equal(result.adjusted, true);
  });

  it('never credits an answer past the end of the phase', () => {
    const result = clampAnswerTime(START + 999_999, START, START + 999_999, ANSWER_MS, COMP);
    assert.equal(result.answeredAt, START + ANSWER_MS);
  });

  it('handles a non-numeric claim', () => {
    const result = clampAnswerTime(Number.NaN, START, START + 400, ANSWER_MS, COMP);
    assert.equal(result.answeredAt, START + 400);
    assert.equal(result.adjusted, true);
  });

  it('keeps the window coherent when arrival is long after the phase closed', () => {
    // A very late packet: the window collapses but must not invert.
    const result = clampAnswerTime(START + 1_000, START, START + 90_000, ANSWER_MS, COMP);
    assert.ok(result.answeredAt >= START);
    assert.ok(Number.isFinite(result.answeredAt));
  });
});

describe('phaseProgress', () => {
  it('runs from 0 to 1 across the phase', () => {
    assert.equal(phaseProgress(1000, 10_000, 1000), 0);
    assert.equal(phaseProgress(1000, 10_000, 6000), 0.5);
    assert.equal(phaseProgress(1000, 10_000, 11_000), 1);
  });

  it('clamps outside the phase', () => {
    assert.equal(phaseProgress(1000, 10_000, 0), 0);
    assert.equal(phaseProgress(1000, 10_000, 999_999), 1);
  });

  it('treats a zero-length phase as finished', () => {
    assert.equal(phaseProgress(1000, 0, 1000), 1);
  });
});
