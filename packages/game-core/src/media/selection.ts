import { z } from 'zod';

/**
 * Which of a playlist's items a room actually plays: the genres the host kept,
 * each within its own difficulty window.
 *
 * The same rule the endless blind test applies to the shared catalogue, pointed
 * at any playlist. It lives here rather than in either app because both need it
 * and must agree to the item: the launch screen counts with it while the host
 * moves the sliders, and the server filters with it when the room opens. A count
 * that drifted from the filter would promise a room forty rounds and deal it
 * twelve.
 */

/** One genre the room keeps, and the difficulty window it plays it in. */
export const genreWindowSchema = z.object({
  /** The item's category as stored, `''` for the items that have none. */
  category: z.string().max(80),
  difficultyMin: z.number().int().min(0).max(100).default(0),
  difficultyMax: z.number().int().min(0).max(100).default(100)
});

export type GenreWindow = z.input<typeof genreWindowSchema>;

/**
 * The genre an item is grouped under: its category, or `''` for none.
 *
 * The category is matched as stored. It is free text on a hand-built item and a
 * genre id on a generated one, and folding case or spaces here would merge two
 * groups the library screen shows apart.
 */
export function genreKeyOf(item: { category: string | null }): string {
  return item.category ?? '';
}

/**
 * Every genre an item plays in: its own first, then the others it was also
 * filed under (`payload.alsoIn`).
 *
 * A catalogue round has one genre that decides its difficulty scale and its
 * answer prompt, and may be listed in more: a Stromae song is chanson and
 * electro, a 2003 rap hit is rap and its era. A room that keeps any of them
 * hears it.
 */
export function genreKeysOf(item: { category: string | null; payload?: unknown }): string[] {
  const own = genreKeyOf(item);
  return [own, ...alsoInOf(item.payload).filter((other) => other !== own)];
}

/** The other genres in a payload, `[]` for none or a malformed list. */
export function alsoInOf(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const list = (payload as { alsoIn?: unknown }).alsoIn;
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((entry): entry is string => typeof entry === 'string' && entry !== ''))];
}

/**
 * The difficulty stored on an item, or null when it has none.
 *
 * Only blind tests carry one today, and an old one may not. Read from the
 * payload without knowing the kind, so the next kind that grows the field is
 * filtered by it for free.
 */
export function mediaDifficulty(item: { payload: unknown }): number | null {
  if (typeof item.payload !== 'object' || item.payload === null) return null;
  const rating = (item.payload as { difficulty?: unknown }).difficulty;
  return typeof rating === 'number' && Number.isFinite(rating) ? rating : null;
}

/**
 * The items the room keeps, in the order they came.
 *
 * An item none of whose genres is listed is dropped; one listed in several is
 * kept when any of their windows takes it. One with no difficulty stays,
 * whatever the window: "unknown" must not read as "too hard", or a narrow window
 * over a quiz of hand-written questions would quietly empty it. The window's ends
 * are ordered on read, so a slider dragged past itself still means something.
 */
export function selectByGenre<T extends { category: string | null; payload: unknown }>(
  items: readonly T[],
  genres: readonly GenreWindow[]
): T[] {
  const windows = new Map<string, { min: number; max: number }>();
  for (const genre of genres) {
    const low = genre.difficultyMin ?? 0;
    const high = genre.difficultyMax ?? 100;
    windows.set(genre.category, { min: Math.min(low, high), max: Math.max(low, high) });
  }

  return items.filter((item) => {
    const rating = mediaDifficulty(item);
    return genreKeysOf(item).some((key) => {
      const window = windows.get(key);
      if (!window) return false;
      return rating === null || (rating >= window.min && rating <= window.max);
    });
  });
}
