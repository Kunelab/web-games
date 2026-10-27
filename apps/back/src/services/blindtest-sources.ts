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
import { batched, remembered } from './request-batching.js';
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
    playlistTracks: (playlistId, at) => deezerGet(`/playlist/${playlistId}/tracks`, page(at)),
    album: (albumId) => deezerGet(`/album/${albumId}`, {})
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
  nextSlot.set(host, slot + gapMs + (slowdown.get(host) ?? 0));
  return pause(slot - now).then(run);
}

/**
 * How much more slowly a host has asked to be called, on top of its own pace.
 *
 * A published limit is per address, and the server and a rescoring on the
 * same machine share one, so pacing to it is not always enough. A 429 doubles
 * the extra gap, up to two seconds; every answer that is not one takes a tenth
 * off, so the pace comes back once the service has.
 */
const slowdown = new Map<string, number>();

function throttledBy(host: string): void {
  slowdown.set(host, Math.min(2_000, Math.max(250, (slowdown.get(host) ?? 0) * 2)));
}

function answeredBy(host: string): void {
  const extra = slowdown.get(host);
  if (extra) slowdown.set(host, extra < 20 ? 0 : extra * 0.9);
}

/**
 * Requests to one host, one at a time, with a pause between the end of one and
 * the start of the next.
 *
 * What Wikimedia asks of its API clients: in series, never in parallel. Spaced
 * starts were not enough there: under an hour of load the answers slowed past
 * the spacing, the requests piled up in parallel, and nine lookups in ten came
 * back throttled, leaving their Wikipedia figures unknown.
 */
const turns = new Map<string, Promise<unknown>>();

function inTurn<T>(host: string, gapMs: number, run: () => Promise<T>): Promise<T> {
  const previous = turns.get(host) ?? Promise.resolve();
  const next = previous.then(() => pause(gapMs + (slowdown.get(host) ?? 0))).then(run);
  turns.set(
    host,
    next.catch(() => undefined)
  );
  return next;
}

/** How often a throttled request is tried in all, and the longest it waits for its turn. */
const THROTTLED_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 30_000;

/**
 * A JSON GET; undefined when the request failed, which the lookups count as "unknown".
 *
 * A 429 or a 503 is the service asking for patience, not saying no, so it is
 * asked again after the wait it names (`Retry-After`, in seconds), a couple of
 * times, before the figure is given up as unknown. Naming the `host` also
 * slows every later request to it; see `slowdown`.
 */
