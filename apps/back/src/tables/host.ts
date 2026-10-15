import type { FastifyBaseLogger } from 'fastify';
import type { LobbyCard, LobbyGame } from 'lobby-core';

import { systemClock, type Clock } from '../clock.js';
import type { CodeRegistry } from './codes.js';
import type { TableRow, TableStore } from './store.js';

/**
 * The life of a table, once, for every game in the house.
 *
 * The quiz, the raid and Mafia each grew the same machinery around their own
 * engine: tables in memory for speed, a snapshot in SQLite on every change so a
 * restart resumes rather than ends the evening, a server-side clock because a
 * phone that never says "time's up" must not be able to stall the room, a sweep
 * for the tables everybody walked away from, and — for the two with a pause
 * model — a once-a-second look at who is still there. Three copies of all that
 * drifted apart in exactly the places that are easy to get wrong: which codes a
 * new table had to avoid, whether a failed save could take the process down,
 * whether a timer could fire into a phase it no longer belonged to.
 *
 * So the machinery lives here, and a game only says what is particular to it,
 * through a `TableAdapter`: how a saved table comes back, when its next deadline
 * is and what happens then, how its pause model ticks, when it is finished with.
 * What a game *does* — its actions, its broadcasts, the order it banks and saves
 * in — stays with the game's own manager, which calls `save` and `arm` from its
 * own funnel.
 */

/** What every game's table has, whatever else it carries. */
export interface Table {
  code: string;
  hostUserId: number | null;
  phase: string;
  /** Moved by the game on anything worth keeping a table alive for. */
  lastActivityAt: number;
}

/** A moment a table moves on its own, and what moving means. */
export interface Deadline<S> {
  at: number;
  /**
   * What the deadline is for, in the game's own terms: the phase, the round,
   * which of a round's several clocks. A timer that fires to find the table
   * carrying a different key, or the same key at a different time, belongs to
   * a moment that has passed. See `TableHost.arm`.
   */
  key: string;
  fire(table: S, now: number): void | Promise<void>;
}

/**
 * What one presence evaluation leaves for its caller to do.
 *
 * A verdict rather than a boolean, because "the table moved" and "the table is
 * gone" want opposite things and a `true` cannot tell them apart. Saving a raid
 * that has just been destroyed writes its row straight back — the save is an
 * upsert — and the next restart reads the ghost in as a live session.
 *
 * `settled` means somebody else has already finished the job: the table was
 * destroyed, or handed to the game's own transition, which saves and announces
 * it. (`save` refuses a table that is no longer live in any case; this is what
 * also keeps the room from being told about it twice.)
 */
export type PresenceVerdict = 'quiet' | 'changed' | 'settled';

/** The pause model, for the games that have one. */
export interface PresencePort<S> {
  /** Nothing for the model to decide, so the tick may skip this table. */
  idle(table: S, now: number): boolean;
  /** Advances the model to `now` and does what its decisions imply. Idempotent. */
  tick(table: S, now: number): PresenceVerdict;
  /** The table changed under the model: the room needs telling, and the table saving. */
  changed(table: S): void;
}

/** One card on the public board, with the account behind it still to be named. */
export interface Listing {
  card: LobbyCard;
  hostUserId: number | null;
}

/**
 * Everything the host needs a game to say about its tables.
 *
 * Derived from what the three managers actually did differently, and nothing
 * more: every hook here is somewhere at least one game disagreed with another.
 */
