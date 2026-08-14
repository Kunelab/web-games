import { randomInt, randomUUID } from 'node:crypto';

import {
  buildLeaderboard,
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
  type PlayerView,
  type RevealView,
  type RoundPhase,
  type RoundView,
  type ScoredSubmission,
  type SessionConfig,
  type SessionPhase,
  type SessionView
} from 'game-core';

import type { HostRoundView } from 'game-core';

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
  /** Per-player game-long tallies, for the final awards and the history row. */
  stats?: Record<string, PlayerAggregate>;
  /** Guards the results table against a finished game being recorded twice. */
  resultsRecorded?: boolean;
  lastActivityAt: number;
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
    scored: null
  };
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

    results = scoreRound(
      submissions,
      round.answers,
      round.phaseStartAt,
      round.timing.answerMs,
      state.config.scoring,
      context
    );
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

  round.phase = 'reveal';
  round.phaseStartAt = now;
  round.phaseEndsAt = state.config.autoAdvance ? now + round.timing.revealMs : null;
  state.lastActivityAt = now;
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
    answerMs: round.timing.answerMs,
    // Answers are not open during the study phase, so nothing is presented yet
    // beyond what the kind chooses to show.
    presentation: definition.playerPresentation(round.payload, context),
    fields: round.answers.map((field) => redactAnswerField(field, revealed.includes(field.key))),
    solvedFieldKeys: solved,
    lockedFieldKeys: locked
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

export function toSessionView(
  state: SessionState,
  playerId: string | null,
  isHost: boolean,
  context: ViewContext,
  currentTitle = ''
): SessionView {
  return {
    code: state.code,
    phase: state.phase,
    oral: state.config.oral,
    players: playerViews(state),
    round: toRoundView(state, playerId, context),
    reveal: toRevealView(state),
    isHost,
    hostRound: isHost ? toHostRoundView(state, currentTitle) : null,
    skipped: isHost ? state.skipped : undefined,
    // The ceremony. An oral game scored nothing, so it has nothing to hand out.
    final: state.phase === 'finished' && !state.config.oral ? { awards: computeAwards(state) } : undefined
  };
}
