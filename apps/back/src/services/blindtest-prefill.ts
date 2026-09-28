import type { FastifyBaseLogger } from 'fastify';

import { apiSlots, env } from '../env.js';
import { GENRES, catalogAvailable, searchForCatalogue } from './blindtest-catalog.js';
import { catalogueRound } from './blindtest-draw.js';
import { indexCatalogueEntry } from './blindtest-duplicates.js';
import { countLibrary, libraryVideoCodes, rememberPlayedRound } from './blindtest-library.js';
import { quotaDay, searchesToday } from './youtube-budget.js';
import { playableIn } from './youtube-service.js';

/**
 * The day's unused searches, spent on the catalogue before they lapse.
 *
 * The YouTube quota is a daily allowance that resets at midnight Pacific (9:00
 * in Paris), and it does not carry over: an evening that played twenty rounds
 * left most of it unspent, and the catalogue only ever grew by what rooms had
 * played. So in the last hours before the reset, while nobody plays, this runs
 * seed searches until the budget is gone and files what they find straight
 * into `Tout (généré)`, ready to be replayed instantly by the next room.
 *
 * ## What it gives up, and what it keeps
 *
 * The catalogue used to hold only rounds a room had heard, which is a check
 * these rows have not had. What is kept of it: a round is filed only if a model
 * read the title (a run the model did not read keeps nothing and hands its
 * seeds back), only if it plays in this deployment's region, only once (the
 * same video id and the same recording are both refused), and it goes through
 * the duplicate index like every other entry, with the genre check reading it
 * too. The admin screen is where the rest of the vetting now happens.
 *
 * ## The budget
 *
 * Only the searches left in the current quota day, less a few kept for anybody
 * who starts a game before the reset. It stops the moment the Pacific day
 * changes, so a run that goes long never spends tomorrow's allowance. The
 * model calls it makes are the other cost: about two per search, a couple of
 * hundred on a full night, on the same endpoints the Mafia bots use, at an
 * hour when no table is playing.
 */

/** Searches left unspent for a game started in the last hours before the reset. */
const PREFILL_KEEP = 3;

/**
 * The pause between two filed rounds.
 *
 * Filing enriches each round (its chorus, its artist's other names, its year),
 * and MusicBrainz asks anonymous callers for about one request a second; AniList
 * allows thirty a minute. A room never came close, drawing one round at a time,
 * and a prefill filing a thousand would.
 */
const ENRICH_GAP_MS = 1_100;
const ANIME_ENRICH_GAP_MS = 2_200;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The clock in Los Angeles, which is the one Google resets the quota by. */
const PACIFIC_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});

/**
 * How long until the quota resets.
 *
 * Read off the Pacific wall clock, so it is an hour out on the two days a year
 * the clocks change. That is harmless: the run also stops on the quota day
 * itself changing (see `prefillCatalogue`), which is exact.
 */
