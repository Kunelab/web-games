/**
 * The catalogue an infinite blind test draws from.
 *
 * Same shape as `panel-service`, and for the same reasons: a pool per source,
 * filled from a remote API, cached for hours, and drawn from in memory so that
 * producing a round costs nothing. What differs is what makes a candidate usable,
 * and there are three tests rather than one.
 *
 *  - **It has to exist and be playable *here*.** YouTube licences per territory,
 *    and the failure is silent: a video can be public, embeddable and healthy and
 *    still refuse to play in France because its allow-list names twelve countries.
 *    Nothing in the editor shows it. The room hears silence. So the region rules
 *    are fetched with the rest of the metadata and stored *raw* — see
 *    `PoolEntry.restriction` — because a pool is shared between rooms and each
 *    room has its own country.
 *
 *  - **It has to be one song.** A compilation has a different answer every twenty
 *    seconds, so no window over it is answerable. Rejected on title and on
 *    duration, because "TOP 10 RÉPLIQUES CULTES" and a fifty-minute mix are the
 *    same problem wearing different clothes.
 *
 *  - **It has to have an answer worth asking for.** Derived from the title, which
 *    for music is a convention ("Artist - Title") and for everything else is not:
 *    the answer to an anime opening is the *anime*, which the title mentions in
 *    passing if at all. What a regular expression cannot do here, a language model
 *    can, and does — once, in a batch, at fill time, never while a room waits.
 *
 * Quota is the constraint that shapes all of it. `search.list` costs 100 units
 * against a daily 10,000, while `playlistItems.list` and `videos.list` cost one
 * unit per fifty items. Per-round searching is therefore impossible: it would cap
 * the whole deployment at a hundred rounds a day. Searching once per genre per
 * day, and drawing from the pool it fills, costs a few hundred units and serves
 * an evening.
 */
import { normalizeAnswer, splitArtistTitle } from 'game-core';

import { env } from '../env.js';
import { anilistAliases, musicbrainzAliases } from './blindtest-aliases.js';
import { THEME_PROFILE, VOCAL_PROFILE, fetchChorus, type ChorusInfo, type ClipProfile } from './chorus-service.js';
import { annotateCandidates, type Annotation } from './blindtest-llm.js';
import { fetchPlaylistItems, fetchVideoFacts, searchVideos, YoutubeError, type VideoFacts } from './youtube-service.js';

/* -------------------------------------------------------------- the taxonomy */

/**
 * What a genre expects an answer to look like.
 *
 * `artist-title` scores two fields; `work` scores one, because "which anime is
 * this" has no second half. This drives the answer fields a generated round
 * carries, so it is content rather than presentation.
 */
export type AnswerShape = 'artist-title' | 'work';

export interface GenreSource {
  /** YouTube playlist id. */
  playlistId: string;
  /**
   * How far down the playlist a draw may begin.
   *
   * The same dial as `panel-service`'s, and it exists for the same reason: the
   * head of a curated playlist is the famous part, and how long that head is
   * differs enormously between sources. Measured per playlist, by hand.
   */
  depth?: number;
}

/**
 * Why the sources are queries and not a list of playlists.
 *
 * The first version of this file held curated playlist ids, and it was wrong in
 * the most instructive way available: of eighteen ids, nine were dead and several
 * of the survivors had drifted off their genre entirely — a "metal" list whose
 * first entry was a-ha, an "anime openings" list opening with Alan Walker.
 *
 * That is not bad luck, it is the shape of the problem. A playlist id is a fact
 * written down once about a mutable thing somebody else owns. It goes private,
 * it gets deleted, its curator loses interest, and nothing announces any of it;
 * the genre simply starts coming back empty months later.
 *
 * A query is evaluated against the live catalogue every time it is used. It costs
 * a hundred quota units where a playlist costs one, which is why the pool it
 * fills is cached for a day rather than a few hours, and why this is the one
 * place in the codebase allowed to call `search.list` at all.
 *
 * Playlists are still supported and still useful where a genuinely good one is
 * known, because they are nearly free. They are an optional supplement now rather
 * than the foundation.
 */

