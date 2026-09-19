import { randomInt, randomUUID } from 'node:crypto';

import {
  buildLeaderboard,
  buzzerScoringConfig,
  clampAnswerTime,
  generateJoinCode,
  getMediaKind,
  matchAnswer,
  matchAnyField,
  maxCompensationMs,
  parseEstimate,
  partitionPlayable,
  pooledFields,
  redactAnswerField,
  scoreEstimationRound,
  scoreRound,
  type AnswerField,
  type BuzzView,
  type GameReward,
  type PlayerView,
  type RevealView,
  type RoundPhase,
  type RoundView,
  type ScoredSubmission,
  type SessionConfig,
  type SessionPhase,
  type SessionView
} from 'game-core';

import type { HostRoundView, StageRoundView } from 'game-core';

import type { MediaView } from '../services/media-service.js';
import { computeAwards } from './awards.js';

/**
 * The authoritative game state.
 *
 * Everything that decides a score lives here, on the server. The client is told
 * only what to render and when a phase started; it never reports its own score, and
 * the answers to the current round are never sent to it at all.
 *
 * The whole object is serialisable so it can be written to SQLite on each phase
 * change, which is what makes a server restart mid-party survivable. The previous
 * implementation kept this in a bare object in the request handler file and lost
 * the game on every deploy.
 */

export interface PlayerState {
  id: string;
  /** Secret the player stores, so a reload reclaims their identity and score. */
  token: string;
  name: string;
  connected: boolean;
  /** Earned across past games, worn as a cosmetic under the name. Badge key. */
  title?: string;
  /** Measured round trip, used to bound how much lag credit they can claim. */
  rttMs: number;
  totalScore: number;
  /**
   * Rounds won in a row, carried between rounds for the combo multiplier.
   *
   * Absent on a session persisted before combos existed, so every read defaults
   * it: a restart mid-party must not crash on an old row.
   */
  comboLength?: number;
  joinedAt: number;
  /**
   * The Kune login behind this seat, when the phone happened to be signed in.
   *
   * Players join with a nickname and no account, and that stays true — this is
   * never required and never asked for. It exists so the tokens a game pays out
   * can follow an account rather than a nickname when there is one, which is the
   * only way a shop purchase survives someone typing "Max" instead of "max".
   */
  account?: string;
}

export interface SubmissionState {
  playerId: string;
  fieldKey: string;
  value: string;
  /** Lag-compensated, in server time. */
  answeredAt: number;
  correct: boolean;
  direct: boolean;
}

export interface RoundState {
  id: string;
  /** Index into the playable item list. */
  index: number;
  mediaId: number;
  kind: string;
  answers: AnswerField[];
  payload: unknown;
  timing: { answerMs: number; studyMs?: number; revealMs: number };
  phase: RoundPhase;
  phaseStartAt: number;
  phaseEndsAt: number | null;
  submissions: SubmissionState[];
  /** Field keys each player has revealed the choices for, so the bonus is lost. */
  revealedChoices: Record<string, string[]>;
  /** Per-round points, computed once when the round closes. */
  scored: Record<string, number> | null;
  /**
   * Combo and comeback multipliers that applied this round, for the players they
   * applied to. Only stored when one of them was not 1, so the common case adds
   * nothing to the persisted state.
   */
  multipliers?: Record<string, { combo: number; comeback: number }>;
  /**
   * The buzzer race, when the session is playing that format.
   *
   * Optional and defaulted on read throughout, because a session persisted before
   * this existed has to restore mid-party rather than crash on a missing key.
   */
  buzz?: BuzzState;
  /**
   * Server time this round was held, or absent while it is running.
   *
   * A pause is the host taking the clock off the room — to explain an answer,
   * to settle an argument, or to correct one. It has to be more than blanking
   * the deadline, because everything this engine times is measured from
   * `phaseStartAt`: a round held for two minutes and released would come back
   * with its whole answering window already elapsed, and every answer after it
   * clamped to the same instant, which is the ordering the scoring is built on.
   *
   * So the moment is recorded here and the start is shifted forward by the
   * length of the pause on release. What the room gets back is the phase it was
   * in, with what was left of it.
   */
  heldAt?: number | null;
  /** What was left of the phase when it was held. Null for a phase with no clock. */
  heldMs?: number | null;
  /**
   * Set once the room has thrown this round's library entry away.
   *
   * Kept on the round rather than re-queried, so the button disappears from the
   * screen the instant it is pressed instead of on the next thing that happens to
   * rebuild the view. Optional, so a round persisted before this existed restores.
   */
  libraryPurged?: boolean;
}

/**
 * How long the server waits, after the first press, before deciding who won.
 *
 * A race cannot be settled by arrival order without handing it to whoever has the
 * shortest cable. Every other timing decision in this game is made on the moment
 * the player physically pressed, bounded by their measured round trip, and a race
 * is the one place where that matters most rather than least: it is the only
 * mechanic where the difference between two players is *entirely* the timestamp.
 *
 * So the first press opens a window instead of winning outright, and every press
 * inside it is judged on its compensated time. A quarter of a second covers the
 * spread between a phone on the room's wifi and one on a weak signal, and it is
 * short enough that nobody sees it happen.
 */
export const BUZZ_ARBITRATION_MS = 250;

/** One press, waiting for the window to close. */
export interface BuzzPress {
  playerId: string;
  /** Lag-compensated, in server time. What the race is actually decided on. */
  pressedAt: number;
}

export interface BuzzState {
  /** Presses collected in the window currently being arbitrated. */
  race: BuzzPress[];
  /** Server time the arbitration window closes. Null when no race is running. */
  raceClosesAt: number | null;
  /** Who won the buzzer and may answer. Null while it is open or being decided. */
  holderId: string | null;
  /** Server time the holder's exclusive window closes. */
  windowEndsAt: number | null;
  /** Players who have spent their shot this round and may not press again. */
  spent: string[];
}

export function emptyBuzzState(): BuzzState {
  return { race: [], raceClosesAt: null, holderId: null, windowEndsAt: null, spent: [] };
}

/**
 * Whether this round is actually being raced.
 *
 * Three things have to hold, and each excludes a format the buzzer would break.
 * An oral game submits nothing at all, so there is no shot to be exclusive about.
 * An estimation round is a commitment every player makes independently and revises
 * until the clock runs out, which is the opposite of one person holding the floor.
 */
export function isBuzzerRound(state: SessionState): boolean {
  if (!state.config.buzzer || state.config.oral) return false;
  return state.round !== null && state.round.kind !== 'estimation';
}

/**
 * What one player did across the whole game, accumulated as rounds close.
 *
 * Round state is replaced on every advance, so anything the final ceremony wants
 * to say about the game has to be banked here while the round still exists.
 * Optional on the session and defaulted on read: a session persisted before this
 * existed must restore without it.
 */
