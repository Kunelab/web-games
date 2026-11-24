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
 * ## A bell curve per genre, over the whole scale
 *
 * Fame is measured within the genre, but how hard the genre is is not: a
 * middling K-pop song is far harder for the room than a middling pop one, and
 * plenty of 30s in pop are already hard while a K-pop 30 was impossible. So
 * each genre has its own centre (see `GenreCurve`): 45 for pop, 70 for K-pop.
 * Around it the curve stretches to both ends, 1 at `Z_END` standard deviations
 * above the genre's middle and 100 at as many below, so a niche genre spends
 * most of the scale at the hard end and its real classics still reach 1.
 *
 * Rules that hold whatever the blend says:
 * an answer the genre's fans all know is never above 20 (a little more in a
 * niche genre), one famous across every genre is never above 20 either, and
 * one that nobody anywhere has heard of, few views and no catalogue that knows
 * it, is never below 95. The easy end, 1 to 10, needs the song to be a hit
 * across the whole catalogue, not only in its genre. And from `DEEP_CUT` up an
 * answer is a deep cut: an admin keeps it or deletes it (see `extremeDoubt`).
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
 * The middle of the scale, and how far one standard deviation of the model's
 * own 0 to 100 opinion goes: what the model's number is read against.
 */
const MIDDLE = 50;
const SPREAD = 22;

/**
 * How many standard deviations of fame from the genre's middle reach an end of
 * the scale: 1 above it, 100 below it. At a centre of 50 that is 22 points a
 * deviation, the single bell every genre used to share.
 */
export const Z_END = 2.25;

/**
 * A genre's bell: where its middling round sits on the scale. See the header.
 * Absent, 50.
 */
export interface GenreCurve {
  center: number;
}

/**
 * How far one figure may stand from its genre's middle, in standard deviations.
 *
 * A zero on a log scale ("Deezer has never heard of them") sits eighteen of them
 * below a genre's middle, and left as it is that one figure would outvote every
 * other in the blend.
 */
const MAX_Z = 3.5;

/** The ends of the scale. 100 is a song almost nobody has heard: a friend's upload with fifty views. */
const FLOOR = 1;
const CEILING = 100;

/** From here up, a deep cut: listed for an admin to keep or delete. See `extremeDoubt`. */
export const DEEP_CUT = 97;

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

/** A song's own figures, each side's: Deezer for France, Last.fm for everywhere. */
const SONG_WEIGHT = { deezerRank: 1, lastfmListeners: 1 };
/** How much of a song's fame is the song's own; the rest is its artist's. */
const SONG_SHARE = 0.65;

/**
 * A song that is a hit on two counts at once is never above this, whoever sings
 * it: one-hit wonders are named by the whole room. Two, because Deezer's rank
 * alone can be a hit in Abidjan or São Paulo that France never heard.
 */
const SONG_HIT_CAP = 40;

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
/**
 * In a genre harder than the middle, a million views is ordinary: the median
 * K-pop upload has two. It takes ten there to say the room knows it.
 */
const CONTRADICTING_VIEWS_NICHE = 10_000_000;

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

/** The centre of a curve, kept inside the scale. */
function centerOf(curve: GenreCurve | undefined): number {
  return Math.min(CEILING - 1, Math.max(FLOOR + 1, curve?.center ?? MIDDLE));
}

/**
 * Fame, in standard deviations from the genre's middle, as a difficulty on its
 * curve. Unrounded and unclamped. See the header.
 */
export function curveAt(z: number, curve?: GenreCurve): number {
  const center = centerOf(curve);
  return z >= 0 ? center - (z * (center - FLOOR)) / Z_END : center - (z * (CEILING - center)) / Z_END;
}

/** The other way: where a difficulty sits on the curve, in standard deviations of fame. */
export function zAt(difficulty: number, curve?: GenreCurve): number {
  const center = centerOf(curve);
  return difficulty <= center
    ? ((center - difficulty) * Z_END) / (center - FLOOR)
    : ((center - difficulty) * Z_END) / (CEILING - center);
}

/**
 * A difficulty to aim the next round at, inside the room's window.
 *
 * Drawn from the same bell the catalogue is scored on rather than evenly across
 * the window. Even, a room on the default 0 to 100 aimed one round in five at
 * the easiest twentieth of the catalogue, and the same few household names came
 * round every evening; on the bell it hears them about as often as they exist.
 * A room of several genres aims on a curve centred on theirs.
 */
