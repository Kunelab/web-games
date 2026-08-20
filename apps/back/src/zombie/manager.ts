import { randomInt, randomUUID } from 'node:crypto';

import {
  activateNextZombie,
  applyGmAction,
  applyHeroAction,
  beginEnemyPhase,
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
  createGame,
  gameConfigSchema,
  playerMindsetNames,
  rematch,
  randomHeroLoadout,
  setLoadout,
  validGmLoadout,
  type ActionResult,
  type CzRaidReward,
  type CzState,
  type GameConfig,
  type GmAction,
  type HeroAction,
  type HeroState
} from 'coronaz-core';
import { generateJoinCode } from 'game-core';
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
/** Milliseconds between AI activations. Slow enough to read, fast enough to fear. */
const AI_STEP_MS = 700;

export type CzTransitionListener = (state: CzState) => void;

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
    this.sweepTimer = setInterval(
      () => {
        void this.sweep();
      },
      15 * 60 * 1000
    );
    this.sweepTimer.unref();
  }

  stopSweeping(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
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
    hostUserId: number;
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
      const host = await userService.getById(options.hostUserId);
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
    if (state.phase !== 'won' && state.phase !== 'lost') return null;

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
    for (const key of [code, `ai:${code}`, `bot:${code}`]) {
      const timer = this.timers.get(key);
      if (timer) clearTimeout(timer);
      this.timers.delete(key);
    }
    this.sessions.delete(code);
  }

  async destroy(code: string): Promise<void> {
    this.drop(code);
    await db.delete(zombieSessions).where(eq(zombieSessions.code, code));
  }

  /** Persist, notify screens, arm whatever timer the new phase needs. */
  private async afterTransition(state: CzState): Promise<void> {
    if ((state.phase === 'won' || state.phase === 'lost') && !state.resultsRecorded) {
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

  /** Names bots introduce themselves with. The flag in the view adds the 🤖. */
  private static readonly BOT_NAMES = ['Léon', 'Mireille', 'Gaspard', 'Odette', 'Marcel'];

  /** Seats a machine teammate. Lobby only, host's call. */
  addBot(code: string, skill: string): { ok: boolean; error?: string } {
    const state = this.sessions.get(code);
    if (!state) return { ok: false, error: 'Partie introuvable' };
    if (state.phase !== 'lobby') return { ok: false, error: 'La partie a commencé' };
    if (!(skill in SKILLS)) return { ok: false, error: 'Niveau inconnu' };

    const used = new Set(Object.values(state.heroes).map((hero) => hero.name));
    const name = CzManager.BOT_NAMES.find((candidate) => !used.has(candidate)) ?? 'Bot';
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
    if (state.phase !== 'heroes') return;
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
    if (!state || state.phase !== 'enemy') return;
    // Already handing over: a second tap must not start a second beat loop, or
    // the horde would activate twice per tick.
    if (this.timers.has(`ai:${code}`)) return;
    this.scheduleAiStep(code);
  }

  private async toEnemyPhase(state: CzState): Promise<void> {
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
  private scheduleAiStep(code: string): void {
    // Parked under its own key: the phase-deadline timer lives under `code`,
    // and the two must never be able to cancel each other.
    const timer = setTimeout(() => {
      this.timers.delete(`ai:${code}`);
      void (async () => {
        const state = this.sessions.get(code);
        if (!state || state.phase !== 'enemy') return;

        const more = activateNextZombie(state);

        if (state.phase !== 'enemy') {
          // The last bite ended the game.
          await this.afterTransition(state);
          return;
        }

        if (more) {
          await this.persist(state);
          this.listener?.(state);
          this.scheduleAiStep(code);
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
    }, AI_STEP_MS);

    timer.unref();
    this.timers.set(`ai:${code}`, timer);
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

    // Shared ranks on ties, same convention as the quiz leaderboard.
    let lastScore: number | null = null;
    let lastRank = 0;
    const players = scores.map((score, index) => {
      const rank = score.score === lastScore ? lastRank : index + 1;
      lastScore = score.score;
      lastRank = rank;
      return {
        name: score.name,
        score: score.score,
        rank,
        correct: 0,
        wrong: 0,
        fastestMs: null,
        roundsWon: 0,
        bestCombo: 0
      };
    });

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
