import { and, eq, isNull } from 'drizzle-orm';
import { normalizeAnswer } from 'game-core';

import { db } from '../db/index.js';
import { blindtestGenreDismissals, media } from '../db/schema.js';
import { GENRES, genreById, type AnswerShape } from './blindtest-catalog.js';
import { listLibrary } from './blindtest-library.js';
import { seedIndex, type SeedIndex } from './blindtest-seeds.js';
import { toMediaView, type MediaView } from './media-service.js';

/**
 * Catalogue entries filed under the wrong genre, for the admin to settle.
 *
 * The sibling of the duplicate check, and built the same way: cheap rules over
 * the whole `Tout (généré)` playlist, each flag a question rather than a
 * verdict. A genre is decided once, when a round is generated, by whichever
 * search happened to find it, and YouTube search has no idea what a genre is:
 * a search for rap returns pop, and a pop song kept from it is filed as rap for
 * every room that plays the catalogue afterwards.
 *
 * Five reasons, strongest first:
 *
 *  - `unknown-genre`: the category names no genre at all (a genre removed or
 *    renamed since the row was kept). Nothing can be dealt from it.
 *  - `wrong-shape`: a work genre holding an artist and a title, or the other
 *    way round. The answer boxes the room sees cannot fit the genre.
 *  - `label-disagrees`: a work whose prompt names another genre's work, such
 *    as "Film" on a row filed under anime openings.
 *  - `seed-elsewhere`: the seed catalogues list this artist or work under other
 *    genres and never under this one. The strongest evidence available,
 *    because it was written by people whose job is exactly that.
 *  - `artist-elsewhere`: every other entry by this artist, two or more of them,
 *    sits in one other genre.
 *
 * And, apart from those, the entries still carrying the old `field.work`
 * prompt ("film, series or game") from before each genre named its work. Not a
 * genre question and not dismissable: it is a stale value, and confirming the
 * genre rewrites it.
 */

export type GenreFlagReason =
  'unknown-genre' | 'wrong-shape' | 'label-disagrees' | 'seed-elsewhere' | 'artist-elsewhere';

export interface GenreFlag {
  mediaId: number;
  reason: GenreFlagReason;
  /** Genres the evidence points at, best first. May be empty. */
  suggestions: string[];
}

export interface GenreCheck {
  flags: GenreFlag[];
  /** Entries whose work prompt is still the old catch-all. */
  legacyLabels: number[];
}

/** The part of a catalogue entry the check reads. */
export interface GenreCheckItem {
  id: number;
  category: string | null;
  answers: { key: string; label: string; value: string }[];
}

/** The part of a genre the check reads. The catalogue's `Genre` fits it. */
export interface GenreInfo {
  id: string;
  answerShape: AnswerShape;
  workLabel?: string;
  artistLabel?: string;
  titleLabel?: string;
  facetOf?: string;
}

/** Which answer shape an entry has, from its fields. */
export function shapeOf(item: { answers: { key: string }[] }): AnswerShape | null {
  if (item.answers.some((answer) => answer.key === 'work')) return 'work';
  if (item.answers.some((answer) => answer.key === 'artist' || answer.key === 'title')) return 'artist-title';
  return null;
}

/** The pool a genre reads: a facet counts as its parent. */
function familyOf(genre: GenreInfo): string {
  return genre.facetOf ?? genre.id;
}