export interface Genre {
  id: string;
  label: string;
  section: string;
  answerShape: AnswerShape;
  /** Live searches, the primary source. Empty for a facet. */
  queries: string[];
  /** Known-good playlists, a cheap supplement. */
  playlists?: GenreSource[];
  /**
   * An era facet over another genre's pool, rather than sources of its own.
   *
   * "90s rap" is not a different catalogue, it is the same catalogue filtered by
   * release year, and curating a second set of playlists for it would be work that
   * goes stale. A facet costs nothing and stays correct as the parent pool grows.
   */
  facetOf?: string;
  yearRange?: { from: number; to: number };
  /** Extra title patterns that mean this is not the genre's kind of video. */
  reject?: RegExp;
  /**
   * Where this genre's recognisable part tends to sit.
   *
   * Defaulted from the answer shape, because the two correlate strongly: a genre
   * answered by artist and track is sung and has a chorus to find, while a genre
   * answered by the work it comes from is usually instrumental and states its
   * theme early. Overridden where that correlation breaks down.
   */
  profile?: ClipProfile;
}

export interface Section {
  id: string;
  label: string;
}

export const SECTIONS: Section[] = [
  { id: 'rap', label: 'Rap' },
  { id: 'pop-rock', label: 'Pop & Rock' },
  { id: 'chanson', label: 'Chanson française' },
  { id: 'electro', label: 'Électro & Dance' },
  { id: 'anime', label: 'Japanimation' },
  { id: 'ecrans', label: 'Écrans' },
  { id: 'jeux', label: 'Jeux vidéo' },
  { id: 'monde', label: 'Musiques du monde' }
];

/**
 * The genres, and where each draws from.
 *
 * The queries are the part worth tuning. A search returns whatever YouTube thinks
 * the words mean, and the words matter: "rap song" pulls in pop, while "hip hop
 * classics official video" stays much closer to the genre. `fillPool` reports any
 * source that comes back short, which is the early warning that one has stopped
 * working.
 */
export const GENRES: Genre[] = [
  /* ------------------------------------------------------------------- rap */
  {
    id: 'rap-fr',
    label: 'Rap français',
    section: 'rap',
    answerShape: 'artist-title',
    queries: ['rap français clip officiel', 'rap fr classique morceau', 'rappeur français titre officiel'],
    playlists: [{ playlistId: 'PL39z-AAkkatsDhv2Fkr-efPk34iQvtAHW' }]
  },
  {
    id: 'rap-us',
    label: 'Rap US',
    section: 'rap',
    answerShape: 'artist-title',
    queries: ['hip hop classics official video', 'rap song official audio', '90s hip hop official video']
  },
  {
    id: 'rap-90s',
    label: 'Rap 90s',
    section: 'rap',
    answerShape: 'artist-title',
    queries: [],
    facetOf: 'rap-us',
    yearRange: { from: 1988, to: 1999 }
  },
  {
    id: 'rap-2010s',
    label: 'Rap 2010s',
    section: 'rap',
    answerShape: 'artist-title',
    queries: [],
    facetOf: 'rap-us',
    yearRange: { from: 2010, to: 2019 }
  },

  /* -------------------------------------------------------------- pop-rock */
  {
    id: 'pop',
    label: 'Pop internationale',
    section: 'pop-rock',
    answerShape: 'artist-title',
    queries: ['pop hits official video', 'pop song official audio', '2000s pop official video']
  },
  {
    id: 'rock',
    label: 'Rock',
    section: 'pop-rock',
    answerShape: 'artist-title',
    queries: ['classic rock official video', 'rock anthem official audio', '90s rock official video']
  },
  {
    id: 'metal',
    label: 'Metal',
    section: 'pop-rock',
    answerShape: 'artist-title',
    queries: ['heavy metal official video', 'metal band official audio', 'thrash metal official video']
  },

  /* --------------------------------------------------------------- chanson */
  {
    id: 'chanson-fr',
    label: 'Chanson française',
    section: 'chanson',
    answerShape: 'artist-title',
    queries: ['chanson française clip officiel', 'variété française titre officiel', 'chanson francaise classique']
  },
  {
    id: 'variete-80',
    label: 'Variété 80s',
    section: 'chanson',
    answerShape: 'artist-title',
    queries: [],
    facetOf: 'chanson-fr',
    yearRange: { from: 1975, to: 1989 }
  },

  /* --------------------------------------------------------------- electro */
  {
    id: 'electro',
    label: 'Électro',
    section: 'electro',
    answerShape: 'artist-title',
    queries: ['electronic music official video', 'house music official audio', 'edm official video']
  },

  /* ----------------------------------------------------------------- anime */
  {
    id: 'anime-op',
    label: 'Openings',
    section: 'anime',
    answerShape: 'work',
    queries: ['anime opening official', 'anime opening full', 'anime op creditless'],
    reject: /\b(amv|nightcore|cover|piano|8d|reaction)\b/i
  },
  {
    id: 'anime-ed',
    label: 'Endings',
    section: 'anime',
    answerShape: 'work',
    queries: ['anime ending official', 'anime ending full'],
    reject: /\b(amv|nightcore|cover|piano|8d|reaction)\b/i
  },

  /* ---------------------------------------------------------------- écrans */
  {
    id: 'films-musique',
    label: 'Musiques de films',
    section: 'ecrans',
    answerShape: 'work',
    queries: ['movie soundtrack main theme', 'film score official soundtrack', 'bande originale film thème'],
    reject: /\b(cover|piano tutorial|remix|reaction|epic music mix)\b/i
  },
  {
    id: 'series-tv',
    label: 'Génériques de séries',
    section: 'ecrans',
    answerShape: 'work',
    queries: ['tv series opening theme', 'série générique officiel', 'tv show intro theme song'],
    reject: /\b(cover|reaction|fan made)\b/i
  },

  /* ------------------------------------------------------------------ jeux */
  {
    id: 'jeux-video',
    label: 'Musiques de jeux',
    section: 'jeux',
    answerShape: 'work',
    queries: ['video game soundtrack main theme', 'game ost official', 'videogame music theme'],
    reject: /\b(cover|remix|piano tutorial|reaction|playthrough|gameplay)\b/i
  },

  /* ----------------------------------------------------------------- monde */
  {
    id: 'reggae',
    label: 'Reggae',
    section: 'monde',
    answerShape: 'artist-title',
    queries: ['reggae classics official video', 'reggae song official audio']
  },
  {
    id: 'kpop',
    label: 'K-pop',
    section: 'monde',
    answerShape: 'artist-title',
    queries: ['kpop official mv', 'k-pop official music video']
  }
];

