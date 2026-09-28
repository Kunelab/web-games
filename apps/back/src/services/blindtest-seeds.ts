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
 */
import { and, count, eq, isNull, lt, sql } from 'drizzle-orm';
import { normalizeAnswer } from 'game-core';
import { z } from 'zod';

import { db } from '../db/index.js';
import { blindtestSeedHarvests, blindtestSeeds } from '../db/schema.js';

const USER_AGENT = 'KuneLabWebGames/0.3 (blind test seeds; https://github.com/Kunelab)';

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
  source: 'deezer' | 'anilist' | 'wikidata';
  sourceKey: string;
  artist: string;
  title: string;
  search: string;
  aliases: string[];
  year: number | null;
  /** The source's own popularity figure, on any scale. Ranked into `fame`. */
  popularity: number;
}

export interface Seed {
  id: number;
  artist: string;
  title: string;
  search: string;
  aliases: string[];
  year: number | null;
  fame: number;
}

/** One YouTube search, and the seeds it is aimed at. */
export interface SeedSearch {
  query: string;
  limit: number;
  seeds: Seed[];
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

/** Re-harvested monthly: new releases, new editorial lists, new seasons. */
const HARVEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A failed harvest is tried again after this. */
const HARVEST_RETRY_MS = 6 * 60 * 60 * 1000;
/** Below this many unsearched seeds a genre harvests again, at most daily. */
const LOW_STOCK = 40;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Searched seeds become eligible again after this, once a genre runs dry. */
const RECYCLE_AFTER_MS = 30 * DAY_MS;

/* ---------------------------------------------------------------- helpers */

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
 * know: squared, so about five draws in six come from the better-known half,
 * where a straight line gave the first harvest's plans "No Limit", "Mallrats"
 * and "Recovery of an MMO Junkie". A room asking for hard rounds gets seeds
 * near the fame its window implies instead: difficulty 0 is fame 1.
 */
export function fameWeight(fame: number, window?: { min: number; max: number }): number {
  if (!window) return 0.05 + 1.5 * fame * fame;
  const target = 1 - (window.min + window.max) / 200;
  const spread = 0.2 + (window.max - window.min) / 400;
  return 0.05 + Math.exp(-((fame - target) ** 2) / (2 * spread ** 2));
}

/** A name as a YouTube phrase. Quotes inside it would end the phrase early. */
function phrase(name: string): string {
  return `"${name.replace(/"/g, '').trim()}"`;
}

/* --------------------------------------------------------------- Deezer */

const DEEZER = 'https://api.deezer.com';

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
        readable: z.boolean().optional(),
        artist: z.object({ name: z.string().default('') }).optional()
      })
    )
    .default([]),
  next: z.string().optional()
});

/** Deezer allows fifty requests per five seconds; this stays well under. */
const DEEZER_GAP_MS = 150;
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

