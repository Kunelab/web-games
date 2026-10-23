/* eslint-disable no-console -- a CLI's output is its interface */
import { writeFileSync } from 'node:fs';

import { and, eq, isNull } from 'drizzle-orm';
import { normalizeAnswer, type BlindtestFame } from 'game-core';

import { closeDb, db } from '../db/index.js';
import { blindtestSeeds, media } from '../db/schema.js';
import { env } from '../env.js';
import {
  fameFromFacts,
  genreById,
  readCalibrations,
  sourceGenreFor,
  themeSongOf,
  writeCalibrations,
  type Genre
} from '../services/blindtest-catalog.js';
import type { FittedCalibration } from '../services/blindtest-difficulty.js';
import { lookupFame, type FameFacts } from '../services/blindtest-fame.js';
import { annotateCandidates, type Annotation } from '../services/blindtest-llm.js';
import { buildOracle, trackOracleKey, type GenreOracle } from '../services/blindtest-seeds.js';
import {
  applyPlan,
  editedSinceFiled,
  placedAgain,
  planRescore,
  type RescorePlan
} from '../services/blindtest-rescore.js';
import { httpSources } from '../services/blindtest-sources.js';
import { uploadKind, type ChorusInfo } from '../services/chorus-service.js';
import { toMediaView, type MediaView } from '../services/media-service.js';
import { fetchVideoFacts, type VideoFacts } from '../services/youtube-service.js';

/**
 * Reassigns the difficulty of every round in the shared catalogue.
 *
 * The catalogue's numbers were a rank of YouTube views within whatever one
 * search returned, blended with a model's guess, and a band nobody has heard
 * of could be filed at 30. This works every round out again the way the draw
 * now does (see `blindtest-difficulty` and `blindtest-fame`): Deezer, Wikipedia,
 * Last.fm, AniList and TMDB say how famous the answer is, each genre's spread
 * is fitted over the catalogue itself so a round is judged against the genre a
 * room picked on purpose, and the result is a bell curve per genre.
 *
 * It also places again the clips of the genres whose clip placement changed:
 * films, series and games no longer open on their first seconds, anime openings
 * find their song's chorus, and instrumentals are heard eight seconds longer.
 *
 *   pnpm --filter back blindtest:rescore                  # report only, writes nothing
 *   pnpm --filter back blindtest:rescore --write          # and saves it
 *
 * Options:
 *   --write             save the new numbers, clips and spreads
 *   --genre <id>        only this genre (repeatable); scored against the stored spreads
 *   --limit <n>         only the first n rounds, for a quick look; the same
 *   --include-edited    also redo rounds changed by hand before this script existed (see below)
 *   --no-retime         leave every clip where it is
 *   --with-model        ask the language model again about each round, as the draw does
 *   --refresh           ask the catalogues again even where the answer is cached
 *   --concurrency <n>   rounds looked up at once (default 4)
 *   --report <file>     write every round's figures and result to a JSON file
 *
 * ## What it never touches
 *
 * A difficulty or a clip a person set: those carry `difficultyBy` / `timingBy`
 * of `human` and are left exactly as they are. Rows saved before that marker
 * existed cannot say, so a row written at all after it was filed is treated as
 * possibly corrected and left alone too, and listed in the report with what it
 * would have become; `--include-edited` redoes them as well. (A label fix also
 * counts as an edit, so some of those are not corrections.) Every decision of
 * this kind is `planRescore`'s, in `services/blindtest-rescore.ts`.
 *
 * ## One scale per genre
 *
 * A whole run fits each genre's spread over the catalogue and saves it, for the
 * server to score new rounds the same way. A partial one (`--genre`, `--limit`)
 * is scored against the spreads already saved and saves none.
 *
 * ## What it costs
 *
 * One YouTube unit per fifty rounds, for their view counts and lengths. The
 * catalogue lookups are free and paced to each service's published limit; a
 * catalogue of two thousand rounds takes a quarter of an hour or so the first
 * time and seconds after that, since the answers are cached for months. With
 * `--with-model`, one model call per twenty-five rounds.
 */

