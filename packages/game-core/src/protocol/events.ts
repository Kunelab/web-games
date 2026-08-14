import { z } from 'zod';

import { joinCodeSchema, type RevealView, type SessionView } from './session.js';

/**
 * The socket contract, declared once and imported by both sides.
 *
 * This is the main reason the two projects share a package. The previous stack had
 * the event names as bare strings in two repos, so a renamed field failed silently
 * at runtime; here a mismatch is a compile error on whichever side is wrong.
 */

export const joinPayloadSchema = z.object({
  code: joinCodeSchema,
  playerName: z.string().trim().min(1, 'Choisis un pseudo').max(24),
  /**
   * Returned by a previous join. Lets a player who reloaded or lost signal
   * reclaim their identity and score instead of appearing as a new player.
   */
  playerToken: z.string().max(80).optional()
});

export type JoinPayload = z.infer<typeof joinPayloadSchema>;

export const answerPayloadSchema = z.object({
  roundId: z.string().min(1),
  fieldKey: z.string().min(1).max(40),
  value: z.string().min(1).max(200),
  /** The player's own clock, converted to server time with its measured offset. */
  clientTime: z.number(),
  /** True when they answered without revealing the choices, for the direct bonus. */
  direct: z.boolean().default(false)
});

export type AnswerPayload = z.infer<typeof answerPayloadSchema>;

export const revealChoicesPayloadSchema = z.object({
  roundId: z.string().min(1),
  fieldKey: z.string().min(1).max(40)
});

export const hostActionSchema = z.object({
  /** Proves the sender owns the session; issued when the host opens it. */
  hostToken: z.string().min(1).max(80)
});

export interface JoinAck {
  ok: boolean;
  error?: string;
  /** Store and resend on reconnect. */
  playerToken?: string;
  playerId?: string;
  session?: SessionView;
}

export interface AnswerAck {
  ok: boolean;
  error?: string;
  /** Whether it was accepted as correct. */
  correct?: boolean;
  /** Points earned, available immediately so the phone can react. */
  points?: number;
  /** Attempts left on this field. */
  attemptsLeft?: number;
}

export interface ClockPongPayload {
  clientSent: number;
  serverTime: number;
}

/** Client to server. */
export interface ClientToServerEvents {
  'session:join': (payload: JoinPayload, ack: (response: JoinAck) => void) => void;
  'session:leave': () => void;
  'clock:ping': (payload: { clientSent: number }, ack: (response: ClockPongPayload) => void) => void;
  'answer:submit': (payload: AnswerPayload, ack: (response: AnswerAck) => void) => void;
  'answer:revealChoices': (
    payload: z.infer<typeof revealChoicesPayloadSchema>,
    ack: (response: { ok: boolean; choices?: string[] }) => void
  ) => void;
  'host:open': (payload: { code: string; hostToken: string }, ack: (response: JoinAck) => void) => void;
  'host:start': (payload: z.infer<typeof hostActionSchema>) => void;
  'host:advance': (payload: z.infer<typeof hostActionSchema>) => void;
  'host:closeAnswers': (payload: z.infer<typeof hostActionSchema>) => void;
  'host:kick': (payload: { hostToken: string; playerId: string }) => void;
}

/** Server to client. */
export interface ServerToClientEvents {
  /** Whole-session snapshot. Sent on join, on reconnect, and on any phase change. */
  'session:state': (view: SessionView) => void;
  'session:players': (players: SessionView['players']) => void;
  'round:reveal': (reveal: RevealView) => void;
  'session:ended': (standings: SessionView['players']) => void;
  'session:error': (payload: { message: string }) => void;
  /**
   * Server-initiated round-trip probe. The client acknowledges immediately and
   * sends nothing back.
   *
   * The measurement has to be server-side. Lag compensation credits a player for
   * their latency, so a client that reported its own round trip could claim a
   * terrible connection and buy itself several seconds of backdating. Timing its
   * own emit-to-ack leaves the client nothing to lie about.
   */
  'clock:sync': (payload: { serverTime: number }, ack: () => void) => void;
}

/**
 * Sent on every phase change rather than diffed.
 *
 * A snapshot is a few hundred bytes at party scale, and it makes reconnection
 * free: a player whose phone slept gets the current state on the next event with
 * no replay logic anywhere. The old implementation had no reconnection at all.
 */
export const SNAPSHOT_ON_EVERY_TRANSITION = true;