export function msUntilQuotaReset(now = new Date()): number {
  const parts = Object.fromEntries(PACIFIC_CLOCK.formatToParts(now).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour) % 24;
  const elapsed = ((hour * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000 + now.getMilliseconds();
  return DAY_MS - elapsed;
}

export interface PrefillReport {
  startedAt: string;
  finishedAt: string | null;
  /** YouTube searches spent. */
  searches: number;
  /** New rows in the catalogue. */
  saved: number;
  byGenre: Record<string, number>;
  /** Why it stopped. */
  stopped: string;
}

let running: PrefillReport | null = null;
let lastReport: PrefillReport | null = null;

/** The run in progress, or the last one, for the diagnostics endpoint. */
export function prefillStatus(): { running: boolean; report: PrefillReport | null } {
  return { running: running !== null, report: running ?? lastReport };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Spends what is left of today's searches on the catalogue, now.
 *
 * Genre by genre, one search each in turn, the genres with the fewest
 * catalogue rows first, until the budget, the quota day or every genre's seeds
 * run out. One run at a time: a second call while one is going returns it.
 */
export async function prefillCatalogue(log?: FastifyBaseLogger): Promise<PrefillReport> {
  if (running) return running;

  const report: PrefillReport = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    searches: 0,
    saved: 0,
    byGenre: {},
    stopped: ''
  };
  running = report;
  const day = quotaDay();
  const budget = Math.max(0, env.BLINDTEST_SEARCH_BUDGET - PREFILL_KEEP);

  try {
    // A facet reads its parent's pool and has no seeds of its own.
    const genres = GENRES.filter((genre) => !genre.facetOf && genre.seeds && genre.seeds.length > 0);
    const stock = await countLibrary(
      genres.map((genre) => genre.id),
      { min: 0, max: 100 }
    );
    genres.sort((left, right) => (stock.get(left.id) ?? 0) - (stock.get(right.id) ?? 0));

    const spent = new Set<string>();
    rounds: for (;;) {
      let searched = false;
      for (const genre of genres) {
        if (spent.has(genre.id)) continue;
        if (quotaDay() !== day) {
          report.stopped = 'the quota day ended';
          break rounds;
        }
        if (searchesToday().used >= budget) {
          report.stopped = 'the budget is spent';
          break rounds;
        }

        const result = await searchForCatalogue(genre, budget);
        if (!result) {
          spent.add(genre.id);
          continue;
        }
        if (result.spent === 0) {
          report.stopped = 'the budget is spent';
          break rounds;
        }
        report.searches += result.spent;
        searched = true;
        if (result.modelDown) {
          report.stopped = 'no model answered';
          break rounds;
        }

        const before = (await libraryVideoCodes()).size;
        for (const entry of result.entries) {
          if (!playableIn(entry.restriction, env.YOUTUBE_REGION)) continue;
          const kept = await rememberPlayedRound(await catalogueRound(entry));
          if (kept) indexCatalogueEntry(kept);
          await pause(genre.section === 'anime' ? ANIME_ENRICH_GAP_MS : ENRICH_GAP_MS);
        }
        const added = (await libraryVideoCodes()).size - before;
        report.saved += added;
        report.byGenre[genre.id] = (report.byGenre[genre.id] ?? 0) + added;
      }
      if (!searched) {
        report.stopped ||= 'every genre has searched its seeds';
        break;
      }
    }
  } catch (error) {
    report.stopped = `failed: ${String(error).slice(0, 200)}`;
    log?.warn({ err: error }, 'blind test prefill failed');
  } finally {
    report.finishedAt = new Date().toISOString();
    lastReport = report;
    running = null;
  }

  log?.info(
    { searches: report.searches, saved: report.saved, byGenre: report.byGenre, stopped: report.stopped },
    'blind test prefill finished'
  );
  return report;
}

/**
 * Runs the prefill every day, `BLINDTEST_PREFILL_HOURS` before the reset.
 *
 * A boot inside the window starts it straight away, which matters on a box
 * that restarts after every power cut. Nothing is scheduled where it could not
 * work: no YouTube key, no model to read titles, or the setting at 0.
 */
export function schedulePrefill(log: FastifyBaseLogger): void {
  const lead = env.BLINDTEST_PREFILL_HOURS * 60 * 60 * 1000;
  if (lead <= 0 || !catalogAvailable() || apiSlots.length === 0) return;

  const later = (ms: number) => setTimeout(plan, Math.max(1_000, ms)).unref();
  function plan(): void {
    const toReset = msUntilQuotaReset();
    if (toReset > lead) {
      later(toReset - lead);
      return;
    }
    void prefillCatalogue(log).finally(() => {
      // Still inside today's window: wait out the reset. Past it (a long run):
      // straight to the next window, which waiting for a reset would skip.
      const left = msUntilQuotaReset();
      later(left <= lead ? left + 60_000 : left - lead);
    });
  }
  plan();
}