/* ---------------------------------------------------------------- options */

interface Options {
  write: boolean;
  genres: Set<string>;
  limit: number | null;
  includeEdited: boolean;
  retime: boolean;
  withModel: boolean;
  refresh: boolean;
  concurrency: number;
  report: string | null;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    write: false,
    genres: new Set(),
    limit: null,
    includeEdited: false,
    retime: true,
    withModel: false,
    refresh: false,
    concurrency: 4,
    report: null
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === '--write') options.write = true;
    else if (flag === '--genre') options.genres.add(value());
    else if (flag === '--limit') options.limit = Math.max(1, Number(value()));
    else if (flag === '--include-edited') options.includeEdited = true;
    else if (flag === '--no-retime') options.retime = false;
    else if (flag === '--with-model') options.withModel = true;
    else if (flag === '--refresh') options.refresh = true;
    else if (flag === '--concurrency') options.concurrency = Math.min(16, Math.max(1, Number(value())));
    else if (flag === '--report') options.report = value();
    else if (flag === '--help' || flag === '-h') {
      console.log('Usage: blindtest:rescore [--write] [--genre <id>]... [--limit <n>] [--include-edited]');
      console.log('       [--no-retime] [--with-model] [--refresh] [--concurrency <n>] [--report <file>]');
      process.exit(0);
    } else throw new Error(`unknown option ${flag}`);
  }
  return options;
}

/* ------------------------------------------------------------------ rows */

interface Row {
  view: MediaView;
  /** The genre it is filed under, and the one whose spread it is judged against. */
  genre: Genre;
  source: Genre;
  code: string;
  payload: Record<string, unknown>;
  artist: string;
  title: string;
  work: string;
  workAliases: string[];
  before: number | null;
  facts?: VideoFacts;
  annotation?: Annotation;
  lookups?: FameFacts;
  fame?: BlindtestFame;
  /** The chorus of the song a work's clip plays, when its clip may be placed again. */
  chorus?: ChorusInfo | null;
  /** What the run does with it. See `planRescore`. */
  plan?: RescorePlan;
}

function toRow(view: MediaView): Row | null {
  const genre = view.category ? genreById.get(view.category) : undefined;
  const payload = (view.payload ?? {}) as Record<string, unknown>;
  const code = typeof payload.code === 'string' ? payload.code : '';
  if (!genre || !code) return null;

  const answer = (key: string) => view.answers.find((field) => field.key === key);
  return {
    view,
    genre,
    source: sourceGenreFor(genre),
    code,
    payload,
    artist: answer('artist')?.value ?? '',
    title: answer('title')?.value ?? '',
    work: answer('work')?.value ?? '',
    workAliases: answer('work')?.aliases ?? [],
    before: typeof payload.difficulty === 'number' ? payload.difficulty : null
  };
}

function loadRows(options: Options): { rows: Row[]; unknown: MediaView[] } {
  const views = db
    .select()
    .from(media)
    .where(and(isNull(media.user_id), eq(media.kind, 'blindtest')))
    .all()
    .map(toMediaView);
  const rows: Row[] = [];
  const unknown: MediaView[] = [];
  for (const view of views) {
    const row = toRow(view);
    if (!row) {
      unknown.push(view);
      continue;
    }
    if (options.genres.size > 0 && !options.genres.has(row.genre.id) && !options.genres.has(row.source.id)) continue;
    rows.push(row);
  }
  rows.sort((left, right) => left.view.id - right.view.id);
  return { rows: options.limit ? rows.slice(0, options.limit) : rows, unknown };
}

/** A whole run: every genre, every round. Only such a run fits and saves the spreads. */
const isPartial = (options: Options) => options.genres.size > 0 || options.limit !== null;

/* -------------------------------------------------------------- figures */

/** Runs `work` over `items`, `limit` at a time. */
async function pool<T>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        await work(items[index], index);
      }
    })
  );
}

