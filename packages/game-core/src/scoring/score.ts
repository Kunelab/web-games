import { z } from 'zod';

import type { AnswerField } from '../media/answer-field.js';

/**
 * Declared separately so its own defaults can seed the parent's default. Nesting
 * the literal inline is what zod cannot do: a nested `.default({})` has to be given
 * the fully-populated shape, not the input shape.
 */
const comboSchema = z.object({
  enabled: z.boolean().default(false),
  /** Added to the multiplier per consecutive win: 1.1, 1.2, 1.3… */
  step: z.number().min(0).max(1).default(0.1),
  /** Ceiling, so a runaway leader cannot reach four times points. */
  max: z.number().min(1).max(5).default(2)
});

const comebackSchema = z.object({
  enabled: z.boolean().default(false),
  /** Share of the field, ranked from the bottom, that may qualify. */
  bottomShare: z.number().min(0).max(1).default(0.3),
  /** How far behind the leader it takes to qualify, as a share of their score. */
  minGap: z.number().min(0).max(1).default(0.35),
  /** Ceiling on the multiplier, reached by someone almost at zero. */
  max: z.number().min(1).max(3).default(1.5)
});

export const scoringConfigSchema = z.object({
  /**
   * Multiplier applied to a field's points by finishing order, index 0 being the
   * first player to get that field right. Position is the dominant term by
   * design: being first should beat being fast-but-second.
   */
  positionMultipliers: z.array(z.number().min(0).max(10)).min(1).default([1, 0.7, 0.5, 0.35, 0.25]),

  /** Multiplier for anyone finishing beyond the array above. */
  tailMultiplier: z.number().min(0).max(10).default(0.15),

  /**
   * Extra points for answering instantly, decaying linearly to zero at the end of
   * the answer phase. Kept small relative to the position term: it breaks ties
   * between players in the same position band rather than driving the ranking.
   */
  speedBonusMax: z.number().min(0).max(20).default(1),

  /**
   * Extra points for being fast *compared to the others who got it*, rather than
   * against the clock.
   *
   * These measure different things and a party game wants both. On an easy round
   * everyone answers in the first five seconds, so the clock-based bonus pays out
   * almost in full to everybody and separates nobody; on a hard round the only
   * person who gets it may take twenty seconds and, judged by the clock alone, is
   * barely rewarded for having been the one who knew. This term is spread across
   * the answers actually given: fastest takes it all, slowest takes none, and a
   * lone correct answer takes all of it.
   */
  relativeSpeedBonusMax: z.number().min(0).max(20).default(1),

  /** Subtracted for a wrong answer. Above zero this discourages spamming. */
  wrongAnswerPenalty: z.number().min(0).max(20).default(0),

  /** Points for getting every field on an item right. */
  perfectRoundBonus: z.number().min(0).max(50).default(0),

  /**
   * Rewards winning rounds back to back.
   *
   * Off by default because it is a deliberate choice about what kind of game this
   * is: a combo rewards a run of form and makes a hot streak worth watching, and it
   * also widens the gap the leader already has, which is why it pairs with the
   * comeback rule below.
   */
  combo: comboSchema.default(comboSchema.parse({})),

  /**
   * Helps the back of the field while the game is still winnable.
   *
   * Both conditions have to hold: last by rank and genuinely far behind. Boosting
   * whoever happens to be last in a close game would punish a good player for a
   * single bad round, which is the opposite of the intent. It multiplies what they
   * earn rather than handing out points, so a comeback still has to be played.
   */
  comeback: comebackSchema.default(comebackSchema.parse({}))
});

export type ScoringConfig = z.infer<typeof scoringConfigSchema>;

export const defaultScoringConfig: ScoringConfig = scoringConfigSchema.parse({});

/** One accepted answer, as the server recorded it. */
export interface ScoredSubmission {
  playerId: string;
  fieldKey: string;
  /** Lag-compensated moment the player answered, in server time. */
  answeredAt: number;
  correct: boolean;
  /** True when the player answered a choice field without revealing the choices. */
  direct: boolean;
}

export interface RoundBreakdownEntry {
  fieldKey: string;
  /** Zero-based finishing position among correct answers for this field. */
  position: number;
  basePoints: number;
  positionMultiplier: number;
  /** From the clock: how much of the answer window was left. */
  speedBonus: number;
  /** From the other players: how they placed against everyone who got it. */
  relativeSpeedBonus: number;
  directBonus: number;
  total: number;
}

export interface PlayerRoundScore {
  playerId: string;
  total: number;
  entries: RoundBreakdownEntry[];
  penalties: number;
  perfectBonus: number;
  /** What the answers were worth before the two multipliers below. */
  earned: number;
  /** 1 when no combo is running or the rule is off. */
  comboMultiplier: number;
  /** 1 when the player does not qualify or the rule is off. */
  comebackMultiplier: number;
  /** Consecutive round wins including this one, to carry into the next round. */
  comboLength: number;
}