export interface TableAdapter<S extends Table, R extends TableRow = TableRow> {
  readonly game: LobbyGame;
  /** Untouched this long and a table is let go, by the sweep and at restart. */
  readonly idleMs: number;
  /**
   * A saved table back to life, or null when it cannot be. Either way, and on a
   * throw with a warning, a table that does not come back loses its row. Runs
   * before the table is live again, so it must not arm anything.
   */
  revive(saved: unknown, now: number): S | null | Promise<S | null>;
  /** The table is live again after a restart: restart whatever moves on its own. */
  restored?(table: S): void | Promise<void>;
  row(table: S): R;
  deadline(table: S, now: number): Deadline<S> | null;
  presence?: PresencePort<S>;
  /**
   * Done with, beyond merely idle — which the host already checks for itself.
   *
   * Asked at restore as well as on every sweep, so it may judge only what the
   * saved state says. Anything judged on who is connected belongs in `sweep`:
   * every seat comes back from a restart disconnected, and a rule about empty
   * rooms would read every room as empty.
   */
  isSpent?(table: S, now: number): boolean;
  /**
   * The game's own look at a live table on each sweep, before the host asks
   * whether it is spent. True when it has dealt with the table this time round,
   * whether by moving it on or by destroying it.
   */
  sweep?(table: S, now: number): boolean | Promise<boolean>;
  /** After each sweep, for whatever the game keeps on the same cadence. */
  swept?(now: number): void;
  /**
   * The table is being let go, by a destroy, the sweep, or a restart that found
   * it spent: keep whatever must outlive it, and forget whatever the game kept
   * on the side. It is still live while this runs.
   */
  release?(table: S): void | Promise<void>;
  /** Its card on the public board, or null when it is not one to list. */
  card(table: S): LobbyCard | null;
  /** How many seats are taken. */
  seated(table: S): number;
  /** Starts a game nobody is hosting, with this many machines ordered. */
  begin(table: S, bots: number): void | Promise<void>;
}

export type TableLog = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

export interface TableDeps<R extends TableRow = TableRow> {
  store: TableStore<R>;
  clock: Clock;
  codes: CodeRegistry;
  log: TableLog;
}

/**
 * What a game manager is handed: always the code registry, and, from a test, a
 * store or a clock in place of the production ones.
 *
 * The registry has no default because a manager that made its own would check
 * its codes against its own tables and nobody else's, which is the collision
 * `CodeRegistry` exists to end, and it would do so without a word. So the app
 * hands every manager its one shared registry, and a test or a script that
 * runs a single game says so by handing it a fresh one.
 */
export type TableOptions<R extends TableRow = TableRow> = Pick<TableDeps<R>, 'codes'> &
  Partial<Pick<TableDeps<R>, 'store' | 'clock'>>;

/** A manager's options with the gaps filled: the game's own table in the app's database, and the real clock. */
export function tableDeps<R extends TableRow>(
  log: TableLog,
  options: TableOptions<R>,
  productionStore: TableStore<R>
): TableDeps<R> {
  return { store: options.store ?? productionStore, clock: options.clock ?? systemClock, codes: options.codes, log };
}

/** What a caller that does not care which game it is holding can ask of any host. */
export interface Tables {
  readonly game: LobbyGame;
  seated(code: string): number;
  board(): Listing[];
  begin(code: string, bots: number): Promise<void>;
}

/** A table nobody is moving is still looked at every quarter of an hour. */
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * How often the pause model is re-evaluated.
 *
 * Presence changes on its own schedule rather than on a player's: nobody sends
 * an event when a phone *stops* beating, so somebody has to notice. One second
 * is well inside the resync window, so a genuine drop stops the clock promptly
 * without the tick itself being the thing that costs anything.
 */
const PRESENCE_TICK_MS = 1000;

/**
 * The soonest a deadline timer fires.
 *
 * A deadline already behind us runs on the next beat rather than this one, and
 * an engine that ever failed to move its own deadline forward would cost a slow
 * loop rather than a hot one. Mafia always had this; the other two now do too.
 */
const MIN_DELAY_MS = 50;

export class TableHost<S extends Table, R extends TableRow = TableRow> implements Tables {
  private readonly tables = new Map<string, S>();
  /** One phase clock per table, as a way to cancel it. */
  private readonly deadlines = new Map<string, () => void>();
  /** Everything else a game parks against a table, by table then slot. */
  private readonly timers = new Map<string, Map<string, () => void>>();
  /** Saves that are allowed to wait, one per table at most. See `saveSoon`. */
  private readonly soon = new Map<string, () => void>();
  private sweepLoop: (() => void) | undefined;
  private presenceLoop: (() => void) | undefined;

  constructor(
    private readonly adapter: TableAdapter<S, R>,
    private readonly deps: TableDeps<R>
  ) {
    deps.codes.track(this.tables);
  }

  get game(): LobbyGame {
    return this.adapter.game;
  }

  get(code: string): S | undefined {
    return this.tables.get(code);
  }

  all(): S[] {
    return [...this.tables.values()];
  }

  /** The codes of this game's live tables, as they stand now: a copy, not a view. */
  codes(): ReadonlySet<string> {
    return new Set(this.tables.keys());
  }

