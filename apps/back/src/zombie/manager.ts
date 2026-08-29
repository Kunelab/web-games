import { randomInt, randomUUID } from 'node:crypto';

import {
  activateNextZombie,
  applyGmAction,
  applyHeroAction,
  beginEnemyPhase,
  checkEnd,
  computeCzAwards,
  decideHeroAction,
  endEnemyPhase,
  finalScores,
  gmClassDef,
  heroPhaseDone,
  joinBot,
  PLAYER_MINDSETS,
  SCENARIO_LABELS,
  SKILLS,
  spawnReinforcements,
  startGame,
  visibleRooms,
  createGame,
  dropHeroSeat,
  gameConfigSchema,
  noteHeroAlive,
  noteHeroSilent,
  proposeHeroKick,
  raidAbandoned,
  raidPaused,
  raidPresence,
  restoreRaidPresence,
  tickRaidPresence,
  voteHeroKick,
  playerMindsetNames,
  rematch,
  randomHeroLoadout,
  setLoadout,
  validGmLoadout,
  type Activation,
  type ActionResult,
  type CzRaidReward,
  type CzState,
  type GameConfig,
  type GmAction,
  type HeroAction,
  type HeroState
} from 'coronaz-core';
import { buildLeaderboard, generateJoinCode } from 'game-core';
import { pickBotName } from 'lobby-core';
import { presenceIdle, type KickRefusal } from 'presence-core';
import { eq, lt } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import { db } from '../db/index.js';
import { gameResults, zombieSessions } from '../db/schema.js';
import { czCareerService } from '../services/cz-career-service.js';
import { userService } from '../services/user-service.js';

/**
 * Owns every live CoronaZ raid, the way GameManager owns the quizzes: state in
 * memory for speed, snapshot to SQLite on every phase change, timers on the
 * server because a client that never sends "time's up" must not be able to stall
 * the horde.
 *
 * The enemy phase against the AI is *paced*, not instant: one zombie activates
 * every beat and the room watches the horde close in, which is most of the dread.
 */

const IDLE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
/**
 * How often the pause model is re-evaluated.
 *
 * Presence changes on its own schedule rather than on a player's: nobody sends
 * an event when a phone stops beating, so somebody has to notice. One second is
 * well inside the resync window, so a genuine drop stops the clock promptly
 * without the tick itself costing anything.
 */
const PRESENCE_TICK_MS = 1000;
/** Milliseconds between AI activations. Slow enough to read, fast enough to fear. */
const AI_STEP_MS = 700;
/**
 * And the beat for a creature nobody can see.
 *
 * Not zero: each activation is still broadcast, and firing them off with no gap
 * would hand every phone a burst of states to reconcile in one frame. Short
 * enough that a district's worth of unseen shuffling costs a moment rather than
 * the minute it used to.
 */
const AI_QUIET_MS = 40;

export type CzTransitionListener = (state: CzState) => void;

/**
 * What one presence evaluation leaves for its caller to do.
 *
 * A verdict rather than a boolean, because "the raid moved" and "the raid is
 * gone" want opposite things and a `true` cannot tell them apart. Saving a raid
 * that has just been destroyed writes its row straight back — `persist` is an
 * upsert — and the next restart reads the ghost in as a live session.
 *
 * `settled` means somebody else has already finished the job: the raid was
 * destroyed, or handed to `afterTransition`, which saves and announces it.
 */
type PresenceVerdict = 'quiet' | 'changed' | 'settled';

/**
 * A raid the engine has finished, either way.
 *
 * Spelled once, and as a function rather than inline, so that asking it after
 * something that may have ended the raid actually re-reads the phase: inline,
 * the narrowing from a guard further up hides the very transition being checked
 * for.
 */
function raidOver(state: CzState): boolean {
  return state.phase === 'won' || state.phase === 'lost';
}

