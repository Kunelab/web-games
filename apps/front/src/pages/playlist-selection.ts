import { genreKeyOf, mediaDifficulty, selectByGenre, type GenreWindow } from 'game-core';

/**
 * What the launch screen keeps of a playlist, as state and as a request.
 *
 * Plain functions beside the panel (`PlaylistSource`) rather than inside it, so
 * the launch screen can turn the same state into the start request and the
 * count, and so both are testable without rendering anything.
 */

/**
 * What the selection reads of a media. The API's `MediaItem` has all of it;
 * naming only this keeps the module, and its test, clear of the API client.
 */
export interface Selectable {
  category: string | null;
  payload: unknown;
  readiness: { ready: boolean };
}

export interface Range {
  min: number;
  max: number;
}

export interface PlaylistFilter {
  /** Genres set aside, by `genreKeyOf`. Everything else plays. */
  excluded: ReadonlySet<string>;
  difficulty: Range;
  /** A window per genre, once the host asks for one; null applies `difficulty` to every genre. */
  perGenre: Readonly<Record<string, Range>> | null;
  /** Null plays everything kept. */
  maxRounds: number | null;
}

export const OPEN_FILTER: PlaylistFilter = {
  excluded: new Set(),
  difficulty: { min: 0, max: 100 },
  perGenre: null,
  maxRounds: null
};

/** The lengths offered, kept to those shorter than what is left to play. */
export const LENGTHS = [10, 20, 30, 50, 100] as const;

export function ordered(range: Range): Range {
  return { min: Math.min(range.min, range.max), max: Math.max(range.min, range.max) };
}

/** The window a genre is played in: its own once there is one, the shared one until then. */
export function windowOf(filter: PlaylistFilter, key: string): Range {
  return ordered(filter.perGenre?.[key] ?? filter.difficulty);
}

/**
 * The request a filter makes, and how many media it keeps.
 *
 * Nothing narrowed sends no genres at all, which the server reads as the whole
 * playlist: the same request a launch made before this screen asked anything.
 * Counted with `selectByGenre`, the rule the server filters with, so the number
 * on screen is the number the room is dealt.
 */
export function playlistSelection(
  items: readonly Selectable[],
  filter: PlaylistFilter
): { genres?: GenreWindow[]; maxRounds?: number; kept: number } {
  const ready = items.filter((item) => item.readiness.ready);
  const keys = [...new Set(ready.map(genreKeyOf))];
  const shared = ordered(filter.difficulty);
  const open = filter.excluded.size === 0 && filter.perGenre === null && shared.min <= 0 && shared.max >= 100;

  const genres = open
    ? undefined
    : keys
        .filter((key) => !filter.excluded.has(key))
        .map((key) => {
          const window = windowOf(filter, key);
          return { category: key, difficultyMin: window.min, difficultyMax: window.max };
        });
  const kept = genres ? selectByGenre(ready, genres).length : ready.length;
  const maxRounds = filter.maxRounds !== null && filter.maxRounds < kept ? filter.maxRounds : undefined;
  return { genres, maxRounds, kept };
}

/** Whether a playlist has anything for the panel to narrow: genres, difficulties, or length. */
export function hasChoices(items: readonly Selectable[]): boolean {
  const ready = items.filter((item) => item.readiness.ready);
  return (
    new Set(ready.map(genreKeyOf)).size > 1 ||
    ready.some((item) => mediaDifficulty(item) !== null) ||
    ready.length > LENGTHS[0]
  );
}