/** Pure, for the tests: every flag the rules raise, dismissals honoured. */
export function checkGenres(
  items: GenreCheckItem[],
  genres: readonly GenreInfo[],
  index: SeedIndex,
  dismissed: ReadonlyMap<number, string>
): GenreCheck {
  const byId = new Map(genres.map((genre) => [genre.id, genre]));
  const value = (item: GenreCheckItem, key: string) => item.answers.find((answer) => answer.key === key)?.value ?? '';

  // How the catalogue itself files each artist, by genre family.
  const artistFamilies = new Map<string, Map<string, number>>();
  for (const item of items) {
    if (shapeOf(item) !== 'artist-title') continue;
    const genre = item.category ? byId.get(item.category) : undefined;
    const artist = normalizeAnswer(value(item, 'artist'));
    if (!genre || !artist) continue;
    const counts = artistFamilies.get(artist) ?? new Map<string, number>();
    counts.set(familyOf(genre), (counts.get(familyOf(genre)) ?? 0) + 1);
    artistFamilies.set(artist, counts);
  }

  const flags: GenreFlag[] = [];
  const legacyLabels: number[] = [];

  for (const item of items) {
    const shape = shapeOf(item);
    if (!shape) continue;

    const workAnswer = item.answers.find((answer) => answer.key === 'work');
    if (workAnswer?.label === 'field.work') legacyLabels.push(item.id);

    const key = normalizeAnswer(shape === 'work' ? value(item, 'work') : value(item, 'artist'));
    const seeded = key ? (shape === 'work' ? index.works.get(key) : index.artists.get(key)) : undefined;
    const seededOfShape = [...(seeded ?? [])].filter((id) => byId.get(id)?.answerShape === shape);

    const flag = ((): Omit<GenreFlag, 'mediaId'> | null => {
      const genre = item.category ? byId.get(item.category) : undefined;
      if (!genre) return { reason: 'unknown-genre', suggestions: seededOfShape };
      if (genre.answerShape !== shape) return { reason: 'wrong-shape', suggestions: seededOfShape };

      // A prompt that is another genre's own: the row was moved without it, or
      // the other way round. A prompt somebody typed by hand is left alone.
      if (workAnswer && workAnswer.label !== 'field.work' && workAnswer.label !== (genre.workLabel ?? 'field.work')) {
        const named = genres.filter((other) => other.workLabel === workAnswer.label).map((other) => other.id);
        if (named.length > 0) return { reason: 'label-disagrees', suggestions: named };
      }

      const family = familyOf(genre);
      if (seeded && seeded.size > 0 && !seeded.has(family) && index.harvested.has(family)) {
        return { reason: 'seed-elsewhere', suggestions: seededOfShape.filter((id) => id !== family) };
      }

      if (shape === 'artist-title' && key) {
        const counts = artistFamilies.get(key);
        if (counts) {
          // This entry is one of the count for its own family.
          const alongside = (counts.get(family) ?? 0) - 1;
          const elsewhere = [...counts.entries()].filter(([other]) => other !== family);
          const total = elsewhere.reduce((sum, [, n]) => sum + n, 0);
          if (alongside === 0 && total >= 2) {
            return {
              reason: 'artist-elsewhere',
              suggestions: elsewhere.sort((left, right) => right[1] - left[1]).map(([other]) => other)
            };
          }
        }
      }
      return null;
    })();

    if (flag && dismissed.get(item.id) !== item.category) flags.push({ mediaId: item.id, ...flag });
  }

  return { flags, legacyLabels };
}

/** The catalogue's genre flags as they stand. */
export async function findLibraryGenreFlags(): Promise<GenreCheck> {
  const items = await listLibrary();
  const dismissals = db.select().from(blindtestGenreDismissals).all();
  return checkGenres(items, GENRES, seedIndex(), new Map(dismissals.map((row) => [row.media_id, row.category])));
}

/** A catalogue row, which is what these writes are allowed to touch: ownerless blind test entries. */
async function libraryRow(mediaId: number) {
  const [row] = await db
    .select()
    .from(media)
    .where(and(eq(media.id, mediaId), isNull(media.user_id), eq(media.kind, 'blindtest')))
    .limit(1);
  return row;
}

/**
 * "This genre is right", for the genre the entry has now.
 *
 * Moving it later makes a new claim that the check will judge again.
 */
