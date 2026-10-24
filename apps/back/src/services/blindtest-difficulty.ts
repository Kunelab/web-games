import type { BlindtestFame } from 'game-core';

/**
 * How hard a generated round is, from how famous its answer is.
 *
 * ## For somebody who picked the genre
 *
 * The question is not "would a random person name it" but "would somebody who
 * ticked this genre on purpose". Bob Marley is a 1 in a reggae round and
 * "Enter Sandman" a 1 to 5 in a metal one, while a dancehall hit known in
 * Jamaica and nowhere else is an 85 to 90 in reggae. So every figure is measured
 * against its own genre's spread (see `Calibration`), never against music as a
 * whole: the Deezer fan count that is ordinary for pop is famous for metal.
 *
 * ## French, or known everywhere
 *
 * The room is French. A song can be known to it because it is famous in France
 * or because it is famous everywhere, and which country it comes from does not
 * matter. So two scores are built, one from what measures French fame (Deezer,
 * whose listeners are mostly French, and the French Wikipedia) and one from
 * what measures worldwide fame (how many Wikipedia languages cover the artist,
 * the English Wikipedia, Last.fm), and the round takes the better of the two.
 * The language count weighs most there, because breadth is what separates
 * famous everywhere from famous at home: a star has a hundred, a hit-maker
 * known in one country has a handful.
 * Except in the French genres, French rap and chanson, where only French fame
 * counts: a French rapper unknown abroad is not therefore obscure to the room.
 *
 * ## A bell curve, with fixed ends
 *
 * The blend is turned into a number around 50 with a spread of 22, so in a
 * genre its two or three most famous percent land at 1 to 5, half the rounds
 * between 35 and 65, and the deepest cuts above 85. Two rules hold whatever the
 * blend says:
 * an answer the genre's fans all know is never above 20, and one that nobody
 * anywhere has heard of, few views and no catalogue that knows it, is never
 * below 95.
 *
 * ## What does not count much
 *
 * YouTube views are worldwide and cannot tell a hit in its home country from a
 * hit everywhere ("QQ, IQ - Movie" has four million), and a Topic upload has a
 * tenth of the views of the music video of the same song. So they only ever make
 * a round harder, and weakly. The language model's opinion is a tie-breaker.
 */

/** The figures a difficulty is scored from. See `blindtestFameSchema` in game-core. */
export type FameSignal =
  | 'deezerRank'
  | 'deezerFans'
  | 'lastfmListeners'
  | 'wikiLanguages'
  | 'frPageviews'
  | 'enPageviews'
  | 'anilistMembers'
  | 'tmdbVotes'
  | 'views';

/** A signal, or the blend itself, which is calibrated like one. */
export type CalibrationKey = FameSignal | 'composite';

export const CALIBRATION_KEYS: readonly CalibrationKey[] = [
  'deezerRank',
  'deezerFans',
  'lastfmListeners',
  'wikiLanguages',
  'frPageviews',
  'enPageviews',
  'anilistMembers',
  'tmdbVotes',
  'views',
  'composite'
];

/** Mean and spread of a figure on a log10 scale, within one genre. */
export interface Scale {
  mean: number;
  sd: number;
  /**
   * Where the genre's top tenth starts, fitted. The spread cannot say: Deezer's
   * rank stops at a million, the genre's hits bunch up under it, and in rap
   * français the best rank there is sits less than one spread above the
   * middle. Absent for a spread fitted before this was kept.
   */
  top?: number;
}

/** One genre's scales. A missing key falls back on `DEFAULT_SCALES`. */
export type Calibration = Partial<Record<CalibrationKey, Scale>>;

/** Whose fame counts: French only, or French or worldwide, whichever is higher. */
export type FameAudience = 'fr' | 'any';

export type FameShape = 'artist-title' | 'work';

/**
 * The middle of the curve and its spread: one standard deviation is 22 points.
 *
 * Wide enough that the head of a genre reaches the bottom of the scale: Bob
 * Marley is a 1 in reggae, not a 9, to somebody who picked reggae.
 */