export const genreById = new Map(GENRES.map((genre) => [genre.id, genre]));
export const genreIds = GENRES.map((genre) => genre.id);

/** Where to aim a clip for this genre. */
export function profileFor(genre: Genre): ClipProfile {
  return genre.profile ?? (genre.answerShape === 'work' ? THEME_PROFILE : VOCAL_PROFILE);
}

/** The pool a genre actually reads, following a facet back to its parent. */
export function sourceGenreFor(genre: Genre): Genre {
  if (!genre.facetOf) return genre;
  return genreById.get(genre.facetOf) ?? genre;
}

/* ------------------------------------------------------------------ entries */

/**
 * What the pool stores per candidate.
 *
 * `restriction` is the raw territory data rather than a verdict, and that is the
 * central design decision of this file. One pool serves every room; whether a
 * clip is playable depends on the room's country; so the pool cannot hold a
 * boolean without becoming one pool per country.
 */
export interface PoolEntry {
  videoId: string;
  /**
   * Identity of the *recording*, not of the upload.
   *
   * Deduplication has to happen here or the same song returns under a second
   * Topic upload and the room hears it twice in one session. Normalised artist
   * and title, because that is what survives a different upload.
   */
  trackKey: string;
  title: string;
  artist: string;
  /** The single answer, for `work` genres. Empty for `artist-title`. */
  work: string;
  /**
   * Accepted spellings, kept apart by the field they belong to.
   *
   * They were one list, and merging them was a scoring bug rather than untidiness:
   * the model's aliases are alternative spellings of the *track title*, the
   * MusicBrainz ones are alternative spellings of the *artist*, and the merged
   * list was attached to the artist field alone. Since the matcher accepts an
   * alias as the answer, typing the song's name into the artist box scored the
   * artist's points, and the title field — which had the aliases that actually
   * belonged to it — was left with none.
   */
  titleAliases: string[];
  artistAliases: string[];
  /** For `work` genres, where there is one answer and therefore one list. */
  workAliases: string[];
  year: number | null;
  /**
   * Whether `year` came from a music/anime catalogue rather than from YouTube.
   *
   * Separate from `enriched` because the two answer different questions and
   * conflating them reinstated the bug the flag was added to prevent: `enrich`
   * always runs, but MusicBrainz and AniList frequently have no match, and the
   * year then quietly stays as the upload date. An era facet that trusts
   * `enriched` is therefore filtering on when somebody posted the video, which
   * for a Topic upload of a back catalogue is decades out.
   */
  yearVerified: boolean;
  views: number;
  durationSeconds: number;
  channel: string;
  restriction: VideoFacts['restriction'];
  /** 0 (household name) to 100 (deep cut). See `scoreDifficulty`. */
  difficulty: number;
  /** A model's estimate of where the theme sits, for instrumentals only. */
  hintFraction: number | null;
  chorus: ChorusInfo | null;
  /**
   * Whether the slow enrichment has run for this entry.
   *
   * Tri-state by way of the two fields above being nullable in their own right:
   * `chorus` of null means "no chorus" once this is true, and "not looked up yet"
   * while it is false. Without the flag every instrumental would be looked up
   * again on every single draw.
   */
  enriched: boolean;
  genreId: string;
  answerShape: AnswerShape;
}

