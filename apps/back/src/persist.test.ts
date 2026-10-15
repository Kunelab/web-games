import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { FastifyBaseLogger } from 'fastify';

import { CodeRegistry } from './tables/codes.js';

/**
 * A failed save is logged, never fatal.
 *
 * Every table saves itself without waiting on the result: a heartbeat, a kick,
 * a bot joining all end in `void persist(state)`. `server.ts` shuts the whole
 * process down on an unhandled rejection, so a save that rejects there takes
 * every room on the server with it, over one write that would have been
 * retried on the next change anyway. Mafia caught its own; the quiz and the
 * raid did not.
 *
 * The database is opened at import, so the same trick the smoke runner uses:
 * point at a throwaway file, then import dynamically.
 */
const directory = mkdtempSync(join(tmpdir(), 'kune-persist-test-'));
process.env.DATABASE_FILE = join(directory, 'test.db');
process.env.SECRET ??= 'persist-test-secret-that-is-long-enough-to-pass';
process.env.NODE_ENV = 'test';

process.on('exit', () => {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // A leftover temp file is not worth failing a passing run over.
  }
});

const { sqlite } = await import('./db/index.js');
const { GameManager } = await import('./game/manager.js');
const { CzManager } = await import('./zombie/manager.js');

const quiet = () => undefined;
function recordingLog(errors: unknown[]): FastifyBaseLogger {
  const log = {
    info: quiet,
    warn: quiet,
    error: (...args: unknown[]) => errors.push(args),
    debug: quiet,
    fatal: quiet,
    trace: quiet,
    silent: quiet,
    level: 'silent',
    child() {
      return log;
    }
  } as unknown as FastifyBaseLogger;
  return log;
}

/** Every write refused, the way a full disk or a locked file refuses it. */
function refuseWrites(): void {
  sqlite.pragma('query_only = ON');
}

describe('a failed save', () => {
  after(() => sqlite.pragma('query_only = OFF'));

  it('is logged by the quiz rather than thrown', async () => {
    const errors: unknown[] = [];
    const games = new GameManager(recordingLog(errors), { codes: new CodeRegistry() });
    const state = await games.create({ playlistId: null, playlistName: 'Persist', hostUserId: null, items: [] });

    refuseWrites();
    await assert.doesNotReject(games.persist(state));
    assert.equal(errors.length, 1);
    sqlite.pragma('query_only = OFF');
  });

  it('is logged by the raid rather than thrown', async () => {
    const errors: unknown[] = [];
    const raids = new CzManager(recordingLog(errors), { codes: new CodeRegistry() });
    const state = await raids.create({ hostUserId: null, config: {} });

    refuseWrites();
    await assert.doesNotReject(raids.persist(state));
    assert.equal(errors.length, 1);
    sqlite.pragma('query_only = OFF');
  });
});