export function bellTarget(min: number, max: number, random: () => number = Math.random, curve?: GenreCurve): number {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  // Difficulty runs the other way from fame: a high z is an easy round.
  const from = normalCdf(zAt(high, curve));
  const to = normalCdf(zAt(low, curve));
  const z = normalQuantile(from + random() * (to - from));
  return Math.min(high, Math.max(low, Math.round(curveAt(z, curve))));
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
  rule: 'famous' | 'obscure' | 'song-hit' | 'artist-only' | 'contradicted' | null;
  /** A song's own fame and its artist's, in standard deviations; null for a work. See `blend`. */
  song?: number | null;
  artist?: number | null;
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
  /** The genre's curve. Absent, centred on 50. */
  curve?: GenreCurve;
  /**
   * For a piece (see `piece`): every work genre's scales together, which its
   * Wikipedia figures are read against. See `PIECE_SIGNALS`.
   */
  works?: Calibration;
  /**
   * The scales of every genre of this shape together (`pooledKey`), for what
   * must hold across genres: the easy end and the famous cap. Absent, the
   * genre's own stand in, as they did before.
   */
  pooled?: Calibration;
}

/**
 * The figures that are a classical piece's own, read against every work's.
 *
 * Against classical's own, they could not tell one piece from another: most
 * of its rounds have nearly no Wikipedia at all, so any piece with an article
 * stood three deviations above the middle, and Pierrot Lunaire with fifteen
 * languages scored the same 1 as Swan Lake with sixty. Films, anime and games
 * spread the same figures over the range a piece's really runs.
 */
const PIECE_SIGNALS: readonly FameSignal[] = ['wikiLanguages', 'frPageviews', 'enPageviews'];

/** A context's scales with a piece's own figures read against every work's. */
export function pieceCalibration(calibration: Calibration, works: Calibration | undefined): Calibration {
  if (!works) return calibration;
  const merged: Calibration = { ...calibration };
  for (const signal of PIECE_SIGNALS) merged[signal] = works[signal] ?? DEFAULT_SCALES[signal];
  return merged;
}

/** Whether the genre is harder than the middle of the scale. */
function niche(context: ScoreContext): boolean {
  return centerOf(context.curve) > MIDDLE;
}