function progress(label: string, done: number, total: number): void {
  if (done === total || done % 50 === 0) process.stderr.write(`\r${label} ${done}/${total}   `);
  if (done === total) process.stderr.write('\n');
}

async function fetchFacts(rows: Row[]): Promise<number> {
  if (!env.GOOGLE_API_KEY) {
    console.warn('GOOGLE_API_KEY is not set: no view counts or lengths, and no clip is placed again.');
    return 0;
  }
  const facts = await fetchVideoFacts(rows.map((row) => row.code));
  let missing = 0;
  for (const row of rows) {
    row.facts = facts.get(row.code);
    if (!row.facts) missing += 1;
  }
  return missing;
}

/** The model's reading again, for its difficulty, whether it knew the answer, and a work's song. */
async function askModel(rows: Row[]): Promise<void> {
  const byGenre = new Map<Genre, Row[]>();
  for (const row of rows) {
    if (!row.facts) continue;
    byGenre.set(row.source, [...(byGenre.get(row.source) ?? []), row]);
  }
  let done = 0;
  for (const [genre, group] of byGenre) {
    const read = await annotateCandidates(
      group.map((row) => ({ videoId: row.code, title: row.facts!.title, channel: row.facts!.channel })),
      genre.answerShape,
      genre.label,
      undefined,
      genre.modelNote
    );
    for (const row of group) row.annotation = read.get(row.code);
    done += group.length;
    progress('model', done, rows.length);
  }
}

/** Each genre's seeds, which know how its tracks and works rank in their source. */
function oracles(rows: Row[]): Map<string, GenreOracle> {
  const built = new Map<string, GenreOracle>();
  for (const genreId of new Set(rows.map((row) => row.source.id))) {
    const seeds = db
      .select({
        artist: blindtestSeeds.artist,
        title: blindtestSeeds.title,
        aliases: blindtestSeeds.aliases,
        fame: blindtestSeeds.fame,
        year: blindtestSeeds.year,
        duration: blindtestSeeds.duration,
        source: blindtestSeeds.source,
        source_key: blindtestSeeds.source_key
      })
      .from(blindtestSeeds)
      .where(eq(blindtestSeeds.genre_id, genreId))
      .all();
    built.set(
      genreId,
      buildOracle(
        seeds.map((seed) => {
          let aliases: string[] = [];
          try {
            const parsed: unknown = JSON.parse(seed.aliases);
            if (Array.isArray(parsed)) aliases = parsed.filter((alias): alias is string => typeof alias === 'string');
          } catch {
            // An unreadable alias list is a seed with one name, nothing worse.
          }
          return { ...seed, aliases };
        })
      )
    );
  }
  return built;
}

async function lookUp(rows: Row[], options: Options): Promise<void> {
  const seeds = oracles(rows);
  let done = 0;
  await pool(rows, options.concurrency, async (row) => {
    const oracle = seeds.get(row.source.id);
    const stored = (row.payload.fame ?? {}) as BlindtestFame;
    let seedFame: number | null = typeof stored.seedFame === 'number' ? stored.seedFame : null;

    if (row.source.answerShape === 'artist-title') {
      seedFame ??= oracle?.tracks.get(trackOracleKey(row.artist, row.title))?.fame ?? null;
      if (row.artist && row.title) {
        row.lookups = await lookupFame(
          db,
          httpSources.fame,
          { shape: 'artist-title', artist: row.artist, title: row.title, piece: row.source.pieceFame },
          { refresh: options.refresh }
        );
      }
    } else if (row.source.workKind && row.work) {
      const seed = oracle?.works.get(normalizeAnswer(row.work));
      seedFame ??= seed?.fame ?? null;
      row.lookups = await lookupFame(
        db,
        httpSources.fame,
        {
          shape: 'work',
          kind: row.source.workKind,
          work: row.work,
          names: [...row.workAliases, ...(seed?.names ?? [])],
          wikidataId: stored.ids?.wikidata ?? seed?.wikidataId ?? null
        },
        { refresh: options.refresh }
      );
    }

    const model = row.annotation?.difficulty ?? (typeof stored.model === 'number' ? stored.model : null);
    const recognised =
      row.annotation?.recognised ?? (typeof stored.recognised === 'boolean' ? stored.recognised : null);
    row.fame = fameFromFacts(row.lookups ?? null, {
      views: row.facts?.views ?? (typeof stored.views === 'number' ? stored.views : null),
      upload: row.facts ? uploadKind(row.facts.channel, row.facts.title) : (stored.upload ?? null),
      seedFame,
      model,
      recognised
    });
    progress('catalogues', ++done, rows.length);
  });
}

