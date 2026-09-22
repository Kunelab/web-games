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
  playerToken: z.string().max(80).optional(),
  /**
   * The word at the door, for a room that has one.
   *
   * Only ever asked of a phone taking a *new* seat: a `playerToken` that names a
   * player already in the room has been through the door once, and asking again
   * would mean every reload and every dropped connection needed it retyped.
   */
  password: z.string().max(40).optional()
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

/**
 * A press of the buzzer.
 *
 * No field key: the buzzer is for the round, not for one answer. Whoever wins it
 * may name anything on the item, which is what lets a blind test's title, artist
 * and year stay one turn at the microphone rather than three separate races.
 */
export const buzzPayloadSchema = z.object({
  roundId: z.string().min(1),
  /** The player's own clock in server time. What the race is decided on. */
  clientTime: z.number()
});

export type BuzzPayload = z.infer<typeof buzzPayloadSchema>;

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
  /**
   * The refusal was the door, not the code: ask for a password and try again.
   *
   * A flag rather than a sentence the phone has to match against, because the
   * join screen reacts to it — it grows a field — and a screen that decided what
   * to render by comparing error strings would break the first time one of them
   * was reworded.
   */
  needsPassword?: boolean;
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
  'answer:buzz': (payload: BuzzPayload, ack: (response: { ok: boolean; error?: string }) => void) => void;
  'answer:revealChoices': (
    payload: z.infer<typeof revealChoicesPayloadSchema>,
    ack: (response: { ok: boolean; choices?: string[] }) => void
  ) => void;
  'host:open': (payload: { code: string; hostToken: string }, ack: (response: JoinAck) => void) => void;
  'host:start': (payload: z.infer<typeof hostActionSchema>) => void;
  'host:advance': (payload: z.infer<typeof hostActionSchema>) => void;
  'host:closeAnswers': (payload: z.infer<typeof hostActionSchema>) => void;
  'host:kick': (payload: { hostToken: string; playerId: string }) => void;
  /**
   * Appoints the television, in a game whose media plays on one screen only.
   *
   * `playerId: null` means the host screen itself, which is the default and the
   * usual answer. Naming a player instead is for the room whose big screen is
   * somebody's phone plugged into an HDMI cable, or a laptop that joined as a
   * player because that was the device with the browser on it.
   */
  'host:setTv': (payload: { hostToken: string; playerId: string | null }) => void;
  /**
   * The room saying the reveal is wrong, so the library entry goes.
   *
   * Host-only, and that is a judgement rather than an oversight. The catalogue is
   * shared and public, so letting any phone delete from it would put it at the
   * mercy of whoever is losing; the host has the screen with the answer on it and
   * is the one person in the room already arbitrating the round.
   */
  'host:flagRound': (payload: z.infer<typeof hostActionSchema>) => void;
  /**
   * Stops the clock on the round in play, or starts it again.
   *
   * Any phase, because the moment a host needs this is rarely the tidy one: an
   * answer that is plainly wrong gets noticed while people are still typing at
   * it, not politely at the reveal. Nothing acts while it is held — no deadline
   * fires, no answer lands, no buzzer resolves — and releasing gives the room
   * back the phase it was in with what was left of it.
   */
  'host:holdRound': (payload: { hostToken: string; hold: boolean }) => void;
  /**
   * Fixes what an answer actually is.
   *
   * A generated round's answers were read off a title by a model, and it gets
   * one wrong now and then — the wrong artist, a subtitle that is not part of
   * the name, the song where the work was wanted. The room finds out at the
   * reveal, which until now was a moment with nowhere to put the correction:
   * the only thing on offer was throwing the round away entirely.
   *
   * Per field, so "the artist is wrong but the title is right" is one edit and
   * not a retype of both.
   */
  'host:correctRound': (payload: {
    hostToken: string;
    /**
     * The answers, each with the spellings that are to count as it.
     *
     * `aliases` omitted leaves the stored ones alone; sent, it replaces them
     * whole, empty array included. The distinction is what lets a wrong alias be
     * taken away as well as a missing one added - one that accepts an answer
     * nobody should get points for is the same kind of mistake as a wrong
     * answer, and needs the same door out.
     */
    fields?: { key: string; value: string; aliases?: string[] }[];
    /**
     * And where the clip should actually start and stop.
     *
     * A generated round's window is worked out from a chorus lookup, and when
     * that lookup misses the round opens on an intro, on silence, or on the
     * wrong half of the song — which is not a wrong answer but is just as
     * unplayable, and was the one kind of mistake the room could hear and
     * nobody could fix. Seconds, as the payload stores them.
     */
    clip?: { startGuess?: number; endGuess?: number; startReveal?: number; endReveal?: number };
    /**
     * And how hard the room turned out to find it, 0 to 100.
     *
     * The draw's own figure is a rank among search results, which is a guess at
     * fame rather than a measure of it; this one is the verdict of a room that
     * has just played the clip. Omitted leaves it as it is, which is not the
     * same as 0 - that would be a claim that everybody knows it.
     */
    difficulty?: number;
  }) => void;
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
