import { eq } from 'drizzle-orm';
import { alsoInOf, normalizeAnswer, type BlindtestFame } from 'game-core';

import { db } from '../db/index.js';
import { blindtestArtistGenres } from '../db/schema.js';
import { GENRES, genreById, readCalibrations, type Genre } from './blindtest-catalog.js';
import { applyPlan, planRescore } from './blindtest-rescore.js';

/**
 * Moving a catalogue entry to another genre, and what has to move with it.
 *
 * A genre is more than the `category` column. The work prompt names the
 * genre's kind of work, and the difficulty is a distance from the genre's own middle:
 * the same fame is ordinary for rap US and famous for rap français. The three
 * places that move an entry (the admin's genre dialog, the host's correction at
 * a reveal, and an artist's remembered genre when a round is kept) each changed
 * the column and some of the rest; they all go through `refiled` now.
 *
 * `last_modified` is none of this module's business. It is how a rescoring
 * tells a person's numbers from the draw's, and a genre says nothing about
 * either: an entry moved without the figures to score it from keeps its old
 * number until `rescoreForPlay` scores it, on its new genre's scale, before a
 * room next hears it. Stamping the move would have told it not to.
 */

/** The part of a genre its answer prompts come from. */
interface GenreLabels {
  workLabel?: string;
  artistLabel?: string;
  titleLabel?: string;
}

/**
 * The answers of an entry moved to `genre`: its work prompt follows.
 *
 * The prompt is the genre's own ("Anime (opening)", "Jeu vidéo"), so an entry
 * moved from films to games without it would keep asking for a film. Only the
 * stock prompts are rewritten; a label somebody typed by hand stays theirs.
 */
export function answersForGenre<T extends { key: string; label: string }>(answers: T[], genre: GenreLabels): T[] {
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

/**
 * The other genres an entry is listed in, once `genreId` is its own.
 *
 * Moving an entry to a genre it was also listed in makes that its own, and
 * the list would otherwise name it twice.
 */
export function alsoInAfterMove(payload: Record<string, unknown>, genreId: string): Record<string, unknown> {
  const others = alsoInOf(payload);
  if (!others.includes(genreId)) return payload;
  const rest = others.filter((other) => other !== genreId);
  const next = { ...payload };
  if (rest.length > 0) next.alsoIn = rest;
  else delete next.alsoIn;
  return next;
}

type Calibrations = ReturnType<typeof readCalibrations>;

/**
 * The payload with its difficulty measured again on `genre`'s scale.
 *
 * From the fame figures the draw keeps with a round, so no outside service is
 * asked. Only figures from a real lookup (`looked`): the view count alone,
 * which the duplicate check fills in for old rows, is not a difficulty. A
 * number a person set stays, by the rescoring's own rules; see `planRescore`.
 */
export function rescoredForGenre(
  payload: Record<string, unknown>,
  genre: Genre,
  filed: { createdAt: string | null; lastModified: string | null },
  calibrations: Calibrations = readCalibrations(db)
): Record<string, unknown> {
  const fame = payload.fame as BlindtestFame | undefined;
  if (!fame?.looked) return payload;
  const [plan] = planRescore(
    [
      {
        id: 0,
        genre,
        payload,
        createdAt: filed.createdAt,
        lastModified: filed.lastModified,
        fame,
        durationSeconds: null,
        upload: 'video',
        chorus: null,
        hintFraction: null
      }
    ],
    { includeEdited: false, partial: true, retime: false, stored: calibrations }
  ).rows;
  return plan ? applyPlan(payload, plan, fame) : payload;
}

/** The fields of a catalogue entry that a move to another genre rewrites. */
export interface RefileableEntry<A extends { key: string; label: string }> {
  category: string | null;
  answers: A[];
  payload: unknown;
  created_at: string | null;
  last_modified: string | null;
}

/**
 * A catalogue entry as it reads under `genre`.
 *
 * Rescored only when the genre actually changes: confirming the genre an entry
 * has is how an old prompt is fixed, and should not move its number because
 * the scales were fitted again since.
 */
export function refiled<A extends { key: string; label: string }>(
  entry: RefileableEntry<A>,
  genre: Genre,
  calibrations?: Calibrations
): { category: string; answers: A[]; payload: Record<string, unknown> } {
  const payload = alsoInAfterMove((entry.payload ?? {}) as Record<string, unknown>, genre.id);
  return {
    category: genre.id,
    answers: answersForGenre(entry.answers, genre),
    payload:
      entry.category === genre.id
        ? payload
        : rescoredForGenre(
            payload,
            genre,
            { createdAt: entry.created_at, lastModified: entry.last_modified },
            calibrations
          )
  };
}

/* ------------------------------------------------- remembered artists */

/**
 * What an artist is remembered by: the whole artist answer, normalised.
 *
 * "Kalash & Ninho" is not Ninho: a duet belongs to two people, and an admin
 * deciding where one of them goes has decided nothing about the other. Empty
 * for a work, which has no artist.
 */
export function artistKeyOf(answers: readonly { key: string; value: string }[]): string {
  return normalizeAnswer(answers.find((answer) => answer.key === 'artist')?.value ?? '');
}

/** Files an artist's later rounds under `genreId`. Replaces whatever was remembered before. */
export function rememberArtistGenre(artist: string, genreId: string): void {
  if (!artist) return;
  db.insert(blindtestArtistGenres)
    .values({ artist, genre_id: genreId })
    .onConflictDoUpdate({ target: blindtestArtistGenres.artist, set: { genre_id: genreId } })
    .run();
}

/** The genre an artist's rounds are filed under, if an admin chose one that still exists. */
export function rememberedGenreOf(artist: string): Genre | undefined {
  if (!artist) return undefined;
  const row = db.select().from(blindtestArtistGenres).where(eq(blindtestArtistGenres.artist, artist)).get();
  return row ? genreById.get(row.genre_id) : undefined;
}

/**
 * A round about to be kept, under its artist's remembered genre if it has one.
 *
 * The round itself is not changed: the room that heard it asked for the genre
 * it was found in. Only the catalogue's copy is filed where the admin said
 * this artist belongs, so the next room asking for that genre gets it.
 */
export function underRememberedGenre<T extends RefileableEntry<{ key: string; label: string; value: string }>>(
  round: T
): T {
  const genre = rememberedGenreOf(artistKeyOf(round.answers));
  if (!genre || genre.id === round.category || genre.answerShape !== 'artist-title') return round;
  return { ...round, ...refiled(round, genre) };
}