  /**
   * A new table, under a code no other room in the house is using.
   *
   * `build` is synchronous on purpose: the code is free only until something is
   * filed under it, so whatever has to be awaited before a table can exist is
   * awaited before this is called, never between the code and the table.
   */
  create(build: (code: string) => S): S {
    const table = build(this.deps.codes.allocate());
    this.tables.set(table.code, table);
    this.save(table);
    return table;
  }

  /**
   * Puts an already-built table under this host, in place of whatever held its
   * code, and reads its clock afresh. For a rematch, which deals a new table
   * into the old one's seat, and for tests that build tables by hand.
   */
  adopt(table: S): void {
    this.tables.set(table.code, table);
    this.arm(table);
  }

  /**
   * Writes the table down. Never throws, and never resurrects.
   *
   * Every game saves without waiting on the outcome — a heartbeat, a kick, a bot
   * joining all end in a save nobody checks — and `server.ts` ends the process
   * on an uncaught error, so a write the disk refuses is logged and left for the
   * next change to retry rather than taking every room on the server with it.
   *
   * And only a table that is still live is written. The save is an upsert, so
   * one landing after a destroy puts the deleted row straight back and the next
   * restart reads the ghost in as a game in progress. The raid learned that one
   * the hard way, from a presence tick that ended a raid and then saved it; a
   * socket handler finishing an `await` after the table went is the same bug.
   */
  save(table: S): void {
    if (this.tables.get(table.code) !== table) return;
    // This write covers anything that was waiting to be saved.
    this.cancelSoon(table.code);
    try {
      this.deps.store.save(this.adapter.row(table));
    } catch (error) {
      this.deps.log.error({ err: error, code: table.code, game: this.game }, 'table save failed');
    }
  }

  /**
   * A save that may wait `ms`, for changes too frequent and too cheap to lose to
   * write through one by one. Coalesces a burst into one save: the first change
   * arms it, the rest ride along. The next ordinary `save` takes it over, and
   * `stop` writes it out rather than dropping it.
   */
  saveSoon(table: S, ms: number): void {
    const code = table.code;
    if (this.soon.has(code)) return;
    this.soon.set(
      code,
      this.deps.clock.after(ms, () => {
        this.soon.delete(code);
        const current = this.tables.get(code);
        if (current) this.save(current);
      })
    );
  }

  /**
   * Re-reads the table's next deadline and sets the one timer that runs to it.
   *
   * One timer per table, whatever the game. A table can carry several clocks at
   * once — a quiz round has its phase, the buzzer's arbitration window and the
   * holder's window — and giving each its own timer is how a stale one ends up
   * firing into a phase it no longer belongs to. The adapter names the soonest;
   * every firing re-arms, so the later ones are simply scheduled again once the
   * earlier one has been dealt with.
   *
   * What the timer was armed for is copied now, not read when it fires. The quiz
   * once read the phase off its live round inside the callback, and compared it
   * with the same live round: the staleness test it existed for could never
   * fail. A copy is what gives the check something to compare against.
   *
   * Called after anything that may have moved a deadline. It is idempotent, and
   * a paused table's adapter names no deadline, so a pause parks the clock and
   * a resume hands it back through this same call.
   */
  arm(table: S): void {
    const code = table.code;
    this.deadlines.get(code)?.();
    this.deadlines.delete(code);

    const now = this.deps.clock.now();
    const deadline = this.adapter.deadline(table, now);
    if (!deadline) return;

    const armedFor = { key: deadline.key, at: deadline.at };
    const cancel = this.deps.clock.after(Math.max(MIN_DELAY_MS, deadline.at - now), () => {
      this.deadlines.delete(code);
      this.fire(code, armedFor);
    });
    this.deadlines.set(code, cancel);
  }

  /**
   * A deadline timer coming due. Runs the deadline only if the table still has
   * exactly that one — same key, same time. Anything else means the table moved
   * on without this timer being told, and all it does is arm whatever the table
   * now says: a trial that pushed the day back, a round the host advanced.
   */
  private fire(code: string, armedFor: { key: string; at: number }): void {
    const table = this.tables.get(code);
    if (!table) return;

    const now = this.deps.clock.now();
    const current = this.adapter.deadline(table, now);
    if (!current) return;
    if (current.key !== armedFor.key || current.at !== armedFor.at) {
      this.arm(table);
      return;
    }

    this.guard(code, 'deadline', () => current.fire(table, now));
  }