async function deezerGet(path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${DEEZER}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  for (let attempt = 0; attempt < 2; attempt++) {
    await pause(DEEZER_GAP_MS);
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000)
    }).catch(() => null);
    if (!response?.ok) continue;
    const body = (await response.json().catch(() => null)) as { error?: { code?: number } } | null;
    // Code 4 is Deezer's "quota exceeded": wait out the window once.
    if (body?.error?.code === 4) {
      await pause(5_000);
      continue;
    }
    return body;
  }
  return null;
}

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
  const parsed = deezerTracks.safeParse(raw);
  if (!parsed.success) return [];
  const seeds: RawSeed[] = [];
  for (const track of parsed.data.data) {
    if (track.readable === false) continue;
    const artist = track.artist?.name.trim() ?? '';
    const title = (track.title_short || track.title).trim();
    if (!artist || !title) continue;
    if (artist.length > 40 || NOT_AN_ARTIST.test(artist)) continue;
    seeds.push({
      source: 'deezer',
      sourceKey: String(track.id),
      artist,
      title,
      search: '',
      aliases: [],
      year: null,
      popularity: track.rank
    });
  }
  return seeds;
}

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
async function harvestDeezer(source: Extract<SeedSource, { kind: 'deezer' }>): Promise<RawSeed[]> {
  const playlists = new Map<number, string>();
  const editors = new Map<number, string>();
  const take = (found: { id: number; title: string }[]) => {
    for (const playlist of found) {
      if (playlists.size >= DEEZER_PLAYLISTS_PER_GENRE) return;
      playlists.set(playlist.id, playlist.title);
    }
  };

  for (const query of source.playlistQueries) {
    for (let index = 0; index < DEEZER_RESULTS_PER_QUERY; index += 50) {
      const raw = await deezerGet('/search/playlist', { q: query, limit: '50', index: String(index) });
      take(curatedPlaylists(raw, source.titleMatch));
      for (const editor of genreEditors(raw, source.titleMatch)) editors.set(editor.id, editor.name);
      if (pageSize(raw) < 50) break;
    }
  }

  for (const [editor, name] of editors) {
    if (playlists.size >= DEEZER_PLAYLISTS_PER_GENRE) break;
    for (let index = 0; index < DEEZER_PLAYLISTS_PER_EDITOR; index += 100) {
      const raw = await deezerGet(`/user/${editor}/playlists`, { limit: '100', index: String(index) });
      take(editorPlaylists(raw, name, source.titleMatch));
      if (pageSize(raw) < 100) break;
    }
  }

  const seeds = new Map<string, RawSeed>();
  for (const id of playlists.keys()) {
    for (let index = 0; index < DEEZER_TRACKS_PER_PLAYLIST; index += 100) {
      const raw = await deezerGet(`/playlist/${id}/tracks`, { limit: '100', index: String(index) });
      const page = deezerSeeds(raw);
      for (const seed of page) {
        if (!seeds.has(seed.sourceKey)) seeds.set(seed.sourceKey, seed);
      }
      if (page.length < 100) break;
    }
  }
  return [...seeds.values()];
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

/** TV formats only: a film has no opening to guess. */
const ANILIST_QUERY = `query($p:Int){Page(page:$p,perPage:50){pageInfo{hasNextPage} media(type:ANIME,sort:POPULARITY_DESC,format_in:[TV,TV_SHORT,ONA]){id popularity title{romaji english native} synonyms startDate{year}}}}`;

/** Two thousand series. Past that, nobody at a party knows the opening. */
const ANILIST_PAGES = 40;
/** AniList currently allows thirty requests a minute. */
const ANILIST_GAP_MS = 2_200;

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

/**
 * The anime list, shared between the openings and the endings.
 *
 * Both genres want the same two thousand series, and fetching it twice is
 * three minutes of a rate-limited free service for nothing.
 */
let anilistCache: { at: number; seeds: RawSeed[] } | null = null;

async function harvestAnilist(): Promise<RawSeed[]> {
  if (anilistCache && Date.now() - anilistCache.at < 6 * 60 * 60 * 1000) return anilistCache.seeds;

  const seeds: RawSeed[] = [];
  for (let page = 1; page <= ANILIST_PAGES; page++) {
    let raw: unknown = null;
    for (let attempt = 0; attempt < 2 && raw === null; attempt++) {
      await pause(ANILIST_GAP_MS);
      const response = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query: ANILIST_QUERY, variables: { p: page } }),
        signal: AbortSignal.timeout(15_000)
      }).catch(() => null);
      if (response?.status === 429) {
        const wait = Number(response.headers.get('retry-after') ?? '60');
        await pause(Math.min(120, Number.isFinite(wait) ? wait : 60) * 1000);
        continue;
      }
      raw = response?.ok ? await response.json().catch(() => null) : null;
      if (raw === null) break;
    }

    const result = anilistSeeds(raw);
    seeds.push(...result.seeds);
    if (!result.more) break;
  }

  if (seeds.length > 0) anilistCache = { at: Date.now(), seeds };
  return seeds;
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

