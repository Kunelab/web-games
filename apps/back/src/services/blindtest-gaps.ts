import { and, eq, isNull } from 'drizzle-orm';
import { normalizeAnswer } from 'game-core';

import { db } from '../db/index.js';
import { blindtestRequests, blindtestSeeds, media } from '../db/schema.js';
import { GENRES } from './blindtest-catalog.js';
import { requestable } from './blindtest-seeds.js';

/**
 * What the catalogue is surprisingly thin on: famous artists with a handful of
 * songs in it, famous works with none.
 *
 * Famous by the seeds, which are the outside world's view: an artist on three
 * or more of the yearly charts, or with eight seeds and one of them near the
 * top of its genre; a work near the top of its genre. Thin by the catalogue,
 * across every genre, so an artist filed under rock is not missing from pop.
 * What an admin has already asked for is left out; the request panel shows it.
 */

/** An artist is thin with this many rounds or fewer, across all genres. */
const THIN_ARTIST = 3;
/** A work is famous from this fame up, within its genre. */
const FAMOUS_WORK = 0.95;
/** An artist is famous with this many chart songs, or this many seeds and one this famous. */
const FAMOUS_CHARTS = 3;
const FAMOUS_SEEDS = 8;
const FAMOUS_ARTIST = 0.97;
/** How many of each are listed. */
const GAPS_LISTED = 40;

export interface ArtistGap {
  artist: string;
  /** The genre most of its seeds are in, where a request would go. */
  genreId: string;
  /** Songs in the catalogue, all genres. */
  rounds: number;
  seeds: number;
  charts: number;
}

export interface WorkGap {
  work: string;
  genreId: string;
  fame: number;
  /** Whether a fill has searched for it already and kept nothing. */
  searched: boolean;
}

export interface Gaps {
  artists: ArtistGap[];
  works: WorkGap[];
}

/** The part of a catalogue round this reads. */
export interface GapRound {
  category: string | null;
  answers: { key: string; value: string; aliases?: string[] }[];
}

/** The part of a seed this reads. */
export interface GapSeed {
  genreId: string;
  source: string;
  artist: string;
  title: string;
  search: string;
  fame: number;
  searched: boolean;
}

/** Pure, for the tests. `requested` is every name asked for already, normalised. */
export function findGaps(
  rounds: readonly GapRound[],
  seeds: readonly GapSeed[],
  requested: ReadonlySet<string>,
  genres: { id: string; answerShape: string; requestable: boolean }[]
): Gaps {
  const byId = new Map(genres.map((genre) => [genre.id, genre]));

  // Every name a round answers to, by genre for works and across them for artists.
  const artistRounds = new Map<string, number>();
  const workNames = new Set<string>();
  for (const round of rounds) {
    for (const answer of round.answers) {
      const names = [answer.value, ...(answer.aliases ?? [])].map(normalizeAnswer).filter(Boolean);
      if (answer.key === 'artist') {
        for (const name of new Set(names)) artistRounds.set(name, (artistRounds.get(name) ?? 0) + 1);
      } else if (answer.key === 'work') {
        for (const name of names) workNames.add(`${round.category ?? ''}::${name}`);
      }
    }
  }

  const artists = new Map<
    string,
    { name: string; seeds: number; charts: number; top: number; genres: Map<string, number> }
  >();
  const works: WorkGap[] = [];
  for (const seed of seeds) {
    const genre = byId.get(seed.genreId);
    if (!genre?.requestable) continue;
    if (genre.answerShape === 'work') {
      const names = [seed.title, seed.search].map(normalizeAnswer).filter(Boolean);
      if (seed.fame < FAMOUS_WORK || seed.source === 'request') continue;
      if (names.some((name) => workNames.has(`${seed.genreId}::${name}`) || requested.has(name))) continue;
      works.push({ work: seed.title, genreId: seed.genreId, fame: seed.fame, searched: seed.searched });
      continue;
    }
    const key = normalizeAnswer(seed.artist);
    if (!key) continue;
    const entry = artists.get(key) ?? { name: seed.artist, seeds: 0, charts: 0, top: 0, genres: new Map() };
    entry.seeds += 1;
    if (seed.source === 'chart') entry.charts += 1;
    if (seed.source !== 'chart') entry.top = Math.max(entry.top, seed.fame);
    entry.genres.set(seed.genreId, (entry.genres.get(seed.genreId) ?? 0) + 1);
    artists.set(key, entry);
  }

  const artistGaps: ArtistGap[] = [];
  for (const [key, entry] of artists) {
    const famous = entry.charts >= FAMOUS_CHARTS || (entry.seeds >= FAMOUS_SEEDS && entry.top >= FAMOUS_ARTIST);
    const rounds = artistRounds.get(key) ?? 0;
    if (!famous || rounds > THIN_ARTIST || requested.has(key)) continue;
    const [genreId] = [...entry.genres.entries()].sort((left, right) => right[1] - left[1])[0] ?? [];
    if (!genreId) continue;
    artistGaps.push({ artist: entry.name, genreId, rounds, seeds: entry.seeds, charts: entry.charts });
  }
  artistGaps.sort(
    (left, right) => right.charts - left.charts || left.rounds - right.rounds || right.seeds - left.seeds
  );
  works.sort((left, right) => right.fame - left.fame);
  return { artists: artistGaps.slice(0, GAPS_LISTED), works: works.slice(0, GAPS_LISTED) };
}

/** The catalogue's gaps as they stand. A few thousand rows read; the admin asks for it by opening a panel. */
export function libraryGaps(): Gaps {
  const rounds = db
    .select({ category: media.category, answers: media.answers })
    .from(media)
    .where(and(isNull(media.user_id), eq(media.kind, 'blindtest')))
    .all()
    .map((row) => {
      try {
        return { category: row.category, answers: JSON.parse(row.answers) as GapRound['answers'] };
      } catch {
        return { category: row.category, answers: [] };
      }
    });
  const seeds = db
    .select({
      genreId: blindtestSeeds.genre_id,
      source: blindtestSeeds.source,
      artist: blindtestSeeds.artist,
      title: blindtestSeeds.title,
      search: blindtestSeeds.search,
      fame: blindtestSeeds.fame,
      searchedAt: blindtestSeeds.searched_at
    })
    .from(blindtestSeeds)
    .all()
    .map(({ searchedAt, ...seed }) => ({ ...seed, searched: searchedAt !== null }));
  const requested = new Set(
    db
      .select()
      .from(blindtestRequests)
      .all()
      .flatMap((row) => [row.name, row.found_as ?? ''].map(normalizeAnswer).filter(Boolean))
  );
  const genres = GENRES.map((genre) => ({
    id: genre.id,
    answerShape: genre.answerShape,
    requestable: !genre.facetOf && requestable(genre)
  }));
  return findGaps(rounds, seeds, requested, genres);
}
