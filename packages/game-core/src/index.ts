export {
  ANSWER_TOLERANCE,
  answerFieldSchema,
  maxFieldPoints,
  pooledFields,
  redactAnswerField,
  toleranceName,
  type AnswerField,
  type AnswerToleranceName,
  type RedactedAnswerField
} from './media/answer-field.js';

export {
  defineKind,
  type AnyKindDefinition,
  type FieldMeta,
  type KindDefinition,
  type KindTiming,
  type PresentationContext
} from './media/kind-definition.js';

export {
  availableMediaKinds,
  getMediaKind,
  isMediaKind,
  mediaInputSchema,
  mediaKindIds,
  mediaKinds,
  mediaKindSchema,
  parsePayload,
  resolveTiming,
  safeParsePayload,
  timingSchema,
  validateMedia,
  type MediaInput,
  type MediaItem
} from './media/registry.js';

export { mediaReadiness, partitionPlayable, type Readiness } from './media/readiness.js';

export { blindtest, blindtestPayloadSchema, type BlindtestPayload } from './media/kinds/blindtest.js';
export { quiz, quizPayloadSchema, type QuizPayload } from './media/kinds/quiz.js';
export { imageReveal, imageRevealPayloadSchema, type ImageRevealPayload } from './media/kinds/image-reveal.js';
export { imageMemory, imageMemoryPayloadSchema, type ImageMemoryPayload } from './media/kinds/image-memory.js';
export { estimation, estimationPayloadSchema, type EstimationPayload } from './media/kinds/estimation.js';

export { normalizeAnswer, splitArtistTitle } from './matching/normalize.js';
export { boundedLevenshtein } from './matching/levenshtein.js';
export { phoneticFold } from './matching/phonetic.js';
export { matchAnswer, matchAnyField, typoBudget, type MatchResult, type MatchRoute } from './matching/match.js';

export { parseEstimate, scoreEstimationRound, type EstimationGuess } from './scoring/estimation.js';

export {
  buildLeaderboard,
  defaultScoringConfig,
  emptyPlayerRoundScore,
  finalizeRoundScores,
  scoreRound,
  scoringConfigSchema,
  type LeaderboardRow,
  type PlayerRoundScore,
  type RoundBreakdownEntry,
  type RoundContext,
  type ScoredSubmission,
  type ScoringConfig
} from './scoring/score.js';

export {
  CLAIM_TOLERANCE_MS,
  CLOCK_RESYNC_INTERVAL_MS,
  CLOCK_SAMPLE_COUNT,
  MAX_COMPENSATION_MS,
  clampAnswerTime,
  clientClockNow,
  estimateClock,
  maxCompensationMs,
  phaseProgress,
  toServerTime,
  type ClampResult,
  type ClockEstimate,
  type ClockSample
} from './protocol/clock.js';

export {
  JOIN_CODE_LENGTH,
  defaultSessionConfig,
  generateJoinCode,
  isJoinCode,
  joinCodeSchema,
  sessionConfigSchema,
  type FinalAward,
  type HostRoundView,
  type PlayerView,
  type RevealView,
  type RoundPhase,
  type RoundView,
  type SessionConfig,
  type SessionPhase,
  type SessionView,
  type StageRoundView
} from './protocol/session.js';

export {
  SNAPSHOT_ON_EVERY_TRANSITION,
  answerPayloadSchema,
  hostActionSchema,
  joinPayloadSchema,
  revealChoicesPayloadSchema,
  type AnswerAck,
  type AnswerPayload,
  type ClientToServerEvents,
  type ClockPongPayload,
  type JoinAck,
  type JoinPayload,
  type ServerToClientEvents
} from './protocol/events.js';
