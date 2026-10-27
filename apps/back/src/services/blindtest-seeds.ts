/**
 * What the endless blind test searches YouTube for.
 *
 * ## Why this exists
 *
 * Each genre used to fill its pool from three fixed queries ("rap français clip
 * officiel", "anime opening official"). YouTube answers a fixed query with
 * roughly the same fifty videos every day, and the draw skips anything the
 * shared catalogue already holds. So once a few hundred rounds had been kept,
 * the daily searches came back full of songs the room had already heard, the
 * pools emptied, and the mode ran out of ideas: not because music had run out,
 * but because the questions never changed.
 *
 * So the questions come from catalogues now. A seed is one real entry, with a
 * popularity figure from the source:
 *
 *  - **Deezer** for the music genres. Its editors publish hundreds of genre
 *    playlists ("Rap FR Classiques", "80s Metal"), readable without a key,
 *    with a `rank` per track. A genre's harvest is a few thousand tracks.
 *  - **AniList** for anime openings and endings: the two thousand most popular
 *    series, with every title a room might type.
 *  - **Wikidata** for films, series and games, through QLever (a fast public
 *    mirror; the official endpoint times out on these queries). The number of
 *    Wikipedia languages an entry has is the fame figure.
 *
 * Seeds are drawn at random, weighted towards the famous, and each search is
 * aimed at a few of them at once. A seed is searched once and marked, so the
 * next search is always about something new. When a genre has used all of its
 * seeds they are recycled a month later: by then the catalogue has grown and
 * YouTube's answers have moved.
 *
 * ## What the model still does
 *
 * Reading a YouTube title and saying what it is. The seed says what the search
 * was *for*; it cannot say what came back. The model is told the seed as a
 * hint, and the seeds then act as a genre oracle: an artist Deezer's rap editors
 * list is a rap artist, whatever the model thinks of them, and a work AniList
 * knows brings its real alternative titles as accepted answers.
 *
 * Every network call here is best-effort. A harvest that fails leaves the genre
 * on its old fixed queries, which is exactly the behaviour before seeds existed.
 *
 * ## What is here, and what is not
 *
 * The requests themselves are not: they go through `SeedSources`, and the
 * production ones (with the pacing each service asks for) are in
 * `blindtest-sources`. What is here is what to ask for, how to read the answer
 * and what to keep, with the stock in the database and the few caches over it
 * held by one `createSeedStock`, so that a test can have its own.
 */
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, like, lt, or, sql } from 'drizzle-orm';
import { normalizeAnswer } from 'game-core';
import { z } from 'zod';

import type { Clock } from '../clock.js';
import type { Db } from '../db/open.js';
import {
  blindtestArtistGenres,
  blindtestRequests,
  blindtestSeedHarvests,
  blindtestSeeds,
  metaData
} from '../db/schema.js';

/* ------------------------------------------------------------------ config */

export type SeedSource =
  | {
      kind: 'deezer';
      /**
       * Playlist searches. Only playlists published by Deezer's own editors or
       * the labels' curation brands are read: anybody's "blind test soirée"
       * list is a party mix, not a genre.
       */
      playlistQueries: string[];
      /**
       * What a playlist's title must say to be read.
       *
       * A search for "rap français" also returns the editors' generic hit
       * lists, and the first harvest filed Taylor Swift under French rap from
       * one of them. The seeds are trusted as a genre oracle, so a playlist has
       * to name the genre to count.
       */
      titleMatch: RegExp;
    }
  | { kind: 'anilist' }
  | {
      kind: 'wikidata';
      /** Wikidata classes, e.g. `Q11424` for a film. */
      types: string[];
      /** How many Wikipedia languages an entry needs: the fame floor. */
      minLinks: number;
      /** The property holding its date: P577 publication, P580 start. */
      dateProperty: string;
      /** Only works with a credited composer (P86): a film score worth hearing. */
      requireComposer?: boolean;
    }
  | {
      /**
       * Classical works, filed under their composer.
       *
       * Deezer cannot supply these: its "artist" on a classical track is the
       * performer (Lang Lang, the Berliner Philharmoniker) and its titles are
       * catalogue strings ("Symphony No. 5 in C Minor, Op. 67 : Beethoven…").
       * Wikidata has the work, its composer and its fame as separate facts.
       */
      kind: 'wikidata-compositions';
      /** How many Wikipedia languages a work needs. */
      minLinks: number;
      /** Composers born before this year: the classical repertoire, not Broadway. */
      bornBefore: number;
    };

/** The part of a genre this module reads. The catalogue's `Genre` fits it. */
export interface SeededGenre {
  id: string;
  answerShape: 'artist-title' | 'work';
  seeds?: SeedSource[];
  /** Added to a work's name to find its music: "opening", "soundtrack". */
  seedSuffix?: string;
  /**
   * Whether the suffix goes inside each quoted name rather than once at the end.
   *
   * Measured against the live API. `"Boruto"|"Blood Lad" opening` came back
   * half scene clips ("Love Confession | The Quintessential Quintuplets 2"),
   * while `"Boruto opening"|"Blood Lad opening"` came back almost entirely
   * openings, every name represented. Films want the other shape: their
   * uploads are titled "Superman Returns Soundtrack : Main Titles" or "Vanilla
   * Sky soundtrack (variant theme)", and a two-word suffix inside the phrase
   * would demand words the titles do not keep together.
   */
  seedSuffixInPhrase?: boolean;
  /**
   * How an artist is weighed when choosing whom to search: by their best-known
   * seed (`fame`, the default) or also by how many seeds they have
   * (`repertoire`).
   *
   * For classical the second is the right question. Its first plan by fame
   * alone opened on Lysenko, W. C. Handy and Franz Xaver Gruber, each famous
   * for one piece, because one well-known work weighed as much as Bach's two
   * hundred. The size of a composer's catalogue is what makes them canonical.
   */
  artistWeight?: 'fame' | 'repertoire';
}

/** One harvested seed, before it is stored. */
export interface RawSeed {
  source: 'deezer' | 'anilist' | 'wikidata' | 'chart' | 'request';
  sourceKey: string;
  artist: string;
  title: string;
  search: string;
  aliases: string[];
  year: number | null;
  /** The source's own popularity figure, on any scale. Ranked into `fame`. */
  popularity: number;
  /** The recording's length in seconds, when the source gives it: Deezer does. */
  duration?: number | null;
}

export interface Seed {
  id: number;
  artist: string;
  title: string;
  search: string;
  aliases: string[];
  year: number | null;
  fame: number;
  /** A hit's videos, found without a search. See `VideoIndex`. */
  videos?: string[];
  /** Where: Wikidata's video of the song is a fact, a channel's upload a match on its title. */
  videosFrom?: VideosFrom;
  /** Asked for by an admin, and planned before the rest of its genre. See `BlindtestRequests`. */
  requested?: boolean;
}

export type VideosFrom = 'wikidata' | 'channel';

/** One YouTube search, and the seeds it is aimed at. */
export interface SeedSearch {
  query: string;
  limit: number;
  seeds: Seed[];
  /**
   * A few artists by name, a few famous songs by artist and title, or a few
   * works. A hit's seeds are spent only once its song is in the catalogue; see
   * `HIT_FAME`.
   */
  aim: 'artists' | 'hits' | 'works';
  /**
   * The videos, when they are already known and YouTube need not be searched:
   * hits whose video Wikidata or the artist's channel gave. The query is empty.
   */
  videoIds?: string[];
  /** What the model is told this search was for. */
  hint: string;
}

/**
 * How many seeds one search is aimed at.
 *
 * One artist per search returns fifteen songs by one person, and the draw's
 * artist spacing lets a room hear two of them in an evening, so most of that
 * search is wasted. YouTube's `|` operator asks for several at once in the same
 * hundred quota units. Works go four to a search because each yields one round
 * (the pool keeps one entry per work).
 */
const ARTISTS_PER_SEARCH = 3;
/** Past this many works a composer weighs no more: Bach need not be searched first every time. */
const REPERTOIRE_CAP = 50;
const WORKS_PER_SEARCH = 4;

/**
 * Where a seed counts as a hit: the top tenth of its genre's harvest.
 *
 * A hit is searched by itself, artist and title, before anything else in its
 * genre. Searched by its artist alongside two others, as everything was, it was
 * left to YouTube's ranking: "The Rolling Stones"|"grandson"|"Clairo" filed
 * twenty-six songs by Clairo and grandson, spent all fifteen Stones seeds, and
 * the catalogue still had no Rolling Stones a month later. "Nirvana" came back
 * as every song called Nirvana by somebody else.
 */
export const HIT_FAME = 0.9;
/**
 * Hits per search. Measured on the live API: four came back with every song
 * in the results, and their Topic uploads among them; eight lost two songs
 * entirely to the covers of the other six.
 */
const HITS_PER_SEARCH = 4;
/** How often the overnight prefill searches a hit that it could not file before it gives up on it. */
const HIT_TRIES = 2;
/**
 * How long a hit rests after a search, found or not.
 *
 * A room's pool may hold the song for a day without anybody playing it, and a
 * search that missed it once is likelier to find it with other songs beside it.
 * Either way the night's prefill should spend its searches on other hits first.
 */
const HIT_REST_MS = 7 * 24 * 60 * 60 * 1000;
/** Hits are searched for a room that may be dealt them: one whose window starts at least this easy. */
const HIT_WINDOW_MIN = 20;
/**
 * Hits per lookup, when their videos are known. No search is spent, so more go
 * in one than in a search; twelve keep the model's reading to a batch or two.
 */
const HITS_PER_LOOKUP = 12;

/** Re-harvested monthly: new releases, new editorial lists, new seasons. */
const HARVEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A failed harvest is tried again after this. */
const HARVEST_RETRY_MS = 6 * 60 * 60 * 1000;
/** Below this many unsearched seeds a genre harvests again, at most daily. */
const LOW_STOCK = 40;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Searched seeds become eligible again after this, once a genre runs dry. */
const RECYCLE_AFTER_MS = 30 * DAY_MS;
/** How long a Wikidata index that would not come is remembered before asking again. */
const VIDEO_INDEX_RETRY_MS = 60 * 60 * 1000;
/**
 * The waits before each try at the index: at once, then longer and longer, up
 * to ten minutes, for QLever to stop throttling. Some eighteen minutes in all,
 * which only the night's prefill waits through; a room's fill never does.
 */
const VIDEO_INDEX_ATTEMPTS = [0, 30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000];
/** Where the index is kept between restarts. */
const VIDEO_INDEX_KEY = 'blindtest_video_index';
/** The charts' row in `BlindtestSeedHarvests`, beside the genres'. */
const CHARTS_HARVEST = 'charts';

/* ----------------------------------------------------------------- sources */

/** Which page of a Deezer listing to ask for. */
export interface DeezerPage {
  index: number;
  limit: number;
}

/**
 * The seed catalogues, one function per kind of request made of them.
 *
 * Each answers with the body as the service sent it, decoded but not checked:
 * checking it is the parsers' job below, which are tested against exactly
 * these bodies. Null means the request would not come, after whatever pacing
 * and retrying the service asks for, which is the adapter's business.
 */
export interface SeedSources {
  deezer: {
    /** `GET /search/playlist`. */
    searchPlaylists(query: string, page: DeezerPage): Promise<unknown>;
    /** `GET /user/:id/playlists`: everything one editor keeps. */
    userPlaylists(userId: number, page: DeezerPage): Promise<unknown>;
    /** `GET /playlist/:id/tracks`. */
    playlistTracks(playlistId: number, page: DeezerPage): Promise<unknown>;
    /** `GET /album/:id`, for its genre. */
    album(albumId: number): Promise<unknown>;
    /** `GET /search/artist`. */
    searchArtists(name: string): Promise<unknown>;
    /** `GET /artist/:id/top`: their most played tracks. */
    artistTop(artistId: number, limit: number): Promise<unknown>;
  };
  /** One page, from 1, of AniList's most popular TV series, fifty to a page. */
  anilist(page: number): Promise<unknown>;
  /** A SPARQL query, on QLever's fast mirror or on Wikidata's own endpoint. */
  sparql(endpoint: 'qlever' | 'wikidata', query: string): Promise<unknown>;
}

/* ---------------------------------------------------------------- helpers */

/**
 * Something a French-speaking room can type: at least one Latin letter.
 * The same test as the alias lookups, for the same reason.
 */
const TYPEABLE = /\p{Script=Latin}/u;