interface Pool {
  entries: PoolEntry[];
  fetchedAt: number;
  /** Sources that came back empty or tiny, so a rotten playlist is visible. */
  thinSources: string[];
}

/**
 * A full day.
 *
 * Longer than the memory panel's six hours because a fill here costs a hundred
 * quota units per query rather than one, and because a genre's worth of famous
 * music does not change between lunch and dinner.
 */
const POOL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long a pool that came back empty is remembered before it is tried again.
 *
 * Short, because an empty genre is usually a passing failure — a rate limit, a
 * 5xx — rather than a fact about the catalogue. Long enough that the setup
 * screen polling every four seconds costs one attempt, not fifty.
 */
const EMPTY_POOL_RETRY_MS = 5 * 60 * 1000;

/** Bounds memory. A few hundred entries per genre is ample for an evening. */
const MAX_POOL_ENTRIES = 600;

/**
 * How many entries get their release year verified when a pool backs an era facet.
 *
 * Each one is a serialised MusicBrainz lookup, so this is roughly its own number
 * of seconds added to a daily pool fill. Enough to give an era facet a real pool
 * to draw from; far short of the whole catalogue, which would take half an hour
 * and annoy a free service that asks for one request a second.
 */
const YEAR_CHECK_LIMIT = 80;

/** Below this a video is a fragment; above it, a compilation, a mix or an album. */
const MIN_DURATION_SECONDS = 60;
const MAX_DURATION_SECONDS = 12 * 60;

/**
 * Titles that are never one answerable thing.
 *
 * The compilation test is the one that matters most and the one a duration check
 * alone misses: a five minute "TOP 5" is within every other bound and still has
 * five answers.
 */
const NOT_A_SINGLE_WORK =
  /\b(top\s*\d+|compilation|best[\s-]?of|les\s+meilleur|mix|megamix|mashup|medley|full\s+album|album\s+complet|playlist|\d+\s*(h|hours?|heures?)\b|reaction|react|review|analys|explain|tutorial|karaoke|instrumental|lyrics?\s+video|sped\s*up|slowed|nightcore|8d\s*audio|loop(ed)?\b|1\s*hour)/i;

const pools = new Map<string, Pool>();

/** In-flight fills, so ten rooms opening at once cause one fetch, not ten. */
const filling = new Map<string, Promise<Pool>>();

/* ------------------------------------------------------------------ helpers */

/**
 * An auto-generated "Art Track": the recording with nothing around it.
 *
 * Worth recognising because its clock is the track's, which is what makes lyric
 * timestamps usable. See the dedup in .
 */
function isTopic(channel: string): boolean {
  return / - Topic$/i.test(channel.trim());
}

/**
 * Drops the artist when it has been repeated inside the title.
 *
 * The model sometimes answers the whole of "Action Bronson – Easy Rider" as the
 * track, having already given "Action Bronson" as the artist. Both fields are
 * then technically right and the title one is unwinnable: a player who types
 * "Easy Rider", which is the name of the song, is marked wrong for not having
 * also typed the artist into the title box.
 *
 * Only a genuine prefix is removed, and only when a separator follows it, so a
 * track that really is named after its artist keeps its name.
 */
function withoutArtistPrefix(title: string, artist: string): string {
  const normalizedArtist = normalizeAnswer(artist);
  if (!normalizedArtist) return title;

  const match = /^(.*?)\s*[-–—:|]\s*(.+)$/.exec(title);
  if (!match) return title;

  const [, head, tail] = match;
  if (!head || !tail) return title;
  if (normalizeAnswer(head) !== normalizedArtist) return title;

  return tail.trim();
}

