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

import { anilistAliases, musicbrainzAliases } from './blindtest-aliases.js';
import type { CatalogueSources } from './blindtest-catalog.js';
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

/* ------------------------------------------------------------------ all */

export const httpSources: CatalogueSources = {
  youtube: { search: searchVideos, facts: fetchVideoFacts, playlist: fetchPlaylistItems },
  seeds: seedSources,
  lyrics: fetchChorus,
  aliases: { musicbrainz: musicbrainzAliases, anilist: anilistAliases },
  annotate: annotateCandidates
};