/** Distinct, typeable names other than `title`, capped. */
export function otherNames(title: string, names: (string | null | undefined)[], cap = 8): string[] {
  const seen = new Set([normalizeAnswer(title)]);
  const kept: string[] = [];
  for (const name of names) {
    const trimmed = name?.trim();
    if (!trimmed || trimmed.length > 90 || !TYPEABLE.test(trimmed)) continue;
    const key = normalizeAnswer(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(trimmed);
    if (kept.length >= cap) break;
  }
  return kept;
}

/**
 * Popularity turned into a 0 to 1 rank within one harvest.
 *
 * A rank rather than a ratio, because the sources' figures share no scale
 * (a Deezer rank runs to a million, a Wikipedia count to a couple of hundred)
 * and are wildly skewed within one source. 1 is the most famous.
 */
export function rankFame<T extends { popularity: number }>(seeds: T[]): (T & { fame: number })[] {
  const order = [...seeds].sort((left, right) => right.popularity - left.popularity);
  const last = order.length - 1;
  return order.map((seed, index) => ({ ...seed, fame: last <= 0 ? 0.5 : 1 - index / last }));
}

/**
 * A weighted draw without replacement (Efraimidis and Spirakis).
 *
 * Each item gets `random^(1/weight)` and the highest keys win, which draws
 * heavier items more often without ever excluding light ones.
 */
export function weightedSample<T>(items: T[], count: number, weight: (item: T) => number, random = Math.random): T[] {
  return items
    .map((item) => ({ item, key: Math.pow(random(), 1 / Math.max(1e-6, weight(item))) }))
    .sort((left, right) => right.key - left.key)
    .slice(0, count)
    .map((entry) => entry.item);
}

/**
 * How much a seed of this fame should be drawn.
 *
 * With no window the famous are favoured, because a party wants songs people
 * know: to the fourth power, so about fifteen draws in sixteen come from the
 * better-known half. A straight line gave the first harvest's plans "No Limit",
 * "Mallrats" and "Recovery of an MMO Junkie"; squared still left two thirds of
 * rock's best-known tenth unsearched after a month, because the middle of a
 * harvest is so much larger than its top. A room asking for hard rounds gets
 * seeds near the fame its window implies instead: difficulty 0 is fame 1.
 */
export function fameWeight(fame: number, window?: { min: number; max: number }): number {
  // A window this wide is no preference at all, and it is what every room
  // left on the default 0 to 100 sends. Read as a target it centred the draw on
  // middling fame and weighed deep cuts the same as household names.
  if (!window || window.max - window.min >= WIDE_WINDOW) return 0.02 + 1.5 * fame ** 4;
  const target = 1 - (window.min + window.max) / 200;
  const spread = 0.2 + (window.max - window.min) / 400;
  return 0.05 + Math.exp(-((fame - target) ** 2) / (2 * spread ** 2));
}

/** A difficulty window at least this wide says nothing about fame. */
const WIDE_WINDOW = 80;

/** A name as a YouTube phrase. Quotes inside it would end the phrase early. */
function phrase(name: string): string {
  return `"${name.replace(/"/g, '').trim()}"`;
}

/**
 * What a release adds to a song's title: "(feat. David Bowie)", "(Remastered 2011)".
 *
 * Left out of a hit's search, which has to match the upload's title word for
 * word: "Queen Under Pressure feat David Bowie" is in no title at all. A
 * bracket that is part of the name, "(I Can't Get No) Satisfaction", stays.
 */
const RELEASE_NOTE =
  /\s*[([][^)\]]*\b(?:feat|ft|with|remaster(?:ed)?|version|edit|live|mono|stereo|mix|bonus|deluxe|demo|single)\b[^)\]]*[)\]]/gi;

function hitPhrase(seed: Seed): string {
  return phrase(`${seed.search || seed.artist} ${seed.title.replace(RELEASE_NOTE, '')}`);
}

/** Which song a hit's seed is, across the several Deezer ids one song has. */
function hitSongKey(seed: { artist: string; title: string }): string {
  return trackOracleKey(seed.artist, seed.title.replace(RELEASE_NOTE, ''));
}

/**
 * The names an artist is matched by: as credited, and the lead of a duet.
 *
 * "Queen & David Bowie" is Queen, "The Rolling Stones" is "Rolling Stones",
 * whichever side of the comparison says it.
 */
function artistKeys(artist: string): string[] {
  const keys = new Set<string>();
  for (const name of [artist, artist.split(/\s*(?:&|,|\bfeat\.?|\bft\.?|\bx\b|\bwith\b|\bvs\.?)\s*/i)[0] ?? '']) {
    const key = normalizeAnswer(name).replace(/^the /, '');
    if (key) keys.add(key);
  }
  return [...keys];
}

/**
 * The keys a recording is matched on, the same for a seed and a catalogue row.
 *
 * The title as it is, without its brackets and without a trailing " - Remastered":
 * Deezer's "(I Can't Get No) Satisfaction" and a model's "Satisfaction" are one
 * song, and so are "Paint It, Black" and "Paint It Black". Empty for a work.
 */
export function songKeys(artist: string, title: string): string[] {
  const names = titleKeys(title);
  return artistKeys(artist).flatMap((who) => names.map((name) => `${who}::${name}`));
}

function titleKeys(title: string): string[] {
  const names = [title, title.replace(/\s*[([][^)\]]*[)\]]/g, ' '), title.replace(/\s+[-–—]\s+.*$/, '')];
  return [...new Set(names.map(normalizeAnswer).filter(Boolean))];
}

/** Whether a found answer is by one of these artists. */
export function byArtistOf(artist: string, seeds: readonly Pick<Seed, 'artist'>[]): boolean {
  const keys = new Set(seeds.flatMap((seed) => artistKeys(seed.artist)));
  return artistKeys(artist).some((key) => keys.has(key));
}

/* --------------------------------------------------------------- Deezer */

/**
 * Curators whose genre playlists mean what they say.
 *
 * Deezer's own editors, and the labels' playlist brands (Filtr is Sony's,
 * Topsify Warner's, Digster Universal's). Community playlists are excluded not
 * because they are bad but because "rap" in a user's title is a mood, while an
 * editor's is a genre.
 */
const CURATOR = /deezer|filtr|topsify|digster/i;

const deezerPlaylists = z.object({
  data: z
    .array(
      z.object({
        id: z.number(),
        title: z.string().default(''),
        nb_tracks: z.number().default(0),
        /** Who published it, in a search result. */
        user: z.object({ id: z.number().optional(), name: z.string().default('') }).optional(),
        /** The same, in a user's own list of playlists. */
        creator: z.object({ name: z.string().default('') }).optional(),
        /** A user's "favourite tracks", which is nobody's genre. */
        is_loved_track: z.boolean().optional()
      })
    )
    .default([])
});

const deezerTracks = z.object({
  data: z
    .array(
      z.object({
        id: z.number(),
        title: z.string().default(''),
        title_short: z.string().optional(),
        rank: z.number().default(0),
        duration: z.number().optional(),
        readable: z.boolean().optional(),
        artist: z.object({ id: z.number().optional(), name: z.string().default('') }).optional(),
        album: z.object({ id: z.number() }).optional()
      })
    )
    .default([]),
  next: z.string().optional()
});

/**
 * How many playlists one genre reads.
 *
 * Thirty gave 750 to 1,600 distinct tracks a genre. Doubling that took more
 * than a bigger number: see `harvestDeezer` for where the extra playlists come
 * from.
 */
const DEEZER_PLAYLISTS_PER_GENRE = 90;
const DEEZER_TRACKS_PER_PLAYLIST = 300;
/** Search results read per query, fifty at a time. */
const DEEZER_RESULTS_PER_QUERY = 100;
/** Playlists read from one editor's own list, a hundred at a time. */
const DEEZER_PLAYLISTS_PER_EDITOR = 400;

/** Which playlists of a page to read: curated, on the genre, and big enough to matter. */
export function curatedPlaylists(raw: unknown, titleMatch?: RegExp): { id: number; title: string }[] {
  const parsed = deezerPlaylists.safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.data
    .filter(
      (playlist) =>
        playlist.nb_tracks >= 20 &&
        !playlist.is_loved_track &&
        CURATOR.test(playlist.user?.name ?? playlist.creator?.name ?? '') &&
        (!titleMatch || titleMatch.test(playlist.title))
    )
    .map((playlist) => ({ id: playlist.id, title: playlist.title }));
}

/**
 * The genre's own editors, among a search's publishers.
 *
 * An editor whose name says the genre ("Ayoub - Deezer Rap Editor", "Rod -
 * Deezer Metal Editor"), and only those: "Deezer Best Of" and the country
 * editors publish a bit of everything, and their lists would bring it all.
 */
export function genreEditors(raw: unknown, titleMatch: RegExp): { id: number; name: string }[] {
  const parsed = deezerPlaylists.safeParse(raw);
  if (!parsed.success) return [];
  const editors = new Map<number, string>();
  for (const playlist of parsed.data.data) {
    const name = playlist.user?.name ?? '';
    const id = playlist.user?.id;
    if (id === undefined || !CURATOR.test(name) || !/editor|editrice|éditrice/i.test(name)) continue;
    if (titleMatch.test(name.replace(CURATOR, ' '))) editors.set(id, name);
  }
  return [...editors].map(([id, name]) => ({ id, name }));
}

/**
 * Which playlists of a genre editor's own list to read.
 *
 * Everything the editor made, whatever its title: the K-pop editor calls a
 * playlist "stargirls☆" and the metal editor calls one "Run Like Hell", and the
 * title test threw most of both away. Their being the genre's editor is the
 * test. The list also holds playlists by other people that the editor added,
 * and those still have to pass the ordinary one.
 */
export function editorPlaylists(raw: unknown, editor: string, titleMatch: RegExp): { id: number; title: string }[] {
  const parsed = deezerPlaylists.safeParse(raw);
  if (!parsed.success) return [];
  const ownOrOnGenre = parsed.data.data.filter(
    (playlist) =>
      playlist.nb_tracks >= 20 &&
      !playlist.is_loved_track &&
      (playlist.creator?.name === editor ||
        (CURATOR.test(playlist.creator?.name ?? '') && titleMatch.test(playlist.title)))
  );
  return ownOrOnGenre.map((playlist) => ({ id: playlist.id, title: playlist.title }));
}

/** How many playlists a page carried, to know whether there is another. */
function pageSize(raw: unknown): number {
  return deezerPlaylists.safeParse(raw).data?.data.length ?? 0;
}

/**
 * An "artist" that is really an album or a compilation.
 *
 * Deezer credits some soundtrack releases to the release itself ("Bad Boys 2
 * The Original Motion Picture Soundtrack featuring P.Diddy, Nelly and Murphy
 * Lee"), which is nobody a room could name and a useless YouTube search.
 */
const NOT_AN_ARTIST = /soundtrack|motion picture|various artists|original cast|\bost\b/i;

/** A page of playlist tracks, as seeds. */
export function deezerSeeds(raw: unknown): RawSeed[] {
  return deezerTrackSeeds(raw).map((track) => track.seed);
}

/** The same, each with its album, whose genre a chart song may be filed by. */
function deezerTrackSeeds(raw: unknown): { seed: RawSeed; album: number | null }[] {
  const parsed = deezerTracks.safeParse(raw);
  if (!parsed.success) return [];
  const seeds: { seed: RawSeed; album: number | null }[] = [];
  for (const track of parsed.data.data) {
    if (track.readable === false) continue;
    const artist = track.artist?.name.trim() ?? '';
    const title = (track.title_short || track.title).trim();
    if (!artist || !title) continue;
    if (artist.length > 40 || NOT_AN_ARTIST.test(artist)) continue;
    // "¥$" or "†‡†" normalise to nothing, and the planner groups by the
    // normalised name: such a seed would sit unsearched for ever and keep the
    // genre from ever recycling. See `ensure`.
    if (!normalizeAnswer(artist)) continue;
    seeds.push({
      seed: {
        source: 'deezer',
        sourceKey: String(track.id),
        artist,
        title,
        search: '',
        aliases: [],
        year: null,
        popularity: track.rank,
        duration: track.duration && track.duration > 0 ? track.duration : null
      },
      album: track.album?.id ?? null
    });
  }
  return seeds;
}

/* --------------------------------------------------------------- charts */

/**
 * The hits of each year since 1990, filed into the music genres.
 *
 * The genres' editorial playlists are what people stream now, and the
 * catalogue showed it: ten thousand rounds from 2015 on, nine hundred from the
 * whole of the nineties, and no "My Heart Will Go On", "Ketchup Song" or
 * "What Is Love" among the seeds at all. Deezer's "Deezer Best Of" publishes a
 * "Top Hits 1995" for every year, fifty to eighty songs, mostly American and
 * British. Nobody publishes a French one, so the French side is the labels'
 * decade lists of French hits.
 *
 * A chart is every genre at once, and the seeds are each genre's oracle, so a
 * song goes where its artist already is: the genre holding most of their
 * seeds. An artist no genre knows goes by its album's genre on Deezer. See
 * `chartGenre`. Every chart song is a hit (see `HIT_FAME`), searched or looked
 * up as itself.
 */
