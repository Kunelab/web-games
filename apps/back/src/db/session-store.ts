import type { SessionStore } from '@fastify/session';
import { eq, lt, sql } from 'drizzle-orm';
import type { Session } from 'fastify';

import { db } from './index.js';
import { sessions } from './schema.js';

type Callback = (err?: unknown) => void;
type CallbackSession = (err: unknown, result?: Session | null) => void;

/**
 * SQLite-backed session store for `@fastify/session`.
 *
 * The old stack installed `express-session-sqlite` but never passed a store to
 * `express-session`, so it silently used MemoryStore: every deploy or crash
 * logged every player out mid-game. Sessions now live in the same database file
 * as everything else.
 *
 * The better-sqlite3 driver is synchronous, so the callbacks below always fire
 * before the method returns. That is fine, and it is what the interface allows.
 */
export class SqliteSessionStore implements SessionStore {
  private readonly ttlMs: number;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  set(sessionId: string, session: Session, callback: Callback): void {
    try {
      const expiresAt = expiryOf(session) ?? Date.now() + this.ttlMs;
      const data = JSON.stringify(session);

      db.insert(sessions)
        .values({ sid: sessionId, expiresAt, data })
        .onConflictDoUpdate({
          target: sessions.sid,
          set: { expiresAt, data }
        })
        .run();

      callback();
    } catch (error) {
      callback(asError(error));
    }
  }

  /**
   * Reads a session, and is careful about which failures destroy one.
   *
   * The two are not the same and used to share a `catch`. A row whose JSON cannot
   * be parsed is genuinely unusable, and dropping it is right — the browser gets a
   * fresh session and notices nothing. A failure to *read* the table is a fact
   * about the database, not about the row: under `SQLITE_BUSY`, or an I/O error on
   * a tired disk, the old code deleted a perfectly good session and signed
   * somebody out for a hiccup that had already passed.
   *
   * So only the parse drops the row, and it answers with no session rather than an
   * error, because handing `@fastify/session` an error makes it `done(err)` — the
   * hard 500 the comment here used to claim it was avoiding. A read failure is
   * reported as what it is and touches nothing.
   */
  get(sessionId: string, callback: CallbackSession): void {
    let row;
    try {
      [row] = db.select().from(sessions).where(eq(sessions.sid, sessionId)).limit(1).all();
    } catch (error) {
      callback(asError(error), null);
      return;
    }

    if (!row) {
      callback(null, null);
      return;
    }

    if (row.expiresAt <= Date.now()) {
      this.forget(sessionId);
      callback(null, null);
      return;
    }

    try {
      callback(null, JSON.parse(row.data) as Session);
    } catch {
      // Unreadable, so it may as well not exist: drop it and let the caller
      // start a new one.
      this.forget(sessionId);
      callback(null, null);
    }
  }

  /**
   * Deletes a row, swallowing a failure to do so.
   *
   * Used on the paths that have already decided to answer "no session". If the
   * delete cannot happen the answer is unchanged and the row will age out on the
   * sweep, so letting the error escape would only turn a recovered request into a
   * failed one.
   */
  private forget(sessionId: string): void {
    try {
      db.delete(sessions).where(eq(sessions.sid, sessionId)).run();
    } catch {
      // See above.
    }
  }

  destroy(sessionId: string, callback: Callback): void {
    try {
      db.delete(sessions).where(eq(sessions.sid, sessionId)).run();
      callback();
    } catch (error) {
      callback(asError(error));
    }
  }

  /**
   * Signs one account out everywhere, optionally sparing the session asking.
   *
   * Changing a password should end every other session the account has — that is
   * the whole point of changing it after a scare — and `regenerate()` cannot do
   * that: it re-issues the caller's own cookie and knows nothing about the phone
   * still logged in on the other side of the room.
   *
   * The owner is read out of the stored JSON rather than kept in a column of its
   * own, so this needs no migration on a table that already holds live sessions.
   */
  destroyForUser(userId: number, exceptSid?: string): number {
    const result = db
      .delete(sessions)
      .where(
        exceptSid === undefined
          ? sql`json_extract(${sessions.data}, '$.user.id') = ${userId}`
          : sql`json_extract(${sessions.data}, '$.user.id') = ${userId} and ${sessions.sid} <> ${exceptSid}`
      )
      .run();

    return result.changes;
  }

  /** Deletes expired rows now, then hourly. */
  startSweeping(): void {
    this.sweep();
    this.sweepTimer = setInterval(() => this.sweep(), 60 * 60 * 1000);
    this.sweepTimer.unref();
  }

  stopSweeping(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  private sweep(): void {
    db.delete(sessions).where(lt(sessions.expiresAt, Date.now())).run();
  }
}

/** Reads the cookie expiry the session middleware attached, if any. */
function expiryOf(session: Session): number | undefined {
  const expires = session.cookie?.expires;
  if (!expires) return undefined;
  const timestamp = new Date(expires).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