export interface PlayerAggregate {
  correct: number;
  wrong: number;
  /** Quickest correct answer, ms into its round. Null until they get one. */
  fastestMs: number | null;
  /** Rounds this player was the (sole) top earner of. */
  roundsWon: number;
  /** Longest run of round wins. Tracked even when combo scoring is off. */
  bestCombo: number;
}

export interface SessionState {
  code: string;
  hostToken: string;
  hostUserId: number | null;
  playlistId: number | null;
  playlistName: string;
  phase: SessionPhase;
  config: SessionConfig;
  players: Record<string, PlayerState>;
  /** Ordered media for this session, resolved at start. */
  order: number[];
  currentRoundIndex: number;
  round: RoundState | null;
  /** Items excluded because they were incomplete, reported to the host. */
  skipped: { title: string; missing: string[] }[];
  /**
   * The device the media plays on, when the config says only one does.
   *
   * A player id, or null for the host screen — which is the default, and stays
   * the answer for every room whose big screen is the one the host opened. It
   * lives on the session rather than in the config because it is answered in the
   * lobby, once the devices are present and named, and can be changed when
   * somebody swaps the phone that is plugged into the television.
   *
   * Optional so a session persisted before it existed restores without it.
   */
  tvPlayerId?: string | null;
  /** Per-player game-long tallies, for the final awards and the history row. */
  stats?: Record<string, PlayerAggregate>;
  /** Guards the results table against a finished game being recorded twice. */
  resultsRecorded?: boolean;
  /**
   * What the game paid each player, computed once when the results were banked.
   *
   * Stored on the session rather than recomputed per view because it is a
   * *difference*, and the "before" half of it stops existing the moment the
   * history row is written. Optional so a session persisted before this existed
   * restores without it, and so a game that has not ended yet simply has none.
   */
  rewards?: GameReward[];
  /**
   * The media this session runs on, when it has none in the library.
   *
   * A generated blind test builds its rounds in memory and saves nothing, which
   * is the whole point of the mode: nobody wants an evening of automatic rounds
   * silting up their library. But `restore` rebuilds a session's media by looking
   * its `order` up in the `Media` table, so after a restart a generated session
   * came back with every round missing and skipped itself to the end in silence.
   *
   * So the items travel inside the state. Trimmed to a trailing window on the way
   * to disk by `GameManager.persist`: an infinite session runs for hours and
   * rewrites this row on every phase change, and an unbounded array here is a
   * blob that grows all evening on a machine whose SSD is already a known
   * weak point.
   */
  ephemeralItems?: MediaView[];
  /**
   * Settings and memory for a session that generates its own rounds.
   *
   * Present only for the infinite mode. `playedTracks` is keyed on the recording
   * rather than the video, because the same song exists under several uploads and
   * deduplicating on the id lets it come round twice in an evening.
   */
  infinite?: InfiniteState;
  /**
   * Server time the last seat went dark, or null while somebody is still on the line.
   *
   * Needed because `lastActivityAt` cannot answer this question: every transition
   * touches it, and an auto-advancing game transitions by itself. A blind test the
   * room walked out of therefore renewed its own idle clock once a round, for ever
   * — the sweep's three-hour rule could never fire, the timer re-armed after every
   * reveal, and in the endless mode each of those rounds drew another song and sent
   * another batch of titles to a model. This is the one clock the game cannot wind
   * on its own: only a phone being on the line clears it.
   */
  emptySince?: number | null;
  lastActivityAt: number;
}

/** What a self-refilling session needs to keep generating rounds. */
export interface InfiniteState {
  genreIds: string[];
  difficultyMin: number;
  difficultyMax: number;
  /** The host's country: the host screen is the stage, so its licence is the one that counts. */
  region: string;
  /** Recording keys already played. Serialised as an array; a Set does not survive JSON. */
  playedTracks: string[];
  /** Artists in play order, most recent last. Only the tail is read. */
  recentArtists: string[];
  /** Hard stop, or null for genuinely endless. */
  maxRounds: number | null;
  /**
   * How much of this room's evening comes out of the shared catalogue.
   *
   * 0 is every round searched for fresh, 1 is every round replayed from what
   * other rooms have already played and vouched for, and anything between is
   * the mix. Per session rather than one number for the deployment, because the
   * two ends are different evenings: a room that wants to hear things nobody
   * has heard turns it down, a room on a thin quota or one that would rather
   * play the corrected catalogue turns it up.
   *
   * Optional, so a session persisted before this existed restores and falls
   * back to the default share.
   */
  replayShare?: number;
  /**
   * Set by the host's "stop after this round".
   *
   * Stops the refill rather than ending the game, so the round on screen finishes
   * and the ceremony follows it. Ending immediately would cut off a round people
   * are still answering.
   */
  stopping?: boolean;
}

export interface CreateSessionOptions {
  playlistName: string;
  playlistId: number | null;
  hostUserId: number | null;
  items: MediaView[];
  config: SessionConfig;
  existingCodes: ReadonlySet<string>;
}

/** Codes are short enough to collide, so generation retries against those in use. */
export function newJoinCode(existing: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 200; attempt++) {
    const code = generateJoinCode((maxExclusive) => randomInt(maxExclusive));
    if (!existing.has(code)) {
      return code;
    }
  }
  throw new Error('could not allocate an unused join code');
}

export function createSession(options: CreateSessionOptions): SessionState {
  const { playable, skipped } = partitionPlayable(options.items);

  let order = playable.map((item) => item.id);

  if (options.config.chronological) {
    const dateById = new Map(playable.map((item) => [item.id, item.date ?? '']));
    order = [...order].sort((a, b) => (dateById.get(a) ?? '').localeCompare(dateById.get(b) ?? ''));
  } else if (options.config.shuffle) {
    order = shuffle(order);
  }

  const now = Date.now();

  return {
    code: newJoinCode(options.existingCodes),
    hostToken: randomUUID(),
    hostUserId: options.hostUserId,
    playlistId: options.playlistId,
    playlistName: options.playlistName,
    phase: 'lobby',
    config: options.config,
    players: {},
    order,
    currentRoundIndex: -1,
    round: null,
    skipped: skipped.map((entry) => ({ title: entry.item.title, missing: entry.missing })),
    lastActivityAt: now
  };
}

/** Fisher-Yates with crypto randomness, so the order is not predictable. */
function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const a = copy[i];
    const b = copy[j];
    if (a !== undefined && b !== undefined) {
      copy[i] = b;
      copy[j] = a;
    }
  }
  return copy;
}

export interface JoinResult {
  player: PlayerState;
  /** True when an existing player reclaimed their seat rather than a new one. */
  reconnected: boolean;
}

/**
 * Joins or rejoins.
 *
 * A returning token reclaims the same player, which is what stops a phone that
 * slept or a tab that reloaded from becoming a second player with no score. Names
 * are made unique so a scoreboard with two "Max" entries is readable.
 */
