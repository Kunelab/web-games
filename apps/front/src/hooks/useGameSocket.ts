import type { ClientToServerEvents, ClockEstimate, ServerToClientEvents, SessionView } from 'game-core';
import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

import { apiOrigin } from '../tools/api-url';
import { useClockUpkeep, useServerClock } from './useServerClock';

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

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
 * The clock is the point, and it lives in `useServerClock` because all three
 * games need exactly this: every countdown and every reveal animation is derived
 * from a server timestamp plus the offset, so all screens show the same frame
 * without a single animation frame being transmitted, and an answer can be
 * reported in server time rather than being judged on when its packet arrived.
 */
export function useGameSocket(): GameConnection {
  // The socket lives in state, not a ref: consumers need to re-render once it
  // exists, and reading a ref during render is not allowed.
  const [socket, setSocket] = useState<GameSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { estimate, serverNow, synchronise } = useServerClock();

  useEffect(() => {
    const current: GameSocket = io(apiOrigin, { transports: ['websocket', 'polling'] });
    // Publishing the socket is the whole purpose of this effect: it is an external
    // resource whose lifetime is the component's, which is what effects are for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSocket(current);

    current.on('connect', () => {
      setConnected(true);
      setError(null);
      synchronise(current);
    });

    current.on('disconnect', () => setConnected(false));
    current.on('connect_error', () => setError('Connexion au serveur impossible.'));
    current.on('session:state', (view) => setSession(view));
    current.on('session:error', (payload) => setError(payload.message));

    // The server probes latency by asking us to acknowledge; nothing to send back.
    current.on('clock:sync', (_payload, ack) => {
      if (typeof ack === 'function') ack();
    });

    return () => {
      current.removeAllListeners();
      current.close();
      setSocket(null);
    };
  }, [synchronise]);

  useClockUpkeep(socket, synchronise);

  return { socket, connected, session, error, clock: estimate, serverNow };
}

export { useCountdown } from './useServerClock';
