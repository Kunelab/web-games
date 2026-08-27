import type { CzClientToServer, CzRaidReward, CzServerToClient, CzView } from 'coronaz-core';
import type { ClockPongPayload } from 'game-core';
import { useCallback, useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

import { apiOrigin } from '../tools/api-url';
import { useClockUpkeep, useServerClock } from './useServerClock';

/**
 * The CoronaZ twin of `useGameSocket`: same server, same clock discipline,
 * different state event. Kept as its own hook rather than a parameterised one
 * because the two views share no shape, and a union would put quiz fields on
 * every zombie screen. The clock itself is shared — see `useServerClock`.
 *
 * The clock matters here for one thing: the phase countdown. Every phone and the
 * television derive "seconds left" from the same server deadline.
 */

export type CzSocket = Socket<
  CzServerToClient,
  CzClientToServer & {
    'clock:ping': (payload: { clientSent: number }, ack: (response: ClockPongPayload) => void) => void;
  }
>;

export interface CzConnection {
  socket: CzSocket | null;
  connected: boolean;
  view: CzView | null;
  /**
   * What the raid paid, once it has ended. Null until the server says so, which is
   * a moment after the final view arrives: the careers have to be written first.
   */
  rewards: CzRaidReward[] | null;
  error: string | null;
  serverNow: () => number;
  /** Feeds a view carried by an ack, so a screen never waits for a broadcast. */
  applyView: (next: CzView) => void;
}

export function useCzSocket(): CzConnection {
  const [socket, setSocket] = useState<CzSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [view, setView] = useState<CzView | null>(null);
  const [rewards, setRewards] = useState<CzRaidReward[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { serverNow, synchronise } = useServerClock();

  useEffect(() => {
    const current: CzSocket = io(apiOrigin, { transports: ['websocket', 'polling'] });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- publishing an external resource
    setSocket(current);

    current.on('connect', () => {
      setConnected(true);
      setError(null);
      synchronise(current);
    });
    current.on('disconnect', () => setConnected(false));
    current.on('connect_error', () => setError('Connexion au serveur impossible.'));
    current.on('cz:state', (next) => setView(next));
    current.on('cz:rewards', (next) => setRewards(next));
    current.on('cz:error', (payload) => setError(payload.message));

    return () => {
      current.removeAllListeners();
      current.close();
      setSocket(null);
    };
  }, [synchronise]);

  useClockUpkeep(socket, synchronise);

  const applyView = useCallback((next: CzView) => setView(next), []);

  return { socket, connected, view, rewards, error, serverNow, applyView };
}