export function joinSession(state: SessionState, name: string, token: string | undefined): JoinResult {
  if (token) {
    const existing = Object.values(state.players).find((player) => player.token === token);
    if (existing) {
      existing.connected = true;
      existing.name = uniqueName(state, name, existing.id);
      state.lastActivityAt = Date.now();
      return { player: existing, reconnected: true };
    }
  }

  const player: PlayerState = {
    id: randomUUID(),
    token: randomUUID(),
    name: uniqueName(state, name, null),
    connected: true,
    rttMs: 0,
    totalScore: 0,
    joinedAt: Date.now()
  };

  state.players[player.id] = player;
  state.lastActivityAt = Date.now();
  return { player, reconnected: false };
}

function uniqueName(state: SessionState, desired: string, selfId: string | null): string {
  const trimmed = desired.trim().slice(0, 24) || 'Joueur';
  const taken = new Set(
    Object.values(state.players)
      .filter((player) => player.id !== selfId)
      .map((player) => player.name.toLowerCase())
  );

  if (!taken.has(trimmed.toLowerCase())) {
    return trimmed;
  }

  for (let suffix = 2; suffix < 100; suffix++) {
    const candidate = `${trimmed} ${suffix}`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  return `${trimmed} ${randomInt(1000)}`;
}

/**
 * How long a game in progress may run to an empty room before it is ended.
 *
 * Long enough that it cannot end a game anybody is still playing: for the whole
 * of it not one seat is on the line, and a seat that is not on the line cannot
 * submit anything, so the round it would have cost them was already lost. Short
 * enough to matter, because the thing being stopped is not the game — a blind
 * test nobody is at is a blind test that keeps drawing songs and keeps sending
 * batches of titles to a model, all evening, for a room that went home.
 *
 * Five minutes is about ten rounds. A phone that locks, a tab that sleeps, a
 * walk to the kitchen: all of them come back well inside it, and a whole room
 * doing it at once for five straight minutes is a room that has left.
 */
export const ABANDONED_ROOM_MS = 5 * 60 * 1000;

/**
 * Keeps `emptySince` honest, and says how long the room has been empty.
 *
 * Null covers two different "not abandoned" cases on purpose. Somebody is on the
 * line, which is the ordinary one; or nobody has ever sat down, which is the host
 * who opened a screen and is waiting for friends — and, in an oral game, is the
 * normal way to play the whole evening, since the answers are spoken and no phone
 * ever joins. Neither is a room that left.
 */
export function noteRoom(state: SessionState, now = Date.now()): number | null {
  const seated = Object.values(state.players);

  if (seated.length === 0 || seated.some((player) => player.connected)) {
    state.emptySince = null;
    return null;
  }

  state.emptySince ??= now;
  return now - state.emptySince;
}

/**
 * Ends a game whose room has gone, as if the host had pressed "Terminer".
 *
 * Finished rather than deleted, and that is the whole point of doing it this way.
 * The standings are still there to be banked by the caller, the tokens are still
 * paid, and a host who wandered back can reopen the ceremony for the two hours
 * `FINISHED_GRACE_MS` allows. What stops is everything that was costing something:
 * the phase timer is not re-armed, and `refilling` reads `finished` and draws no
 * more rounds, which is what takes the model calls with it.
 *
 * Returns whether it acted, so a caller can tell an ordinary transition from this.
 */
export function abandonIfEmpty(state: SessionState, now = Date.now()): boolean {
  if (state.phase !== 'playing') return false;

  const emptyFor = noteRoom(state, now);
  if (emptyFor === null || emptyFor < ABANDONED_ROOM_MS) return false;

  state.phase = 'finished';
  state.round = null;
  state.lastActivityAt = now;
  return true;
}

/** Media the engine needs by id. Supplied by the caller so this stays pure. */
export type MediaLookup = (mediaId: number) => MediaView | undefined;

/**
 * Starts the next round, or finishes the session.
 *
 * The first phase depends on the kind: a memory panel opens with a study phase
 * where the image is up but answers are closed, everything else goes straight to
 * answering.
 */
export function advance(state: SessionState, lookup: MediaLookup, now = Date.now()): void {
  state.lastActivityAt = now;

  const nextIndex = state.currentRoundIndex + 1;

  if (nextIndex >= state.order.length) {
    state.phase = 'finished';
    state.round = null;
    return;
  }

  const mediaId = state.order[nextIndex];
  const item = mediaId === undefined ? undefined : lookup(mediaId);

  if (!item) {
    // Deleted between session start and now; skip it rather than stalling.
    state.currentRoundIndex = nextIndex;
    advance(state, lookup, now);
    return;
  }

  const timing = item.effectiveTiming;
  const opensWithStudy = timing.studyMs !== undefined && timing.studyMs > 0;

  // Spoken answers are not on a clock. The answer deadline exists to stop players
  // typing after time is up, and with nobody typing it would only cut the room off
  // mid-sentence, so the host closes the round instead. A study phase keeps its
  // timer: on a memory panel, "you have twenty seconds to look" is the game.
  const answerEndsAt = state.config.oral ? null : now + timing.answerMs;

  state.phase = 'playing';
  state.currentRoundIndex = nextIndex;
  state.round = {
    id: randomUUID(),
    index: nextIndex,
    mediaId: item.id,
    kind: item.kind,
    answers: item.answers,
    payload: item.payload,
    timing,
    phase: opensWithStudy ? 'study' : 'answering',
    phaseStartAt: now,
    phaseEndsAt: opensWithStudy ? now + (timing.studyMs ?? 0) : answerEndsAt,
    submissions: [],
    revealedChoices: {},
    scored: null,
    buzz: state.config.buzzer ? emptyBuzzState() : undefined
  };
}

/** True while the host has the clock stopped on this round. */
export function isHeld(state: SessionState): boolean {
  return state.round?.heldAt != null;
}

/**
 * Stops the clock on the round in play, or starts it again.
 *
 * Any phase, because the moment a host needs this is rarely the tidy one: an
 * answer that is plainly wrong is noticed while people are still typing at it,
 * not politely at the reveal.
 *
 * Releasing shifts `phaseStartAt` forward by however long the pause lasted,
 * which is what makes the resumed phase the same phase rather than a new one
 * with a stale start. Every timing decision in this engine — the answer clamp,
 * the reveal animation, the buzzer's arbitration — is a difference against that
 * field, so moving it is how the pause becomes invisible to all of them at once.
 */
export function holdRound(state: SessionState, hold: boolean, now = Date.now()): boolean {
  const round = state.round;
  if (!round || state.phase !== 'playing') return false;

  if (hold) {
    if (round.heldAt != null) return false;
    round.heldAt = now;
    round.heldMs = round.phaseEndsAt === null ? null : Math.max(0, round.phaseEndsAt - now);
    round.phaseEndsAt = null;
    state.lastActivityAt = now;
    return true;
  }

  if (round.heldAt == null) return false;

  round.phaseStartAt += Math.max(0, now - round.heldAt);
  round.phaseEndsAt = round.heldMs == null ? null : now + round.heldMs;
  round.heldAt = null;
  round.heldMs = null;
  state.lastActivityAt = now;
  return true;
}

/**
 * Corrects what this round's answers actually are.
 *
 * Deliberately does not re-score. The round may already have closed, the points
 * are on the board and the players have read them, and quietly rewriting a
 * scoreboard somebody is looking at is a worse surprise than a round that was
 * marked strictly. What this changes is the answer on screen and, through the
 * caller, the copy kept in the shared catalogue — so the next room dealt this
 * song gets the right one.
 *
 * Values only, and only for fields the round already has. A key naming no field
 * is ignored rather than added: the fields are the round's shape, fixed when it
 * was built, and a client inventing one must not be able to grow it.
 */
export function correctAnswers(state: SessionState, fields: { key: string; value: string }[]): boolean {
  const round = state.round;
  if (!round) return false;

  let changed = false;
  for (const field of fields) {
    const answer = round.answers.find((candidate) => candidate.key === field.key);
    const value = field.value.trim();
    if (!answer || !value || answer.value === value) continue;
    answer.value = value;
    changed = true;
  }

  if (changed) state.lastActivityAt = Date.now();
  return changed;
}

/**
 * Moves this round's clip window.
 *
 * Validated through the kind's own payload schema rather than field by field,
 * so the bounds that a saved item is held to are the bounds a correction is
 * held to: one rule, in one place, whichever door the value came in through. A
 * patch that would not survive being saved is refused whole rather than
 * applied in part.
 *
 * `round.timing` is deliberately left alone. The answer window was fixed when
 * the round was built and the room is inside it; stretching it under people who
 * are already typing would be a stranger thing to do than leaving one round
 * slightly out of step. The stored copy is re-timed from its payload whenever
 * it is next read, so the correction takes full effect the next time the song
 * is played.
 */
export function correctClip(state: SessionState, clip: Record<string, number | undefined>): boolean {
  const round = state.round;
  if (!round) return false;

  const patch: Record<string, number> = {};
  for (const [key, value] of Object.entries(clip)) {
    if (typeof value === 'number' && Number.isFinite(value)) patch[key] = Math.round(value);
  }
  if (Object.keys(patch).length === 0) return false;

  const current = (round.payload ?? {}) as Record<string, unknown>;
  const parsed = getMediaKind(round.kind).payloadSchema.safeParse({ ...current, ...patch });
  if (!parsed.success) return false;

  round.payload = parsed.data;
  state.lastActivityAt = Date.now();
  return true;
}

/** Study phase over: answers open. */
export function openAnswers(state: SessionState, now = Date.now()): void {
  const round = state.round;
  if (!round || round.phase !== 'study') return;

  round.phase = 'answering';
  round.phaseStartAt = now;
  // Same rule as when a round opens straight into answering: no clock when the
  // answers are spoken.
  round.phaseEndsAt = state.config.oral ? null : now + round.timing.answerMs;
  // A fresh buzzer: the study phase was for looking, and nobody may have raced
  // during it. Rebuilt rather than cleared so a restored round gets one too.
  if (state.config.buzzer) round.buzz = emptyBuzzState();
  state.lastActivityAt = now;
}

/**
 * Closes answering and scores the round.
 *
 * Scoring happens exactly once, here, from the submissions recorded during the
 * phase. Doing it at close rather than per answer is what allows position to be
 * resolved per field: the finishing order for a field is not known until the phase
 * ends.
 */
export function closeAnswers(state: SessionState, now = Date.now()): void {
  const round = state.round;
  if (!round || round.phase !== 'answering') return;

  const players = Object.values(state.players);

  // Standings as they stood before this round, which is what the comeback rule
  // judges, and the streaks brought into it, which is what the combo pays on.
  const context = {
    previousTotals: new Map(players.map((player) => [player.id, player.totalScore])),
    comboLengths: new Map(players.map((player) => [player.id, player.comboLength ?? 0]))
  };

  let results;

  if (round.kind === 'estimation') {
    // Distance ranking instead of right-or-wrong; the settlement (combos,
    // comebacks, streaks) is shared. Only the first answer field is the estimate.
    const field = round.answers[0];
    results = field ? scoreEstimationRound(estimationGuesses(round), field, state.config.scoring, context) : [];
  } else {
    const submissions: ScoredSubmission[] = round.submissions.map((submission) => ({
      playerId: submission.playerId,
      fieldKey: submission.fieldKey,
      answeredAt: submission.answeredAt,
      correct: submission.correct,
      direct: submission.direct
    }));

    // A raced round pays face value: the ladder and the two clock terms are the
    // simultaneous format's way of rewarding speed, and the buzzer is this one's.
    const scoring = isBuzzerRound(state) ? buzzerScoringConfig(state.config.scoring) : state.config.scoring;

    results = scoreRound(submissions, round.answers, round.phaseStartAt, round.timing.answerMs, scoring, context);
  }

  round.scored = {};
  round.multipliers = {};
  const byPlayer = new Map(results.map((result) => [result.playerId, result]));

  for (const result of results) {
    round.scored[result.playerId] = result.total;
    if (result.comboMultiplier !== 1 || result.comebackMultiplier !== 1) {
      round.multipliers[result.playerId] = {
        combo: result.comboMultiplier,
        comeback: result.comebackMultiplier
      };
    }
    const player = state.players[result.playerId];
    if (player) {
      player.totalScore = Math.round((player.totalScore + result.total) * 100) / 100;
    }
  }

  // Every player, not just those who scored: sitting a round out ends a streak, and
  // a player who never submitted has no entry in the results at all.
  for (const player of players) {
    player.comboLength = byPlayer.get(player.id)?.comboLength ?? 0;
  }

  // Bank what the ceremony will want to say. The round object is replaced on the
  // next advance, so this is the only moment these numbers exist.
  const stats = (state.stats ??= {});
  const ensureAggregate = (playerId: string): PlayerAggregate =>
    (stats[playerId] ??= { correct: 0, wrong: 0, fastestMs: null, roundsWon: 0, bestCombo: 0 });

  for (const submission of round.submissions) {
    const aggregate = ensureAggregate(submission.playerId);
    if (submission.correct) {
      aggregate.correct += 1;
      const elapsed = submission.answeredAt - round.phaseStartAt;
      if (elapsed >= 0 && (aggregate.fastestMs === null || elapsed < aggregate.fastestMs)) {
        aggregate.fastestMs = elapsed;
      }
    } else {
      aggregate.wrong += 1;
    }
  }

  for (const result of results) {
    // `awardCombos` leaves exactly one player with a streak above zero: the round's
    // sole top earner. Everyone else was reset.
    if (result.comboLength > 0) {
      const aggregate = ensureAggregate(result.playerId);
      aggregate.roundsWon += 1;
      aggregate.bestCombo = Math.max(aggregate.bestCombo, result.comboLength);
    }
  }

  // Nothing may hold a buzzer into the reveal, and no stale deadline may survive
  // into it either: `nextDeadline` reads these, and a leftover window would arm a
  // timer against a phase that is already over.
  if (round.buzz) {
    round.buzz.holderId = null;
    round.buzz.windowEndsAt = null;
    round.buzz.race = [];
    round.buzz.raceClosesAt = null;
  }

  round.phase = 'reveal';
  round.phaseStartAt = now;
  round.phaseEndsAt = state.config.autoAdvance ? now + round.timing.revealMs : null;
  state.lastActivityAt = now;
}

/* ------------------------------- the buzzer ------------------------------- */

export interface BuzzResult {
  ok: boolean;
  error?: string;
  /** The press was taken and is in the race being arbitrated. */
  racing?: boolean;
}

/**
 * Records one press of the buzzer.
 *
 * Nobody wins here. The press joins the race and the winner is decided when the
 * arbitration window closes, which is the only way a race can be fair across
 * phones with different round trips. The first press is what opens that window.
 */
export function buzz(options: {
  state: SessionState;
  playerId: string;
  roundId: string;
  claimedAt: number;
  receivedAt: number;
}): BuzzResult {
  const { state, playerId, roundId, claimedAt, receivedAt } = options;
  const round = state.round;

  if (!round || round.id !== roundId) return { ok: false, error: 'Ce tour est terminé' };
  if (!isBuzzerRound(state)) return { ok: false, error: 'Ce tour ne se joue pas au buzzer' };
  if (round.phase !== 'answering') return { ok: false, error: 'Les réponses ne sont pas ouvertes' };
  if (round.heldAt != null) return { ok: false, error: 'La manche est en pause' };

  const player = state.players[playerId];
  if (!player) return { ok: false, error: 'Joueur inconnu' };

  const buzzState = (round.buzz ??= emptyBuzzState());

  if (buzzState.spent.includes(playerId)) return { ok: false, error: 'Vous avez déjà tenté ce tour' };
  if (buzzState.holderId !== null) return { ok: false, error: 'Quelqu’un a déjà le buzzer' };
  if (buzzState.race.some((press) => press.playerId === playerId)) {
    // Not an error worth showing: the phone already drew itself as pressed.
    return { ok: true, racing: true };
  }

  // Refused rather than clamped once the phase is genuinely over, exactly as an
  // answer is: a press that physically arrived after time cannot win a race.
  if (round.phaseEndsAt !== null && receivedAt > round.phaseEndsAt + 1_500) {
    return { ok: false, error: 'Trop tard' };
  }

  const { answeredAt } = clampAnswerTime(
    claimedAt,
    round.phaseStartAt,
    receivedAt,
    round.timing.answerMs,
    maxCompensationMs(player.rttMs)
  );

  buzzState.race.push({ playerId, pressedAt: answeredAt });
  buzzState.raceClosesAt ??= receivedAt + BUZZ_ARBITRATION_MS;
  state.lastActivityAt = receivedAt;

  return { ok: true, racing: true };
}

/**
 * Closes the arbitration window and hands the buzzer to whoever pressed first.
 *
 * Earliest compensated press wins, ties broken by player id so the outcome never
 * depends on the order packets happened to arrive in — the same tie-break the
 * scorer uses, and for the same reason.
 */
export function resolveBuzzRace(state: SessionState, now = Date.now()): boolean {
  const round = state.round;
  const buzzState = round?.buzz;
  if (!round || !buzzState || buzzState.raceClosesAt === null || buzzState.holderId !== null) return false;

  const winner = [...buzzState.race].sort(
    (a, b) => a.pressedAt - b.pressedAt || a.playerId.localeCompare(b.playerId)
  )[0];

  buzzState.race = [];
  buzzState.raceClosesAt = null;

  // Everybody in the race dropped out between pressing and now, which today can
  // only happen if the race was empty. Reopening is the safe reading either way.
  if (!winner) return false;

  buzzState.holderId = winner.playerId;
  buzzState.windowEndsAt = now + state.config.buzzerWindowMs;
  state.lastActivityAt = now;
  return true;
}

/**
 * The holder's window ran out with nothing right in it.
 *
 * Costs them the round, exactly as a wrong answer does. Staying silent has to be
 * as expensive as being wrong, or the cheapest play in the format is to buzz on
 * every round to deny it to everyone else and simply never answer.
 */
export function expireBuzzWindow(state: SessionState, now = Date.now()): boolean {
  const round = state.round;
  const buzzState = round?.buzz;
  if (!round || !buzzState || buzzState.holderId === null) return false;

  releaseBuzzer(state, buzzState, buzzState.holderId, now);
  return true;
}

/**
 * Takes the buzzer off a player who has spent their shot, and reopens it.
 *
 * When nobody is left who could still press, the round is finished in substance
 * and the phase closes early rather than leaving the room watching a clock that
 * cannot produce another answer.
 */
function releaseBuzzer(state: SessionState, buzzState: BuzzState, playerId: string, now: number): void {
  if (!buzzState.spent.includes(playerId)) buzzState.spent.push(playerId);
  buzzState.holderId = null;
  buzzState.windowEndsAt = null;
  buzzState.race = [];
  buzzState.raceClosesAt = null;
  state.lastActivityAt = now;

  if (everyoneSpent(state, buzzState)) closeAnswers(state, now);
}

/** True when no seat is left that could still take the buzzer. */
function everyoneSpent(state: SessionState, buzzState: BuzzState): boolean {
  const contenders = Object.values(state.players).filter((player) => !buzzState.spent.includes(player.id));
  return contenders.length === 0;
}

/**
 * The next moment the server has to act on this session, and what for.
 *
 * The manager arms exactly one timer per session, which is a property worth
 * keeping: two timers on one round is two ways for a stale one to fire into a
 * phase it no longer belongs to. So the buzzer's two deadlines are folded in here
 * rather than given timers of their own, and the earliest wins.
 */
export type SessionDeadline = { at: number; kind: 'phase' | 'buzz-race' | 'buzz-window' };

export function nextDeadline(state: SessionState): SessionDeadline | null {
  const round = state.round;
  if (state.phase !== 'playing' || !round) return null;
  // A held round has no deadlines at all, the buzzer's two included: the whole
  // of the pause is that nothing fires.
  if (round.heldAt != null) return null;

  const candidates: SessionDeadline[] = [];
  if (round.phaseEndsAt !== null) candidates.push({ at: round.phaseEndsAt, kind: 'phase' });

  if (round.phase === 'answering' && round.buzz) {
    if (round.buzz.raceClosesAt !== null) candidates.push({ at: round.buzz.raceClosesAt, kind: 'buzz-race' });
    if (round.buzz.windowEndsAt !== null) candidates.push({ at: round.buzz.windowEndsAt, kind: 'buzz-window' });
  }

  return candidates.sort((a, b) => a.at - b.at)[0] ?? null;
}

export interface SubmitOptions {
  state: SessionState;
  playerId: string;
  roundId: string;
  fieldKey: string;
  value: string;
  /** Client's claim, already expressed in server time. */
  claimedAt: number;
  receivedAt: number;
}

export interface SubmitResult {
  ok: boolean;
  error?: string;
  correct?: boolean;
  attemptsLeft?: number;
}

/**
 * Records one answer.
 *
 * Correctness is decided here and now, but points are not: they depend on where
 * this answer lands in the finishing order, which is only known when the phase
 * closes.
 */
export function submitAnswer(options: SubmitOptions): SubmitResult {
  const { state, playerId, roundId, fieldKey, value, claimedAt, receivedAt } = options;
  const round = state.round;

  if (!round || round.id !== roundId) {
    return { ok: false, error: 'Ce tour est terminé' };
  }
  if (round.phase !== 'answering') {
    return { ok: false, error: 'Les réponses ne sont pas ouvertes' };
  }
  // Held: the clock is off the room, so nothing lands. Refused rather than
  // queued, because an answer accepted during a pause would be timed against a
  // window that is not running.
  if (round.heldAt != null) {
    return { ok: false, error: 'La manche est en pause' };
  }

  const player = state.players[playerId];
  if (!player) {
    return { ok: false, error: 'Joueur inconnu' };
  }

  // Late packets are refused outright rather than clamped, so an answer that
  // physically arrived after the phase closed cannot score.
  if (round.phaseEndsAt !== null && receivedAt > round.phaseEndsAt + 1_500) {
    return { ok: false, error: 'Trop tard' };
  }

  /**
   * In a race, only the winner of the buzzer may answer.
   *
   * Enforced here rather than by hiding the input, because hiding it is a drawing
   * decision and this is the rule: a phone that kept its keyboard open, or a
   * client written by somebody at the table, must not be able to answer out of
   * turn. The window is checked too, so an answer typed after the buzzer has
   * lapsed loses for the same reason a late packet does.
   */
  if (isBuzzerRound(state)) {
    const buzzState = (round.buzz ??= emptyBuzzState());
    if (buzzState.holderId === null) {
      return { ok: false, error: 'Il faut buzzer d’abord' };
    }
    if (buzzState.holderId !== playerId) {
      return { ok: false, error: 'Ce n’est pas votre tour' };
    }
    if (buzzState.windowEndsAt !== null && receivedAt > buzzState.windowEndsAt + 1_500) {
      return { ok: false, error: 'Trop tard' };
    }
  }

  /**
   * An estimation is a commitment, not an attempt. There is no wrong answer to
   * count, revising the number until the round closes is the format, and only the
   * last value stands, so the whole attempts-and-matching path below does not
   * apply: the previous submission is replaced in place.
   */
  if (round.kind === 'estimation') {
    if (parseEstimate(value) === null) {
      return { ok: false, error: 'Entre un nombre' };
    }

    const compensation = maxCompensationMs(player.rttMs);
    const { answeredAt } = clampAnswerTime(
      claimedAt,
      round.phaseStartAt,
      receivedAt,
      round.timing.answerMs,
      compensation
    );

    const fieldKey = round.answers[0]?.key ?? 'estimate';
    round.submissions = round.submissions.filter((submission) => submission.playerId !== playerId);
    round.submissions.push({
      playerId,
      fieldKey,
      value: value.slice(0, 200),
      answeredAt,
      correct: true,
      direct: false
    });

    state.lastActivityAt = receivedAt;
    return { ok: true, correct: true };
  }

  const mine = round.submissions.filter((submission) => submission.playerId === playerId);

  /**
   * Which prompt the player typed into is a hint, not a binding.
   *
   * A round with several written answers has no order: "1991" answers the year of a
   * film whichever box it was typed into, and it answers it whenever it is typed.
   * The prompt only binds for a field offering choices, where the player is picking
   * from that field's own list. This used to be a check on the kind, which meant only
   * the memory panel worked this way and a three-answer blind test made players aim.
   */
  const named = round.answers.find((candidate) => candidate.key === fieldKey);
  if (!named) {
    return { ok: false, error: 'Champ inconnu' };
  }
  const pooled = !named.choices?.length;

  let field: AnswerField | undefined;
  let correct: boolean;

  if (pooled) {
    const solved = new Set(mine.filter((s) => s.correct).map((s) => s.fieldKey));

    // Spending the whole round's allowance is what closes the pool, since there is
    // no way to lock a single prompt when the player never aimed at one. The budget
    // is the same total as the per-prompt one it replaces.
    if (wrongPooledAttempts(mine, round.answers) >= pooledAttemptBudget(state, round.answers)) {
      return { ok: false, error: "Plus d'essais pour ce tour" };
    }

    const hit = matchAnyField(value, round.answers, solved);

    if (!hit) {
      // Naming something they have already found is a repeat, not a wrong answer.
      // Without this it would be recorded as a miss and, wherever the host has set
      // a penalty, cost them points for saying "lion" twice in a panel of forty.
      const repeat = matchAnyField(value, round.answers, new Set());
      if (repeat && solved.has(repeat.field.key)) {
        return { ok: false, error: 'Déjà trouvé' };
      }
    }

    // A miss leaves `field` undefined, so the wrong guess is recorded against a
    // synthetic key: the penalty applies without pretending they named an item.
    field = hit?.field;
    correct = hit !== null;
  } else {
    field = named;

    if (mine.some((submission) => submission.correct && submission.fieldKey === fieldKey)) {
      return { ok: false, error: 'Déjà trouvé' };
    }

    const wrongAttempts = mine.filter((submission) => submission.fieldKey === fieldKey && !submission.correct).length;

    if (wrongAttempts >= state.config.attemptsPerField) {
      return { ok: false, error: "Plus d'essais pour ce champ" };
    }

    correct = matchAnswer(value, field).matched;
  }

  const compensation = maxCompensationMs(player.rttMs);
  const { answeredAt } = clampAnswerTime(
    claimedAt,
    round.phaseStartAt,
    receivedAt,
    round.timing.answerMs,
    compensation
  );

  // The direct bonus is only earned if they never asked to see the choices.
  const revealed = round.revealedChoices[playerId] ?? [];
  const targetKey = field?.key ?? `__wrong_${fieldKey}`;
  const direct = Boolean(field?.choices?.length) && !revealed.includes(targetKey);

  round.submissions.push({
    playerId,
    fieldKey: targetKey,
    value: value.slice(0, 200),
    answeredAt,
    correct,
    direct
  });

  state.lastActivityAt = receivedAt;

  /**
   * What the buzzer costs, and what it buys.
   *
   * Wrong and the round is over for them: that is the whole risk of pressing, and
   * it is what makes pressing early a gamble rather than a free option.
   *
   * Right and they keep the floor. A blind test asks for a title, an artist and a
   * year, and taking the buzzer off somebody who has just named the title would
   * turn a format built on holding the floor into three separate races with a
   * pause between them. They hold it until the window runs out, they get one
   * wrong, or there is nothing left to name.
   */
  if (isBuzzerRound(state) && round.buzz?.holderId === playerId) {
    if (!correct) {
      releaseBuzzer(state, round.buzz, playerId, receivedAt);
    } else if (allFieldsSolved(round)) {
      closeAnswers(state, receivedAt);
    }
  }

  const after = round.submissions.filter((submission) => submission.playerId === playerId);

  if (pooled) {
    return {
      ok: true,
      correct,
      // What is left for the round, since a pooled guess is not aimed at a prompt.
      attemptsLeft: Math.max(0, pooledAttemptBudget(state, round.answers) - wrongPooledAttempts(after, round.answers))
    };
  }

  const wrongAfter = after.filter((submission) => submission.fieldKey === fieldKey && !submission.correct).length;

  return {
    ok: true,
    correct,
    attemptsLeft: Math.max(0, state.config.attemptsPerField - wrongAfter)
  };
}

/**
 * Every answer on this round has been named by somebody.
 *
 * Judged across the round rather than per player, which is the right reading for a
 * race and the wrong one for the simultaneous format: there, two players are
 * separately racing to name the same three things, and one of them finishing does
 * not end the other's round. Here only one person can be answering at all, so a
 * board with nothing left on it is a round that is over.
 */
function allFieldsSolved(round: RoundState): boolean {
  const solved = new Set(round.submissions.filter((s) => s.correct).map((s) => s.fieldKey));
  return round.answers.length > 0 && round.answers.every((field) => solved.has(field.key));
}

/**
 * Wrong guesses a player may spend on the pooled answers of a round.
 *
 * The same total the per-prompt limit gave: three tries on each of three written
 * answers is nine wrong guesses, they just are not partitioned any more, because a
 * guess that matched nothing cannot be attributed to a prompt. A memory panel of
 * forty items therefore keeps what it always had, which is effectively no limit.
 */
function pooledAttemptBudget(state: SessionState, answers: AnswerField[]): number {
  return state.config.attemptsPerField * Math.max(1, pooledFields(answers).length);
}

/**
 * A player's wrong pooled guesses in this round.
 *
 * Counted from the synthetic `__wrong_*` keys a miss is recorded under, plus any
 * wrong answer landing on a pooled field, which cannot happen today but would stop
 * being counted silently if it ever did.
 */
function wrongPooledAttempts(mine: SubmissionState[], answers: AnswerField[]): number {
  const pooledKeys = new Set(pooledFields(answers).map((field) => field.key));

  return mine.filter(
    (submission) =>
      !submission.correct && (submission.fieldKey.startsWith('__wrong_') || pooledKeys.has(submission.fieldKey))
  ).length;
}

/** Records that a player asked to see the choices, forfeiting the direct bonus. */
export function revealChoices(
  state: SessionState,
  playerId: string,
  roundId: string,
  fieldKey: string
): string[] | null {
  const round = state.round;
  if (!round || round.id !== roundId || round.phase !== 'answering') {
    return null;
  }

  const field = round.answers.find((candidate) => candidate.key === fieldKey);
  if (!field?.choices?.length) {
    return null;
  }

  const revealed = round.revealedChoices[playerId] ?? [];
  if (!revealed.includes(fieldKey)) {
    revealed.push(fieldKey);
    round.revealedChoices[playerId] = revealed;
  }

  return field.choices;
}

/* ------------------------------- projections ------------------------------ */

export interface ViewContext {
  /** Builds the opaque per-round URL for an asset. */
  imageUrl: (source: string) => string;
}

/**
 * Whether the media reaches this particular recipient.
 *
 * One line, but it is the whole of "on the television only": the host screen is
 * a stage unless a phone was appointed, a phone is a stage when it was the one
 * appointed, and everybody is a stage in a room that never asked for a
 * television at all.
 */
function isStageFor(state: SessionState, playerId: string | null): boolean {
  const television = televisionOf(state);
  if (!television.tvOnly) return true;
  return television.tvPlayerId === playerId;
}

function playerViews(state: SessionState): PlayerView[] {
  const totals = new Map(Object.values(state.players).map((player) => [player.id, player.totalScore]));
  const ranked = buildLeaderboard(totals);
  const rankById = new Map(ranked.map((row) => [row.playerId, row.rank]));

  return Object.values(state.players)
    .map((player) => ({
      id: player.id,
      name: player.name,
      connected: player.connected,
      score: player.totalScore,
      rank: rankById.get(player.id) ?? 0,
      title: player.title
    }))
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, 'fr'));
}

