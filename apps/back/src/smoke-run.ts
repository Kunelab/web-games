/**
 * Runs the smoke test against a throwaway database.
 *
 * The smoke test writes real rows, so pointing it at the development database
 * would leave a `smoke_1234567890` account and its media behind on every run. It
 * used to be up to whoever ran it to remember `DATABASE_FILE=./smoke.db`, which
 * is exactly the kind of thing that is remembered until it is not.
 *
 * This is a separate entry point rather than a few lines at the top of smoke.ts
 * because ES module imports are hoisted: anything set in the body of that file
 * runs after `./app.js` has already been evaluated, and opening the database is
 * one of the things that evaluation does. Setting the variable here and then
 * importing dynamically is what makes the order right.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import 'dotenv/config';

const directory = mkdtempSync(join(tmpdir(), 'kune-smoke-'));
process.env.DATABASE_FILE = join(directory, 'smoke.db');

// Only a default: a real SECRET in the environment still wins. Without this the
// test cannot run anywhere that has no .env, which includes a fresh checkout.
process.env.SECRET ??= 'smoke-test-secret-that-is-long-enough-to-pass';

/**
 * Quietens Fastify's per-request logging so the checks are the output.
 *
 * Set rather than defaulted, because `.env` has already been read by this point
 * and it says `development`. DEBUG=true still turns the whole log back on, which
 * is the escape hatch when a check fails and the request is what you need to see.
 */
process.env.NODE_ENV = 'test';

process.on('exit', () => {
  try {
    // WAL and shared-memory files sit beside the database, so the directory goes
    // rather than the file.
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    // A leftover file in the temp directory is not worth turning a passing run
    // into a failing one, so this reports rather than throws.
    console.warn(`could not remove ${directory}:`, error);
  }
});

await import('./smoke.js');