function trackKeyFor(artist: string, title: string, work: string): string {
  const left = normalizeAnswer(artist);
  const right = normalizeAnswer(title || work);
  return left ? `${left}::${right}` : right;
}

/**
 * There was a title-stripping fallback here, and removing it was the fix.
 *
 * It turned "Naruto Shippuden OP 16 - Silhouette" into "Naruto Shippuden", which
 * looked like it worked. On a live search it met titles of every other shape and
 * produced answers such as `YOASOBI Official Music Video／TVアニメ オープニングテーマ`
 * and `廻廻奇譚 - Eve MV`: unwinnable rounds, generated confidently, indistinguishable
 * from good ones until a room is staring at them.
 *
 * A genre answered by its work now requires the model's judgement or drops the
 * candidate. A pool is hundreds deep and a session plays dozens, so refusing what
 * nothing could name costs nothing worth having. See `toEntry`.
 */

/**
 * Popularity turned into a difficulty, within this genre.
 *
 * View count is the only fame signal that arrives free with the metadata, and it
 * is a good one for music. It is a poor one for anime and film, where a hugely
 * viewed edit can carry an obscure work, which is exactly the gap the language
 * model annotation fills. Blended rather than switched, so a genre with no
 * annotation still gets a usable spread.
 */
function scoreDifficulty(rank: number, total: number, annotated: number | null): number {
  // 0 for the most viewed in the pool, 100 for the least.
  const byViews = total <= 1 ? 50 : Math.round((rank / (total - 1)) * 100);
  if (annotated === null) return byViews;
  return Math.round(byViews * 0.6 + annotated * 0.4);
}

/* --------------------------------------------------------------- the filler */

/**
 * Turns one YouTube video into a candidate, or rejects it.
 *
 * Everything here is cheap and local. The expensive judgements — is this really
 * this anime, what else might a player type — happen once per batch afterwards.
 */
function toEntry(
  facts: VideoFacts,
  genre: Genre,
  annotation: Annotation | undefined,
  /**
   * Whether annotation ran for this pool at all.
   *
   * The difference between "the model declined this one" and "no model answered"
   * matters, and conflating them is how a pool ends up either empty or impure.
   *
   * When the batch landed, a candidate it did not mention was deliberately left
   * out, and keeping it would reinstate exactly what the genre filter rejected:
   * the first pools for "rap US" came back holding Bruno Mars and Martin Garrix.
   * When no endpoint answered at all, dropping everything would leave the genre
   * with nothing, and a pool with a few neighbours in it is a far better evening
   * than a mode that refuses to start.
   */
  annotationRan: boolean
): PoolEntry | null {
  const rawTitle = facts.title;

  if (NOT_A_SINGLE_WORK.test(rawTitle)) return null;
  if (genre.reject?.test(rawTitle)) return null;
  if (facts.durationSeconds === null) return null;
  if (facts.durationSeconds < MIN_DURATION_SECONDS || facts.durationSeconds > MAX_DURATION_SECONDS) return null;

  // The model gets the last word on whether this is answerable at all: it is the
  // only thing that can tell a montage from a track by reading the title.
  if (annotation?.kind === 'reject') return null;
  // And on whether it belongs here. YouTube search has no notion of genre below
  // its Music category, so a query for rap returns pop, and only something that
  // recognises the artist can say so.
  if (annotation?.fitsGenre === false) return null;

  let artist = '';
  let title = '';
  let work = '';

  if (genre.answerShape === 'artist-title') {
    if (annotationRan && !annotation) return null;

    artist = annotation?.artist?.trim() || '';
    title = annotation?.answer?.trim() || '';
    if (!artist || !title) {
      const split = splitArtistTitle(rawTitle);
      artist = artist || split.artist;
      title = title || split.title;
    }
    if (!artist || !title) return null;

    title = withoutArtistPrefix(title, artist);
  } else {
    /**
     * A `work` answer has to come from the model, or not at all.
     *
     * The title-stripping fallback is fine for "Naruto Shippuden OP 16" and
     * useless for everything that does not follow that shape, which on a live
     * search is most of it. Without this the first real pool produced rounds
     * whose answer was `YOASOBI Official Music Video／TVアニメ オープニングテーマ`
     * — a string nobody can type, presented as the thing to guess.
     *
     * So there is no fallback at all here: the model answers, or the candidate
     * is dropped. A pool is hundreds deep and a session plays dozens.
     */
    /**
     * And the model has to have answered the *right question*.
     *
     * Asked about an anime opening it will often reply `music` with the song —
     * "YOASOBI - Idol" — which is a true statement and the wrong answer: the
     * round asks which anime, and Idol is Oshi no Ko. A `music` verdict in a
     * `work` genre means it read the title and did not know the work, so the
     * candidate is dropped rather than asked about the song by accident.
     */
    if (annotation?.kind !== 'work') return null;

    work = annotation.answer.trim();
    if (!work) return null;
    if (work.length > 80) return null;
    // A leftover fragment of the video's own title is not an answer.
    if (/official|music video|mv\b|opening|ending|\bost\b|theme song|full ver/i.test(work)) return null;
  }

  return {
    videoId: facts.videoId,
    trackKey: trackKeyFor(artist, title, work),
    title,
    artist,
    work,
    // The model's aliases are spellings of the answer it gave, so they follow it
    // to the field that carries that answer and nowhere else.
    titleAliases: genre.answerShape === 'artist-title' ? (annotation?.aliases ?? []) : [],
    artistAliases: [],
    workAliases: genre.answerShape === 'work' ? (annotation?.aliases ?? []) : [],
    year: facts.year,
    yearVerified: false,
    views: facts.views,
    durationSeconds: facts.durationSeconds,
    channel: facts.channel,
    restriction: facts.restriction,
    difficulty: 50,
    hintFraction: annotation?.hookFraction ?? null,
    chorus: null,
    enriched: false,
    genreId: genre.id,
    answerShape: genre.answerShape
  };
}

