import type { ChatMessage } from 'chat-core';
import type { MafiaClientToServer, MafiaReward, MafiaServerToClient, MafiaView } from 'mafia-core';
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
import { io, type Socket } from 'socket.io-client';

import { apiOrigin } from '../tools/api-url';

/**
 * The Mafia twin of `useCzSocket`: same server, same clock discipline, its own
 * events. The clock matters for one thing — day, trial and night countdowns
 * are derived on every phone from the same server deadline.
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

const NO_CLOCK: ClockEstimate = { offsetMs: 0, rttMs: 0, samples: 0 };

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
  const [clock, setClock] = useState<ClockEstimate>(NO_CLOCK);

  const clockRef = useRef<ClockEstimate>(NO_CLOCK);
  useEffect(() => {
    clockRef.current = clock;
  }, [clock]);

  const syncing = useRef(false);

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
      void synchronise(current);
    });
    current.on('disconnect', () => setConnected(false));
    current.on('connect_error', () => setError('Connexion au serveur impossible.'));
    current.on('mafia:state', applyView);
    current.on('mafia:message', (message) => setExtra((currentExtra) => [...currentExtra, message]));
    current.on('mafia:rewards', (next) => setRewards(next));
    current.on('mafia:error', (payload) => setError(payload.message));

    async function synchronise(target: MafiaSocket) {
      if (syncing.current) return;
      syncing.current = true;
      const samples: ClockSample[] = [];
      try {
        for (let index = 0; index < CLOCK_SAMPLE_COUNT; index++) {
          const clientSent = clientClockNow();
          try {
            const pong = (await target.timeout(3000).emitWithAck('clock:ping', { clientSent })) as ClockPongPayload;
            samples.push({ clientSent: pong.clientSent, serverTime: pong.serverTime, clientReceived: clientClockNow() });
          } catch {
            break;
          }
        }
      } finally {
        syncing.current = false;
      }
      if (samples.length > 0) setClock(estimateClock(samples));
    }

    const resync = setInterval(() => void synchronise(current), CLOCK_RESYNC_INTERVAL_MS);

    function onVisible() {
      if (document.visibilityState === 'visible' && current.connected) {
        void synchronise(current);
      }
    }
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(resync);
      document.removeEventListener('visibilitychange', onVisible);
      current.disconnect();
    };
  }, [applyView]);

  const serverNow = useCallback(() => toServerTime(clockRef.current), []);

  const messages = view ? mergeMessages(view.chat, extra) : extra;

  return { socket, connected, view, messages, rewards, error, serverNow, applyView };
}

function mergeMessages(base: ChatMessage[], extra: ChatMessage[]): ChatMessage[] {
  if (extra.length === 0) return base;
  const lastId = base.at(-1)?.id ?? 0;
  const fresh = extra.filter((message) => message.id > lastId);
  return fresh.length > 0 ? [...base, ...fresh] : base;
}
