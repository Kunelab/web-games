import type { AnswerField } from './answer-field.js';
import { getMediaKind } from './registry.js';

export interface Readiness {
  /** True when this item can be presented in a game. */
  ready: boolean;
  /**
   * Catalogue keys for what is still missing, each a fragment that reads after
   * "Missing:".
   *
   * Keys rather than prose, because this list is computed on the server, crosses
   * the wire in a session's `skipped`, and is then read by a host whose language
   * nobody asked about. It used to be French sentences built here, which is why
   * an English host was told a media item was missing "la vidéo YouTube".
   */
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
    missing.push('miss.answer');
  }

  // A choice field whose choices do not contain its answer can never be won.
  for (const field of item.answers) {
    if (field.choices?.length && field.value.trim() && !field.choices.includes(field.value)) {
      // Said once however many fields are wrong: the sentence used to name the
      // offending field, which is what a key cannot carry, and the editor shows
      // which one it is anyway.
      if (!missing.includes('miss.choiceMissing')) missing.push('miss.choiceMissing');
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
