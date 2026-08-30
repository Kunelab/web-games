import type { Msg } from 'i18n';
import { z } from 'zod';

import { LOBBY_GAMES } from './state.js';
import type { LobbyGame } from './state.js';
import type { QuickLobbyView } from './view.js';

/**
 * The quick lobby over the wire.
 *
 * Six events, and only one of them carries anything the server has to think about.
 * A room deciding what to play is a much smaller protocol than the game it starts,
 * and keeping it small is what lets all three games share it.
 */

const codeSchema = z.string().trim().toUpperCase().min(1).max(16);

export const quickJoinSchema = z.object({
  game: z.enum(LOBBY_GAMES),
  /**
   * The room to join. Absent means "find me one", which is what the Quick match
   * button sends: matchmaking is the default and naming a room is the exception,
   * for a replay or a shared link.
   */
  code: codeSchema.optional(),
  name: z.string().trim().min(1).max(24),
  /** Returned by a previous join; lets a reload take its seat back. */
  memberToken: z.string().max(128).optional()
});

export const quickReadySchema = z.object({
  code: codeSchema,
  ready: z.boolean()
});
export const quickVoteSchema = z.object({
  code: codeSchema,
  key: z.string().max(32),
  value: z.string().max(64)
});
/**
 * How many machine players the room wants, as an absolute count rather than a
 * nudge: two phones pressing "+" at the same moment should land on three bots,
 * not four, and an absolute value is the only version of this that is safe to
 * send twice.
 */
export const quickBotsSchema = z.object({
  code: codeSchema,
  count: z.number().int().min(0).max(64)
});

export const quickLeaveSchema = z.object({ code: codeSchema });
export const quickBeatSchema = z.object({ code: codeSchema });

/**
 * "Play that again."
 *
 * Keyed by the game that just finished rather than by the lobby that started it:
 * the lobby is gone by then, and the finished game's code is the one thing every
 * phone at the table is holding.
 */
export const quickReplaySchema = z.object({
  game: z.enum(LOBBY_GAMES),
  gameCode: codeSchema,
  name: z.string().trim().min(1).max(24)
});

export interface QuickJoinAck {
  ok: boolean;
  /** A catalogue key, like every other refusal the house sends. */
  error?: Msg;
  code?: string;
  memberId?: string;
  memberToken?: string;
  view?: QuickLobbyView;
}

/** Where the room is going, once it has started something. */
export interface QuickLaunch {
  game: LobbyGame;
  /** The quick lobby that launched it. */
  lobbyCode: string;
  /** The real game's join code. */
  code: string;
  /** Path the player should open, relative to the site root. */
  path: string;
}

type Ack<T> = (response: T) => void;

export interface QuickClientToServer {
  'quick:join': (payload: z.infer<typeof quickJoinSchema>, ack: Ack<QuickJoinAck>) => void;
  'quick:replay': (payload: z.infer<typeof quickReplaySchema>, ack: Ack<QuickJoinAck>) => void;
  'quick:ready': (payload: z.infer<typeof quickReadySchema>) => void;
  'quick:vote': (payload: z.infer<typeof quickVoteSchema>) => void;
  'quick:bots': (payload: z.infer<typeof quickBotsSchema>) => void;
  'quick:beat': (payload: z.infer<typeof quickBeatSchema>) => void;
  'quick:leave': (payload: z.infer<typeof quickLeaveSchema>) => void;
}

export interface QuickServerToClient {
  'quick:state': (view: QuickLobbyView) => void;
  'quick:launch': (launch: QuickLaunch) => void;
  'quick:closed': (payload: { code: string; reason: Msg }) => void;
}

/** Where a player of `game` goes once the room has started something. */
export function quickJoinPath(game: LobbyGame, code: string): string {
  switch (game) {
    case 'quiz':
      return `/rejoindre/${code}`;
    case 'coronaz':
      return `/coronaz/rejoindre/${code}`;
    case 'mafia':
      return `/mafia/rejoindre/${code}`;
  }
}
