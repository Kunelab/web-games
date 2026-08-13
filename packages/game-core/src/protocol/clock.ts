/**
 * Clock synchronisation, so a round is judged on when players actually pressed
 * rather than on when their packets happened to arrive.
 *
 * Without this, a blind test rewards the lowest latency: the server timestamps on
 * arrival, so a player on hotel wifi loses to one on ethernet even having pressed
 * first. The fix is the same NTP does. Each client measures its offset from the
 * server, then reports answers in server time; the server trusts that only within
 * a window it can verify.
 */

/**
 * The client's own clock, for everything that has to be measured locally.
 *
 * Monotonic on purpose. `performance.now()` counts from page load and is unaffected
 * by the wall clock being set, which `Date.now()` is not: a player who corrects
 * their phone's time mid-round, or whose phone quietly receives an NTP correction
 * or a daylight-saving change, would otherwise invalidate the offset measured at
 * the start of the game and have every answer of theirs clamped back to arrival.
 * Nothing here needs to know what time the phone thinks it is, only how much time
 * has passed, which is the one thing a monotonic clock guarantees.
 *
 * A clock that is simply wrong, by an hour or by a year, needs no special handling
 * at all: the offset absorbs it, because the offset is the only thing that ever
 * converts between the two clocks.
 */
export function clientClockNow(): number {
  return performance.now();
}

export interface ClockSample {
  /** Client clock when the ping was sent, from `clientClockNow`. */
  clientSent: number;
  /** Server clock when the ping was handled. */
  serverTime: number;
  /** Client clock when the reply came back, from `clientClockNow`. */
  clientReceived: number;
}

export interface ClockEstimate {
  /** Add to a client timestamp to get server time. */
  offsetMs: number;
  /** Round trip of the sample this estimate came from. */
  rttMs: number;
  /** How many samples were considered. */
  samples: number;
}

/** Enough to find a good sample without delaying the lobby. */
export const CLOCK_SAMPLE_COUNT = 5;

/**
 * How often a client re-measures its offset during a game.
 *
 * Quartz drift over a party game is a millisecond or two, so this is not about
 * drift. It is about the first estimate having been taken during a bad moment on
 * the network, and about the monotonic clock itself: some phones stop advancing it
 * while the device is asleep, so a screen that has been off wakes up with an offset
 * that is wrong by however long the nap lasted. Re-measuring costs five small
 * packets and repairs both.
 */
export const CLOCK_RESYNC_INTERVAL_MS = 30_000;

/**
 * Best offset from a set of samples.
 *
 * Takes the single lowest-RTT sample rather than averaging. Averaging is worse
 * here: latency spikes are one-sided, so a delayed packet drags the mean while
 * the fastest round trip is the least contaminated estimate available.
 */
export function estimateClock(samples: ClockSample[]): ClockEstimate {
  if (samples.length === 0) {
    return { offsetMs: 0, rttMs: 0, samples: 0 };
  }

  let best: ClockSample | undefined;
  let bestRtt = Number.POSITIVE_INFINITY;

  for (const sample of samples) {
    const rtt = sample.clientReceived - sample.clientSent;
    // A negative round trip means the clock was adjusted mid-flight.
    if (rtt >= 0 && rtt < bestRtt) {
      bestRtt = rtt;
      best = sample;
    }
  }

  if (!best) {
    return { offsetMs: 0, rttMs: 0, samples: samples.length };
  }

  // Assume the reply took half the round trip, so the server's clock at the
  // moment we received it was serverTime + rtt/2.
  const offsetMs = Math.round(best.serverTime + bestRtt / 2 - best.clientReceived);

  return { offsetMs, rttMs: bestRtt, samples: samples.length };
}

/**
 * Client-side: current time expressed on the server's clock.
 *
 * The default argument is the whole point of `clientClockNow`: every countdown,
 * every reveal animation and every claimed answer time on the client runs through
 * here, so basing this on the monotonic clock is what makes all of them immune to
 * the phone's wall clock moving.
 */
export function toServerTime(estimate: ClockEstimate, clientNow: number = clientClockNow()): number {
  return Math.round(clientNow + estimate.offsetMs);
}

/**
 * How far ahead of its arrival a claimed timestamp may be, in ms.
 *
 * A claim can legitimately precede arrival by up to the one-way latency; this
 * allows generously for that while still bounding how much a client could gain by
 * lying. It only ever moves an answer earlier within the round, never outside it.
 */
export const CLAIM_TOLERANCE_MS = 2_000;

/** Ceiling on the credit any one player can be given back, however bad their link. */
export const MAX_COMPENSATION_MS = 5_000;

/**
 * How far before arrival a player may credibly claim to have answered.
 *
 * Derived from their measured round trip rather than being a flat constant,
 * because that is exactly the quantity being compensated for. A player on a 40ms
 * link can claim ~270ms of credit; one on a 600ms link can claim ~550ms. Anything
 * beyond that is not latency, it is a client lying.
 */
export function maxCompensationMs(rttMs: number): number {
  const oneWay = Math.max(0, rttMs) / 2;
  // The margin absorbs jitter and the time between the keypress and the emit.
  return Math.min(oneWay + 250, MAX_COMPENSATION_MS);
}

export interface ClampResult {
  answeredAt: number;
  /** True when the claim was outside the credible window and was corrected. */
  adjusted: boolean;
}

/**
 * Turns a client's claimed answer time into one the server is willing to score.
 *
 * The window is bounded at both ends, and the lower bound is the one that matters
 * for fairness. Trusting any claim at or after the round start would hand the game
 * to whoever patches their client to always claim the first millisecond; bounding
 * the claim to `receivedAt - maxCompensation` means a player can only ever be
 * credited for latency they demonstrably have.
 *
 * The upper bound stops a claim landing after the phase closed.
 */
export function clampAnswerTime(
  claimedAt: number,
  roundStartAt: number,
  receivedAt: number,
  answerMs: number,
  compensationMs = MAX_COMPENSATION_MS
): ClampResult {
  // The phase end is a hard ceiling on both bounds. Without capping `earliest`
  // too, a packet arriving long after the phase closed would drag the lower bound
  // past it and get credited with a time outside the round entirely.
  const phaseEnd = roundStartAt + answerMs;
  const earliest = Math.min(Math.max(roundStartAt, receivedAt - compensationMs), phaseEnd);
  const latest = Math.max(earliest, Math.min(receivedAt + CLAIM_TOLERANCE_MS, phaseEnd));

  if (!Number.isFinite(claimedAt)) {
    return { answeredAt: Math.min(receivedAt, latest), adjusted: true };
  }

  if (claimedAt < earliest) {
    return { answeredAt: earliest, adjusted: true };
  }

  if (claimedAt > latest) {
    return { answeredAt: latest, adjusted: true };
  }

  return { answeredAt: claimedAt, adjusted: false };
}

/**
 * Progress through a phase, 0 to 1, from a synchronised clock.
 *
 * This is what keeps a reveal identical on every screen: the server sends only
 * the start time, and each client derives the frame it should be showing. Nothing
 * about the animation is transmitted.
 */
export function phaseProgress(startAt: number, durationMs: number, serverNow: number): number {
  if (durationMs <= 0) return 1;
  const elapsed = serverNow - startAt;
  if (elapsed <= 0) return 0;
  if (elapsed >= durationMs) return 1;
  return elapsed / durationMs;
}