/**
 * What the scorer needs to know about the rounds already played.
 *
 * Optional, and everything degrades to the plain per-round model without it: the
 * combo and the comeback are the only parts of scoring that are not a pure function
 * of one round, so they are the only reason this exists.
 */
export interface RoundContext {
  /** Cumulative totals before this round, keyed by player. Also names the room. */
  previousTotals?: ReadonlyMap<string, number>;
  /** Consecutive wins each player brought into this round. */
  comboLengths?: ReadonlyMap<string, number>;
}

/** Below this a "bottom 30%" is not a group, it is just whoever is losing. */
const MIN_PLAYERS_FOR_COMEBACK = 3;

function positionMultiplier(config: ScoringConfig, position: number): number {
  return config.positionMultipliers[position] ?? config.tailMultiplier;
}

/**
 * Scores one round.
 *
 * Position is resolved per field, not per round, which is what makes the model
 * work across every kind: on a blind test one player can take the position bonus
 * on the title while another takes it on the year, and on a memory panel each of
 * the twenty faces is its own race.
 *
 * `roundStartAt` and `answerMs` bound the speed term. Submissions are expected to
 * be pre-clamped into that window by the caller, which is where the lag
 * compensation lives.
 */
export function scoreRound(
  submissions: ScoredSubmission[],
  fields: AnswerField[],
  roundStartAt: number,
  answerMs: number,
  config: ScoringConfig = defaultScoringConfig,
  context: RoundContext = {}
): PlayerRoundScore[] {
  const fieldsByKey = new Map(fields.map((field) => [field.key, field]));
  const scores = new Map<string, PlayerRoundScore>();

  const ensure = (playerId: string): PlayerRoundScore => {
    let score = scores.get(playerId);
    if (!score) {
      score = emptyPlayerRoundScore(playerId);
      scores.set(playerId, score);
    }
    return score;
  };

  // Wrong answers are penalised regardless of ordering.
  for (const submission of submissions) {
    if (!submission.correct) {
      const score = ensure(submission.playerId);
      score.penalties += config.wrongAnswerPenalty;
    }
  }

  for (const field of fields) {
    const correct = submissions
      .filter((submission) => submission.correct && submission.fieldKey === field.key)
      // Ties broken by player id so the result never depends on arrival order.
      .sort((a, b) => a.answeredAt - b.answeredAt || a.playerId.localeCompare(b.playerId));

    // A player could have submitted twice; only their first correct one counts.
    const seen = new Set<string>();
    const firstOfField = correct[0]?.answeredAt ?? roundStartAt;
    const lastOfField = correct.at(-1)?.answeredAt ?? firstOfField;
    let position = 0;

    for (const submission of correct) {
      if (seen.has(submission.playerId)) {
        continue;
      }
      seen.add(submission.playerId);

      const multiplier = positionMultiplier(config, position);
      const elapsed = Math.max(0, Math.min(submission.answeredAt - roundStartAt, answerMs));
      const speedBonus = answerMs > 0 ? config.speedBonusMax * (1 - elapsed / answerMs) : 0;

      // Where they came in the field's own race. A single correct answer spans no
      // time at all, and takes the whole bonus rather than dividing by zero.
      const spread = lastOfField - firstOfField;
      const share = spread > 0 ? (submission.answeredAt - firstOfField) / spread : 0;
      const relativeSpeedBonus = config.relativeSpeedBonusMax * (1 - share);

      const directBonus = submission.direct ? field.directBonus : 0;

      const entry: RoundBreakdownEntry = {
        fieldKey: field.key,
        position,
        basePoints: field.points,
        positionMultiplier: multiplier,
        speedBonus: round2(speedBonus),
        relativeSpeedBonus: round2(relativeSpeedBonus),
        directBonus,
        total: round2(field.points * multiplier + speedBonus + relativeSpeedBonus + directBonus)
      };

      const score = ensure(submission.playerId);
      score.entries.push(entry);
      score.earned = round2(score.earned + entry.total);
      position += 1;
    }
  }

  if (config.perfectRoundBonus > 0 && fields.length > 0) {
    for (const score of scores.values()) {
      const distinctFields = new Set(score.entries.map((entry) => entry.fieldKey));
      const gotEverything = fields.every((field) => distinctFields.has(field.key));
      if (gotEverything && distinctFields.size === fieldsByKey.size) {
        score.perfectBonus = config.perfectRoundBonus;
      }
    }
  }

  return finalizeRoundScores(scores, config, context);
}

/**
 * The tail every round scorer shares: multipliers, ranking, streak bookkeeping.
 *
 * Split out so a kind that earns points differently, as the estimation round does
 * with its distance ranking, still goes through exactly the same combo and comeback
 * rules as everyone else. Two ways of earning, one way of settling.
 */
export function finalizeRoundScores(
  scores: Map<string, PlayerRoundScore>,
  config: ScoringConfig,
  context: RoundContext
): PlayerRoundScore[] {
  applyMultipliers(scores, config, context);

  const ranked = [...scores.values()].sort((a, b) => b.total - a.total || a.playerId.localeCompare(b.playerId));

  awardCombos(ranked, context);

  return ranked;
}