export const CHARTS = {
  /** `Deezer Best Of`, whose "Top Hits <year>" lists these are. */
  yearlyEditor: 4036701362,
  yearlyTitle: /^Top Hits ((?:19|20)\d\d)$/,
  since: 1990,
  frenchQueries: [
    'variété française années 90',
    'musique française années 90',
    'tubes années 90',
    'variété française années 2000',
    'tubes français années 2000',
    'tubes français des années'
  ],
  /** French, and a decade from the nineties on: not "Années 80", not "Rap US des années 90". */
  frenchTitle: /^(?=.*(?:fran[cç]|vari[ée]t[ée]|bleu blanc))(?=.*(?:90|2000)).*$/i
};

/* ------------------------------------------------------------- requests */

/** One admin's ask, and how far the fills have got with it. See `BlindtestRequests`. */
export interface SeedRequest {
  id: number;
  genreId: string;
  name: string;
  /** What the source answered with, when it knew the name. */
  foundAs: string | null;
  createdAt: string | null;
  /** Its seeds: an artist's top tracks, or the one work. */
  seeds: number;
  /** Searched or looked up, and in the catalogue. */
  filed: number;
  /** Searched as often as a hit is, and never filed. */
  missed: number;
  /** Not searched yet. */
  waiting: number;
  /**
   * Of those, the ones only a YouTube search can file: a work, or a song whose
   * free lookups (Wikidata's video list, the artist's channel) found nothing.
   * A fill run with `searches=0` leaves these waiting.
   */
  needSearch: number;
}

export type RequestResult =
  { ok: true; request: SeedRequest } | { ok: false; reason: 'not-requestable' | 'not-found' | 'unavailable' };

/** How many of an artist's tracks a request asks for, when it does not say. */
export const REQUEST_SONGS = 20;
export const REQUEST_SONGS_MAX = 50;

/**
 * Whether an admin can ask for more of a genre.
 *
 * An artist's songs where its seeds are an editor's tracks, searched as
 * themselves; a work where the genre's seeds are works. Not the classical
 * repertoire, whose "artist" on Deezer is the orchestra.
 */
export function requestable(genre: SeededGenre): boolean {
  if (!genre.seeds || genre.seeds.length === 0) return false;
  return genre.answerShape === 'work' || searchesHits(genre);
}

const deezerArtists = z.object({
  data: z
    .array(
      z.object({
        id: z.number(),
        name: z.string().default(''),
        nb_fan: z.number().default(0),
        picture_small: z.string().optional()
      })
    )
    .default([])
});

/** One of Deezer's answers to an artist's name, for an admin to pick from. */
export interface ArtistCandidate {
  id: number;
  name: string;
  fans: number;
  picture: string | null;
}

/** How many of Deezer's answers an admin is shown. */
const CANDIDATES = 5;

/**
 * Deezer's answers to a name, the most followed first, for an admin to pick
 * from before a request is made. By fans rather than by spelling: the Thai
 * singer called exactly "Korn" has 87, KoЯn two and a half million.
 */
export function artistCandidates(raw: unknown): ArtistCandidate[] {
  const artists = deezerArtists.safeParse(raw).data?.data ?? [];
  return [...artists]
    .sort((left, right) => right.nb_fan - left.nb_fan)
    .slice(0, CANDIDATES)
    .map((artist) => ({
      id: artist.id,
      name: artist.name,
      fans: artist.nb_fan,
      picture: artist.picture_small ?? null
    }));
}

/**
 * An artist's own songs among their top tracks, each title once.
 *
 * Deezer's top tracks include the ones the artist is only featured on, under
 * the other artist's name ("Pitbull - Timber" for Kesha), and the live and
 * studio versions of one song as two tracks. Those are left out.
 */