/**
 * What one player is allowed to see.
 *
 * Note what is absent: answer values, the explanation, and raw asset paths. This is
 * the only path by which round data reaches a player, so anything not built here
 * cannot leak.
 */
export function toRoundView(state: SessionState, playerId: string | null, context: ViewContext): RoundView | null {
  const round = state.round;
  if (!round) return null;

  const definition = getMediaKind(round.kind);
  const mine = playerId ? round.submissions.filter((submission) => submission.playerId === playerId) : [];
  const solved = mine.filter((submission) => submission.correct).map((submission) => submission.fieldKey);
  const revealed = playerId ? (round.revealedChoices[playerId] ?? []) : [];

  // A pooled answer locks with the round rather than on its own: the player never
  // aimed at it, so there is nothing to lock until the whole allowance is gone.
  const pooledExhausted = wrongPooledAttempts(mine, round.answers) >= pooledAttemptBudget(state, round.answers);

  const locked = round.answers
    .filter((field) => {
      if (!field.choices?.length) {
        return pooledExhausted;
      }
      const wrong = mine.filter((submission) => submission.fieldKey === field.key && !submission.correct).length;
      return wrong >= state.config.attemptsPerField;
    })
    .map((field) => field.key);

  return {
    roundId: round.id,
    index: round.index,
    total: state.order.length,
    kind: round.kind,
    phase: round.phase,
    phaseStartAt: round.phaseStartAt,
    phaseEndsAt: round.phaseEndsAt,
    held: round.heldAt != null,
    answerMs: round.timing.answerMs,
    // Answers are not open during the study phase, so nothing is presented yet
    // beyond what the kind chooses to show.
    presentation: definition.playerPresentation(round.payload, {
      ...context,
      stage: isStageFor(state, playerId)
    }),
    fields: round.answers.map((field) => redactAnswerField(field, revealed.includes(field.key))),
    solvedFieldKeys: solved,
    lockedFieldKeys: locked,
    buzz: toBuzzView(state, playerId)
  };
}

