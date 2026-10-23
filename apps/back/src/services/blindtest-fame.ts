import { eq } from 'drizzle-orm';
import { normalizeAnswer } from 'game-core';

import type { Db } from '../db/open.js';
import { blindtestFame } from '../db/schema.js';

/**
 * How famous an answer is, asked of the catalogues that know.
 *
 * The difficulty of a generated round used to be a blend of YouTube views ranked
 * within one search's results, a language model's guess and a rank within a
 * genre's harvest, and a band nobody has heard of could come out at 30. This is
 * where the real figures come from instead: Deezer for the French audience,
 * Wikipedia for how widely an artist or a work is covered and how much it is
 * read, Last.fm for listeners worldwide, AniList for the anime fandom, TMDB for
 * films and series. `blindtest-difficulty` turns them into a number.
 *
 * ## Found by id, never by a guessed name
 *
 * Every catalogue is reached through an id another one already gave, wherever
 * there is one: Wikidata knows each artist's Deezer and MusicBrainz ids and each
 * anime's AniList id, so "QQ" is never looked up on Wikipedia by its name,
 * where it is a messaging app. A name search is only the last resort, and only
 * accepted for an entity that is plainly the right kind of thing.
 *
 * ## Not there is an answer too
 *
 * A Deezer search that finds no such artist, a Wikidata entity with no French
 * article: those are zeros, and a zero says "obscure". A request that failed is
 * different and leaves the figure unknown, and a lookup with a failure in it is
 * kept for a day rather than for months.
 */

/* --------------------------------------------------------------- the port */

export interface DeezerTrackHit {
  id: number;
  title: string;
  rank: number;
  artist: { id: number; name: string };
}

export interface DeezerArtistHit {
  id: number;
  name: string;
  fans: number | null;
}

export interface WikidataEntity {
  id: string;
  /** Site to article title: `frwiki`, `enwiki`, `enwikiquote`... */
  sitelinks: Record<string, string>;
  /** Property to its values: item ids for an item, the string for an id. */
  claims: Record<string, string[]>;
  /** French and English labels, when the entity has them. */
  labels: Record<string, string>;
}

export interface AnilistHit {
  id: number;
  popularity: number;
  titles: string[];
}

/** One opening or ending of an anime, and its song. */
export interface AnimeTheme {
  type: 'OP' | 'ED';
  /** OP1, OP2...; null for a series with a single one. */
  sequence: number | null;
  song: string;
  artists: string[];
}

/**
 * Every request the lookups make, one function each.
 *
 * Each answers `undefined` when the request failed (the service was down, a
 * timeout) and `null` or an empty list when it answered and has nothing. The
 * production version is in `blindtest-sources`; a test hands in a fake world.
 */
export interface FameSources {
  deezerTracks(artist: string, title: string): Promise<DeezerTrackHit[] | undefined>;
  deezerArtists(name: string): Promise<DeezerArtistHit[] | undefined>;
  deezerArtist(id: number): Promise<DeezerArtistHit | null | undefined>;
  /** Items carrying this value for this property, e.g. `P2722` = a Deezer artist id. */
  wikidataByClaim(property: string, value: string): Promise<string[] | undefined>;
  wikidataSearch(name: string, language: 'fr' | 'en'): Promise<string[] | undefined>;
  wikidataEntities(ids: string[]): Promise<WikidataEntity[] | undefined>;
  /** Views of the article over the last sixty days; 0 for no such article. */
  pageviews(language: 'fr' | 'en', title: string): Promise<number | undefined>;
  /** Null when Last.fm does not know the track, or when no key is configured. */
  lastfmListeners(artist: string, title: string): Promise<number | null | undefined>;
  /** The anime a search finds, best match first, with every title each is known by. */
  anilist(work: string): Promise<AnilistHit[] | undefined>;
  /** Null when TMDB does not know it, or when no key is configured. */
  tmdbVotes(
    kind: 'movie' | 'tv',
    ref: { id: string } | { query: string }
  ): Promise<{ id: string; votes: number } | null | undefined>;
  animeThemes(anilistId: number): Promise<AnimeTheme[] | null | undefined>;
  /** Which of the services that need a key have one. */
  configured(): OptionalSources;
}