async function sparql(endpoint: string, query: string, timeoutMs: number): Promise<unknown> {
  const url = new URL(endpoint);
  url.searchParams.set('query', query);
  const response = await fetch(url, {
    headers: { accept: 'application/sparql-results+json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs)
  }).catch(() => null);
  if (!response?.ok) return null;
  return response.json().catch(() => null);
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
    if (!title || !artist) continue;
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

async function harvestCompositions(source: Extract<SeedSource, { kind: 'wikidata-compositions' }>): Promise<RawSeed[]> {
  return compositionSeeds(await sparql('https://qlever.dev/api/wikidata', compositionsQuery(source), 60_000));
}

async function harvestWikidata(source: Extract<SeedSource, { kind: 'wikidata' }>): Promise<RawSeed[]> {
  const fast = wikidataSeeds(await sparql('https://qlever.dev/api/wikidata', qleverQuery(source), 60_000));
  if (fast.length > 0) return fast;
  return wikidataSeeds(await sparql('https://query.wikidata.org/sparql', wdqsQuery(source), 70_000));
}

/* --------------------------------------------------------------- storage */

function parseAliases(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

/** Stores a harvest. Known seeds keep their search history; their fame moves. */
function storeSeeds(genreId: string, seeds: RawSeed[]): void {
  const ranked = rankFame(seeds);
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
          fame: seed.fame
        })
        .onConflictDoUpdate({
          target: [blindtestSeeds.genre_id, blindtestSeeds.source, blindtestSeeds.source_key],
          set: { fame: seed.fame, aliases: JSON.stringify(seed.aliases), year: seed.year }
        })
        .run();
    }
  });
}

function recordHarvest(genreId: string, seeds: number, error: string | null): void {
  const harvestedAt = new Date().toISOString();
  db.insert(blindtestSeedHarvests)
    .values({ genre_id: genreId, harvested_at: harvestedAt, seeds, error })
    .onConflictDoUpdate({ target: blindtestSeedHarvests.genre_id, set: { harvested_at: harvestedAt, seeds, error } })
    .run();
}

function freshCount(genreId: string): number {
  const row = db
    .select({ value: count() })
    .from(blindtestSeeds)
    .where(and(eq(blindtestSeeds.genre_id, genreId), isNull(blindtestSeeds.searched_at)))
    .get();
  return row?.value ?? 0;
}

/* --------------------------------------------------------------- harvest */

const harvesting = new Map<string, Promise<number>>();

/**
 * Fetches a genre's seeds from its sources and stores them.
 *
 * Returns how many the sources offered. One run per genre at a time; a second
 * caller waits for the first. Sources fail independently, and only a harvest
 * where every source failed is recorded as an error.
 */
export function harvestSeeds(genre: SeededGenre): Promise<number> {
  const running = harvesting.get(genre.id);
  if (running) return running;

  const run = (async () => {
    const collected: RawSeed[] = [];
    const errors: string[] = [];
    for (const source of genre.seeds ?? []) {
      try {
        if (source.kind === 'deezer') collected.push(...(await harvestDeezer(source)));
        else if (source.kind === 'anilist') collected.push(...(await harvestAnilist()));
        else if (source.kind === 'wikidata-compositions') collected.push(...(await harvestCompositions(source)));
        else collected.push(...(await harvestWikidata(source)));
      } catch (error) {
        errors.push(`${source.kind}: ${String(error).slice(0, 120)}`);
      }
    }

    if (collected.length === 0) {
      recordHarvest(genre.id, 0, errors.join('; ') || 'no seeds returned');
      return 0;
    }

    storeSeeds(genre.id, collected);
    recordHarvest(genre.id, collected.length, null);
    invalidateOracles();
    return collected.length;
  })().finally(() => harvesting.delete(genre.id));

  harvesting.set(genre.id, run);
  return run;
}

