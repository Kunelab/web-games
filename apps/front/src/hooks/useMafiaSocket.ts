import type { ChatMessage } from 'chat-core';
import type { ClockPongPayload } from 'game-core';
import { msg, type Msg } from 'i18n';
import type { MafiaClientToServer, MafiaServerToClient, MafiaView } from 'mafia-core';
import { useCallback, useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';

import { openSocket } from '../seat/browser';
import { mergeMessages } from './useMafiaFeed';
import { useClockUpkeep, useServerClock } from './useServerClock';

/**
 * The Mafia television's socket: a screen that watches a table without holding
 * a seat at it. Phones hold seats, and theirs is `useSeat` with `useMafiaFeed`
 * on top; this is what is left for a screen that only spectates.
 *
 * The clock matters for one thing — day, trial and night countdowns are derived
 * on every screen from the same server deadline. Chat is merged the same way a
 * seat merges it (see `useMafiaFeed`).
 */

export type MafiaSocket = Socket<
  MafiaServerToClient,
  MafiaClientToServer & {
    'clock:ping': (payload: { clientSent: number }, ack: (response: ClockPongPayload) => void) => void;
  }
>;

export interface MafiaConnection {
  socket: MafiaSocket | null;
  connected: boolean;
  view: MafiaView | null;
  /** view.chat plus every message pushed since the last broadcast. */
  messages: ChatMessage[];
  /** A key, like everything else the server says; the screen renders it. */
  error: Msg | null;
  serverNow: () => number;
}

export function useMafiaSocket(): MafiaConnection {
  const [socket, setSocket] = useState<MafiaSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [view, setView] = useState<MafiaView | null>(null);
  const [extra, setExtra] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<Msg | null>(null);
  const { serverNow, synchronise } = useServerClock();

  const applyView = useCallback((next: MafiaView) => {
    setView(next);
    // Messages the view already carries need no duplicate in the side buffer.
    const lastId = next.chat.at(-1)?.id ?? 0;
    setExtra((current) => current.filter((message) => message.id > lastId));
  }, []);

  useEffect(() => {
    const current: MafiaSocket = openSocket();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- publishing an external resource
    setSocket(current);

    current.on('connect', () => {
      setConnected(true);
      setError(null);
      synchronise(current);
    });
    current.on('disconnect', () => setConnected(false));
    current.on('connect_error', () => setError(msg('net.unreachable')));
    current.on('mafia:state', applyView);
    current.on('mafia:message', (message) => setExtra((currentExtra) => [...currentExtra, message]));
    current.on('mafia:error', (payload) => setError(payload.message));

    return () => {
      current.removeAllListeners();
      current.close();
      setSocket(null);
    };
  }, [applyView, synchronise]);

  useClockUpkeep(socket, synchronise);

  const messages = view ? mergeMessages(view.chat, extra) : extra;

  return { socket, connected, view, messages, error, serverNow };
}
