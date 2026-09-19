import { eq, lt } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { defaultSessionConfig, sessionConfigSchema, type SessionConfig } from 'game-core';

import { db } from '../db/index.js';
import { gameSessions } from '../db/schema.js';
import { drawRounds, reserveEphemeralIdsBelow, type DrawHistory } from '../services/blindtest-draw.js';
import { mediaService, type MediaView } from '../services/media-service.js';
import { resultsService } from '../services/results-service.js';
import { assetUrlFor, sweepAssets } from './assets.js';
import {
  advance,
  closeAnswers,
  createSession,
  expireBuzzWindow,
  nextDeadline,
  openAnswers,
  resolveBuzzRace,
  toSessionView,
  type InfiniteState,
  type SessionState,
  type ViewContext
} from './session.js';

/**
 * Owns every live game.
 *
 * Sessions live in memory for speed and are written to SQLite on each phase change,
 * so a restart mid-party resumes rather than ending the game. The previous
 * implementation kept them in a plain object with no persistence at all, so a deploy
 * lost every score.
 */

/** A session with no activity for this long is dropped. */
const IDLE_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * How long a lobby the room walked out of is kept.
 *
 * The commonest dead game there is: a few phones joined, nobody pressed start,
 * everybody wandered off. Nothing about it will ever change again, and until now
 * it announced itself to its host as in progress for six hours.
 *
 * Counted from the last thing that happened, which for a lobby is the last join,
 * and applied only once somebody has actually sat down. A host who has just
 * opened the screen and is waiting for friends to arrive has an empty lobby too,
 * and taking the game out from under them while they look at the join code would
 * be worse than the problem being fixed.
 */
const ABANDONED_LOBBY_MS = 30 * 60 * 1000;
/**
 * How long a *finished* game is kept before it is let go.
 *
 * It holds memory and it is over, so it does not get the full idle timeout. But
 * it was twenty minutes, which turned out to be shorter than an evening: a host
 * who closed the tab on the podium, or wandered off before reading it out, had
 * no way back to the standings at all. The game is listed as finished rather
 * than as in progress now, so keeping it around no longer misleads anybody, and
 * it can simply be reopened.
 *
 * The permanent record is in the history either way. This is only about getting
 * back to the ceremony screen itself.
 */
const FINISHED_GRACE_MS = 2 * 60 * 60 * 1000;

export type TransitionListener = (state: SessionState) => void;

/**
 * Trims the generated-item snapshot on its way to disk.
 *
 * An infinite session writes its whole state on every phase change, a few times a
 * minute, for as long as the evening lasts. `ephemeralItems` grows by one every
 * round, so persisting it whole means a blob that gets steadily larger and is
 * rewritten constantly — on a machine whose SSD is already a known weak point.
 *
 * Only the recent tail can ever be needed, because a restore resumes from where
 * the session is rather than replaying it. Rounds already played are in the
 * history row if the game banks, and are of no use to a resumed session either
 * way.
 *
 * Written as a replacer rather than by mutating the state, because the live
 * session keeps its full list: `mediaBySession` is what actually serves rounds,
 * and trimming the object itself would throw away items the engine might still
 * be asked for.
 */
function snapshotReplacer(state: SessionState): (key: string, value: unknown) => unknown {
  const keep = new Set(state.order.slice(-GameManager.PERSIST_WINDOW_SIZE));

  return (key, value) => {
    if (key !== 'ephemeralItems' || !Array.isArray(value)) return value;
    return (value as MediaView[]).filter((item) => keep.has(item.id));
  };
}

export class GameManager {
  private readonly sessions = new Map<string, SessionState>();
  /** Media snapshot per session, so a round is unaffected by later library edits. */
  private readonly mediaBySession = new Map<string, Map<number, MediaView>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private listener: TransitionListener | null = null;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(private readonly log: FastifyBaseLogger) {}

  onTransition(listener: TransitionListener): void {
    this.listener = listener;
  }