/**
 * Fills one genre's pool.
 *
 * Three network stages, in order of cost: the playlists (one unit per fifty), the
 * video facts (one unit per fifty), then the free enrichment. Nothing here is on
 * any room's critical path, so it is allowed to be slow; what it must not be is
 * wasteful, because the quota is shared by the whole deployment for a day.
 */
async function fillPool(genre: Genre): Promise<Pool> {
  const harvested: string[] = [];
  const thinSources: string[] = [];

  /**
   * Searches first, because they are what keeps a genre alive.
   *
   * Each is one `search.list`, so a genre with three queries costs three hundred
   * quota units to fill and then serves for a day. `musicOnly` pins the search to
   * YouTube's own Music category for the genres where that is meaningful, which
   * is most of the cheap quality here: without it "rock" returns documentaries
   * and "metal" returns metalworking.
   */
  const musicOnly = genre.section !== 'ecrans' && genre.section !== 'jeux';

  for (const query of genre.queries) {
    try {
      const ids = await searchVideos(query, { musicOnly });
      if (ids.length < 10) thinSources.push(`query:${query}`);
      harvested.push(...ids);
    } catch (error) {
      thinSources.push(`query:${query}`);
      if (!(error instanceof YoutubeError)) throw error;
    }
  }

  for (const source of genre.playlists ?? []) {
    try {
      const items = await fetchPlaylistItems(source.playlistId);
      if (items.length < 10) thinSources.push(source.playlistId);
      const start = Math.min(source.depth ?? 0, Math.max(0, items.length - 1));
      for (const item of items.slice(start)) {
        harvested.push(item.videoId);
      }
    } catch (error) {
      // One dead playlist must not empty a genre that has other sources.
      thinSources.push(source.playlistId);
      if (!(error instanceof YoutubeError)) throw error;
    }
  }

  const unique = [...new Set(harvested)].slice(0, MAX_POOL_ENTRIES * 2);
  const facts = unique.length > 0 ? await fetchVideoFacts(unique) : new Map<string, VideoFacts>();

  // Annotation is batched over everything that survived the cheap filters, so the
  // model sees one list per genre rather than one call per video.
  const surviving = [...facts.values()].filter(
    (fact) =>
      fact.durationSeconds !== null &&
      fact.durationSeconds >= MIN_DURATION_SECONDS &&
      fact.durationSeconds <= MAX_DURATION_SECONDS &&
      !NOT_A_SINGLE_WORK.test(fact.title)
  );

  const annotations = await annotateCandidates(
    surviving.map((fact) => ({ videoId: fact.videoId, title: fact.title, channel: fact.channel })),
    genre.answerShape,
    genre.label
  );

  // See toEntry: an empty result means no endpoint answered, which is a very
  // different thing from a model that read the list and kept none of it.
  const annotationRan = annotations.size > 0;

  const entries: PoolEntry[] = [];
  const byTrack = new Map<string, number>();

  for (const fact of surviving) {
    const entry = toEntry(fact, genre, annotations.get(fact.videoId), annotationRan);
    if (!entry) continue;

    /**
     * One recording, one entry, and when there is a choice the Topic upload wins.
     *
     * Not a tidiness rule. An auto-generated "Art Track" is the recording with
     * nothing round it, so its clock matches the lyrics and the chorus timing
     * becomes usable; a music video of the same song has a cold open and a skit
     * and drifts by up to a minute, which makes every lyric timestamp useless and
     * forces the window back to a blind convention. Preferring the Topic upload
     * is therefore the difference between a round that opens on the hook and one
     * that opens wherever thirty percent happens to land.
     */
    const existing = byTrack.get(entry.trackKey);
    if (existing !== undefined) {
      const incumbent = entries[existing];
      if (incumbent && !isTopic(incumbent.channel) && isTopic(entry.channel)) {
        entries[existing] = entry;
      }
      continue;
    }

    byTrack.set(entry.trackKey, entries.length);
    entries.push(entry);
    if (entries.length >= MAX_POOL_ENTRIES) break;
  }

  // Difficulty is a rank *within this pool*, so it can only be assigned once the
  // pool is known. Most viewed first, so rank 0 is the household name.
  entries.sort((left, right) => right.views - left.views);
  entries.forEach((entry, index) => {
    entry.difficulty = scoreDifficulty(index, entries.length, annotations.get(entry.videoId)?.difficulty ?? null);
  });

  /**
   * A pool that backs an era facet has its years checked now, not at draw time.
   *
   * `inEra` filters on `entry.year`, and until an entry is enriched that year is
   * YouTube's *publication* date: the day somebody uploaded the video. For a
   * Topic upload of a back catalogue that is the day the label bulk-loaded it, so
   * "Rap 90s" drawn from unenriched entries returns tracks published in 2015 and
   * silently omits every actual nineties record. The facet looked like it worked
   * and was wrong about its entire purpose.
   *
   * So the correction happens here, once a day, for the handful of pools that
   * need it, rather than after selection when it is far too late to filter on.
   * Bounded and serialised because MusicBrainz asks anonymous callers for about a
   * request a second and this is the one place that would otherwise flood it.
   */
  if (GENRES.some((other) => other.facetOf === genre.id)) {
    for (const entry of entries.slice(0, YEAR_CHECK_LIMIT)) {
      await enrich([entry]);
    }
  }

  return { entries, fetchedAt: Date.now(), thinSources };
}

