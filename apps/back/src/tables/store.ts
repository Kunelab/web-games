import { eq, lt } from 'drizzle-orm';

import type { Db } from '../db/open.js';
import { gameSessions, type mafiaSessions, type zombieSessions } from '../db/schema.js';

/**
 * Where tables are written down between restarts.
 *
 * Synchronous on purpose. The driver underneath is better-sqlite3, which never
 * did anything asynchronously in the first place; the `await` the managers put
 * in front of every write only moved the write a microtask later, which is
 * exactly the gap a destroy could land in before a save. A save that has
 * happened by the time the call returns has nothing to race.
 */
export interface TableStore<R extends TableRow = TableRow> {
  /** Every saved table, in no particular order. */
  load(): StoredTable[];
  save(row: R): void;
  remove(code: string): void;
  /** Deletes every row untouched since `before`. */
  removeIdle(before: number): void;
}

/** One table as it is written: the engine's whole state as JSON, plus what is indexed. */
export interface TableRow {
  code: string;
  hostUserId: number | null;
  phase: string;
  state: string;
  lastActivityAt: number;
}

/** The quiz's table keeps three things in columns of their own. */
export interface QuizRow extends TableRow {
  playlistId: number | null;
  hostToken: string;
  /** JSON SessionConfig. */
  config: string;
}

/** One table as it is read back, before anybody has trusted a word of it. */
export interface StoredTable {
  code: string;
  lastActivityAt: number;
  state: string;
}

/** The row for a game whose table is nothing but its snapshot. */
export function snapshotRow(table: {
  code: string;
  hostUserId: number | null;
  phase: string;
  lastActivityAt: number;
}): TableRow {
  return {
    code: table.code,
    hostUserId: table.hostUserId,
    phase: table.phase,
    state: JSON.stringify(table),
    lastActivityAt: table.lastActivityAt
  };
}

/**
 * The raid's and Mafia's tables, which are the same table under two names.
 *
 * The one cast is honest for that reason: Drizzle types each table by its name,
 * and the two names are the only thing that differs.
 */
export function tableStore(db: Db, sessions: typeof zombieSessions | typeof mafiaSessions): TableStore {
  const table = sessions as typeof zombieSessions;

  return {
    load: () =>
      db
        .select()
        .from(table)
        .all()
        .map((row) => ({ code: row.code, lastActivityAt: row.last_activity_at, state: row.state })),

    save(row) {
      db.insert(table)
        .values({
          code: row.code,
          host_user_id: row.hostUserId,
          phase: row.phase,
          state: row.state,
          last_activity_at: row.lastActivityAt
        })
        .onConflictDoUpdate({
          target: table.code,
          set: { phase: row.phase, state: row.state, last_activity_at: row.lastActivityAt }
        })
        .run();
    },

    remove(code) {
      db.delete(table).where(eq(table.code, code)).run();
    },

    removeIdle(before) {
      db.delete(table).where(lt(table.last_activity_at, before)).run();
    }
  };
}

export function quizTableStore(db: Db): TableStore<QuizRow> {
  return {
    load: () =>
      db
        .select()
        .from(gameSessions)
        .all()
        .map((row) => ({ code: row.code, lastActivityAt: row.last_activity_at, state: row.state })),

    save(row) {
      db.insert(gameSessions)
        .values({
          code: row.code,
          playlist_id: row.playlistId,
          host_user_id: row.hostUserId,
          host_token: row.hostToken,
          phase: row.phase,
          config: row.config,
          state: row.state,
          last_activity_at: row.lastActivityAt
        })
        .onConflictDoUpdate({
          target: gameSessions.code,
          set: { phase: row.phase, config: row.config, state: row.state, last_activity_at: row.lastActivityAt }
        })
        .run();
    },

    remove(code) {
      db.delete(gameSessions).where(eq(gameSessions.code, code)).run();
    },

    removeIdle(before) {
      db.delete(gameSessions).where(lt(gameSessions.last_activity_at, before)).run();
    }
  };
}
