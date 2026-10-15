import { databaseFile, env } from '../env.js';
import { openDb } from './open.js';

const opened = openDb(databaseFile, { logger: env.DEBUG });

export const sqlite = opened.sqlite;

/** Legacy Videos/Images copied into Media on this boot; see `openDb`. */
export const mediaMigration = opened.mediaMigration;

export const db = opened.db;

export type { Db } from './open.js';
export { openDb };

export function closeDb(): void {
  sqlite.close();
}
