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
import {
  THEME_PROFILE,
  VOCAL_PROFILE,
  fetchChorus,
  uploadKind,
  type ChorusInfo,
  type ClipProfile,
  type UploadKind
} from './chorus-service.js';
import { libraryVideoCodes } from './blindtest-library.js';
import { annotateCandidates, type Annotation } from './blindtest-llm.js';
import {
  ensureSeeds,
  genreOracle,
  markSearched,
  otherNames,
  unmarkSearched,
  planSeedSearches,
  trackOracleKey,
  type GenreOracle,
  type SeedSearch,
  type SeedSource
} from './blindtest-seeds.js';
import { spendSearch } from './youtube-budget.js';
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
   * The prompt over the answer box, for a genre answered by its work.
   *
   * One shared "film, series or game" covered all five of them and told the room
   * nothing: an anime opening was announced as maybe a film, maybe a game. The
   * genre already knows which of the five it is, so it says so.
   */
  workLabel?: string;
  /**
   * Where this genre's recognisable part tends to sit.
   *
   * Defaulted from the answer shape, because the two correlate strongly: a genre
   * answered by artist and track is sung and has a chorus to find, while a genre
   * answered by the work it comes from is usually instrumental and states its
   * theme early. Overridden where that correlation breaks down.
   */
  profile?: ClipProfile;
  /**
   * Where this genre's searches come from once it has any: real catalogues,
   * one entry per search, instead of the fixed `queries`. Those stay as the
   * fallback for a genre whose harvest failed. See `blindtest-seeds`.
   */
  seeds?: SeedSource[];
  /** Added to a work's name to find its music: "opening", "soundtrack". */
  seedSuffix?: string;
  /** The suffix inside each quoted name rather than once at the end. See `SeededGenre`. */
  seedSuffixInPhrase?: boolean;
  /** Whom to search first among a genre's artists. See `SeededGenre`. */
  artistWeight?: 'fame' | 'repertoire';
  /**
   * The prompts over an artist-title round's two boxes, when "artist" and
   * "title" are the wrong words: a classical round asks for the composer and
   * the piece. The keys stay `artist` and `title`, so everything that reads a
   * round (duplicates, corrections, the genre check) treats it like any song.
   */
  artistLabel?: string;
  titleLabel?: string;
  /**
   * What the model has to be told about this genre's answers in particular,
   * beyond its name. Only where the general instructions would read it wrong.
   */
  modelNote?: string;
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
  { id: 'monde', label: 'Musiques du monde' },
  { id: 'classique', label: 'Classique' }
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
    playlists: [{ playlistId: 'PL39z-AAkkatsDhv2Fkr-efPk34iQvtAHW' }],
    seeds: [
      {
        kind: 'deezer',
        playlistQueries: [
          'rap français',
          'rap fr classiques',
          'rap français années 2000',
          'rap français années 90',
          'rap fr 2010'
        ],
        titleMatch: /rap|hip[- ]?hop|drill|trap/i
      }
    ]
  },
  {
    id: 'rap-us',
    label: 'Rap US',
    section: 'rap',
    answerShape: 'artist-title',
    queries: ['hip hop classics official video', 'rap song official audio', '90s hip hop official video'],
    seeds: [
      {
        kind: 'deezer',
        playlistQueries: [
          'hip hop classics',
          'rap us',
          '90s hip hop',
          '2000s hip hop',
          '2010s rap',
          'hip hop essentials',
          'trap',
          'west coast rap',
          'old school hip hop',
          'rap hits'
        ],
        titleMatch: /rap|hip[- ]?hop|west coast|east coast|trap|drill|breakdance/i
      }
    ]
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
    queries: ['pop hits official video', 'pop song official audio', '2000s pop official video'],
    seeds: [
      {
        kind: 'deezer',
        playlistQueries: ['pop essentials', 'pop hits', '80s pop', '90s pop', '2000s pop', '2010s pop'],
        titleMatch: /pop|hits?\b/i
      }
    ]
  },
  {
    id: 'rock',
    label: 'Rock',
    section: 'pop-rock',
    answerShape: 'artist-title',
    queries: ['classic rock official video', 'rock anthem official audio', '90s rock official video'],
    seeds: [
      {
        kind: 'deezer',
        playlistQueries: ['rock essentials', 'rock classics', '70s rock', '80s rock', '90s rock', 'indie rock'],
        titleMatch: /rock|grunge|punk|indie/i
      }
    ]
  },
  {
    id: 'metal',
    label: 'Metal',
    section: 'pop-rock',
    answerShape: 'artist-title',
    queries: ['heavy metal official video', 'metal band official audio', 'thrash metal official video'],
    seeds: [
      {
        kind: 'deezer',
        playlistQueries: [
          'metal essentials',
          'metal',
          '80s metal',
          'nu metal',
          'metal français',
          'heavy metal',
          'thrash metal',
          'metalcore',
          'death metal',
          'power metal',
          'symphonic metal'
        ],
        titleMatch: /metal|core\b|heavy|thrash|hellfest/i
      }
    ]
  },

  /* --------------------------------------------------------------- chanson */
  {
    id: 'chanson-fr',
    label: 'Chanson française',
    section: 'chanson',
    answerShape: 'artist-title',
    queries: ['chanson française clip officiel', 'variété française titre officiel', 'chanson francaise classique'],
    seeds: [
      {
        kind: 'deezer',
        playlistQueries: [
          'chanson française',
          'variété française',
          'chanson française essentiels',
          'variété années 70',
          'chanson française années 80',
          'variété 2000',
          'chanson française années 60',
          'variété française 90',
          'chanson française années 90',
          'chanson française 2000',
          'nouvelle scène française',
          'chanteuses françaises',
          'variété française hits'
        ],
        titleMatch: /chanson|vari[ée]t[ée]|fran[çc]ais|france|bleu blanc/i
      }
    ]
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
    queries: ['electronic music official video', 'house music official audio', 'edm official video'],
    seeds: [
      {
        kind: 'deezer',
        playlistQueries: [
          'electro hits',
          'edm hits',
          'french touch',
          'house classics',
          'dance 90s',
          'techno essentials'
        ],
        titleMatch: /[ée]lectro|house|edm|techno|dance|french touch|club/i
      }
    ]
  },

  /* ----------------------------------------------------------------- anime */
  {
    id: 'anime-op',
    label: 'Openings',
    section: 'anime',
    answerShape: 'work',
    workLabel: 'field.work.animeOpening',
    queries: ['anime opening official', 'anime opening full', 'anime op creditless'],
    seeds: [{ kind: 'anilist' }],
    seedSuffix: 'opening',
    seedSuffixInPhrase: true,
    reject: /\b(amv|nightcore|cover|piano|8d|reaction)\b/i
  },
  {
    id: 'anime-ed',
    label: 'Endings',
    section: 'anime',
    answerShape: 'work',
    workLabel: 'field.work.animeEnding',
    queries: ['anime ending official', 'anime ending full'],
    seeds: [{ kind: 'anilist' }],
    seedSuffix: 'ending',
    seedSuffixInPhrase: true,
    reject: /\b(amv|nightcore|cover|piano|8d|reaction)\b/i
  },

  /* ---------------------------------------------------------------- écrans */
  {
    id: 'films-musique',
    label: 'Musiques de films',
    section: 'ecrans',
    answerShape: 'work',
    workLabel: 'field.work.film',
    queries: ['movie soundtrack main theme', 'film score official soundtrack', 'bande originale film thème'],
    seeds: [{ kind: 'wikidata', types: ['Q11424'], minLinks: 40, dateProperty: 'P577', requireComposer: true }],
    seedSuffix: 'soundtrack theme',
    reject: /\b(cover|piano tutorial|remix|reaction|epic music mix)\b/i
  },
  {
    id: 'series-tv',
    label: 'Génériques de séries',
    section: 'ecrans',
    answerShape: 'work',
    workLabel: 'field.work.series',
    queries: ['tv series opening theme', 'série générique officiel', 'tv show intro theme song'],
    seeds: [{ kind: 'wikidata', types: ['Q5398426', 'Q581714'], minLinks: 20, dateProperty: 'P580' }],
    seedSuffix: 'opening theme',
    reject: /\b(cover|reaction|fan made)\b/i
  },

  /* ------------------------------------------------------------------ jeux */
  {
    id: 'jeux-video',
    label: 'Musiques de jeux',
    section: 'jeux',
    answerShape: 'work',
    workLabel: 'field.work.game',
    queries: ['video game soundtrack main theme', 'game ost official', 'videogame music theme'],
    seeds: [{ kind: 'wikidata', types: ['Q7889'], minLinks: 20, dateProperty: 'P577' }],
    seedSuffix: 'OST theme',
    reject: /\b(cover|remix|piano tutorial|reaction|playthrough|gameplay)\b/i
  },

  /* ----------------------------------------------------------------- monde */
  {
    id: 'reggae',
    label: 'Reggae',
    section: 'monde',
    answerShape: 'artist-title',
    queries: ['reggae classics official video', 'reggae song official audio'],
    seeds: [
      {
        kind: 'deezer',
        playlistQueries: [
          'reggae essentials',
          'reggae classics',
          'roots reggae',
          'dancehall',
          'reggae français',
          'reggae',
          'ska',
          'dub',
          'reggae hits'
        ],
        titleMatch: /reggae|dancehall|dub\b|ska\b|roots/i
      }
    ]
  },
  {
    id: 'kpop',
    label: 'K-pop',
    section: 'monde',
    answerShape: 'artist-title',
    queries: ['kpop official mv', 'k-pop official music video'],
    seeds: [
      {
        kind: 'deezer',
        playlistQueries: [
          'kpop',
          'k-pop hits',
          'kpop essentials',
          'kpop girl groups',
          'kpop boy groups',
          'k-pop',
          'kpop hits',
          'kpop classics',
          'kpop 2010s',
          'kpop girl group',
          'kpop boy group',
          'kpop dance',
          'kpop ballad'
        ],
        titleMatch: /k-?pop/i
      }
    ]
  },

  /* ------------------------------------------------------------- classique */
  {
    id: 'classique',
    label: 'Musique classique',
    section: 'classique',
    answerShape: 'artist-title',
    artistLabel: 'field.composer',
    titleLabel: 'field.piece',
    // Instrumental: the theme states itself early and there are no lyrics to find a chorus in.
    profile: THEME_PROFILE,
    modelNote:
      'In this genre the ARTIST is the COMPOSER (Beethoven), never the orchestra, the conductor or the soloist. The answer is the piece by the name a French room knows it by ("La Lettre à Élise", "Symphonie n° 5", "Le Lac des cygnes"), without catalogue numbers, keys or movement numbers. Reject a compilation of several pieces.',
    queries: ['classical music masterpiece', 'musique classique célèbre', 'famous classical piece orchestra'],
    seeds: [{ kind: 'wikidata-compositions', minLinks: 8, bornBefore: 1915 }],
    artistWeight: 'repertoire'
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
  /**
   * The two other opinions `difficulty` is blended from, kept so the pool can
   * be re-ranked when an extension adds entries: the model's, and the fame of
   * the seed this entry matched, when it matched one.
   */
  modelDifficulty: number | null;
  seedFame: number | null;
  /**
   * The recording's length in seconds, when a catalogue says: the seed's, the
   * lyrics source's or MusicBrainz's, filled in that order. Against the video's
   * own length it says how much of the video is not the song.
   */
  trackSeconds: number | null;
  /** Topic track, audio upload or music video: which of them starts on the music. */
  upload: UploadKind;
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
  /** YouTube searches the fill spent. Decides how long an empty result is kept. */
  spent?: number;
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

/**
 * How long a fill that spent searches and still found nothing is remembered.
 *
 * Far longer than the five minutes above, because the retry is not free: a
 * fill with no model to annotate for it spends three searches and comes back
 * empty, and retried every five minutes that is the day's budget by lunch.
 * Nothing the retry could learn in five minutes is worth that.
 */
const FAILED_FILL_RETRY_MS = 60 * 60 * 1000;

/**
 * Searches kept back from the extensions for the daily fills.
 *
 * An extension is the endless mode's refill and a fill is a genre's whole day;
 * a room running five genres low used to spend the budget on extensions in
 * half an hour, and every pool that expired after that refilled with nothing.
 * Thirty is ten genres' worth of fills.
 */
const FILL_RESERVE = 30;

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

/**
 * When each pool was last asked for, so a fill nobody is waiting for can stop.
 *
 * Interest is re-expressed continuously by everything that could want a pool and
 * costs nothing to say: a live session asks `cachedPool` for every genre on every
 * draw, and the setup screen's count polls every four seconds. So silence here is
 * a real signal rather than an inference — nothing in the deployment wants this
 * genre any more.
 *
 * The point is the model calls. A cold fill annotates its survivors in batches of
 * twenty-five, one after another, and the endless blind test is what starts them:
 * a room that quits leaves a fill running that will spend several minutes of
 * somebody's API quota building a pool for a game that is over.
 */
const wantedAt = new Map<string, number>();

/**
 * How long a fill keeps going after the last time anybody asked for its pool.
 *
 * Comfortably longer than a round, because the ordinary rhythm of interest is one
 * draw per round: the gap between two asks is the length of a song, not of an
 * evening. Short enough that a fill outlives the room that wanted it by one batch
 * or two rather than by its whole remaining length.
 */
const FILL_ABANDON_MS = 90_000;

/** Says somebody still wants this pool. Cheap, and called from every reader. */
function noteWanted(key: string): void {
  wantedAt.set(key, Date.now());
}

/** Thrown by a fill that gave up because nothing was waiting for it any more. */
class PoolAbandoned extends Error {
  constructor(key: string) {
    super(`pool fill abandoned: nothing has asked for "${key}" in ${FILL_ABANDON_MS}ms`);
    this.name = 'PoolAbandoned';
  }
}

/* ------------------------------------------------------------------ helpers */

/** Which upload wins when a recording turns up twice. Lower is better. */
const UPLOAD_RANK: Record<UploadKind, number> = { topic: 0, audio: 1, video: 2 };

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
 *
 * A matched seed adds a third opinion: its rank in a catalogue's own popularity
 * figures, which knows a famous song from a famous upload. Weighted like the
 * model's, and absent for a deep cut the catalogue never listed.
 */
function scoreDifficulty(rank: number, total: number, annotated: number | null, seedFame: number | null): number {
  // 0 for the most viewed in the pool, 100 for the least.
  const byViews = total <= 1 ? 50 : Math.round((rank / (total - 1)) * 100);
  let sum = byViews * 3;
  let weight = 3;
  if (annotated !== null) {
    sum += annotated * 2;
    weight += 2;
  }
  if (seedFame !== null) {
    sum += (1 - seedFame) * 100 * 2;
    weight += 2;
  }
  return Math.round(sum / weight);
}

/** Difficulty is a rank within the pool, so it is assigned to the whole pool at once. */
function rankDifficulty(entries: PoolEntry[]): void {
  // Most viewed first, so rank 0 is the household name.
  entries.sort((left, right) => right.views - left.views);
  entries.forEach((entry, index) => {
    entry.difficulty = scoreDifficulty(index, entries.length, entry.modelDifficulty, entry.seedFame);
  });
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
  annotationRan: boolean,
  /**
   * What the genre's seeds know, or null for a genre without any.
   *
   * It overrules the model on one question, whether an *artist* belongs to this
   * genre, and only in one direction: an artist Deezer's rap editors list is a
   * rap artist even when the model hesitates. An answer the seeds do not know
   * still has to pass the model's own judgement, as before.
   *
   * Never for a work. There the model's "does not fit" is about the clip, not
   * the work: a scene from an anime AniList knows well is still not its
   * opening, and a live search returned a pool's worth of exactly those.
   */
  oracle: GenreOracle | null = null
): PoolEntry | null {
  const rawTitle = facts.title;

  if (NOT_A_SINGLE_WORK.test(rawTitle)) return null;
  if (genre.reject?.test(rawTitle)) return null;
  if (facts.durationSeconds === null) return null;
  if (facts.durationSeconds < MIN_DURATION_SECONDS || facts.durationSeconds > MAX_DURATION_SECONDS) return null;

  // The model gets the last word on whether this is answerable at all: it is the
  // only thing that can tell a montage from a track by reading the title.
  if (annotation?.kind === 'reject') return null;
  /**
   * And on whether it belongs here, unless the seeds already know.
   *
   * YouTube search has no notion of genre below its Music category, so a query
   * for rap returns pop, and only something that recognises the artist can say
   * so. Decided below, once the answer is known, because the seeds are keyed by
   * the answer.
   */
  const judgedOutOfGenre = annotation?.fitsGenre === false;

  let artist = '';
  let title = '';
  let work = '';
  let seedFame: number | null = null;
  let trackSeconds: number | null = null;
  let seedNames: string[] = [];
  let seedYear: number | null = null;

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

    /**
     * Only an editor's list may overrule the model on fit.
     *
     * Deezer's genre editors put an artist on a rap playlist because they are a
     * rap artist. Wikidata's composers are anybody with the occupation, which
     * includes the woman who wrote "Happy Birthday": a list that good for
     * choosing whom to search is not one to keep a pop song in a classical
     * round against the model's judgement.
     */
    const artistKey = normalizeAnswer(artist);
    const editorsVouch = genre.seeds?.some((source) => source.kind === 'deezer') ?? false;
    const knownArtist = Boolean(editorsVouch && oracle?.artists.has(artistKey) && !oracle.contested.has(artistKey));
    if (judgedOutOfGenre && !knownArtist) return null;
    const seedTrack = oracle?.tracks.get(trackOracleKey(artist, title));
    seedFame = seedTrack?.fame ?? null;
    trackSeconds = seedTrack?.duration ?? null;
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

    /**
     * A work the seeds know brings its other names with it.
     *
     * The model answers in French where it can ("L'Attaque des Titans"), the
     * room types whatever it grew up with, and the seed has the rest as facts:
     * AniList's romaji and English titles, Wikidata's labels. Those are safe to
     * accept in a way the model's own alias guesses never were.
     */
    if (judgedOutOfGenre) return null;
    const seedWork = oracle?.works.get(normalizeAnswer(work));
    if (seedWork) {
      seedFame = seedWork.fame;
      seedNames = seedWork.names;
      seedYear = seedWork.year;
    }
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
    workAliases:
      genre.answerShape === 'work' ? otherNames(work, [...(annotation?.aliases ?? []), ...seedNames], 12) : [],
    // A catalogue's year is a release year, which the upload date is not.
    year: seedYear ?? facts.year,
    yearVerified: seedYear !== null,
    views: facts.views,
    durationSeconds: facts.durationSeconds,
    channel: facts.channel,
    restriction: facts.restriction,
    difficulty: 50,
    modelDifficulty: annotation?.difficulty ?? null,
    seedFame,
    trackSeconds,
    upload: uploadKind(facts.channel, rawTitle),
    hintFraction: annotation?.hookFraction ?? null,
    chorus: null,
    enriched: false,
    genreId: genre.id,
    answerShape: genre.answerShape
  };
}

