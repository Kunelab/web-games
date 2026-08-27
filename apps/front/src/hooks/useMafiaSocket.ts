import type { ChatMessage } from 'chat-core';
import type { ClockPongPayload } from 'game-core';
import type { MafiaClientToServer, MafiaReward, MafiaServerToClient, MafiaView } from 'mafia-core';
import { useCallback, useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

import { apiOrigin } from '../tools/api-url';
import { useClockUpkeep, useServerClock } from './useServerClock';

/**
 * The Mafia twin of `useCzSocket`: same server, same clock discipline, its own
 * events. The clock matters for one thing — day, trial and night countdowns are
 * derived on every phone from the same server deadline.
 *
 * Chat arrives twice: inside every `mafia:state` view (authoritative, filtered
 * server-side) and as incremental `mafia:message` pushes between broadcasts.
 * The hook merges the two, deduplicating on message id.
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
  rewards: MafiaReward[] | null;
  error: string | null;
  serverNow: () => number;
  applyView: (next: MafiaView) => void;
}

export function useMafiaSocket(): MafiaConnection {
  const [socket, setSocket] = useState<MafiaSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [view, setView] = useState<MafiaView | null>(null);
  const [extra, setExtra] = useState<ChatMessage[]>([]);
  const [rewards, setRewards] = useState<MafiaReward[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { serverNow, synchronise } = useServerClock();

  const applyView = useCallback((next: MafiaView) => {
    setView(next);
    // Messages the view already carries need no duplicate in the side buffer.
    const lastId = next.chat.at(-1)?.id ?? 0;
    setExtra((current) => current.filter((message) => message.id > lastId));
  }, []);

  useEffect(() => {
    const current: MafiaSocket = io(apiOrigin, { transports: ['websocket', 'polling'] });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- publishing an external resource
    setSocket(current);

    current.on('connect', () => {
      setConnected(true);
      setError(null);
      synchronise(current);
    });
    current.on('disconnect', () => setConnected(false));
    current.on('connect_error', () => setError('Connexion au serveur impossible.'));
    current.on('mafia:state', applyView);
    current.on('mafia:message', (message) => setExtra((currentExtra) => [...currentExtra, message]));
    current.on('mafia:rewards', (next) => setRewards(next));
    current.on('mafia:error', (payload) => setError(payload.message));

    return () => {
      current.removeAllListeners();
      current.close();
      setSocket(null);
    };
  }, [applyView, synchronise]);

  useClockUpkeep(socket, synchronise);

  const messages = view ? mergeMessages(view.chat, extra) : extra;

  return { socket, connected, view, messages, rewards, error, serverNow, applyView };
}

function mergeMessages(base: ChatMessage[], extra: ChatMessage[]): ChatMessage[] {
  if (extra.length === 0) return base;
  const lastId = base.at(-1)?.id ?? 0;
  const fresh = extra.filter((message) => message.id > lastId);
  return fresh.length > 0 ? [...base, ...fresh] : base;
}