/** The services that answer only with a key: Last.fm and TMDB. */
export interface OptionalSources {
  lastfm: boolean;
  tmdb: boolean;
}

/** A world where nothing is known: what a source that is not wired answers. */
export const noFameSources: FameSources = {
  deezerTracks: async () => undefined,
  deezerArtists: async () => undefined,
  deezerArtist: async () => undefined,
  wikidataByClaim: async () => undefined,
  wikidataSearch: async () => undefined,
  wikidataEntities: async () => undefined,
  pageviews: async () => undefined,
  lastfmListeners: async () => undefined,
  anilist: async () => undefined,
  tmdbVotes: async () => undefined,
  animeThemes: async () => undefined,
  configured: () => ({ lastfm: false, tmdb: false })
};

/* -------------------------------------------------------------- the facts */

export type WorkKind = 'anime' | 'film' | 'series' | 'game';

export type FameTarget =
  | {
      shape: 'artist-title';
      artist: string;
      title: string;
      /** The artist's MusicBrainz id, when the alias lookup found the recording. */
      artistMbid?: string | null;
    }
  | {
      shape: 'work';
      kind: WorkKind;
      work: string;
      /**
       * Its other names, tried in turn when the first finds nothing. The answer
       * is in French where the work has a French name, and AniList and the
       * English Wikidata labels often know it only by its English or romaji one.
       */
      names?: string[];
      /** The work's Wikidata item, when its seed came from Wikidata. */
      wikidataId?: string | null;
    };

/** What the catalogues said. Null is "not known"; zero is "looked, and nothing". */
export interface FameFacts {
  deezerRank: number | null;
  deezerFans: number | null;
  lastfmListeners: number | null;
  wikiLanguages: number | null;
  frPageviews: number | null;
  enPageviews: number | null;
  anilistMembers: number | null;
  tmdbVotes: number | null;
  ids: Record<string, string>;
  /** An anime's openings and endings, for finding the song a clip plays. */
  themes?: AnimeTheme[];
  /** A series' theme song, from Wikidata, for the same reason. */
  themeSong?: { title: string; artist: string } | null;
  /**
   * Which keyed services could be asked. An answer kept from before a key was
   * configured is asked again rather than kept for months without that figure.
   */
  asked?: OptionalSources;
}

function emptyFacts(): FameFacts {
  return {
    deezerRank: null,
    deezerFans: null,
    lastfmListeners: null,
    wikiLanguages: null,
    frPageviews: null,
    enPageviews: null,
    anilistMembers: null,
    tmdbVotes: null,
    ids: {}
  };
}

/** Whether any request of one lookup failed, which shortens how long it is kept. */
interface Trace {
  failed: boolean;
}

function settle<T>(trace: Trace, value: T | undefined): T | undefined {
  if (value === undefined) trace.failed = true;
  return value;
}

/* ----------------------------------------------------------- name matching */

/** A track title without the version noise a catalogue adds and a room never types. */
function bareTitle(title: string): string {
  return normalizeAnswer(
    title
      .replace(/\s*[([].*?(remaster|version|edit|mix|feat|ft\.|live|mono|stereo|radio).*?[)\]]/gi, '')
      .replace(/\s+-\s+.*(remaster|version|edit|mix|live).*$/i, '')
  );
}

function sameName(left: string, right: string): boolean {
  const a = normalizeAnswer(left);
  const b = normalizeAnswer(right);
  return a.length > 0 && a === b;
}

/**
 * The main artist of a credit: "QQ" of "QQ, IQ", "Booba" of "Booba feat. Kaaris".
 *
 * A catalogue files a song under its main artist, and a round's answer often
 * credits everyone on it.
 */