/** One YouTube search, and what it was aimed at. */
interface SearchStep {
  query: string;
  limit: number;
  /** Set when the search is aimed at seeds rather than a fixed query. */
  seed?: SeedSearch;
  /** How `thinSources` names it. */
  label: string;
}

/**
 * Searches per daily fill: the same three the fixed queries cost, now aimed at
 * seeds nobody has searched yet.
 */
const FILL_SEARCHES = 3;

/** Searches per extension. Small, because an extension repeats as needed. */
const EXTEND_SEARCHES = 1;

/**
 * What to search for.
 *
 * Seeds when the genre has them, harvesting first if its stock is due. The
 * fixed queries only when there are none, because a fixed query is exactly
 * what ran dry: the same fifty videos, every day. An extension never falls back
 * to them for that reason; it would only find the fill's results again.
 */
async function searchPlan(
  genre: Genre,
  searches: number,
  options: { window?: { min: number; max: number }; allowFixed: boolean }
): Promise<SearchStep[]> {
  if (genre.seeds && genre.seeds.length > 0) {
    await ensureSeeds(genre).catch(() => undefined);
    const planned = planSeedSearches(genre, searches, options.window);
    if (planned.length > 0) {
      return planned.map((seed) => ({ query: seed.query, limit: seed.limit, seed, label: `seeds:${seed.hint}` }));
    }
  }
  if (!options.allowFixed) return [];
  return genre.queries.map((query) => ({ query, limit: 50, label: `query:${query}` }));
}

