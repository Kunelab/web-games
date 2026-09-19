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
  NO,
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
import type { MafiaBusy } from 'mafia-core';
import type { ChatMessage } from 'chat-core';
import type { Locale } from 'i18n';
import { eq, lt } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import { db } from '../db/index.js';
import { endTrace, forgetTrace, trace } from '../trace.js';
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
 * How long a *finished* table is kept before it is let go.
 *
 * The idle timeout is six hours, which is the right answer for a table somebody
 * might still come back to. A table whose game is over is not that: the masks
 * are off, the standings have been read, and all it does for the rest of the
 * day is hold memory and offer itself back to its host as resumable.
 *
 * Long enough that a phone reopening the results still finds them; short enough
 * that a host playing two games in an evening is never offered the first one
 * in the middle of the second.
 */
const FINISHED_GRACE_MS = 20 * 60 * 1000;

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
/** The one refusal the manager owns: the table is gone, so nothing else applies. */
const NO_SUCH_TABLE = () => NO.noTable();
/** Still a sentence, for the two throw sites where nothing renders a key. */
const NO_SUCH_TABLE_TEXT = 'Partie introuvable';

export type MafiaTransitionListener = (state: MafiaState) => void;
export type MafiaBusyListener = (code: string, busy: MafiaBusy) => void;
export type MafiaMessageListener = (state: MafiaState, message: ChatMessage) => void;
export type MafiaRewardListener = (state: MafiaState, rewards: MafiaGameReward[]) => void;

