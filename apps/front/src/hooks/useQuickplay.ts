import type { LobbyGame, QuickClientToServer, QuickJoinAck, QuickLaunch, QuickLobbyView, QuickServerToClient } from 'lobby-core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

import { apiOrigin } from '../tools/api-url';

export type QuickSocket = Socket<QuickServerToClient, QuickClientToServer>;

export interface QuickConnection {
  connected: boolean;
  lobby: QuickLobbyView | null;
  /** Set once the room has started something; the screen then navigates. */
  launch: QuickLaunch | null;
  error: string | null;
  ready: (value: boolean) => void;
  vote: (key: string, value: string) => void;
  leave: () => void;
}

/** Where a member id is kept, so a reload takes its place back rather than a new one. */
function tokenKey(game: LobbyGame): string {
  return `kune.quick.${game}.member`;
}

/** The nickname a phone last used. Asked once, remembered everywhere. */
export const NICKNAME_KEY = 'kune.nickname';

export function storedNickname(): string {
  try {
    return localStorage.getItem(NICKNAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function rememberNickname(name: string): void {
  try {
    localStorage.setItem(NICKNAME_KEY, name);
  } catch {
    // A phone with storage disabled just gets asked again. Not worth failing over.
  }
}

export interface QuickplayOptions {
  game: LobbyGame;
  name: string;
  /** A specific room; omitted, the server matches you into one. */
  code?: string;
  /**
   * Replay a finished game instead of joining a room.
   *
   * Everyone who presses "encore" on the same finished game lands in the same
   * successor room, which is the whole reason this is a separate verb rather
   * than a join with a code the client made up.
   */
  replayOf?: string;
  /** False while the screen is still asking for a nickname. */
  enabled: boolean;
}

/**
 * One socket, one quick room.
 *
 * The room is a socket conversation rather than a REST resource because every
 * interesting thing about it happens to you rather than because you asked:
 * somebody else votes, the count tips, the countdown starts and the game exists.
 * Polling that would be both slower and worse.
 */
export function useQuickplay(options: QuickplayOptions): QuickConnection {
  const { game, name, code, replayOf, enabled } = options;

  const [connected, setConnected] = useState(false);
  const [lobby, setLobby] = useState<QuickLobbyView | null>(null);
  const [launch, setLaunch] = useState<QuickLaunch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<QuickSocket | null>(null);

  useEffect(() => {
    if (!enabled || !name.trim()) return;

    const socket: QuickSocket = io(apiOrigin, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;
    let joinedCode: string | null = null;

    function onAck(ack: QuickJoinAck) {
      if (!ack.ok) {
        setError(ack.error ?? 'Ce salon est inaccessible.');
        return;
      }
      setError(null);
      joinedCode = ack.code ?? null;
      if (ack.memberToken) {
        try {
          sessionStorage.setItem(tokenKey(game), ack.memberToken);
        } catch {
          // Same as the nickname: a reload will simply be a new member.
        }
      }
      if (ack.view) setLobby(ack.view);
    }

    socket.on('connect', () => {
      setConnected(true);

      if (replayOf) {
        socket.emit('quick:replay', { game, gameCode: replayOf, name: name.trim() }, onAck);
        return;
      }

      let memberToken: string | undefined;
      try {
        memberToken = sessionStorage.getItem(tokenKey(game)) ?? undefined;
      } catch {
        memberToken = undefined;
      }

      socket.emit('quick:join', { game, code, name: name.trim(), memberToken }, onAck);
    });

    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setError('Connexion au serveur impossible.'));
    socket.on('quick:state', (view) => setLobby(view));
    socket.on('quick:launch', (payload) => setLaunch(payload));
    socket.on('quick:closed', (payload) => {
      setLobby(null);
      setError(payload.reason);
    });

    /**
     * A heartbeat, because the majority is counted over who is *present*.
     *
     * A phone that locked mid-vote must stop holding the room hostage, and the
     * server cannot tell a quiet member from a gone one without being told.
     */
    const beat = setInterval(() => {
      if (joinedCode) socket.emit('quick:beat', { code: joinedCode });
    }, 5000);

    return () => {
      clearInterval(beat);
      if (joinedCode) socket.emit('quick:leave', { code: joinedCode });
      socket.removeAllListeners();
      socket.close();
      socketRef.current = null;
    };
  }, [game, name, code, replayOf, enabled]);

  const ready = useCallback(
    (value: boolean) => {
      const current = lobby?.code;
      if (current) socketRef.current?.emit('quick:ready', { code: current, ready: value });
    },
    [lobby?.code]
  );

  const vote = useCallback(
    (key: string, value: string) => {
      const current = lobby?.code;
      if (current) socketRef.current?.emit('quick:vote', { code: current, key, value });
    },
    [lobby?.code]
  );

  const leave = useCallback(() => {
    const current = lobby?.code;
    if (current) socketRef.current?.emit('quick:leave', { code: current });
  }, [lobby?.code]);

  return { connected, lobby, launch, error, ready, vote, leave };
}