/**
 * Searches, looks up and annotates, and returns the candidates as entries.
 *
 * Shared by the daily fill and by an extension, which differ only in how many
 * searches they make and what they already hold. Three network stages, in
 * order of cost: the searches (a hundred units each, budgeted), the video facts
 * (one unit per fifty), then the model. Nothing here is on any room's critical
 * path, so it is allowed to be slow; what it must not be is wasteful.
 */
async function buildEntries(
  genre: Genre,
  steps: SearchStep[],
  extraIds: string[],
  exclude: { videoIds: ReadonlySet<string>; trackKeys: ReadonlySet<string> },
  checkpoint: () => void,
  /** The day's searches this run may take the count up to. See `FILL_RESERVE`. */
  budget: number = env.BLINDTEST_SEARCH_BUDGET
): Promise<{
  entries: PoolEntry[];
  thinSources: string[];
  spent: number;
  /** Whether a model read the candidates, and how many there were to read. */
  annotated: boolean;
  candidates: number;
  /** The seed searches that ran, so a caller that discards the result can hand them back. */
  searched: SeedSearch[];
}> {
  const harvested: string[] = [];
  const thinSources: string[] = [];
  /** Which search found each video, for the hint the model is given. */
  const origin = new Map<string, SearchStep>();
  const ran: SeedSearch[] = [];
  let spent = 0;

  for (const step of steps) {
    checkpoint();
    if (!spendSearch(budget)) {
      thinSources.push('budget: the daily YouTube search budget is spent');
      break;
    }
    /**
     * `musicOnly` pins the search to YouTube's own Music category for the genres
     * where that is meaningful, which is most of the cheap quality here: without
     * it "rock" returns documentaries and "metal" returns metalworking.
     *
     * Not for a search aimed at works. Tried on the live API, four anime by
     * their English names inside the Music category returned nothing at all:
     * the official openings under those names are Crunchyroll's, filed as film
     * and animation, and the Music uploads are titled in Japanese.
     */
    const musicOnly =
      genre.section !== 'ecrans' && genre.section !== 'jeux' && !(step.seed && genre.answerShape === 'work');
    try {
      const ids = await searchVideos(step.query, { musicOnly, limit: step.limit });
      if (ids.length < 10) thinSources.push(step.label);
      for (const id of ids) {
        harvested.push(id);
        if (!origin.has(id)) origin.set(id, step);
      }
      // Spent the moment it ran: the quota is gone whatever the model makes of
      // the results, and a seed searched twice is a hundred units for nothing.
      if (step.seed) {
        markSearched(step.seed, ids.length);
        ran.push(step.seed);
      }
      spent += 1;
    } catch (error) {
      thinSources.push(step.label);
      if (!(error instanceof YoutubeError)) throw error;
    }
  }
  harvested.push(...extraIds);

  /**
   * And nothing the shared catalogue already holds.
   *
   * The draw would never serve those (a search exists to find something new,
   * and `drawRounds` skips a catalogued video), so annotating them was model
   * time spent on candidates that could only ever be thrown away. Once the
   * catalogue ran to hundreds of rounds that was most of every fill.
   */
  const catalogued = await libraryVideoCodes().catch(() => new Set<string>());
  const unique = [...new Set(harvested)]
    .filter((id) => !catalogued.has(id) && !exclude.videoIds.has(id))
    .slice(0, MAX_POOL_ENTRIES * 2);
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
    surviving.map((fact) => ({
      videoId: fact.videoId,
      title: fact.title,
      channel: fact.channel,
      hint: origin.get(fact.videoId)?.seed?.hint
    })),
    genre.answerShape,
    // "Japanimation / Openings" rather than "Openings": the model judges fit
    // against this name, and the bare one does not say openings of what.
    `${SECTIONS.find((section) => section.id === genre.section)?.label ?? genre.section} / ${genre.label}`,
    checkpoint,
    genre.modelNote
  );

  // See toEntry: an empty result means no endpoint answered, which is a very
  // different thing from a model that read the list and kept none of it.
  const annotationRan = annotations.size > 0;

  /**
   * No model answered, so a work genre can use none of this: hand the seeds back.
   *
   * A work answer comes from the model or not at all (see `toEntry`), so a run
   * with every endpoint down produced nothing and still spent its seeds, each
   * marked searched and never tried again for a month. The searches are gone
   * either way; the seeds need not be.
   */
  if (genre.answerShape === 'work' && surviving.length > 0 && !annotationRan) {
    for (const seed of ran) unmarkSearched(seed);
  }

  const oracle =
    genre.seeds && genre.seeds.length > 0
      ? genreOracle(genre.id, (other) => genreById.get(other)?.section === genre.section)
      : null;

  const entries: PoolEntry[] = [];
  const byTrack = new Map<string, number>();

  for (const fact of surviving) {
    const entry = toEntry(fact, genre, annotations.get(fact.videoId), annotationRan, oracle);
    if (!entry || exclude.trackKeys.has(entry.trackKey)) continue;

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
      // Topic first, then an audio upload, then a music video: the order in which
      // they start on the music rather than on a scene.
      if (incumbent && UPLOAD_RANK[entry.upload] < UPLOAD_RANK[incumbent.upload]) {
        entries[existing] = entry;
      }
      continue;
    }

    byTrack.set(entry.trackKey, entries.length);
    entries.push(entry);
    if (entries.length >= MAX_POOL_ENTRIES) break;
  }

  return { entries, thinSources, spent, annotated: annotationRan, candidates: surviving.length, searched: ran };
}

