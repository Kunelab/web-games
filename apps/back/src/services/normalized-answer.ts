import { normalizeAnswer } from 'game-core';

/**
 * `normalizeAnswer`, remembered.
 *
 * The catalogue's titles and artists are normalised on every look at it: the
 * duplicate filter before every launch and every count, the recording keys
 * before every draw, two strings per entry each time and the same strings
 * every time. The function is pure, so its answer for a string never changes
 * and is worth keeping.
 */
const remembered = new Map<string, string>();

/** Room for the catalogue's titles and artists several times over, then a fresh start. */
const MAX_REMEMBERED = 120_000;

export function normalizedAnswer(value: string): string {
  let result = remembered.get(value);
  if (result === undefined) {
    if (remembered.size >= MAX_REMEMBERED) remembered.clear();
    result = normalizeAnswer(value);
    remembered.set(value, result);
  }
  return result;
}