  /**
   * Runs something else against a table `ms` from now, beside its deadline,
   * under a slot of the game's choosing: the raid's bot beat, the horde's next
   * step. Replaces whatever was in that slot, and goes when the table does. A
   * failure is logged with the table it belongs to.
   */
  schedule(code: string, slot: string, ms: number, fn: () => void | Promise<void>): void {
    this.cancel(code, slot);
    let parked = this.timers.get(code);
    if (!parked) {
      parked = new Map();
      this.timers.set(code, parked);
    }
    parked.set(
      slot,
      this.deps.clock.after(ms, () => {
        this.timers.get(code)?.delete(slot);
        this.guard(code, slot, fn);
      })
    );
  }

  pending(code: string, slot: string): boolean {
    return this.timers.get(code)?.has(slot) ?? false;
  }

  /** Cancels one parked timer, or every one a table has when no slot is named. */
  cancel(code: string, slot?: string): void {
    const parked = this.timers.get(code);
    if (!parked) return;
    for (const [name, cancel] of parked) {
      if (slot !== undefined && name !== slot) continue;
      cancel();
      parked.delete(name);
    }
    if (parked.size === 0) this.timers.delete(code);
  }

  /** The time by this host's clock, which is the time its pause model runs on. */
  now(): number {
    return this.deps.clock.now();
  }

  /**
   * The game has just changed something the pause model watches: a phone
   * reporting in after a silence, a socket closing, a kick proposed or voted
   * on. The model runs now rather than at the next tick, because it may have
   * been waiting on exactly this.
   *
   * The room is told, and the table saved, whether or not the model decided
   * anything (a seat coming back out of the dark is worth showing either way)
   * unless the model has already settled the table itself. So the game calls
   * this only for a change that is news, and stamps that change with `now`.
   */
  presenceChanged(table: S): void {
    const presence = this.adapter.presence;
    if (!presence || this.tables.get(table.code) !== table) return;

    if (presence.tick(table, this.deps.clock.now()) === 'settled') return;
    this.arm(table);
    presence.changed(table);
  }

  /**
   * Restores the tables saved before a restart.
   *
   * A table idle past the limit is deleted unread. One that cannot be read back
   * is deleted too, with a warning, rather than allowed to stop the server from
   * starting. One that reads back fine but is already done with — a finished
   * game past its grace, a lobby everybody left — is let go here exactly as the
   * sweep would have let it go had the process stayed up, rather than offered
   * back to its host for the quarter of an hour until the next sweep.
   */
  async restore(): Promise<number> {
    const now = this.deps.clock.now();
    let restored = 0;

    for (const row of this.deps.store.load()) {
      if (row.lastActivityAt < now - this.adapter.idleMs) {
        this.remove(row.code);
        continue;
      }

      let live: S | undefined;
      try {
        const table = await this.adapter.revive(JSON.parse(row.state), now);
        if (!table) {
          this.remove(row.code);
          continue;
        }
        if (this.spent(table, now)) {
          await this.adapter.release?.(table);
          this.remove(row.code);
          continue;
        }

        this.tables.set(table.code, table);
        live = table;
        await this.adapter.restored?.(table);
        restored += 1;
      } catch (error) {
        this.deps.log.warn({ err: error, code: row.code, game: this.game }, 'could not restore table, dropping it');
        if (live) this.forget(live.code);
        this.remove(row.code);
      }
    }

    return restored;
  }

  /** The sweep every quarter of an hour, and the pause model every second. */
  start(): void {
    if (this.sweepLoop) return;

    const sweep = () => {
      this.sweepLoop = this.deps.clock.after(SWEEP_INTERVAL_MS, () => {
        sweep();
        void this.sweep().catch((error: unknown) =>
          this.deps.log.error({ err: error, game: this.game }, 'table sweep failed')
        );
      });
    };
    sweep();

    const presence = this.adapter.presence;
    if (presence) {
      const tick = () => {
        this.presenceLoop = this.deps.clock.after(PRESENCE_TICK_MS, () => {
          tick();
          this.tickPresence(presence);
        });
      };
      tick();
    }
  }

  /** Stops every clock this host owns, and writes out anything still waiting to be saved. */
  stop(): void {
    this.sweepLoop?.();
    this.sweepLoop = undefined;
    this.presenceLoop?.();
    this.presenceLoop = undefined;

    for (const cancel of this.deadlines.values()) cancel();
    this.deadlines.clear();
    for (const code of [...this.timers.keys()]) this.cancel(code);

    // Saved now rather than dropped.
    for (const code of [...this.soon.keys()]) {
      this.cancelSoon(code);
      const table = this.tables.get(code);
      if (table) this.save(table);
    }
  }

