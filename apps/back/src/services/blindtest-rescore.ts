import type { BlindtestFame } from 'game-core';

import { audienceOf, profileFor, sourceGenreFor, type Genre } from './blindtest-catalog.js';
import {
  fitCalibrations,
  resolveCalibration,
  scoreBreakdown,
  type CalibrationKey,
  type CalibrationSample,
  type FittedCalibration,
  type Scale,
  type ScoreBreakdown
} from './blindtest-difficulty.js';
import { VOCAL_PROFILE, clipWindow, type ChorusInfo, type ClipPlan, type UploadKind } from './chorus-service.js';

/**
 * What a rescoring of the shared catalogue changes, round by round.
 *
 * Every decision of `pnpm --filter back blindtest:rescore` is made here, and
 * nothing else: the script loads the rounds, gathers their figures, calls this,
 * then reports and saves what it says. Three rules matter most, and each was
 * once got wrong:
 *
 *  - **A person's numbers are never touched.** A difficulty or clip marked
 *    `human` stays, and so does any round written after it was filed by a
 *    version that did not mark hand edits yet: filing puts the database's own
 *    timestamp in both `created_at` and `last_modified`, and every later write
 *    leaves an ISO one, so any difference at all is an edit, even a host's
 *    correction made seconds after the round was filed at its reveal.
 *  - **A clip is placed for the difficulty the round will carry**, the kept one
 *    where a person set it: the difficulty decides which part of the song is
 *    asked, and an easy round asked from a verse is a hard round.
 *  - **One scale per genre.** A partial run (one genre, or a few rounds) is
 *    scored against the spreads the server already uses and saves none, since a
 *    spread fitted on a subset is the spread of whatever it happened to read.
 */

/** One catalogue round, as it is stored and with the figures gathered for it. */
export interface RescoreRow {
  id: number;
  /** The genre it is filed under. */
  genre: Genre;
  payload: Record<string, unknown>;
  createdAt: string | null;
  lastModified: string | null;
  /** What it is scored from; null when nothing could be gathered. */
  fame: BlindtestFame | null;
  /** The video's length, when YouTube still has it. Without it the clip stays. */
  durationSeconds: number | null;
  upload: UploadKind;
  /** The chorus of the song its clip plays, when it is a sung work. */
  chorus: ChorusInfo | null;
  hintFraction: number | null;
}

export interface RescoreOptions {
  /** Redo rounds edited before hand edits were marked, as well. */
  includeEdited: boolean;
  /** Only some genres or some rounds: score against `stored`, fit nothing. */
  partial: boolean;
  /** Place clips again where their genre's placement changed. */
  retime: boolean;
  /** The spreads the server uses now. See `readCalibrations`. */
  stored: ReadonlyMap<string, Partial<Record<CalibrationKey, Scale>>>;
  random?: () => number;
}

export interface RescorePlan {
  id: number;
  /** Written after it was filed, by a person or a fix. */
  edited: boolean;
  keepDifficulty: boolean;
  keepTiming: boolean;
  before: number | null;
  /** How the new number came out, kept or not, for the report. */
  score: ScoreBreakdown | null;
  /** The difficulty the round will carry: the new one, or the one it keeps. */
  difficulty: number | null;
  /** Its new clip, or null when the clip stays as it is. */
  clip: ClipPlan | null;
}

/** Whether a round was written after it was filed. See the header. */
export function editedSinceFiled(createdAt: string | null, lastModified: string | null): boolean {
  return createdAt !== null && lastModified !== null && lastModified !== createdAt;
}

/**
 * The genres whose clips are placed differently now: every work genre, and
 * classical for its longer window. Sung music is placed exactly as before.
 */
export function placedAgain(genre: Genre): boolean {
  return profileFor(genre) !== VOCAL_PROFILE;
}

function sampleOf(row: RescoreRow): CalibrationSample | null {
  if (!row.fame) return null;
  const source = sourceGenreFor(row.genre);
  return { genreId: source.id, shape: source.answerShape, audience: audienceOf(row.genre), fame: row.fame };
}

export function planRescore(
  rows: readonly RescoreRow[],
  options: RescoreOptions
): { rows: RescorePlan[]; calibration: FittedCalibration | null } {
  const calibration = options.partial
    ? null
    : fitCalibrations(rows.map(sampleOf).filter((sample): sample is CalibrationSample => sample !== null));
  const scales = calibration ?? options.stored;

  const plans = rows.map((row): RescorePlan => {
    const edited = editedSinceFiled(row.createdAt, row.lastModified);
    const unmarked = (by: unknown) => by === undefined && edited && !options.includeEdited;
    const keepDifficulty = row.payload.difficultyBy === 'human' || unmarked(row.payload.difficultyBy);
    const keepTiming = row.payload.timingBy === 'human' || unmarked(row.payload.timingBy);
    const before = typeof row.payload.difficulty === 'number' ? row.payload.difficulty : null;

    const source = sourceGenreFor(row.genre);
    const score = row.fame
      ? scoreBreakdown(row.fame, {
          shape: source.answerShape,
          audience: audienceOf(row.genre),
          calibration: resolveCalibration(scales, source.id, source.answerShape)
        })
      : null;
    const difficulty = keepDifficulty ? before : (score?.difficulty ?? before);

    const clip =
      options.retime && !keepTiming && row.durationSeconds && placedAgain(row.genre)
        ? clipWindow(row.durationSeconds, {
            profile: profileFor(row.genre),
            difficulty: difficulty ?? 50,
            chorus: row.chorus,
            hintFraction: row.hintFraction,
            upload: row.upload,
            random: options.random
          })
        : null;

    return { id: row.id, edited, keepDifficulty, keepTiming, before, score, difficulty, clip };
  });

  return { rows: plans, calibration };
}