const MIDDLE = 50;
const SPREAD = 22;

/**
 * How far one figure may stand from its genre's middle, in standard deviations.
 *
 * A zero on a log scale ("Deezer has never heard of them") sits eighteen of them
 * below a genre's middle, and left as it is that one figure would outvote every
 * other in the blend.
 */
const MAX_Z = 3.5;

/** Kept off the very ends, which would read as "certain". */
const FLOOR = 1;
const CEILING = 99;

/**
 * Where each figure sits before a genre has been calibrated.
 *
 * Measured by eye on known cases, in log10 of the raw figure: a Deezer rank of
 * 400k is ordinary and 950k is a hit; a Deezer artist with 100k fans is
 * ordinary, ten million is a star and a thousand is nobody; sixty days of
 * French Wikipedia views run from a hundred to a hundred thousand. The rescoring
 * script replaces these with each genre's own figures.
 */
export const DEFAULT_SCALES: Record<CalibrationKey, Scale> = {
  deezerRank: { mean: 5.6, sd: 0.35, top: Math.log10(900_001) },
  deezerFans: { mean: 5, sd: 1 },
  lastfmListeners: { mean: 4.8, sd: 0.9 },
  wikiLanguages: { mean: 1.1, sd: 0.5 },
  frPageviews: { mean: 3.3, sd: 1.1 },
  enPageviews: { mean: 4, sd: 1.1 },
  anilistMembers: { mean: 4.9, sd: 0.45 },
  tmdbVotes: { mean: 3, sd: 0.7 },
  views: { mean: 6.3, sd: 1.2 },
  // A weighted mean of several scores spreads less than any one of them.
  composite: { mean: 0, sd: 0.8 }
};

/**
 * Which figures say "known in France" and which say "known everywhere", and
 * how much each weighs within its side.
 *
 * For a song the French side is Deezer and the French Wikipedia; for a work it
 * is the French Wikipedia alone, since the French audience of a film shows in
 * nothing else that is free to read. AniList's members are the anime fandom
 * worldwide, which is exactly who picks an anime genre.
 */
const SIDES: Record<FameShape, { french: [FameSignal, number][]; international: [FameSignal, number][] }> = {
  'artist-title': {
    french: [
      ['deezerRank', 3],
      ['deezerFans', 2],
      ['frPageviews', 2]
    ],
    international: [
      ['wikiLanguages', 3],
      ['lastfmListeners', 2],
      ['enPageviews', 1]
    ]
  },
  work: {
    french: [['frPageviews', 3]],
    international: [
      ['anilistMembers', 3],
      ['tmdbVotes', 2],
      ['enPageviews', 2],
      ['wikiLanguages', 1]
    ]
  }
};

/** Fame decides; the model, the seed's rank and the views only lean on it. */
const WEIGHT = { fame: 4, model: 1, seed: 1, views: 0.5 };

/**
 * How much more a music video is watched than another upload of the same song.
 *
 * A Topic track and an official audio upload sit next to a music video that
 * collects most of the song's views, so their own count is read up by this
 * much, in log10, before it is compared with anything.
 */
const UPLOAD_BOOST: Record<NonNullable<BlindtestFame['upload']>, number> = { topic: 0.8, audio: 0.4, video: 0 };

/** Fame this far above the genre's middle is its top twentieth: never above `FAMOUS_CAP`. */
const FAMOUS_Z = 1.67;
const FAMOUS_CAP = 20;

/** And the obscure end: below all of these, with few views, nobody will name it. */
const OBSCURE_FLOOR = 95;
const OBSCURE_VIEWS = 10_000;
const OBSCURE_FANS = 1_000;
const OBSCURE_LISTENERS = 1_000;
const OBSCURE_ANIME_MEMBERS = 2_000;
const OBSCURE_TMDB_VOTES = 20;

/** What the model says when it does not know the answer, at the least. */
const UNRECOGNISED_MODEL = 80;