async function getJson(
  url: URL,
  headers: Record<string, string> = {},
  options: { host?: string; attempts?: number } = {}
): Promise<{ status: number; body: unknown } | undefined> {
  const attempts = options.attempts ?? THROTTLED_ATTEMPTS;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await fetch(url, {
      headers: { 'user-agent': FAME_USER_AGENT, accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(15_000)
    }).catch(() => null);
    if (!response) return undefined;
    if (response.status === 429 || response.status === 503) {
      if (options.host) throttledBy(options.host);
      if (attempt === attempts) return undefined;
      const asked = Number(response.headers.get('retry-after'));
      await pause(Math.min(MAX_RETRY_WAIT_MS, Number.isFinite(asked) && asked >= 0 ? asked * 1000 : 2_000 * attempt));
      continue;
    }
    if (options.host) answeredBy(options.host);
    if (response.status >= 500) return undefined;
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  return undefined;
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
async function deezerFame<T>(
  path: string,
  params: Record<string, string>,
  parse: (raw: unknown) => T,
  gapMs = DEEZER_GAP_FAME_MS
) {
  const raw = await paced('deezer', gapMs, () => deezerGet(path, params));
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
async function wikidataGet(params: Record<string, string>, attempts?: number): Promise<unknown> {
  const url = new URL(WIKIDATA_API);
  for (const [key, value] of Object.entries({ format: 'json', ...params })) url.searchParams.set(key, value);
  const answer = await inTurn('wikidata', WIKIDATA_GAP_MS, () => getJson(url, {}, { host: 'wikidata', attempts }));
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

/**
 * A `wbgetentities` answer, by entity id. Missing entities are left out, and
 * so is an id that redirected, as before: it comes back under its target's id.
 */
function parseEntities(body: unknown): Map<string, WikidataEntity> {
  const parsed = wikidataEntitiesSchema.safeParse(body);
  const entities = new Map<string, WikidataEntity>();
  if (!parsed.success) return entities;
  for (const [id, raw] of Object.entries(parsed.data.entities)) {
    if (raw.missing !== undefined) continue;
    const claims: Record<string, string[]> = {};
    for (const [property, statements] of Object.entries(raw.claims ?? {})) {
      claims[property] = statements
        .map((statement) => claimValue(statement.mainsnak.datavalue?.value))
        .filter((value): value is string => value !== null);
    }
    const entity: WikidataEntity = {
      id: raw.id ?? id,
      sitelinks: Object.fromEntries(Object.entries(raw.sitelinks ?? {}).map(([site, link]) => [site, link.title])),
      labels: Object.fromEntries(Object.entries(raw.labels ?? {}).map(([language, label]) => [language, label.value])),
      claims
    };
    entities.set(entity.id, entity);
  }
  return entities;
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

/** Deezer's three fame questions, at a given pace. */
function deezerFameSources(gapMs: number): Pick<FameSources, 'deezerTracks' | 'deezerArtists' | 'deezerArtist'> {
  return {
    // A plain query: the advanced `artist:"..." track:"..."` form has started
    // coming back empty for everything.
    deezerTracks: (artist, title) =>
      deezerFame(
        '/search',
        { q: `${artist} ${title}`, limit: '25' },
        (raw) => {
          const parsed = deezerTrackPage.safeParse(raw);
          return parsed.success ? parsed.data.data : [];
        },
        gapMs
      ),

    deezerArtists: (name) =>
      deezerFame(
        '/search/artist',
        { q: name, limit: '5' },
        (raw) => {
          const parsed = z.object({ data: z.array(deezerArtistSchema).default([]) }).safeParse(raw);
          return parsed.success ? parsed.data.data.map(toArtist) : [];
        },
        gapMs
      ),

    deezerArtist: (id) =>
      deezerFame(
        `/artist/${id}`,
        {},
        (raw) => {
          const parsed = deezerArtistSchema.safeParse(raw);
          return parsed.success ? toArtist(parsed.data) : null;
        },
        gapMs
      )
  };
}

const fameSources: FameSources = {
  ...deezerFameSources(DEEZER_GAP_FAME_MS),

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
    const entities = parseEntities(body);
    // In the order asked, which is the search's order of relevance.
    return ids.map((id) => entities.get(id)).filter((entity) => entity !== undefined);
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
    const host = `${language}.wikipedia`;
    const answer = await inTurn(host, WIKIMEDIA_GAP_MS, () => getJson(url, {}, { host }));
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
    const answer = await paced('lastfm', LASTFM_GAP_MS, () => getJson(url, {}, { host: 'lastfm' }));
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
    const answer = await paced('tmdb', TMDB_GAP_MS, () => getJson(request.url, request.headers, { host: 'tmdb' }));
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
    const answer = await paced('animethemes', ANIMETHEMES_GAP_MS, () => getJson(url, {}, { host: 'animethemes' }));
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

/* ------------------------------------------------------------- in bulk */

/**
 * Deezer's pace for a whole catalogue: the draw's own.
 *
 * Fifty requests per five seconds is Deezer's limit per address, and the
 * server on the same machine keeps drawing rounds while a rescoring runs, so
 * this stays a sixth under it, and a "quota exceeded" slows it further; see
 * `patient`. One search per song is what is left of a rescoring's requests
 * once everything else is asked once and in batches, so this is its pace.
 */
const DEEZER_GAP_BULK_MS = 120;
/** Throttled requests are tried this often in all when nothing is waiting on the answer but a script. */
const BULK_ATTEMPTS = 6;
/** Wikidata and Wikipedia take fifty ids or titles to a request. */
const WIKIMEDIA_BATCH = 50;
/** QLever takes far more, and answers a few hundred ids at once in well under a second. */
const SPARQL_BATCH = 200;
/** How long a batch waits for company, when no request is out to wait on. */
const BATCH_WAIT_MS = 40;
/** QLever answers a burst with 429s: a second between queries, and a batch asked again this often. */
const SPARQL_GAP_MS = 1_000;
const SPARQL_ATTEMPTS = 3;

/**
 * Deezer, asked again after a pause when it fails.
 *
 * A failed answer is how Deezer says "quota exceeded", and the lookup would
 * file the song's figures as unknown for a day. A script can wait out the
 * five-second window instead.
 */
function patient<A extends unknown[], R>(ask: (...args: A) => Promise<R | undefined>) {
  return async (...args: A): Promise<R | undefined> => {
    for (let attempt = 1; ; attempt++) {
      const answer = await ask(...args);
      if (answer !== undefined) {
        answeredBy('deezer');
        return answer;
      }
      // Every request after this one slows down too, not only this one's retry.
      throttledBy('deezer');
      if (attempt === 3) return answer;
      await pause(5_000);
    }
  };
}

const pageviewBatchSchema = z.object({
  query: z
    .object({
      normalized: z.array(z.object({ from: z.string(), to: z.string() })).default([]),
      redirects: z.array(z.object({ from: z.string(), to: z.string() })).default([]),
      pages: z
        .array(
          z.object({
            title: z.string(),
            missing: z.boolean().optional(),
            pageviews: z.record(z.string(), z.number().nullable()).optional()
          })
        )
        .default([])
    })
    .optional(),
  continue: z.record(z.string(), z.string()).optional()
});

/**
 * Sixty days of views for each title asked, from every answer to one request.
 *
 * A title comes back under its normalised and redirected name, so each asked
 * title is followed to the page it landed on. As for one title alone, a page
 * that does not exist is 0 and so is one with no views recorded.
 */
export function readPageviewBatch(bodies: readonly unknown[], titles: readonly string[]): Map<string, number> {
  const renamed = new Map<string, string>();
  const views = new Map<string, number>();
  for (const body of bodies) {
    const query = pageviewBatchSchema.safeParse(body).data?.query;
    if (!query) continue;
    for (const { from, to } of [...query.normalized, ...query.redirects]) renamed.set(from, to);
    for (const page of query.pages) {
      if (page.pageviews) {
        const total = Object.values(page.pageviews).reduce<number>((sum, count) => sum + (count ?? 0), 0);
        views.set(page.title, total);
      } else if (!views.has(page.title)) {
        views.set(page.title, 0);
      }
    }
  }
  const landing = (title: string) => {
    let current = title;
    for (let hop = 0; hop < 4 && renamed.has(current); hop++) current = renamed.get(current)!;
    return current;
  };
  return new Map(titles.map((title) => [title, views.get(landing(title)) ?? 0]));
}

/** Up to fifty titles' views in one request, following the answer's continuations. */
async function pageviewBatch(language: 'fr' | 'en', titles: string[]): Promise<Map<string, number> | undefined> {
  const host = `${language}.wikipedia`;
  const bodies: unknown[] = [];
  let next: Record<string, string> = {};
  for (let round = 0; round < 10; round++) {
    const url = new URL(`https://${language}.wikipedia.org/w/api.php`);
    for (const [key, value] of Object.entries({
      action: 'query',
      format: 'json',
      formatversion: '2',
      prop: 'pageviews',
      titles: titles.join('|'),
      redirects: '1',
      ...next
    })) {
      url.searchParams.set(key, value);
    }
    const answer = await inTurn(host, WIKIMEDIA_GAP_MS, () => getJson(url, {}, { host, attempts: BULK_ATTEMPTS }));
    if (!answer || answer.status !== 200) return undefined;
    bodies.push(answer.body);
    const more = pageviewBatchSchema.safeParse(answer.body).data?.continue;
    if (!more) break;
    next = more;
  }
  return readPageviewBatch(bodies, titles);
}

/** Who carries each value, from a SPARQL answer of `?v ?item` rows: the oldest item first. */
export function readClaimHolders(body: unknown): Map<string, string[]> {
  const parsed = z
    .object({
      results: z.object({
        bindings: z.array(z.object({ v: z.object({ value: z.string() }), item: z.object({ value: z.string() }) }))
      })
    })
    .safeParse(body);
  const holders = new Map<string, string[]>();
  for (const row of parsed.data?.results.bindings ?? []) {
    const id = row.item.value.split('/').pop() ?? '';
    if (!/^Q\d+$/.test(id)) continue;
    holders.set(row.v.value, [...(holders.get(row.v.value) ?? []), id]);
  }
  for (const items of holders.values()) items.sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
  return holders;
}

/**
 * The items carrying each of these values for a property, a few hundred to a query.
 *
 * Through QLever rather than Wikidata's search, which takes them one at a time
 * in Wikimedia's queue: an artist's item by their Deezer id was a third of a
 * rescoring's Wikidata requests. When QLever does not answer, the search does,
 * one value at a time as before.
 */
async function claimHolderBatch(property: string, values: string[]): Promise<Map<string, string[] | undefined>> {
  const list = values.map((value) => JSON.stringify(value)).join(' ');
  const query = `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
SELECT ?v ?item WHERE { VALUES ?v { ${list} } ?item wdt:${property} ?v }`;
  for (let attempt = 1; attempt <= SPARQL_ATTEMPTS; attempt++) {
    const body = await paced('qlever', SPARQL_GAP_MS, () => sparql('qlever', query));
    if (body) {
      const holders = readClaimHolders(body);
      return new Map(values.map((value) => [value, holders.get(value) ?? []]));
    }
    if (attempt < SPARQL_ATTEMPTS) await pause(2_000 * attempt);
  }
  const answers = await Promise.all(values.map((value) => fameSources.wikidataByClaim(property, value)));
  return new Map(values.map((value, index) => [value, answers[index]]));
}

/**
 * The fame sources for a whole catalogue at once: the same questions, asked
 * once each, and many to a request wherever the service takes them.
 *
 * For the rescoring script, which looks up thousands of songs by a few
 * thousand artists, and spent most of its time asking Wikimedia, one request
 * at a time, about the same artists over and over. Every answer means exactly
 * what `fameSources`' does, so a difficulty worked out here is the one the
 * draw would work out. The per-host pace is the same too, and a 429 slows that
 * host further; see `slowdown`.
 *
 * A fresh set per run: what it remembers is an answer from minutes ago, and a
 * long-running server has no business keeping it.
 */
export function bulkFameSources(): FameSources {
  const deezer = deezerFameSources(DEEZER_GAP_BULK_MS);
  const entity = batched<string, WikidataEntity | null>(
    async (ids) => {
      const body = await wikidataGet(
        { action: 'wbgetentities', ids: ids.join('|'), props: 'claims|sitelinks|labels', languages: 'fr|en' },
        BULK_ATTEMPTS
      );
      return body === undefined ? undefined : parseEntities(body);
    },
    { size: WIKIMEDIA_BATCH, waitMs: BATCH_WAIT_MS, absent: null }
  );
  const views = {
    fr: batched<string, number>((titles) => pageviewBatch('fr', titles), {
      size: WIKIMEDIA_BATCH,
      waitMs: BATCH_WAIT_MS,
      absent: 0
    }),
    en: batched<string, number>((titles) => pageviewBatch('en', titles), {
      size: WIKIMEDIA_BATCH,
      waitMs: BATCH_WAIT_MS,
      absent: 0
    })
  };
  const holders = new Map<string, (value: string) => Promise<string[] | undefined>>();
  const holdersOf = (property: string) => {
    let ask = holders.get(property);
    if (!ask) {
      ask = batched<string, string[] | undefined>((values) => claimHolderBatch(property, values), {
        size: SPARQL_BATCH,
        waitMs: BATCH_WAIT_MS,
        absent: []
      });
      holders.set(property, ask);
    }
    return ask;
  };

  return {
    deezerTracks: remembered(patient(deezer.deezerTracks), (artist, title) => `${artist}\n${title}`),
    deezerArtists: remembered(patient(deezer.deezerArtists), (name) => name),
    deezerArtist: remembered(patient(deezer.deezerArtist), (id) => String(id)),
    wikidataByClaim: remembered(
      (property: string, value: string) => holdersOf(property)(value),
      (property, value) => `${property}\n${value}`
    ),
    wikidataSearch: remembered(
      (name: string, language: 'fr' | 'en') => fameSources.wikidataSearch(name, language),
      (name, language) => `${language}\n${name}`
    ),
    async wikidataEntities(ids) {
      const found = await Promise.all(ids.map((id) => entity(id)));
      if (found.some((one) => one === undefined)) return undefined;
      // In the order asked, which is the search's order of relevance.
      return found.filter((one): one is WikidataEntity => one !== null && one !== undefined);
    },
    pageviews: remembered(
      (language, title) => views[language](title),
      (language, title) => `${language}\n${title}`
    ),
    lastfmListeners: remembered(
      (artist: string, title: string) => fameSources.lastfmListeners(artist, title),
      (artist, title) => `${artist}\n${title}`
    ),
    anilist: remembered(
      (work: string) => fameSources.anilist(work),
      (work) => work
    ),
    tmdbVotes: remembered(
      (kind: 'movie' | 'tv', ref: { id: string } | { query: string }) => fameSources.tmdbVotes(kind, ref),
      (kind, ref) => `${kind}\n${JSON.stringify(ref)}`
    ),
    animeThemes: remembered(
      (id: number) => fameSources.animeThemes(id),
      (id) => String(id)
    ),
    configured: () => fameSources.configured()
  };
}

/* ------------------------------------------------------------------ all */

export const httpSources: CatalogueSources = {
  youtube: { search: searchVideos, facts: fetchVideoFacts, playlist: fetchPlaylistItems },
  seeds: seedSources,
  lyrics: fetchChorus,
  aliases: { musicbrainz: musicbrainzAliases, anilist: anilistAliases },
  fame: fameSources,
  annotate: annotateCandidates
};