/* ------------------------------------------------------------- scoring */

/**
 * The chorus of the song each work's clip plays, where the clip may be placed
 * again: found the way the draw finds it, and fetched here because the plan
 * itself asks nothing of the network.
 */
async function fetchChoruses(rows: Row[], options: Options): Promise<void> {
  if (!options.retime) return;
  const due = rows.filter(
    (row) =>
      row.source.answerShape === 'work' &&
      row.facts?.durationSeconds &&
      placedAgain(row.genre) &&
      row.payload.timingBy !== 'human' &&
      (options.includeEdited ||
        row.payload.timingBy !== undefined ||
        !editedSinceFiled(row.view.created_at, row.view.last_modified))
  );
  let done = 0;
  await pool(due, options.concurrency, async (row) => {
    const song = themeSongOf(
      {
        song: row.annotation?.song ?? '',
        songArtist: row.annotation?.songArtist ?? '',
        videoTitle: row.facts!.title,
        fame: row.lookups ?? null
      },
      row.genre
    );
    row.chorus = song ? await httpSources.lyrics(song.artist, song.title) : null;
    progress('choruses', ++done, due.length);
  });
}

function plan(rows: Row[], options: Options): FittedCalibration | null {
  const result = planRescore(
    rows.map((row) => ({
      id: row.view.id,
      genre: row.genre,
      payload: row.payload,
      createdAt: row.view.created_at,
      lastModified: row.view.last_modified,
      fame: row.fame ?? null,
      durationSeconds: row.facts?.durationSeconds ?? null,
      upload: row.facts ? uploadKind(row.facts.channel, row.facts.title) : 'video',
      chorus: row.chorus ?? null,
      hintFraction: row.annotation?.hookFraction ?? null
    })),
    {
      includeEdited: options.includeEdited,
      partial: isPartial(options),
      retime: options.retime,
      stored: readCalibrations(db)
    }
  );
  result.rows.forEach((planned, index) => {
    rows[index].plan = planned;
  });
  return result.calibration;
}

/* -------------------------------------------------------------- report */

function nameOf(row: Row): string {
  return row.work || `${row.artist} - ${row.title}`;
}

function bucketsOf(values: number[]): number[] {
  const buckets = Array.from({ length: 10 }, () => 0);
  for (const value of values) buckets[Math.min(9, Math.floor(value / 10))] += 1;
  return buckets;
}

function histogram(label: string, before: number[], after: number[]): void {
  const left = bucketsOf(before);
  const right = bucketsOf(after);
  const top = Math.max(1, ...left, ...right);
  const bar = (count: number) => '█'.repeat(Math.round((count / top) * 24)).padEnd(24);
  console.log(`\n  ${label}   before (${before.length})${' '.repeat(18)}after (${after.length})`);
  for (let bucket = 0; bucket < 10; bucket++) {
    const range = `${String(bucket * 10).padStart(2)}-${bucket === 9 ? 100 : bucket * 10 + 9}`.padEnd(7);
    console.log(
      `    ${range} ${bar(left[bucket])} ${String(left[bucket]).padStart(4)}   ${bar(right[bucket])} ${String(right[bucket]).padStart(4)}`
    );
  }
}

const fmt = (value: number | null | undefined) => (typeof value === 'number' ? value.toFixed(2) : '   -');

