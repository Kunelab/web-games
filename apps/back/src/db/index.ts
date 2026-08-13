import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { databaseFile, env } from '../env.js';
import { bootstrapSchema } from './bootstrap.js';
import { migrateToMedia } from './migrate-to-media.js';
import * as schema from './schema.js';

mkdirSync(dirname(databaseFile), { recursive: true });

export const sqlite = new Database(databaseFile);

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
export const mediaMigration = migrateToMedia(sqlite);

export const db = drizzle(sqlite, {
  schema,
  logger: env.DEBUG
});

export type Db = typeof db;

export function closeDb(): void {
  sqlite.close();
}
