import type { ChatMessage } from 'chat-core';
import type { ClockPongPayload } from 'game-core';
import { msg, type Msg } from 'i18n';
import type { MafiaBusy, MafiaClientToServer, MafiaReward, MafiaServerToClient, MafiaView } from 'mafia-core';
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
  /** Which seats have a model working for them, and whether the ear is reading. */
  busy: MafiaBusy;
  /** A key, like everything else the server says; the screen renders it. */
  error: Msg | null;
  serverNow: () => number;
  applyView: (next: MafiaView) => void;
}

export function useMafiaSocket(): MafiaConnection {
  const [socket, setSocket] = useState<MafiaSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [view, setView] = useState<MafiaView | null>(null);
  const [extra, setExtra] = useState<ChatMessage[]>([]);
  const [rewards, setRewards] = useState<MafiaReward[] | null>(null);
  /**
   * Deliberately outside the view.
   *
   * It changes several times a second and means nothing a moment later, so it
   * arrives on its own small event and never drags a projected board behind it.
   * A disconnect leaves the last state behind, which is why the reconnect below
   * clears it: nothing is working for a table this socket has just rejoined.
   */
  const [busy, setBusy] = useState<MafiaBusy>({ speaking: [], thinking: [], reading: false });
  const [error, setError] = useState<Msg | null>(null);
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
    current.on('disconnect', () => {
      setConnected(false);
      setBusy({ speaking: [], thinking: [], reading: false });
    });
    current.on('connect_error', () => setError(msg('net.unreachable')));
    current.on('mafia:state', applyView);
    current.on('mafia:message', (message) => setExtra((currentExtra) => [...currentExtra, message]));
    current.on('mafia:rewards', (next) => setRewards(next));
    current.on('mafia:busy', (next) => setBusy(next));
    current.on('mafia:error', (payload) => setError(payload.message));

    return () => {
      current.removeAllListeners();
      current.close();
      setSocket(null);
    };
  }, [applyView, synchronise]);

  useClockUpkeep(socket, synchronise);

  const messages = view ? mergeMessages(view.chat, extra) : extra;

  return { socket, connected, view, messages, rewards, busy, error, serverNow, applyView };
}

function mergeMessages(base: ChatMessage[], extra: ChatMessage[]): ChatMessage[] {
  if (extra.length === 0) return base;
  const lastId = base.at(-1)?.id ?? 0;
  const fresh = extra.filter((message) => message.id > lastId);
  return fresh.length > 0 ? [...base, ...fresh] : base;
}
