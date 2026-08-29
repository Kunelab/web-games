import { randomBytes, randomInt, randomUUID } from 'node:crypto';

import { generateJoinCode } from 'game-core';
import {
  addMafiaBot,
  advanceMafia,
  callCourt,
  castBallot,
  castVote,
  checkVictory,
  createMafiaGame,
  dropMafiaSeat,
  jailTarget,
  joinMafia,
  mafiaPaused,
  noteSeatAlive,
  noteSeatSilent,
  proposeMafiaKick,
  removeMafiaBot,
  restoreMafiaTable,
  revealMayor,
  sayInChat,
  setLastWill,
  setNightAction,
  startMafia,
  tablePresence,
  tickMafiaPresence,
  voteMafiaKick,
  whisperTo,
  type ActionOutcome,
  type MafiaConfig,
  type MafiaPlayer,
  type MafiaState
} from 'mafia-core';
import { presenceIdle, type KickRefusal } from 'presence-core';
import type { ChatMessage } from 'chat-core';
import type { Locale } from 'i18n';
import { eq, lt } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import { db } from '../db/index.js';
import { mafiaSessions } from '../db/schema.js';
import { mafiaCareerService, type MafiaGameReward } from '../services/mafia-career-service.js';
import { MafiaBotDriver } from './bots.js';

/**
 * Owns every live Mafia table: state in memory, snapshot to SQLite on every
 * transition, and — crucially for this game — the phase clock. Day, defense,
 * judgement and night all end on a server timer; a phone that never says
 * "time's up" cannot stall the town.
 */

const IDLE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * How long a chat line may sit unsaved.
 *
 * Every phase change is still written through synchronously — losing a night
 * resolution to a crash is unacceptable, and that is the guarantee the whole
 * persistence model exists for. A chat line is not that: the table is a full
 * table with its whole log inside it, so saving on every message meant twenty-four
 * phones at the rate limit rewriting the same row twelve times a second. Two
 * seconds of talk is a cheap thing to lose to a hard kill, and it is the only
 * thing this defers.
 */
const CHAT_PERSIST_MS = 2000;

/**
 * How often the pause model is re-evaluated.
 *
 * Presence changes on its own schedule rather than on a player's: nobody sends
 * an event when a phone *stops* beating, so somebody has to notice. One second
 * is well inside the resync window, so a genuine drop stops the clock promptly
 * without the tick itself being the thing that costs anything.
 */
const PRESENCE_TICK_MS = 1000;

/** Every lookup miss says the same thing; it is spelled once. */
const NO_SUCH_TABLE = 'Partie introuvable';

export type MafiaTransitionListener = (state: MafiaState) => void;
export type MafiaMessageListener = (state: MafiaState, message: ChatMessage) => void;
export type MafiaRewardListener = (state: MafiaState, rewards: MafiaGameReward[]) => void;

export class MafiaManager {
  private readonly sessions = new Map<string, MafiaState>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Pending chat-only saves, one per table at most. See CHAT_PERSIST_MS. */
  private readonly chatFlush = new Map<string, NodeJS.Timeout>();
  /** Tables whose careers are already banked; a table banks exactly once. */
  private readonly banked = new Set<string>();
  private listener: MafiaTransitionListener | null = null;
  private messageListener: MafiaMessageListener | null = null;
  private rewardListener: MafiaRewardListener | null = null;
  private sweepTimer: NodeJS.Timeout | undefined;
  private presenceTimer: NodeJS.Timeout | undefined;
  private readonly bots: MafiaBotDriver;

  constructor(private readonly log: FastifyBaseLogger) {
    this.bots = new MafiaBotDriver(log, {
      chat: (code, botId, channel, text) => this.playerChat(code, botId, channel, text),
      vote: (code, botId, slot) => this.vote(code, botId, slot),
      ballot: (code, botId, verdict) => this.ballot(code, botId, verdict),
      action: (code, botId, slot) => this.nightAction(code, botId, slot),
      get: (code) => this.sessions.get(code)
    });
  }