/** The two sides and the blend, before the genre's spread is applied. */
function blend(fame: BlindtestFame, context: ScoreContext) {
  const { shape, audience } = context;
  const calibration = context.piece ? pieceCalibration(context.calibration, context.works) : context.calibration;
  const sides = SIDES[shape];
  const french = weightedMean(sides.french.map(([signal, w]) => [zOf(fame, signal, calibration), w]));
  const international = weightedMean(sides.international.map(([signal, w]) => [zOf(fame, signal, calibration), w]));
  const better = (fr: number | null, any: number | null) =>
    audience === 'fr' ? fr : fr === null ? any : any === null ? fr : Math.max(fr, any);

  /**
   * A song: its own fame first, its artist's second.
   *
   * Taking the better of two sides that were mostly the artist's let a big name
   * carry every song it ever released: Prince's B-sides came out at 16, and a
   * hit by an act with no Wikipedia at all came out hard ("Soda Pop", 76). So
   * the song's own figures (Deezer's rank for the track, Last.fm's listeners
   * for it, its views) lead, and the artist's (fans, Wikipedia) lean on them.
   * Each picks its own audience. Without any figure for the song itself the
   * artist alone decides, as before, and `ARTIST_ONLY_FLOOR` keeps that off the
   * easy end.
   */
  let song: number | null = null;
  let artist: number | null = null;
  let counted: number | null;
  if (shape === 'artist-title' && context.piece !== true) {
    const z = (signal: FameSignal) => zOf(fame, signal, calibration);
    song = better(
      weightedMean([[z('deezerRank'), SONG_WEIGHT.deezerRank]]),
      weightedMean([[z('lastfmListeners'), SONG_WEIGHT.lastfmListeners]])
    );
    artist = better(
      weightedMean([
        [z('deezerFans'), 2],
        [z('frPageviews'), 2]
      ]),
      weightedMean([
        [z('wikiLanguages'), 3],
        [z('enPageviews'), 1]
      ])
    );
    /**
     * Deezer's rank stops at a million, so a song's fame cannot climb past the
     * genre's top tenth while a star's goes on: Bob Marley's biggest hit sat at
     * 1.4 deviations and his name at 2.3. A song at the top says nothing against
     * its artist, and is not held below them.
     */
    const atTop = (signal: FameSignal) => {
      const logged = logFigure(fame, signal);
      const scale = scaleOf(calibration, signal);
      return logged !== null && logged >= (scale.top ?? scale.mean + HIT_Z * scale.sd);
    };
    if (song !== null && artist !== null && song < artist && (atTop('deezerRank') || atTop('lastfmListeners'))) {
      song = artist;
    }
    counted =
      song === null
        ? artist
        : weightedMean([
            [song, SONG_SHARE],
            [artist, 1 - SONG_SHARE]
          ]);
  } else {
    counted = better(french, international);
  }

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
  /**
   * Views make a round harder, and easier only from an official upload with a
   * hit's count: a music video or a Topic track is the song's own, and a
   * fan's upload of a famous song is not. See the header.
   */
  const official = fame.upload === 'video' || fame.upload === 'topic';
  const leaning = views === null ? null : views < 0 ? views : official && views >= HIT_Z ? views - HIT_Z / 2 : null;

  const composite = weightedMean([
    [counted, WEIGHT.fame],
    [model === null ? null : (MIDDLE - model) / SPREAD, WEIGHT.model],
    [seed, WEIGHT.seed],
    [leaning, WEIGHT.views]
  ]);

  return { french, international, song, artist, counted, composite };
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
 * The song itself is a hit, not only its artist. See `EASY_END`.
 *
 * Measured against every genre (`ScoreContext.pooled`), except a classical
 * piece, whose figures are the piece's and are read against other pieces.
 * Always so of a work, whose figures are the work's own: there is no artist
 * to lend it fame.
 */
export function songIsHit(fame: BlindtestFame, context: ScoreContext): boolean {
  if (context.shape === 'work') return true;
  const hit = (signal: FameSignal, scales: Calibration) => {
    const logged = logFigure(fame, signal);
    if (logged === null) return false;
    const scale = scaleOf(scales, signal);
    return logged >= (scale.top ?? DEFAULT_SCALES[signal].top ?? scale.mean + HIT_Z * scale.sd);
  };
  // Against every genre: the top tenth of K-pop on Deezer is not a hit to the room.
  const everywhere = context.pooled ?? context.calibration;
  /**
   * A piece: read by more than the average work on the English Wikipedia, or
   * by as many as a famous one on the French. How many languages cover it says
   * how notable it is, which is not whether the room would hum it.
   */
  if (context.piece === true) {
    const works = context.works ?? context.calibration;
    const read = (signal: FameSignal, at: 'mean' | 'top') => {
      const logged = logFigure(fame, signal);
      if (logged === null) return false;
      const scale = scaleOf(works, signal);
      return logged >= (at === 'mean' ? scale.mean : (scale.top ?? scale.mean + HIT_Z * scale.sd));
    };
    return read('enPageviews', 'mean') || read('frPageviews', 'top') || hit('views', everywhere);
  }
  return songHits(fame, context) > 0;
}

/**
 * How many of a song's own figures call it a hit, against every genre. See
 * `songIsHit` and `SONG_HIT_CAP`. Never counts a work or a piece.
 */
export function songHits(fame: BlindtestFame, context: ScoreContext): number {
  if (context.shape === 'work' || context.piece === true) return 0;
  const everywhere = context.pooled ?? context.calibration;
  const hit = (signal: FameSignal) => {
    const logged = logFigure(fame, signal);
    if (logged === null) return false;
    const scale = scaleOf(everywhere, signal);
    return logged >= (scale.top ?? DEFAULT_SCALES[signal].top ?? scale.mean + HIT_Z * scale.sd);
  };
  return [
    // In a niche genre Deezer's rank is its fans streaming this month's release, not the room knowing it.
    !niche(context) && hit('deezerRank'),
    hit('lastfmListeners'),
    hit('views'),
    // A seed's fame is its rank within the genre's lists, which in a niche genre says nothing to the room.
    !niche(context) && typeof fame.seedFame === 'number' && fame.seedFame >= HIT_SEED
  ].filter(Boolean).length;
}

/**
 * Something says people know it after all: a million views (ten in a niche
 * genre), or a Deezer rank above the middle of every genre's.
 */
export function knownAfterAll(fame: BlindtestFame, context: ScoreContext): boolean {
  const views = niche(context) ? CONTRADICTING_VIEWS_NICHE : CONTRADICTING_VIEWS;
  if (typeof fame.views === 'number' && fame.views >= views) return true;
  return (
    context.shape === 'artist-title' &&
    (zOf(fame, 'deezerRank', context.pooled ?? context.calibration) ?? -Infinity) >= 0
  );
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
export type ExtremeDoubt = 'easy-unconfirmed' | 'hard-contradicted' | 'unscored' | 'not-found' | 'deep-cut';

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
 *
 * And a deep cut, from `DEEP_CUT` up, that nothing contradicts: almost nobody
 * will name it, and an admin decides whether it stays. Setting its difficulty
 * by hand keeps it and takes it off the list.
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
  if (knownAfterAll(fame, context)) return 'hard-contradicted';
  return difficulty >= DEEP_CUT ? 'deep-cut' : null;
}

/** The difficulty, and how it came out. */
export function scoreBreakdown(fame: BlindtestFame, context: ScoreContext): ScoreBreakdown {
  const missing = fame.looked === true && unfound(fame, context.shape);
  const { french, international, song, artist, counted, composite } = blend(
    missing ? withoutCatalogues(fame) : fame,
    context
  );

  let difficulty = Math.round(centerOf(context.curve));
  if (composite !== null) {
    const { mean, sd } = scaleOf(context.calibration, 'composite');
    difficulty = Math.round(curveAt((composite - mean) / sd, context.curve));
  }
  difficulty = Math.min(CEILING, Math.max(FLOOR, difficulty));

  /**
   * The genre's top twentieth: never above 20, or where that fame sits on a
   * niche genre's curve (24 in K-pop). Famous across every genre: never above 20.
   */
  const genreCap = Math.max(FAMOUS_CAP, Math.round(curveAt(FAMOUS_Z, context.curve)));
  const everywhere =
    context.pooled !== undefined &&
    (blend(missing ? withoutCatalogues(fame) : fame, { ...context, calibration: context.pooled }).counted ??
      -Infinity) >= FAMOUS_Z;
  let rule: ScoreBreakdown['rule'] = null;
  if (everywhere && difficulty > FAMOUS_CAP) {
    difficulty = FAMOUS_CAP;
    rule = 'famous';
  } else if (counted !== null && counted >= FAMOUS_Z && difficulty > genreCap) {
    difficulty = genreCap;
    rule = 'famous';
  } else if (nobodyKnows(fame, context.shape) && difficulty < OBSCURE_FLOOR) {
    difficulty = OBSCURE_FLOOR;
    rule = 'obscure';
  } else if (difficulty > SONG_HIT_CAP && songHits(fame, context) >= 2) {
    difficulty = SONG_HIT_CAP;
    rule = 'song-hit';
  }

  // And the extremes, earned or not; see `EASY_END`.
  if (difficulty <= EASY_END && !songIsHit(fame, context)) {
    difficulty = ARTIST_ONLY_FLOOR;
    rule = 'artist-only';
  } else if (difficulty > CONTRADICTED_CAP && knownAfterAll(fame, context)) {
    difficulty = CONTRADICTED_CAP;
    rule = 'contradicted';
  }

  return { difficulty, french, international, song, artist, fame: counted, composite, rule, unfound: missing };
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
  /** A classical piece, whose own figures are read against every work's. See `PIECE_SIGNALS`. */
  piece?: boolean;
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
          calibration: resolveCalibration(fitted, sample.genreId, sample.shape, false),
          piece: sample.piece,
          works: sample.piece ? resolveCalibration(fitted, pooledKey('work'), 'work', false) : undefined
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

/** Every genre of a shape together: what `ScoreContext.pooled` is. */
export function pooledCalibration(
  fitted: ReadonlyMap<string, Partial<Record<CalibrationKey, Scale>>>,
  shape: FameShape
): Calibration {
  return resolveCalibration(fitted, pooledKey(shape), shape);
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
