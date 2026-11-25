/* eslint-disable no-console -- a CLI's output is its interface */
import { writeFileSync } from 'node:fs';

import { closeDb, db } from '../db/index.js';
import { env } from '../env.js';
import { liveReplaceDeps, proposeForFlaggedIn } from '../services/blindtest-video-replace.js';

/**
 * Finds the real video of the catalogue rounds the audit flagged, and proposes it.
 *
 * Each round in doubt (`videoDoubt`, see `blindtest-video-audit`) with no
 * proposal yet is searched for on YouTube, its candidates screened, ranked and
 * read by the model; the best is filed on the round as `videoProposal`, which
 * the catalogue editor shows under "Wrong video" for an admin to accept or
 * refuse in one click. The video itself is never changed here.
 *
 *   pnpm --filter back blindtest:video-replace                 # report only
 *   pnpm --filter back blindtest:video-replace --write         # and file the proposals
 *   ... --limit 20 --report replace.json
 *
 * Up to two searches (two hundred units) per round, out of the day's budget:
 * it stops when the budget is spent. A dry run spends them too, since the
 * searching is the point; `--limit` is what bounds it.
 */

interface Options {
  write: boolean;
  limit: number;
  report: string | null;
}

function parseOptions(argv: string[]): Options {
  const options: Options = { write: false, limit: 10, report: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--write') options.write = true;
    else if (flag === '--limit') options.limit = Number(argv[++index]);
    else if (flag === '--report') options.report = argv[++index] ?? null;
    else {
      console.error('usage: blindtest-video-replace [--write] [--limit <n>] [--report <file>]');
      process.exit(2);
    }
  }
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    console.error('--limit takes a positive whole number');
    process.exit(2);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!env.GOOGLE_API_KEY) {
    console.error('GOOGLE_API_KEY is not set: nothing can be searched.');
    process.exit(1);
  }

  const report = await proposeForFlaggedIn(db, liveReplaceDeps(db), {
    limit: options.limit,
    write: options.write,
    log: { info: (message) => console.log(`  ${message}`) }
  });

  console.log(
    `\n${report.tried} rounds tried: ${report.proposed} proposals, ${report.none} with nothing better, ${report.deferred} deferred`
  );
  for (const result of report.results) {
    if (result.proposal) {
      const { code, title, channel, score, reason } = result.proposal;
      console.log(`  #${result.id} ${result.code} -> ${code} "${title}" [${channel}] (${score}: ${reason})`);
    }
  }

  if (options.report) {
    writeFileSync(options.report, JSON.stringify(report, null, 2));
    console.log(`\nreport written to ${options.report}`);
  }
  if (!options.write) console.log('\nDry run: nothing written. Again with --write to file the proposals.');
}

await main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
