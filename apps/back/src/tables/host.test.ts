import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LobbyGame } from 'lobby-core';

import { handClock, type Clock } from '../clock.js';
import { openDb, type Db } from '../db/open.js';
import { zombieSessions } from '../db/schema.js';
import { CodeRegistry } from './codes.js';
import { TableHost, type TableAdapter } from './host.js';
import { snapshotRow, tableStore } from './store.js';

/**
 * The table host, through the interface the three game managers use.
 *
 * The games themselves are not here: a table is a toy with a phase and a
 * deadline, which is all the host is allowed to know about one. What is real is
 * everything the host touches on its own — a database in memory, a clock that
 * only moves when a test moves it, and a log that keeps what it is told.
 */

/** A table as small as the host lets one be. */
interface Toy {
  code: string;
  phase: string;
  hostUserId: number | null;
  lastActivityAt: number;
  /** When the phase ends on its own, or null for a phase that waits. */
  endsAt: number | null;
  /** Every phase a deadline has ended, in order. */
  ended: string[];
  /** A seat whose phone has stopped answering. */
  dark?: boolean;
  /** The clock, stopped, with what the phase had left on it. */
  paused?: { leftMs: number };
}

function toy(code: string, fields: Partial<Toy> = {}): Toy {
  return { code, phase: 'day', hostUserId: null, lastActivityAt: 0, endsAt: null, ended: [], ...fields };
}

/** A log that keeps its errors, for the tests that are about them. */
function recordingLog() {
  const errors: unknown[] = [];
  const quiet = () => undefined;
  return { errors, log: { info: quiet, warn: quiet, error: (...args: unknown[]) => errors.push(args) } };
}

const HOUR = 60 * 60 * 1000;

function hostFor(
  game: LobbyGame,
  options: {
    codes?: CodeRegistry;
    clock?: Clock;
    db?: Db;
    log?: ReturnType<typeof recordingLog>['log'];
    adapter?: Partial<TableAdapter<Toy>>;
  } = {}
) {
  const adapter: TableAdapter<Toy> = {
    game,
    idleMs: 6 * HOUR,
    revive: (saved) => saved as Toy,
    row: snapshotRow,
    deadline: () => null,
    card: () => null,
    seated: () => 0,
    begin: () => undefined,
    ...options.adapter
  };

  return new TableHost(adapter, {
    store: tableStore(options.db ?? openDb().db, zombieSessions),
    clock: options.clock ?? handClock(),
    codes: options.codes ?? new CodeRegistry(),
    log: options.log ?? recordingLog().log
  });
}

/**
 * A die that rolls the same code at the start of every allocation.
 *
 * Five rolls make a code, so this hands out one code twice running and then a
 * different one: the second allocation's first candidate is exactly the code
 * the first allocation took. A registry that does not know about the other
 * game takes it again.
 */
function sameFirstCodeEveryTime() {
  let rolls = 0;
  return () => Math.floor(rolls++ / 10);
}