/** One round as the report lists it. A kept round says so, beside what it would have become. */
function line(row: Row): string {
  const score = row.plan?.score;
  const result = score ? String(score.difficulty).padStart(3) : '  -';
  const kept = row.payload.difficultyBy === 'human' ? 'by hand' : 'edited';
  const rule = row.plan?.keepDifficulty ? ` [kept, ${kept}]` : score?.rule ? ` [${score.rule}]` : '';
  return (
    `    ${String(row.before ?? '-').padStart(3)} → ${result}${rule.padEnd(18)} ${row.genre.id.padEnd(14)} ` +
    `fr ${fmt(score?.french)}  int ${fmt(score?.international)}  ${nameOf(row)}`
  );
}

/** Cases with a known right answer, to check the scale against before writing. */
const ANCHORS: { label: string; expect: string; match: (row: Row) => boolean }[] = [
  { label: 'Bob Marley, reggae', expect: '1-5', match: (row) => /bob marley/i.test(row.artist) },
  {
    label: 'Metallica - Enter Sandman, metal',
    expect: '1-5',
    match: (row) => /metallica/i.test(row.artist) && /enter sandman/i.test(row.title)
  },
  {
    label: 'Queen - Bohemian Rhapsody',
    expect: '1-20',
    match: (row) => /queen/i.test(row.artist) && /bohemian/i.test(row.title)
  },
  {
    label: 'Michael Jackson - Billie Jean',
    expect: '1-20',
    match: (row) => /michael jackson/i.test(row.artist) && /billie jean/i.test(row.title)
  },
  { label: 'Star Wars', expect: '1-20', match: (row) => /star wars/i.test(row.work) },
  {
    label: 'QQ, IQ - Movie, reggae',
    expect: '85-90',
    match: (row) => /\bqq\b/i.test(row.artist) && /movie/i.test(row.title)
  }
];

function report(rows: Row[], unknown: MediaView[], missing: number, fitted: FittedCalibration | null) {
  const scored = rows.filter((row) => row.plan?.score && !row.plan.keepDifficulty);
  const human = rows.filter((row) => row.payload.difficultyBy === 'human');
  const heldEdited = rows.filter(
    (row) => row.plan?.keepDifficulty && row.payload.difficultyBy !== 'human' && row.plan.score
  );

  console.log('\n== Catalogue');
  if (!fitted) console.log('  partial run: scored against the spreads already saved, and none saved');
  console.log(`  ${rows.length} rounds, ${scored.length} rescored`);
  console.log(`  ${human.length} set by hand, left alone`);
  console.log(`  ${heldEdited.length} edited before hand edits were marked, left alone (see below; --include-edited)`);
  console.log(`  ${missing} whose video YouTube no longer returns (scored without views, clip left alone)`);
  console.log(`  ${unknown.length} with no known genre or no video, skipped`);

  console.log('\n== Difficulty by genre');
  const byGenre = new Map<string, Row[]>();
  for (const row of rows) byGenre.set(row.source.id, [...(byGenre.get(row.source.id) ?? []), row]);
  for (const [genreId, group] of [...byGenre].sort(([left], [right]) => left.localeCompare(right))) {
    const own = fitted?.get(genreId)?.composite;
    const spread = !fitted ? 'saved spread' : own ? `fitted on ${own.samples}` : 'shape-wide or default spread';
    histogram(
      `${genreId} (${spread})`,
      group.map((row) => row.before).filter((value): value is number => value !== null),
      group.map((row) => row.plan?.difficulty ?? null).filter((value): value is number => value !== null)
    );
  }

  console.log('\n== Anchors (expected range in brackets)');
  for (const anchor of ANCHORS) {
    const found = rows.filter(anchor.match);
    if (found.length === 0) {
      console.log(`  ${anchor.label} [${anchor.expect}]: not in the catalogue`);
      continue;
    }
    console.log(`  ${anchor.label} [${anchor.expect}]`);
    for (const row of found.slice(0, 5)) console.log(line(row));
  }

  const moved = (row: Row) => Math.abs((row.plan?.difficulty ?? 0) - (row.before ?? 0));
  const moves = scored
    .filter((row) => row.before !== null && moved(row) >= 25)
    .sort((left, right) => moved(right) - moved(left));
  console.log(`\n== Biggest moves (${moves.length} by 25 points or more)`);
  for (const row of moves.slice(0, 60)) console.log(line(row));
  if (moves.length > 60) console.log(`    … ${moves.length - 60} more in --report`);

  if (heldEdited.length > 0) {
    console.log(`\n== Edited since filed, left alone (${heldEdited.length}); what they would become`);
    for (const row of heldEdited.slice(0, 60)) console.log(line(row));
    if (heldEdited.length > 60) console.log(`    … ${heldEdited.length - 60} more in --report`);
  }

  const retimed = rows.filter((row) => row.plan?.clip);
  console.log(`\n== Clips placed again: ${retimed.length}`);
  for (const row of retimed.slice(0, 15)) {
    const clip = row.plan!.clip!;
    const was = `${String(row.payload.startGuess)}-${String(row.payload.endGuess)}s`;
    console.log(
      `    ${was.padEnd(10)} → ${`${clip.startGuess}-${clip.endGuess}s`.padEnd(10)} ${row.genre.id.padEnd(14)} ${clip.angle}/${clip.source}  ${nameOf(row)}`
    );
  }
}