/**
 * The ends of the scale, which have to be earned.
 *
 * 1 to 10 is a song every fan of the genre names in a second, and the blend
 * could put one there on its artist alone: four of the seven points on the
 * French side are the artist's (Deezer fans, the French Wikipedia), so an
 * ordinary song by a big name came out at 1 to 5. Nine of SDM's did. The easy
 * end needs the song itself to be a hit: in its genre's top tenth on Deezer,
 * on Last.fm or on YouTube, or near the top of the genre's seeds. Short of
 * that, the artist's fame still makes it easy, never extreme.
 *
 * And 90 to 100 is a song nobody will name, which a lookup that found nothing
 * cannot tell from one that looked under the wrong name: "ASTRO DDOCA", a
 * sub-unit Deezer files under another, came out at 91 with nine million
 * views. A million views, or a Deezer rank above the genre's middle, says
 * people know it, whatever else came back empty.
 */
const EASY_END = 10;
const ARTIST_ONLY_FLOOR = 15;
/** The top tenth of a genre, in standard deviations from its middle, where no `top` was fitted. */
const HIT_Z = 1.3;
const HIT_SEED = 0.9;
const HARD_END = 90;
const CONTRADICTED_CAP = 85;
const CONTRADICTING_VIEWS = 1_000_000;

/* ------------------------------------------------------------------ the bell */

