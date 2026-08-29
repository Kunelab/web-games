import { randomInt, randomUUID } from 'node:crypto';

import { generateJoinCode } from 'game-core';
import {
  QUICK_PLAYLIST_KEY,
  armQuickCountdown,
  cancelQuickCountdown,
  createQuickLobby,
  dropQuickMember,
  joinQuickLobby,
  markQuickSeen,
  quickDecision,
  quickJoinPath,
  quickSize,
  quickSpecs,
  setQuickReady,
  setQuickBots,
  setQuickVote,
  tallyQuick,
  type LobbyCard,
  type LobbyGame,
  type QuickLaunch,
  type QuickLobby,
  type QuickOptionSpec
} from 'lobby-core';
import type { FastifyBaseLogger } from 'fastify';

import type { GameManager } from '../game/manager.js';
import type { MafiaManager } from '../mafia/manager.js';
import { playlistService } from '../services/playlist-service.js';
import type { CzManager } from '../zombie/manager.js';
import { coronazConfig, mafiaConfig, quizConfig, quizRounds } from './settings.js';

/**
 * Matchmaking, and the room that comes with it.
 *
 * The three games each own a lobby already, and each of those lobbies belongs to
 * whoever opened it: the host picks the playlist, the map and the moment. This
 * owns the other kind — the one you arrive at alone, where the settings were
 * rolled by a die and the start is a vote. That is a different object with a
 * different lifetime, which is why it is a manager of its own rather than a flag
 * on the other three.
 *
 * Nothing here is persisted. A quick room exists for the ninety seconds between
 * a player pressing the button and a game beginning; a restart in that window
 * loses a decision nobody had finished making, and writing it to SQLite would
 * buy a resumed lobby full of players who have long since walked away. The games
 * it *starts* are persisted exactly as any other, by the managers that own them.
 */

/** The tick that drives every countdown, every timeout and every sweep here. */
const TICK_MS = 1000;

/** A room nobody is in is kept this long, in case its last member is reloading. */
const EMPTY_GRACE_MS = 45_000;

/** How long a launched room stays addressable, so a late phone can be redirected. */
const LAUNCHED_LINGER_MS = 120_000;

/**
 * How long the real game waits for the room to walk through the door.
 *
 * Launching hands every phone a URL and every phone then has to connect, name
 * itself and take a seat. Starting the first round before they arrive would score
 * it against an empty room, so the game is created immediately — the code has to
 * exist for anyone to join it — and started once they are in, or when this runs
 * out, whichever comes first.
 */
const BOARDING_MS = 20_000;

/** A finished game stays replayable this long. After that, the table has moved on. */
const REPLAY_WINDOW_MS = 15 * 60 * 1000;

export type QuickTransitionListener = (lobby: QuickLobby, specs: QuickOptionSpec[]) => void;
export type QuickLaunchListener = (lobby: QuickLobby, launch: QuickLaunch) => void;
export type QuickClosedListener = (code: string, reason: string) => void;

export interface QuickJoinInput {
  game: LobbyGame;
  /** A specific room, or undefined to be matched into one. */
  code?: string;
  memberId: string;
  name: string;
}

export type QuickJoinOutcome = { ok: true; lobby: QuickLobby; specs: QuickOptionSpec[] } | { ok: false; error: string };

/** A game started by a quick room, waiting for its players to arrive. */
interface Boarding {
  game: LobbyGame;
  code: string;
  expected: number;
  /** Machine players the room ordered, seated when the first round is dealt. */
  bots: number;
  deadline: number;
  started: boolean;
}

export class QuickplayManager {
  private readonly lobbies = new Map<string, QuickLobby>();
  private readonly specsByCode = new Map<string, QuickOptionSpec[]>();
  private readonly boarding = new Map<string, Boarding>();
  /** Quick-started games, by the game's own code: who may replay, and until when. */
  private readonly played = new Map<string, { game: LobbyGame; expiresAt: number }>();
  /** One successor room per finished game, so everyone who says "again" lands together. */
  private readonly successors = new Map<string, string>();
  /** Rooms emptied out, and when: see EMPTY_GRACE_MS. */
  private readonly emptiedAt = new Map<string, number>();