function writeReport(file: string, rows: Row[]): void {
  const data = rows.map((row) => ({
    id: row.view.id,
    genre: row.genre.id,
    answer: nameOf(row),
    code: row.code,
    edited: row.plan?.edited ?? false,
    keptDifficulty: row.plan?.keepDifficulty ?? false,
    keptTiming: row.plan?.keepTiming ?? false,
    before: row.before,
    after: row.plan?.difficulty ?? null,
    score: row.plan?.score ?? null,
    fame: row.fame,
    clipBefore: { startGuess: row.payload.startGuess, endGuess: row.payload.endGuess },
    clipAfter: row.plan?.clip ?? null
  }));
  writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`\nReport written to ${file}`);
}

/* ---------------------------------------------------------------- write */

function save(rows: Row[], fitted: FittedCalibration | null): number {
  let written = 0;
  db.transaction((tx) => {
    for (const row of rows) {
      if (!row.plan) continue;
      const payload = applyPlan(row.payload, row.plan, row.fame ?? null);
      if (payload === row.payload) continue;
      // `last_modified` is left alone on purpose: it is how the next run tells
      // a person's edit from this one.
      tx.update(media)
        .set({ payload: JSON.stringify(payload) })
        .where(eq(media.id, row.view.id))
        .run();
      written += 1;
    }
  });
  // Null on a partial run, whose spreads would be the spreads of what it read.
  if (fitted) writeCalibrations(db, fitted);
  return written;
}

/* ----------------------------------------------------------------- main */

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const { rows, unknown } = loadRows(options);
  if (rows.length === 0) {
    console.log('No catalogue rounds to rescore.');
    return 0;
  }
  console.log(`${rows.length} catalogue rounds${options.write ? '' : ' (dry run: nothing is written)'}`);
  if (!env.LASTFM_API_KEY) console.warn('LASTFM_API_KEY is not set: no Last.fm listeners.');
  if (!env.TMDB_API_KEY) console.warn('TMDB_API_KEY is not set: no TMDB votes for films and series.');

  const missing = await fetchFacts(rows);
  if (options.withModel) await askModel(rows);
  await lookUp(rows, options);
  await fetchChoruses(rows, options);
  const fitted = plan(rows, options);

  report(rows, unknown, missing, fitted);
  if (options.report) writeReport(options.report, rows);

  if (!options.write) {
    console.log('\nDry run: nothing was written. Run again with --write to save it.');
    return 0;
  }
  const written = save(rows, fitted);
  console.log(`\nSaved ${written} rounds${fitted ? ' and the genre spreads' : ''}.`);
  return 0;
}

main()
  .then((code) => {
    closeDb();
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    closeDb();
    process.exit(1);
  });
