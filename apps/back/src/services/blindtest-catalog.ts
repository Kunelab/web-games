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
import { and, eq, isNull, sql } from 'drizzle-orm';
import { normalizeAnswer, splitArtistTitle, type BlindtestFame } from 'game-core';

import type { Clock } from '../clock.js';
import type { Db } from '../db/open.js';
import { blindtestCalibration, media } from '../db/schema.js';
import { env } from '../env.js';
import type { AliasLookup } from './blindtest-aliases.js';
import {
  resolveCalibration,
  scoreDifficulty,
  type Calibration,
  type CalibrationKey,
  type FameAudience,
  type Scale
} from './blindtest-difficulty.js';
import {
  animeThemeFor,
  lookupFame,
  themeSlotOf,
  type FameFacts,
  type FameSources,
  type WorkKind
} from './blindtest-fame.js';
import {
  ANIME_THEME_PROFILE,
  FILM_SCORE_PROFILE,
  GAME_THEME_PROFILE,
  SERIES_THEME_PROFILE,
  THEME_PROFILE,
  VOCAL_PROFILE,
  uploadKind,
  type ChorusInfo,
  type ClipProfile,
  type UploadKind
} from './chorus-service.js';
import type { Annotation, Candidate } from './blindtest-llm.js';
import {
  createSeedStock,
  otherNames,
  trackOracleKey,
  type GenreOracle,
  type SeedIndex,
  type SeedSearch,
  type SeedSource,
  type SeedSources,
  type SeedStats
} from './blindtest-seeds.js';
import { quotaDay, searchesOn, spendSearch } from './youtube-budget.js';
import { YoutubeError, type VideoFacts, type YoutubePlaylistItem } from './youtube-service.js';

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
  /**
   * Whose fame makes a round easy: `fr` for the French genres, where a rapper
   * famous in France and unknown abroad is a household name to the room.
   * Everywhere else French or worldwide fame counts, whichever is higher. See
   * `blindtest-difficulty`.
   */
  fameAudience?: FameAudience;
  /** What a work genre's answers are, for looking their fame up. */
  workKind?: WorkKind;
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
    fameAudience: 'fr',
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
    fameAudience: 'fr',
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
    workKind: 'anime',
    profile: ANIME_THEME_PROFILE,
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
    workKind: 'anime',
    profile: ANIME_THEME_PROFILE,
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
    workKind: 'film',
    profile: FILM_SCORE_PROFILE,
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
    workKind: 'series',
    profile: SERIES_THEME_PROFILE,
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
    workKind: 'game',
    profile: GAME_THEME_PROFILE,
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