/**
 * The buzzer as one recipient sees it.
 *
 * The holder's *name* is sent rather than left to the client to resolve, because
 * the television and a player's phone both want to say "Marc a buzzé" and only one
 * of them has the roster. Nothing here is a secret: who holds the buzzer is the
 * most public fact in the format.
 */
function toBuzzView(state: SessionState, playerId: string | null): BuzzView | undefined {
  if (!isBuzzerRound(state)) return undefined;
  const buzzState = state.round?.buzz;
  if (!buzzState) return undefined;

  return {
    holderId: buzzState.holderId,
    holderName: buzzState.holderId ? (state.players[buzzState.holderId]?.name ?? null) : null,
    windowEndsAt: buzzState.windowEndsAt,
    racing: buzzState.raceClosesAt !== null,
    spent: playerId !== null && buzzState.spent.includes(playerId)
  };
}

/** Each player's number on an estimation round: last submission per player. */
export function estimationGuesses(round: RoundState): { playerId: string; value: number; answeredAt: number }[] {
  const latest = new Map<string, SubmissionState>();
  for (const submission of round.submissions) {
    latest.set(submission.playerId, submission);
  }

  const guesses: { playerId: string; value: number; answeredAt: number }[] = [];
  for (const submission of latest.values()) {
    const value = parseEstimate(submission.value);
    if (value !== null) {
      guesses.push({ playerId: submission.playerId, value, answeredAt: submission.answeredAt });
    }
  }
  return guesses;
}

