import {
  CLOCK_RESYNC_INTERVAL_MS,
  CLOCK_SAMPLE_COUNT,
  clientClockNow,
  estimateClock,
  toServerTime,
  type ClockEstimate,
  type ClockPongPayload,
  type ClockSample
} from 'game-core';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The clock discipline every game screen shares.
 *
 * Each of the three sockets — quiz, CoronaZ, Mafia — needs the same thing: an
 * offset from the server's clock, re-measured for as long as the game lasts, so
 * that a countdown, a reveal animation and a timestamped answer all agree across
 * every phone in the room without a single frame being transmitted.
 *
 * It lived three times, copied verbatim into each hook, which is how the three
 * drifted: one cleaned its listeners up on unmount and another only
 * disconnected. Extracted here it is one implementation with one lifetime, and a
 * fourth game gets it by asking.
 */

const NO_CLOCK: ClockEstimate = { offsetMs: 0, rttMs: 0, samples: 0 };

/** The one call this needs from a socket, so it is not tied to any game's events. */
interface ClockPinger {
  connected: boolean;
  timeout(ms: number): { emitWithAck(event: 'clock:ping', payload: { clientSent: number }): Promise<unknown> };
}

export interface ServerClock {
  /** Offset and round trip as last measured. */
  estimate: ClockEstimate;
  /** Current time on the server's clock. Stable identity, so timers survive it. */
  serverNow: () => number;
  /** Measures now: on connect, and whenever a caller knows the offset is suspect. */
  synchronise: (socket: ClockPinger) => void;
}

export function useServerClock(): ServerClock {
  const [estimate, setEstimate] = useState<ClockEstimate>(NO_CLOCK);

  // Mirrored into a ref so `serverNow` stays stable while still seeing the
  // latest estimate; a countdown depending on a changing callback would restart
  // its timer on every measurement.
  const latest = useRef<ClockEstimate>(NO_CLOCK);
  useEffect(() => {
    latest.current = estimate;
  }, [estimate]);

  // One measurement pass at a time: the interval, the visibility listener and a
  // reconnect can all ask for one, and overlapping passes would interleave their
  // pings and measure the queue rather than the network.
  const measuring = useRef(false);

  const synchronise = useCallback((socket: ClockPinger) => {
    if (measuring.current) return;
    measuring.current = true;

    void (async () => {
      const samples: ClockSample[] = [];
      try {
        for (let probe = 0; probe < CLOCK_SAMPLE_COUNT; probe++) {
          // Monotonic, so a phone whose wall clock moves mid-game measures the
          // same round trip as one whose clock sits still.
          const clientSent = clientClockNow();
          try {
            // socket.io's ack typing does not survive `timeout()`, so the shape
            // is asserted once here rather than leaking `any` into the estimate.
            const pong = (await socket.timeout(3000).emitWithAck('clock:ping', { clientSent })) as ClockPongPayload;
            samples.push({
              clientSent: pong.clientSent,
              serverTime: pong.serverTime,
              clientReceived: clientClockNow()
            });
          } catch {
            break;
          }
        }
      } finally {
        measuring.current = false;
      }

      // The freshest estimate wins outright rather than being merged with the
      // last one: the reason to re-measure is that the old offset may no longer
      // describe this phone, and averaging would keep the stale half of it.
      if (samples.length > 0) setEstimate(estimateClock(samples));
    })();
  }, []);

  const serverNow = useCallback(() => toServerTime(latest.current), []);

  return { estimate, serverNow, synchronise };
}

/**
 * Keeps one socket's clock fresh for as long as it is mounted: on an interval,
 * and whenever a phone comes back from a locked screen — the moment most likely
 * to be holding a stale offset, and also the moment the player is about to act.
 */
export function useClockUpkeep(socket: ClockPinger | null, synchronise: (socket: ClockPinger) => void): void {
  useEffect(() => {
    if (!socket) return;

    const resync = setInterval(() => synchronise(socket), CLOCK_RESYNC_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && socket.connected) synchronise(socket);
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(resync);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [socket, synchronise]);
}

/**
 * A countdown that ticks locally but is anchored to server time.
 *
 * Recomputed from the absolute deadline on every tick rather than decremented, so a
 * tab that was backgrounded shows the right number the instant it returns instead of
 * resuming from where it fell asleep.
 */
export function useCountdown(endsAt: number | null, serverNow: () => number): number {
  const [remaining, setRemaining] = useState(() => secondsLeft(endsAt, serverNow));

  useEffect(() => {
    // Subscribing to a clock is exactly the external-system case an effect is for;
    // the first read has to happen here because the deadline changes per phase.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRemaining(secondsLeft(endsAt, serverNow));
    if (endsAt === null) return;

    const timer = setInterval(() => setRemaining(secondsLeft(endsAt, serverNow)), 100);
    return () => clearInterval(timer);
  }, [endsAt, serverNow]);

  return remaining;
}

function secondsLeft(endsAt: number | null, serverNow: () => number): number {
  if (endsAt === null) return 0;
  return Math.max(0, Math.ceil((endsAt - serverNow()) / 1000));
}