export function mainArtist(credit: string): string {
  return (
    credit
      .split(/\s*(?:,|&|\+|;|\/|\bfeat\.?|\bft\.?|\bfeaturing\b|\bx\b|\bvs\.?|\bwith\b|\bet\b|\band\b)\s*/i)[0]
      ?.trim() || credit
  );
}

/**
 * The same artist, as two catalogues credit them.
 *
 * Deezer files Bob Marley's catalogue under "Bob Marley & The Wailers", and an
 * exact comparison read that as never having heard of him. A name that starts
 * with the other followed by more words is the same act, with its band. And a
 * name that ends with the other is the same person by their full name: a
 * classical round credits "Beethoven", Deezer "Ludwig van Beethoven".
 */
function sameArtist(catalogued: string, wanted: string): boolean {
  const a = normalizeAnswer(catalogued);
  const b = normalizeAnswer(wanted);
  if (!a || !b) return false;
  return (
    a === b ||
    a.startsWith(`${b} `) ||
    b.startsWith(`${a} `) ||
    a.endsWith(` ${b}`) ||
    normalizeAnswer(mainArtist(catalogued)) === b
  );
}

function sameTitle(left: string, right: string): boolean {
  const a = bareTitle(left);
  const b = bareTitle(right);
  if (!a || !b) return false;
  return a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));
}

/* ------------------------------------------------------------- Wikipedia */

/**
 * Sites that are Wikipedias: `frwiki`, not `frwikiquote` or `commonswiki`.
 *
 * Their count is how many languages cover the subject, which is the best free
 * measure there is of fame beyond its home country.
 */
const NOT_A_WIKIPEDIA = new Set([
  'commonswiki',
  'specieswiki',
  'metawiki',
  'mediawikiwiki',
  'wikidatawiki',
  'sourceswiki',
  'outreachwiki',
  'wikifunctionswiki',
  'incubatorwiki',
  'wikimaniawiki'
]);

export function wikipediaLanguages(entity: WikidataEntity): number {
  return Object.keys(entity.sitelinks).filter((site) => /^[a-z_]+wiki$/.test(site) && !NOT_A_WIKIPEDIA.has(site))
    .length;
}

/**
 * Coverage and readership, from one Wikidata item.
 *
 * No item is "no Wikipedia anywhere", zeros, only when the search that would
 * have found one came back with nothing at all (`absent`) and nothing failed.
 * A search that found other names may have missed a spelling ("Beethoven" for
 * "Ludwig van Beethoven"), and leaves the figures unknown. An item with no
 * French article is a zero on the French side only.
 */
async function wikipediaFacts(
  entity: WikidataEntity | null,
  facts: FameFacts,
  sources: FameSources,
  trace: Trace,
  absent: boolean
) {
  if (!entity) {
    if (absent && !trace.failed) {
      facts.wikiLanguages = 0;
      facts.frPageviews = 0;
      facts.enPageviews = 0;
    }
    return;
  }

  facts.ids.wikidata = entity.id;
  facts.wikiLanguages = wikipediaLanguages(entity);
  for (const language of ['fr', 'en'] as const) {
    const title = entity.sitelinks[`${language}wiki`];
    const views = title ? settle(trace, await sources.pageviews(language, title)) : 0;
    if (views === undefined) continue;
    if (language === 'fr') facts.frPageviews = views;
    else facts.enPageviews = views;
  }
}

async function entityById(id: string | null | undefined, sources: FameSources, trace: Trace) {
  if (!id) return null;
  const [entity] = settle(trace, await sources.wikidataEntities([id])) ?? [];
  return entity ?? null;
}

async function firstByClaim(property: string, value: string, sources: FameSources, trace: Trace) {
  return (settle(trace, await sources.wikidataByClaim(property, value)) ?? [])[0] ?? null;
}

/* ----------------------------------------------------------------- music */