  onTransition(listener: MafiaTransitionListener): void {
    this.listener = listener;
  }

  onMessage(listener: MafiaMessageListener): void {
    this.messageListener = listener;
  }

  onRewards(listener: MafiaRewardListener): void {
    this.rewardListener = listener;
  }

  get(code: string): MafiaState | undefined {
    return this.sessions.get(code);
  }

  /** What this table's bots have publicly claimed, for the headless harness. */
  botLedger(code: string) {
    return this.bots.ledger(code);
  }

  activeCodes(): ReadonlySet<string> {
    return new Set(this.sessions.keys());
  }

  private rng = (): number => randomInt(2 ** 31) / 2 ** 31;

  create(input: {
    hostUserId: number | null;
    config?: Partial<MafiaConfig>;
    takenCodes: ReadonlySet<string>;
  }): MafiaState {
    let code: string;
    do {
      code = generateJoinCode((maxExclusive) => randomInt(maxExclusive));
    } while (this.sessions.has(code) || input.takenCodes.has(code));

    const state = createMafiaGame({
      code,
      hostToken: randomBytes(24).toString('base64url'),
      hostUserId: input.hostUserId,
      config: input.config,
      now: Date.now()
    });
    this.sessions.set(code, state);
    void this.persist(state);
    return state;
  }

  /* ------------------------------ mutations ------------------------------ */

  join(
    code: string,
    name: string,
    presetToken?: string,
    account?: string,
    locale?: Locale
  ): { player: MafiaPlayer; state: MafiaState } {
    const state = this.mustGet(code);
    const { player } = joinMafia(
      state,
      name,
      randomBytes(24).toString('base64url'),
      randomUUID(),
      presetToken,
      account
    );
    // Only matters for what the bots speak; see `spokenLocale`.
    if (locale) player.locale = locale;
    this.afterChange(state);
    return { player, state };
  }

  addBots(code: string, count: number): void {
    const state = this.mustGet(code);
    const capped = Math.max(0, Math.min(count, state.config.maxPlayers - Object.keys(state.players).length));
    for (let i = 0; i < capped; i++) {
      addMafiaBot(state, randomBytes(24).toString('base64url'), randomUUID(), randomInt);
    }
    this.afterChange(state);
  }

  removeBot(code: string, playerId: string): void {
    const state = this.mustGet(code);
    removeMafiaBot(state, playerId);
    this.afterChange(state);
  }

  start(code: string): void {
    const state = this.mustGet(code);
    startMafia(state, Date.now(), this.rng);
    this.afterChange(state);
  }

  playerChat(code: string, playerId: string, channel: string, text: string): ActionOutcome {
    const state = this.sessions.get(code);
    if (!state) return { ok: false, error: NO_SUCH_TABLE };
    const result = sayInChat(state, playerId, channel, text, Date.now());
    if (!result.ok) return result;

    state.lastActivityAt = Date.now();
    this.messageListener?.(state, result.message);
    this.persistSoon(state);
    return { ok: true };
  }

  vote(code: string, playerId: string, targetSlot: number | null): ActionOutcome {
    return this.mutate(code, (state) => castVote(state, playerId, targetSlot, Date.now()));
  }

  ballot(code: string, playerId: string, verdict: 'guilty' | 'innocent' | 'abstain'): ActionOutcome {
    return this.mutate(code, (state) => castBallot(state, playerId, verdict));
  }

  nightAction(
    code: string,
    playerId: string,
    targetSlot: number | null,
    secondTargetSlot?: number | null
  ): ActionOutcome {
    return this.mutate(code, (state) => setNightAction(state, playerId, targetSlot, secondTargetSlot));
  }