  /** Restores sessions from the database, e.g. after a restart. */
  async restore(): Promise<number> {
    const rows = await db.select().from(gameSessions);
    let restored = 0;

    for (const row of rows) {
      if (row.last_activity_at < Date.now() - IDLE_TIMEOUT_MS) {
        await db.delete(gameSessions).where(eq(gameSessions.code, row.code));
        continue;
      }

      try {
        const state = JSON.parse(row.state) as SessionState;
        this.sessions.set(state.code, state);

        /**
         * Reload the media this session referenced. A round already in flight
         * keeps the answers embedded in its own state, so this only matters for
         * later ones.
         *
         * Generated rounds are not in the library and never will be, so they come
         * back from the snapshot the state carries. Both sources are merged
         * rather than chosen between, because a session may legitimately mix the
         * two, and the library is consulted only for the ids that could be in it.
         */
        const lookup = new Map<number, MediaView>();

        for (const item of state.ephemeralItems ?? []) {
          lookup.set(item.id, item);
        }

        const libraryIds = state.order.filter((id) => id > 0);
        if (libraryIds.length > 0) {
          for (const item of await mediaService.getManyByIds(libraryIds)) {
            lookup.set(item.id, item);
          }
        }

        // Keep newly generated ids clear of the ones this session already uses.
        for (const id of state.order) {
          if (id < 0) reserveEphemeralIdsBelow(id);
        }

        this.mediaBySession.set(state.code, lookup);
        restored += 1;

        // No timer is armed. Rather than resuming a countdown whose deadline may
        // already be in the past, control goes back to the host: the phase stays
        // where it is until they advance.
      } catch (error) {
        this.log.warn({ err: error, code: row.code }, 'could not restore game session, dropping it');
        await db.delete(gameSessions).where(eq(gameSessions.code, row.code));
      }
    }

    return restored;
  }