/** Claims only a music artist's Wikidata item carries: catalogue ids. */
const MUSIC_ARTIST_IDS = ['P434', 'P2722', 'P1902', 'P1953', 'P3192'];

/**
 * An artist's Wikidata item by name, as a last resort.
 *
 * Accepted only when its label is the artist's name and it carries a music
 * catalogue's id, so a search for "QQ" cannot settle on the messaging app.
 * `empty` says the search found nothing at all, which is the only miss that
 * means the artist has no Wikipedia.
 */
async function artistByName(
  name: string,
  sources: FameSources,
  trace: Trace
): Promise<{ entity: WikidataEntity | null; empty: boolean }> {
  const ids = settle(trace, await sources.wikidataSearch(name, 'en')) ?? [];
  if (ids.length === 0) return { entity: null, empty: true };
  const entities = settle(trace, await sources.wikidataEntities(ids.slice(0, 5))) ?? [];
  const entity =
    entities.find(
      (candidate) =>
        Object.values(candidate.labels).some((label) => sameName(label, name)) &&
        MUSIC_ARTIST_IDS.some((property) => (candidate.claims[property]?.length ?? 0) > 0)
    ) ?? null;
  return { entity, empty: false };
}

async function musicFame(
  target: Extract<FameTarget, { shape: 'artist-title' }>,
  sources: FameSources,
  trace: Trace
): Promise<FameFacts> {
  const facts = emptyFacts();
  const main = mainArtist(target.artist);
  // The whole credit first: "Simon & Garfunkel" is not Simon. The main artist
  // only when the whole credit finds nothing.
  const credits = [...new Set([target.artist, main])];

  /**
   * Deezer: the track if it can be found, the best-ranked version of it.
   *
   * A search lists the remaster, the live take and the radio edit side by side;
   * the original is the one people play, and the one with the highest rank.
   */
  let tracks: DeezerTrackHit[] | undefined;
  let track: DeezerTrackHit | undefined;
  for (const credit of credits) {
    tracks = settle(trace, await sources.deezerTracks(credit, target.title));
    track = (tracks ?? [])
      .filter((hit) => sameArtist(hit.artist.name, credit) && sameTitle(hit.title, target.title))
      .sort((left, right) => right.rank - left.rank)[0];
    if (track) break;
  }
  let artistId: number | null = track?.artist.id ?? null;
  /** The artist as Deezer names them, which the other catalogues know them by too. */
  let named: string | null = track?.artist.name ?? null;
  let fans: number | null = null;
  if (track) {
    facts.deezerRank = track.rank;
    facts.ids.deezerTrack = String(track.id);
  }

  /**
   * And the artist, by each way the answer credits them.
   *
   * Only a search that comes back with nothing at all says Deezer has never
   * heard of them. One that returns other names may simply have missed the
   * spelling, and that leaves the figure unknown rather than zero.
   */
  if (artistId === null) {
    let answeredEmpty = true;
    for (const credit of credits) {
      const artists = settle(trace, await sources.deezerArtists(credit));
      if (artists === undefined) {
        answeredEmpty = false;
        continue;
      }
      if (artists.length > 0) answeredEmpty = false;
      const artist =
        artists.find((hit) => sameName(hit.name, credit)) ??
        artists
          .filter((hit) => sameArtist(hit.name, credit))
          .sort((left, right) => (right.fans ?? 0) - (left.fans ?? 0))[0];
      if (artist) {
        artistId = artist.id;
        named = artist.name;
        fans = artist.fans;
        break;
      }
    }
    if (artistId === null && answeredEmpty && tracks !== undefined) {
      facts.deezerFans = 0;
      facts.deezerRank = 0;
    }
  }

  if (artistId !== null) {
    facts.ids.deezerArtist = String(artistId);
    if (fans === null) {
      const artist = settle(trace, await sources.deezerArtist(artistId));
      fans = artist?.fans ?? null;
    }
    facts.deezerFans = fans;
  }

  // Wikidata by the ids it shares with Deezer and MusicBrainz, then by name.
  let qid = artistId !== null ? await firstByClaim('P2722', String(artistId), sources, trace) : null;
  if (!qid && target.artistMbid) qid = await firstByClaim('P434', target.artistMbid, sources, trace);
  let entity = qid ? await entityById(qid, sources, trace) : null;
  let absent = false;
  /**
   * And the answer's own artist, when Deezer credits somebody wider.
   *
   * Deezer's id for "Bob Marley & The Wailers" is the band's Wikidata item,
   * twenty-four Wikipedias, while the answer is Bob Marley, in a hundred and
   * thirty-six. The better covered of the two is the one the room knows.
   */
  if (!entity || (named !== null && !sameName(named, target.artist))) {
    const own = await artistByName(entity ? main : (named ?? main), sources, trace);
    if (own.entity && (!entity || wikipediaLanguages(own.entity) > wikipediaLanguages(entity))) entity = own.entity;
    absent = !entity && own.empty;
  }
  await wikipediaFacts(entity, facts, sources, trace, absent);

  const listeners = settle(trace, await sources.lastfmListeners(named ?? target.artist, target.title));
  if (listeners !== undefined) facts.lastfmListeners = listeners;

  return facts;
}