/**
 * Makes sure a genre has seeds to search, harvesting when it is due.
 *
 * Due means never harvested, a month old, a failure six hours old, or running
 * low with the last harvest a day behind. A genre that has searched every seed
 * it has gets the month-old ones back.
 */
export async function ensureSeeds(genre: SeededGenre): Promise<void> {
  if (!genre.seeds || genre.seeds.length === 0) return;

  const state = db.select().from(blindtestSeedHarvests).where(eq(blindtestSeedHarvests.genre_id, genre.id)).get();
  const age = state ? Date.now() - Date.parse(state.harvested_at) : Number.POSITIVE_INFINITY;
  const stock = freshCount(genre.id);

  const due =
    !state ||
    age > HARVEST_TTL_MS ||
    (state.error !== null && age > HARVEST_RETRY_MS) ||
    (stock < LOW_STOCK && age > DAY_MS);

  if (due) await harvestSeeds(genre).catch(() => 0);

  if (freshCount(genre.id) === 0) {
    const cutoff = new Date(Date.now() - RECYCLE_AFTER_MS).toISOString();
    db.update(blindtestSeeds)
      .set({ searched_at: null })
      .where(and(eq(blindtestSeeds.genre_id, genre.id), lt(blindtestSeeds.searched_at, cutoff)))
      .run();
  }
}

/* --------------------------------------------------------------- planning */

function toSeed(row: {
  id: number;
  artist: string;
  title: string;
  search: string;
  aliases: string;
  year: number | null;
  fame: number;
}): Seed {
  return {
    id: row.id,
    artist: row.artist,
    title: row.title,
    search: row.search,
    aliases: parseAliases(row.aliases),
    year: row.year,
    fame: row.fame
  };
}

/**
 * Groups unsearched seeds into YouTube searches. Pure, for the tests.
 *
 * Music is searched by artist, a few artists per search, and every seed of a
 * chosen artist rides along so the whole artist is marked once searched. A
 * work is searched by its name and the genre's suffix.
 */
export function planFromSeeds(
  genre: SeededGenre,
  seeds: Seed[],
  searches: number,
  window?: { min: number; max: number },
  random = Math.random
): SeedSearch[] {
  if (searches <= 0 || seeds.length === 0) return [];

  if (genre.answerShape === 'artist-title') {
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
        hint: chunk.map((group) => group.artist).join(', ')
      });
    }
    return plan;
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
      hint: chunk.map((seed) => seed.title).join(', ')
    });
  }
  return plan;
}

/** The next searches for a genre, from seeds nobody has searched yet. */
export function planSeedSearches(
  genre: SeededGenre,
  searches: number,
  window?: { min: number; max: number }
): SeedSearch[] {
  if (!genre.seeds || genre.seeds.length === 0) return [];
  const rows = db
    .select({
      id: blindtestSeeds.id,
      artist: blindtestSeeds.artist,
      title: blindtestSeeds.title,
      search: blindtestSeeds.search,
      aliases: blindtestSeeds.aliases,
      year: blindtestSeeds.year,
      fame: blindtestSeeds.fame
    })
    .from(blindtestSeeds)
    .where(and(eq(blindtestSeeds.genre_id, genre.id), isNull(blindtestSeeds.searched_at)))
    .all();
  return planFromSeeds(genre, rows.map(toSeed), searches, window);
}

/**
 * Marks a search's seeds as spent, with what they produced.
 *
 * Called after the search ran, not when it was planned, so a search the quota
 * refused leaves its seeds for another day.
 */
