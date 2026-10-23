/**
 * The blind test catalogue's outside world, over HTTP.
 *
 * The production `CatalogueSources`: every request the catalogue makes, made
 * for real. What lives here is how to talk to each service, which is to say
 * its URL, its headers, its timeouts and the pace it asks to be called at.
 * What to ask for and what to make of the answer stays with the catalogue and
 * the seeds, which see only the port, so a test can hand them a fake world
 * instead and nothing in it reaches the network.
 *
 * Three of the sources are whole client modules already and are wired rather
 * than absorbed: `youtube-service`, which the editor's routes use as well,
 * `blindtest-aliases` and `blindtest-llm`, whose only job is their one call.
 * The rest was fetch code inside modules that otherwise hold no I/O, and moved
 * here unchanged.
 */
import { z } from 'zod';

import { env } from '../env.js';
import { anilistAliases, musicbrainzAliases } from './blindtest-aliases.js';
import type { CatalogueSources } from './blindtest-catalog.js';
import type { AnilistHit, AnimeTheme, DeezerArtistHit, FameSources, WikidataEntity } from './blindtest-fame.js';
import { annotateCandidates } from './blindtest-llm.js';
import type { DeezerPage, SeedSources } from './blindtest-seeds.js';
import { chorusFromLyrics, type ChorusInfo } from './chorus-service.js';
import { fetchPlaylistItems, fetchVideoFacts, searchVideos } from './youtube-service.js';

/** Who is asking, for the services that want callers to say so, and for what. */
const userAgent = (purpose: string) => `KuneLabWebGames/0.3 (${purpose}; https://github.com/Kunelab)`;

const SEEDS_USER_AGENT = userAgent('blind test seeds');

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ---------------------------------------------------------------- Deezer */

const DEEZER = 'https://api.deezer.com';

/** Deezer allows fifty requests per five seconds; this stays well under. */
const DEEZER_GAP_MS = 150;

async function deezerGet(path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${DEEZER}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  for (let attempt = 0; attempt < 2; attempt++) {
    await pause(DEEZER_GAP_MS);
    const response = await fetch(url, {
      headers: { 'user-agent': SEEDS_USER_AGENT, accept: 'application/json' },
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

const page = ({ index, limit }: DeezerPage) => ({ limit: String(limit), index: String(index) });

/* --------------------------------------------------------------- AniList */

/** TV formats only: a film has no opening to guess. */
const ANILIST_QUERY = `query($p:Int){Page(page:$p,perPage:50){pageInfo{hasNextPage} media(type:ANIME,sort:POPULARITY_DESC,format_in:[TV,TV_SHORT,ONA]){id popularity title{romaji english native} synonyms startDate{year}}}}`;

/** AniList currently allows thirty requests a minute. */
const ANILIST_GAP_MS = 2_200;

async function anilistPage(pageNumber: number): Promise<unknown> {
  let raw: unknown = null;
  for (let attempt = 0; attempt < 2 && raw === null; attempt++) {
    await pause(ANILIST_GAP_MS);
    const response = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query: ANILIST_QUERY, variables: { p: pageNumber } }),
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
  return raw;
}

/* -------------------------------------------------------------- Wikidata */

/** QLever is a fast public mirror; the official endpoint times out on these queries and is the fallback. */
const SPARQL_ENDPOINTS = {
  qlever: { url: 'https://qlever.dev/api/wikidata', timeoutMs: 60_000 },
  wikidata: { url: 'https://query.wikidata.org/sparql', timeoutMs: 70_000 }
} as const;

async function sparql(endpoint: keyof typeof SPARQL_ENDPOINTS, query: string): Promise<unknown> {
  const { url: base, timeoutMs } = SPARQL_ENDPOINTS[endpoint];
  const url = new URL(base);
  url.searchParams.set('query', query);
  const response = await fetch(url, {
    headers: { accept: 'application/sparql-results+json', 'user-agent': SEEDS_USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs)
  }).catch(() => null);
  if (!response?.ok) return null;
  return response.json().catch(() => null);
}

const seedSources: SeedSources = {
  deezer: {
    searchPlaylists: (query, at) => deezerGet('/search/playlist', { q: query, ...page(at) }),
    userPlaylists: (userId, at) => deezerGet(`/user/${userId}/playlists`, page(at)),
    playlistTracks: (playlistId, at) => deezerGet(`/playlist/${playlistId}/tracks`, page(at))
  },
  anilist: anilistPage,
  sparql
};

/* ---------------------------------------------------------------- LRCLIB */

/** LRCLIB asks callers to identify themselves. */
const LYRICS_USER_AGENT = userAgent('blind test clip finder');

const LRCLIB_URL = 'https://lrclib.net/api/get';

const lrclibSchema = z.object({
  duration: z.number().nullable().optional(),
  instrumental: z.boolean().optional(),
  syncedLyrics: z.string().nullable().optional()
});

async function fetchChorus(artist: string, title: string): Promise<ChorusInfo | null> {
  const url = new URL(LRCLIB_URL);
  url.searchParams.set('artist_name', artist);
  url.searchParams.set('track_name', title);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'user-agent': LYRICS_USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(8_000)
    });
  } catch {
    // A lyrics source being down must never stop a pool from filling: every caller
    // has a fallback, and a slightly worse window beats no round at all.
    return null;
  }

  if (!response.ok) return null;

  const parsed = lrclibSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return null;

  return chorusFromLyrics(parsed.data);
}