export async function dismissGenreFlag(mediaId: number): Promise<boolean> {
  const row = await libraryRow(mediaId);
  if (!row?.category) return false;
  db.insert(blindtestGenreDismissals)
    .values({ media_id: mediaId, category: row.category })
    .onConflictDoUpdate({ target: blindtestGenreDismissals.media_id, set: { category: row.category } })
    .run();
  return true;
}

/**
 * The answers of an entry moved to `genre`: its work prompt follows.
 *
 * The prompt is the genre's own ("Anime (opening)", "Jeu vidéo"), so an entry
 * moved from films to games without it would keep asking for a film. Only the
 * stock prompts are rewritten; a label somebody typed by hand stays theirs.
 */
export function answersForGenre<T extends { key: string; label: string }>(answers: T[], genre: GenreInfo): T[] {
  const stock: Record<string, { labels: Set<string>; to: string }> = {
    work: { labels: stockLabels('field.work', (other) => other.workLabel), to: genre.workLabel ?? 'field.work' },
    artist: {
      labels: stockLabels('field.artist', (other) => other.artistLabel),
      to: genre.artistLabel ?? 'field.artist'
    },
    title: { labels: stockLabels('field.title', (other) => other.titleLabel), to: genre.titleLabel ?? 'field.title' }
  };
  return answers.map((answer) => {
    const rule = stock[answer.key];
    return rule && rule.labels.has(answer.label) ? { ...answer, label: rule.to } : answer;
  });
}

/** A field's default prompt and every genre's own, which are the ones a move may rewrite. */
function stockLabels(fallback: string, own: (genre: (typeof GENRES)[number]) => string | undefined): Set<string> {
  return new Set([fallback, ...GENRES.map(own).filter((label): label is string => Boolean(label))]);
}

export type SetGenreResult =
  { ok: true; item: MediaView } | { ok: false; reason: 'not-found' | 'unknown-genre' | 'wrong-shape' };

/**
 * Files a catalogue entry under another genre, or confirms the one it has.
 *
 * Refused across answer shapes: an artist and a title cannot become a work by
 * changing a category, and letting it would leave a round whose answer boxes
 * ask for something the row does not hold. Confirming the current genre is
 * allowed on purpose, since it is how an old `field.work` prompt gets fixed.
 */
export async function setLibraryGenre(mediaId: number, genreId: string): Promise<SetGenreResult> {
  const row = await libraryRow(mediaId);
  if (!row) return { ok: false, reason: 'not-found' };

  const genre = genreById.get(genreId);
  if (!genre) return { ok: false, reason: 'unknown-genre' };

  const view = toMediaView(row);
  if (shapeOf(view) !== genre.answerShape) return { ok: false, reason: 'wrong-shape' };

  const answers = answersForGenre(view.answers, genre);
  const [updated] = await db
    .update(media)
    .set({ category: genre.id, answers: JSON.stringify(answers), last_modified: new Date().toISOString() })
    .where(eq(media.id, mediaId))
    .returning();
  if (!updated) return { ok: false, reason: 'not-found' };

  return { ok: true, item: toMediaView(updated) };
}

/**
 * Rewrites every old `field.work` prompt whose genre is known.
 *
 * The genre already says what the work is, so there is nothing to decide. An
 * entry whose genre is unknown, or not a work genre, is left flagged for a
 * person to look at.
 */
export async function fixLegacyLabels(): Promise<number> {
  let fixed = 0;
  for (const item of await listLibrary()) {
    const genre = item.category ? genreById.get(item.category) : undefined;
    if (!genre || genre.answerShape !== 'work' || !genre.workLabel) continue;
    if (!item.answers.some((answer) => answer.key === 'work' && answer.label === 'field.work')) continue;

    await db
      .update(media)
      .set({
        answers: JSON.stringify(answersForGenre(item.answers, genre)),
        last_modified: new Date().toISOString()
      })
      .where(eq(media.id, item.id));
    fixed += 1;
  }
  return fixed;
}