/**
 * The pool for a genre, fetched if stale.
 *
 * Facets share their parent's pool rather than having one, which is what makes
 * "90s rap" free: it is a filter applied at draw time, not a second catalogue.
 */
/**
 * The pool if it is already in memory, without ever fetching one.
 *
 * Exists because filling is expensive enough that it must not happen inside a
 * request a browser is waiting on. A cold fill is several searches, a batch of
 * language model calls and, for a pool backing an era facet, eighty serialised
 * catalogue lookups: a minute or two, and a few hundred quota units. Doing that
 * for every genre a host ticks — "select all" is twenty — inside one HTTP call
 * would spend most of a day's quota and time the request out.
 *
 * So the counting endpoint reads what is there and asks for the rest in the
 * background. The number on screen fills in as the pools arrive.
 */
export function cachedPool(genreId: string): PoolEntry[] | null {
  const genre = genreById.get(genreId);
  if (!genre) return null;

  const pool = pools.get(sourceGenreFor(genre).id);
  if (!pool || Date.now() - pool.fetchedAt >= POOL_TTL_MS) return null;
  return pool.entries;
}

/**
 * Starts a fill without waiting for it, and without starting a second one.
 *
 * Deliberately returns nothing: every caller of this wants the pool *later*.
 */
export function warmPool(genreId: string, onError?: (error: unknown) => void): void {
  if (cachedPool(genreId) !== null) return;
  void poolFor(genreId).catch((error: unknown) => onError?.(error));
}

