import type { AnswerField } from '../media/answer-field.js';
import {
  emptyPlayerRoundScore,
  finalizeRoundScores,
  type PlayerRoundScore,
  type RoundContext,
  type ScoringConfig
} from './score.js';

/**
 * Scoring for the estimation round: everyone names a number, closest wins.
 *
 * Nothing here is about speed, deliberately. The point of an estimation question is
 * the number, and rewarding the fast answer would punish the player who spent the
 * clock actually estimating. Order comes from distance alone; the submission time
 * only breaks an exact tie, favouring whoever committed to the number first.
 */

/** One player's number, the last one they entered before the round closed. */
export interface EstimationGuess {
  playerId: string;
  value: number;
  /** Lag-compensated server time, used only to break distance ties. */
  answeredAt: number;
}

/**
 * Reads a number the way a phone keyboard writes one.
 *
 * French players type "1 234,5" as readily as "1234.5", so grouping spaces are
 * dropped and a comma is accepted as the decimal separator when it is the only
 * separator present. Anything else non-numeric refuses to parse rather than
 * guessing: a wrong reading here silently mis-scores a round.
 */
export function parseEstimate(raw: string): number | null {
  let text = raw.trim().replace(/\s/g, '');
  if (!text) return null;

  const commas = (text.match(/,/g) ?? []).length;
  const dots = (text.match(/\./g) ?? []).length;

  if (commas === 1 && dots === 0) {
    text = text.replace(',', '.');
  } else if (commas > 0) {
    // "1,234,567" is grouping, not decimals; with a dot present the commas are too.
    text = text.replace(/,/g, '');
  }

  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    return null;
  }

  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * Scores one estimation round.
 *
 * Players are ranked by distance from the truth and paid through the same position
 * multipliers as every other kind, so "closest wins, second-closest takes less" costs
 * no new configuration. Equal distances share the position (over and under by the
 * same margin are the same answer quality), and landing exactly on the value earns
 * half the base points again, because calling the number precisely deserves more
 * than winning the ranking.
 *
 * The result goes through `finalizeRoundScores`, so combos and comebacks apply here
 * exactly as everywhere else.
 */
export function scoreEstimationRound(
  guesses: EstimationGuess[],
  field: AnswerField,
  config: ScoringConfig,
  context: RoundContext = {}
): PlayerRoundScore[] {
  const truth = parseEstimate(field.value);
  const scores = new Map<string, PlayerRoundScore>();

  if (truth === null) {
    // An unparseable authored answer scores nobody rather than crashing the round.
    return finalizeRoundScores(scores, config, context);
  }

  const ordered = [...guesses].sort((a, b) => {
    const byDistance = Math.abs(a.value - truth) - Math.abs(b.value - truth);
    return byDistance || a.answeredAt - b.answeredAt || a.playerId.localeCompare(b.playerId);
  });

  let position = 0;
  let previousDistance: number | null = null;

  ordered.forEach((guess, index) => {
    const distance = Math.abs(guess.value - truth);

    // Standard competition ranking: equal distances share, the next distance
    // resumes at how many players are ahead of it.
    if (previousDistance === null || distance > previousDistance) {
      position = index;
      previousDistance = distance;
    }

    const multiplier = config.positionMultipliers[position] ?? config.tailMultiplier;
    const exactBonus = distance === 0 ? round2(field.points / 2) : 0;
    const total = round2(field.points * multiplier + exactBonus);

    const score = emptyPlayerRoundScore(guess.playerId);
    score.entries.push({
      fieldKey: field.key,
      position,
      basePoints: field.points,
      positionMultiplier: multiplier,
      speedBonus: 0,
      relativeSpeedBonus: 0,
      directBonus: exactBonus,
      total
    });
    score.earned = total;
    scores.set(guess.playerId, score);
  });

  return finalizeRoundScores(scores, config, context);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