/**
 * One seed search, straight into rounds for the catalogue.
 *
 * For the overnight prefill (see `blindtest-prefill`), which spends the day's
 * unused searches on the catalogue instead of letting them lapse. Returns null
 * when the genre has nothing left to search.
 *
 * Stricter than a fill in one way. With no model to read the titles, a fill
 * still makes rounds for a music genre by splitting "Artist - Title", which is
 * a fair fallback for a pool that lives a day and a poor thing to file for good.
 * So a run the model did not read keeps nothing, and hands its seeds back.
 *
 * Difficulty is not a rank here: a rank among one search's results says
 * nothing. The model's opinion and the seed's fame decide it, around the middle.
 */
export async function searchForCatalogue(
  genre: Genre,
  budget: number
): Promise<{ entries: PoolEntry[]; spent: number; modelDown: boolean } | null> {
  const steps = await searchPlan(genre, 1, { allowFixed: false });
  if (steps.length === 0) return null;

  const built = await buildEntries(genre, steps, [], { videoIds: new Set(), trackKeys: new Set() }, () => {}, budget);
  const modelDown = built.candidates > 0 && !built.annotated;
  if (modelDown) {
    for (const seed of built.searched) unmarkSearched(seed);
    return { entries: [], spent: built.spent, modelDown };
  }

  for (const entry of built.entries) {
    entry.difficulty = scoreDifficulty(0, 1, entry.modelDifficulty, entry.seedFame);
  }
  return { entries: built.entries, spent: built.spent, modelDown };
}

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
async function verifyYears(genre: Genre, entries: PoolEntry[], checkpoint: () => void): Promise<void> {
  if (!GENRES.some((other) => other.facetOf === genre.id)) return;
  for (const entry of entries.slice(0, YEAR_CHECK_LIMIT)) {
    // Eighty serialised lookups at roughly a second each: the same reason the
    // annotation can be cut short applies here, for the same abandoned room.
    checkpoint();
    await enrich([entry]);
  }
}