  whisper(code: string, playerId: string, targetSlot: number, text: string): ActionOutcome {
    const state = this.sessions.get(code);
    if (!state) return { ok: false, error: NO_SUCH_TABLE };
    const result = whisperTo(state, playerId, targetSlot, text, Date.now());
    if (!result.ok) return result;

    state.lastActivityAt = Date.now();
    // Two deliveries: the words to the pair, the gesture to the whole square.
    this.messageListener?.(state, result.message);
    this.messageListener?.(state, result.gossip);
    this.persistSoon(state);
    return { ok: true };
  }

  dayAction(
    code: string,
    playerId: string,
    action: { type: 'jail'; targetSlot: number | null } | { type: 'reveal' } | { type: 'court' }
  ): ActionOutcome {
    return this.mutate(code, (state) =>
      action.type === 'jail'
        ? jailTarget(state, playerId, action.targetSlot)
        : action.type === 'court'
          ? callCourt(state, playerId, Date.now())
          : revealMayor(state, playerId, Date.now())
    );
  }

  will(code: string, playerId: string, text: string): ActionOutcome {
    return this.mutate(code, (state) => setLastWill(state, playerId, text));
  }

  markConnected(code: string, playerId: string, connected: boolean): void {
    const state = this.sessions.get(code);
    const player = state?.players[playerId];
    if (!state || !player) return;
    player.connected = connected;

    /**
     * A dropped socket is an absence immediately, without waiting for missed
     * heartbeats: a connection closing is better evidence than silence is, and
     * starting the resync window now rather than two beats later is what makes
     * the window mean what it says.
     *
     * It still only starts the window. Nothing is paused here — the tick decides
     * that several seconds later, and only if the phone has not come back.
     */
    if (connected) noteSeatAlive(state, playerId, Date.now());
    else noteSeatSilent(state, playerId, Date.now());

    /**
     * Through the funnel rather than a bare broadcast, because the pause model
     * can end the game outright: a town of two that loses one of them has
     * reached parity, and a game ended that way has careers to bank like any
     * other. `connected` is part of the projection either way, so the room is
     * told whether or not the model decided anything.
     */
    this.runPresence(state);
    this.afterChange(state);
  }

  /**
   * A phone reporting in. The hot path, so it does as little as possible.
   *
   * Nothing is broadcast or saved on an ordinary beat: only a seat coming back
   * out of the dark is news, and only then does the room need telling.
   */
  beat(code: string, playerId: string): void {
    const state = this.sessions.get(code);
    if (!state?.players[playerId]) return;
    // The beat is recorded either way — that record is what lets the tick notice
    // the beats stopping later — but only a seat coming back is news.
    if (noteSeatAlive(state, playerId, Date.now())) {
      // News, so it goes through the funnel: a seat coming back completes a
      // resume, and a resume restarts the phase clock — a change worth saving
      // rather than broadcasting and leaving to the next unrelated write.
      this.runPresence(state);
      this.afterChange(state);
    }
  }

  proposeKick(code: string, playerId: string, targetSlot: number): { ok: boolean; reason?: KickRefusal } {
    const state = this.sessions.get(code);
    if (!state) return { ok: false, reason: 'not-seated' };
    const opened = proposeMafiaKick(state, playerId, targetSlot, Date.now());
    if (opened.ok) this.afterChange(state);
    return opened.ok ? { ok: true } : { ok: false, reason: opened.reason };
  }

  voteKick(code: string, playerId: string, yes: boolean): { ok: boolean; reason?: KickRefusal } {
    const state = this.sessions.get(code);
    if (!state) return { ok: false, reason: 'not-seated' };
    const cast = voteMafiaKick(state, playerId, yes);
    // A ballot may be the one that carries it, so the model is advanced here
    // rather than leaving the room to wait up to a second for the ticker.
    if (cast.ok) {
      this.runPresence(state);
      this.afterChange(state);
    }
    return cast.ok ? { ok: true } : { ok: false, reason: cast.reason };
  }

