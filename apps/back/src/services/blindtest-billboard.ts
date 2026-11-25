import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { normalizeAnswer } from 'game-core';
import { z } from 'zod';

import { bareTitle, mainArtist, sameArtist } from './blindtest-fame.js';

/**
 * The US Billboard Hot 100, every week since it began, as a lookup by song.
 *
 * Streaming counts and today's listeners favour what came out since streaming:
 * "Hey Jude" ranks below a TikTok hit of last spring, yet every room knows it.
 * What the Hot 100 says is how big a song was when it came out, which is fair
 * to the Beatles and to Gotye alike. So the blind test's difficulty can read a
 * song's best peak, how many weeks it charted and the year it first did.
 *
 * The source is the free, full history kept by mhollingshead/billboard-hot-100
 * on GitHub: one JSON file (`all.json`, about 44 MB in late 2026) holding every
 * weekly chart since 4 August 1958, updated daily. It is far too big to keep
 * around for a lookup, so `refreshBillboard` downloads it now and then and
 * boils it down to a compact index (one entry per credit and title, about
 * 33,000 of them), written to disk as JSON, which `loadBillboard` reads back.
 */

/** Where the full history lives: the raw file of the repository's default branch. */
export const BILLBOARD_URL = 'https://raw.githubusercontent.com/mhollingshead/billboard-hot-100/main/all.json';

/** Who is asking, as `blindtest-sources` tells the services it calls. */
const USER_AGENT = 'KuneLabWebGames/0.3 (blind test billboard; https://github.com/Kunelab)';

/** The whole history is one file of tens of megabytes, so it gets longer than a call. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a song did on the Hot 100, all its runs together. */
export interface BillboardRun {
  /** Its best position, 1 being the top. */
  peak: number;
  /** How many weekly charts it was on. */
  weeks: number;
  /** The year of the first chart it was on. */
  firstYear: number;
}

/**
 * One charting credit and title: the artists it can be found under (the whole
 * credit, normalized, then each performer in it), joined by `|`, which a
 * normalized name never contains; then its peak, weeks and first year.
 */
type BillboardEntry = [artists: string, peak: number, weeks: number, firstYear: number];

/**
 * The compact form of the whole history, as written to disk.
 *
 * `titles` maps a normalized title to the indexes of the entries charting
 * under it in `entries`. One entry can sit under several titles ("Bicycle
 * Race/Fat Bottomed Girls" under each side, "(I Can't Get No) Satisfaction"
 * under "Satisfaction" too), and indexes keep a lookup from counting it twice.
 */
export interface BillboardIndex {
  version: 1;
  /** When the index was built, as an ISO timestamp. */
  builtAt: string;
  /** The first and last chart dates of the history it was built from. */
  firstChart: string;
  lastChart: string;
  entries: BillboardEntry[];
  titles: Record<string, number[]>;
}

const indexSchema = z.object({
  version: z.literal(1),
  builtAt: z.string(),
  firstChart: z.string(),
  lastChart: z.string(),
  entries: z.array(z.tuple([z.string(), z.number().int(), z.number().int(), z.number().int()])),
  titles: z.record(z.string(), z.array(z.number().int().nonnegative()))
});

/** One weekly chart of `all.json`. Only the fields the index reads are checked. */
const chartsSchema = z
  .array(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      data: z.array(
        z.object({
          song: z.string(),
          artist: z.string(),
          this_week: z.number().int().positive()
        })
      )
    })
  )
  .min(1);

export type BillboardCharts = z.infer<typeof chartsSchema>;

/* ---------------------------------------------------------------- names */

/**
 * What separates performers in a Billboard credit: "Gotye Featuring Kimbra",
 * "Beyonce & Jay-Z", "Lil Nas X x Billy Ray Cyrus", "Lil Nas X & Cardi B Or
 * Nas". The separators of `mainArtist`, and "Or".
 */
const PERFORMER_SEPARATOR =
  /\s*(?:,|&|\+|;|\/|\bfeat\.?|\bft\.?|\bfeaturing\b|\bx\b|\bvs\.?|\bwith\b|\band\b|\bor\b|\bduet\b)\s*/i;

/**
 * The names a credit can be looked up under: the whole of it, so "Earth, Wind
 * & Fire" stays itself, then every performer in it, so "Beyonce Featuring Jay
 * Z" is Jay-Z's song as well as Beyoncé's.
 */
function artistNames(credit: string): string[] {
  const names = [credit, mainArtist(credit), ...credit.split(PERFORMER_SEPARATOR)]
    .map((name) => normalizeAnswer(name))
    .filter((name) => name.length > 0);
  return [...new Set(names)];
}

/**
 * The keys a title is filed under: as it is (without version noise, see
 * `bareTitle`), without what is in brackets, and each side of a double A-side
 * ("Bicycle Race/Fat Bottomed Girls"). A side is a key only when long enough
 * to be a title rather than the "7" of "24/7".
 */
function titleKeys(title: string): string[] {
  const keys = [bareTitle(title), bareTitle(title.replace(/\s*[([].*?[)\]]/g, ' '))];
  if (title.includes('/')) {
    for (const side of title.split('/')) {
      const key = bareTitle(side);
      if (key.length >= 4) keys.push(key);
    }
  }
  return [...new Set(keys.filter((key) => key.length > 0))];
}

