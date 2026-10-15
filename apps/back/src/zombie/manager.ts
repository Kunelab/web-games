import { randomInt, randomUUID } from 'node:crypto';

import {
  applyGmAction,
  applyHeroAction,
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
  startGame,
  stepHorde,
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
  sayInRaid,
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
import { createChat } from 'chat-core';
import { buildLeaderboard } from 'game-core';
import { msg } from 'i18n';
import { pickBotName, type LobbyCard } from 'lobby-core';
import { presenceIdle, type KickRefusal } from 'presence-core';
import type { FastifyBaseLogger } from 'fastify';

import { db } from '../db/index.js';
import { endTrace, forgetTrace, trace } from '../trace.js';
import { gameResults, zombieSessions } from '../db/schema.js';
import { czCareerService } from '../services/cz-career-service.js';
import { userService } from '../services/user-service.js';
import { TableHost, tableDeps, type Deadline, type PresenceVerdict, type TableOptions } from '../tables/host.js';
import { snapshotRow, tableStore } from '../tables/store.js';

/**
 * Owns every live CoronaZ raid, the way GameManager owns the quizzes: state in
 * memory for speed, snapshot to SQLite on every phase change, timers on the
 * server because a client that never sends "time's up" must not be able to stall
 * the horde. The machinery for all three is the shared `TableHost`; what is here
 * is the raid.
 *
 * The enemy phase against the AI is *paced*, not instant: one zombie activates
 * every beat and the room watches the horde close in, which is most of the dread.
 */

const IDLE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
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
  /** Every live raid, and everything that keeps one alive between actions. */
  readonly tables: TableHost<CzState>;
  private listener: CzTransitionListener | null = null;
  private rewardListener: CzRewardListener | null = null;
  /**
   * Raids whose game master has handed the rest of the horde to the server.
   *
   * Remembered rather than inferred from a live timer, because a pause cancels
   * that timer: without this, stopping the clock mid-handover would return the
   * horde to a game master who had already stepped away from it.
   */
  private readonly handingOver = new Set<string>();
  /** The last beat written to each raid's log, so a phase is recorded once. */
  private readonly beats = new Map<string, string>();

  constructor(
    private readonly log: FastifyBaseLogger,
    options: TableOptions
  ) {
    this.tables = new TableHost<CzState>(
      {
        game: 'coronaz',
        idleMs: IDLE_TIMEOUT_MS,
        revive: (saved, now) => this.revive(saved as CzState, now),
        // Timers do not survive a restart; the phase waits for a human, same
        // policy as the quizzes. Bot heartbeats, though, restart themselves.
        restored: (state) => this.scheduleBots(state),
        row: snapshotRow,
        deadline: (state) => this.deadline(state),
        presence: {
          idle: (state, now) => presenceIdle(raidPresence(state), now),
          tick: (state, now) => this.runPresence(state, now),
          changed: (state) => {
            this.listener?.(state);
            this.tables.save(state);
          }
        },
        release: (state) => this.release(state),
        card: (state) => this.card(state),
        seated: (state) => Object.keys(state.heroes).length,
        begin: async (state, bots) => {
          // One call each: CoronaZ seats bots one at a time because each draws its
          // own mindset and loadout, which is what keeps a squad of them a squad.
          for (let i = 0; i < bots; i++) {
            this.addBot(state.code, 'expert');
          }
          await this.start(state.code);
        }
      },
      tableDeps(log, options, tableStore(db, zombieSessions))
    );
  }

  onTransition(listener: CzTransitionListener): void {
    this.listener = listener;
  }

  onRewards(listener: CzRewardListener): void {
    this.rewardListener = listener;
  }

  /**
   * A phone reporting in. The hot path, so it does as little as possible.
   *
   * Nothing is broadcast or saved on an ordinary beat: only a survivor coming
   * back out of the dark is news, and only then does the room need telling.
   */
  beat(code: string, playerId: string): void {
    const state = this.tables.get(code);
    if (!state?.heroes[playerId]) return;
    // The beat is recorded either way — that record is what lets the tick notice
    // the beats stopping later — but only a survivor coming back is news. A
    // seat coming back out of the dark is news whatever the pause model then
    // decides; a resume also restarts the clock, which is worth saving rather
    // than leaving to the next unrelated write.
    if (noteHeroAlive(state, playerId, this.tables.now())) this.tables.presenceChanged(state);
  }

  /**
   * A socket that dropped. Starts the resync window, and pauses nothing yet.
   *
   * A closed connection is better evidence than silence, so the window opens now
   * rather than after two missed beats — but the tick is still what decides,
   * several seconds later, whether the raid actually stops.
   */
  markGone(code: string, playerId: string): void {
    const state = this.tables.get(code);
    if (!state?.heroes[playerId]) return;
    noteHeroSilent(state, playerId, this.tables.now());
    this.tables.presenceChanged(state);
  }

  proposeKick(code: string, playerId: string, targetId: string): { ok: boolean; reason?: KickRefusal } {
    const state = this.tables.get(code);
    if (!state) return { ok: false, reason: 'not-seated' };
    const opened = proposeHeroKick(state, playerId, targetId, this.tables.now());
    if (!opened.ok) return { ok: false, reason: opened.reason };
    this.tables.presenceChanged(state);
    return { ok: true };
  }

  voteKick(code: string, playerId: string, yes: boolean): { ok: boolean; reason?: KickRefusal } {
    const state = this.tables.get(code);
    if (!state) return { ok: false, reason: 'not-seated' };
    const cast = voteHeroKick(state, playerId, yes);
    if (!cast.ok) return { ok: false, reason: cast.reason };
    // A ballot may be the one that carries it, so the model is advanced on the
    // spot rather than leaving the room to wait up to a second for the ticker.
    this.tables.presenceChanged(state);
    return { ok: true };
  }

  /**
   * Runs the pause model for one raid and acts on what it decided.
   *
   * The engine has already stopped or restarted the phase clock by the time this
   * reads the result — that is what tickRaidPresence does — so all that is left
   * here is the machinery a clock change implies: the horde, the bot beats, and
   * the seats a spent pause has given up on. The phase timer itself is the
   * host's, which re-reads it after every change this reports.
   */
  private runPresence(state: CzState, now: number): PresenceVerdict {
    if (state.phase !== 'heroes' && state.phase !== 'enemy') return 'quiet';
    const tick = tickRaidPresence(state, now);
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
      // deadline (the host parks it, since a paused raid names none), the horde
      // stepping through its activations, and the bots.
      this.tables.cancel(state.code);
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
        void this.tables
          .destroy(state.code)
          .catch((error: unknown) =>
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

  /** A saved raid read back after a restart, or null when the current rules cannot read it. */
  private revive(state: CzState, now: number): CzState | null {
    // A raid saved by a build with fewer settings comes back missing them,
    // and a missing setting read as a string is a crash somewhere far from
    // here. The schema fills every gap with a fresh raid's default.
    const revived = gameConfigSchema.safeParse(state.config);
    if (revived.success) state.config = revived.data;
    /**
     * A raid saved by an older build carries the old board — one square room
     * per cell, two door bits — and no amount of care would let the current
     * rules read it. There is nothing to migrate here (unlike the accounts
     * and the results, which are their own tables): the honest move is to
     * drop the session and let the table start a fresh raid.
     */
    if (!Array.isArray(state.board?.cellRoom)) {
      this.log.warn({ code: state.code }, 'CoronaZ session predates the room model, dropping it');
      return null;
    }
    /**
     * Every socket in the world is gone, so an absence measured before the
     * restart says nothing about now — and a pause with nobody left to end it
     * would freeze the raid forever. Everybody's resync window re-opens from
     * here, because nobody is connected any more whatever the snapshot says.
     * The kick list survives.
     */
    // Raids saved before the chat existed come back without one.
    state.chat ??= createChat();
    restoreRaidPresence(state, now);
    // Timers do not survive a restart; the phase waits for a human, same
    // policy as the quizzes.
    state.phaseEndsAt = null;
    return state;
  }

  /**
   * A new raid, under a code no other room in the house is using: a player
   * typing a code into the wrong join screen should get "no such game", never
   * someone else's game. The shared registry behind `tables` sees to that.
   */
  async create(options: {
    /** Null for a hostless quick match: nobody opened this one. */
    hostUserId: number | null;
    config: unknown;
    /** Replay a world: same seed + same config = same map and dice. */
    seed?: number;
    /** The game master's lobby pick: one class perk plus up to two globals. */
    gmLoadout?: string[];
  }): Promise<CzState> {
    const parsed = gameConfigSchema.safeParse(options.config ?? {});
    const config: GameConfig = parsed.success ? parsed.data : gameConfigSchema.parse({});

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

    // Everything awaited is behind us: the code is taken and filed in one step.
    return this.tables.create((code) =>
      createGame({
        code,
        hostToken: randomUUID(),
        gmToken: randomUUID(),
        hostUserId: options.hostUserId,
        config,
        seed: options.seed ?? randomInt(2 ** 31),
        gmPerks,
        gmLoadout: config.mode === 'gm' ? validGmLoadout(config.gmClass, options.gmLoadout ?? []) : []
      })
    );
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
    const state = this.tables.get(code);
    if (!state) return null;
    // A raid in progress is not a thing to restart out from under the table.
    if (!raidOver(state)) return null;

    // Any pending AI beat belongs to the raid that just ended. Its phase timer
    // goes when the new raid is adopted and the clock is read afresh.
    this.tables.cancel(code, 'ai');

    const next = rematch(state, randomInt(2 ** 31));
    this.tables.adopt(next);
    this.tables.save(next);
    this.listener?.(next);
    return next;
  }

  /**
   * Writes the raid down. Never rejects and never resurrects a raid already
   * gone; see `TableHost.save`. Kept a promise for the callers that chain on it.
   */
  async persist(state: CzState): Promise<void> {
    this.tables.save(state);
  }

  /** What the raid keeps on the side, let go with it. Its timers go with the host's. */
  private release(state: CzState): void {
    const code = state.code;
    this.handingOver.delete(code);
    endTrace('coronaz', code, {
      phase: state.phase,
      turn: state.turn,
      survivors: Object.values(state.heroes)
        .filter((hero) => hero.alive)
        .map((hero) => hero.name)
    });
    forgetTrace('coronaz', code);
    this.beats.delete(code);
  }

  /**
   * Its card on the public board: a raid that has not started, and asked to be
   * found.
   */
  private card(state: CzState): LobbyCard | null {
    if (state.phase !== 'lobby' || !state.config.public) return null;
    return {
      game: 'coronaz',
      code: state.code,
      title: state.config.name || msg(`coronaz.scenario.${state.config.scenario}.name`),
      detail: msg(state.config.mode === 'gm' ? 'lobby.card.hordeGm' : 'lobby.card.hordeAi'),
      host: null,
      players: Object.keys(state.heroes).length,
      maxPlayers: 5,
      createdAt: state.lastActivityAt,
      quick: false,
      locked: state.config.password.length > 0
    };
  }

  /**
   * The raid as the flight recorder sees it: one line per beat.
   *
   * Coarser than Mafia's on purpose. A raid has no model in it and no free-form
   * speech to interpret, so what is worth keeping is the shape of the fight —
   * whose turn it is, who is still standing, how much of the horde is left —
   * and the actions that got it there. That is enough to answer the questions
   * this game actually raises afterwards: where the party lost its health, which
   * turn the horde took over, whether a bot spent its AP on anything.
   */
  private recordBeat(state: CzState): void {
    const signature = `${state.phase}:${state.turn}`;
    if (this.beats.get(state.code) === signature) return;
    this.beats.set(state.code, signature);

    const heroes = Object.values(state.heroes);
    trace('coronaz', state.code).event('phase', {
      phase: state.phase,
      turn: state.turn,
      alive: heroes.filter((hero) => hero.alive && !hero.escaped).length,
      zombies: Object.keys(state.zombies).length,
      kills: state.killsTotal,
      keys: state.keysCollected,
      hp: heroes.map((hero) => ({ name: hero.name, bot: hero.isBot ?? false, hp: hero.hp, ap: hero.ap, room: hero.roomId }))
    });
  }

  /** Persist, notify screens, arm whatever timer the new phase needs. */
  private async afterTransition(state: CzState): Promise<void> {
    this.recordBeat(state);
    if (raidOver(state) && !state.resultsRecorded) {
      state.resultsRecorded = true;
      try {
        await this.recordResult(state);
      } catch (error) {
        this.log.error({ err: error, code: state.code }, 'could not record CoronaZ result');
      }
    }

    this.tables.save(state);
    this.listener?.(state);
    this.tables.arm(state);
    this.scheduleBots(state);
  }

  async start(code: string): Promise<void> {
    const state = this.tables.get(code);
    if (!state) return;
    startGame(state);
    trace('coronaz', code, { config: state.config }).event('deal', {
      seed: state.seed,
      objectives: state.objectives,
      heroes: Object.values(state.heroes).map((hero) => ({
        name: hero.name,
        bot: hero.isBot ?? false,
        skill: hero.bot?.skill ?? null,
        mindset: hero.bot?.mindset ?? null,
        hero: hero.heroId,
        hp: hero.maxHp
      }))
    });
    await this.afterTransition(state);
  }

  /** Seats a machine teammate. Lobby only, host's call. */
  addBot(code: string, skill: string): { ok: boolean; error?: string } {
    const state = this.tables.get(code);
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
    this.tables.save(state);
    this.listener?.(state);
    return { ok: true };
  }

  /**
   * Says something in the raid.
   *
   * Rate limiting, length and whitespace are `chat-core`'s job — the same code
   * that polices Mafia's town square. All this adds is who is allowed to speak,
   * which is a question only the raid can answer.
   */
  say(code: string, playerId: string, text: string): { ok: boolean; error?: string } {
    const state = this.tables.get(code);
    if (!state) return { ok: false, error: 'Partie introuvable' };

    const result = sayInRaid(state, playerId, text, Date.now());
    if (!result.ok) return { ok: false, error: result.error };

    trace('coronaz', code).event('chat', {
      name: state.heroes[playerId]?.name,
      bot: state.heroes[playerId]?.isBot ?? false,
      turn: state.turn,
      text
    });
    state.lastActivityAt = Date.now();
    this.tables.save(state);
    this.listener?.(state);
    return { ok: true };
  }

  removeBot(code: string, playerId: string): void {
    const state = this.tables.get(code);
    const hero = state?.heroes[playerId];
    if (!state || !hero?.isBot || state.phase !== 'lobby') return;
    delete state.heroes[playerId];
    this.tables.save(state);
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
    if (!pending || this.tables.pending(state.code, 'bot')) return;

    const code = state.code;
    this.tables.schedule(code, 'bot', 900, () => this.botBeat(code));
  }

  private async botBeat(code: string): Promise<void> {
    const state = this.tables.get(code);
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

    const after = this.tables.get(code);
    if (after) this.scheduleBots(after);
  }

  /** A hero action; ends the phase early once everyone is done. */
  async heroAction(code: string, playerId: string, action: HeroAction): Promise<ActionResult> {
    const state = this.tables.get(code);
    if (!state) return { ok: false, error: 'Partie introuvable' };

    const before = state.heroes[playerId];
    const result = applyHeroAction(state, playerId, action);

    /**
     * Every action either side of the door, refusals included.
     *
     * A refused action is the more interesting of the two: it is what a bot
     * wasting its turn looks like, and what a phone that thinks it can reach a
     * room it cannot looks like, and neither leaves any other trace.
     */
    trace('coronaz', code).event('act', {
      name: before?.name,
      bot: before?.isBot ?? false,
      turn: state.turn,
      phase: state.phase,
      ap: before?.ap,
      hp: before?.hp,
      room: before?.roomId,
      action,
      ok: result.ok,
      error: result.ok ? null : result.error
    });

    /**
     * A refused action changes nothing, so it must TOUCH nothing. Running the
     * transition machinery here is what froze games: equipping loot a beat
     * after the horde's phase began re-armed the phase timer under the same
     * key the AI stepper was parked on, cancelling the horde's next move with
     * nothing to replace it. The phase then waited forever. (The two now live
     * in separate slots of the host and cannot reach each other, but a refusal
     * still has no business saving, broadcasting or re-arming anything.)
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
    const state = this.tables.get(code);
    if (!state) return { ok: false, error: 'Partie introuvable' };

    const result = applyGmAction(state, action);
    // Same law as the heroes: a refused action touches nothing.
    if (!result.ok) return result;

    state.lastActivityAt = Date.now();
    await this.afterTransition(state);
    return result;
  }

  async gmEnd(code: string): Promise<void> {
    const state = this.tables.get(code);
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
   * at the same beat, closing with the phase change. Nothing about the horde's
   * competence depends on which hand moved it.
   *
   * The dens stay shut, as they do all game against him: he buys his
   * reinforcements, and `stepHorde` is what decides that. This stepper used to
   * fire them on its own, which paid a free wave for every turn he handed over.
   *
   * A game master who runs out of clock instead loses the horde's whole turn in
   * silence, and one who runs out of patience had only "concede" — so this is the
   * difference between a raid that ends badly and a raid that ends.
   */
  gmAuto(code: string): void {
    const state = this.tables.get(code);
    if (!state || state.phase !== 'enemy' || raidPaused(state)) return;
    // Already handing over: a second tap must not start a second beat loop, or
    // the horde would activate twice per tick.
    if (this.tables.pending(code, 'ai')) return;
    this.handingOver.add(code);
    this.scheduleAiStep(code);
  }

  private async toEnemyPhase(state: CzState): Promise<void> {
    /**
     * Only ever out of the survivors' turn. `beginEnemyPhase` used to refuse any
     * other phase by itself; `stepHorde` takes whatever beat comes next, and in the
     * horde's own turn that is a creature moving, not the board changing hands.
     */
    if (state.phase !== 'heroes') return;
    // A new horde turn is the game master's again until he says otherwise.
    this.handingOver.delete(state.code);
    stepHorde(state);
    await this.afterTransition(state);

    // The horde has the board now; only a raid settled during the save (the last
    // seat dropping) leaves it nothing to step.
    if (state.config.mode === 'ai' && !raidOver(state)) {
      this.scheduleAiStep(state.code);
    }
    // GM mode: the deadline timer armed by afterTransition does the rest.
  }

  /**
   * One AI beat: one step of the horde's turn, shown to the room, and the next beat
   * booked. What a step *is* — which creature moves, whether the dens fire, when
   * the board goes back — is `stepHorde`'s; what is left here is only how long the
   * room gets to watch each one.
   */
  private scheduleAiStep(code: string, delay = AI_STEP_MS): void {
    // Parked in a slot of its own: the phase deadline is the host's, and the
    // two must never be able to cancel each other.
    this.tables.schedule(code, 'ai', delay, async () => {
      const state = this.tables.get(code);
      if (!state || state.phase !== 'enemy') return;
      // The clock stopped between this beat being booked and it firing: the
      // horde waits with everybody else, and resuming re-books it.
      if (raidPaused(state)) return;

      const step = stepHorde(state);

      if (step.kind === 'ended') {
        // The survivors have the board back, or the last bite decided the raid.
        await this.afterTransition(state);
        return;
      }

      this.tables.save(state);
      this.listener?.(state);
      /**
       * The next beat is paced by whether there was anything to watch.
       *
       * The slow beat is the point of the phase — the room watches the horde
       * close in, and that dread is most of the game. It is also the reason a
       * large district crawls: most of a horde is streets away behind a wall,
       * and a beat spent on a creature nobody can see is the table sitting in
       * silence for no reason. Seen creatures keep their beat; the rest are
       * resolved as fast as the broadcasts can carry them. The dens always get
       * the full beat: it is the breath between the reinforcements landing and
       * the board going back.
       */
      const seen = step.kind !== 'activated' || this.watched(state, step.act);
      this.scheduleAiStep(code, seen ? AI_STEP_MS : AI_QUIET_MS);
    });
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

  /**
   * Server-driven deadlines: hero phase clock, and the GM's clock.
   *
   * Keyed by the phase and timed by `phaseEndsAt`, which together are exactly
   * what the old timer checked before it fired: a raid whose phase or deadline
   * has moved on since is a stale timer, and the host lets it pass.
   */
  private deadline(state: CzState): Deadline<CzState> | null {
    if (state.phaseEndsAt === null) return null;
    if (state.phase !== 'heroes' && state.phase !== 'enemy') return null;
    // A stopped raid has no deadline to run to: the clock is parked, and the
    // engine hands it back when everybody is here again.
    if (raidPaused(state)) return null;

    const phase = state.phase;
    return {
      at: state.phaseEndsAt,
      key: phase,
      fire: async (current) => {
        if (phase === 'heroes') {
          await this.toEnemyPhase(current);
        } else {
          // The game master ran out of clock; the heroes get the board back.
          endEnemyPhase(current);
          await this.afterTransition(current);
        }
      }
    };
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
