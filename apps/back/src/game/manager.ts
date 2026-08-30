import { eq, lt } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { defaultSessionConfig, sessionConfigSchema, type SessionConfig } from 'game-core';

import { db } from '../db/index.js';
import { gameSessions } from '../db/schema.js';
import { mediaService, type MediaView } from '../services/media-service.js';
import { resultsService } from '../services/results-service.js';
import { assetUrlFor, sweepAssets } from './assets.js';
import {
  advance,
  closeAnswers,
  createSession,
  openAnswers,
  toSessionView,
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
const IDLE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
/**
 * How long a *finished* game is kept before it is let go.
 *
 * The idle timeout is six hours, which is the right answer for a session
 * somebody might still come back to. A game whose ceremony has been read is not
 * that: it holds memory, and it keeps announcing itself to its host as being in
 * progress. Long enough that a phone reopening the standings still finds them;
 * short enough that a host who plays two games in an evening is never shown the
 * first one during the second.
 */
const FINISHED_GRACE_MS = 20 * 60 * 1000;

export type TransitionListener = (state: SessionState) => void;

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

        // Reload the media this session referenced. A round already in flight keeps
        // the answers embedded in its own state, so this only matters for later ones.
        const items = await mediaService.getManyByIds(state.order);
        this.mediaBySession.set(state.code, new Map(items.map((item) => [item.id, item])));
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
    const cutoff = Date.now() - IDLE_TIMEOUT_MS;
    const finished = Date.now() - FINISHED_GRACE_MS;

    for (const [code, state] of this.sessions) {
      const over = state.phase === 'finished';
      if (state.lastActivityAt < cutoff || (over && state.lastActivityAt < finished)) {
        this.drop(code);
      }
    }

    await db.delete(gameSessions).where(lt(gameSessions.last_activity_at, cutoff));
    sweepAssets();
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
    playlistId: number;
    playlistName: string;
    /** Null for a hostless quick match: nobody opened this one. */
    hostUserId: number | null;
    items: MediaView[];
    config?: unknown;
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

    this.sessions.set(state.code, state);
    this.mediaBySession.set(state.code, new Map(options.items.map((item) => [item.id, item])));
    await this.persist(state);

    return state;
  }

  private lookupFor(code: string) {
    const items = this.mediaBySession.get(code);
    return (mediaId: number) => items?.get(mediaId);
  }

  /** Host pressed start, or the reveal ended and the session auto-advances. */
  async advanceSession(code: string): Promise<SessionState | undefined> {
    const state = this.sessions.get(code);
    if (!state) return undefined;

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
     * A game that just finished leaves its permanent trace now, before anything
     * else: the live session row is deleted the moment the host presses "Terminer",
     * and this is the only transition at which the full standings still exist.
     * Oral games score nothing, and a game nobody joined has nothing to keep.
     */
    await this.bank(state);

    await this.persist(state);
    this.listener?.(state);
    this.scheduleNext(state);
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
   * The gates are unchanged. An oral game scores nothing by design, a game
   * nobody joined has nothing to keep, and a lobby that never started is not a
   * game. `resultsRecorded` makes it idempotent, so the two callers cannot
   * double-credit a wallet between them.
   */
  private async bank(state: SessionState): Promise<void> {
    const played = state.phase === 'finished' || state.currentRoundIndex >= 0;
    if (state.resultsRecorded || state.config.oral || !played) return;
    if (Object.keys(state.players).length === 0) return;

    state.resultsRecorded = true;
    try {
      await resultsService.record(state);
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
    if (state.phase !== 'playing' || !round || round.phaseEndsAt === null) {
      return;
    }

    const delay = Math.max(0, round.phaseEndsAt - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(state.code);
      void this.runScheduledTransition(state.code, round.id, round.phase);
    }, delay);

    timer.unref();
    this.timers.set(state.code, timer);
  }

  private async runScheduledTransition(code: string, roundId: string, phase: string): Promise<void> {
    const state = this.sessions.get(code);
    // The round may have been advanced by the host in the meantime, in which case
    // this timer is stale and must do nothing.
    if (!state || state.round?.id !== roundId || state.round.phase !== phase) {
      return;
    }

    try {
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
      state: JSON.stringify(state),
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