  private transitionListener: QuickTransitionListener | null = null;
  private launchListener: QuickLaunchListener | null = null;
  private closedListener: QuickClosedListener | null = null;
  private tickTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly log: FastifyBaseLogger,
    private readonly deps: { games: GameManager; cz: CzManager; mafia: MafiaManager }
  ) {}

  onTransition(listener: QuickTransitionListener): void {
    this.transitionListener = listener;
  }

  onLaunch(listener: QuickLaunchListener): void {
    this.launchListener = listener;
  }

  onClosed(listener: QuickClosedListener): void {
    this.closedListener = listener;
  }

  start(): void {
    this.tickTimer = setInterval(() => void this.tick(), TICK_MS);
    this.tickTimer.unref();
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
  }

  get(code: string): QuickLobby | undefined {
    return this.lobbies.get(code);
  }

  specs(code: string): QuickOptionSpec[] {
    return this.specsByCode.get(code) ?? [];
  }

  activeCodes(): ReadonlySet<string> {
    return new Set(this.lobbies.keys());
  }

  /** Open quick rooms, for the public board. */
  cards(): LobbyCard[] {
    const cards: LobbyCard[] = [];

    for (const lobby of this.lobbies.values()) {
      if (lobby.phase !== 'gathering' && lobby.phase !== 'countdown') continue;

      const settings = tallyQuick(lobby, this.specs(lobby.code));
      cards.push({
        game: lobby.game,
        code: lobby.code,
        title: this.headline(lobby, settings),
        detail: lobby.fromGameCode ? 'Revanche — les joueurs de la partie précédente arrivent' : null,
        host: null,
        players: Object.keys(lobby.members).length,
        maxPlayers: lobby.maxPlayers,
        createdAt: lobby.createdAt,
        quick: true
      });
    }

    return cards.sort((left, right) => right.players - left.players || left.createdAt - right.createdAt);
  }

  /** The one line that says what this room is about to play. */
  private headline(lobby: QuickLobby, settings: Record<string, string>): string {
    const specs = this.specs(lobby.code);
    const label = (key: string): string => {
      const spec = specs.find((candidate) => candidate.key === key);
      const value = settings[key];
      return spec?.choices.find((choice) => choice.value === value)?.label ?? '';
    };

    switch (lobby.game) {
      case 'quiz':
        return label(QUICK_PLAYLIST_KEY) || 'Quiz surprise';
      case 'coronaz':
        return label('scenario') || 'Raid';
      case 'mafia':
        return label('setup') || 'Table';
    }
  }

  /* ------------------------------------------------------------ membership */

  async join(input: QuickJoinInput): Promise<QuickJoinOutcome> {
    const now = Date.now();

    let lobby = input.code ? this.lobbies.get(input.code) : this.findOpen(input.game);

    if (input.code && !lobby) {
      return { ok: false, error: 'Ce salon n’existe plus.' };
    }

    /**
     * A room that has already left is not one to wait in. The member is pointed
     * at the game it started rather than at a fresh room, because the whole
     * reason they are holding this code is that somebody sent it to them.
     */
    if (lobby && (lobby.phase === 'launched' || lobby.phase === 'closed')) {
      if (lobby.launch) {
        return { ok: true, lobby, specs: this.specs(lobby.code) };
      }
      return { ok: false, error: 'Ce salon est fermé.' };
    }

    lobby ??= await this.open(input.game, null);

    const result = joinQuickLobby(lobby, { id: input.memberId, name: input.name, now });

    if (!result.ok) {
      return { ok: false, error: result.error === 'full' ? 'Ce salon est complet.' : 'Ce salon est fermé.' };
    }

    this.emptiedAt.delete(lobby.code);
    this.changed(lobby);
    return { ok: true, lobby, specs: this.specs(lobby.code) };
  }

  /**
   * "Again", from a game that has just ended.
   *
   * The successor room is keyed by the finished game rather than created per
   * caller, which is the entire point: five people pressing the same button in
   * the same ten seconds have to end up in the same room, not in five rooms of
   * one. Whoever presses first opens it; everyone after joins it. It is a normal
   * quick room in every other respect, so matchmaking will also feed it
   * strangers while the table waits — which is what stops a replay of three from
   * being a game of three.
   */
  async replay(input: {
    game: LobbyGame;
    gameCode: string;
    memberId: string;
    name: string;
  }): Promise<QuickJoinOutcome> {
    const origin = this.played.get(input.gameCode);
    if (!origin || origin.game !== input.game) {
      return { ok: false, error: 'Cette partie n’était pas une partie rapide.' };
    }

    const existingCode = this.successors.get(input.gameCode);
    const existing = existingCode ? this.lobbies.get(existingCode) : undefined;

    if (existing && (existing.phase === 'gathering' || existing.phase === 'countdown')) {
      return this.join({ ...input, code: existing.code });
    }

    const lobby = await this.open(input.game, input.gameCode);
    this.successors.set(input.gameCode, lobby.code);
    return this.join({ ...input, code: lobby.code });
  }

  leave(code: string, memberId: string): void {
    const lobby = this.lobbies.get(code);
    if (!lobby) return;

    dropQuickMember(lobby, memberId, Date.now());
    if (Object.keys(lobby.members).length === 0) {
      this.emptiedAt.set(code, Date.now());
    }
    this.changed(lobby);
  }

  ready(code: string, memberId: string, ready: boolean): void {
    const lobby = this.lobbies.get(code);
    if (!lobby) return;
    setQuickReady(lobby, memberId, ready, Date.now());
    this.settle(lobby);
  }

  vote(code: string, memberId: string, key: string, value: string): void {
    const lobby = this.lobbies.get(code);
    if (!lobby) return;
    if (!setQuickVote(lobby, memberId, this.specs(code), key, value, Date.now())) return;
    this.changed(lobby);
  }

  /**
   * Order machine players.
   *
   * Through `settle` rather than `changed`, because the count feeds the launch
   * arithmetic: the bot that takes a room from four seats to five is exactly the
   * one that makes an already-agreed table startable, and it should not have to
   * wait for somebody to toggle their vote for the room to notice.
   */
  bots(code: string, count: number): void {
    const lobby = this.lobbies.get(code);
    if (!lobby) return;
    if (!setQuickBots(lobby, count, Date.now())) return;
    this.settle(lobby);
  }

  beat(code: string, memberId: string): void {
    const lobby = this.lobbies.get(code);
    if (!lobby) return;
    markQuickSeen(lobby, memberId, Date.now());
  }

  /* --------------------------------------------------------------- rooms */

  /** The fullest room with space left: a quick match should fill one, not seed ten. */
  private findOpen(game: LobbyGame): QuickLobby | undefined {
    let best: QuickLobby | undefined;

    for (const lobby of this.lobbies.values()) {
      if (lobby.game !== game || lobby.phase !== 'gathering') continue;
      if (Object.keys(lobby.members).length >= lobby.maxPlayers) continue;
      if (!best || Object.keys(lobby.members).length > Object.keys(best.members).length) {
        best = lobby;
      }
    }

    return best;
  }

  private async open(game: LobbyGame, fromGameCode: string | null): Promise<QuickLobby> {
    const specs = await this.buildSpecs(game);
    const size = quickSize(game);

    const lobby = createQuickLobby({
      code: this.newCode(),
      game,
      specs,
      minPlayers: size.min,
      maxPlayers: size.max,
      randomInt: (maxExclusive) => randomInt(maxExclusive),
      now: Date.now(),
      fromGameCode
    });

    this.lobbies.set(lobby.code, lobby);
    this.specsByCode.set(lobby.code, specs);
    return lobby;
  }

  /**
   * The quiz's playlist choices are the library's, not a constant.
   *
   * Everything else a room can vote on is a fixed list compiled into lobby-core.
   * "Which quiz" cannot be: it is whatever the house has published today, which
   * is why the spec ships with no choices and gets them here. A house that has
   * published nothing yields an empty option, and the launch refuses rather than
   * starting a game with no rounds in it.
   */
  private async buildSpecs(game: LobbyGame): Promise<QuickOptionSpec[]> {
    const specs = quickSpecs(game);
    if (game !== 'quiz') return specs;

    const playlists = await playlistService.listPublic();
    const spec = specs.find((candidate) => candidate.key === QUICK_PLAYLIST_KEY);
    if (spec) {
      spec.choices = playlists.slice(0, 40).map((playlist) => ({
        value: String(playlist.id),
        label: playlist.name ?? `Quiz ${playlist.id}`
      }));
      spec.fallback = spec.choices[0]?.value ?? '';
    }

    return specs;
  }

  /** One namespace for every code in the house, so a typo lands nowhere at all. */
  private newCode(): string {
    const taken = new Set<string>([
      ...this.lobbies.keys(),
      ...this.deps.games.activeCodes(),
      ...this.deps.cz.activeCodes(),
      ...this.deps.mafia.activeCodes()
    ]);

    for (let attempt = 0; attempt < 200; attempt++) {
      const code = generateJoinCode((maxExclusive) => randomInt(maxExclusive));
      if (!taken.has(code)) return code;
    }

    throw new Error('could not allocate an unused lobby code');
  }

  /* ------------------------------------------------------------- the clock */

  private changed(lobby: QuickLobby): void {
    this.transitionListener?.(lobby, this.specs(lobby.code));
  }

  /** Re-reads the room's decision after anything that could have changed it. */
  private settle(lobby: QuickLobby): void {
    const now = Date.now();
    const decision = quickDecision(lobby, now);

    if (decision === 'countdown') {
      armQuickCountdown(lobby, now);
    } else if (decision === 'cancel') {
      cancelQuickCountdown(lobby, now);
    }

    this.changed(lobby);

    if (decision === 'launch') {
      void this.launch(lobby);
    }
  }

  private async tick(): Promise<void> {
    const now = Date.now();

    for (const lobby of [...this.lobbies.values()]) {
      if (lobby.phase === 'countdown') {
        const decision = quickDecision(lobby, now);
        if (decision === 'cancel') {
          cancelQuickCountdown(lobby, now);
          this.changed(lobby);
        } else if (decision === 'launch') {
          await this.launch(lobby);
        }
        continue;
      }

      if (lobby.phase === 'gathering') {
        /**
         * A member whose phone stopped beating stops counting towards the
         * majority, and the countdown can therefore arm itself with no new vote
         * at all — three of five present becomes three of three. Re-reading the
         * decision every second is what makes that happen rather than leaving a
         * room stalled behind someone who closed the tab.
         */
        const decision = quickDecision(lobby, now);
        if (decision === 'countdown') {
          armQuickCountdown(lobby, now);
          this.changed(lobby);
        }
      }

      const empty = Object.keys(lobby.members).length === 0;
      const emptiedAt = this.emptiedAt.get(lobby.code);
      if (empty && emptiedAt === undefined) {
        this.emptiedAt.set(lobby.code, now);
      } else if (!empty) {
        this.emptiedAt.delete(lobby.code);
      } else if (emptiedAt !== undefined && now - emptiedAt > EMPTY_GRACE_MS) {
        this.close(lobby.code, 'Salon vide');
      }

      if (lobby.phase === 'launched' && now - lobby.lastActivityAt > LAUNCHED_LINGER_MS) {
        this.close(lobby.code, 'Partie lancée');
      }
    }

    for (const [lobbyCode, entry] of [...this.boarding]) {
      if (entry.started) {
        this.boarding.delete(lobbyCode);
        continue;
      }
      if (this.seated(entry) >= entry.expected || now >= entry.deadline) {
        entry.started = true;
        await this.beginGame(entry);
        this.boarding.delete(lobbyCode);
      }
    }

    for (const [gameCode, entry] of [...this.played]) {
      if (now > entry.expiresAt) {
        this.played.delete(gameCode);
        this.successors.delete(gameCode);
      }
    }
  }

  private close(code: string, reason: string): void {
    const lobby = this.lobbies.get(code);
    if (lobby) lobby.phase = 'closed';
    this.lobbies.delete(code);
    this.specsByCode.delete(code);
    this.emptiedAt.delete(code);
    this.closedListener?.(code, reason);
  }

  /* -------------------------------------------------------------- launching */

  private async launch(lobby: QuickLobby): Promise<void> {
    if (lobby.phase === 'launched') return;

    const settings = tallyQuick(lobby, this.specs(lobby.code));
    const expected = Object.keys(lobby.members).length;

    let code: string;
    try {
      code = await this.createGame(lobby, settings);
    } catch (error) {
      this.log.error({ err: error, lobby: lobby.code, game: lobby.game }, 'quick match could not start a game');
      cancelQuickCountdown(lobby, Date.now());
      for (const member of Object.values(lobby.members)) {
        member.ready = false;
      }
      this.changed(lobby);
      return;
    }

    lobby.phase = 'launched';
    lobby.launch = { code };
    lobby.startsAt = null;
    lobby.lastActivityAt = Date.now();

    this.played.set(code, { game: lobby.game, expiresAt: Date.now() + REPLAY_WINDOW_MS });
    this.boarding.set(lobby.code, {
      game: lobby.game,
      code,
      expected,
      bots: lobby.bots,
      deadline: Date.now() + BOARDING_MS,
      started: false
    });

    const launch: QuickLaunch = {
      game: lobby.game,
      lobbyCode: lobby.code,
      code,
      path: quickJoinPath(lobby.game, code)
    };

    this.changed(lobby);
    this.launchListener?.(lobby, launch);
  }

  private async createGame(lobby: QuickLobby, settings: Record<string, string>): Promise<string> {
    switch (lobby.game) {
      case 'quiz': {
        const playlistId = Number(settings[QUICK_PLAYLIST_KEY]);
        if (!Number.isInteger(playlistId) || playlistId <= 0) {
          throw new Error('no public playlist to draw from');
        }

        const playlists = await playlistService.listPublic();
        const playlist = playlists.find((candidate) => candidate.id === playlistId) ?? playlists[0];
        if (!playlist) {
          throw new Error('no public playlist to draw from');
        }

        const state = await this.deps.games.create({
          playlistId: playlist.id,
          playlistName: playlist.name ?? 'Partie rapide',
          // Nobody hosts this one. The playlist still has an owner; the game does not.
          hostUserId: null,
          items: playlist.items,
          config: quizConfig(settings),
          maxRounds: quizRounds(settings.length)
        });

        if (state.order.length === 0) {
          await this.deps.games.destroy(state.code);
          throw new Error('playlist had nothing playable left');
        }

        return state.code;
      }

      case 'coronaz': {
        const state = await this.deps.cz.create({
          hostUserId: null,
          config: coronazConfig(settings),
          quizCodes: this.deps.games.activeCodes()
        });
        return state.code;
      }

      case 'mafia': {
        const state = this.deps.mafia.create({
          hostUserId: null,
          config: mafiaConfig(settings, lobby.maxPlayers),
          takenCodes: new Set([...this.deps.games.activeCodes(), ...this.deps.cz.activeCodes()])
        });
        return state.code;
      }
    }
  }

  /** How many of the room have actually taken a seat in the game it started. */
  private seated(entry: Boarding): number {
    switch (entry.game) {
      case 'quiz':
        return Object.keys(this.deps.games.get(entry.code)?.players ?? {}).length;
      case 'coronaz':
        return Object.keys(this.deps.cz.get(entry.code)?.heroes ?? {}).length;
      case 'mafia':
        return Object.keys(this.deps.mafia.get(entry.code)?.players ?? {}).length;
    }
  }

  /**
   * The first round, once the room is in the room.
   *
   * A hostless game has nobody to press start, so this is that hand. It is also
   * where a room that lost people on the way is made playable again: Mafia needs
   * a town, and five strangers who became three during the redirect get bots
   * rather than a game that cannot be dealt.
   */
  private async beginGame(entry: Boarding): Promise<void> {
    try {
      switch (entry.game) {
        case 'quiz': {
          const state = this.deps.games.get(entry.code);
          if (!state) return;
          if (Object.keys(state.players).length === 0) {
            await this.deps.games.destroy(entry.code);
            return;
          }
          await this.deps.games.advanceSession(entry.code);
          return;
        }

        case 'coronaz': {
          const state = this.deps.cz.get(entry.code);
          if (!state) return;
          if (Object.keys(state.heroes).length === 0) {
            await this.deps.cz.destroy(entry.code);
            return;
          }
          // One call each: CoronaZ seats bots one at a time because each draws its
          // own mindset and loadout, which is what keeps a squad of them a squad.
          for (let i = 0; i < entry.bots; i++) {
            this.deps.cz.addBot(entry.code, 'expert');
          }
          await this.deps.cz.start(entry.code);
          return;
        }

        case 'mafia': {
          const state = this.deps.mafia.get(entry.code);
          if (!state) return;
          const seated = Object.keys(state.players).length;
          if (seated === 0) {
            await this.deps.mafia.destroy(entry.code);
            return;
          }
          // What the room asked for first, then whatever the deal still needs. The
          // top-up is the old behaviour and stays: a room that lost people during
          // the redirect gets a town rather than an error.
          if (entry.bots > 0) this.deps.mafia.addBots(entry.code, entry.bots);
          const withBots = Object.keys(this.deps.mafia.get(entry.code)?.players ?? {}).length;
          if (withBots < state.config.minPlayers) {
            this.deps.mafia.addBots(entry.code, state.config.minPlayers - withBots);
          }
          this.deps.mafia.start(entry.code);
          return;
        }
      }
    } catch (error) {
      this.log.error({ err: error, code: entry.code, game: entry.game }, 'quick match could not begin its game');
    }
  }

  /* ------------------------------------------------------------- utilities */

  /** A member id for a socket that has never had one. */
  static newMemberId(): string {
    return randomUUID();
  }

  /** Whether a finished game came from a quick room, and can therefore be replayed. */
  replayable(gameCode: string): LobbyGame | null {
    return this.played.get(gameCode)?.game ?? null;
  }
}