/* ----------------------------------------------------------------- works */

/**
 * A media franchise: "Star Wars" names the saga as much as its first film, and
 * the saga is what a room recognises from the theme.
 */
const MEDIA_FRANCHISE = 'Q196600';

/**
 * What a work's Wikidata item is an instance of, by kind.
 *
 * With the ids only that kind of work carries as a second test, because the
 * classes are many and specific ("animated feature film", "miniseries") and a
 * list of them is never complete. Not the IMDb id: people have one too, and
 * "Elvis" the film was being scored with the fame of Elvis the man.
 */
const WORK_TYPES: Record<Exclude<WorkKind, 'anime'>, { types: string[]; ids: string[] }> = {
  film: {
    types: ['Q11424', 'Q24869', 'Q202866', 'Q29168811', 'Q506240', 'Q24862', 'Q229390', MEDIA_FRANCHISE],
    ids: ['P4947', 'P1265']
  },
  series: {
    types: ['Q5398426', 'Q581714', 'Q1259759', 'Q526877', 'Q63952888', 'Q15416', MEDIA_FRANCHISE],
    ids: ['P4983', 'P4835']
  },
  game: { types: ['Q7889', 'Q7058673', MEDIA_FRANCHISE], ids: ['P5794', 'P1733', 'P2725'] }
};

/** A person or a fictional character, which a work is named after but never is. */
const NOT_A_WORK = ['Q5', 'Q95074'];

function isKind(entity: WikidataEntity, kind: Exclude<WorkKind, 'anime'>): boolean {
  const { types, ids } = WORK_TYPES[kind];
  const instanceOf = entity.claims.P31 ?? [];
  if (instanceOf.some((type) => NOT_A_WORK.includes(type))) return false;
  return (
    instanceOf.some((type) => types.includes(type)) ||
    ids.some((property) => (entity.claims[property]?.length ?? 0) > 0)
  );
}

/** How many of a work's names are tried before it is taken as unknown. */
const MAX_NAMES = 3;

/**
 * A film, series or game by its name, searched in French and in English.
 *
 * Of the items of the right kind, the one most Wikipedias cover: a search for
 * "Star Wars" also finds a documentary, a novelisation and a pinball machine of
 * that name, and the saga is the one the room means. `empty` says the search
 * found nothing at all, as for `artistByName`.
 */