/** A zeroed score row, exported for scorers that build their own entries. */
export function emptyPlayerRoundScore(playerId: string): PlayerRoundScore {
  return {
    playerId,
    total: 0,
    entries: [],
    penalties: 0,
    perfectBonus: 0,
    earned: 0,
    comboMultiplier: 1,
    comebackMultiplier: 1,
    comboLength: 0
  };
}

/**
 * Turns what each player earned into what they score.
 *
 * The two multipliers apply to the answers only. Penalties are deliberately left
 * out of them, because multiplying a penalty by a comeback bonus would punish the
 * player it is meant to help, and so is the perfect-round bonus, which is a flat
 * reward for a specific achievement rather than part of the race.
 */
function applyMultipliers(scores: Map<string, PlayerRoundScore>, config: ScoringConfig, context: RoundContext): void {
  const eligible = comebackEligibility(config, context);

  for (const score of scores.values()) {
    if (config.combo.enabled) {
      const streak = context.comboLengths?.get(score.playerId) ?? 0;
      score.comboMultiplier = Math.min(config.combo.max, 1 + config.combo.step * streak);
    }

    if (config.comeback.enabled) {
      score.comebackMultiplier = eligible.get(score.playerId) ?? 1;
    }

    const boosted = score.earned * score.comboMultiplier * score.comebackMultiplier;
    score.total = round2(boosted + score.perfectBonus - score.penalties);
  }
}

/**
 * Who gets a comeback multiplier this round, and how much.
 *
 * Scaled by the size of the gap rather than granted flat, so the player who is
 * nearly lapped gets the most and the one who has just slipped into the bottom
 * third gets almost nothing. Everything is decided from the standings *before* this
 * round, which is what makes it predictable: the boost is announced by the position
 * you were in, not by how the round you are playing turns out.
 */
function comebackEligibility(config: ScoringConfig, context: RoundContext): Map<string, number> {
  const multipliers = new Map<string, number>();
  const totals = context.previousTotals;

  if (!config.comeback.enabled || !totals || totals.size < MIN_PLAYERS_FOR_COMEBACK) {
    return multipliers;
  }

  const standings = [...totals.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  const leader = standings.at(-1)?.[1] ?? 0;

  // Nobody is behind in a game where nobody has scored.
  if (leader <= 0) {
    return multipliers;
  }

  const slots = Math.max(1, Math.floor(standings.length * config.comeback.bottomShare));

  for (const [playerId, total] of standings.slice(0, slots)) {
    const gap = (leader - total) / leader;
    if (gap < config.comeback.minGap) {
      continue;
    }
    multipliers.set(playerId, Math.min(config.comeback.max, 1 + gap));
  }

  return multipliers;
}

/**
 * Extends the winner's streak and ends everyone else's.
 *
 * The winner is the round's top scorer rather than whoever was first to buzz, which
 * is the same thing on a one-answer quiz and the fairer reading on a blind test
 * where four separate fields are in play. A tie extends nobody's streak: a combo is
 * a claim to have been the best in the round, and a tie is not one.
 *
 * A player who submitted nothing does not appear in the results at all, so the
 * caller has to treat a missing entry as a streak of zero. That is the correct
 * reading anyway: sitting a round out ends a run.
 *
 * Judged on what was earned rather than on the final total, and that is the whole
 * point: scoring the winner after the multipliers have been applied would let a
 * combo win the next round on its own, keeping the streak alive because it is
 * already alive. The streak has to be re-earned every round at face value.
 */
function awardCombos(ranked: PlayerRoundScore[], context: RoundContext): void {
  const byEarned = [...ranked].sort((a, b) => b.earned - a.earned || a.playerId.localeCompare(b.playerId));
  const [best, runnerUp] = byEarned;
  const winner = best && best.earned > 0 && best.earned !== runnerUp?.earned ? best.playerId : null;

  for (const score of ranked) {
    const previous = context.comboLengths?.get(score.playerId) ?? 0;
    score.comboLength = score.playerId === winner ? previous + 1 : 0;
  }
}

/** Two decimals: scores stay readable without float noise in the UI. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface LeaderboardRow {
  playerId: string;
  total: number;
  rank: number;
}

/** Cumulative standings, with ties sharing a rank. */
export function buildLeaderboard(totals: Map<string, number>): LeaderboardRow[] {
  const rows = [...totals.entries()]
    .map(([playerId, total]) => ({ playerId, total: round2(total), rank: 0 }))
    .sort((a, b) => b.total - a.total || a.playerId.localeCompare(b.playerId));

  let lastTotal: number | null = null;
  let lastRank = 0;

  rows.forEach((row, index) => {
    if (lastTotal !== null && row.total === lastTotal) {
      row.rank = lastRank;
    } else {
      row.rank = index + 1;
      lastRank = row.rank;
      lastTotal = row.total;
    }
  });

  return rows;
}