/**
 * Stops a run if nothing has asked for this pool in a while.
 *
 * Throwing rather than returning what has been annotated so far, because a
 * partial annotation is the one outcome that must not be kept: every candidate
 * the model never reached would be dropped by `toEntry`, and the short pool
 * that resulted would be cached as this genre's pool for the next twenty-four
 * hours. `poolFor` turns the throw into the brief cache a failed fill gets, so
 * the next room to ask for the genre starts a fresh, whole fill.
 */
function checkpointFor(key: string): () => void {
  return () => {
    const last = wantedAt.get(key) ?? 0;
    if (Date.now() - last > FILL_ABANDON_MS) throw new PoolAbandoned(key);
  };
}

/**
 * Fills one genre's pool.
 *
 * The searches first, then the configured playlists, which are nearly free
 * (one unit per fifty) and add whatever a curator put there.
 */
async function fillPool(genre: Genre): Promise<Pool> {
  const checkpoint = checkpointFor(genre.id);
  const steps = await searchPlan(genre, FILL_SEARCHES, { allowFixed: true });
  /**
   * The abandonment clock starts once the searches are ready.
   *
   * `searchPlan` may have waited on a genre's first harvest, which is a minute
   * or two nobody chose (AniList alone is forty paced pages), and the clock
   * counted it: a quick match that warmed its genre once found the fill
   * abandoned at its first checkpoint and the pool cached empty.
   */
  noteWanted(genre.id);

  const thinSources: string[] = [];
  const playlistIds: string[] = [];
  for (const source of genre.playlists ?? []) {
    try {
      const items = await fetchPlaylistItems(source.playlistId);
      if (items.length < 10) thinSources.push(source.playlistId);
      const start = Math.min(source.depth ?? 0, Math.max(0, items.length - 1));
      for (const item of items.slice(start)) {
        playlistIds.push(item.videoId);
      }
    } catch (error) {
      // One dead playlist must not empty a genre that has other sources.
      thinSources.push(source.playlistId);
      if (!(error instanceof YoutubeError)) throw error;
    }
  }

  const built = await buildEntries(
    genre,
    steps,
    playlistIds,
    { videoIds: new Set(), trackKeys: new Set() },
    checkpoint
  );
  thinSources.push(...built.thinSources);

  // Difficulty is a rank *within this pool*, so it can only be assigned once the
  // pool is known.
  rankDifficulty(built.entries);
  await verifyYears(genre, built.entries, checkpoint);

  return { entries: built.entries, fetchedAt: Date.now(), thinSources, spent: built.spent };
}