/**
 * Fired once when a raid's careers have been banked.
 *
 * Separate from the transition listener because it is not a state broadcast: it
 * carries the difference between two careers, it happens exactly once per raid,
 * and it must land *after* the write rather than on every phase change.
 */
export type CzRewardListener = (state: CzState, rewards: CzRaidReward[]) => void;

export class CzManager {
  private readonly sessions = new Map<string, CzState>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private listener: CzTransitionListener | null = null;
  private rewardListener: CzRewardListener | null = null;
  private sweepTimer: NodeJS.Timeout | undefined;
  private presenceTimer: NodeJS.Timeout | undefined;
  /**
   * Raids whose game master has handed the rest of the horde to the server.
   *
   * Remembered rather than inferred from a live timer, because a pause cancels
   * that timer: without this, stopping the clock mid-handover would return the
   * horde to a game master who had already stepped away from it.
   */
  private readonly handingOver = new Set<string>();

  constructor(private readonly log: FastifyBaseLogger) {}

  onTransition(listener: CzTransitionListener): void {
    this.listener = listener;
  }

  onRewards(listener: CzRewardListener): void {
    this.rewardListener = listener;
  }

  get(code: string): CzState | undefined {
    return this.sessions.get(code);
  }

  activeCodes(): ReadonlySet<string> {
    return new Set(this.sessions.keys());
  }

  /**
   * A phone reporting in. The hot path, so it does as little as possible.
   *
   * Nothing is broadcast or saved on an ordinary beat: only a survivor coming
   * back out of the dark is news, and only then does the room need telling.
   */
  beat(code: string, playerId: string): void {
    const state = this.sessions.get(code);
    if (!state?.heroes[playerId]) return;
    // The beat is recorded either way — that record is what lets the tick notice
    // the beats stopping later — but only a survivor coming back is news.
    if (!noteHeroAlive(state, playerId, Date.now())) return;

    const verdict = this.runPresence(state);
    if (verdict === 'settled') return;
    // A seat coming back out of the dark is news either way; a resume also
    // restarts the clock, which is worth saving rather than leaving to the next
    // unrelated write.
    this.listener?.(state);
    if (verdict === 'changed') void this.persist(state);
  }

  /**
   * A socket that dropped. Starts the resync window, and pauses nothing yet.
   *
   * A closed connection is better evidence than silence, so the window opens now
   * rather than after two missed beats — but the tick is still what decides,
   * several seconds later, whether the raid actually stops.
   */
  markGone(code: string, playerId: string): void {
    const state = this.sessions.get(code);
    if (!state?.heroes[playerId]) return;
    noteHeroSilent(state, playerId, Date.now());
    if (this.runPresence(state) === 'settled') return;
    this.listener?.(state);
    void this.persist(state);
  }

  proposeKick(code: string, playerId: string, targetId: string): { ok: boolean; reason?: KickRefusal } {
    const state = this.sessions.get(code);
    if (!state) return { ok: false, reason: 'not-seated' };
    const opened = proposeHeroKick(state, playerId, targetId, Date.now());
    if (opened.ok) {
      this.listener?.(state);
      void this.persist(state);
    }
    return opened.ok ? { ok: true } : { ok: false, reason: opened.reason };
  }

  voteKick(code: string, playerId: string, yes: boolean): { ok: boolean; reason?: KickRefusal } {
    const state = this.sessions.get(code);
    if (!state) return { ok: false, reason: 'not-seated' };
    const cast = voteHeroKick(state, playerId, yes);
    // A ballot may be the one that carries it, so the model is advanced here
    // rather than leaving the room to wait up to a second for the ticker.
    if (cast.ok && this.runPresence(state) !== 'settled') {
      this.listener?.(state);
      void this.persist(state);
    }
    return cast.ok ? { ok: true } : { ok: false, reason: cast.reason };
  }

