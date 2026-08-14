import {
  CLOCK_RESYNC_INTERVAL_MS,
  CLOCK_SAMPLE_COUNT,
  clientClockNow,
  estimateClock,
  toServerTime,
  type ClientToServerEvents,
  type ClockEstimate,
  type ClockPongPayload,
  type ClockSample,
  type ServerToClientEvents,
  type SessionView
} from 'game-core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

import { apiOrigin } from '../tools/api-url';

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const NO_CLOCK: ClockEstimate = { offsetMs: 0, rttMs: 0, samples: 0 };

export interface GameConnection {
  socket: GameSocket | null;
  connected: boolean;
  session: SessionView | null;
  error: string | null;
  /** Offset and round trip measured against the server clock. */
  clock: ClockEstimate;
  /** Current time on the server's clock, for rendering countdowns. */
  serverNow: () => number;
}

/**
 * Opens the game socket and keeps the clock synchronised.
 *
 * The clock is the point. Every countdown and every reveal animation is derived from
 * a server timestamp plus this offset, so all screens show the same frame without a
 * single animation frame being transmitted, and an answer can be reported in server
 * time rather than being judged on when its packet happened to arrive.
 */
export function useGameSocket(): GameConnection {
  // The socket lives in state, not a ref: consumers need to re-render once it
  // exists, and reading a ref during render is not allowed.
  const [socket, setSocket] = useState<GameSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState<ClockEstimate>(NO_CLOCK);

  // Mirrored into a ref so `serverNow` stays stable while still seeing the latest
  // estimate; a countdown depending on a changing callback would restart its timer.
  const clockRef = useRef<ClockEstimate>(NO_CLOCK);
  useEffect(() => {
    clockRef.current = clock;
  }, [clock]);

  // One measurement pass at a time: the interval, the visibility listener and a
  // reconnect can all ask for one, and overlapping passes would interleave their
  // pings and measure the queue rather than the network.
  const syncing = useRef(false);

  useEffect(() => {
    const current: GameSocket = io(apiOrigin, { transports: ['websocket', 'polling'] });
    // Publishing the socket is the whole purpose of this effect: it is an external
    // resource whose lifetime is the component's, which is what effects are for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSocket(current);

    current.on('connect', () => {
      setConnected(true);
      setError(null);
      void synchronise(current);
    });

    current.on('disconnect', () => setConnected(false));
    current.on('connect_error', () => setError('Connexion au serveur impossible.'));
    current.on('session:state', (view) => setSession(view));
    current.on('session:error', (payload) => setError(payload.message));

    // The server probes latency by asking us to acknowledge; nothing to send back.
    current.on('clock:sync', (_payload, ack) => {
      if (typeof ack === 'function') ack();
    });

    async function synchronise(target: GameSocket) {
      if (syncing.current) return;
      syncing.current = true;

      const samples: ClockSample[] = [];

      try {
        for (let index = 0; index < CLOCK_SAMPLE_COUNT; index++) {
          // Monotonic, so a phone whose wall clock moves mid-game measures the same
          // round trip as one whose clock sits still.
          const clientSent = clientClockNow();
          try {
            // socket.io's ack typing does not survive `timeout()`, so the shape is
            // asserted once here rather than leaking `any` into the estimate.
            const pong = (await target.timeout(3000).emitWithAck('clock:ping', { clientSent })) as ClockPongPayload;

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
        syncing.current = false;
      }

      if (samples.length > 0) {
        // The freshest estimate wins outright rather than being merged with the
        // last one: the reason to re-measure is that the old offset may no longer
        // describe this phone, and averaging would keep the stale half of it.
        setClock(estimateClock(samples));
      }
    }

    // Kept up to date for as long as the game lasts, rather than measured once in
    // the lobby and trusted for an hour.
    const resync = setInterval(() => void synchronise(current), CLOCK_RESYNC_INTERVAL_MS);

    // A phone coming back from a locked screen is the case most likely to be
    // holding a stale offset, and also the moment the player is about to answer.
    function onVisible() {
      if (document.visibilityState === 'visible' && current.connected) {
        void synchronise(current);
      }
    }
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(resync);
      document.removeEventListener('visibilitychange', onVisible);
      current.removeAllListeners();
      current.close();
      setSocket(null);
    };
  }, []);

  const serverNow = useCallback(() => toServerTime(clockRef.current), []);

  return { socket, connected, session, error, clock, serverNow };
}

/**
 * A countdown that ticks locally but is anchored to server time.
 *
 * Recomputed from the absolute deadline on every tick rather than decremented, so a
 * tab that was backgrounded shows the right number the instant it returns instead of
 * resuming from where it fell asleep.
 */
export function useCountdown(endsAt: number | null, serverNow: () => number): number {
  const [remaining, setRemaining] = useState(() => compute(endsAt, serverNow));

  useEffect(() => {
    // Subscribing to a clock is exactly the external-system case an effect is for;
    // the first read has to happen here because the deadline changes per phase.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRemaining(compute(endsAt, serverNow));
    if (endsAt === null) return;

    const timer = setInterval(() => setRemaining(compute(endsAt, serverNow)), 100);
    return () => clearInterval(timer);
  }, [endsAt, serverNow]);

  return remaining;
}

function compute(endsAt: number | null, serverNow: () => number): number {
  if (endsAt === null) return 0;
  return Math.max(0, Math.ceil((endsAt - serverNow()) / 1000));
}