export class MafiaManager {
  private readonly sessions = new Map<string, MafiaState>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Pending chat-only saves, one per table at most. See CHAT_PERSIST_MS. */
  private readonly chatFlush = new Map<string, NodeJS.Timeout>();
  /** Tables whose careers are already banked; a table banks exactly once. */
  private readonly banked = new Set<string>();
  /** The last beat written to each table's log, so a phase is recorded once. */
  private readonly beats = new Map<string, string>();
  /** How many deaths each table's log already knows about. */
  private readonly mourned = new Map<string, number>();
  private listener: MafiaTransitionListener | null = null;
  private busyListener: MafiaBusyListener | null = null;
  /**
   * The last morning whose night has been written down, per table.
   *
   * `recordChange` fires on every stage of the day, and the night's report
   * hangs on the state until the next night overwrites it — so one night's
   * attacks were recorded again at each trial and each verdict, out of order
   * and several times over.
   */
  private readonly logged = new Map<string, number>();
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
      action: (code, botId, slot, second) => this.nightAction(code, botId, slot, second),
      dayAction: (code, botId, action) => this.dayAction(code, botId, action),
      will: (code, botId, text) => this.will(code, botId, text),
      whisper: (code, botId, slot, text) => this.whisper(code, botId, slot, text),
      get: (code) => this.sessions.get(code),
      busy: (code, busy) => this.busyListener?.(code, busy)
    });
  }

  onTransition(listener: MafiaTransitionListener): void {
    this.listener = listener;
  }

  onMessage(listener: MafiaMessageListener): void {
    this.messageListener = listener;
  }

  /**
   * Who is thinking, writing or reading, for the screens.
   *
   * Its own listener rather than a field on the board: it changes several times
   * a second and is worth nothing a moment later, so it must never drag a
   * projection, a persist or a round of bot planning behind it. See `MafiaBusy`.
   */
  onBusy(listener: MafiaBusyListener): void {
    this.busyListener = listener;
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

    /**
     * The one place a table's whole cast is known and nothing has happened yet.
     *
     * Roles are written down here, at the deal, rather than at the end: a game
     * that crashes, is swept or is killed by a power cut is exactly the game
     * somebody wants to read afterwards, and a log that only names the roles of
     * the games that finished tidily is no use for any of that.
     */
    trace('mafia', code, { config: state.config }).event('deal', {
      seats: Object.values(state.players).map((player) => ({
        slot: player.slot,
        name: player.name,
        bot: player.isBot,
        role: player.role
      }))
    });

    this.afterChange(state);
  }

  playerChat(code: string, playerId: string, channel: string, text: string): ActionOutcome {
    const state = this.sessions.get(code);
    if (!state) return { ok: false, error: NO_SUCH_TABLE() };
    const result = sayInChat(state, playerId, channel, text, Date.now());
    if (!result.ok) return result;

    state.lastActivityAt = Date.now();
    this.messageListener?.(state, result.message);

    const speaker = state.players[playerId];
    trace('mafia', code).event('chat', {
      slot: speaker?.slot,
      name: speaker?.name,
      bot: speaker?.isBot,
      channel,
      text,
      day: state.day,
      phase: state.phase,
      stage: state.stage
    });

    // The bots' ear reads the square when a person has spoken in it, not on a
    // fixed clock; this is how it hears.
    this.bots.onChat(state, result.message);
    this.persistSoon(state);
    return { ok: true };
  }

  /**
   * A ballot, and the one thing a ballot is that nothing else here is: a move
   * against a named seat.
   *
   * `afterChange` wakes the bots, but `onChange` is keyed on phase, day, stage
   * and trial, so a vote cast during a discussion changes none of those and the
   * table sleeps through it. The seat being voted for is exactly who ought to
   * be woken, so the vote says so explicitly.
   */
  vote(code: string, playerId: string, targetSlot: number | 'skip' | null): ActionOutcome {
    const result = this.mutate(code, (state) => castVote(state, playerId, targetSlot, Date.now()));
    if (result.ok) {
      const state = this.sessions.get(code);
      this.wrote(code, playerId, 'vote', { target: targetSlot });
      if (state && !mafiaPaused(state)) this.bots.onVote(state);
    }
    return result;
  }

  ballot(code: string, playerId: string, verdict: 'guilty' | 'innocent' | 'abstain'): ActionOutcome {
    const result = this.mutate(code, (state) => castBallot(state, playerId, verdict));
    if (result.ok) this.wrote(code, playerId, 'ballot', { verdict });
    return result;
  }

  /**
   * One move by one seat, as the recorder sees it.
   *
   * Written here rather than in the bot driver so that a person's move and a
   * bot's move are the same record: the interesting comparison in a log of this
   * game is nearly always "what did the table do", not "what did the bots do",
   * and the driver only knows half of it.
   */
  private wrote(code: string, playerId: string, what: string, data: Record<string, unknown>): void {
    const state = this.sessions.get(code);
    const player = state?.players[playerId];
    if (!state || !player) return;
    trace('mafia', code).event(what, {
      slot: player.slot,
      name: player.name,
      bot: player.isBot,
      day: state.day,
      phase: state.phase,
      stage: state.stage,
      ...data
    });
  }

  nightAction(
    code: string,
    playerId: string,
    targetSlot: number | null,
    secondTargetSlot?: number | null
  ): ActionOutcome {
    const result = this.mutate(code, (state) => setNightAction(state, playerId, targetSlot, secondTargetSlot));
    if (result.ok) this.wrote(code, playerId, 'night-action', { target: targetSlot, second: secondTargetSlot ?? null });
    return result;
  }

  whisper(code: string, playerId: string, targetSlot: number, text: string): ActionOutcome {
    const state = this.sessions.get(code);
    if (!state) return { ok: false, error: NO_SUCH_TABLE() };
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
    const result = this.mutate(code, (state) =>
      action.type === 'jail'
        ? jailTarget(state, playerId, action.targetSlot)
        : action.type === 'court'
          ? callCourt(state, playerId, Date.now())
          : revealMayor(state, playerId, Date.now())
    );
    if (result.ok) this.wrote(code, playerId, 'day-action', { ...action });
    return result;
  }

  will(code: string, playerId: string, text: string): ActionOutcome {
    const result = this.mutate(code, (state) => setLastWill(state, playerId, text));
    if (result.ok) this.wrote(code, playerId, 'will', { text });
    return result;
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
    this.beats.delete(code);
    this.mourned.delete(code);
    // Swept with the rest: a reused table code otherwise starts on a stale day
    // and swallows its first night trace event.
    this.logged.delete(code);
    // A table swept mid-game still closes its log, or its last minutes sit in a
    // buffer that nothing will ever flush. A table that never started has no
    // log, and `endTrace` will not invent one to close.
    endTrace('mafia', code, { reason: 'swept', phase: state?.phase ?? 'gone' });
    forgetTrace('mafia', code);
    if (state) await db.delete(mafiaSessions).where(eq(mafiaSessions.code, code));
  }

  /* ------------------------------ lifecycle ------------------------------ */

  private mustGet(code: string): MafiaState {
    const state = this.sessions.get(code);
    if (!state) throw new Error(NO_SUCH_TABLE_TEXT);
    return state;
  }

  private mutate(code: string, change: (state: MafiaState) => ActionOutcome): ActionOutcome {
    const state = this.sessions.get(code);
    if (!state) return { ok: false, error: NO_SUCH_TABLE() };
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
    this.recordChange(state);
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
      /**
       * The masks come off in the log too.
       *
       * The deal was written down at the start, so this is only the outcome and
       * who was still standing — but it is what turns a file of moves into a
       * game somebody can reason about afterwards, because every claim in it
       * can finally be scored against what was true.
       */
      endTrace('mafia', state.code, {
        winners: state.winners,
        day: state.day,
        survivors: Object.values(state.players)
          .filter((player) => player.alive)
          .map((player) => ({ slot: player.slot, role: player.role })),
        deaths: state.deaths.map((death) => ({
          slot: state.players[death.playerId]?.slot,
          role: state.players[death.playerId]?.role,
          day: death.day,
          phase: death.phase,
          source: death.source ?? null
        }))
      });
      this.bots.forget(state.code);
      void mafiaCareerService
        .recordGame(state)
        .then((rewards) => this.rewardListener?.(state, rewards))
        .catch((error: unknown) => this.log.error({ err: error, code: state.code }, 'Mafia career banking failed'));
    }
  }

  /**
   * The phase clock and the graveyard, as they move.
   *
   * Called from the one funnel every change goes through, and keyed on the same
   * signature the bot driver plans against, so a log and a table agree about
   * what a "beat" is. Deaths are written the first time they appear rather than
   * counted at the end: a night that killed two people is a different night
   * from one that killed one, and the file should say so where it happened.
   */
  private recordChange(state: MafiaState): void {
    const signature = `${state.phase}:${state.day}:${state.stage ?? '-'}:${state.trial?.accusedId ?? '-'}`;
    if (this.beats.get(state.code) === signature) return;
    this.beats.set(state.code, signature);

    const log = trace('mafia', state.code);
    log.event('phase', {
      phase: state.phase,
      day: state.day,
      stage: state.stage ?? null,
      onTrial: state.trial ? state.players[state.trial.accusedId]?.slot : null,
      alive: Object.values(state.players).filter((player) => player.alive).length,
      endsInMs: state.phaseEndsAt === null ? null : state.phaseEndsAt - Date.now()
    });

    /**
     * What every knife did last night, whether or not it produced a body.
     *
     * The deaths below say who died and to whom; this says who else was out,
     * what they hit, and why nothing came of it — armour, a doctor, a cell, or
     * a body somebody else had already made. Four explanations that used to
     * look identical from the outside, which is how a Vigilante firing into a
     * house the family had already emptied looked exactly like a Vigilante who
     * never fired at all.
     */
    if (state.phase === 'day' && state.nightLog && state.nightLog.length > 0 && this.logged.get(state.code) !== state.day) {
      this.logged.set(state.code, state.day);
      log.event('night', { day: state.day - 1, attacks: state.nightLog });
    }

    const seen = this.mourned.get(state.code) ?? 0;
    if (state.deaths.length > seen) {
      for (const death of state.deaths.slice(seen)) {
        const who = state.players[death.playerId];
        log.event('death', {
          slot: who?.slot,
          name: who?.name,
          bot: who?.isBot,
          role: who?.role,
          day: death.day,
          phase: death.phase,
          source: death.source ?? null,
          // Everybody whose knife reached this body, when more than one did.
          sources: death.sources ?? null,
          hidden: death.hidden ?? false
        });
      }
      this.mourned.set(state.code, state.deaths.length);
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
    const finished = Date.now() - FINISHED_GRACE_MS;
    for (const [code, state] of this.sessions) {
      const over = state.phase === 'ended';
      if (state.lastActivityAt < cutoff || (over && state.lastActivityAt < finished)) {
        this.log.info({ code, over }, 'sweeping Mafia table');
        await this.destroy(code);
      }
    }
    await db.delete(mafiaSessions).where(lt(mafiaSessions.last_activity_at, cutoff));
  }
}