  /**
   * Runs the pause model for one raid and acts on what it decided.
   *
   * The engine has already stopped or restarted the phase clock by the time this
   * reads the result — that is what tickRaidPresence does — so all that is left
   * here is the machinery a clock change implies: the phase timer, the horde, the
   * bot beats, and the seats a spent pause has given up on.
   */
  private runPresence(state: CzState): PresenceVerdict {
    if (state.phase !== 'heroes' && state.phase !== 'enemy') return 'quiet';
    const tick = tickRaidPresence(state, Date.now());
    if (!tick.changed) return 'quiet';

    if (tick.kicked) dropHeroSeat(state, tick.kicked);
    for (const playerId of tick.abandoned) dropHeroSeat(state, playerId);

    if (tick.kicked !== null || tick.abandoned.length > 0) {
      /**
       * Losing the last survivor still inside can end the raid, and only the
       * engine knows how it ended: a district whose other heroes are already out
       * has been *won*, and calling that an abandonment would delete a finished
       * raid along with everybody's scores. `dropHeroSeat` records a forfeit and
       * nothing else, so the ending is checked for here — the same beat Mafia
       * checks victory on after a seat goes.
       */
      checkEnd(state);
    }

    if (tick.paused) {
      // Everything that moves on its own stops with the clock: the phase
      // deadline, the horde stepping through its activations, and the bots.
      this.dropTimers(state.code);
    }

    if (raidOver(state)) {
      // The raid ended on this tick, so it finishes the way every other raid
      // does: results banked, saved and announced by the one path that knows how.
      void this.afterTransition(state).catch((error: unknown) =>
        this.log.error({ err: error, code: state.code }, 'CoronaZ presence ending failed')
      );
      return 'settled';
    }

    if (tick.resumed) {
      /**
       * A raid whose last human has gone is over rather than continuing against
       * an empty room: the horde would otherwise keep activating against four
       * bots nobody is watching until the idle sweep noticed hours later.
       *
       * Only reached when `checkEnd` did not end the raid, so this really is an
       * abandonment and not a finish — there is no result to record.
       */
      if (raidAbandoned(state)) {
        void this.destroy(state.code).catch((error: unknown) =>
          this.log.error({ err: error, code: state.code }, 'CoronaZ abandoned raid cleanup failed')
        );
        return 'settled';
      }

      /**
       * The seat that just left may have been the last one the phase was waiting
       * on, in which case the horde should move now rather than when the clock
       * happens to run out. `dropHeroSeat` marks the seat ready for exactly this
       * reason: a survivor nobody is playing must not hold up the turn.
       */
      if (state.phase === 'heroes' && heroPhaseDone(state)) {
        void this.toEnemyPhase(state).catch((error: unknown) =>
          this.log.error({ err: error, code: state.code }, 'CoronaZ resume into enemy phase failed')
        );
        return 'settled';
      }

      this.armTimer(state);
      this.scheduleBots(state);
      /**
       * The horde was mid-turn when the clock stopped, so it picks up where it
       * was. In AI mode that is simply how the phase runs; in game-master mode it
       * means a handover he had already asked for, which the pause must not
       * quietly cancel — `handingOver` is what remembers that he asked.
       */
      if (state.phase === 'enemy' && (state.config.mode === 'ai' || this.handingOver.has(state.code))) {
        this.scheduleAiStep(state.code);
      }
    }
    return 'changed';
  }

  /** Every live raid, once a second. Cheap: most have nothing to decide. */
  private tickAllPresence(): void {
    const now = Date.now();
    for (const state of this.sessions.values()) {
      if (presenceIdle(raidPresence(state), now)) continue;
      if (this.runPresence(state) === 'changed') {
        this.listener?.(state);
        void this.persist(state);
      }
    }
  }