export function markSearched(search: SeedSearch, found: number): void {
  const at = new Date().toISOString();
  const ids = search.seeds.map((seed) => seed.id);
  db.transaction((tx) => {
    for (const id of ids) {
      tx.update(blindtestSeeds).set({ searched_at: at, found }).where(eq(blindtestSeeds.id, id)).run();
    }
  });
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
  /** `artist::title`, normalised, to that track's fame. */
  tracks: Map<string, number>;
  /** Any normalised name of a work to the work. */
  works: Map<string, { names: string[]; fame: number; year: number | null }>;
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
const oracles = new Map<string, { at: number; oracle: GenreOracle }>();
let seedIndexCache: { at: number; index: SeedIndex } | null = null;

function invalidateOracles(): void {
  oracles.clear();
  seedIndexCache = null;
}

export function buildOracle(
  seeds: { artist: string; title: string; aliases: string[]; fame: number; year: number | null }[]
): GenreOracle {
  const oracle: GenreOracle = { artists: new Map(), tracks: new Map(), works: new Map(), contested: new Set() };
  for (const seed of seeds) {
    if (seed.artist) {
      const artist = normalizeAnswer(seed.artist);
      if (!artist) continue;
      oracle.artists.set(artist, Math.max(oracle.artists.get(artist) ?? 0, seed.fame));
      oracle.tracks.set(trackOracleKey(seed.artist, seed.title), seed.fame);
      continue;
    }
    const work = { names: [seed.title, ...seed.aliases], fame: seed.fame, year: seed.year };
    for (const name of work.names) {
      const key = normalizeAnswer(name);
      if (key && !oracle.works.has(key)) oracle.works.set(key, work);
    }
  }
  return oracle;
}

/**
 * A genre's oracle, from every seed it has, searched or not. Cached briefly.
 *
 * `sameShelf` says which other genres do not count against it: the openings
 * and the endings share every anime, and that is not a disagreement.
 */
export function genreOracle(genreId: string, sameShelf: (otherGenreId: string) => boolean = () => false): GenreOracle {
  const cached = oracles.get(genreId);
  if (cached && Date.now() - cached.at < ORACLE_TTL_MS) return cached.oracle;

  const rows = db
    .select({
      artist: blindtestSeeds.artist,
      title: blindtestSeeds.title,
      aliases: blindtestSeeds.aliases,
      fame: blindtestSeeds.fame,
      year: blindtestSeeds.year
    })
    .from(blindtestSeeds)
    .where(eq(blindtestSeeds.genre_id, genreId))
    .all();
  const oracle = buildOracle(rows.map((row) => ({ ...row, aliases: parseAliases(row.aliases) })));

  const index = seedIndex();
  const elsewhere = (genres: Set<string> | undefined) =>
    [...(genres ?? [])].some((other) => other !== genreId && !sameShelf(other));
  for (const key of oracle.artists.keys()) {
    if (elsewhere(index.artists.get(key))) oracle.contested.add(key);
  }
  for (const key of oracle.works.keys()) {
    if (elsewhere(index.works.get(key))) oracle.contested.add(key);
  }

  oracles.set(genreId, { at: Date.now(), oracle });
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

export function seedIndex(): SeedIndex {
  if (seedIndexCache && Date.now() - seedIndexCache.at < ORACLE_TTL_MS) return seedIndexCache.index;

  const index: SeedIndex = { artists: new Map(), works: new Map(), harvested: new Set() };
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
    index.harvested.add(row.genre_id);
    if (row.artist) {
      add(index.artists, normalizeAnswer(row.artist), row.genre_id);
      continue;
    }
    for (const name of [row.title, ...parseAliases(row.aliases)]) {
      add(index.works, normalizeAnswer(name), row.genre_id);
    }
  }

  seedIndexCache = { at: Date.now(), index };
  return index;
}

/* ------------------------------------------------------------- diagnostics */

export function seedStats(): {
  genreId: string;
  total: number;
  fresh: number;
  harvestedAt: string | null;
  error: string | null;
}[] {
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
    const harvest = harvests.get(genreId);
    return {
      genreId,
      total: total?.total ?? 0,
      fresh: Number(total?.fresh ?? 0),
      harvestedAt: harvest?.harvested_at ?? null,
      error: harvest?.error ?? null
    };
  });
}