/* ------------------------------------------------------------------ fame */

const FAME_USER_AGENT = userAgent('blind test difficulty');

/**
 * Starts of requests to one host, spaced at least this far apart.
 *
 * The rescoring script looks up a whole catalogue several rows at a time, and
 * each service has its own published pace: Deezer fifty requests per five
 * seconds, Last.fm five a second, AniList thirty a minute, AnimeThemes ninety.
 * Spacing the starts rather than queueing whole requests keeps each one under
 * its limit without making a slow answer hold up the next.
 */
const nextSlot = new Map<string, number>();

function paced<T>(host: string, gapMs: number, run: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, slot + gapMs);
  return pause(slot - now).then(run);
}

/** A JSON GET; undefined when the request failed, which the lookups count as "unknown". */
async function getJson(
  url: URL,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown } | undefined> {
  const response = await fetch(url, {
    headers: { 'user-agent': FAME_USER_AGENT, accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(15_000)
  }).catch(() => null);
  if (!response) return undefined;
  if (response.status >= 500 || response.status === 429) return undefined;
  return { status: response.status, body: await response.json().catch(() => null) };
}

const deezerTrackPage = z.object({
  data: z
    .array(
      z.object({
        id: z.number(),
        title: z.string(),
        rank: z.number().default(0),
        artist: z.object({ id: z.number(), name: z.string() })
      })
    )
    .default([])
});

const deezerArtistSchema = z.object({ id: z.number(), name: z.string(), nb_fan: z.number().nullable().optional() });

const DEEZER_GAP_FAME_MS = 120;

/** Deezer's "no data": the one error that is an answer. */
const DEEZER_NO_DATA = 800;

/**
 * Deezer, for the French side of a song's fame.
 *
 * Deezer reports its errors as an HTTP 200 with an `error` body. "No data" is
 * a real answer (no such artist); any other (busy, quota, a bad query) is a
 * failed request, and read as an empty search it would have said "Deezer has
 * never heard of them", which is what makes a round 95.
 */
async function deezerFame<T>(path: string, params: Record<string, string>, parse: (raw: unknown) => T) {
  const raw = await paced('deezer', DEEZER_GAP_FAME_MS, () => deezerGet(path, params));
  if (raw === null) return undefined;
  const code = (raw as { error?: { code?: unknown } }).error?.code;
  if (code !== undefined && code !== DEEZER_NO_DATA) return undefined;
  return parse(raw);
}

const toArtist = (artist: z.infer<typeof deezerArtistSchema>): DeezerArtistHit => ({
  id: artist.id,
  name: artist.name,
  fans: artist.nb_fan ?? null
});

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const WIKIDATA_GAP_MS = 120;
const WIKIMEDIA_GAP_MS = 100;

/** The parsed body, or undefined when the request failed. */
async function wikidataGet(params: Record<string, string>): Promise<unknown> {
  const url = new URL(WIKIDATA_API);
  for (const [key, value] of Object.entries({ format: 'json', ...params })) url.searchParams.set(key, value);
  const answer = await paced('wikidata', WIKIDATA_GAP_MS, () => getJson(url));
  return answer && answer.status === 200 ? answer.body : undefined;
}

const wikidataEntitiesSchema = z.object({
  entities: z.record(
    z.string(),
    z.object({
      id: z.string().optional(),
      missing: z.string().optional(),
      sitelinks: z.record(z.string(), z.object({ title: z.string() })).optional(),
      labels: z.record(z.string(), z.object({ value: z.string() })).optional(),
      claims: z
        .record(
          z.string(),
          z.array(
            z.object({
              mainsnak: z.object({ datavalue: z.object({ value: z.unknown() }).optional() })
            })
          )
        )
        .optional()
    })
  )
});

/** A claim's value as a string: an item's id, or the text of an external id. */
function claimValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id;
  }
  return null;
}