  startSweeping(): void {
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  stopSweeping(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    const cutoff = now - IDLE_TIMEOUT_MS;

    for (const [code, state] of this.sessions) {
      if (!this.isSpent(state, now)) continue;

      /**
       * Banked before it is dropped, exactly as the host's own "Terminer" does.
       *
       * A swept game is still a game that was played. The old sweeper called
       * `drop` straight out, so an abandoned game took its standings and every
       * token its players had won with it, silently, hours later. `bank` is
       * idempotent and refuses a lobby nobody played, so this costs nothing in
       * the cases where there is nothing to keep.
       */
      await this.bank(state);
      this.drop(code);
      // Per session rather than by timestamp: a game dropped for being abandoned
      // or over is not necessarily old, and leaving its row behind would restore
      // it on the next restart.
      await db.delete(gameSessions).where(eq(gameSessions.code, code));
    }

    // Rows with no session in memory, e.g. after a restart that did not restore
    // them, still age out on the plain idle rule.
    await db.delete(gameSessions).where(lt(gameSessions.last_activity_at, cutoff));
    sweepAssets();
  }

  /**
   * Whether a session has nothing left to do.
   *
   * Three ways to be done, in order of how sure we are. Nothing at all has
   * happened for hours; or the game is over and has had its grace; or it is a
   * lobby whose players have all gone and which was therefore never going to
   * start.
   */
  private isSpent(state: SessionState, now: number): boolean {
    if (state.lastActivityAt < now - IDLE_TIMEOUT_MS) return true;

    if (state.phase === 'finished') {
      return state.lastActivityAt < now - FINISHED_GRACE_MS;
    }

    if (state.phase === 'lobby') {
      const seated = Object.values(state.players);
      const empty = seated.length > 0 && !seated.some((player) => player.connected);
      return empty && state.lastActivityAt < now - ABANDONED_LOBBY_MS;
    }

    return false;
  }

  /**
   * Puts an already-built session under this manager.
   *
   * Exists for the smoke test, which builds sessions with the pure engine
   * functions and needs them to go through the real ending — the one that banks
   * tokens — rather than a reimplementation of it. Named rather than done by
   * reaching into the private map, so the test exercises the same object graph
   * the server does.
   */
  adopt(state: SessionState): void {
    this.sessions.set(state.code, state);
  }

  get(code: string): SessionState | undefined {
    return this.sessions.get(code);
  }

  activeCodes(): ReadonlySet<string> {
    return new Set(this.sessions.keys());
  }

  /** View context for a session: turns asset paths into opaque per-round URLs. */
  viewContext(state: SessionState): ViewContext {
    const roundId = state.round?.id ?? 'none';
    return { imageUrl: (source) => assetUrlFor(roundId, source) };
  }

  view(state: SessionState, playerId: string | null, isHost: boolean) {
    // The host screen shows which item is playing, which the engine state does not
    // carry: it stores the answers and payload, not the librarian-facing title.
    const title = state.round ? (this.mediaBySession.get(state.code)?.get(state.round.mediaId)?.title ?? '') : '';
    return toSessionView(state, playerId, isHost, this.viewContext(state), title);
  }

  async create(options: {
    /** Null when the rounds came from nowhere: a generated session owns no playlist. */
    playlistId: number | null;
    playlistName: string;
    /** Null for a hostless quick match: nobody opened this one. */
    hostUserId: number | null;
    items: MediaView[];
    config?: unknown;
    /**
     * Makes this a self-refilling session.
     *
     * Its `items` are then only the opening buffer; everything after comes from
     * `topUp`, drawn while the previous round plays.
     */
    infinite?: InfiniteState;
    /**
     * Stop after this many rounds.
     *
     * Applied after the order is built, so a shuffled session takes a random
     * slice rather than the top of the playlist — which is what a quick match
     * asking for "eight rounds" out of a hundred-item quiz actually means.
     */
    maxRounds?: number;
  }): Promise<SessionState> {
    const parsedConfig = sessionConfigSchema.safeParse(options.config ?? {});
    const config: SessionConfig = parsedConfig.success ? parsedConfig.data : defaultSessionConfig;

    const state = createSession({
      playlistId: options.playlistId,
      playlistName: options.playlistName,
      hostUserId: options.hostUserId,
      items: options.items,
      config,
      existingCodes: this.activeCodes()
    });

    if (options.maxRounds !== undefined && options.maxRounds > 0) {
      state.order = state.order.slice(0, options.maxRounds);
    }

    if (options.infinite) {
      state.infinite = options.infinite;
      // The generated items exist nowhere else, so they travel with the state.
      state.ephemeralItems = options.items;
    }

    this.sessions.set(state.code, state);
    this.mediaBySession.set(state.code, new Map(options.items.map((item) => [item.id, item])));
    await this.persist(state);

    return state;
  }

  /* ------------------------------------------------------------- infinite mode */

  /**
   * How many rounds are kept ready ahead of the one playing.
   *
   * Your instinct was one, prepared while the current round runs, and the timing
   * works: a round is about thirty seconds and a draw is about one. The reason it
   * was three is failure, not speed. A draw can legitimately come back empty —
   * every remaining candidate region-blocked, or the same artist as two rounds
   * ago — and with a lookahead of one that single miss stalls the game in front
   * of the room.
   *
   * It is one now, and the miss is covered somewhere better: `advanceFor` waits
   * for a top-up when the buffer is actually empty, so an empty draw costs the
   * room the moment it takes to find one more song rather than nothing at all.
   * Three rounds of lookahead meant three songs were searched for, annotated and
   * held before anybody needed them, and a session that ends after four rounds
   * threw two of them away — paid for in API quota that the endless mode spends
   * all evening.
   */
  private static readonly LOOKAHEAD = 1;

  /**
   * How long to leave it after a draw that found nothing.
   *
   * A lookahead of one means the top-up fires only when the buffer is empty, so
   * on the happy path there is exactly one draw per round and no timer is needed
   * to space them out — the round itself does that. The bad path is the one that
   * needs a brake. A draw that comes back with nothing leaves the buffer empty,
   * and a blind test transitions several times per round — playing, answers
   * closing, the reveal, the next round — so every one of those fired another
   * draw, and each of those is a chorus lookup with a pool build possibly behind
   * it. A genre selection that has genuinely run dry hammered the API for the
   * rest of the evening.
   *
   * So the wait is charged only for coming back empty, and a draw that produced
   * a song imposes no delay on the next one at all. `advanceFor` passes `urgent`
   * and ignores this regardless, because that call is the room standing in
   * silence rather than a guess about the future.
   */
  private static readonly EMPTY_DRAW_BACKOFF_MS = 10_000;

  /** When each room last drew nothing. See `EMPTY_DRAW_BACKOFF_MS`. */
  private readonly emptyDrawAt = new Map<string, number>();

  /**
   * Rounds kept in the persisted snapshot.
   *
   * An infinite session plays for hours and rewrites its row on every phase
   * change. Keeping every item it ever generated would mean a JSON blob that
   * grows all evening, rewritten a few times a minute. Only the recent tail is
   * needed, because that is all a restore has to be able to resume from.
   */
  static readonly PERSIST_WINDOW_SIZE = 25;

  /** Top-ups in flight, so several transitions cannot start the same draw twice. */
  private readonly topUps = new Map<string, Promise<void>>();

  /** Whether this session should keep generating rounds. */
  private refilling(state: SessionState): boolean {
    const infinite = state.infinite;
    if (!infinite || infinite.stopping) return false;
    /**
     * A finished game does not want more rounds.
     *
     * `afterTransition` runs on every transition including the one *into*
     * `finished`, so without this the last thing an ended game did was spend
     * quota drawing rounds nobody would hear and append them to the order of a
     * game already on its podium. Worse, that left `order.length` ahead of
     * `currentRoundIndex`, so a stray advance would walk a finished session back
     * into playing after its results had been banked.
     */
    if (state.phase === 'finished') return false;
    if (infinite.maxRounds !== null && state.order.length >= infinite.maxRounds) return false;
    return true;
  }

  /**
   * Draws more rounds if the buffer is running low.
   *
   * Never awaited by the transition that triggers it: the point of the whole
   * design is that the search for the next clip happens during the current one,
   * so making a phase change wait on it would defeat it exactly.
   */
  private topUp(state: SessionState, urgent = false): Promise<void> {
    const existing = this.topUps.get(state.code);
    if (existing) return existing;
    if (!this.refilling(state)) return Promise.resolve();

    const remaining = state.order.length - state.currentRoundIndex - 1;
    if (remaining >= GameManager.LOOKAHEAD) return Promise.resolve();

    // Only after a miss, and never when the room is waiting. See `EMPTY_DRAW_BACKOFF_MS`.
    const sinceEmpty = Date.now() - (this.emptyDrawAt.get(state.code) ?? 0);
    if (!urgent && sinceEmpty < GameManager.EMPTY_DRAW_BACKOFF_MS) return Promise.resolve();

    const infinite = state.infinite;
    if (!infinite) return Promise.resolve();

    let wanted = GameManager.LOOKAHEAD - remaining;
    if (infinite.maxRounds !== null) {
      wanted = Math.min(wanted, infinite.maxRounds - state.order.length);
    }
    if (wanted <= 0) return Promise.resolve();

    const history: DrawHistory = {
      playedTracks: new Set(infinite.playedTracks),
      recentArtists: [...infinite.recentArtists]
    };

    const promise = drawRounds(
      {
        genreIds: infinite.genreIds,
        difficultyMin: infinite.difficultyMin,
        difficultyMax: infinite.difficultyMax,
        region: infinite.region
      },
      history,
      wanted
    )
      .then((items) => {
        /**
         * The session may have ended, or been told to wind up, while the draw was
         * out. A draw takes seconds and the host can press "finish" inside that
         * window, so the decision is re-read here rather than only at the top: an
         * in-flight top-up landing afterwards would quietly undo the stop by
         * appending the very rounds it just removed.
         */
        if (items.length === 0) {
          // Nothing found. Leave it a moment before asking again, so a dry set
          // of settings does not draw once per transition. See `EMPTY_DRAW_BACKOFF_MS`.
          this.emptyDrawAt.set(state.code, Date.now());
          return;
        }
        if (!this.sessions.has(state.code)) return;
        if (!this.refilling(state)) return;
        this.emptyDrawAt.delete(state.code);

        const lookup = this.mediaBySession.get(state.code);
        for (const item of items) {
          lookup?.set(item.id, item);
          state.order.push(item.id);
        }

        state.ephemeralItems = [...(state.ephemeralItems ?? []), ...items];
        infinite.playedTracks = [...history.playedTracks];
        infinite.recentArtists = history.recentArtists;
      })
      .catch((error: unknown) => {
        // A failed draw is a slower buffer, never a broken game.
        this.log.warn({ err: error, code: state.code }, 'blind test top-up failed');
      })
      .finally(() => {
        this.topUps.delete(state.code);
      });

    this.topUps.set(state.code, promise);
    return promise;
  }

  /**
   * The host asking for the run to finish.
   *
   * Stops the refill instead of ending the session, so the round on screen plays
   * out and the ceremony follows it naturally when `advance` runs off the end of
   * the order. Ending on the spot would cut off a round people are mid-answer on.
   */
  stopRefilling(code: string): boolean {
    const state = this.sessions.get(code);
    if (!state?.infinite) return false;
    state.infinite.stopping = true;

    /**
     * The buffer goes too, or the button is a lie.
     *
     * Three rounds are always held ready ahead of the one playing, so merely
     * stopping the refill leaves those three to play out: "Terminer après cette
     * manche" would run for four more. Cutting the order back to the current
     * round is what makes the label true, and it is safe because those rounds
     * have not been presented to anybody — they exist only as a lookahead.
     *
     * `currentRoundIndex + 1` rather than the index itself: the order is sliced
     * to a length, and the round on screen has to remain in it.
     */
    state.order = state.order.slice(0, Math.max(1, state.currentRoundIndex + 1));

    /**
     * Written out now rather than left to the next transition.
     *
     * A phase change would persist it within a round, but a restart in that gap
     * would restore a session still set to refill and quietly hand the room an
     * endless game it had already asked to end.
     */
    void this.persist(state).catch((error: unknown) => {
      this.log.warn({ err: error, code }, 'could not persist the stop request');
    });
    return true;
  }

  private lookupFor(code: string) {
    const items = this.mediaBySession.get(code);
    return (mediaId: number) => items?.get(mediaId);
  }

  /** Host pressed start, or the reveal ended and the session auto-advances. */
  async advanceSession(code: string): Promise<SessionState | undefined> {
    const state = this.sessions.get(code);
    if (!state) return undefined;

    /**
     * The one place a top-up is waited for.
     *
     * Only when the buffer is actually empty, which with a lookahead of three
     * means something went wrong earlier: a draw failed, or the room exhausted
     * what its settings allow. Waiting briefly here turns "the game ended without
     * warning" into "the next round took a moment", and if the draw still comes
     * back with nothing then `advance` finds an empty order and finishes the game
     * properly, with its ceremony.
     */
    if (this.refilling(state) && state.order.length - state.currentRoundIndex - 1 <= 0) {
      // Urgent: the room is between rounds with nothing to play, so the spacing
      // in `MIN_DRAW_GAP_MS` does not apply. See `topUp`.
      await this.topUp(state, true);
    }

    advance(state, this.lookupFor(code));
    await this.afterTransition(state);
    return state;
  }

  async closeAnswersFor(code: string): Promise<SessionState | undefined> {
    const state = this.sessions.get(code);
    if (!state) return undefined;

    closeAnswers(state);
    await this.afterTransition(state);
    return state;
  }

  async openAnswersFor(code: string): Promise<SessionState | undefined> {
    const state = this.sessions.get(code);
    if (!state) return undefined;

    openAnswers(state);
    await this.afterTransition(state);
    return state;
  }

  /** Persists, notifies listeners, and arms the timer for the next transition. */
  async afterTransition(state: SessionState): Promise<void> {
    /**
     * A game that just *finished* leaves its permanent trace now, before anything
     * else: the live session row is deleted the moment the host presses
     * "Terminer", and this is the last transition at which the full standings
     * still exist.
     *
     * The phase test is the whole of it, and leaving it out was catastrophic.
     * `bank` guards on "was this game ever played", which is true from the first
     * round onwards, so an unconditional call here fired on the transition into
     * round one: every game wrote its history row before a single answer had been
     * submitted, with every player on nought, and then set `resultsRecorded` so
     * the real standings at the end were silently refused.
     *
     * Two things followed from that, and both were reported as separate puzzles.
     * No token was ever credited to anybody. And since `buildLeaderboard` shares
     * a rank between equal totals, a table of noughts is a table where everyone
     * came first, so every player of every game earned a career win and wore
     * "Vainqueur" as a title in every lobby afterwards.
     */
    if (state.phase === 'finished') {
      await this.bank(state);
    }

    await this.persist(state);
    this.listener?.(state);
    this.scheduleNext(state);

    /**
     * And here is the loop: every transition looks at the buffer, and a round
     * starting is a transition. So the search for round N+1 begins the moment
     * round N goes on screen and has the whole of it to finish in.
     *
     * Deliberately not awaited. `void` rather than a floating promise so the
     * intent is stated: nothing here is allowed to delay the phase change that
     * the room is waiting on.
     */
    if (this.refilling(state)) {
      void this.topUp(state);
    }
  }

  /**
   * Writes the permanent trace of a game: the history row, and the wallets.
   *
   * Called from both endings, which is the fix rather than the tidy-up. It used
   * to live inline in `afterTransition` and therefore ran only when a session
   * reached `finished` of its own accord — by the host advancing past the last
   * round. The other ending, the "Terminer" button, goes through `destroy`,
   * which dropped the session and deleted its row without ever coming past here.
   *
   * So a host who ended a game early — the normal thing to do when everyone has
   * had enough, and the only thing to do when the last round drags — threw away
   * the standings *and* every token every player had just won. The comment
   * above this code even said the row is deleted the moment "Terminer" is
   * pressed; what it did not say was that nothing banked anything first.
   *
   * The gates are the ones that belong to *this* function: an oral game scores
   * nothing by design, a game nobody joined has nothing to keep, and a lobby that
   * never started is not a game. `resultsRecorded` makes it idempotent, so no two
   * callers can double-credit a wallet between them.
   *
   * What is deliberately not a gate here is "is the game over". A host ending one
   * early, and the sweeper letting an abandoned one go, both mean to bank a game
   * that never reached its last round. Deciding that is the caller's job, and
   * `afterTransition` is the caller that has to say so.
   */
  private async bank(state: SessionState): Promise<void> {
    const played = state.phase === 'finished' || state.currentRoundIndex >= 0;
    if (state.resultsRecorded || state.config.oral || !played) return;
    if (Object.keys(state.players).length === 0) return;

    state.resultsRecorded = true;
    try {
      // Kept on the session so the ceremony can show it. The screens read the
      // session view, and this is the one thing in it that cannot be recomputed
      // from the state alone.
      state.rewards = await resultsService.record(state);
    } catch (error) {
      this.log.error({ err: error, code: state.code }, 'could not record game result');
    }
  }

  /** Called on every answer: cheap, and keeps the session from being swept. */
  touch(state: SessionState): void {
    state.lastActivityAt = Date.now();
  }

  /**
   * Arms a single timer for whatever comes next.
   *
   * The server drives phase changes rather than trusting a client to report that
   * time is up, which is the same reason it owns the clock: a client that never
   * sends the message, or sends it early, must not be able to stall or rush a round.
   */
  private scheduleNext(state: SessionState): void {
    const existing = this.timers.get(state.code);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(state.code);
    }

    const round = state.round;
    /**
     * Whatever comes soonest, which since the buzzer is not always the phase.
     *
     * Still one timer. A raced round has up to three live deadlines — the phase,
     * the arbitration window, the holder's window — and giving each its own timer
     * is how a stale one ends up firing into a phase it no longer belongs to.
     * `nextDeadline` picks the earliest and every firing re-arms, so the later
     * ones are simply scheduled again once the earlier one has been dealt with.
     */
    const deadline = nextDeadline(state);
    if (state.phase !== 'playing' || !round || !deadline) {
      return;
    }

    const delay = Math.max(0, deadline.at - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(state.code);
      void this.runScheduledTransition(state.code, round.id, round.phase, deadline.kind);
    }, delay);