/**
 * The library entry this round belongs to, if the room may throw it away.
 *
 * Three conditions, and each one excludes a round it would be wrong to offer a
 * delete button for. A positive media id is somebody's own library item, which
 * the reveal screen has no business deleting from under them. A round with no
 * video code is not a blind test. And one already purged is gone.
 */
function libraryCodeOf(round: RoundState): string | undefined {
  if (round.libraryPurged || round.mediaId >= 0 || round.kind !== 'blindtest') return undefined;
  const code = (round.payload as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

export function toRevealView(state: SessionState): RevealView | null {
  const round = state.round;
  if (!round || round.phase !== 'reveal' || !round.scored) {
    return null;
  }

  const explanation =
    round.kind === 'quiz' ? ((round.payload as { explanation?: string }).explanation ?? undefined) : undefined;

  // On an estimation the guesses are the reveal: everyone's number goes on the
  // television, closest first. No other kind shares who typed what.
  let guesses: RevealView['guesses'];
  if (round.kind === 'estimation') {
    const truth = parseEstimate(round.answers[0]?.value ?? '');
    guesses = estimationGuesses(round)
      .map((guess) => ({
        playerId: guess.playerId,
        name: state.players[guess.playerId]?.name ?? '?',
        value: guess.value,
        delta: truth === null ? 0 : guess.value - truth
      }))
      .sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
  }

  return {
    roundId: round.id,
    answers: round.answers.map((field) => ({ key: field.key, label: field.label, value: field.value })),
    explanation: explanation || undefined,
    guesses,
    libraryCode: libraryCodeOf(round),
    roundScores: Object.entries(round.scored)
      .map(([playerId, points]) => ({
        playerId,
        name: state.players[playerId]?.name ?? '?',
        points,
        comboMultiplier: round.multipliers?.[playerId]?.combo,
        comebackMultiplier: round.multipliers?.[playerId]?.comeback,
        comboLength: state.players[playerId]?.comboLength ?? 0,
        fieldKeys: round.submissions
          .filter((submission) => submission.playerId === playerId && submission.correct)
          .map((submission) => submission.fieldKey)
      }))
      .sort((a, b) => b.points - a.points)
  };
}

/**
 * Full round data for the host screen.
 *
 * Built only when `isHost`, and the host's identity is proved by a token issued when
 * the session was created, so this is the one path where the payload and the answers
 * are allowed out.
 */
function toHostRoundView(state: SessionState, title: string): HostRoundView | null {
  const round = state.round;
  if (!round) return null;

  return {
    roundId: round.id,
    index: round.index,
    total: state.order.length,
    kind: round.kind,
    title,
    phase: round.phase,
    phaseStartAt: round.phaseStartAt,
    phaseEndsAt: round.phaseEndsAt,
    held: round.heldAt != null,
    libraryCode: libraryCodeOf(round),
    answerMs: round.timing.answerMs,
    payload: round.payload,
    answers: round.answers.map((field) => ({
      key: field.key,
      label: field.label,
      value: field.value,
      points: field.points
    }))
  };
}

/**
 * The payload, with nothing that names it.
 *
 * Built for a device that has to present the media and is not the host screen:
 * every phone when the room has no television, or the single phone appointed as
 * one. It borrows the host round's shape minus `title` and `answers`, which are
 * the two fields that would simply print the solution on every phone.
 *
 * Only kinds the host screen normally presents alone get one. Everything else
 * already reaches a player through `presentation`, whose image sources are
 * opaque per-round URLs; handing those kinds the raw payload as well would put
 * the answer in a filename for no gain at all. Today that means the blind test,
 * and it says so by asking the kind rather than by naming it.
 */
function toStageRoundView(state: SessionState): StageRoundView | null {
  const round = state.round;
  if (!round) return null;
  if (!getMediaKind(round.kind).presentedByHost) return null;

  return {
    roundId: round.id,
    index: round.index,
    total: state.order.length,
    kind: round.kind,
    phase: round.phase,
    phaseStartAt: round.phaseStartAt,
    phaseEndsAt: round.phaseEndsAt,
    answerMs: round.timing.answerMs,
    payload: round.payload
  };
}

/**
 * Which device presents the media, resolved against who is actually here.
 *
 * A television that has left the room is not one: the host may have appointed a
 * phone and that phone may have been kicked, or never came back from a tunnel.
 * Rather than leaving the media with nowhere to play, an appointment naming
 * somebody who is no longer seated falls back to the host screen.
 */
function televisionOf(state: SessionState): { tvOnly: boolean; tvPlayerId: string | null } {
  // A quick match has no host screen to be the television, so the setting cannot
  // apply to it whatever a stored config says.
  const tvOnly = state.config.tv && !state.config.autonomous;
  const appointed = state.tvPlayerId ?? null;

  return {
    tvOnly,
    tvPlayerId: appointed !== null && state.players[appointed] ? appointed : null
  };
}

export function toSessionView(
  state: SessionState,
  playerId: string | null,
  isHost: boolean,
  context: ViewContext,
  currentTitle = ''
): SessionView {
  const television = televisionOf(state);

  return {
    code: state.code,
    phase: state.phase,
    // Only when true, so every other game keeps the view it always had.
    ...(state.infinite ? { infinite: true } : {}),
    oral: state.config.oral,
    tvOnly: television.tvOnly,
    tvPlayerId: television.tvPlayerId,
    players: playerViews(state),
    round: toRoundView(state, playerId, context),
    reveal: toRevealView(state),
    isHost,
    hostRound: isHost ? toHostRoundView(state, currentTitle) : null,
    /**
     * The stage goes to every phone unless a television has claimed it.
     *
     * Three ways to be a stage. A quick match never had a television, so every
     * phone is one. A launched game whose host chose "on everybody's device" has
     * not appointed one either, and the media has to reach the people playing or
     * it reaches nobody at all. And a game that has appointed one hands the
     * payload to exactly that phone — the host screen needs no help here, since
     * it already holds the whole round.
     */
    stageRound:
      playerId !== null && (!television.tvOnly || television.tvPlayerId === playerId)
        ? toStageRoundView(state)
        : undefined,
    skipped: isHost ? state.skipped : undefined,
    // The ceremony. An oral game scored nothing, so it has nothing to hand out.
    final:
      state.phase === 'finished' && !state.config.oral
        ? { awards: computeAwards(state), rewards: state.rewards ?? [] }
        : undefined
  };
}
