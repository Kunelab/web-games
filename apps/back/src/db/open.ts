import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { bootstrapSchema } from './bootstrap.js';
import { migrateToMedia } from './migrate-to-media.js';
import * as schema from './schema.js';

/**
 * A database with the whole schema in it, ready to use.
 *
 * Apart from `index.ts`, which opens the app's own file at import, so that a
 * test can have a database without that file being touched: `openDb()` is a
 * fresh one in memory, bootstrapped and migrated exactly like the real one,
 * and gone when the test drops it. Nothing here reads the environment, for the
 * same reason.
 */
export function openDb(file = ':memory:', options: { logger?: boolean } = {}) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });

  const sqlite = new Database(file);

  // WAL lets readers run while a write is in flight, which matters once several
  // players are hitting the API during a game. `foreign_keys` is off by default
  // in SQLite and has to be enabled per connection.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  bootstrapSchema(sqlite);

  /**
   * Copies legacy Videos/Images rows into Media on first boot. Idempotent, and the
   * old tables are left untouched so this can be re-examined if it mapped anything
   * badly. The report is logged by the app once its logger exists.
   */
  const mediaMigration = migrateToMedia(sqlite);

  const db = drizzle(sqlite, { schema, logger: options.logger ?? false });
  return { sqlite, db, mediaMigration };
}

export type Db = ReturnType<typeof openDb>['db'];