/**
 * The standard normal distribution function.
 *
 * Abramowitz and Stegun 7.1.26, good to about 1e-7, which is far finer than a
 * difficulty in whole points needs.
 */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Its inverse (Acklam's approximation), for a probability strictly between 0 and 1. */
export function normalQuantile(p: number): number {
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239
  ];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968,
    2.938163982698783
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  const q = Math.min(1 - 1e-12, Math.max(1e-12, p));

  if (q < low) {
    const r = Math.sqrt(-2 * Math.log(q));
    return (
      (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) /
      ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1)
    );
  }
  if (q > 1 - low) {
    const r = Math.sqrt(-2 * Math.log(1 - q));
    return (
      -(((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) /
      ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1)
    );
  }
  const r = q - 0.5;
  const s = r * r;
  return (
    ((((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r) /
    (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1)
  );
}

/**
 * A difficulty to aim the next round at, inside the room's window.
 *
 * Drawn from the same bell the catalogue is scored on rather than evenly across
 * the window. Even, a room on the default 0 to 100 aimed one round in five at
 * the easiest twentieth of the catalogue, and the same few household names came
 * round every evening; on the bell it hears them about as often as they exist.
 */
export function bellTarget(min: number, max: number, random: () => number = Math.random): number {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  // Difficulty runs the other way from fame: a high z is an easy round.
  const from = normalCdf((MIDDLE - high) / SPREAD);
  const to = normalCdf((MIDDLE - low) / SPREAD);
  const z = normalQuantile(from + random() * (to - from));
  return Math.min(high, Math.max(low, Math.round(MIDDLE - SPREAD * z)));
}

/* ----------------------------------------------------------------- scoring */

function scaleOf(calibration: Calibration, key: CalibrationKey): Scale {
  return calibration[key] ?? DEFAULT_SCALES[key];
}

/**
 * The least a figure counts as, when it is lower.
 *
 * No Wikipedia article and an article nobody reads say the same thing, and on
 * a log scale the first would otherwise sit a cliff below the second: a dancehall
 * hit with no article anywhere came out at 99 rather than the high 80s its
 * Deezer figures put it at.
 */
const FIGURE_FLOOR: Partial<Record<FameSignal, number>> = { frPageviews: 30, enPageviews: 30, wikiLanguages: 1 };

/** A raw figure on the log scale its calibration is kept in. Null when unknown. */
export function logFigure(fame: BlindtestFame, signal: FameSignal): number | null {
  const value = fame[signal];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const logged = Math.log10(1 + Math.max(value, FIGURE_FLOOR[signal] ?? 0));
  return signal === 'views' ? logged + UPLOAD_BOOST[fame.upload ?? 'video'] : logged;
}

function zOf(fame: BlindtestFame, signal: FameSignal, calibration: Calibration): number | null {
  const logged = logFigure(fame, signal);
  if (logged === null) return null;
  const { mean, sd } = scaleOf(calibration, signal);
  return Math.max(-MAX_Z, Math.min(MAX_Z, (logged - mean) / sd));
}

function weightedMean(parts: [number | null, number][]): number | null {
  let sum = 0;
  let weight = 0;
  for (const [value, w] of parts) {
    if (value === null) continue;
    sum += value * w;
    weight += w;
  }
  return weight > 0 ? sum / weight : null;
}

/** How a difficulty came out, for the rescoring report. */
export interface ScoreBreakdown {
  difficulty: number;
  /** Fame on each side, in standard deviations from the genre's middle. */
  french: number | null;
  international: number | null;
  /** The side that counted for this genre. */
  fame: number | null;
  /** The blend before the genre's own spread is taken out. */
  composite: number | null;
  /**
   * Which rule, if any, decided it: a fixed end (`famous`, `obscure`), or one
   * kept from the extremes it had not earned (`artist-only`, `contradicted`).
   */
  rule: 'famous' | 'obscure' | 'artist-only' | 'contradicted' | null;
  /**
   * No catalogue found it at all, and nothing says it is obscure: scored on
   * what is left (the model, the seeds, the views), which a rescoring takes as
   * no reason to change a number it already has. See `nothingFound`.
   */
  unfound: boolean;
}

export interface ScoreContext {
  shape: FameShape;
  audience: FameAudience;
  calibration: Calibration;
  /**
   * Whether the answer is a piece known in its own right, as in classical,
   * whose Wikipedia figures are the piece's and not its composer's.
   */
  piece?: boolean;
}

/** The two sides and the blend, before the genre's spread is applied. */
function blend(fame: BlindtestFame, { shape, audience, calibration }: ScoreContext) {
  const sides = SIDES[shape];
  const french = weightedMean(sides.french.map(([signal, w]) => [zOf(fame, signal, calibration), w]));
  const international = weightedMean(sides.international.map(([signal, w]) => [zOf(fame, signal, calibration), w]));
  const counted =
    audience === 'fr'
      ? french
      : french === null
        ? international
        : international === null
          ? french
          : Math.max(french, international);

  const model =
    typeof fame.model === 'number' && Number.isFinite(fame.model)
      ? fame.recognised === false
        ? Math.max(fame.model, UNRECOGNISED_MODEL)
        : fame.model
      : fame.recognised === false
        ? UNRECOGNISED_MODEL
        : null;
  const seed =
    typeof fame.seedFame === 'number' && Number.isFinite(fame.seedFame)
      ? normalQuantile(Math.min(0.98, Math.max(0.02, fame.seedFame)))
      : null;
  const views = zOf(fame, 'views', calibration);

  const composite = weightedMean([
    [counted, WEIGHT.fame],
    [model === null ? null : (MIDDLE - model) / SPREAD, WEIGHT.model],
    [seed, WEIGHT.seed],
    // Views only ever make it harder; see the header.
    [views !== null && views < 0 ? views : null, WEIGHT.views]
  ]);

  return { french, international, counted, composite };
}

/** The blend alone, which the calibration fits a spread to. */
export function compositeOf(fame: BlindtestFame, context: ScoreContext): number | null {
  return blend(fame, context).composite;
}

/** A figure the catalogues gave, under the limit. */
function knownBelow(value: number | null | undefined, limit: number): boolean {
  return typeof value === 'number' && value < limit;
}

/** Under the limit, or a catalogue that has no figure for it, which for these is common. */
function notAbove(value: number | null | undefined, limit: number): boolean {
  return value === null || value === undefined || value < limit;
}

/**
 * Nobody anywhere has heard of it.
 *
 * Few views is the half every case needs. The other half is the catalogues
 * answering that they do not know it, which is a zero and never a missing
 * figure: a lookup whose requests failed knows nothing either way. Without
 * that answer, the model not knowing it either will do.
 */
function nobodyKnows(fame: BlindtestFame, shape: FameShape): boolean {
  // The upload's own count, not read up for a Topic upload: an act this obscure
  // has no music video holding the rest of its views, so there is nothing to read up.
  if (typeof fame.views !== 'number' || fame.views >= OBSCURE_VIEWS) return false;

  const nowhere = knownBelow(fame.wikiLanguages, 1);
  const catalogues =
    shape === 'artist-title'
      ? nowhere && knownBelow(fame.deezerFans, OBSCURE_FANS) && notAbove(fame.lastfmListeners, OBSCURE_LISTENERS)
      : nowhere && notAbove(fame.anilistMembers, OBSCURE_ANIME_MEMBERS) && notAbove(fame.tmdbVotes, OBSCURE_TMDB_VOTES);
  // The catalogues' answer stands when there is one; the model only fills in for none.
  const answered =
    typeof fame.wikiLanguages === 'number' ||
    typeof (shape === 'artist-title' ? fame.deezerFans : fame.anilistMembers) === 'number';
  if (fame.looked && answered) return catalogues;
  return fame.recognised === false || (typeof fame.model === 'number' && fame.model >= UNRECOGNISED_MODEL);
}

/**
 * The song itself is a hit in its genre, not only its artist. See `EASY_END`.
 *
 * Always so of a work, whose figures are the work's own: there is no artist
 * to lend it fame.
 */
export function songIsHit(fame: BlindtestFame, context: ScoreContext): boolean {
  if (context.shape === 'work') return true;
  const hit = (signal: FameSignal) => {
    const logged = logFigure(fame, signal);
    if (logged === null) return false;
    const scale = scaleOf(context.calibration, signal);
    return logged >= (scale.top ?? DEFAULT_SCALES[signal].top ?? scale.mean + HIT_Z * scale.sd);
  };
  return (
    hit('deezerRank') ||
    hit('lastfmListeners') ||
    hit('views') ||
    (typeof fame.seedFame === 'number' && fame.seedFame >= HIT_SEED) ||
    // A piece's Wikipedia is its own, not its composer's: see `ScoreContext.piece`.
    (context.piece === true && (hit('wikiLanguages') || hit('frPageviews') || hit('enPageviews')))
  );
}

/** Something says people know it after all: a million views, or a Deezer rank above the genre's middle. */
export function knownAfterAll(fame: BlindtestFame, context: ScoreContext): boolean {
  if (typeof fame.views === 'number' && fame.views >= CONTRADICTING_VIEWS) return true;
  return context.shape === 'artist-title' && (zOf(fame, 'deezerRank', context.calibration) ?? -Infinity) >= 0;
}

/** What the catalogues give, as opposed to the views, the model and the seeds. */
const CATALOGUE_SIGNALS: readonly FameSignal[] = [
  'deezerRank',
  'deezerFans',
  'lastfmListeners',
  'wikiLanguages',
  'frPageviews',
  'enPageviews',
  'anilistMembers',
  'tmdbVotes'
];

/**
 * The catalogues answered, and every answer was nothing: a zero somewhere,
 * and not one figure above it. (Figures that are all unknown say nothing
 * either way, and are scored on what is left as they always were.)
 *
 * Read as "nobody knows it", that put "My Hero Academia", "Superman" and all
 * of (G)I-DLE at 85 to 99. It is almost always the name instead: a season or
 * a translation in brackets ("Drive (film, 2011)"), punctuation a search does
 * not take, or an answer that is not the work at all (a singer, the song) read
 * off a Japanese video title.
 */
export function nothingFound(fame: BlindtestFame): boolean {
  const values = CATALOGUE_SIGNALS.map((signal) => fame[signal]);
  return values.some((value) => value === 0) && !values.some((value) => typeof value === 'number' && value > 0);
}

/** Found nowhere, and the views do not say it is obscure either. See `nothingFound`. */
function unfound(fame: BlindtestFame, shape: FameShape): boolean {
  return nothingFound(fame) && !nobodyKnows(fame, shape);
}

/** The figures with the catalogues' zeros taken for what they are here: unknown. */
function withoutCatalogues(fame: BlindtestFame): BlindtestFame {
  return { ...fame, ...Object.fromEntries(CATALOGUE_SIGNALS.map((signal) => [signal, null])) };
}

/** Why a stored difficulty is in doubt. See `extremeDoubt`. */
export type ExtremeDoubt = 'easy-unconfirmed' | 'hard-contradicted' | 'unscored' | 'not-found';

/**
 * Why a difficulty at either end is in doubt, or null when nothing says so.
 *
 * For the admin. `scoreBreakdown` keeps every new number off the ends it has
 * not earned; this finds the stored ones it would not have given: those no
 * rescoring has reached yet or ever will (a round edited by hand before edits
 * were marked), and the extremes scored before any figure was kept, which
 * nothing backs either way.
 *
 * And, wherever it sits, a round no catalogue found at all: its number was
 * kept rather than made up, and the answer itself is the likeliest culprit.
 */
export function extremeDoubt(
  difficulty: number,
  fame: BlindtestFame | null | undefined,
  context: ScoreContext
): ExtremeDoubt | null {
  if (fame?.looked && unfound(fame, context.shape)) return 'not-found';
  if (difficulty > EASY_END && difficulty < HARD_END) return null;
  if (!fame?.looked) return 'unscored';
  if (difficulty <= EASY_END) return songIsHit(fame, context) ? null : 'easy-unconfirmed';
  return knownAfterAll(fame, context) ? 'hard-contradicted' : null;
}

/** The difficulty, and how it came out. */
export function scoreBreakdown(fame: BlindtestFame, context: ScoreContext): ScoreBreakdown {
  const missing = fame.looked === true && unfound(fame, context.shape);
  const { french, international, counted, composite } = blend(missing ? withoutCatalogues(fame) : fame, context);

  let difficulty = MIDDLE;
  if (composite !== null) {
    const { mean, sd } = scaleOf(context.calibration, 'composite');
    const z = (composite - mean) / sd;
    difficulty = Math.round(MIDDLE - SPREAD * z);
  }
  difficulty = Math.min(CEILING, Math.max(FLOOR, difficulty));

  let rule: ScoreBreakdown['rule'] = null;
  if (counted !== null && counted >= FAMOUS_Z && difficulty > FAMOUS_CAP) {
    difficulty = FAMOUS_CAP;
    rule = 'famous';
  } else if (nobodyKnows(fame, context.shape) && difficulty < OBSCURE_FLOOR) {
    difficulty = OBSCURE_FLOOR;
    rule = 'obscure';
  }

  // And the extremes, earned or not; see `EASY_END`.
  if (difficulty <= EASY_END && !songIsHit(fame, context)) {
    difficulty = ARTIST_ONLY_FLOOR;
    rule = 'artist-only';
  } else if (difficulty > CONTRADICTED_CAP && knownAfterAll(fame, context)) {
    difficulty = CONTRADICTED_CAP;
    rule = 'contradicted';
  }

  return { difficulty, french, international, fame: counted, composite, rule, unfound: missing };
}

export function scoreDifficulty(fame: BlindtestFame, context: ScoreContext): number {
  return scoreBreakdown(fame, context).difficulty;
}

/* ------------------------------------------------------------- calibration */

/** One catalogue round, as the calibration sees it. */
export interface CalibrationSample {
  /** The genre whose spread it belongs to: a facet's parent, never the facet. */
  genreId: string;
  shape: FameShape;
  audience: FameAudience;
  fame: BlindtestFame;
}

/** The calibration a whole answer shape shares, for a genre too small for its own. */
export const POOLED_PREFIX = '*';
export const pooledKey = (shape: FameShape) => `${POOLED_PREFIX}${shape}`;

/** Fewer than this and a genre's spread is noise; it borrows its shape's instead. */
const MIN_SAMPLES = 25;

/** Spreads below these would make one step of a figure worth half the scale. */
const MIN_SD: Record<CalibrationKey, number> = {
  deezerRank: 0.1,
  deezerFans: 0.25,
  lastfmListeners: 0.25,
  wikiLanguages: 0.15,
  frPageviews: 0.25,
  enPageviews: 0.25,
  anilistMembers: 0.15,
  tmdbVotes: 0.2,
  views: 0.3,
  composite: 0.3
};

function spreadOf(values: number[], key: CalibrationKey): Scale & { samples: number } {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length - 1);
  const sorted = [...values].sort((left, right) => left - right);
  const top = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
  return { mean, sd: Math.max(MIN_SD[key], Math.sqrt(variance)), top, samples: values.length };
}

export type FittedCalibration = Map<string, Partial<Record<CalibrationKey, Scale & { samples: number }>>>;

/**
 * Each genre's spread, from the catalogue's own rounds.
 *
 * Two passes. The first measures every figure per genre. The second blends
 * each round with its genre's first-pass scales and measures the blend, which
 * is what makes the result a bell of the intended width whatever the figures'
 * correlations happen to be. A genre with too few rounds for a figure borrows
 * the figure from every genre of its shape (the `*artist-title` and `*work`
 * rows), and those are kept too, for the runtime to fall back on.
 */
export function fitCalibrations(samples: readonly CalibrationSample[], minSamples = MIN_SAMPLES): FittedCalibration {
  const fitted: FittedCalibration = new Map();
  const groups = new Map<string, CalibrationSample[]>();
  for (const sample of samples) {
    for (const key of [sample.genreId, pooledKey(sample.shape)]) {
      const group = groups.get(key) ?? [];
      group.push(sample);
      groups.set(key, group);
    }
  }

  const signals = CALIBRATION_KEYS.filter((key): key is FameSignal => key !== 'composite');
  for (const [key, group] of groups) {
    const scales: Partial<Record<CalibrationKey, Scale & { samples: number }>> = {};
    for (const signal of signals) {
      const values = group
        .map((sample) => logFigure(sample.fame, signal))
        .filter((value): value is number => value !== null);
      if (values.length >= minSamples) scales[signal] = spreadOf(values, signal);
    }
    fitted.set(key, scales);
  }

  // The blend, measured with the scales each round will actually be scored with.
  for (const [key, group] of groups) {
    const composites = group
      .map((sample) =>
        compositeOf(sample.fame, {
          shape: sample.shape,
          audience: sample.audience,
          calibration: resolveCalibration(fitted, sample.genreId, sample.shape, false)
        })
      )
      .filter((value): value is number => value !== null);
    if (composites.length >= minSamples) {
      const scales = fitted.get(key) ?? {};
      scales.composite = spreadOf(composites, 'composite');
      fitted.set(key, scales);
    }
  }

  return fitted;
}

/**
 * The scales a round of this genre is scored with: the genre's own where it has
 * them, its shape's where it does not, and the defaults under both.
 */
export function resolveCalibration(
  fitted: ReadonlyMap<string, Partial<Record<CalibrationKey, Scale>>>,
  genreId: string,
  shape: FameShape,
  withComposite = true
): Calibration {
  const own = fitted.get(genreId) ?? {};
  const pooled = fitted.get(pooledKey(shape)) ?? {};
  const calibration: Calibration = {};
  for (const key of CALIBRATION_KEYS) {
    if (key === 'composite' && !withComposite) continue;
    const scale = own[key] ?? pooled[key];
    if (scale) calibration[key] = { mean: scale.mean, sd: scale.sd, ...(scale.top != null ? { top: scale.top } : {}) };
  }
  return calibration;
}