  async destroy(code: string): Promise<void> {
    const state = this.sessions.get(code);
    this.clearTimer(code);
    this.cancelChatFlush(code);
    this.bots.forget(code);
    this.sessions.delete(code);
    this.banked.delete(code);
    if (state) await db.delete(mafiaSessions).where(eq(mafiaSessions.code, code));
  }

  /* ------------------------------ lifecycle ------------------------------ */

  private mustGet(code: string): MafiaState {
    const state = this.sessions.get(code);
    if (!state) throw new Error(NO_SUCH_TABLE);
    return state;
  }

  private mutate(code: string, change: (state: MafiaState) => ActionOutcome): ActionOutcome {
    const state = this.sessions.get(code);
    if (!state) return { ok: false, error: NO_SUCH_TABLE };
    const result = change(state);
    if (result.ok) this.afterChange(state);
    return result;
  }

  /**
   * The one funnel after any state change: broadcast the new projections,
   * snapshot to SQLite, re-arm the phase timer (deadlines move when trials
   * start), wake the bots, and bank the careers if the game just ended.
   */
  private afterChange(state: MafiaState): void {
    state.lastActivityAt = Date.now();
    this.listener?.(state);
    // This write covers anything chat was waiting to save.
    this.cancelChatFlush(state.code);
    void this.persist(state);
    this.armTimer(state);
    // A paused table plans nothing: the bots would otherwise argue and vote
    // through a wait that exists precisely so nobody acts without the absentee.
    if (!mafiaPaused(state)) this.bots.onChange(state);

    if (state.phase === 'ended' && !this.banked.has(state.code)) {
      this.banked.add(state.code);
      this.bots.forget(state.code);
      void mafiaCareerService
        .recordGame(state)
        .then((rewards) => this.rewardListener?.(state, rewards))
        .catch((error: unknown) => this.log.error({ err: error, code: state.code }, 'Mafia career banking failed'));
    }
  }

  /**
   * Runs the pause model for one table and acts on what it decided.
   *
   * The engine has already stopped or restarted the phase clock by the time this
   * reads the result — that is what tickMafiaPresence does — so all that is left
   * here is the machinery a clock change implies: the timer, the bots, and the
   * seats a spent pause has given up on.
   */
  private runPresence(state: MafiaState): boolean {
    if (state.phase === 'lobby' || state.phase === 'ended') return false;
    const tick = tickMafiaPresence(state, Date.now());
    if (!tick.changed) return false;

    if (tick.kicked) dropMafiaSeat(state, tick.kicked, Date.now());
    for (const playerId of tick.abandoned) dropMafiaSeat(state, playerId, Date.now());

    if (tick.kicked !== null || tick.abandoned.length > 0) {
      // Removing a seat can end the game outright — a town of two that loses one
      // of them has reached parity — so the victory check runs before the clock.
      checkVictory(state, Date.now());
    }

    // A pause parks the clock and a resume hands it back, so either way the
    // timer has to be re-read from the state rather than left as it was.
    this.armTimer(state);
    if (tick.resumed) this.bots.onChange(state);
    return true;
  }

  /** Every live table, once a second. Cheap: most tables have nothing to decide. */
  private tickAllPresence(): void {
    const now = Date.now();
    for (const state of this.sessions.values()) {
      if (presenceIdle(tablePresence(state), now)) continue;
      // The funnel, because a spent pause gives up on seats and giving up on a
      // seat can end the game: banking the careers is part of ending it.
      if (this.runPresence(state)) this.afterChange(state);
    }
  }