/** Whose fame counts in this genre; a facet's is its parent's. */
export function audienceOf(genre: Genre): FameAudience {
  return sourceGenreFor(genre).fameAudience ?? 'any';
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
  /** 0 (household name) to 100 (deep cut). See `blindtest-difficulty`. */
  difficulty: number;
  /**
   * What `difficulty` is scored from besides the views: the model's opinion and
   * whether it knew the answer at all, the fame of the seed this entry matched
   * when it matched one, and what the outside catalogues said, once `enrich`
   * has asked them.
   */
  modelDifficulty: number | null;
  recognised: boolean | null;
  seedFame: number | null;
  fame: FameFacts | null;
  /** The Wikidata item of the work's seed, when it came from Wikidata. */
  seedWikidataId: string | null;
  /**
   * For a work, the song its clip plays, when the model read it off the title.
   * A sung theme then has its chorus found like any song's. Empty otherwise.
   */
  song: string;
  songArtist: string;
  /** The video's own title, which says which opening it is ("OP 3"). */
  videoTitle: string;
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

/**
 * How long a fill keeps going after the last time anybody asked for its pool.
 *
 * Comfortably longer than a round, because the ordinary rhythm of interest is one
 * draw per round: the gap between two asks is the length of a song, not of an
 * evening. Short enough that a fill outlives the room that wanted it by one batch
 * or two rather than by its whole remaining length.
 */
const FILL_ABANDON_MS = 90_000;

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
 * Everything an entry's difficulty is scored from, in the shape a catalogue
 * row keeps it.
 *
 * The difficulty used to be a rank of the views within one pool, which said
 * how an upload did against whatever else one search returned: a band nobody
 * has heard of could top a small pool and be dealt as easy. It is now scored
 * from what the catalogues know, against the genre's own spread; see
 * `blindtest-difficulty`. Until `enrich` has asked them, the views, the model
 * and the seed's rank stand in.
 */
export function fameOf(entry: PoolEntry): BlindtestFame {
  return fameFromFacts(entry.fame, {
    views: entry.views,
    upload: entry.upload,
    seedFame: entry.seedFame,
    model: entry.modelDifficulty,
    recognised: entry.recognised
  });
}

/** The catalogues' facts and the round's own figures, as one record. */
export function fameFromFacts(
  facts: FameFacts | null,
  own: Pick<BlindtestFame, 'views' | 'upload' | 'seedFame' | 'model' | 'recognised'>
): BlindtestFame {
  return {
    ...own,
    deezerRank: facts?.deezerRank ?? null,
    deezerFans: facts?.deezerFans ?? null,
    lastfmListeners: facts?.lastfmListeners ?? null,
    wikiLanguages: facts?.wikiLanguages ?? null,
    frPageviews: facts?.frPageviews ?? null,
    enPageviews: facts?.enPageviews ?? null,
    anilistMembers: facts?.anilistMembers ?? null,
    tmdbVotes: facts?.tmdbVotes ?? null,
    looked: facts !== null,
    ...(facts && Object.keys(facts.ids).length > 0 ? { ids: facts.ids } : {})
  };
}

/**
 * The song a work's clip plays, when it can be told.
 *
 * The one the model read off the video's title first, then the anime theme the
 * title names by its slot ("OP 3"), then a series' theme song as Wikidata has
 * it. A sung theme placed from its lyrics lands on its chorus; without them the
 * window is placed by the genre's convention, which is a guess.
 */
export function themeSongOf(
  entry: Pick<PoolEntry, 'song' | 'songArtist' | 'videoTitle' | 'fame'>,
  genre: Genre
): { title: string; artist: string } | null {
  if (entry.song && entry.songArtist) return { title: entry.song, artist: entry.songArtist };
  const themes = entry.fame?.themes;
  if (themes && themes.length > 0) {
    const theme = animeThemeFor(themes, themeSlotOf(entry.videoTitle), genre.id === 'anime-ed' ? 'ED' : 'OP');
    const artist = theme?.artists[0];
    if (theme && artist) return { title: theme.song, artist };
  }
  return entry.fame?.themeSong ?? null;
}

/** Each genre's spread as the rescoring script last fitted it. See `BlindtestCalibration`. */
export function readCalibrations(db: Db): Map<string, Partial<Record<CalibrationKey, Scale>>> {
  const fitted = new Map<string, Partial<Record<CalibrationKey, Scale>>>();
  for (const row of db.select().from(blindtestCalibration).all()) {
    const scales = fitted.get(row.genre_id) ?? {};
    scales[row.signal as CalibrationKey] = { mean: row.mean, sd: row.sd };
    fitted.set(row.genre_id, scales);
  }
  return fitted;
}

/** Replaces every stored spread with these, in one transaction. */
export function writeCalibrations(
  db: Db,
  fitted: ReadonlyMap<string, Partial<Record<CalibrationKey, Scale & { samples?: number }>>>,
  now: Date = new Date()
): void {
  db.transaction((tx) => {
    tx.delete(blindtestCalibration).run();
    for (const [genreId, scales] of fitted) {
      for (const [signal, scale] of Object.entries(scales)) {
        if (!scale) continue;
        tx.insert(blindtestCalibration)
          .values({
            genre_id: genreId,
            signal,
            mean: scale.mean,
            sd: scale.sd,
            samples: scale.samples ?? 0,
            fitted_at: now.toISOString()
          })
          .run();
      }
    }
  });
}

/** How often a running server reads the spreads again, so a rescoring reaches it. */
const CALIBRATION_TTL_MS = 10 * 60 * 1000;

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
  let seedWikidataId: string | null = null;

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
      seedWikidataId = seedWork.wikidataId ?? null;
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
    // Scored once the pool is known, against its genre's spread; see `rescore`.
    difficulty: 50,
    modelDifficulty: annotation?.difficulty ?? null,
    recognised: annotation?.recognised ?? null,
    seedFame,
    fame: null,
    seedWikidataId,
    song: annotation?.song ?? '',
    songArtist: annotation?.songArtist ?? '',
    videoTitle: rawTitle,
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

/* ------------------------------------------------------------- extensions */

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

/**
 * How long a genre is left alone after an extension that added nothing.
 *
 * Usually a narrow difficulty window that the new seeds fell outside, or a
 * genre whose seeds are spent; asking again every ninety seconds would only
 * spend searches on the same answer.
 */
const FRUITLESS_EXTENSION_BACKOFF_MS = 15 * 60 * 1000;

/* ---------------------------------------------------------------- the seam */

/**
 * Everything the catalogue asks of the outside world, one function per request.
 *
 * The catalogue's only way out: no fetch happens anywhere else in it. The
 * production sources are `httpSources` in `blindtest-sources`; a test hands it
 * a fake world instead, and the catalogue cannot tell.
 */
export interface CatalogueSources {
  youtube: {
    /** `search.list`, the hundred-unit call: up to `limit` video ids. Throws `YoutubeError`. */
    search(query: string, options: { musicOnly: boolean; limit: number }): Promise<string[]>;
    /** `videos.list` over any number of ids. An id YouTube does not return is absent. Throws `YoutubeError`. */
    facts(videoIds: string[]): Promise<Map<string, VideoFacts>>;
    /** Every item of a playlist. Throws `YoutubeError`. */
    playlist(playlistId: string): Promise<YoutubePlaylistItem[]>;
  };
  /** The seed catalogues: Deezer, AniList and Wikidata. See `blindtest-seeds`. */
  seeds: SeedSources;
  /** Where a track's chorus lands, from its synced lyrics. Null for none; never throws. */
  lyrics(artist: string, title: string): Promise<ChorusInfo | null>;
  /** Other names and the real release year, from catalogues that hold them as facts. Never throws. */
  aliases: {
    musicbrainz(artist: string, title: string): Promise<AliasLookup | null>;
    anilist(work: string): Promise<AliasLookup | null>;
  };
  /** How famous an answer is: Deezer, Wikipedia, Last.fm, AniList, TMDB. See `blindtest-fame`. */
  fame: FameSources;
  /**
   * A model's reading of each candidate's title, by video id. Empty when no model
   * answered. `checkpoint` is called between batches and throws to stop the run.
   */
  annotate(
    candidates: Candidate[],
    shape: AnswerShape,
    genreLabel: string,
    checkpoint?: () => void,
    note?: string
  ): Promise<Map<string, Annotation>>;
}

export interface CatalogueDeps {
  sources: CatalogueSources;
  /** Where the seeds and the day's search ledger live, and the shared catalogue a search must not repeat. */
  db: Db;
  /** Only ever asked the time: nothing here waits on a timer of its own. */
  clock: Pick<Clock, 'now'>;
  /** YouTube searches a day, all of them. `BLINDTEST_SEARCH_BUDGET` in production. */
  budget: number;
}

export interface PoolStatus {
  genreId: string;
  entries: number;
  ageMs: number;
  /** Sources that came back empty or tiny, and why a fill stopped short. */
  thinSources: string[];
}

/** One seed search's worth of rounds for the overnight prefill. See `searchForCatalogue`. */
export interface CatalogueSearch {
  entries: PoolEntry[];
  spent: number;
  /** No model read the candidates, so nothing was kept and the seeds were handed back. */
  modelDown: boolean;
}

/** The blind test's catalogue: genre pools, the seeds behind them, and the day's searches. */
export interface Catalogue {
  /**
   * The pool for a genre, fetched if stale. Never throws: a failed fill is an
   * empty pool, remembered briefly.
   *
   * Facets share their parent's pool rather than having one, which is what makes
   * "90s rap" free: it is a filter applied at draw time, not a second catalogue.
   */
  poolFor(genreId: string): Promise<PoolEntry[]>;
  /** The pool if it is already in memory, without ever fetching one. */
  cachedPool(genreId: string): PoolEntry[] | null;
  /** Starts a fill without waiting for it, and without starting a second one. */
  warm(genreId: string, onError?: (error: unknown) => void): void;
  /** Searches a few more seeds into a live pool, in the background. */
  extend(genreId: string, window?: { min: number; max: number }): void;
  /** The per-track detail a round needs: its chorus, its other names, its real year. */
  enrich(entries: PoolEntry[]): Promise<void>;
  /** One seed search straight into rounds for the shared catalogue, within `budget` for the day. */
  searchForCatalogue(genreId: string, budget: number): Promise<CatalogueSearch | null>;
  /** Diagnostics for the setup screen and the logs. */
  status(): PoolStatus[];
  /** Harvests a genre's seeds now. Resolves to how many the sources offered. */
  harvest(genreId: string): Promise<number>;
  /** Starts every due seed harvest, one after another, without waiting for any. */
  warmSeeds(): void;
  seedStats(): SeedStats[];
  /** Which genres' seeds know each name. For the genre check on the shared catalogue. */
  seedIndex(): SeedIndex;
  /** Today's search spending, by the Pacific day Google resets the quota on. */
  searchesToday(): { day: string; used: number; budget: number };
}

/**
 * Every video id the shared catalogue already holds.
 *
 * What a fresh search is *for* is a song nobody has heard. A pool draw knows
 * what this session has played and nothing about what the catalogue holds, so
 * it would happily spend a search on a track already sitting there — which is a
 * round the room could have had for free, and the one flavour of duplicate the
 * track key does not catch, because the two never met inside one session.
 *
 * Projected rather than read whole: this runs on the draw path, where the rows
 * themselves are not wanted. Here rather than in `blindtest-library`, which
 * re-exports it over the app's database, because that module opens the app's
 * database as it loads and the catalogue has to be able to run on another.
 */
export async function libraryVideoCodesIn(db: Db): Promise<Set<string>> {
  const rows = await db
    .select({ code: sql<string | null>`json_extract(${media.payload}, '$.code')` })
    .from(media)
    .where(and(isNull(media.user_id), eq(media.kind, 'blindtest')));

  const codes = new Set<string>();
  for (const row of rows) {
    if (row.code) codes.add(row.code);
  }
  return codes;
}

/**
 * A catalogue over these sources, this database and this clock.
 *
 * Every cache, queue and in-flight map the pools and the seeds keep is held in
 * here rather than at module level, so the app makes one and holds on to it
 * (see `catalogue-service`) while a test makes a fresh one per case.
 */
export function createCatalogue({ sources, db, clock, budget: dailyBudget }: CatalogueDeps): Catalogue {
  const stock = createSeedStock({ sources: sources.seeds, db, clock });

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

  /** Says somebody still wants this pool. Cheap, and called from every reader. */
  function noteWanted(key: string): void {
    wantedAt.set(key, clock.now());
  }

  /** Extensions in flight, one per pool. */
  const extending = new Map<string, Promise<void>>();
  /** When each pool was last extended, so a dry genre is not searched every round. */
  const extendedAt = new Map<string, number>();
  /** The last extension anywhere; see `EXTEND_GLOBAL_GAP_MS`. */
  let lastExtensionAt = 0;

  /** Each genre's spread, read from the database now and then. See `readCalibrations`. */
  let calibrations: { at: number; fitted: ReturnType<typeof readCalibrations> } | null = null;

  function calibrationFor(genre: Genre): Calibration {
    if (!calibrations || clock.now() - calibrations.at >= CALIBRATION_TTL_MS) {
      let fitted: ReturnType<typeof readCalibrations>;
      try {
        fitted = readCalibrations(db);
      } catch {
        fitted = new Map();
      }
      calibrations = { at: clock.now(), fitted };
    }
    return resolveCalibration(calibrations.fitted, sourceGenreFor(genre).id, genre.answerShape);
  }

  /**
   * Scores entries against their genre's spread.
   *
   * Per entry rather than as a rank over the pool, so an entry's number does
   * not move when an extension brings others in, and a pool of obscure uploads
   * is not given an easy end of its own.
   */
  function rescore(genre: Genre, entries: PoolEntry[]): void {
    const context = { shape: genre.answerShape, audience: audienceOf(genre), calibration: calibrationFor(genre) };
    for (const entry of entries) {
      entry.difficulty = scoreDifficulty(fameOf(entry), context);
    }
  }

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
      await stock.ensure(genre).catch(() => undefined);
      const planned = stock.plan(genre, searches, options.window);
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
    budget: number = dailyBudget
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
      if (!spendSearch(db, budget, clock)) {
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
        const ids = await sources.youtube.search(step.query, { musicOnly, limit: step.limit });
        if (ids.length < 10) thinSources.push(step.label);
        for (const id of ids) {
          harvested.push(id);
          if (!origin.has(id)) origin.set(id, step);
        }
        // Spent the moment it ran: the quota is gone whatever the model makes of
        // the results, and a seed searched twice is a hundred units for nothing.
        if (step.seed) {
          stock.markSearched(step.seed, ids.length);
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
    const catalogued = await libraryVideoCodesIn(db).catch(() => new Set<string>());
    const unique = [...new Set(harvested)]
      .filter((id) => !catalogued.has(id) && !exclude.videoIds.has(id))
      .slice(0, MAX_POOL_ENTRIES * 2);
    const facts = unique.length > 0 ? await sources.youtube.facts(unique) : new Map<string, VideoFacts>();

    // Annotation is batched over everything that survived the cheap filters, so the
    // model sees one list per genre rather than one call per video.
    const surviving = [...facts.values()].filter(
      (fact) =>
        fact.durationSeconds !== null &&
        fact.durationSeconds >= MIN_DURATION_SECONDS &&
        fact.durationSeconds <= MAX_DURATION_SECONDS &&
        !NOT_A_SINGLE_WORK.test(fact.title)
    );

    const annotations = await sources.annotate(
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
      for (const seed of ran) stock.unmarkSearched(seed);
    }

    const oracle =
      genre.seeds && genre.seeds.length > 0
        ? stock.oracle(genre.id, (other) => genreById.get(other)?.section === genre.section)
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
   * Scored provisionally here, from the model and the seed; the prefill
   * enriches each round before filing it, which is when the catalogues are
   * asked and the number becomes the real one.
   */
  async function searchForCatalogue(genreId: string, budget: number): Promise<CatalogueSearch | null> {
    const genre = genreById.get(genreId);
    if (!genre) return null;
    const steps = await searchPlan(genre, 1, { allowFixed: false });
    if (steps.length === 0) return null;

    const built = await buildEntries(genre, steps, [], { videoIds: new Set(), trackKeys: new Set() }, () => {}, budget);
    const modelDown = built.candidates > 0 && !built.annotated;
    if (modelDown) {
      for (const seed of built.searched) stock.unmarkSearched(seed);
      return { entries: [], spent: built.spent, modelDown };
    }

    rescore(genre, built.entries);
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
   *
   * The most viewed first, which are the famous tracks a facet most needs in its
   * right decade. The pool was once sorted by views as a side effect of ranking
   * its difficulty, and the check relied on that order without saying so; when
   * the ranking went, it was checking whichever eighty the search listed first.
   */
  async function verifyYears(genre: Genre, entries: PoolEntry[], checkpoint: () => void): Promise<void> {
    if (!GENRES.some((other) => other.facetOf === genre.id)) return;
    const mostViewed = [...entries].sort((left, right) => right.views - left.views);
    for (const entry of mostViewed.slice(0, YEAR_CHECK_LIMIT)) {
      // Eighty serialised enrichments, each a MusicBrainz lookup and the fame
      // lookups (cached for months, so slow only the first time): the same
      // reason the annotation can be cut short applies here, for the same
      // abandoned room.
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
      if (clock.now() - last > FILL_ABANDON_MS) throw new PoolAbandoned(key);
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
        const items = await sources.youtube.playlist(source.playlistId);
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

    rescore(genre, built.entries);
    await verifyYears(genre, built.entries, checkpoint);

    return { entries: built.entries, fetchedAt: clock.now(), thinSources, spent: built.spent };
  }

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
  function extend(genreId: string, window?: { min: number; max: number }): void {
    const genre = genreById.get(genreId);
    if (!genre) return;
    const source = sourceGenreFor(genre);
    const key = source.id;

    if (!source.seeds || source.seeds.length === 0) return;
    const pool = pools.get(key);
    // No pool, or a stale one: a fill is what it needs, and `warm` starts it.
    if (!pool || pool.entries.length === 0 || clock.now() - pool.fetchedAt >= POOL_TTL_MS) return;
    if (pool.entries.length >= MAX_EXTENDED_POOL) return;
    if (filling.has(key) || extending.has(key)) return;
    if (clock.now() - (extendedAt.get(key) ?? 0) < EXTEND_COOLDOWN_MS) return;
    if (clock.now() - lastExtensionAt < EXTEND_GLOBAL_GAP_MS) return;
    extendedAt.set(key, clock.now());
    lastExtensionAt = clock.now();

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
        Math.max(0, dailyBudget - FILL_RESERVE)
      );
      if (built.entries.length === 0) {
        // Pushed into the future so the cooldown check keeps failing for the back-off.
        extendedAt.set(key, clock.now() + FRUITLESS_EXTENSION_BACKOFF_MS);
        return;
      }
      await verifyYears(source, built.entries, checkpoint);

      // Replaced by a fresh fill while this was out: that pool has its own.
      if (pools.get(key) !== pool) return;
      const known = new Set(pool.entries.map((entry) => entry.trackKey));
      rescore(source, built.entries);
      pool.entries.push(...built.entries.filter((entry) => !known.has(entry.trackKey)));
    })()
      .catch(() => undefined)
      .finally(() => extending.delete(key));

    extending.set(key, run);
  }

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
  function cachedPool(genreId: string): PoolEntry[] | null {
    const genre = genreById.get(genreId);
    if (!genre) return null;

    const key = sourceGenreFor(genre).id;
    // Asking is wanting, whatever the answer turns out to be: a draw that finds the
    // pool missing wants it most of all, and that is the ask a running fill listens
    // for. See `wantedAt`.
    noteWanted(key);

    const pool = pools.get(key);
    if (!pool || clock.now() - pool.fetchedAt >= POOL_TTL_MS) return null;
    return pool.entries;
  }

  /**
   * Starts a fill without waiting for it, and without starting a second one.
   *
   * Deliberately returns nothing: every caller of this wants the pool *later*.
   */
  function warm(genreId: string, onError?: (error: unknown) => void): void {
    if (cachedPool(genreId) !== null) return;
    void poolFor(genreId).catch((error: unknown) => onError?.(error));
  }

  async function poolFor(genreId: string): Promise<PoolEntry[]> {
    const genre = genreById.get(genreId);
    if (!genre) return [];

    const source = sourceGenreFor(genre);
    const key = source.id;
    noteWanted(key);

    const cached = pools.get(key);
    if (cached && clock.now() - cached.fetchedAt < POOL_TTL_MS) {
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
    return clock.now() - (POOL_TTL_MS - retryMs);
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
   *
   * Then the catalogues that know how famous the answer is (see `blindtest-fame`,
   * cached for months), which is when the entry's difficulty becomes the real
   * one, and for a work the song its clip plays, whose lyrics place a sung theme
   * the way they place any song.
   */
  async function enrich(entries: PoolEntry[]): Promise<void> {
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.enriched) return;
        entry.enriched = true;
        const genre = genreById.get(entry.genreId);

        if (entry.answerShape === 'artist-title' && entry.artist && entry.title) {
          await enrichTrack(entry, genre);
        } else if (entry.answerShape === 'work' && entry.work) {
          await enrichWork(entry, genre);
        }
        if (genre) rescore(genre, [entry]);
      })
    );
  }

  async function enrichTrack(entry: PoolEntry, genre: Genre | undefined): Promise<void> {
    // No lyrics, so no chorus to find: an instrumental genre skips the lookup
    // and plays from its profile and the model's estimate of the theme.
    const sung = !genre || !profileFor(genre).instrumental;
    const [chorus, catalogued] = await Promise.all([
      sung ? sources.lyrics(entry.artist, entry.title) : Promise.resolve(null),
      sources.aliases.musicbrainz(entry.artist, entry.title)
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

    entry.fame = await lookupFame(
      db,
      sources.fame,
      { shape: 'artist-title', artist: entry.artist, title: entry.title, artistMbid: catalogued?.artistMbid ?? null },
      { now: clock.now() }
    );
  }

  async function enrichWork(entry: PoolEntry, genre: Genre | undefined): Promise<void> {
    /**
     * AniList for anime only.
     *
     * It used to be asked about every work, and it answers whatever it is
     * asked: a search for a film or a game returns the nearest anime, whose
     * titles then became accepted answers and whose year filed the film under
     * the wrong decade. Films, series and games get theirs from their seeds.
     */
    if (genre?.section === 'anime') {
      const catalogued = await sources.aliases.anilist(entry.work);
      if (catalogued) {
        entry.workAliases = [...new Set([...entry.workAliases, ...catalogued.aliases])];
        if (catalogued.year) {
          entry.year = catalogued.year;
          entry.yearVerified = true;
        }
      }
    }

    const kind = genre ? sourceGenreFor(genre).workKind : undefined;
    if (!genre || !kind) return;
    entry.fame = await lookupFame(
      db,
      sources.fame,
      { shape: 'work', kind, work: entry.work, names: entry.workAliases, wikidataId: entry.seedWikidataId },
      { now: clock.now() }
    );

    const song = themeSongOf(entry, genre);
    if (song) entry.chorus = await sources.lyrics(song.artist, song.title);
  }

  function status(): PoolStatus[] {
    const now = clock.now();
    return [...pools.entries()].map(([genreId, pool]) => ({
      genreId,
      entries: pool.entries.length,
      ageMs: now - pool.fetchedAt,
      thinSources: pool.thinSources
    }));
  }

  return {
    poolFor,
    cachedPool,
    warm,
    extend,
    enrich,
    searchForCatalogue,
    status,
    harvest: (genreId) => {
      const genre = genreById.get(genreId);
      return genre ? stock.harvest(genre) : Promise.resolve(0);
    },
    warmSeeds: () => stock.warm(GENRES),
    seedStats: () => stock.stats(),
    seedIndex: () => stock.index(),
    searchesToday: () => {
      const day = quotaDay(clock);
      return { day, used: searchesOn(db, day), budget: dailyBudget };
    }
  };
}

/** Whether YouTube can be reached at all. Surfaced so the UI can say why not. */
export function catalogAvailable(): boolean {
  return Boolean(env.GOOGLE_API_KEY);
}