const pageviewsSchema = z.object({
  query: z
    .object({
      pages: z
        .array(
          z.object({
            missing: z.boolean().optional(),
            pageviews: z.record(z.string(), z.number().nullable()).optional()
          })
        )
        .default([])
    })
    .optional()
});

const LASTFM_GAP_MS = 250;
const lastfmTrackSchema = z.object({
  track: z.object({ listeners: z.coerce.number() }).optional(),
  error: z.number().optional()
});

const ANILIST_FAME_QUERY = `query($s:String){Page(perPage:6){media(search:$s,type:ANIME,sort:SEARCH_MATCH){id popularity title{romaji english native} synonyms}}}`;
const anilistFameSchema = z.object({
  data: z.object({
    Page: z.object({
      media: z
        .array(
          z.object({
            id: z.number(),
            popularity: z.number().nullable(),
            title: z.object({
              romaji: z.string().nullable().optional(),
              english: z.string().nullable().optional(),
              native: z.string().nullable().optional()
            }),
            synonyms: z.array(z.string()).nullable().optional()
          })
        )
        .default([])
    })
  })
});

const TMDB_API = 'https://api.themoviedb.org/3';
const TMDB_GAP_MS = 120;
const tmdbItemSchema = z.object({ id: z.number(), vote_count: z.number().default(0) });