async function workByName(
  name: string,
  kind: Exclude<WorkKind, 'anime'>,
  sources: FameSources,
  trace: Trace
): Promise<{ entity: WikidataEntity | null; empty: boolean }> {
  const ids = new Set<string>();
  for (const language of ['fr', 'en'] as const) {
    for (const id of (settle(trace, await sources.wikidataSearch(name, language)) ?? []).slice(0, 7)) ids.add(id);
  }
  if (ids.size === 0) return { entity: null, empty: true };
  const entities = settle(trace, await sources.wikidataEntities([...ids])) ?? [];
  const entity =
    entities
      .filter((candidate) => isKind(candidate, kind))
      .sort((left, right) => wikipediaLanguages(right) - wikipediaLanguages(left))[0] ?? null;
  return { entity, empty: false };
}

/** A series' theme song and who performs it, from its Wikidata item. */
async function themeSongOf(entity: WikidataEntity, sources: FameSources, trace: Trace) {
  const themeId = entity.claims.P942?.[0];
  if (!themeId) return null;
  const theme = await entityById(themeId, sources, trace);
  const title = theme?.labels.en ?? theme?.labels.fr;
  if (!theme || !title) return null;
  const performer = await entityById(theme.claims.P175?.[0], sources, trace);
  const artist = performer?.labels.en ?? performer?.labels.fr ?? '';
  return artist ? { title, artist } : null;
}

async function workFame(
  target: Extract<FameTarget, { shape: 'work' }>,
  sources: FameSources,
  trace: Trace
): Promise<FameFacts> {
  const facts = emptyFacts();
  const names = [...new Set([target.work, ...(target.names ?? [])].map((name) => name.trim()).filter(Boolean))].slice(
    0,
    MAX_NAMES
  );

  if (target.kind === 'anime') {
    /**
     * The anime every name agrees on.
     *
     * AniList answers a French title with its nearest match, which for "L'Attaque
     * des Titans" is the final season rather than the series. So a hit that
     * carries one of the names as a title wins wherever it is found, and the
     * first search's best match stands in only when no name is a title at all.
     */
    let anime: AnilistHit | null = null;
    let fallback: AnilistHit | null = null;
    for (const name of names) {
      const hits = settle(trace, await sources.anilist(name)) ?? [];
      fallback ??= hits[0] ?? null;
      anime = hits.find((hit) => hit.titles.some((title) => sameName(title, name))) ?? null;
      if (anime) break;
    }
    anime ??= fallback;
    if (anime) {
      facts.anilistMembers = anime.popularity;
      facts.ids.anilist = String(anime.id);
      const themes = settle(trace, await sources.animeThemes(anime.id));
      if (themes) facts.themes = themes;
    } else if (!trace.failed) {
      facts.anilistMembers = 0;
    }
    const qid = anime ? await firstByClaim('P8729', String(anime.id), sources, trace) : null;
    // No Wikipedia only for an anime AniList has never heard of either; one it
    // knows that Wikidata does not link to it is simply not known here.
    const item = await entityById(qid ?? target.wikidataId, sources, trace);
    await wikipediaFacts(item, facts, sources, trace, !anime && !item);
    return facts;
  }

  let entity = await entityById(target.wikidataId, sources, trace);
  // No Wikipedia only when every name searched found nothing at all.
  let absent = !entity;
  for (const name of names) {
    if (entity) break;
    const found = await workByName(name, target.kind, sources, trace);
    entity = found.entity;
    absent &&= found.empty;
  }
  await wikipediaFacts(entity, facts, sources, trace, absent && !entity);

  if (target.kind !== 'game') {
    const kind = target.kind === 'film' ? 'movie' : 'tv';
    const tmdbId = entity?.claims[target.kind === 'film' ? 'P4947' : 'P4983']?.[0];
    const tmdb = settle(trace, await sources.tmdbVotes(kind, tmdbId ? { id: tmdbId } : { query: target.work }));
    if (tmdb) {
      facts.tmdbVotes = tmdb.votes;
      facts.ids.tmdb = tmdb.id;
    }
  }
  if (target.kind === 'series' && entity) facts.themeSong = await themeSongOf(entity, sources, trace);

  return facts;
}