export function ownTopTracks(raw: unknown, artistId: number, count: number): RawSeed[] {
  const own = new Set(
    (deezerTracks.safeParse(raw).data?.data ?? [])
      .filter((track) => track.artist?.id === undefined || track.artist.id === artistId)
      .map((track) => String(track.id))
  );
  const titles = new Set<string>();
  return deezerSeeds(raw)
    .filter((seed) => {
      if (!own.has(seed.sourceKey)) return false;
      const title = normalizeAnswer(seed.title.replace(/\s*[([].*$/, ''));
      if (titles.has(title)) return false;
      titles.add(title);
      return true;
    })
    .slice(0, count);
}

/**
 * The artist an admin meant, among Deezer's answers to their name.
 *
 * The one whose name is theirs, normalised, so "francky vincent" is Francky
 * Vincent; failing that, Deezer's first answer, which is its most followed.
 * Its name goes back to the admin, so a wrong guess shows.
 */
export function pickArtist(raw: unknown, name: string): { id: number; name: string } | null {
  const artists = deezerArtists.safeParse(raw).data?.data ?? [];
  const wanted = normalizeAnswer(name);
  const artist = artists.find((candidate) => normalizeAnswer(candidate.name) === wanted) ?? artists[0];
  return artist ? { id: artist.id, name: artist.name } : null;
}

/** The chart side a list is from, which decides where an unknown rapper goes. */
export type ChartSide = 'world' | 'france';

/** Deezer's album genres, as this catalogue's genres. Null where it has none. */
function genreOfAlbum(deezerGenre: number | null, side: ChartSide): string | null {
  switch (deezerGenre) {
    case 116:
      return side === 'france' ? 'rap-fr' : 'rap-us';
    case 152:
    case 85:
      return 'rock';
    case 113:
    case 106:
      return 'electro';
    case 144:
      return 'reggae';
    case 464:
      return 'metal';
    case 52:
      return 'chanson-fr';
    case 16:
      return 'kpop';
    default:
      return null;
  }
}

/**
 * Where a chart song is filed, among the genres that take hits.
 *
 * Its artist's genre first: the one holding most of their seeds, which put
 * Guns N' Roses in rock (11) over pop (5) and metal (4), and every Dire Straits
 * or U2 song with the rest of theirs. Then its album's genre on Deezer. Then
 * pop, or French chanson for a French list: they are chart hits, and pop is
 * what the editors file a hit under when it is nothing more particular.
 */
export function chartGenre(
  artist: string,
  side: ChartSide,
  artistGenres: ReadonlyMap<string, ReadonlyMap<string, number>>,
  albumGenre: number | null,
  genreIds: ReadonlySet<string>,
  /** Where an admin filed each artist, by normalised name: first, over any seed. */
  remembered: ReadonlyMap<string, string> = new Map()
): string | null {
  const chosen = remembered.get(normalizeAnswer(artist));
  if (chosen && genreIds.has(chosen)) return chosen;
  let best: string | null = null;
  let most = 0;
  for (const [genreId, seeds] of artistGenres.get(normalizeAnswer(artist)) ?? []) {
    if (genreIds.has(genreId) && seeds > most) {
      best = genreId;
      most = seeds;
    }
  }
  if (best) return best;
  const byAlbum = genreOfAlbum(albumGenre, side);
  if (byAlbum && genreIds.has(byAlbum)) return byAlbum;
  const fallback = side === 'france' ? 'chanson-fr' : 'pop';
  return genreIds.has(fallback) ? fallback : null;
}

/** The year a "Top Hits" list is of, if it is one this harvest reads. */
export function chartYear(title: string): number | null {
  const year = Number(CHARTS.yearlyTitle.exec(title.trim())?.[1]);
  return Number.isFinite(year) && year >= CHARTS.since ? year : null;
}

const deezerAlbum = z.object({ genre_id: z.number().nullable().optional() });

/** An album's main genre on Deezer, or null. */
export function albumGenre(raw: unknown): number | null {
  const genre = deezerAlbum.safeParse(raw).data?.genre_id;
  return typeof genre === 'number' && genre > 0 ? genre : null;
}

/** How many tracks a page carried, filtered or not, to know whether there is another. */
function trackPageSize(raw: unknown): number {
  return deezerTracks.safeParse(raw).data?.data.length ?? 0;
}

/* -------------------------------------------------------------- AniList */

const anilistPage = z.object({
  data: z.object({
    Page: z.object({
      pageInfo: z.object({ hasNextPage: z.boolean().default(false) }),
      media: z
        .array(
          z.object({
            id: z.number(),
            popularity: z.number().nullable().default(0),
            title: z.object({
              romaji: z.string().nullable().optional(),
              english: z.string().nullable().optional(),
              native: z.string().nullable().optional()
            }),
            synonyms: z.array(z.string()).nullable().optional(),
            startDate: z.object({ year: z.number().nullable().optional() }).optional()
          })
        )
        .default([])
    })
  })
});

/** Two thousand series. Past that, nobody at a party knows the opening. */
const ANILIST_PAGES = 40;

export function anilistSeeds(raw: unknown): { seeds: RawSeed[]; more: boolean } {
  const parsed = anilistPage.safeParse(raw);
  if (!parsed.success) return { seeds: [], more: false };
  const seeds: RawSeed[] = [];
  for (const media of parsed.data.data.Page.media) {
    const title = (media.title.english || media.title.romaji || '').trim();
    if (!title) continue;
    seeds.push({
      source: 'anilist',
      sourceKey: String(media.id),
      artist: '',
      title,
      search: title,
      aliases: otherNames(title, [
        media.title.romaji,
        media.title.english,
        media.title.native,
        ...(media.synonyms ?? [])
      ]),
      year: media.startDate?.year ?? null,
      popularity: media.popularity ?? 0
    });
  }
  return { seeds, more: parsed.data.data.Page.pageInfo.hasNextPage };
}

/* ------------------------------------------------------------- Wikidata */

const sparqlResults = z.object({
  results: z.object({
    bindings: z.array(z.record(z.string(), z.object({ value: z.string() }).passthrough())).default([])
  })
});

const PREFIXES = `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX schema: <http://schema.org/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>`;

/**
 * The labels, outside the grouping.
 *
 * Inside it, `SAMPLE` over the joined rows came back unbound for a sixth of
 * the entries. And `mul`, because Wikidata now stores a name shared by every
 * language once under that tag and drops the identical French and English
 * labels, which is why "Minecraft" had neither.
 */
const LABELS = `  OPTIONAL { ?item rdfs:label ?fr FILTER(LANG(?fr) = "fr") }
  OPTIONAL { ?item rdfs:label ?en FILTER(LANG(?en) = "en") }
  OPTIONAL { ?item rdfs:label ?mul FILTER(LANG(?mul) = "mul") }`;

/** For QLever, which has no sitelink count and counts the pages instead. */
export function qleverQuery(source: Extract<SeedSource, { kind: 'wikidata' }>): string {
  const types = source.types.map((type) => `wd:${type}`).join(' ');
  return `${PREFIXES}
SELECT ?item ?links ?year ?fr ?en ?mul WHERE {
  {
    SELECT ?item (COUNT(DISTINCT ?page) AS ?links) (MIN(YEAR(?date)) AS ?year) WHERE {
      VALUES ?type { ${types} }
      ?item wdt:P31 ?type .
      ${source.requireComposer ? '?item wdt:P86 ?composer .' : ''}
      ?page schema:about ?item .
      OPTIONAL { ?item wdt:${source.dateProperty} ?date }
    } GROUP BY ?item HAVING (COUNT(DISTINCT ?page) >= ${source.minLinks})
  }
${LABELS}
} ORDER BY DESC(?links) LIMIT 6000`;
}

/** For the official endpoint, which has the count but is slow: the fallback. */
export function wdqsQuery(source: Extract<SeedSource, { kind: 'wikidata' }>): string {
  const types = source.types.map((type) => `wd:${type}`).join(' ');
  return `${PREFIXES}
SELECT ?item ?links ?year ?fr ?en ?mul WHERE {
  {
    SELECT ?item ?links (MIN(YEAR(?date)) AS ?year) WHERE {
      VALUES ?type { ${types} }
      ?item wdt:P31 ?type ; wikibase:sitelinks ?links .
      FILTER(?links >= ${source.minLinks})
      ${source.requireComposer ? 'FILTER EXISTS { ?item wdt:P86 [] }' : ''}
      OPTIONAL { ?item wdt:${source.dateProperty} ?date }
    } GROUP BY ?item ?links
  }
${LABELS}
} LIMIT 6000`;
}

export function wikidataSeeds(raw: unknown): RawSeed[] {
  const parsed = sparqlResults.safeParse(raw);
  if (!parsed.success) return [];

  const seeds = new Map<string, RawSeed>();
  for (const row of parsed.data.results.bindings) {
    const id = /Q\d+$/.exec(row.item?.value ?? '')?.[0];
    if (!id || seeds.has(id)) continue;
    const fr = row.fr?.value;
    const en = row.en?.value;
    const mul = row.mul?.value;
    // French first for the answer on screen, English first for the search:
    // YouTube's soundtrack uploads are overwhelmingly titled in English.
    const title = (fr || mul || en || '').trim();
    const search = (en || mul || fr || '').trim();
    if (!title) continue;
    const year = Number(row.year?.value);
    seeds.set(id, {
      source: 'wikidata',
      sourceKey: id,
      artist: '',
      title,
      search,
      aliases: otherNames(title, [en, mul, fr]),
      year: Number.isFinite(year) && year > 1800 ? year : null,
      popularity: Number(row.links?.value ?? 0) || 0
    });
  }
  return [...seeds.values()];
}

/**
 * What a classical work is not, although Wikidata files it as a musical work
 * by a composer born long ago: national anthems, hymns, songs, musicals,
 * singles and albums. The first query without this was topped by
 * L'Internationale, La Marseillaise and every anthem on the planet.
 */
const NOT_A_CONCERT_PIECE = ['Q23691', 'Q484692', 'Q7366', 'Q2743', 'Q134556', 'Q482994'];

export function compositionsQuery(source: Extract<SeedSource, { kind: 'wikidata-compositions' }>): string {
  const excluded = NOT_A_CONCERT_PIECE.map((type) => `wd:${type}`).join(' ');
  return `${PREFIXES}
SELECT ?item ?links ?composer ?fr ?en ?mul ?cfr ?cen ?cmul WHERE {
  {
    SELECT ?item ?composer (COUNT(DISTINCT ?page) AS ?links) WHERE {
      ?item wdt:P31/wdt:P279* wd:Q105543609 .
      ?item wdt:P86 ?composer .
      ?composer wdt:P106 wd:Q36834 ; wdt:P569 ?born .
      FILTER(YEAR(?born) < ${source.bornBefore})
      FILTER NOT EXISTS { VALUES ?excluded { ${excluded} } ?item wdt:P31 ?excluded }
      ?page schema:about ?item .
    } GROUP BY ?item ?composer HAVING (COUNT(DISTINCT ?page) >= ${source.minLinks})
  }
${LABELS}
  OPTIONAL { ?composer rdfs:label ?cfr FILTER(LANG(?cfr) = "fr") }
  OPTIONAL { ?composer rdfs:label ?cen FILTER(LANG(?cen) = "en") }
  OPTIONAL { ?composer rdfs:label ?cmul FILTER(LANG(?cmul) = "mul") }
} ORDER BY DESC(?links) LIMIT 6000`;
}

/**
 * Works as seeds with their composer as the artist.
 *
 * The composer is shown in French and searched in English, for the same reason
 * as a film: "Tchaikovsky" is how YouTube titles him, "Tchaïkovski" is how a
 * French room writes him, and the matcher forgives the difference either way.
 * A work with two composers keeps the first one the query returned.
 */
export function compositionSeeds(raw: unknown): RawSeed[] {
  const parsed = sparqlResults.safeParse(raw);
  if (!parsed.success) return [];

  const seeds = new Map<string, RawSeed>();
  for (const row of parsed.data.results.bindings) {
    const id = /Q\d+$/.exec(row.item?.value ?? '')?.[0];
    if (!id || seeds.has(id)) continue;
    const title = (row.fr?.value || row.mul?.value || row.en?.value || '').trim();
    const artist = (row.cfr?.value || row.cmul?.value || row.cen?.value || '').trim();
    const searchAs = (row.cen?.value || row.cmul?.value || row.cfr?.value || '').trim();
    if (!title || !artist || !normalizeAnswer(artist)) continue;
    seeds.set(id, {
      source: 'wikidata',
      sourceKey: id,
      artist,
      title,
      search: searchAs,
      aliases: otherNames(title, [row.en?.value, row.mul?.value, row.fr?.value]),
      year: null,
      popularity: Number(row.links?.value ?? 0) || 0
    });
  }
  return [...seeds.values()];
}

/* ------------------------------------------------------------- hit videos */

/**
 * Where a hit's video is found without a search, which costs a hundred units.
 *
 * Wikidata holds the YouTube video of some forty thousand songs (P1651) and
 * the channel of eighteen thousand performers (P2397), whose uploads read at
 * one unit a page of fifty. Measured against the 1,756 hits the catalogue
 * lacked: the videos covered 766 of them, and the channels 709 of the rest.
 * What neither finds is searched, as before.
 */
export interface VideoIndex {
  /** `songKeys` to the song's video ids. */
  songs: Map<string, string[]>;
  /** An artist's name, normalised, to their channel ids. */
  channels: Map<string, string[]>;
}

/** Videos kept for one song. A lookup costs no search, but each one is read by the model. */
const VIDEOS_PER_SONG = 3;

/** Every song with a performer and a YouTube video, under each of its names. */
export const SONG_VIDEOS_QUERY = `${PREFIXES}
SELECT DISTINCT ?vid ?title ?artist WHERE {
  ?item wdt:P1651 ?vid ; wdt:P175 ?performer .
  ?item rdfs:label ?t FILTER(LANG(?t) IN ("en", "mul", "fr"))
  ?performer rdfs:label ?a FILTER(LANG(?a) IN ("en", "mul", "fr"))
  BIND(STR(?t) AS ?title) BIND(STR(?a) AS ?artist)
}`;

/** Every performer with a YouTube channel, under each of their names. */
export const ARTIST_CHANNELS_QUERY = `${PREFIXES}
SELECT DISTINCT ?channel ?name WHERE {
  ?work wdt:P175 ?performer . ?performer wdt:P2397 ?channel .
  ?performer rdfs:label ?n FILTER(LANG(?n) IN ("en", "mul", "fr"))
  BIND(STR(?n) AS ?name)
}`;

const VIDEO_ID = /^[\w-]{11}$/;
const CHANNEL_ID = /^UC[\w-]{22}$/;

/** A channel is matched on the artist's whole name: the lead of a duet has a channel of their own. */
function channelKey(artist: string): string {
  return normalizeAnswer(artist).replace(/^the /, '');
}

/** The index the two queries above answer, or null when either answer is not one. */
export function videoIndex(songsRaw: unknown, channelsRaw: unknown): VideoIndex | null {
  const songs = sparqlResults.safeParse(songsRaw);
  const channels = sparqlResults.safeParse(channelsRaw);
  if (!songs.success || !channels.success) return null;

  const index: VideoIndex = { songs: new Map(), channels: new Map() };
  const add = (map: Map<string, string[]>, key: string, id: string) => {
    const ids = map.get(key) ?? [];
    if (!ids.includes(id) && ids.length < VIDEOS_PER_SONG) ids.push(id);
    map.set(key, ids);
  };
  for (const row of songs.data.results.bindings) {
    const id = row.vid?.value ?? '';
    if (!VIDEO_ID.test(id)) continue;
    for (const key of songKeys(row.artist?.value ?? '', row.title?.value ?? '')) add(index.songs, key, id);
  }
  for (const row of channels.data.results.bindings) {
    const id = row.channel?.value ?? '';
    const key = channelKey(row.name?.value ?? '');
    if (CHANNEL_ID.test(id) && key) add(index.channels, key, id);
  }
  return index;
}

/** The videos Wikidata gives this song, under any of its names. */
export function videosFor(index: VideoIndex, artist: string, title: string): string[] {
  const ids = new Set(songKeys(artist, title).flatMap((key) => index.songs.get(key) ?? []));
  return [...ids].slice(0, VIDEOS_PER_SONG);
}

/** The artist's YouTube channels, by their whole name. */
export function channelsFor(index: VideoIndex, artist: string): string[] {
  const key = channelKey(artist);
  return key ? (index.channels.get(key) ?? []) : [];
}

/** A channel's uploads, as a playlist: its id with `UU` where the channel's has `UC`. */
export function uploadsPlaylist(channelId: string): string {
  return `UU${channelId.slice(2)}`;
}

/** What makes an upload something other than the recording, unless the song's own name says it. */
const NOT_THE_RECORDING =
  /\b(live|teaser|trailer|making|behind|backstage|interview|reaction|snippet|extrait|preview|shorts?|tiktok|karaoke|instrumental|cover|remix|acoustic|acoustique|session|version)\b/gi;
const OFFICIAL = /\b(official|officiel(?:le)?|clip|music video|audio|visuali[sz]er)\b/i;

function noiseIn(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(NOT_THE_RECORDING)) {
    const word = (match[1] ?? '').toLowerCase();
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}

/**
 * Whether a video's title says it is this song, and only the song.
 *
 * It has to hold one of the song's names as whole words, and must not also say
 * it is a live take, a teaser or a remix more often than the song's own name
 * does: Oasis's "Live Forever" is live only in its title, and "Live Forever
 * (Live at Knebworth)" says it once more.
 */
export function isTheRecording(videoTitle: string, title: string): boolean {
  const text = ` ${normalizeAnswer(videoTitle)} `;
  if (!titleKeys(title).some((name) => text.includes(` ${name} `))) return false;
  const own = noiseIn(title);
  return [...noiseIn(videoTitle)].every(([word, times]) => times <= (own.get(word) ?? 0));
}

/**
 * The uploads on an artist's channel that are this song, the official ones
 * first. See `isTheRecording`. The model reads what is kept, as it reads a
 * search's: a title matched on a channel is a guess, where Wikidata's is a fact.
 */
export function uploadsFor(uploads: readonly { title: string; videoId: string }[], title: string): string[] {
  return uploads
    .filter((upload) => isTheRecording(upload.title, title))
    .sort((left, right) => Number(OFFICIAL.test(right.title)) - Number(OFFICIAL.test(left.title)))
    .slice(0, VIDEOS_PER_SONG)
    .map((upload) => upload.videoId);
}

/** A hit's title as the answer: without what the release added, "(feat. David Bowie)". */
export function songTitle(title: string): string {
  return title.replace(RELEASE_NOTE, '').trim() || title;
}

/** What one source returned, and how many of its requests failed on the way. */
interface Harvest {
  seeds: RawSeed[];
  failed: number;
}

/* --------------------------------------------------------------- planning */

function parseAliases(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function toSeed(row: {
  id: number;
  artist: string;
  title: string;
  search: string;
  aliases: string;
  year: number | null;
  fame: number;
  videos: string | null;
  videos_from: string | null;
  source?: string;
}): Seed {
  return {
    id: row.id,
    artist: row.artist,
    title: row.title,
    search: row.search,
    aliases: parseAliases(row.aliases),
    year: row.year,
    fame: row.fame,
    ...(row.videos ? { videos: parseAliases(row.videos) } : {}),
    ...(row.videos_from === 'wikidata' || row.videos_from === 'channel' ? { videosFrom: row.videos_from } : {}),
    ...(row.source === 'request' ? { requested: true } : {})
  };
}

/**
 * Whether a genre's famous seeds are searched one song at a time. See `HIT_FAME`.
 *
 * Only where the seeds are an editor's tracks, credited the way the uploads
 * are. A Wikidata work is "Symphony No. 5" under "Ludwig van Beethoven", which
 * no upload's title says word for word.
 */
export function searchesHits(genre: SeededGenre): boolean {
  return genre.answerShape === 'artist-title' && (genre.seeds?.some((source) => source.kind === 'deezer') ?? false);
}

/**
 * Groups unsearched seeds into YouTube searches. Pure, for the tests.
 *
 * A genre's hits first, a few songs to a search by artist and title, for any
 * room that may be dealt one. Then music by artist, a few artists per search,
 * every seed of a chosen artist riding along so the whole artist is marked
 * once searched, except its hits, which are only ever searched as themselves.
 * A work is searched by its name and the genre's suffix.
 */
export function planFromSeeds(
  genre: SeededGenre,
  seeds: Seed[],
  searches: number,
  window?: { min: number; max: number },
  random = Math.random
): SeedSearch[] {
  if (searches <= 0 || seeds.length === 0) return [];

  /**
   * What an admin asked for first, then the rest with what is left.
   *
   * Planned the same way as the others, a requested song as a hit and a work
   * as a work: only their place in the queue is theirs.
   */
  const requested = seeds.filter((seed) => seed.requested);
  if (requested.length > 0 && requested.length < seeds.length) {
    const first = planFromSeeds(genre, requested, searches, window, random);
    const rest = seeds.filter((seed) => !seed.requested);
    return [...first, ...planFromSeeds(genre, rest, searches - first.length, window, random)];
  }

  if (genre.answerShape === 'artist-title') {
    if (!searchesHits(genre)) return planArtists(genre, seeds, searches, window, random);
    const hits = seeds.filter((seed) => seed.fame >= HIT_FAME);
    const rest = seeds.filter((seed) => seed.fame < HIT_FAME);
    const first = !window || window.min <= HIT_WINDOW_MIN ? planHits(hits, searches, window, random) : [];
    return [...first, ...planArtists(genre, rest, searches - first.length, window, random)];
  }

  const chosen = weightedSample(seeds, searches * WORKS_PER_SEARCH, (seed) => fameWeight(seed.fame, window), random);
  const suffix = genre.seedSuffix ? ` ${genre.seedSuffix}` : '';
  const plan: SeedSearch[] = [];
  for (let index = 0; index < chosen.length; index += WORKS_PER_SEARCH) {
    const chunk = chosen.slice(index, index + WORKS_PER_SEARCH);
    const names = chunk.map((seed) => seed.search || seed.title);
    plan.push({
      query: genre.seedSuffixInPhrase
        ? names.map((name) => phrase(`${name}${suffix}`)).join('|')
        : `${names.map((name) => phrase(name)).join('|')}${suffix}`,
      limit: 50,
      seeds: chunk,
      aim: 'works',
      hint: chunk.map((seed) => seed.title).join(', ')
    });
  }
  return plan;
}

/**
 * Famous songs, by artist and title, a few to a search.
 *
 * One song is often several seeds, a track on three editors' lists under three
 * Deezer ids, and they go together: searched once, spent together.
 */
function planHits(
  seeds: Seed[],
  searches: number,
  window: { min: number; max: number } | undefined,
  random: () => number
): SeedSearch[] {
  if (searches <= 0) return [];
  const bySong = new Map<string, { lead: Seed; seeds: Seed[] }>();
  for (const seed of seeds) {
    const key = hitSongKey(seed);
    const song = bySong.get(key);
    if (!song) bySong.set(key, { lead: seed, seeds: [seed] });
    else {
      song.seeds.push(seed);
      if (seed.fame > song.lead.fame) song.lead = seed;
    }
  }

  // The songs whose videos are known first: they cost no search at all.
  const videosOf = (song: { seeds: Seed[] }) =>
    [...new Set(song.seeds.flatMap((seed) => seed.videos ?? []))].slice(0, VIDEOS_PER_SONG);
  const weight = (song: { lead: Seed }) => fameWeight(song.lead.fame, window);
  const songs = [...bySong.values()];
  const hint = (chunk: { lead: Seed }[]) => chunk.map((song) => `${song.lead.artist} - ${song.lead.title}`).join(', ');

  const plan: SeedSearch[] = [];
  const known = weightedSample(
    songs.filter((song) => videosOf(song).length > 0),
    searches * HITS_PER_LOOKUP,
    weight,
    random
  );
  for (let index = 0; index < known.length; index += HITS_PER_LOOKUP) {
    const chunk = known.slice(index, index + HITS_PER_LOOKUP);
    plan.push({
      query: '',
      limit: 50,
      seeds: chunk.flatMap((song) => song.seeds),
      aim: 'hits',
      videoIds: chunk.flatMap(videosOf),
      hint: hint(chunk)
    });
  }

  const chosen = weightedSample(
    songs.filter((song) => videosOf(song).length === 0),
    (searches - plan.length) * HITS_PER_SEARCH,
    weight,
    random
  );
  for (let index = 0; index < chosen.length; index += HITS_PER_SEARCH) {
    const chunk = chosen.slice(index, index + HITS_PER_SEARCH);
    plan.push({
      query: chunk.map((song) => hitPhrase(song.lead)).join('|'),
      limit: 50,
      seeds: chunk.flatMap((song) => song.seeds),
      aim: 'hits',
      hint: hint(chunk)
    });
  }
  return plan;
}

function planArtists(
  genre: SeededGenre,
  seeds: Seed[],
  searches: number,
  window: { min: number; max: number } | undefined,
  random: () => number
): SeedSearch[] {
  if (searches <= 0) return [];
  const byArtist = new Map<string, { artist: string; search: string; fame: number; seeds: Seed[] }>();
  for (const seed of seeds) {
    const key = normalizeAnswer(seed.artist);
    if (!key) continue;
    const group = byArtist.get(key);
    if (group) {
      group.seeds.push(seed);
      group.fame = Math.max(group.fame, seed.fame);
    } else {
      // A composer is searched under the name YouTube uses; a Deezer artist has
      // no separate search name and is searched as credited.
      byArtist.set(key, { artist: seed.artist, search: seed.search || seed.artist, fame: seed.fame, seeds: [seed] });
    }
  }

  const chosen = weightedSample(
    [...byArtist.values()],
    searches * ARTISTS_PER_SEARCH,
    (group) =>
      fameWeight(group.fame, window) *
      (genre.artistWeight === 'repertoire' ? Math.sqrt(Math.min(group.seeds.length, REPERTOIRE_CAP)) : 1),
    random
  );
  const plan: SeedSearch[] = [];
  for (let index = 0; index < chosen.length; index += ARTISTS_PER_SEARCH) {
    const chunk = chosen.slice(index, index + ARTISTS_PER_SEARCH);
    plan.push({
      query: chunk.map((group) => phrase(group.search)).join('|'),
      limit: 50,
      seeds: chunk.flatMap((group) => group.seeds),
      aim: 'artists',
      hint: chunk.map((group) => group.artist).join(', ')
    });
  }
  return plan;
}

/* ----------------------------------------------------------------- oracle */

/**
 * What a genre's seeds know, keyed by normalised name.
 *
 * The seeds are a list of things that belong to the genre, written down by
 * people whose job is exactly that. So they settle the question the model is
 * worst at: whether an artist is really rap, whether a work is really a game.
 */
export interface GenreOracle {
  /** Normalised artist to the fame of their best-known seeded track. */
  artists: Map<string, number>;
  /**
   * `artist::title`, normalised, to that track's fame and its length.
   *
   * The length is what tells a music video from its recording: a video longer
   * than the track it carries has that much that is not the song. See
   * `clipWindow`.
   */
  tracks: Map<string, { fame: number; duration: number | null }>;
  /**
   * Any normalised name of a work to the work, with its Wikidata item when the
   * seed came from Wikidata, so its fame is looked up by id rather than by name.
   */
  works: Map<string, { names: string[]; fame: number; year: number | null; wikidataId?: string | null }>;
  /**
   * Names the seeds also file on another shelf: David Guetta under pop and
   * electro, Fargo under films and series. The seeds cannot settle those, so
   * the model's judgement stands for them.
   */
  contested: Set<string>;
}

export function trackOracleKey(artist: string, title: string): string {
  return `${normalizeAnswer(artist)}::${normalizeAnswer(title)}`;
}

const ORACLE_TTL_MS = 10 * 60 * 1000;

export function buildOracle(
  seeds: {
    artist: string;
    title: string;
    aliases: string[];
    fame: number;
    year: number | null;
    duration?: number | null;
    source?: string;
    source_key?: string;
  }[]
): GenreOracle {
  const oracle: GenreOracle = { artists: new Map(), tracks: new Map(), works: new Map(), contested: new Set() };
  for (const seed of seeds) {
    if (seed.artist) {
      const artist = normalizeAnswer(seed.artist);
      if (!artist) continue;
      oracle.artists.set(artist, Math.max(oracle.artists.get(artist) ?? 0, seed.fame));
      oracle.tracks.set(trackOracleKey(seed.artist, seed.title), { fame: seed.fame, duration: seed.duration ?? null });
      continue;
    }
    const work = {
      names: [seed.title, ...seed.aliases],
      fame: seed.fame,
      year: seed.year,
      wikidataId:
        seed.source === 'wikidata' && seed.source_key && /^Q\d+$/.test(seed.source_key) ? seed.source_key : null
    };
    for (const name of work.names) {
      const key = normalizeAnswer(name);
      if (key && !oracle.works.has(key)) oracle.works.set(key, work);
    }
  }
  return oracle;
}

/**
 * Which genres know a name, across all of them. For the genre check.
 *
 * `harvested` lists the genres that have any seeds at all, because "not in
 * this genre's seeds" only means something for a genre that has some.
 */
export interface SeedIndex {
  artists: Map<string, Set<string>>;
  works: Map<string, Set<string>>;
  harvested: Set<string>;
}

/* ------------------------------------------------------------------ stock */

/** Where Wikidata's list of song videos and artist channels stands. See `SeedStock.videoIndex`. */
export interface VideoIndexStatus {
  loadedAt: string | null;
  songs: number;
  channels: number;
  /** The last failure, when it came after the last load. */
  failedAt: string | null;
  error: string | null;
}

export interface SeedStats {
  genreId: string;
  total: number;
  fresh: number;
  harvestedAt: string | null;
  error: string | null;
}

/** The seeds in stock, and everything that fetches, spends and reads them. */
export interface SeedStock {
  /**
   * Fetches a genre's seeds from its sources and stores them.
   *
   * Returns how many the sources offered. One run per genre at a time; a second
   * caller waits for the first. Sources fail independently, and only a harvest
   * where every source failed is recorded as an error.
   */
  harvest(genre: SeededGenre): Promise<number>;
  /** Starts every due harvest, one after another, without waiting for any, the charts last. */
  warm(genres: readonly SeededGenre[]): void;
  /** Fetches the charts and files their songs into these genres. See `CHARTS`. Returns how many songs. */
  harvestCharts(genres: readonly SeededGenre[]): Promise<number>;
  /** Waits for the charts: the fetch under way, or one that is due. Nothing when they are filed and fresh. */
  chartsReady(genres: readonly SeededGenre[]): Promise<void>;
  /**
   * An admin's ask for more of an artist (their top tracks on Deezer, `count`
   * of them) or for a work, stored as seeds planned before the rest of the genre.
   */
  request(
    genre: SeededGenre,
    name: string,
    options?: { count?: number; userId?: number | null; artistId?: number }
  ): Promise<RequestResult>;
  /** Deezer's artists for a name, to pick the one meant. Null when Deezer did not answer. */
  artistCandidates(name: string): Promise<ArtistCandidate[] | null>;
  /** Every request, newest first, with how far the fills have got. */
  requests(): SeedRequest[];
  /** Forgets a request and its seeds. Whether there was one. */
  cancelRequest(id: number): boolean;
  /** The genres holding requested seeds nobody has searched yet. */
  requestedGenres(): Set<string>;
  /** Hits not searched yet whose videos are known: what a fill files without a search. */
  knownVideosWaiting(): number;
  /** Makes sure a genre has seeds to search, harvesting when it is due. */
  ensure(genre: SeededGenre): Promise<void>;
  /** The next searches for a genre, from seeds nobody has searched yet. */
  plan(genre: SeededGenre, searches: number, window?: { min: number; max: number }): SeedSearch[];
  /**
   * Marks a search's seeds as spent, with what they produced.
   *
   * Called after the search ran, not when it was planned, so a search the quota
   * refused leaves its seeds for another day.
   */
  markSearched(search: SeedSearch, found: number): void;
  /**
   * Rests a search's hits; see `HIT_REST_MS`. Not spent: a hit is spent once
   * its song is in the catalogue (see `settleHits`), which a room's pool alone
   * does not put it in.
   */
  markTried(search: SeedSearch): void;
  /** Counts a try against a search's hits, for a run that files what it finds. See `HIT_TRIES`. */
  countTry(search: SeedSearch): void;
  /** Hands a search's seeds back, for a run that could make nothing of its results. */
  unmarkSearched(search: SeedSearch): void;
  /**
   * Spends a genre's hits whose song the catalogue holds, and those tried too
   * often to keep trying. `covered` is every catalogue recording's `songKeys`.
   */
  settleHits(genre: SeededGenre, covered: ReadonlySet<string>): void;
  /**
   * Puts back every hit spent without its song reaching the catalogue, for the
   * one pass that undid the artist searches' losses. Returns how many.
   */
  reopenHits(genre: SeededGenre, covered: ReadonlySet<string>): number;
  /**
   * A genre's unspent hits nobody has looked for a video for yet. They wait,
   * unplanned, until somebody has: see `lookUpVideos` in the catalogue.
   */
  pendingVideos(genre: SeededGenre): { id: number; artist: string; title: string }[];
  /** What was found for these hits: their videos, or none. */
  recordVideos(found: { id: number; videos: string[]; from: VideosFrom | null }[]): void;
  /**
   * Wikidata's songs and channels, fetched once a day and kept across restarts.
   * Null while QLever will not answer. Without `wait`, a list not loaded yet is
   * asked for in the background and null comes back at once: a room's fill does
   * not wait minutes on it, the night's prefill does.
   */
  videoIndex(wait?: boolean, force?: boolean): Promise<VideoIndex | null>;
  /** When the list last loaded or failed to, and how big it is. For the diagnostics. */
  videoIndexStatus(): VideoIndexStatus;
  /**
   * A genre's oracle, from every seed it has, searched or not. Cached briefly.
   *
   * `sameShelf` says which other genres do not count against it: the openings
   * and the endings share every anime, and that is not a disagreement.
   */
  oracle(genreId: string, sameShelf?: (otherGenreId: string) => boolean): GenreOracle;
  /** Which genres know each name, across all of them. Cached briefly. */
  index(): SeedIndex;
  /** Per genre: how many seeds, how many never searched, and the last harvest. */
  stats(): SeedStats[];
}

/**
 * The seed stock over one database, fetching through `sources`.
 *
 * The caches live here rather than at module level so that each stock has its
 * own: the app makes one, and a test makes one per case without inheriting the
 * last one's anime list or oracles.
 */
export function createSeedStock({
  sources,
  db,
  clock,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}: {
  sources: SeedSources;
  db: Db;
  clock: Pick<Clock, 'now'>;
  /** How the stock waits before asking a throttled service again. A test's is instant. */
  wait?: (ms: number) => Promise<void>;
}): SeedStock {
  /**
   * The anime list, shared between the openings and the endings.
   *
   * Both genres want the same two thousand series, and fetching it twice is
   * three minutes of a rate-limited free service for nothing.
   */
  let anilistCache: { at: number; seeds: RawSeed[] } | null = null;

  const harvesting = new Map<string, Promise<number>>();
  let harvestQueue: Promise<unknown> = Promise.resolve();

  const oracles = new Map<string, { at: number; oracle: GenreOracle }>();
  let seedIndexCache: { at: number; index: SeedIndex } | null = null;

  const stamp = (at = clock.now()) => new Date(at).toISOString();

  /* ------------------------------------------------------------- sources */

  /**
   * A genre's tracks, from its curated playlists.
   *
   * Two ways in, in this order. The searches, read two pages deep instead of
   * twenty-five results: that alone nearly doubled pop, rock and French rap, and
   * did little for K-pop or reggae, whose searches keep returning the same few
   * playlists. Then the genre's own editors' lists, which is where the rest of a
   * genre's catalogue lives: a rap editor publishes one playlist per decade and
   * city, and a search finds three of them.
   */
  async function harvestDeezer(source: Extract<SeedSource, { kind: 'deezer' }>): Promise<Harvest> {
    const playlists = new Map<number, string>();
    const editors = new Map<number, string>();
    let failed = 0;
    const counted = (raw: unknown) => {
      if (raw === null) failed += 1;
      return raw;
    };
    const take = (found: { id: number; title: string }[]) => {
      for (const playlist of found) {
        if (playlists.size >= DEEZER_PLAYLISTS_PER_GENRE) return;
        playlists.set(playlist.id, playlist.title);
      }
    };

    for (const query of source.playlistQueries) {
      for (let index = 0; index < DEEZER_RESULTS_PER_QUERY; index += 50) {
        const raw = counted(await sources.deezer.searchPlaylists(query, { index, limit: 50 }));
        take(curatedPlaylists(raw, source.titleMatch));
        for (const editor of genreEditors(raw, source.titleMatch)) editors.set(editor.id, editor.name);
        if (pageSize(raw) < 50) break;
      }
    }

    for (const [editor, name] of editors) {
      if (playlists.size >= DEEZER_PLAYLISTS_PER_GENRE) break;
      for (let index = 0; index < DEEZER_PLAYLISTS_PER_EDITOR; index += 100) {
        const raw = counted(await sources.deezer.userPlaylists(editor, { index, limit: 100 }));
        take(editorPlaylists(raw, name, source.titleMatch));
        if (pageSize(raw) < 100) break;
      }
    }

    const seeds = new Map<string, RawSeed>();
    for (const id of playlists.keys()) {
      for (let index = 0; index < DEEZER_TRACKS_PER_PLAYLIST; index += 100) {
        const raw = counted(await sources.deezer.playlistTracks(id, { index, limit: 100 }));
        for (const seed of deezerSeeds(raw)) {
          if (!seeds.has(seed.sourceKey)) seeds.set(seed.sourceKey, seed);
        }
        // What the API sent, not what survived the filter: one track not playable
        // here made a full page of a 250-track playlist look like its last.
        if (trackPageSize(raw) < 100) break;
      }
    }
    return { seeds: [...seeds.values()], failed };
  }

  async function harvestAnilist(): Promise<Harvest> {
    if (anilistCache && clock.now() - anilistCache.at < 6 * 60 * 60 * 1000) {
      return { seeds: anilistCache.seeds, failed: 0 };
    }

    const seeds: RawSeed[] = [];
    let failed = 0;
    for (let page = 1; page <= ANILIST_PAGES; page++) {
      const raw = await sources.anilist(page);

      // A page that would not come is skipped rather than taken for the end of
      // the list, which is what it used to be: one bad minute cut two thousand
      // series to however many pages had arrived, and filed that as a success.
      if (raw === null) {
        failed += 1;
        if (failed >= 3) break;
        continue;
      }
      const result = anilistSeeds(raw);
      seeds.push(...result.seeds);
      if (!result.more) break;
    }

    // Only a whole list is shared with the other anime genre.
    if (seeds.length > 0 && failed === 0) anilistCache = { at: clock.now(), seeds };
    return { seeds, failed };
  }

  async function harvestCompositions(source: Extract<SeedSource, { kind: 'wikidata-compositions' }>): Promise<Harvest> {
    const seeds = compositionSeeds(await sources.sparql('qlever', compositionsQuery(source)));
    return { seeds, failed: 0 };
  }

  async function harvestWikidata(source: Extract<SeedSource, { kind: 'wikidata' }>): Promise<Harvest> {
    const fast = wikidataSeeds(await sources.sparql('qlever', qleverQuery(source)));
    if (fast.length > 0) return { seeds: fast, failed: 0 };
    return { seeds: wikidataSeeds(await sources.sparql('wikidata', wdqsQuery(source))), failed: 0 };
  }

  /** One chart's tracks, every page of them. */
  async function chartTracks(
    playlistId: number,
    counted: (raw: unknown) => unknown
  ): Promise<{ seed: RawSeed; album: number | null }[]> {
    const tracks: { seed: RawSeed; album: number | null }[] = [];
    for (let index = 0; index < DEEZER_TRACKS_PER_PLAYLIST; index += 100) {
      const raw = counted(await sources.deezer.playlistTracks(playlistId, { index, limit: 100 }));
      tracks.push(...deezerTrackSeeds(raw));
      if (trackPageSize(raw) < 100) break;
    }
    return tracks;
  }

  /**
   * The year-end charts and the French decade lists, filed into the genres. See `CHARTS`.
   *
   * After the genres' own harvests, since an artist is filed where their seeds
   * are. A song filed under another genre last month and somewhere else now is
   * moved: it is the same seed, and two of it would be searched twice.
   */
  async function harvestChartsNow(genres: readonly SeededGenre[]): Promise<number> {
    const genreIds = new Set(genres.filter(searchesHits).map((genre) => genre.id));
    if (genreIds.size === 0) return 0;
    let failed = 0;
    const counted = (raw: unknown) => {
      if (raw === null) failed += 1;
      return raw;
    };

    const charts = new Map<number, ChartSide>();
    for (let index = 0; index < DEEZER_PLAYLISTS_PER_EDITOR; index += 100) {
      const raw = counted(await sources.deezer.userPlaylists(CHARTS.yearlyEditor, { index, limit: 100 }));
      for (const playlist of deezerPlaylists.safeParse(raw).data?.data ?? []) {
        if (chartYear(playlist.title) !== null) charts.set(playlist.id, 'world');
      }
      if (pageSize(raw) < 100) break;
    }
    for (const query of CHARTS.frenchQueries) {
      const raw = counted(await sources.deezer.searchPlaylists(query, { index: 0, limit: 50 }));
      for (const playlist of curatedPlaylists(raw, CHARTS.frenchTitle)) {
        if (!charts.has(playlist.id)) charts.set(playlist.id, 'france');
      }
    }

    // One seed a song: the same hit is on a year's list and on two decade lists.
    const songs = new Map<string, { seed: RawSeed; album: number | null; side: ChartSide }>();
    for (const [playlistId, side] of charts) {
      for (const track of await chartTracks(playlistId, counted)) {
        const key = hitSongKey(track.seed);
        if (!songs.has(key)) songs.set(key, { ...track, seed: { ...track.seed, source: 'chart' }, side });
      }
    }
    if (songs.size === 0) {
      recordHarvest(CHARTS_HARVEST, 0, failed > 0 ? `${failed} request(s) failed` : 'no chart found');
      return 0;
    }

    const artistGenres = new Map<string, Map<string, number>>();
    const rows = db
      .select({ artist: blindtestSeeds.artist, genreId: blindtestSeeds.genre_id, seeds: count() })
      .from(blindtestSeeds)
      .where(sql`${blindtestSeeds.source} <> 'chart'`)
      .groupBy(blindtestSeeds.artist, blindtestSeeds.genre_id)
      .all();
    for (const row of rows) {
      const key = normalizeAnswer(row.artist);
      if (!key) continue;
      const genres = artistGenres.get(key) ?? new Map<string, number>();
      genres.set(row.genreId, (genres.get(row.genreId) ?? 0) + row.seeds);
      artistGenres.set(key, genres);
    }

    // An admin's "all this artist's songs go here" outranks every seed.
    const remembered = new Map(
      db
        .select()
        .from(blindtestArtistGenres)
        .all()
        .map((row) => [row.artist, row.genre_id])
    );

    // Asked only for the artists no genre knows: a tenth of them, measured.
    const albums = new Map<number, number | null>();
    const byGenre = new Map<string, RawSeed[]>();
    for (const { seed, album, side } of songs.values()) {
      const known = artistGenres.has(normalizeAnswer(seed.artist)) || remembered.has(normalizeAnswer(seed.artist));
      if (!known && album !== null && !albums.has(album)) {
        albums.set(album, albumGenre(counted(await sources.deezer.album(album))));
      }
      const genreId = chartGenre(
        seed.artist,
        side,
        artistGenres,
        album === null ? null : (albums.get(album) ?? null),
        genreIds,
        remembered
      );
      if (genreId) byGenre.set(genreId, [...(byGenre.get(genreId) ?? []), seed]);
    }

    // All of them hits, the best known of them first.
    const fame = new Map(
      rankFame([...songs.values()].map((song) => song.seed)).map((seed) => [seed.sourceKey, seed.fame])
    );
    for (const [genreId, seeds] of byGenre) {
      db.delete(blindtestSeeds)
        .where(
          and(
            eq(blindtestSeeds.source, 'chart'),
            sql`${blindtestSeeds.genre_id} <> ${genreId}`,
            inArray(
              blindtestSeeds.source_key,
              seeds.map((seed) => seed.sourceKey)
            )
          )
        )
        .run();
      storeRanked(
        genreId,
        seeds.map((seed) => ({ ...seed, fame: HIT_FAME + (1 - HIT_FAME) * (fame.get(seed.sourceKey) ?? 0) }))
      );
    }
    invalidateOracles();
    recordHarvest(CHARTS_HARVEST, songs.size, failed > 0 ? `partial: ${failed} request(s) failed` : null);
    return songs.size;
  }

  function harvestCharts(genres: readonly SeededGenre[]): Promise<number> {
    const running = harvesting.get(CHARTS_HARVEST);
    if (running) return running;
    const run = harvestQueue.then(() => harvestChartsNow(genres)).finally(() => harvesting.delete(CHARTS_HARVEST));
    harvestQueue = run.catch(() => 0);
    harvesting.set(CHARTS_HARVEST, run);
    return run;
  }

  async function chartsReady(genres: readonly SeededGenre[]): Promise<void> {
    const running = harvesting.get(CHARTS_HARVEST);
    if (running) await running.catch(() => 0);
    else if (genres.some(searchesHits) && harvestDue(CHARTS_HARVEST)) await harvestCharts(genres).catch(() => 0);
  }

  /* ------------------------------------------------------------ requests */

  async function request(
    genre: SeededGenre,
    name: string,
    options: { count?: number; userId?: number | null; artistId?: number } = {}
  ): Promise<RequestResult> {
    const asked = name.trim();
    if (!requestable(genre) || !asked) return { ok: false, reason: 'not-requestable' };

    let foundAs = asked;
    let seeds: RawSeed[] = [];
    if (genre.answerShape === 'work') {
      seeds = [
        {
          source: 'request',
          sourceKey: 'work',
          artist: '',
          title: asked,
          search: asked,
          aliases: [],
          year: null,
          popularity: 1
        }
      ];
    } else {
      const found = await sources.deezer.searchArtists(asked);
      if (found === null) return { ok: false, reason: 'unavailable' };
      // The one the admin picked, among the same answers they were shown.
      const artist =
        options.artistId === undefined
          ? pickArtist(found, asked)
          : (artistCandidates(found).find((candidate) => candidate.id === options.artistId) ?? null);
      if (!artist) return { ok: false, reason: 'not-found' };
      const count = Math.min(REQUEST_SONGS_MAX, Math.max(1, Math.round(options.count ?? REQUEST_SONGS)));
      // Twice as many, since the featured and the second versions are left out.
      const top = await sources.deezer.artistTop(artist.id, Math.min(100, count * 2));
      if (top === null) return { ok: false, reason: 'unavailable' };
      foundAs = artist.name;
      seeds = ownTopTracks(top, artist.id, count);
      if (seeds.length === 0) return { ok: false, reason: 'not-found' };
    }

    const id = db.transaction((tx) => {
      const row = tx
        .insert(blindtestRequests)
        .values({ genre_id: genre.id, name: asked, found_as: foundAs, user_id: options.userId ?? null })
        .returning({ id: blindtestRequests.id })
        .get();
      for (const seed of seeds) {
        tx.insert(blindtestSeeds)
          .values({
            genre_id: genre.id,
            source: 'request',
            source_key: `${row.id}:${seed.sourceKey}`,
            artist: seed.artist,
            title: seed.title,
            search: seed.search,
            aliases: JSON.stringify(seed.aliases),
            year: seed.year,
            // A hit, searched or looked up as itself: see `HIT_FAME`.
            fame: 1,
            duration: seed.duration ?? null
          })
          .onConflictDoNothing()
          .run();
      }
      return row.id;
    });
    invalidateOracles();
    const stored = requests().find((entry) => entry.id === id);
    return stored ? { ok: true, request: stored } : { ok: false, reason: 'not-found' };
  }

  async function candidatesFor(name: string): Promise<ArtistCandidate[] | null> {
    const asked = name.trim();
    if (!asked) return [];
    const found = await sources.deezer.searchArtists(asked);
    return found === null ? null : artistCandidates(found);
  }

  /** The request a seed belongs to, from its key: `12:3135556` is request 12's. */
  const requestIdOf = (sourceKey: string) => Number(sourceKey.slice(0, sourceKey.indexOf(':')));

  function requests(): SeedRequest[] {
    const seeds = db
      .select({
        key: blindtestSeeds.source_key,
        artist: blindtestSeeds.artist,
        searched: blindtestSeeds.searched_at,
        found: blindtestSeeds.found,
        videos: blindtestSeeds.videos
      })
      .from(blindtestSeeds)
      .where(eq(blindtestSeeds.source, 'request'))
      .all();
    const empty = { seeds: 0, filed: 0, missed: 0, waiting: 0, needSearch: 0 };
    const counts = new Map<number, typeof empty>();
    for (const seed of seeds) {
      const id = requestIdOf(seed.key);
      const count = counts.get(id) ?? { ...empty };
      count.seeds += 1;
      // A song's `found` says whether it was filed; a work's, how many videos its search found.
      if (seed.searched === null) {
        count.waiting += 1;
        if (seed.artist === '' || seed.videos === '[]') count.needSearch += 1;
      } else if (seed.found > 0) count.filed += 1;
      else count.missed += 1;
      counts.set(id, count);
    }
    return db
      .select()
      .from(blindtestRequests)
      .orderBy(desc(blindtestRequests.id))
      .all()
      .map((row) => ({
        id: row.id,
        genreId: row.genre_id,
        name: row.name,
        foundAs: row.found_as,
        createdAt: row.created_at,
        ...(counts.get(row.id) ?? empty)
      }));
  }

  function cancelRequest(id: number): boolean {
    const removed = db.transaction((tx) => {
      tx.delete(blindtestSeeds)
        .where(and(eq(blindtestSeeds.source, 'request'), like(blindtestSeeds.source_key, `${id}:%`)))
        .run();
      return tx.delete(blindtestRequests).where(eq(blindtestRequests.id, id)).run().changes > 0;
    });
    invalidateOracles();
    return removed;
  }

  function requestedGenres(): Set<string> {
    const rows = db
      .selectDistinct({ genreId: blindtestSeeds.genre_id })
      .from(blindtestSeeds)
      .where(and(eq(blindtestSeeds.source, 'request'), isNull(blindtestSeeds.searched_at)))
      .all();
    return new Set(rows.map((row) => row.genreId));
  }

  function knownVideosWaiting(): number {
    return (
      db
        .select({ n: count() })
        .from(blindtestSeeds)
        .where(
          and(
            isNull(blindtestSeeds.searched_at),
            gte(blindtestSeeds.fame, HIT_FAME),
            isNotNull(blindtestSeeds.videos),
            sql`${blindtestSeeds.videos} <> '[]'`
          )
        )
        .get()?.n ?? 0
    );
  }

  /* ------------------------------------------------------------- storage */

  /** Stores a harvest. Known seeds keep their search history; their fame moves. */
  function storeSeeds(genreId: string, seeds: RawSeed[]): void {
    storeRanked(genreId, rankFame(seeds));
  }

  function storeRanked(genreId: string, ranked: (RawSeed & { fame: number })[]): void {
    db.transaction((tx) => {
      for (const seed of ranked) {
        tx.insert(blindtestSeeds)
          .values({
            genre_id: genreId,
            source: seed.source,
            source_key: seed.sourceKey,
            artist: seed.artist,
            title: seed.title,
            search: seed.search,
            aliases: JSON.stringify(seed.aliases),
            year: seed.year,
            fame: seed.fame,
            duration: seed.duration ?? null
          })
          .onConflictDoUpdate({
            target: [blindtestSeeds.genre_id, blindtestSeeds.source, blindtestSeeds.source_key],
            // The names as well as the aliases: the aliases are computed without
            // the title, so keeping an old title beside new aliases lost the new
            // name entirely (a series that gained its English title, a film its
            // French label).
            set: {
              artist: seed.artist,
              title: seed.title,
              search: seed.search,
              aliases: JSON.stringify(seed.aliases),
              year: seed.year,
              fame: seed.fame,
              duration: seed.duration ?? null
            }
          })
          .run();
      }
    });
  }

  function recordHarvest(genreId: string, seeds: number, error: string | null): void {
    const harvestedAt = stamp();
    db.insert(blindtestSeedHarvests)
      .values({ genre_id: genreId, harvested_at: harvestedAt, seeds, error })
      .onConflictDoUpdate({ target: blindtestSeedHarvests.genre_id, set: { harvested_at: harvestedAt, seeds, error } })
      .run();
  }

  /** Whether a genre's seeds should be fetched again. */
  function harvestDue(genreId: string): boolean {
    const state = db.select().from(blindtestSeedHarvests).where(eq(blindtestSeedHarvests.genre_id, genreId)).get();
    if (!state) return true;
    const age = clock.now() - Date.parse(state.harvested_at);
    return (
      age > HARVEST_TTL_MS ||
      (state.error !== null && age > HARVEST_RETRY_MS) ||
      // The charts have no seeds of their own under their name: running low means nothing for them.
      (genreId !== CHARTS_HARVEST && freshCount(genreId) < LOW_STOCK && age > DAY_MS)
    );
  }

  function seedTotal(genreId: string): number {
    const row = db.select({ value: count() }).from(blindtestSeeds).where(eq(blindtestSeeds.genre_id, genreId)).get();
    return row?.value ?? 0;
  }

  function freshCount(genreId: string): number {
    const row = db
      .select({ value: count() })
      .from(blindtestSeeds)
      .where(and(eq(blindtestSeeds.genre_id, genreId), isNull(blindtestSeeds.searched_at)))
      .get();
    return row?.value ?? 0;
  }

  /* ------------------------------------------------------------- harvest */

  function harvest(genre: SeededGenre): Promise<number> {
    const running = harvesting.get(genre.id);
    if (running) return running;

    /**
     * Queued behind every other harvest, never beside one.
     *
     * "Select all" on the setup screen warms every genre at once, and each warm
     * harvested in parallel: nine Deezer harvests at one request per 150 ms is
     * forty a second against a limit of ten, and the openings and the endings
     * both fetched AniList's forty pages because neither had finished to share
     * them. One at a time keeps each source at its own pace, and the second anime
     * genre finds the first's list waiting.
     */
    const run = harvestQueue.then(() => harvestNow(genre)).finally(() => harvesting.delete(genre.id));
    harvestQueue = run.catch(() => 0);
    harvesting.set(genre.id, run);
    return run;
  }

  async function harvestNow(genre: SeededGenre): Promise<number> {
    const collected: RawSeed[] = [];
    const errors: string[] = [];
    let failed = 0;
    for (const source of genre.seeds ?? []) {
      try {
        const result =
          source.kind === 'deezer'
            ? await harvestDeezer(source)
            : source.kind === 'anilist'
              ? await harvestAnilist()
              : source.kind === 'wikidata-compositions'
                ? await harvestCompositions(source)
                : await harvestWikidata(source);
        collected.push(...result.seeds);
        failed += result.failed;
      } catch (error) {
        errors.push(`${source.kind}: ${String(error).slice(0, 120)}`);
      }
    }

    if (collected.length === 0) {
      recordHarvest(genre.id, 0, errors.join('; ') || 'no seeds returned');
      return 0;
    }

    storeSeeds(genre.id, collected);
    /**
     * Kept, but not called finished.
     *
     * A harvest missing some of its pages was recorded as a success and left
     * alone for a month. What arrived is stored, since it is good, and the error
     * makes `harvestDue` try again in six hours for the rest.
     */
    const partial = failed > 0 || errors.length > 0;
    recordHarvest(
      genre.id,
      collected.length,
      partial ? `partial: ${failed} request(s) failed ${errors.join('; ')}`.trim() : null
    );
    invalidateOracles();
    return collected.length;
  }

  /**
   * Called at boot so that the first host of the day finds the seeds already
   * there rather than waiting behind a harvest for their first round. Costs
   * nothing on a boot where nothing is due, which is every boot but the monthly
   * one: the mini PC restarts often and this must not hammer anybody for it.
   */
  function warm(genres: readonly SeededGenre[]): void {
    for (const genre of genres) {
      if (genre.seeds && genre.seeds.length > 0 && harvestDue(genre.id)) {
        void harvest(genre).catch(() => 0);
      }
    }
    // Queued behind the genres', whose seeds say where each artist goes.
    if (genres.some(searchesHits) && harvestDue(CHARTS_HARVEST)) void harvestCharts(genres).catch(() => 0);
  }

  /**
   * Due means never harvested, a month old, a failure six hours old, or running
   * low with the last harvest a day behind. A genre that has searched every seed
   * it has gets the month-old ones back.
   */
  async function ensure(genre: SeededGenre): Promise<void> {
    if (!genre.seeds || genre.seeds.length === 0) return;

    if (harvestDue(genre.id)) {
      const running = harvest(genre).catch(() => 0);
      /**
       * Waited for only when there is nothing to search without it.
       *
       * A refresh of a genre that already has seeds runs in the background: the
       * fill has plenty to search meanwhile, and waiting cost it the harvest's
       * minute or two (and, queued behind other harvests, several), long enough
       * for its own abandonment clock to run out.
       */
      if (seedTotal(genre.id) === 0) await running;
    }

    /**
     * Recycled when nothing more can be planned, not when nothing is unsearched.
     *
     * The two used to be the same test, and they are not: a seed the planner
     * cannot use is unsearched for ever, so one of them kept a genre from ever
     * recycling and it fell back to the fixed queries this whole module replaces.
     */
    if (plan(genre, 1).length === 0) {
      const cutoff = stamp(clock.now() - RECYCLE_AFTER_MS);
      db.update(blindtestSeeds)
        .set({ searched_at: null, tries: 0, tried_at: null, videos: null, videos_from: null })
        .where(and(eq(blindtestSeeds.genre_id, genre.id), lt(blindtestSeeds.searched_at, cutoff)))
        .run();
    }
  }

  /* ------------------------------------------------------------ planning */

  function plan(genre: SeededGenre, searches: number, window?: { min: number; max: number }): SeedSearch[] {
    if (!genre.seeds || genre.seeds.length === 0) return [];
    const rested = stamp(clock.now() - HIT_REST_MS);
    const rows = db
      .select({
        id: blindtestSeeds.id,
        artist: blindtestSeeds.artist,
        title: blindtestSeeds.title,
        search: blindtestSeeds.search,
        aliases: blindtestSeeds.aliases,
        year: blindtestSeeds.year,
        fame: blindtestSeeds.fame,
        videos: blindtestSeeds.videos,
        videos_from: blindtestSeeds.videos_from,
        source: blindtestSeeds.source
      })
      .from(blindtestSeeds)
      .where(
        and(
          eq(blindtestSeeds.genre_id, genre.id),
          isNull(blindtestSeeds.searched_at),
          or(isNull(blindtestSeeds.tried_at), lt(blindtestSeeds.tried_at, rested)),
          // A hit whose video nobody has looked for yet waits: it may cost no search at all.
          searchesHits(genre) ? or(lt(blindtestSeeds.fame, HIT_FAME), isNotNull(blindtestSeeds.videos)) : undefined
        )
      )
      .all();
    return planFromSeeds(genre, rows.map(toSeed), searches, window);
  }

  function markSearched(search: SeedSearch, found: number): void {
    const at = stamp();
    const ids = search.seeds.map((seed) => seed.id);
    db.transaction((tx) => {
      for (const id of ids) {
        tx.update(blindtestSeeds).set({ searched_at: at, found }).where(eq(blindtestSeeds.id, id)).run();
      }
    });
  }

  function markTried(search: SeedSearch): void {
    const at = stamp();
    db.transaction((tx) => {
      for (const seed of search.seeds) {
        tx.update(blindtestSeeds).set({ tried_at: at }).where(eq(blindtestSeeds.id, seed.id)).run();
      }
    });
  }

  /**
   * And a lookup that filed nothing hands its videos back: they were dead,
   * blocked here, or not the song, so the next try is a search.
   */
  function countTry(search: SeedSearch): void {
    db.transaction((tx) => {
      for (const seed of search.seeds) {
        tx.update(blindtestSeeds)
          .set({
            tries: sql`${blindtestSeeds.tries} + 1`,
            ...(search.videoIds ? { videos: '[]', videos_from: null } : {})
          })
          .where(eq(blindtestSeeds.id, seed.id))
          .run();
      }
    });
  }

  function unmarkSearched(search: SeedSearch): void {
    db.transaction((tx) => {
      for (const seed of search.seeds) {
        tx.update(blindtestSeeds)
          .set({ searched_at: null, found: 0, tried_at: null })
          .where(eq(blindtestSeeds.id, seed.id))
          .run();
      }
    });
  }

  /** A genre's hits, spent or not. */
  function hitsOf(genre: SeededGenre) {
    return db
      .select({
        id: blindtestSeeds.id,
        artist: blindtestSeeds.artist,
        title: blindtestSeeds.title,
        searched_at: blindtestSeeds.searched_at,
        tries: blindtestSeeds.tries,
        tried_at: blindtestSeeds.tried_at,
        videos: blindtestSeeds.videos,
        videos_from: blindtestSeeds.videos_from
      })
      .from(blindtestSeeds)
      .where(and(eq(blindtestSeeds.genre_id, genre.id), gte(blindtestSeeds.fame, HIT_FAME)))
      .all();
  }

  const filed = (seed: { artist: string; title: string }, covered: ReadonlySet<string>) =>
    songKeys(seed.artist, seed.title).some((key) => covered.has(key));

  /**
   * By song, not by seed.
   *
   * One song is several seeds, a track on several editors' lists, and the
   * monthly harvest can bring it another: a seed that arrives after its song
   * was tried twice and given up on starts with no tries of its own, and would
   * have it searched all over again. So what one seed of a song knows, its
   * unspent seeds are brought up to: its tries, its rest, whether it is done,
   * and its videos, so that a new id does not send anybody to read the
   * artist's channel a second time.
   */
  function settleHits(genre: SeededGenre, covered: ReadonlySet<string>): void {
    if (!searchesHits(genre)) return;
    const songs = new Map<string, ReturnType<typeof hitsOf>>();
    for (const seed of hitsOf(genre)) {
      const key = hitSongKey(seed);
      songs.set(key, [...(songs.get(key) ?? []), seed]);
    }

    const at = stamp();
    const updates: { id: number; set: Partial<typeof blindtestSeeds.$inferInsert> }[] = [];
    for (const seeds of songs.values()) {
      const found = seeds.some((seed) => filed(seed, covered));
      const tries = Math.max(...seeds.map((seed) => seed.tries));
      const triedAt = seeds.reduce<string | null>(
        (last, seed) => (seed.tried_at && (!last || seed.tried_at > last) ? seed.tried_at : last),
        null
      );
      const known = seeds.find((seed) => seed.videos && seed.videos !== '[]') ?? seeds.find((seed) => seed.videos);
      for (const seed of seeds) {
        if (seed.searched_at !== null) continue;
        if (found || tries >= HIT_TRIES) updates.push({ id: seed.id, set: { searched_at: at, found: found ? 1 : 0 } });
        else if (seed.tries !== tries || seed.tried_at !== triedAt || (seed.videos === null && known)) {
          const videos = seed.videos === null && known ? known : seed;
          updates.push({
            id: seed.id,
            set: { tries, tried_at: triedAt, videos: videos.videos, videos_from: videos.videos_from }
          });
        }
      }
    }
    if (updates.length === 0) return;
    db.transaction((tx) => {
      for (const { id, set } of updates) tx.update(blindtestSeeds).set(set).where(eq(blindtestSeeds.id, id)).run();
    });
  }

  function reopenHits(genre: SeededGenre, covered: ReadonlySet<string>): number {
    if (!searchesHits(genre)) return 0;
    const lost = hitsOf(genre).filter((seed) => seed.searched_at !== null && !filed(seed, covered));
    db.transaction((tx) => {
      for (const seed of lost) {
        tx.update(blindtestSeeds)
          .set({ searched_at: null, found: 0, tries: 0, tried_at: null })
          .where(eq(blindtestSeeds.id, seed.id))
          .run();
      }
    });
    return lost.length;
  }

  /* ---------------------------------------------------------- hit videos */

  function pendingVideos(genre: SeededGenre): { id: number; artist: string; title: string }[] {
    if (!searchesHits(genre)) return [];
    return hitsOf(genre).filter((seed) => seed.searched_at === null && seed.videos === null);
  }

  function recordVideos(found: { id: number; videos: string[]; from: VideosFrom | null }[]): void {
    if (found.length === 0) return;
    db.transaction((tx) => {
      for (const { id, videos, from } of found) {
        tx.update(blindtestSeeds)
          .set({ videos: JSON.stringify(videos), videos_from: videos.length > 0 ? from : null })
          .where(eq(blindtestSeeds.id, id))
          .run();
      }
    });
  }

  /**
   * Fetched whole rather than asked song by song: two queries of a few seconds,
   * where thousands of small ones would be thousands of requests to a free service.
   *
   * From QLever only. Wikidata's own endpoint was the fallback and never once
   * answered these: both queries ran into its sixty-second limit and came back
   * cut off, two minutes spent for nothing. QLever asked to slow down (a 429)
   * is asked again, five times, each after a longer wait.
   *
   * Kept a day, in the database as well as here: the box restarts with every
   * deploy, and three deploys in an afternoon fetched the list three times, which
   * with the fame lookups is what got the server throttled. A failure is kept an
   * hour, so QLever is not asked again and again while it is saying no.
   */
  let videoIndexCache: { at: number; index: VideoIndex | null } | null = null;
  let indexing: Promise<VideoIndex | null> | null = null;
  const indexStatus: VideoIndexStatus = { loadedAt: null, songs: 0, channels: 0, failedAt: null, error: null };

  async function fetchVideoIndex(): Promise<VideoIndex | null> {
    for (let attempt = 0; attempt < VIDEO_INDEX_ATTEMPTS.length; attempt++) {
      await wait(VIDEO_INDEX_ATTEMPTS[attempt] ?? 0);
      const index = videoIndex(
        await sources.sparql('qlever', SONG_VIDEOS_QUERY),
        await sources.sparql('qlever', ARTIST_CHANNELS_QUERY)
      );
      if (index) return index;
    }
    return null;
  }

  /** The list a previous process kept, if it is less than a day old. */
  function storedVideoIndex(): { at: number; index: VideoIndex } | null {
    const row = db
      .select({ value: metaData.value })
      .from(metaData)
      .where(and(eq(metaData.content_id, 0), eq(metaData.key, VIDEO_INDEX_KEY)))
      .get();
    if (!row?.value) return null;
    try {
      const stored = JSON.parse(row.value) as {
        at: number;
        songs: [string, string[]][];
        channels: [string, string[]][];
      };
      if (clock.now() - stored.at >= DAY_MS) return null;
      return { at: stored.at, index: { songs: new Map(stored.songs), channels: new Map(stored.channels) } };
    } catch {
      return null;
    }
  }

  function storeVideoIndex(at: number, index: VideoIndex): void {
    const value = JSON.stringify({ at, songs: [...index.songs], channels: [...index.channels] });
    const stamped = stamp(at);
    db.insert(metaData)
      .values({ content_id: 0, key: VIDEO_INDEX_KEY, value, type: 'cache', createdAt: stamped, updatedAt: stamped })
      .onConflictDoUpdate({ target: [metaData.content_id, metaData.key], set: { value, updatedAt: stamped } })
      .run();
  }

  function noteLoaded(at: number, index: VideoIndex): void {
    Object.assign(indexStatus, {
      loadedAt: stamp(at),
      songs: index.songs.size,
      channels: index.channels.size,
      failedAt: null,
      error: null
    });
  }

  /** `force` asks again now even after a failure, though never over a list less than a day old. */
  function videoIndexNow(waitForIt = true, force = false): Promise<VideoIndex | null> {
    if (!videoIndexCache) {
      const stored = storedVideoIndex();
      if (stored) {
        videoIndexCache = stored;
        noteLoaded(stored.at, stored.index);
      }
    }
    const keep = videoIndexCache?.index ? DAY_MS : force ? 0 : VIDEO_INDEX_RETRY_MS;
    if (videoIndexCache && clock.now() - videoIndexCache.at < keep) return Promise.resolve(videoIndexCache.index);
    indexing ??= fetchVideoIndex()
      .catch(() => null)
      .then((index) => {
        const at = clock.now();
        videoIndexCache = { at, index };
        indexing = null;
        if (index) {
          noteLoaded(at, index);
          try {
            storeVideoIndex(at, index);
          } catch {
            // Kept in memory all the same; the next restart fetches it again.
          }
        } else {
          indexStatus.failedAt = stamp(at);
          indexStatus.error = `QLever did not answer in ${VIDEO_INDEX_ATTEMPTS.length} tries; asked again in an hour`;
        }
        return index;
      });
    return waitForIt ? indexing : Promise.resolve(null);
  }

  /* -------------------------------------------------------------- oracle */

  function invalidateOracles(): void {
    oracles.clear();
    seedIndexCache = null;
  }

  function oracle(genreId: string, sameShelf: (otherGenreId: string) => boolean = () => false): GenreOracle {
    const cached = oracles.get(genreId);
    if (cached && clock.now() - cached.at < ORACLE_TTL_MS) return cached.oracle;

    const rows = db
      .select({
        artist: blindtestSeeds.artist,
        title: blindtestSeeds.title,
        aliases: blindtestSeeds.aliases,
        fame: blindtestSeeds.fame,
        year: blindtestSeeds.year,
        duration: blindtestSeeds.duration,
        source: blindtestSeeds.source,
        source_key: blindtestSeeds.source_key
      })
      .from(blindtestSeeds)
      .where(eq(blindtestSeeds.genre_id, genreId))
      .all();
    const built = buildOracle(rows.map((row) => ({ ...row, aliases: parseAliases(row.aliases) })));

    const known = index();
    const elsewhere = (genres: Set<string> | undefined) =>
      [...(genres ?? [])].some((other) => other !== genreId && !sameShelf(other));
    for (const key of built.artists.keys()) {
      if (elsewhere(known.artists.get(key))) built.contested.add(key);
    }
    for (const key of built.works.keys()) {
      if (elsewhere(known.works.get(key))) built.contested.add(key);
    }

    oracles.set(genreId, { at: clock.now(), oracle: built });
    return built;
  }

  function index(): SeedIndex {
    if (seedIndexCache && clock.now() - seedIndexCache.at < ORACLE_TTL_MS) return seedIndexCache.index;

    const built: SeedIndex = { artists: new Map(), works: new Map(), harvested: new Set() };
    const add = (map: Map<string, Set<string>>, key: string, genreId: string) => {
      if (!key) return;
      const genres = map.get(key);
      if (genres) genres.add(genreId);
      else map.set(key, new Set([genreId]));
    };

    const rows = db
      .select({
        genre_id: blindtestSeeds.genre_id,
        artist: blindtestSeeds.artist,
        title: blindtestSeeds.title,
        aliases: blindtestSeeds.aliases
      })
      .from(blindtestSeeds)
      .all();
    for (const row of rows) {
      built.harvested.add(row.genre_id);
      if (row.artist) {
        add(built.artists, normalizeAnswer(row.artist), row.genre_id);
        continue;
      }
      for (const name of [row.title, ...parseAliases(row.aliases)]) {
        add(built.works, normalizeAnswer(name), row.genre_id);
      }
    }

    seedIndexCache = { at: clock.now(), index: built };
    return built;
  }

  /* --------------------------------------------------------- diagnostics */

  function stats(): SeedStats[] {
    const totals = db
      .select({
        genreId: blindtestSeeds.genre_id,
        total: count(),
        fresh: sql<number>`SUM(CASE WHEN ${blindtestSeeds.searched_at} IS NULL THEN 1 ELSE 0 END)`
      })
      .from(blindtestSeeds)
      .groupBy(blindtestSeeds.genre_id)
      .all();
    const harvests = new Map(
      db
        .select()
        .from(blindtestSeedHarvests)
        .all()
        .map((row) => [row.genre_id, row])
    );

    const genreIds = new Set([...totals.map((row) => row.genreId), ...harvests.keys()]);
    return [...genreIds].map((genreId) => {
      const total = totals.find((row) => row.genreId === genreId);
      const last = harvests.get(genreId);
      return {
        genreId,
        total: total?.total ?? 0,
        fresh: Number(total?.fresh ?? 0),
        harvestedAt: last?.harvested_at ?? null,
        error: last?.error ?? null
      };
    });
  }

  return {
    harvest,
    warm,
    harvestCharts,
    chartsReady,
    request,
    artistCandidates: candidatesFor,
    requests,
    cancelRequest,
    requestedGenres,
    knownVideosWaiting,
    ensure,
    plan,
    markSearched,
    markTried,
    countTry,
    unmarkSearched,
    settleHits,
    reopenHits,
    pendingVideos,
    recordVideos,
    videoIndex: videoIndexNow,
    videoIndexStatus: () => ({ ...indexStatus }),
    oracle,
    index,
    stats
  };
}