/* ---------------------------------------------------------------- index */

/**
 * The compact index of a full history. Pure, for the tests.
 *
 * A credit and title is one entry however many runs it had: its best position
 * over all of them, every week it was on the chart and the year of the first.
 */
export function buildBillboardIndex(charts: BillboardCharts, builtAt = new Date()): BillboardIndex {
  const runs = new Map<string, { credit: string; song: string; peak: number; weeks: number; firstYear: number }>();
  let firstChart = '';
  let lastChart = '';
  for (const chart of charts) {
    if (!firstChart || chart.date < firstChart) firstChart = chart.date;
    if (chart.date > lastChart) lastChart = chart.date;
    const year = Number(chart.date.slice(0, 4));
    for (const row of chart.data) {
      const key = `${row.artist}\u0000${row.song}`;
      const run = runs.get(key);
      if (run) {
        run.peak = Math.min(run.peak, row.this_week);
        run.weeks += 1;
        run.firstYear = Math.min(run.firstYear, year);
      } else {
        runs.set(key, { credit: row.artist, song: row.song, peak: row.this_week, weeks: 1, firstYear: year });
      }
    }
  }

  const entries: BillboardEntry[] = [];
  const titles: Record<string, number[]> = {};
  for (const run of runs.values()) {
    const artists = artistNames(run.credit);
    const keys = titleKeys(run.song);
    if (artists.length === 0 || keys.length === 0) continue;
    const at = entries.push([artists.join('|'), run.peak, run.weeks, run.firstYear]) - 1;
    for (const key of keys) (titles[key] ??= []).push(at);
  }
  return { version: 1, builtAt: builtAt.toISOString(), firstChart, lastChart, entries, titles };
}

/**
 * What the Hot 100 says of a song by an artist, or null when it never charted
 * (or not under that artist).
 *
 * The title is matched once normalized, and the artist is any name the credit
 * carries, as `sameArtist` compares them (or exactly the main artist of the
 * credit asked for): "Gotye" finds "Gotye Featuring
 * Kimbra", "Beyoncé" finds "Beyonce". A song of the same title by someone else
 * is never theirs. When several entries match (a song credited differently
 * over the years), the runs add up: the best peak, all the weeks, the earliest
 * year.
 */
export function billboardRun(index: BillboardIndex, artist: string, title: string): BillboardRun | null {
  if (normalizeAnswer(artist).length === 0) return null;
  // The main artist of a credit typed in full ("Beyoncé feat. Jay-Z"), only by
  // its exact name: "Simon" of "Simon & Garfunkel" is not Carly Simon.
  const main = normalizeAnswer(mainArtist(artist));

  const seen = new Set<number>();
  let result: BillboardRun | null = null;
  for (const key of titleKeys(title)) {
    for (const at of index.titles[key] ?? []) {
      if (seen.has(at)) continue;
      seen.add(at);
      const entry = index.entries[at];
      if (!entry) continue;
      const [artists, peak, weeks, firstYear] = entry;
      const names = artists.split('|');
      if (!names.some((name) => name === main || sameArtist(name, artist))) continue;
      result = result
        ? {
            peak: Math.min(result.peak, peak),
            weeks: result.weeks + weeks,
            firstYear: Math.min(result.firstYear, firstYear)
          }
        : { peak, weeks, firstYear };
    }
  }
  return result;
}

/* ---------------------------------------------------------------- files */

/** The index written to `file`, or null when there is none or it is not one. */
export function loadBillboard(file: string): BillboardIndex | null {
  try {
    const parsed = indexSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The full history from GitHub, checked. */
async function downloadCharts(): Promise<BillboardCharts> {
  const response = await fetch(BILLBOARD_URL, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Billboard history: HTTP ${response.status}`);
  return chartsSchema.parse(await response.json());
}

/** How old `file` is, in milliseconds, or null when it is not there. */
function ageOf(file: string): number | null {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The index at `file`, rebuilt from a fresh download when it is missing, not
 * readable or older than `maxAgeDays` (0: always).
 *
 * The new index replaces the old one in a single rename, so a reader never
 * sees half a file. When the download or its check fails, the old file is
 * left as it was and null is returned: the caller can still `loadBillboard`
 * it. `download` stands in for GitHub in the tests.
 */
export async function refreshBillboard(
  file: string,
  maxAgeDays = 7,
  download: () => Promise<BillboardCharts> = downloadCharts
): Promise<BillboardIndex | null> {
  const age = ageOf(file);
  if (maxAgeDays > 0 && age !== null && age < maxAgeDays * DAY_MS) {
    const current = loadBillboard(file);
    if (current) return current;
  }
  try {
    const index = buildBillboardIndex(chartsSchema.parse(await download()));
    mkdirSync(dirname(file), { recursive: true });
    const partial = `${file}.${process.pid}.tmp`;
    writeFileSync(partial, JSON.stringify(index));
    renameSync(partial, file);
    return index;
  } catch (error) {
    console.warn('[billboard] refresh failed, keeping the previous index:', error);
    return null;
  }
}