/* ------------------------------------------------------------- the cache */

/** A song's fame moves over months, not evenings. */
const FAME_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** A lookup with a failed request in it is tried again sooner. */
const PARTIAL_TTL_MS = 24 * 60 * 60 * 1000;

export function fameKey(target: FameTarget): string {
  return target.shape === 'artist-title'
    ? `music:${normalizeAnswer(target.artist)}::${bareTitle(target.title)}`
    : `work:${target.kind}:${normalizeAnswer(target.work)}`;
}

function cached(db: Db, key: string, now: number): FameFacts | null {
  const row = db.select().from(blindtestFame).where(eq(blindtestFame.key, key)).get();
  if (!row || Date.parse(row.expires_at) < now) return null;
  try {
    return JSON.parse(row.facts) as FameFacts;
  } catch {
    return null;
  }
}

function keep(db: Db, key: string, facts: FameFacts, until: number): void {
  const values = { key, facts: JSON.stringify(facts), expires_at: new Date(until).toISOString() };
  db.insert(blindtestFame)
    .values(values)
    .onConflictDoUpdate({ target: blindtestFame.key, set: { facts: values.facts, expires_at: values.expires_at } })
    .run();
}

/**
 * What the catalogues know about this track or work, from the cache when it is
 * fresh. Never throws: a lookup that cannot run comes back with nothing known.
 */
export async function lookupFame(
  db: Db,
  sources: FameSources,
  target: FameTarget,
  options: { now?: number; refresh?: boolean } = {}
): Promise<FameFacts> {
  const now = options.now ?? Date.now();
  const key = fameKey(target);
  if (!options.refresh) {
    const hit = cached(db, key, now);
    const configured = sources.configured();
    const keyedSince = (configured.lastfm && !hit?.asked?.lastfm) || (configured.tmdb && !hit?.asked?.tmdb);
    if (hit && !keyedSince) return hit;
  }

  const trace: Trace = { failed: false };
  const asked = sources.configured();
  let facts: FameFacts;
  try {
    facts =
      target.shape === 'artist-title'
        ? await musicFame(target, sources, trace)
        : await workFame(target, sources, trace);
  } catch {
    return emptyFacts();
  }

  facts.asked = asked;
  try {
    keep(db, key, facts, now + (trace.failed ? PARTIAL_TTL_MS : FAME_TTL_MS));
  } catch {
    // A cache that cannot be written costs a second lookup, nothing more.
  }
  return facts;
}

/* ------------------------------------------------------- the clip's song */

/** "OP 3", "Opening 3", "ED2", "Ending 2" in a video title. */
export function themeSlotOf(videoTitle: string): { type: 'OP' | 'ED'; sequence: number | null } | null {
  const match = /\b(op|opening|ed|ending)\s*#?\s*(\d{1,2})?\b/i.exec(videoTitle);
  if (!match) return null;
  const type = /^(op|opening)$/i.test(match[1] ?? '') ? 'OP' : 'ED';
  return { type, sequence: match[2] ? Number(match[2]) : null };
}

/**
 * Which of an anime's themes a clip plays, when that can be told.
 *
 * By the slot the video's title names, or the only theme of that type there is.
 * Anything less certain is no answer: a chorus taken from the wrong song puts the
 * window somewhere arbitrary while claiming to have measured it.
 */
export function animeThemeFor(
  themes: readonly AnimeTheme[],
  slot: { type: 'OP' | 'ED'; sequence: number | null } | null,
  genreType: 'OP' | 'ED'
): AnimeTheme | null {
  const type = slot?.type ?? genreType;
  const ofType = themes.filter((theme) => theme.type === type);
  if (slot?.sequence != null) {
    return ofType.find((theme) => (theme.sequence ?? 1) === slot.sequence) ?? null;
  }
  return ofType.length === 1 ? (ofType[0] ?? null) : null;
}