describe('the table host', () => {
  it('never hands one game a code another game is already using', () => {
    const codes = new CodeRegistry(sameFirstCodeEveryTime());
    const quiz = hostFor('quiz', { codes });
    const mafia = hostFor('mafia', { codes });

    const first = quiz.create((code) => toy(code));
    const second = mafia.create((code) => toy(code));

    assert.notEqual(second.code, first.code);
    assert.equal(quiz.get(first.code), first);
    assert.equal(mafia.get(second.code), second);
  });

  it('names the codes of its own live tables and of no other game', async () => {
    // Rolls 0, 1, 2 and on, so the codes come out as ABCDE, FGHJK, MNPQR, STUVW.
    let rolls = 0;
    const codes = new CodeRegistry(() => rolls++);
    const quiz = hostFor('quiz', { codes });
    const mafia = hostFor('mafia', { codes });

    quiz.create((code) => toy(code));
    mafia.create((code) => toy(code));
    const ended = quiz.create((code) => toy(code));
    quiz.create((code) => toy(code));
    await quiz.destroy(ended.code);

    assert.deepEqual(quiz.codes(), new Set(['ABCDE', 'STUVW']));
    assert.deepEqual(mafia.codes(), new Set(['FGHJK']));
  });

  /**
   * Every table saves itself without anybody waiting on the outcome, and
   * `server.ts` ends the process on an uncaught error. A save that throws there
   * takes every room on the server down over one write the next change would
   * have retried anyway.
   */
  it('logs a save the database refuses rather than throwing it', () => {
    const { sqlite, db } = openDb();
    const { errors, log } = recordingLog();
    const host = hostFor('coronaz', { db, log });
    const table = host.create((code) => toy(code));

    // Every write refused, the way a full disk or a locked file refuses it.
    sqlite.pragma('query_only = ON');
    table.phase = 'night';

    assert.doesNotThrow(() => host.save(table));
    assert.equal(errors.length, 1);
  });

  /**
   * The quiz once read the phase its timer was for when the timer fired, off the
   * live round, and compared it with the same live round: the staleness test
   * could never fail, and a timer armed for one phase ended the next one.
   */
  it('lets a timer armed for a phase the table has since left go by without ending anything', () => {
    const clock = handClock();
    const host = hostFor('mafia', { clock, adapter: { deadline: phaseClock } });
    const table = host.create((code) => toy(code, { phase: 'day', endsAt: 1000 }));
    host.arm(table);

    // The table moves on behind the timer's back: night now, and it ends later.
    table.phase = 'night';
    table.endsAt = 5000;

    clock.advance(1000);
    assert.deepEqual(table.ended, []);

    clock.advance(4000);
    assert.deepEqual(table.ended, ['night']);
  });

  it('brings back the tables still in play after a restart and lets the spent ones go for good', async () => {
    const { db } = openDb();
    /** Over, and the room has had an hour to read the results. */
    const finishedLongAgo = (table: Toy, now: number) => table.phase === 'over' && table.lastActivityAt < now - HOUR;

    const before = hostFor('mafia', { db, adapter: { isSpent: finishedLongAgo } });
    const playing = before.create((code) => toy(code, { phase: 'day', lastActivityAt: 9 * HOUR }));
    const finished = before.create((code) => toy(code, { phase: 'over', lastActivityAt: 8 * HOUR }));
    const forgotten = before.create((code) => toy(code, { phase: 'day', lastActivityAt: 1 * HOUR }));

    // The process restarts at ten o'clock, onto the same database.
    const after = hostFor('mafia', { db, clock: handClock(10 * HOUR), adapter: { isSpent: finishedLongAgo } });

    assert.equal(await after.restore(), 1);
    assert.deepEqual(after.get(playing.code), playing);
    assert.equal(after.get(finished.code), undefined);
    assert.equal(after.get(forgotten.code), undefined);

    // Deleted rather than skipped: a host that would keep anything finds only the one.
    const keepsAnything = hostFor('mafia', {
      db,
      clock: handClock(10 * HOUR),
      adapter: { idleMs: Infinity, isSpent: () => false }
    });
    assert.equal(await keepsAnything.restore(), 1);
  });

  /**
   * The save is an upsert, so one landing after a destroy writes the row straight
   * back and the next restart reads the ghost in as a game in progress. The raid
   * did it from a presence tick that ended a raid and then saved it; a socket
   * handler finishing an `await` after the table went is the same bug.
   */
  it('never saves a table back once it is gone', async () => {
    const { db } = openDb();
    const host = hostFor('coronaz', { db });
    const table = host.create((code) => toy(code));

    await host.destroy(table.code);
    host.save(table);

    const afterRestart = hostFor('coronaz', { db });
    assert.equal(await afterRestart.restore(), 0);
  });

  it('parks the deadline while the table is paused and hands it back when play resumes', () => {
    const clock = handClock();
    const host = hostFor('coronaz', {
      clock,
      adapter: { deadline: (table) => (table.paused ? null : phaseClock(table)), presence: waitsForTheDark }
    });
    const table = host.create((code) => toy(code, { endsAt: 5000 }));
    host.arm(table);
    host.start();

    // A phone goes dark a moment in, and stays dark well past the deadline.
    table.dark = true;
    clock.advance(10_000);
    assert.deepEqual(table.ended, []);

    // It comes back, and the phase gets the four seconds it had left.
    table.dark = false;
    clock.advance(1000 + 4000);
    assert.deepEqual(table.ended, ['day']);

    host.stop();
  });
});

/**
 * The pause model at its smallest: a dark seat stops the clock, and its
 * return starts it again with whatever time the phase had left.
 */
const waitsForTheDark = {
  idle: (table: Toy) => Boolean(table.dark) === Boolean(table.paused),
  tick(table: Toy, now: number) {
    if (table.dark && !table.paused) {
      table.paused = { leftMs: (table.endsAt ?? now) - now };
      return 'changed' as const;
    }
    if (!table.dark && table.paused) {
      table.endsAt = now + table.paused.leftMs;
      table.paused = undefined;
      return 'changed' as const;
    }
    return 'quiet' as const;
  },
  changed: () => undefined
};

/** Each phase ends on its own at `endsAt`, and writes down that it did. */
function phaseClock(table: Toy) {
  if (table.endsAt === null) return null;
  return {
    at: table.endsAt,
    key: table.phase,
    fire: (current: Toy) => {
      current.ended.push(current.phase);
      current.endsAt = null;
    }
  };
}