    timer.unref();
    this.timers.set(state.code, timer);
  }

  private async runScheduledTransition(
    code: string,
    roundId: string,
    phase: string,
    kind: 'phase' | 'buzz-race' | 'buzz-window' = 'phase'
  ): Promise<void> {
    const state = this.sessions.get(code);
    // The round may have been advanced by the host in the meantime, in which case
    // this timer is stale and must do nothing.
    if (!state || state.round?.id !== roundId || state.round.phase !== phase) {
      return;
    }

    try {
      /**
       * The buzzer's two deadlines do not change the phase, so they do not go
       * through the phase transitions at all.
       *
       * Both are no-ops when the thing they were armed for has already happened —
       * a race resolved by a later press arriving, a window ended by an answer —
       * and both say so, which is what keeps a stale firing from broadcasting a
       * view identical to the one everybody already has.
       */
      if (kind === 'buzz-race') {
        if (resolveBuzzRace(state)) await this.afterTransition(state);
        else this.scheduleNext(state);
        return;
      }
      if (kind === 'buzz-window') {
        if (expireBuzzWindow(state)) await this.afterTransition(state);
        else this.scheduleNext(state);
        return;
      }

      if (phase === 'study') {
        await this.openAnswersFor(code);
      } else if (phase === 'answering') {
        await this.closeAnswersFor(code);
      } else if (phase === 'reveal') {
        await this.advanceSession(code);
      }
    } catch (error) {
      this.log.error({ err: error, code }, 'scheduled game transition failed');
    }
  }

  async persist(state: SessionState): Promise<void> {
    const payload = {
      code: state.code,
      playlist_id: state.playlistId,
      host_user_id: state.hostUserId,
      host_token: state.hostToken,
      phase: state.phase,
      config: JSON.stringify(state.config),
      state: JSON.stringify(state, snapshotReplacer(state)),
      last_activity_at: state.lastActivityAt
    };

    await db
      .insert(gameSessions)
      .values(payload)
      .onConflictDoUpdate({
        target: gameSessions.code,
        set: {
          phase: payload.phase,
          config: payload.config,
          state: payload.state,
          last_activity_at: payload.last_activity_at
        }
      });
  }

  drop(code: string): void {
    const timer = this.timers.get(code);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(code);
    }
    this.sessions.delete(code);
    this.mediaBySession.delete(code);
    // A top-up still in flight resolves into a session that no longer exists; it
    // checks for that, so this only stops the map holding the entry forever.
    this.topUps.delete(code);
    this.emptyDrawAt.delete(code);
  }

  /**
   * The host's way out, from any phase.
   *
   * Banks first. A game ended early is still a game that was played, and the
   * points on the screen when the button was pressed are the points the players
   * believe they won.
   */
  async destroy(code: string): Promise<void> {
    const state = this.sessions.get(code);
    if (state) await this.bank(state);

    this.drop(code);
    await db.delete(gameSessions).where(eq(gameSessions.code, code));
  }
}
