import { z } from 'zod';

import type { RedactedAnswerField } from '../media/answer-field.js';
import { scoringConfigSchema } from '../scoring/score.js';

/**
 * Phases a round moves through.
 *
 * The server owns this, and every transition carries an absolute server-time
 * boundary so clients render countdowns and reveals from their synchronised clock
 * instead of being told what to draw.
 */
export type RoundPhase =
  /** Media loading, players told what is coming. */
  | 'loading'
  /** Memory panel visible, answers not yet open. */
  | 'study'
  /** Answers accepted. */
  | 'answering'
  /** Answers closed, correct values and per-round scores shown. */
  | 'reveal';

export type SessionPhase =
  /** Players joining, host has not started. */
  | 'lobby'
  | 'playing'
  /** Final standings. */
  | 'finished';

export interface PlayerView {
  id: string;
  name: string;
  connected: boolean;
  score: number;
  rank: number;
  /**
   * Badge key of the title this nickname has earned across past games, when it has
   * one. Pure cosmetics: the client maps the key to its French label.
   */
  title?: string;
}

/** What a player receives for the current round. */
export interface RoundView {
  roundId: string;
  index: number;
  total: number;
  kind: string;
  phase: RoundPhase;
  /** Server time this phase began. */
  phaseStartAt: number;
  /** Server time this phase ends, or null when it waits on the host. */
  phaseEndsAt: number | null;
  /**
   * How long the answer phase is meant to last, in ms.
   *
   * Sent as well as the deadline because a progressive presentation needs a duration
   * even when there is no deadline: an oral round is host-driven, so `phaseEndsAt` is
   * null, and a reveal that derives its duration from that shows a fully unblurred
   * picture on the first frame, which is the whole game given away.
   */
  answerMs: number;
  /** Kind-specific, produced by the kind's playerPresentation. Never has answers. */
  presentation: unknown;
  fields: RedactedAnswerField[];
  /** Field keys this player has already answered correctly. */
  solvedFieldKeys: string[];
  /** Field keys this player has used up their attempts on. */
  lockedFieldKeys: string[];
}

/** Correct answers plus scores, sent only once answering has closed. */
export interface RevealView {
  roundId: string;
  answers: { key: string; label: string; value: string }[];
  explanation?: string;
  /**
   * Everyone's number on an estimation round, closest first.
   *
   * Only that kind fills this: guesses are the spectacle of the reveal there, where
   * on every other kind who-typed-what stays private. `delta` is signed, so the
   * screen can say "trop haut" or "trop bas".
   */
  guesses?: { playerId: string; name: string; value: number; delta: number }[];
  roundScores: {
    playerId: string;
    name: string;
    points: number;
    /** Present only when it was not 1, so the screen can explain the number. */
    comboMultiplier?: number;
    comebackMultiplier?: number;
    /** Rounds won in a row including this one, for showing a running streak. */
    comboLength: number;
    fieldKeys: string[];
  }[];
}

/**
 * The round as the host sees it: unredacted.
 *
 * The host screen has to play the clip and show the answers, so it genuinely needs
 * the payload. It is a separate field rather than a looser `RoundView` so that the
 * redacted and unredacted shapes can never be confused at a call site — a player
 * payload has no `hostRound`, and that is a type error rather than a leak.
 */
export interface HostRoundView {
  roundId: string;
  index: number;
  total: number;
  kind: string;
  title: string;
  phase: RoundPhase;
  phaseStartAt: number;
  phaseEndsAt: number | null;
  answerMs: number;
  payload: unknown;
  answers: { key: string; label: string; value: string; points: number }[];
}

/**
 * A distinction handed out with the final standings.
 *
 * The key names the achievement and the client owns the French label for it, so
 * adding an award is a server change plus one dictionary entry. `value` is already
 * formatted for display because only the server has the numbers it comes from.
 */
export interface FinalAward {
  key: string;
  playerId: string;
  playerName: string;
  value: string;
}

export interface SessionView {
  code: string;
  phase: SessionPhase;
  /**
   * True when the game is being played out loud with no phones.
   *
   * The one piece of the session config the screens genuinely need: a television
   * showing a join code, a countdown and a score strip is showing three things that
   * do not exist in this mode. Sending the whole config to every client for one flag
   * would be worse.
   */
  oral: boolean;
  players: PlayerView[];
  round: RoundView | null;
  reveal: RevealView | null;
  isHost: boolean;
  /** Present only when `isHost`. */
  hostRound?: HostRoundView | null;
  /** Items excluded from this session because they were incomplete. */
  skipped?: { title: string; missing: string[] }[];
  /** Present once the session is finished: the ceremony. */
  final?: { awards: FinalAward[] };
}

export const sessionConfigSchema = z.object({
  /** Play the playlist in a random order. */
  shuffle: z.boolean().default(false),
  /** Order media by their date rather than playlist position. */
  chronological: z.boolean().default(false),

  /**
   * No phones: the television is the only screen and answers are spoken aloud.
   *
   * Nothing is submitted, so nothing is scored, and the parts of the game that
   * exist to arbitrate between players stop applying: there is no answer deadline,
   * because the deadline exists to stop people typing, and a room talking to each
   * other does not need one. The host drives the pace from the television.
   *
   * It is also the way to try a playlist out alone, which is why it must be
   * startable with nobody in the room at all.
   */
  oral: z.boolean().default(false),
  /** How many wrong tries a player gets per field before it locks. */
  attemptsPerField: z.number().int().min(1).max(10).default(3),
  /** Advance automatically when the reveal timer ends, rather than waiting. */
  autoAdvance: z.boolean().default(true),
  scoring: scoringConfigSchema.default(scoringConfigSchema.parse({}))
});

export type SessionConfig = z.infer<typeof sessionConfigSchema>;

export const defaultSessionConfig: SessionConfig = sessionConfigSchema.parse({});

/**
 * Join codes are typed by hand from a phone, so the alphabet excludes the
 * characters people misread: no 0/O, no 1/I/L.
 */
const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const JOIN_CODE_LENGTH = 5;

export function isJoinCode(value: string): boolean {
  if (value.length !== JOIN_CODE_LENGTH) return false;
  return [...value].every((character) => JOIN_CODE_ALPHABET.includes(character));
}

/** Requires a source of randomness so the caller controls it. */
export function generateJoinCode(randomInt: (maxExclusive: number) => number): string {
  let code = '';
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
    code += JOIN_CODE_ALPHABET[randomInt(JOIN_CODE_ALPHABET.length)];
  }
  return code;
}

export const joinCodeSchema = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .refine(isJoinCode, { message: 'Code de partie invalide' });