/* ------------------------------------------------------------- extensions */

/** Extensions in flight, one per pool. */
const extending = new Map<string, Promise<void>>();
/** When each pool was last extended, so a dry genre is not searched every round. */
const extendedAt = new Map<string, number>();

/**
 * How often a pool may be extended.
 *
 * A search costs a hundred of the day's ten thousand units, and a room
 * draining a pool asks on every round. Once every minute and a half keeps an
 * evening fed (an extension brings several rounds) without letting one genre
 * spend the day's budget in an hour.
 */
const EXTEND_COOLDOWN_MS = 90_000;

/** Past this a pool has plenty, and a room asking for more is asking for a filter. */
const MAX_EXTENDED_POOL = MAX_POOL_ENTRIES * 2;

/**
 * And across every genre, one extension at a time per this gap.
 *
 * The cooldown above is per genre, so a room with five genres running low
 * spent five searches every ninety seconds. This caps the whole deployment.
 */
const EXTEND_GLOBAL_GAP_MS = 60_000;
let lastExtensionAt = 0;

/**
 * How long a genre is left alone after an extension that added nothing.
 *
 * Usually a narrow difficulty window that the new seeds fell outside, or a
 * genre whose seeds are spent; asking again every ninety seconds would only
 * spend searches on the same answer.
 */