/** TMDB takes either a v3 key as a parameter or a v4 read token as a bearer. */
function tmdbRequest(
  path: string,
  params: Record<string, string>
): { url: URL; headers: Record<string, string> } | null {
  const key = env.TMDB_API_KEY;
  if (!key) return null;
  const url = new URL(`${TMDB_API}${path}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  if (key.startsWith('eyJ')) return { url, headers: { authorization: `Bearer ${key}` } };
  url.searchParams.set('api_key', key);
  return { url, headers: {} };
}

const ANIMETHEMES_GAP_MS = 800;
const animeThemesSchema = z.object({
  anime: z
    .array(
      z.object({
        animethemes: z
          .array(
            z.object({
              type: z.string(),
              sequence: z.number().nullable().optional(),
              song: z
                .object({
                  title: z.string().nullable().optional(),
                  artists: z.array(z.object({ name: z.string() })).default([])
                })
                .nullable()
                .optional()
            })
          )
          .default([])
      })
    )
    .default([])
});

const fameSources: FameSources = {
  // A plain query: the advanced `artist:"..." track:"..."` form has started
  // coming back empty for everything.
  deezerTracks: (artist, title) =>
    deezerFame('/search', { q: `${artist} ${title}`, limit: '25' }, (raw) => {
      const parsed = deezerTrackPage.safeParse(raw);
      return parsed.success ? parsed.data.data : [];
    }),

  deezerArtists: (name) =>
    deezerFame('/search/artist', { q: name, limit: '5' }, (raw) => {
      const parsed = z.object({ data: z.array(deezerArtistSchema).default([]) }).safeParse(raw);
      return parsed.success ? parsed.data.data.map(toArtist) : [];
    }),

  deezerArtist: (id) =>
    deezerFame(`/artist/${id}`, {}, (raw) => {
      const parsed = deezerArtistSchema.safeParse(raw);
      return parsed.success ? toArtist(parsed.data) : null;
    }),

  async wikidataByClaim(property, value) {
    const body = await wikidataGet({
      action: 'query',
      list: 'search',
      srsearch: `haswbstatement:${property}=${value}`,
      srlimit: '3'
    });
    if (body === undefined) return undefined;
    const parsed = z
      .object({ query: z.object({ search: z.array(z.object({ title: z.string() })).default([]) }).optional() })
      .safeParse(body);
    return parsed.success ? (parsed.data.query?.search ?? []).map((hit) => hit.title) : [];
  },

  async wikidataSearch(name, language) {
    const body = await wikidataGet({
      action: 'wbsearchentities',
      search: name,
      language,
      uselang: language,
      type: 'item',
      limit: '7'
    });
    if (body === undefined) return undefined;
    const parsed = z.object({ search: z.array(z.object({ id: z.string() })).default([]) }).safeParse(body);
    return parsed.success ? parsed.data.search.map((hit) => hit.id) : [];
  },

  async wikidataEntities(ids) {
    if (ids.length === 0) return [];
    const body = await wikidataGet({
      action: 'wbgetentities',
      ids: ids.join('|'),
      props: 'claims|sitelinks|labels',
      languages: 'fr|en'
    });
    if (body === undefined) return undefined;
    const parsed = wikidataEntitiesSchema.safeParse(body);
    if (!parsed.success) return [];

    const entities: WikidataEntity[] = [];
    for (const [id, raw] of Object.entries(parsed.data.entities)) {
      if (raw.missing !== undefined) continue;
      const claims: Record<string, string[]> = {};
      for (const [property, statements] of Object.entries(raw.claims ?? {})) {
        claims[property] = statements
          .map((statement) => claimValue(statement.mainsnak.datavalue?.value))
          .filter((value): value is string => value !== null);
      }
      entities.push({
        id: raw.id ?? id,
        sitelinks: Object.fromEntries(Object.entries(raw.sitelinks ?? {}).map(([site, link]) => [site, link.title])),
        labels: Object.fromEntries(
          Object.entries(raw.labels ?? {}).map(([language, label]) => [language, label.value])
        ),
        claims
      });
    }
    // In the order asked, which is the search's order of relevance.
    return ids.map((id) => entities.find((entity) => entity.id === id)).filter((entity) => entity !== undefined);
  },

  async pageviews(language, title) {
    const url = new URL(`https://${language}.wikipedia.org/w/api.php`);
    for (const [key, value] of Object.entries({
      action: 'query',
      format: 'json',
      formatversion: '2',
      prop: 'pageviews',
      titles: title,
      redirects: '1'
    })) {
      url.searchParams.set(key, value);
    }
    const answer = await paced(`${language}.wikipedia`, WIKIMEDIA_GAP_MS, () => getJson(url));
    if (!answer || answer.status !== 200) return undefined;
    const parsed = pageviewsSchema.safeParse(answer.body);
    const page = parsed.success ? parsed.data.query?.pages[0] : undefined;
    if (!page || page.missing) return 0;
    return Object.values(page.pageviews ?? {}).reduce<number>((sum, count) => sum + (count ?? 0), 0);
  },

  async lastfmListeners(artist, title) {
    const key = env.LASTFM_API_KEY;
    if (!key) return null;
    const url = new URL('https://ws.audioscrobbler.com/2.0/');
    for (const [name, value] of Object.entries({
      method: 'track.getinfo',
      api_key: key,
      artist,
      track: title,
      autocorrect: '1',
      format: 'json'
    })) {
      url.searchParams.set(name, value);
    }
    const answer = await paced('lastfm', LASTFM_GAP_MS, () => getJson(url));
    if (!answer) return undefined;
    const parsed = lastfmTrackSchema.safeParse(answer.body);
    // Error 6 is "track not found"; anything else is a refusal worth no figure.
    return parsed.success && parsed.data.track ? parsed.data.track.listeners : null;
  },

  async anilist(work) {
    const response = await paced('anilist', ANILIST_GAP_MS, () =>
      fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query: ANILIST_FAME_QUERY, variables: { s: work } }),
        signal: AbortSignal.timeout(15_000)
      }).catch(() => null)
    );
    if (!response || response.status === 429 || response.status >= 500) return undefined;
    // AniList answers a search with no match as a 404 carrying an error.
    if (response.status === 404) return [];
    const parsed = anilistFameSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return [];
    return parsed.data.data.Page.media.map((media): AnilistHit => ({
      id: media.id,
      popularity: media.popularity ?? 0,
      titles: [media.title.romaji, media.title.english, media.title.native, ...(media.synonyms ?? [])].filter(
        (title): title is string => Boolean(title)
      )
    }));
  },

  async tmdbVotes(kind, ref) {
    const request =
      'id' in ref
        ? tmdbRequest(`/${kind}/${encodeURIComponent(ref.id)}`, {})
        : tmdbRequest(`/search/${kind}`, { query: ref.query, language: 'fr-FR' });
    if (!request) return null;
    const answer = await paced('tmdb', TMDB_GAP_MS, () => getJson(request.url, request.headers));
    if (!answer) return undefined;
    if (answer.status === 404) return null;
    const item =
      'id' in ref
        ? tmdbItemSchema.safeParse(answer.body)
        : z.object({ results: z.array(tmdbItemSchema).default([]) }).safeParse(answer.body);
    if (!item.success) return null;
    const found = 'results' in item.data ? item.data.results[0] : item.data;
    return found ? { id: String(found.id), votes: found.vote_count } : null;
  },

  async animeThemes(anilistId) {
    const url = new URL('https://api.animethemes.moe/anime');
    url.searchParams.set('filter[has]', 'resources');
    url.searchParams.set('filter[site]', 'AniList');
    url.searchParams.set('filter[external_id]', String(anilistId));
    url.searchParams.set('include', 'animethemes.song.artists');
    const answer = await paced('animethemes', ANIMETHEMES_GAP_MS, () => getJson(url));
    if (!answer) return undefined;
    const parsed = animeThemesSchema.safeParse(answer.body);
    const anime = parsed.success ? parsed.data.anime[0] : undefined;
    if (!anime) return null;
    return anime.animethemes
      .filter((theme) => (theme.type === 'OP' || theme.type === 'ED') && theme.song?.title)
      .map((theme): AnimeTheme => ({
        type: theme.type as 'OP' | 'ED',
        sequence: theme.sequence ?? null,
        song: theme.song?.title ?? '',
        artists: theme.song?.artists.map((artist) => artist.name) ?? []
      }));
  },

  configured: () => ({ lastfm: Boolean(env.LASTFM_API_KEY), tmdb: Boolean(env.TMDB_API_KEY) })
};

/* ------------------------------------------------------------------ all */

export const httpSources: CatalogueSources = {
  youtube: { search: searchVideos, facts: fetchVideoFacts, playlist: fetchPlaylistItems },
  seeds: seedSources,
  lyrics: fetchChorus,
  aliases: { musicbrainz: musicbrainzAliases, anilist: anilistAliases },
  fame: fameSources,
  annotate: annotateCandidates
};
