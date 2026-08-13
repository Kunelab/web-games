import type { AnswerField } from './answer-field.js';
import { getMediaKind } from './registry.js';

export interface Readiness {
  /** True when this item can be presented in a game. */
  ready: boolean;
  /** What is still missing, phrased for display after "Il manque". */
  missing: string[];
}

/**
 * Whether a media item is complete enough to play.
 *
 * Separating this from schema validation is what lets the editor save a
 * half-finished item without a fight, while the game engine still refuses to put
 * an unanswerable round in front of players. Two things are always required
 * regardless of kind: something to present, and at least one answer worth points.
 */
export function mediaReadiness(item: { kind: string; answers: AnswerField[]; payload: unknown }): Readiness {
  const missing: string[] = [];

  const definition = getMediaKind(item.kind);
  missing.push(...definition.missingForPlay(item.payload));

  const scorable = item.answers.filter((field) => field.value.trim().length > 0);
  if (scorable.length === 0) {
    missing.push('au moins une réponse');
  }

  // A choice field whose choices do not contain its answer can never be won.
  for (const field of item.answers) {
    if (field.choices?.length && field.value.trim() && !field.choices.includes(field.value)) {
      // Named by its label where it has one, by its answer otherwise.
      missing.push(`la bonne réponse de « ${field.label.trim() || field.value} » dans ses choix`);
    }
  }

  return { ready: missing.length === 0, missing };
}

/** Splits a playlist into what can be played and what cannot, for the host. */
export function partitionPlayable<T extends { kind: string; answers: AnswerField[]; payload: unknown }>(
  items: T[]
): { playable: T[]; skipped: { item: T; missing: string[] }[] } {
  const playable: T[] = [];
  const skipped: { item: T; missing: string[] }[] = [];

  for (const item of items) {
    const readiness = mediaReadiness(item);
    if (readiness.ready) {
      playable.push(item);
    } else {
      skipped.push({ item, missing: readiness.missing });
    }
  }

  return { playable, skipped };
}