export async function poolFor(genreId: string): Promise<PoolEntry[]> {
  const genre = genreById.get(genreId);
  if (!genre) return [];

  const source = sourceGenreFor(genre);
  const key = source.id;

  const cached = pools.get(key);
  if (cached && Date.now() - cached.fetchedAt < POOL_TTL_MS) {
    return cached.entries;
  }

  const inFlight = filling.get(key);
  if (inFlight) return (await inFlight).entries;

  /**
   * A failed fill is cached too, briefly.
   *
   * Two opposite traps meet here and both are expensive. Caching a failure for
   * the full day leaves a genre reporting nothing until tomorrow with no way to
   * retry. Caching it not at all is worse: the setup screen polls every four
   * seconds while a pool is pending, and every one of those polls re-pays about
   * three hundred quota units of `search.list`, which drains a day's allowance
   * in a couple of minutes.
   *
   * So a fill that produced nothing is remembered for a few minutes: long enough
   * that polling costs one attempt rather than fifty, short enough that a passing
   * outage does not cost the evening.
   */
  const promise = fillPool(source)
    .then((pool) => {
      pools.set(key, pool.entries.length > 0 ? pool : { ...pool, fetchedAt: failureStamp() });
      return pool;
    })
    .catch((error: unknown) => {
      pools.set(key, { entries: [], fetchedAt: failureStamp(), thinSources: [String(error).slice(0, 200)] });
      return { entries: [], fetchedAt: failureStamp(), thinSources: [] } satisfies Pool;
    })
    .finally(() => filling.delete(key));

  filling.set(key, promise);
  return (await promise).entries;
}

/**
 * A `fetchedAt` that expires after `EMPTY_POOL_RETRY_MS` rather than the full TTL.
 *
 * Backdating the timestamp is how one cache expresses two lifetimes without
 * every reader having to know there are two.
 */
function failureStamp(): number {
  return Date.now() - (POOL_TTL_MS - EMPTY_POOL_RETRY_MS);
}

/**
 * Fills in the per-track detail: where the chorus is, what else it is called,
 * and when it actually came out.
 *
 * Deliberately not part of `fillPool`. A pool holds hundreds of entries and a
 * session plays a few dozen, so enriching all of them would mean hundreds of
 * requests to three free services for information most of which is never used.
 * The draw calls this for the handful it is about to serve, which is a few
 * requests during a round that is already playing, and the results are cached on
 * the pooled entry so a track drawn twice in an evening is looked up once.
 *
 * Three lookups run together per entry and all three are best-effort. A track
 * that comes back with nothing still plays; it simply plays from its genre's
 * profile rather than from its chorus, and accepts fewer spellings.
 */
export async function enrich(entries: PoolEntry[]): Promise<void> {
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.enriched) return;
      entry.enriched = true;

      if (entry.answerShape === 'artist-title' && entry.artist && entry.title) {
        const [chorus, catalogued] = await Promise.all([
          fetchChorus(entry.artist, entry.title),
          musicbrainzAliases(entry.artist, entry.title)
        ]);
        entry.chorus = chorus;
        if (catalogued) {
          // MusicBrainz returns names for the *artist*, so they go on the artist.
          entry.artistAliases = [...new Set([...entry.artistAliases, ...catalogued.aliases])];
          /**
           * The catalogue's release year wins over YouTube's.
           *
           * A YouTube publication date is when somebody uploaded the video, which
           * for a Topic upload of a back catalogue is the day the label bulk
           * loaded it. Trusting it puts half of the sixties in the 2010s and
           * makes every era facet wrong.
           */
          if (catalogued.year) {
            entry.year = catalogued.year;
            entry.yearVerified = true;
          }
        }
        return;
      }

      if (entry.answerShape === 'work' && entry.work) {
        const catalogued = await anilistAliases(entry.work);
        if (catalogued) {
          entry.workAliases = [...new Set([...entry.workAliases, ...catalogued.aliases])];
          if (catalogued.year) {
            entry.year = catalogued.year;
            entry.yearVerified = true;
          }
        }
      }
    })
  );
}

/** Whether YouTube can be reached at all. Surfaced so the UI can say why not. */
export function catalogAvailable(): boolean {
  return Boolean(env.GOOGLE_API_KEY);
}

/** Diagnostics for the setup screen and the logs. */
export function poolStatus(): { genreId: string; entries: number; ageMs: number; thinSources: string[] }[] {
  const now = Date.now();
  return [...pools.entries()].map(([genreId, pool]) => ({
    genreId,
    entries: pool.entries.length,
    ageMs: now - pool.fetchedAt,
    thinSources: pool.thinSources
  }));
}

/** Internals reachable from the tests, which is the only reason they are exported. */
export const __testing = { withoutArtistPrefix };