  /**
   * Every live table, once a second. Cheap: most have nothing to decide.
   *
   * A change re-reads the deadline before the room is told, because a pause
   * parks the clock and a resume hands it back: either way the timer has to be
   * re-read from the state rather than left as it was.
   */
  private tickPresence(presence: PresencePort<S>): void {
    const now = this.deps.clock.now();
    for (const table of [...this.tables.values()]) {
      if (this.tables.get(table.code) !== table) continue;
      if (presence.idle(table, now)) continue;
      if (presence.tick(table, now) !== 'changed') continue;
      this.arm(table);
      presence.changed(table);
    }
  }

  /**
   * Lets go of every table that is done with.
   *
   * A table let go here goes the same way a host's own "end" lets it go — through
   * `destroy`, and so through the adapter's `release` — so whatever a game keeps
   * of a finished table is kept whoever finished it. Its row goes with it, per
   * table rather than by timestamp: a table dropped for being over is not
   * necessarily old, and leaving its row behind would restore it next restart.
   */
  private async sweep(): Promise<void> {
    const now = this.deps.clock.now();

    for (const table of [...this.tables.values()]) {
      if (this.tables.get(table.code) !== table) continue;
      if (await this.adapter.sweep?.(table, now)) continue;
      if (!this.spent(table, now)) continue;
      this.deps.log.info({ code: table.code, game: this.game, phase: table.phase }, 'sweeping table');
      await this.destroy(table.code);
    }

    // Rows with no table in memory, e.g. after a restart that did not restore
    // them, still age out on the plain idle rule.
    try {
      this.deps.store.removeIdle(now - this.adapter.idleMs);
    } catch (error) {
      this.deps.log.error({ err: error, game: this.game }, 'could not delete idle table rows');
    }
    this.adapter.swept?.(now);
  }

  /**
   * Lets one table go, from any phase: whatever the game keeps of it first, then
   * its timers, its place in memory and its row.
   */
  async destroy(code: string): Promise<void> {
    const table = this.tables.get(code);
    if (table) {
      try {
        await this.adapter.release?.(table);
      } catch (error) {
        this.deps.log.error({ err: error, code, game: this.game }, 'table release failed');
      }
    }
    this.forget(code);
    this.remove(code);
  }

  seated(code: string): number {
    const table = this.tables.get(code);
    return table ? this.adapter.seated(table) : 0;
  }

  board(): Listing[] {
    const listings: Listing[] = [];
    for (const table of this.tables.values()) {
      const card = this.adapter.card(table);
      if (card) listings.push({ card, hostUserId: table.hostUserId });
    }
    return listings;
  }

  /** Starts a hostless game, unless nobody ever sat down at it, in which case it goes. */
  async begin(code: string, bots: number): Promise<void> {
    const table = this.tables.get(code);
    if (!table) return;
    if (this.adapter.seated(table) === 0) {
      await this.destroy(code);
      return;
    }
    await this.adapter.begin(table, bots);
  }

  private spent(table: S, now: number): boolean {
    return table.lastActivityAt < now - this.adapter.idleMs || (this.adapter.isSpent?.(table, now) ?? false);
  }

  /** Out of memory and off every clock, without touching its row. */
  private forget(code: string): void {
    this.deadlines.get(code)?.();
    this.deadlines.delete(code);
    this.cancel(code);
    this.cancelSoon(code);
    this.tables.delete(code);
  }

  private remove(code: string): void {
    try {
      this.deps.store.remove(code);
    } catch (error) {
      this.deps.log.error({ err: error, code, game: this.game }, 'could not delete table row');
    }
  }

  private cancelSoon(code: string): void {
    this.soon.get(code)?.();
    this.soon.delete(code);
  }

  /** Runs something on a table's behalf, logging rather than throwing what goes wrong, now or later. */
  private guard(code: string, what: string, fn: () => void | Promise<void>): void {
    const report = (error: unknown) =>
      this.deps.log.error({ err: error, code, game: this.game }, `table ${what} failed`);
    try {
      const result = fn();
      if (result) result.catch(report);
    } catch (error) {
      report(error);
    }
  }
}