const FRUITLESS_EXTENSION_BACKOFF_MS = 15 * 60 * 1000;

/**
 * Searches a few more seeds into a live pool, in the background.
 *
 * The daily fill used to be all a genre got until tomorrow. A room that played
 * through its pool in an evening was left with the catalogue's replays and
 * then nothing; this is what makes the endless mode endless. The draw calls it
 * when a genre it is dealing from runs low, and it adds to the pool in place,
 * so the next draw simply has more to choose from.
 *
 * `window` is the room's difficulty window, which steers which seeds are
 * searched: a room asking for hard rounds gets lesser-known artists searched
 * for it rather than more household names it will filter out.
 */
export function extendPool(genreId: string, window?: { min: number; max: number }): void {
  const genre = genreById.get(genreId);
  if (!genre) return;
  const source = sourceGenreFor(genre);
  const key = source.id;

  if (!source.seeds || source.seeds.length === 0) return;
  const pool = pools.get(key);
  // No pool, or a stale one: a fill is what it needs, and `warmPool` starts it.
  if (!pool || pool.entries.length === 0 || Date.now() - pool.fetchedAt >= POOL_TTL_MS) return;
  if (pool.entries.length >= MAX_EXTENDED_POOL) return;
  if (filling.has(key) || extending.has(key)) return;
  if (Date.now() - (extendedAt.get(key) ?? 0) < EXTEND_COOLDOWN_MS) return;
  if (Date.now() - lastExtensionAt < EXTEND_GLOBAL_GAP_MS) return;
  extendedAt.set(key, Date.now());
  lastExtensionAt = Date.now();

  const checkpoint = checkpointFor(key);
  const run = (async () => {
    const steps = await searchPlan(source, EXTEND_SEARCHES, { window, allowFixed: false });
    if (steps.length === 0) return;

    const built = await buildEntries(
      source,
      steps,
      [],
      {
        videoIds: new Set(pool.entries.map((entry) => entry.videoId)),
        trackKeys: new Set(pool.entries.map((entry) => entry.trackKey))
      },
      checkpoint,
      Math.max(0, env.BLINDTEST_SEARCH_BUDGET - FILL_RESERVE)
    );
    if (built.entries.length === 0) {
      // Pushed into the future so the cooldown check keeps failing for the back-off.
      extendedAt.set(key, Date.now() + FRUITLESS_EXTENSION_BACKOFF_MS);
      return;
    }
    await verifyYears(source, built.entries, checkpoint);

    // Replaced by a fresh fill while this was out: that pool has its own.
    if (pools.get(key) !== pool) return;
    const known = new Set(pool.entries.map((entry) => entry.trackKey));
    pool.entries.push(...built.entries.filter((entry) => !known.has(entry.trackKey)));
    rankDifficulty(pool.entries);
  })()
    .catch(() => undefined)
    .finally(() => extending.delete(key));

  extending.set(key, run);
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

  const key = sourceGenreFor(genre).id;
  // Asking is wanting, whatever the answer turns out to be: a draw that finds the
  // pool missing wants it most of all, and that is the ask a running fill listens
  // for. See `wantedAt`.
  noteWanted(key);

  const pool = pools.get(key);
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
  noteWanted(key);

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
      // An empty fill that spent searches is kept longer; see `FAILED_FILL_RETRY_MS`.
      const retry = (pool.spent ?? 0) > 0 ? FAILED_FILL_RETRY_MS : EMPTY_POOL_RETRY_MS;
      pools.set(key, pool.entries.length > 0 ? pool : { ...pool, fetchedAt: failureStamp(retry) });
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
 * A `fetchedAt` that expires after `retryMs` rather than the full TTL.
 *
 * Backdating the timestamp is how one cache expresses two lifetimes without
 * every reader having to know there are two.
 */
function failureStamp(retryMs: number = EMPTY_POOL_RETRY_MS): number {
  return Date.now() - (POOL_TTL_MS - retryMs);
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
        // No lyrics, so no chorus to find: an instrumental genre skips the lookup
        // and plays from its profile and the model's estimate of the theme.
        const genre = genreById.get(entry.genreId);
        const sung = !genre || profileFor(genre) !== THEME_PROFILE;
        const [chorus, catalogued] = await Promise.all([
          sung ? fetchChorus(entry.artist, entry.title) : Promise.resolve(null),
          musicbrainzAliases(entry.artist, entry.title)
        ]);
        entry.chorus = chorus;
        // The recording's length, for keeping the clip inside the music, when the
        // seed did not give one. (`clipWindow` prefers the lyrics source's own
        // anyway when it shifts the chorus timings, since those belong to it.)
        entry.trackSeconds ??= chorus?.trackDuration ?? catalogued?.durationSeconds ?? null;
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

      /**
       * AniList for anime only.
       *
       * It used to be asked about every work, and it answers whatever it is
       * asked: a search for a film or a game returns the nearest anime, whose
       * titles then became accepted answers and whose year filed the film under
       * the wrong decade. Films, series and games get theirs from their seeds.
       */
      if (entry.answerShape === 'work' && entry.work && genreById.get(entry.genreId)?.section === 'anime') {
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
export const __testing = { withoutArtistPrefix, toEntry, scoreDifficulty };