  private armTimer(state: MafiaState): void {
    this.clearTimer(state.code);
    // A stopped table has no deadline to run to: the clock is parked, and the
    // engine hands it back when everybody is here again.
    if (mafiaPaused(state)) return;
    if (state.phaseEndsAt === null || state.phase === 'ended' || state.phase === 'lobby') return;

    const delay = Math.max(50, state.phaseEndsAt - Date.now());
    const timer = setTimeout(() => {
      const current = this.sessions.get(state.code);
      if (!current || current.phaseEndsAt === null) return;
      // A trial may have moved the deadline since this timer was armed.
      if (current.phaseEndsAt > Date.now() + 100) {
        this.armTimer(current);
        return;
      }
      try {
        advanceMafia(current, Date.now(), this.rng);
        this.afterChange(current);
      } catch (error) {
        this.log.error({ err: error, code: state.code }, 'Mafia phase advance failed');
        // Never leave a table without a clock: push the deadline and retry,
        // rather than freezing the town on one bad transition.
        current.phaseEndsAt = Date.now() + 5000;
        this.armTimer(current);
      }
    }, delay);
    timer.unref();
    this.timers.set(state.code, timer);
  }

  private clearTimer(code: string): void {
    const timer = this.timers.get(code);
    if (timer) clearTimeout(timer);
    this.timers.delete(code);
  }

  /** Coalesces a burst of chat into one save. First message arms it, the rest ride along. */
  private persistSoon(state: MafiaState): void {
    if (this.chatFlush.has(state.code)) return;
    const timer = setTimeout(() => {
      this.chatFlush.delete(state.code);
      const current = this.sessions.get(state.code);
      if (current) void this.persist(current);
    }, CHAT_PERSIST_MS);
    timer.unref();
    this.chatFlush.set(state.code, timer);
  }

  private cancelChatFlush(code: string): void {
    const timer = this.chatFlush.get(code);
    if (timer) clearTimeout(timer);
    this.chatFlush.delete(code);
  }

  async persist(state: MafiaState): Promise<void> {
    try {
      await db
        .insert(mafiaSessions)
        .values({
          code: state.code,
          host_user_id: state.hostUserId,
          phase: state.phase,
          state: JSON.stringify(state),
          last_activity_at: state.lastActivityAt
        })
        .onConflictDoUpdate({
          target: mafiaSessions.code,
          set: { phase: state.phase, state: JSON.stringify(state), last_activity_at: state.lastActivityAt }
        });
    } catch (error) {
      this.log.error({ err: error, code: state.code }, 'Mafia persist failed');
    }
  }

  async restore(): Promise<number> {
    const rows = await db.select().from(mafiaSessions);
    let restored = 0;
    for (const row of rows) {
      if (row.last_activity_at < Date.now() - IDLE_TIMEOUT_MS) {
        await db.delete(mafiaSessions).where(eq(mafiaSessions.code, row.code));
        continue;
      }
      try {
        const state = JSON.parse(row.state) as MafiaState;
        // Clears the absences nothing can measure any more and hands a phase that
        // was mid-flight — including one a pause had parked — a fresh clock.
        restoreMafiaTable(state, Date.now());
        this.sessions.set(state.code, state);
        this.armTimer(state);
        restored++;
      } catch (error) {
        this.log.warn({ err: error, code: row.code }, 'could not restore Mafia session');
        await db.delete(mafiaSessions).where(eq(mafiaSessions.code, row.code));
      }
    }
    return restored;
  }

  startSweeping(): void {
    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();

    this.presenceTimer = setInterval(() => this.tickAllPresence(), PRESENCE_TICK_MS);
    this.presenceTimer.unref();
  }

  stopSweeping(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = undefined;
    for (const code of [...this.timers.keys()]) this.clearTimer(code);
    // Anything still waiting to be saved is saved now rather than dropped.
    for (const code of [...this.chatFlush.keys()]) {
      this.cancelChatFlush(code);
      const state = this.sessions.get(code);
      if (state) void this.persist(state);
    }
    this.bots.stop();
  }

  private async sweep(): Promise<void> {
    const cutoff = Date.now() - IDLE_TIMEOUT_MS;
    for (const [code, state] of this.sessions) {
      if (state.lastActivityAt < cutoff) {
        this.log.info({ code }, 'sweeping idle Mafia table');
        await this.destroy(code);
      }
    }
    await db.delete(mafiaSessions).where(lt(mafiaSessions.last_activity_at, cutoff));
  }
}