  /** Cancels every timer parked against a raid, without forgetting the raid. */
  private dropTimers(code: string): void {
    for (const key of [code, `ai:${code}`, `bot:${code}`]) {
      const timer = this.timers.get(key);
      if (timer) clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  async restore(): Promise<number> {
    const rows = await db.select().from(zombieSessions);
    let restored = 0;

    for (const row of rows) {
      if (row.last_activity_at < Date.now() - IDLE_TIMEOUT_MS) {
        await db.delete(zombieSessions).where(eq(zombieSessions.code, row.code));
        continue;
      }
      try {
        const state = JSON.parse(row.state) as CzState;
        /**
         * A raid saved by an older build carries the old board — one square room
         * per cell, two door bits — and no amount of care would let the current
         * rules read it. There is nothing to migrate here (unlike the accounts
         * and the results, which are their own tables): the honest move is to
         * drop the session and let the table start a fresh raid.
         */
        if (!Array.isArray(state.board?.cellRoom)) {
          this.log.warn({ code: row.code }, 'CoronaZ session predates the room model, dropping it');
          await db.delete(zombieSessions).where(eq(zombieSessions.code, row.code));
          continue;
        }
        /**
         * Every socket in the world is gone, so an absence measured before the
         * restart says nothing about now — and a pause with nobody left to end it
         * would freeze the raid forever. Everybody's resync window re-opens from
         * here, because nobody is connected any more whatever the snapshot says.
         * The kick list survives.
         */
        restoreRaidPresence(state, Date.now());
        // Timers do not survive a restart; the phase waits for a human, same
        // policy as the quizzes. Bot heartbeats, though, restart themselves.
        state.phaseEndsAt = null;
        this.sessions.set(state.code, state);
        this.scheduleBots(state);
        restored += 1;
      } catch (error) {
        this.log.warn({ err: error, code: row.code }, 'could not restore CoronaZ session, dropping it');
        await db.delete(zombieSessions).where(eq(zombieSessions.code, row.code));
      }
    }

    return restored;
  }

  startSweeping(): void {
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();

    this.presenceTimer = setInterval(() => this.tickAllPresence(), PRESENCE_TICK_MS);
    this.presenceTimer.unref();
  }

  stopSweeping(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = undefined;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private async sweep(): Promise<void> {
    const cutoff = Date.now() - IDLE_TIMEOUT_MS;
    for (const [code, state] of this.sessions) {
      if (state.lastActivityAt < cutoff) this.drop(code);
    }
    await db.delete(zombieSessions).where(lt(zombieSessions.last_activity_at, cutoff));
  }

  /**
   * Codes share one namespace with the quiz sessions: a player typing a code into
   * the wrong join screen should get "no such game", never someone else's game.
   */
  async create(options: {
    /** Null for a hostless quick match: nobody opened this one. */
    hostUserId: number | null;
    config: unknown;
    quizCodes: ReadonlySet<string>;
    /** Replay a world: same seed + same config = same map and dice. */
    seed?: number;
    /** The game master's lobby pick: one class perk plus up to two globals. */
    gmLoadout?: string[];
  }): Promise<CzState> {
    const parsed = gameConfigSchema.safeParse(options.config ?? {});
    const config: GameConfig = parsed.success ? parsed.data : gameConfigSchema.parse({});

    const taken = new Set([...options.quizCodes, ...this.activeCodes()]);
    let code = '';
    for (let attempt = 0; attempt < 200; attempt++) {
      code = generateJoinCode((maxExclusive) => randomInt(maxExclusive));
      if (!taken.has(code)) break;
    }

    // The game master's roguelite perks ride in from his career, under his login.
    let gmPerks: string[] = [];
    if (config.mode === 'gm') {
      const host = options.hostUserId === null ? undefined : await userService.getById(options.hostUserId);
      if (host?.login) {
        gmPerks = await czCareerService.gmPerks(host.login);
      }
      // The class is server truth: unknown or still locked falls back to the
      // plain horde rather than trusting the client's config.
      try {
        gmClassDef(config.gmClass);
      } catch {
        config.gmClass = 'horde';
      }
      if (host?.login && !(await czCareerService.gmClassAllowed(host.login, config.gmClass))) {
        config.gmClass = 'horde';
      }
    }

    const state = createGame({
      code,
      hostToken: randomUUID(),
      gmToken: randomUUID(),
      hostUserId: options.hostUserId,
      config,
      seed: options.seed ?? randomInt(2 ** 31),
      gmPerks,
      gmLoadout: config.mode === 'gm' ? validGmLoadout(config.gmClass, options.gmLoadout ?? []) : []
    });

    this.sessions.set(state.code, state);
    await this.persist(state);
    return state;
  }

  /**
   * Another raid for the same table, in the same slot.
   *
   * Only from a finished raid, and only with the host's token. The code and every
   * seat token are kept, so every phone in the room is already holding the key to
   * the new lobby: nothing is read out, nobody re-joins, nobody re-picks. New seed,
   * so it is a new world — replaying a map is what the setup screen's seed field is
   * for.
   */
  async rematch(code: string): Promise<CzState | null> {
    const state = this.sessions.get(code);
    if (!state) return null;
    // A raid in progress is not a thing to restart out from under the table.
    if (!raidOver(state)) return null;

    // Any pending AI beat belongs to the raid that just ended.
    for (const key of [code, `ai:${code}`]) {
      const timer = this.timers.get(key);
      if (timer) clearTimeout(timer);
      this.timers.delete(key);
    }

    const next = rematch(state, randomInt(2 ** 31));
    this.sessions.set(next.code, next);
    await this.persist(next);
    this.listener?.(next);
    return next;
  }

  async persist(state: CzState): Promise<void> {
    await db
      .insert(zombieSessions)
      .values({
        code: state.code,
        host_user_id: state.hostUserId,
        phase: state.phase,
        state: JSON.stringify(state),
        last_activity_at: state.lastActivityAt
      })
      .onConflictDoUpdate({
        target: zombieSessions.code,
        set: { phase: state.phase, state: JSON.stringify(state), last_activity_at: state.lastActivityAt }
      });
  }

  drop(code: string): void {
    this.dropTimers(code);
    this.handingOver.delete(code);
    this.sessions.delete(code);
  }

  async destroy(code: string): Promise<void> {
    this.drop(code);
    await db.delete(zombieSessions).where(eq(zombieSessions.code, code));
  }

  /** Persist, notify screens, arm whatever timer the new phase needs. */
  private async afterTransition(state: CzState): Promise<void> {
    if (raidOver(state) && !state.resultsRecorded) {
      state.resultsRecorded = true;
      try {
        await this.recordResult(state);
      } catch (error) {
        this.log.error({ err: error, code: state.code }, 'could not record CoronaZ result');
      }
    }

    await this.persist(state);
    this.listener?.(state);
    this.armTimer(state);
    this.scheduleBots(state);
  }

  async start(code: string): Promise<void> {
    const state = this.sessions.get(code);
    if (!state) return;
    startGame(state);
    await this.afterTransition(state);
  }

  /** Seats a machine teammate. Lobby only, host's call. */
  addBot(code: string, skill: string): { ok: boolean; error?: string } {
    const state = this.sessions.get(code);
    if (!state) return { ok: false, error: 'Partie introuvable' };
    if (state.phase !== 'lobby') return { ok: false, error: 'La partie a commencé' };
    if (!(skill in SKILLS)) return { ok: false, error: 'Niveau inconnu' };

    // The pop-culture cast the lobby shares with Mafia; the flag in the view adds
    // the 🤖. It used to be five French first names here, which meant a raid never
    // saw a sixth bot and never saw the same table twice as anything else.
    const name = pickBotName(
      Object.values(state.heroes).map((hero) => hero.name),
      randomInt
    );
    // A random play style per bot: a table of machines should be a table, not
    // four copies of one player.
    const mindset = playerMindsetNames[randomInt(playerMindsetNames.length)] ?? 'balanced';

    try {
      const bot = joinBot(state, name, mindset, skill);
      // A bot picks like a person would: one signature perk, two globals.
      setLoadout(state, bot.playerId, randomHeroLoadout(state.rng, bot.heroId));
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Impossible' };
    }
    void this.persist(state);
    this.listener?.(state);
    return { ok: true };
  }

  removeBot(code: string, playerId: string): void {
    const state = this.sessions.get(code);
    const hero = state?.heroes[playerId];
    if (!state || !hero?.isBot || state.phase !== 'lobby') return;
    delete state.heroes[playerId];
    void this.persist(state);
    this.listener?.(state);
  }

  /**
   * The bot heartbeat: one decision per beat, staggered so the room watches
   * teammates play rather than teleport. Runs only during the hero phase; the
   * bots use the exact policies the balance bench was calibrated with.
   */
  private scheduleBots(state: CzState): void {
    if (state.phase !== 'heroes' || raidPaused(state)) return;
    const pending = Object.values(state.heroes).some(
      (hero) => hero.isBot && hero.alive && !hero.escaped && !hero.ready
    );
    if (!pending || this.timers.has(`bot:${state.code}`)) return;

    const timer = setTimeout(() => {
      this.timers.delete(`bot:${state.code}`);
      void this.botBeat(state.code).catch((error: unknown) =>
        this.log.error({ err: error, code: state.code }, 'CoronaZ bot beat failed')
      );
    }, 900);
    timer.unref();
    this.timers.set(`bot:${state.code}`, timer);
  }

  private async botBeat(code: string): Promise<void> {
    const state = this.sessions.get(code);
    if (!state || state.phase !== 'heroes') return;

    const bot = Object.values(state.heroes).find(
      (hero): hero is HeroState => Boolean(hero.isBot) && hero.alive && !hero.escaped && !hero.ready
    );
    if (!bot) return;

    const mindset = PLAYER_MINDSETS[bot.bot?.mindset ?? 'balanced'] ?? PLAYER_MINDSETS.balanced;
    const skill = SKILLS[bot.bot?.skill ?? 'expert'] ?? SKILLS.expert;
    const action = mindset && skill ? decideHeroAction(state, bot, mindset, skill) : null;

    // `heroAction` does the rest: apply, broadcast, and hand the phase to the
    // horde once everyone is ready — bots and humans through one door.
    await this.heroAction(code, bot.playerId, action ?? { type: 'ready' });

    const after = this.sessions.get(code);
    if (after) this.scheduleBots(after);
  }

  /** A hero action; ends the phase early once everyone is done. */
  async heroAction(code: string, playerId: string, action: HeroAction): Promise<ActionResult> {
    const state = this.sessions.get(code);
    if (!state) return { ok: false, error: 'Partie introuvable' };

    const result = applyHeroAction(state, playerId, action);

    /**
     * A refused action changes nothing, so it must TOUCH nothing. Running the
     * transition machinery here is what froze games: equipping loot a beat
     * after the horde's phase began re-armed the phase timer under the same
     * key the AI stepper was parked on, cancelling the horde's next move with
     * nothing to replace it. The phase then waited forever.
     */
    if (!result.ok) {
      return result;
    }

    state.lastActivityAt = Date.now();

    if (state.phase === 'heroes' && heroPhaseDone(state)) {
      await this.toEnemyPhase(state);
    } else {
      await this.afterTransition(state);
    }

    return result;
  }

  async gmAction(code: string, action: GmAction): Promise<ActionResult> {
    const state = this.sessions.get(code);
    if (!state) return { ok: false, error: 'Partie introuvable' };

    const result = applyGmAction(state, action);
    // Same law as the heroes: a refused action touches nothing.
    if (!result.ok) return result;

    state.lastActivityAt = Date.now();
    await this.afterTransition(state);
    return result;
  }

  async gmEnd(code: string): Promise<void> {
    const state = this.sessions.get(code);
    if (!state || state.phase !== 'enemy') return;
    // Neither of the game master's out-of-turn powers goes through
    // `applyGmAction`, so the engine's own guard does not cover them: ending
    // the horde's turn while the raid is stopped would hand the board back to
    // survivors who are not all there to take it.
    if (raidPaused(state)) return;
    endEnemyPhase(state);
    await this.afterTransition(state);
  }

  /**
   * The game master hands the rest of the horde to the server.
   *
   * Reuses `scheduleAiStep` verbatim, which is the whole point: the creatures the
   * game master did not get to move play exactly as they would in AI mode, paced
   * at the same beat, closing with reinforcements and the phase change. Nothing
   * about the horde's competence depends on which hand moved it.
   *
   * A game master who runs out of clock instead loses the horde's whole turn in
   * silence, and one who runs out of patience had only "concede" — so this is the
   * difference between a raid that ends badly and a raid that ends.
   */
  gmAuto(code: string): void {
    const state = this.sessions.get(code);
    if (!state || state.phase !== 'enemy' || raidPaused(state)) return;
    // Already handing over: a second tap must not start a second beat loop, or
    // the horde would activate twice per tick.
    if (this.timers.has(`ai:${code}`)) return;
    this.handingOver.add(code);
    this.scheduleAiStep(code);
  }

  private async toEnemyPhase(state: CzState): Promise<void> {
    // A new horde turn is the game master's again until he says otherwise.
    this.handingOver.delete(state.code);
    beginEnemyPhase(state);
    await this.afterTransition(state);

    if (state.config.mode === 'ai' && state.phase === 'enemy') {
      this.scheduleAiStep(state.code);
    }
    // GM mode: the deadline timer armed by afterTransition does the rest.
  }

  /**
   * One AI beat: activate a zombie, show the room, book the next beat. When the
   * horde has moved, reinforcements arrive and the phase hands back to the heroes.
   */
  private scheduleAiStep(code: string, delay = AI_STEP_MS): void {
    // Parked under its own key: the phase-deadline timer lives under `code`,
    // and the two must never be able to cancel each other.
    const timer = setTimeout(() => {
      this.timers.delete(`ai:${code}`);
      void (async () => {
        const state = this.sessions.get(code);
        if (!state || state.phase !== 'enemy') return;
        // The clock stopped between this beat being booked and it firing: the
        // horde waits with everybody else, and resuming re-books it.
        if (raidPaused(state)) return;

        const act = activateNextZombie(state);

        if (state.phase !== 'enemy') {
          // The last bite ended the game.
          await this.afterTransition(state);
          return;
        }

        if (act.more) {
          await this.persist(state);
          this.listener?.(state);
          /**
           * The next beat is paced by whether there was anything to watch.
           *
           * The slow beat is the point of the phase — the room watches the horde
           * close in, and that dread is most of the game. It is also the reason a
           * large district crawls: most of a horde is streets away behind a wall,
           * and a beat spent on a creature nobody can see is the table sitting in
           * silence for no reason. Seen creatures keep their beat; the rest are
           * resolved as fast as the broadcasts can carry them.
           */
          this.scheduleAiStep(code, this.watched(state, act) ? AI_STEP_MS : AI_QUIET_MS);
          return;
        }

        spawnReinforcements(state);
        this.listener?.(state);
        // A breath between the reinforcements landing and the next phase.
        const closing = setTimeout(() => {
          this.timers.delete(`ai:${code}`);
          void (async () => {
            const current = this.sessions.get(code);
            if (!current || current.phase !== 'enemy') return;
            endEnemyPhase(current);
            await this.afterTransition(current);
          })().catch((error: unknown) => this.log.error({ err: error, code }, 'CoronaZ phase close failed'));
        }, AI_STEP_MS);
        closing.unref();
        this.timers.set(`ai:${code}`, closing);
      })().catch((error: unknown) => this.log.error({ err: error, code }, 'CoronaZ AI step failed'));
    }, delay);

    timer.unref();
    this.timers.set(`ai:${code}`, timer);
  }

  /**
   * Whether anybody could have seen that.
   *
   * A creature that bit somebody always counts — the victim saw it whatever the
   * fog says — and otherwise it is a question of where it walked: a horde
   * stepping into view has to be watched arriving, and one crossing a basement
   * nobody has a line on has nothing to show.
   *
   * Sight is taken per activation rather than once per phase because a hero dying
   * mid-horde changes it. It costs one ray-cast per survivor, against a beat this
   * is deciding whether to spend most of a second on.
   */
  private watched(state: CzState, act: Activation): boolean {
    if (act.struck) return true;
    const seen = visibleRooms(state);
    return act.visited.some((roomId) => seen.has(roomId));
  }

  /** Server-driven deadlines: hero phase clock, and the GM's clock. */
  private armTimer(state: CzState): void {
    const existing = this.timers.get(state.code);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(state.code);
    }

    if (state.phaseEndsAt === null) return;
    if (state.phase !== 'heroes' && state.phase !== 'enemy') return;
    // A stopped raid has no deadline to run to: the clock is parked, and the
    // engine hands it back when everybody is here again.
    if (raidPaused(state)) return;

    const phase = state.phase;
    const deadline = state.phaseEndsAt;
    const delay = Math.max(0, deadline - Date.now());

    const timer = setTimeout(() => {
      this.timers.delete(state.code);
      void (async () => {
        const current = this.sessions.get(state.code);
        // Stale timer: the phase already moved on.
        if (!current || current.phase !== phase || current.phaseEndsAt !== deadline) return;

        if (phase === 'heroes') {
          await this.toEnemyPhase(current);
        } else {
          // The game master ran out of clock; the heroes get the board back.
          endEnemyPhase(current);
          await this.afterTransition(current);
        }
      })().catch((error: unknown) => this.log.error({ err: error, code: state.code }, 'CoronaZ phase deadline failed'));
    }, delay);

    timer.unref();
    this.timers.set(state.code, timer);
  }

  /**
   * The raid's permanent trace, in the same table as the quizzes: history,
   * careers and badges apply to an evening of zombies exactly as to a blind test.
   */
  private async recordResult(state: CzState): Promise<void> {
    const scores = finalScores(state);
    if (scores.length === 0) return;

    // The careers first: trophies earned tonight should greet the next raid.
    const host = state.hostUserId === null ? undefined : await userService.getById(state.hostUserId);
    const rewards = await czCareerService.recordGame(state, host?.login ?? null);
    // And say so, before anyone puts the phone down. The rations were always
    // banked and never shown, so the progression was invisible until the next
    // lobby — which is a progression nobody has any reason to believe in.
    if (rewards.length > 0) this.rewardListener?.(state, rewards);

    // Ranked by the quiz's own scorer rather than by a second copy of its
    // tie rule: "same convention as the leaderboard" is now true by construction.
    const rankById = new Map(
      buildLeaderboard(new Map(scores.map((score) => [score.playerId, score.score]))).map((row) => [
        row.playerId,
        row.rank
      ])
    );
    const players = scores.map((score) => ({
      name: score.name,
      score: score.score,
      rank: rankById.get(score.playerId) ?? 0,
      correct: 0,
      wrong: 0,
      fastestMs: null,
      roundsWon: 0,
      bestCombo: 0
    }));

    await db.insert(gameResults).values({
      code: state.code,
      playlist_id: null,
      playlist_name: `CoronaZ · ${SCENARIO_LABELS[state.config.scenario].name}`,
      host_user_id: state.hostUserId,
      finished_at: Date.now(),
      rounds_total: state.turn,
      players: JSON.stringify(players),
      awards: JSON.stringify(computeCzAwards(state))
    });
  }
}
