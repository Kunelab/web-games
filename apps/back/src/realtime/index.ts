import {
  czGmActionSchema,
  czHeroActionSchema,
  czJoinSchema,
  czKickSchema,
  joinHero,
  setLoadout,
  setMutations,
  switchHero,
  toView,
  type CzClientToServer,
  type CzRole,
  type CzServerToClient,
  type CzState
} from 'coronaz-core';
import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { msg, type Msg } from 'i18n';
import {
  chatLineFor,
  chatRules,
  NO,
  refusalOf,
  type MafiaViewer,
  mafiaActionSchema,
  mafiaBallotSchema,
  mafiaChatSchema,
  mafiaDayActionSchema,
  mafiaJoinSchema,
  mafiaKickSchema,
  mafiaVoteSchema,
  mafiaWhisperSchema,
  mafiaWillSchema,
  toMafiaView,
  type MafiaClientToServer,
  type MafiaServerToClient,
  type MafiaState
} from 'mafia-core';

import {
  quickBeatSchema,
  quickBotsSchema,
  quickJoinPath,
  quickJoinSchema,
  quickLeaveSchema,
  quickReadySchema,
  quickReplaySchema,
  quickVoteSchema,
  toQuickView,
  type QuickClientToServer,
  type QuickJoinAck,
  type QuickLobby,
  type QuickOptionSpec,
  type QuickServerToClient
} from 'lobby-core';
import type { KickRefusal } from 'presence-core';

import { accountOf, sessionUserOf } from './account.js';
import {
  answerPayloadSchema,
  buzzPayloadSchema,
  joinPayloadSchema,
  revealChoicesPayloadSchema,
  type ClientToServerEvents,
  type ServerToClientEvents
} from 'game-core';
import { Server as SocketServer, type Socket } from 'socket.io';

import { allowedOrigins } from '../env.js';
import type { GameManager } from '../game/manager.js';
import {
  buzz,
  cleanAliases,
  correctAnswers,
  correctPayloadNumbers,
  holdRound,
  libraryCodeOf,
  isBuzzerRound,
  joinSession,
  revealChoices,
  submitAnswer,
  type SessionState
} from '../game/session.js';
import { isAdmin } from '../services/ownership.js';
import { correctLibraryRound, purgeLibraryRound } from '../services/blindtest-library.js';
import { careerKey, czCareerService } from '../services/cz-career-service.js';
import { resultsService } from '../services/results-service.js';
import type { MafiaManager } from '../mafia/manager.js';
import type { QuickplayManager } from '../quickplay/manager.js';
import type { CzManager } from '../zombie/manager.js';

/** Per-connection bookkeeping, kept out of the game state. */
interface SocketData {
  code?: string;
  playerId?: string;
  isHost: boolean;
  /** CoronaZ attachment: one socket is in at most one raid, in one role. */
  czCode?: string;
  czRole?: CzRole;
  /** Mafia attachment: a seat, the host screen, or a television watching. */
  mafiaCode?: string;
  mafiaPlayerId?: string;
  mafiaHost?: boolean;
  mafiaSpectator?: boolean;
  /** Quick-match attachment: one socket waits in at most one room, as one member. */
  quickCode?: string;
  quickMemberId?: string;
}

type AllClientToServer = ClientToServerEvents & CzClientToServer & MafiaClientToServer & QuickClientToServer;
type AllServerToClient = ServerToClientEvents & CzServerToClient & MafiaServerToClient & QuickServerToClient;

type GameSocket = Socket<AllClientToServer, AllServerToClient, Record<string, never>, SocketData>;

/** An ack a handler can always call. socket.io does not promise the client sent one. */
type Respond<T> = (result: T) => void;

function responder<T>(ack: unknown): Respond<T> {
  return typeof ack === 'function' ? (ack as Respond<T>) : () => undefined;
}

/** A join code off the wire. Typed by hand, so it arrives cased and spaced freely. */
function readCode(payload: { code?: unknown } | undefined): string {
  return typeof payload?.code === 'string' ? payload.code.trim().toUpperCase() : '';
}

/** A schema the seat guard can drive, without naming zod in this file. */
interface Parser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/**
 * Why a proposed kick was refused, for the phone that proposed it.
 *
 * presence-core answers with a key rather than a sentence, which is the right
 * shape for a rule — and this is the one place that maps those keys onto the
 * catalogue's. Every branch is a rule the player is entitled to be told about,
 * `too-soon` most of all: it is the whole reason the delay exists.
 */
const KICK_REFUSALS: Partial<Record<KickRefusal, string>> = {
  'too-soon': 'presence.kick.tooSoon',
  'target-present': 'presence.kick.targetPresent',
  'already-open': 'presence.kick.alreadyOpen',
  'already-kicked': 'presence.kick.alreadyKicked',
  self: 'presence.kick.self',
  'no-vote': 'presence.kick.noVote'
};

/** Mafia's phones render keys, so they get one. */
function kickRefusal(reason: KickRefusal | undefined): Msg {
  return msg((reason && KICK_REFUSALS[reason]) ?? 'presence.kick.impossible');
}

/**
 * CoronaZ's screens still print the sentence they are handed, so its kick
 * refusals stay French here until that game learns the catalogue too.
 */
function kickRefusalText(reason: KickRefusal | undefined): string {
  switch (reason) {
    case 'too-soon':
      return 'Trop tôt : laissez-lui le temps de revenir.';
    case 'target-present':
      return 'Ce joueur est là.';
    case 'already-open':
      return 'Un vote est déjà en cours.';
    case 'already-kicked':
      return 'Ce joueur a déjà quitté la table.';
    case 'self':
      return 'On ne s’exclut pas soi-même.';
    case 'no-vote':
      return 'Aucun vote en cours.';
    default:
      return 'Impossible.';
  }
}

/**
 * Which projection this socket gets, from the capacity it attached in.
 *
 * Named because the broadcast and the chat filter both need the same mapping,
 * and a third reader should not have to re-derive that a seat wins over a host
 * flag.
 */
function mafiaViewerFor(data: SocketData): MafiaViewer {
  if (data.mafiaPlayerId) return { kind: 'player', playerId: data.mafiaPlayerId };
  return data.mafiaHost ? { kind: 'host' } : { kind: 'spectator' };
}

/**
 * The room name per game, in one place.
 *
 * Named rather than inlined because a join site and a push site that disagree
 * about the string fail silently and identically to a dead socket: the table
 * simply stops updating. One function each, used by both ends.
 *
 * Prefixed per game because the four games share a code space, and an
 * unprefixed code would put a quiz and a raid that happened to be called the
 * same thing in one room.
 */
const quizRoom = (code: string): string => `quiz:${code}`;
const czRoom = (code: string): string => `cz:${code}`;
const mafiaRoom = (code: string): string => `mafia:${code}`;
const quickRoom = (code: string): string => `quick:${code}`;

export function registerRealtime(
  app: FastifyInstance,
  games: GameManager,
  cz: CzManager,
  mafia: MafiaManager,
  quick: QuickplayManager
): SocketServer {
  const io: SocketServer<AllClientToServer, AllServerToClient, Record<string, never>, SocketData> = new SocketServer(
    app.server,
    {
      cors: { origin: allowedOrigins, credentials: true },
      // Players are on phones that sleep and switch networks; a generous window
      // means a returning socket resumes rather than being treated as a new player.
      connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 }
    }
  );

  /**
   * The sockets attached to one game, rather than every socket on the server.
   *
   * Each of the pushes below wants the same thing: the handful of sockets on
   * one table. They used to get there by walking `io.sockets.sockets` (every
   * socket connected to the process, across all four games) and discarding the
   * ones whose `data` named a different code. Socket.IO already keeps that
   * index — every attach below joins a room — so the walk was O(everyone) to
   * reach O(one table), and the room bookkeeping was never read by anything.
   *
   * Read through the adapter rather than `fetchSockets()` because these are
   * synchronous transition callbacks: `fetchSockets` is async and would make
   * every emitter below async for no gain on a single node.
   *
   * The `data` guard stays in every caller. Room membership is the fast path,
   * not the authority: what a socket may see is decided by the capacity it
   * attached in, and that decision is not something to re-express as a room
   * name in a game where a wrong recipient means handing the wolves to the town.
   */
  function socketsIn(room: string): GameSocket[] {
    const ids = io.sockets.adapter.rooms.get(room);
    if (!ids) return [];
    const found: GameSocket[] = [];
    for (const id of ids) {
      const socket = io.sockets.sockets.get(id);
      if (socket) found.push(socket);
    }
    return found;
  }

  /**
   * Pushes the current state to everyone in a session.
   *
   * Each recipient gets their own projection, because what a player may see differs
   * per player: their own solved fields, their own remaining attempts, and never the
   * answers. Broadcasting one shared payload would leak.
   */
  function broadcast(state: SessionState): void {
    for (const socket of socketsIn(quizRoom(state.code))) {
      const data = socket.data;
      if (data.code !== state.code) continue;

      socket.emit('session:state', games.view(state, data.playerId ?? null, data.isHost));
    }
  }

  games.onTransition(broadcast);

  /** Same projection-per-recipient rule as the quizzes: the fog is per role. */
  function czBroadcast(state: CzState): void {
    for (const socket of socketsIn(czRoom(state.code))) {
      const data = socket.data;
      if (data.czCode !== state.code || !data.czRole) continue;
      socket.emit('cz:state', toView(state, data.czRole));
    }
  }

  cz.onTransition(czBroadcast);

  /**
   * The payoff, once, to everyone who was in the raid.
   *
   * The whole list goes to each participant rather than one row each: reading out
   * what everybody unlocked is most of what an end-of-raid screen is for, and
   * there is nothing private in a trophy.
   */
  cz.onRewards((state, rewards) => {
    for (const socket of socketsIn(czRoom(state.code))) {
      if (socket.data.czCode !== state.code || !socket.data.czRole) continue;
      socket.emit('cz:rewards', rewards);
    }
  });

  /**
   * Mafia: the projection-per-recipient rule matters more here than anywhere
   * else in the codebase — a shared payload would hand the wolves to the town.
   * Each socket gets its own `toMafiaView`; the chat event below additionally
   * checks channel visibility per recipient before delivering a single line.
   */
  function mafiaBroadcast(state: MafiaState): void {
    for (const socket of socketsIn(mafiaRoom(state.code))) {
      const data = socket.data;
      if (data.mafiaCode !== state.code) continue;
      if (data.mafiaPlayerId || data.mafiaHost || data.mafiaSpectator) {
        socket.emit('mafia:state', toMafiaView(state, mafiaViewerFor(data)));
      }
    }
  }

  mafia.onTransition(mafiaBroadcast);

  /**
   * The lights, which are not the board.
   *
   * Sent to everybody in the room as it is: there is nothing private in a list
   * of seats a model is working for, and giving it the per-recipient treatment
   * would cost a projection per socket for a thing that changes twice a second.
   */
  mafia.onBusy((code, busy) => {
    for (const socket of socketsIn(mafiaRoom(code))) {
      if (socket.data.mafiaCode !== code) continue;
      socket.emit('mafia:busy', busy);
    }
  });

  mafia.onMessage((state, message) => {
    const rules = chatRules();
    for (const socket of socketsIn(mafiaRoom(state.code))) {
      const data = socket.data;
      if (data.mafiaCode !== state.code) continue;
      if (data.mafiaPlayerId) {
        // Per recipient, byline included: the spy reads the family room, never
        // the name on the door.
        if (rules.canRead(message.channel, data.mafiaPlayerId, state))
          socket.emit('mafia:message', chatLineFor(state, data.mafiaPlayerId, message));
      } else if ((data.mafiaHost || data.mafiaSpectator) && message.channel === 'day') {
        // A screen in the room hears the square and nothing else, ever.
        socket.emit('mafia:message', message);
      }
    }
  });

  mafia.onRewards((state, rewards) => {
    for (const socket of socketsIn(mafiaRoom(state.code))) {
      if (socket.data.mafiaCode !== state.code) continue;
      socket.emit('mafia:rewards', rewards);
    }
  });

  /** Probes per measurement pass; the lowest is kept. */
  const RTT_PROBES = 3;
  const RTT_TIMEOUT_MS = 3_000;

  /**
   * Measures a player's round trip from the server side and stores the best sample.
   *
   * The lowest of several probes is used rather than an average, for the same reason
   * the client-side clock estimate does: latency spikes are one-sided, so the
   * fastest round trip is the least contaminated view of the real link.
   */
  function probeOnce(socket: GameSocket): Promise<number | null> {
    return new Promise((resolve) => {
      const sentAt = Date.now();
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(null);
      }, RTT_TIMEOUT_MS);
      timer.unref();

      socket.emit('clock:sync', { serverTime: sentAt }, () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(Date.now() - sentAt);
      });
    });
  }

  async function measureRtt(socket: GameSocket, state: SessionState, playerId: string): Promise<void> {
    let best = Number.POSITIVE_INFINITY;

    for (let probe = 0; probe < RTT_PROBES; probe++) {
      const rtt = await probeOnce(socket);
      // Timed out or the socket went away; keep whatever we already measured.
      if (rtt === null) break;
      best = Math.min(best, rtt);
    }

    const player = state.players[playerId];
    if (player && Number.isFinite(best)) {
      player.rttMs = best;
      app.log.debug({ playerId, rttMs: best }, 'measured player round trip');
    }
  }

  /**
   * The quick room, to everyone waiting in it.
   *
   * Same per-recipient projection as everywhere else, for a different reason:
   * there is nothing secret in a lobby, but each phone needs to see which of the
   * votes on screen is its own. That is the only thing `toQuickView` personalises.
   */
  function quickBroadcast(lobby: QuickLobby, specs: QuickOptionSpec[]): void {
    const now = Date.now();
    for (const socket of socketsIn(quickRoom(lobby.code))) {
      if (socket.data.quickCode !== lobby.code) continue;
      socket.emit('quick:state', toQuickView(lobby, specs, socket.data.quickMemberId ?? null, now));
    }
  }

  quick.onTransition(quickBroadcast);

  quick.onLaunch((lobby, launch) => {
    for (const socket of socketsIn(quickRoom(lobby.code))) {
      if (socket.data.quickCode !== lobby.code) continue;
      socket.emit('quick:launch', launch);
    }
  });

  quick.onClosed((code, reason) => {
    for (const socket of socketsIn(quickRoom(code))) {
      if (socket.data.quickCode !== code) continue;
      socket.emit('quick:closed', { code, reason });
      socket.data.quickCode = undefined;
      socket.data.quickMemberId = undefined;
      void socket.leave(quickRoom(code));
    }
  });

  io.on('connection', (socket: GameSocket) => {
    socket.data.isHost = false;

    /**
     * Clock synchronisation. Answered as early as possible in the handler so the
     * timestamp reflects arrival rather than queueing behind other work, since the
     * whole point is measuring the network rather than the server.
     */
    socket.on('clock:ping', (payload, ack) => {
      const serverTime = Date.now();
      if (typeof ack !== 'function') return;

      const clientSent = typeof payload?.clientSent === 'number' ? payload.clientSent : serverTime;
      ack({ clientSent, serverTime });
    });

    socket.on('session:join', (payload, ack) => {
      const respond = responder(ack);

      const parsed = joinPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        respond({ ok: false, error: NO.badRequest() });
        return;
      }

      const state = games.get(parsed.data.code);
      if (!state) {
        respond({ ok: false, error: 'Aucune partie avec ce code' });
        return;
      }

      if (state.phase === 'finished') {
        respond({ ok: false, error: 'Cette partie est terminée' });
        return;
      }

      const { player } = joinSession(state, parsed.data.playerName, parsed.data.playerToken);

      /**
       * The account, if the phone happens to have one, resolved after the fact.
       *
       * Not awaited, and not required: joining must stay instant and must keep
       * working for the phones this game is built around, which carry no session
       * at all. The login is only read when the game ends and the tokens are
       * banked, which is minutes away.
       */
      void accountOf(app, socket)
        .then((login) => {
          if (login) player.account = login;
        })
        .catch(() => undefined);

      socket.data.code = state.code;
      socket.data.playerId = player.id;
      socket.data.isHost = false;
      void socket.join(quizRoom(state.code));

      respond({
        ok: true,
        playerToken: player.token,
        playerId: player.id,
        session: games.view(state, player.id, false)
      });

      // Everyone else needs the updated roster.
      broadcast(state);
      void games.persist(state);

      // Measure this player's latency now, so their first answer is already
      // compensated correctly rather than being judged with an assumed zero RTT.
      void measureRtt(socket, state, player.id);

      // The title this nickname has earned across past evenings, fetched after the
      // ack so joining never waits on a history scan. Purely cosmetic, so a failure
      // here is not worth reporting to anyone.
      void resultsService
        .titleFor(player.name)
        .then((title) => {
          const seated = state.players[player.id];
          if (title && seated) {
            seated.title = title;
            broadcast(state);
          }
        })
        .catch(() => undefined);
    });

    socket.on('host:open', (payload, ack) => {
      const respond = responder(ack);
      const code = readCode(payload);

      const state = games.get(code);
      if (!state) {
        respond({ ok: false, error: 'Aucune partie avec ce code' });
        return;
      }

      if (payload?.hostToken !== state.hostToken) {
        respond({ ok: false, error: 'Jeton hôte invalide' });
        return;
      }

      socket.data.code = state.code;
      socket.data.playerId = undefined;
      socket.data.isHost = true;
      void socket.join(quizRoom(state.code));

      respond({ ok: true, session: games.view(state, null, true) });

      /**
       * The television learns the state the same way everyone else does.
       *
       * Without this the host screen only ever had the copy in the ack above, which
       * the client discards, so it sat on "Connexion à la partie…" until something
       * else happened to broadcast. In a normal game the first player joining did
       * that, which hid the bug; with nobody joining, as in an oral game, nothing
       * ever did and the screen span forever.
       */
      socket.emit('session:state', games.view(state, null, true));
    });

    /** Host actions all funnel through one guard so the token check is not duplicated. */
    function withHost(hostToken: string | undefined, action: (state: SessionState) => Promise<unknown>): void {
      const code = socket.data.code;
      if (!code) return;

      const state = games.get(code);
      if (!state || !hostToken || hostToken !== state.hostToken) {
        socket.emit('session:error', { message: "Action réservée à l'hôte" });
        return;
      }

      void action(state).catch((error: unknown) => {
        app.log.error({ err: error, code }, 'host action failed');
        socket.emit('session:error', { message: 'Action impossible' });
      });
    }

    socket.on('host:start', (payload) => {
      withHost(payload?.hostToken, async (state) => {
        if (state.phase !== 'lobby') return;
        await games.advanceSession(state.code);
      });
    });

    socket.on('host:advance', (payload) => {
      withHost(payload?.hostToken, async (state) => {
        // Advancing during answering closes them first, so the round is still
        // scored rather than being thrown away.
        if (state.round?.phase === 'answering') {
          await games.closeAnswersFor(state.code);
          return;
        }
        if (state.round?.phase === 'study') {
          await games.openAnswersFor(state.code);
          return;
        }
        await games.advanceSession(state.code);
      });
    });

    socket.on('host:closeAnswers', (payload) => {
      withHost(payload?.hostToken, async (state) => {
        await games.closeAnswersFor(state.code);
      });
    });

    /**
     * Appoints the television, or hands the job back to the host screen.
     *
     * Only meaningful while the media is set to play on one screen; harmless
     * otherwise, so it is not refused, and the projection ignores it. An id
     * naming nobody is treated as "the host screen" rather than rejected: the
     * one way to get here with a stale id is that the phone left, and the room
     * wants the media somewhere rather than an error.
     */
    socket.on('host:setTv', (payload) => {
      withHost(payload?.hostToken, async (state) => {
        const playerId = typeof payload?.playerId === 'string' ? payload.playerId : null;
        state.tvPlayerId = playerId !== null && state.players[playerId] ? playerId : null;
        await games.afterTransition(state);
      });
    });

    /**
     * The room says the reveal is wrong, and the library entry goes.
     *
     * Only ever acts on a round the shared catalogue owns — generated here, or
     * replayed out of it. `libraryCodeOf` decides that and the screen only draws
     * the button when it answered, but it is re-derived here rather than trusted
     * from the payload, because a client that sent a code of its own choosing
     * must not be able to delete an arbitrary row out of a catalogue everybody
     * shares.
     *
     * The round on screen is left exactly as it is. It has been played, the points
     * are settled, and rewriting the answers under a room in the middle of reading
     * them would be a stranger thing to do than keeping a wrong one on screen for
     * another twenty seconds. What changes is only what the next room will be dealt.
     */
    socket.on('host:flagRound', (payload) => {
      withHost(payload?.hostToken, async (state) => {
        const round = state.round;
        if (!round || round.phase !== 'reveal') return;

        const code = libraryCodeOf(round);
        if (!code) return;

        await purgeLibraryRound(code);

        // Marked whether or not a row was found: either way there is nothing left
        // to throw away, and the button should stop offering to.
        round.libraryPurged = true;
        broadcast(state);
      });
    });

    /**
     * The clock off the room, and back on.
     *
     * The host's to press, not an admin's: stopping a game you are running to
     * explain an answer or settle an argument is what running it *is*, and it
     * changes nothing outside the room. Correcting the catalogue below is the
     * one that writes something everybody shares, and that is where the account
     * check lives.
     */
    socket.on('host:holdRound', (payload) => {
      withHost(payload?.hostToken, async (state) => {
        if (!holdRound(state, payload?.hold !== false)) return;
        await games.afterTransition(state);
      });
    });

    /**
     * What the answer actually is.
     *
     * Admin only, and deliberately not "host only". A host is whoever opened a
     * game — any signed-in account, and on a shared box that is everybody — and
     * what this writes is not their game's business but the shared catalogue's:
     * one correction here is the answer every future room is dealt. So the seat
     * at the console is not enough, and the account behind the socket has to be
     * one that may edit the library at all. That is the same rule the media
     * routes enforce, arrived at from the other side.
     *
     * The round on screen is corrected too, not only the stored copy. The room
     * is looking at the wrong answer while it is being told it is wrong, and
     * leaving it there until the next game would be a strange way to agree.
     */
    socket.on('host:correctRound', (payload) => {
      const code = socket.data.code;
      const state = code ? games.get(code) : undefined;
      if (!state || !payload?.hostToken || payload.hostToken !== state.hostToken) {
        socket.emit('session:error', { message: "Action réservée à l'hôte" });
        return;
      }

      /**
       * The answers, each with however many spellings are to be accepted.
       *
       * `aliases` is optional on the wire and stays optional all the way down:
       * a client that sends none is asking for the stored ones to be left alone,
       * which is not the same as sending an empty list. `cleanAliases` is what
       * holds the list to the shape the answer field's schema would.
       */
      const fields = Array.isArray(payload.fields)
        ? payload.fields
            .filter(
              (field): field is { key: string; value: string; aliases?: string[] } =>
                !!field && typeof field.key === 'string' && typeof field.value === 'string'
            )
            .slice(0, 8)
            .map((field) => ({
              key: field.key,
              value: field.value.slice(0, 200),
              aliases: cleanAliases(
                Array.isArray(field.aliases) ? field.aliases.filter((alias) => typeof alias === 'string') : undefined
              )
            }))
        : [];
      /**
       * The clip window, read defensively.
       *
       * Only the four keys the payload has, only finite numbers, and the engine
       * runs the result through the kind's schema anyway — so a client sending
       * a fifth key, a string or a negative gets nothing rather than something
       * partly applied.
       */
      const clip: Record<string, number | undefined> = {};
      const sent = (payload as { clip?: Record<string, unknown> }).clip;
      if (sent && typeof sent === 'object') {
        for (const key of ['startGuess', 'endGuess', 'startReveal', 'endReveal'] as const) {
          const value = sent[key];
          if (typeof value === 'number' && Number.isFinite(value)) clip[key] = value;
        }
      }

      /**
       * And how hard it was, which rides in the payload beside the window.
       *
       * Read the same defensive way and bounded by the kind's schema below, so
       * the worst a client can do with it is have its number refused.
       */
      const difficulty = (payload as { difficulty?: unknown }).difficulty;
      if (typeof difficulty === 'number' && Number.isFinite(difficulty)) {
        clip.difficulty = Math.min(100, Math.max(0, difficulty));
      }

      if (fields.length === 0 && Object.keys(clip).length === 0) return;

      void (async () => {
        const user = await sessionUserOf(app, socket).catch(() => null);
        if (!user || !isAdmin(user)) {
          socket.emit('session:error', { message: 'Correction réservée à un administrateur' });
          return;
        }

        // The catalogue's rule, not a rule of this handler's own: a round
        // generated here, or one replayed out of the shared catalogue. A round
        // from somebody's own library is theirs, and is edited in the editor.
        const round = state.round;
        const libraryCode = round ? libraryCodeOf(round) : undefined;

        // Either may land on its own: an answer that was right with a window
        // that was not is the commonest correction of the two.
        const fixedAnswers = correctAnswers(state, fields);
        const fixedClip = correctPayloadNumbers(state, clip);
        if (!fixedAnswers && !fixedClip) return;

        // The shared copy second: a correction that cannot be stored has still
        // fixed the screen the room is arguing in front of.
        if (libraryCode) {
          await correctLibraryRound(libraryCode, fields, clip).catch((error: unknown) => {
            app.log.warn({ err: error, code: state.code }, 'could not store a round correction');
          });
        }

        await games.afterTransition(state);
      })();
    });

    socket.on('host:kick', (payload) => {
      withHost(payload?.hostToken, async (state) => {
        const playerId = typeof payload?.playerId === 'string' ? payload.playerId : '';
        if (!state.players[playerId]) return;

        delete state.players[playerId];

        for (const other of socketsIn(quizRoom(state.code))) {
          const data = other.data;
          if (data.code === state.code && data.playerId === playerId) {
            other.emit('session:error', { message: 'Vous avez été retiré de la partie' });
            void other.leave(quizRoom(state.code));
            data.code = undefined;
            data.playerId = undefined;
          }
        }

        await games.afterTransition(state);
      });
    });

    socket.on('answer:submit', (payload, ack) => {
      // Captured before any validation work, so a slow parse cannot cost the player.
      const receivedAt = Date.now();
      const respond = responder(ack);

      const { code, playerId } = socket.data;
      if (!code || !playerId) {
        respond({ ok: false, error: "Vous n'êtes pas dans une partie" });
        return;
      }

      const parsed = answerPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        respond({ ok: false, error: 'Réponse invalide' });
        return;
      }

      const state = games.get(code);
      if (!state) {
        respond({ ok: false, error: 'Partie introuvable' });
        return;
      }

      const result = submitAnswer({
        state,
        playerId,
        roundId: parsed.data.roundId,
        fieldKey: parsed.data.fieldKey,
        value: parsed.data.value,
        claimedAt: parsed.data.clientTime,
        receivedAt
      });

      if (!result.ok) {
        respond({ ok: false, error: result.error });
        return;
      }

      games.touch(state);
      respond({ ok: true, correct: result.correct, attemptsLeft: result.attemptsLeft });

      /**
       * A raced round has to tell the room; a simultaneous one must not.
       *
       * In the simultaneous format an answer changes nothing anybody else can see,
       * and broadcasting it would leak the shape of the round: who has solved what
       * is exactly the thing a player would love to read off a neighbour's screen.
       *
       * Under the buzzer that reasoning inverts, because an answer moves *public*
       * state. A wrong one hands the buzzer back and puts its author out of the
       * round, a right one can empty the board and end the phase early, and either
       * way the deadline the server is waiting on has just changed — so the timer
       * has to be re-armed or the round would sit on a window that no longer
       * exists. `afterTransition` does all three.
       */
      if (isBuzzerRound(state)) {
        void games.afterTransition(state);
        return;
      }

      // Points are deliberately not sent yet: they depend on the finishing order,
      // which is not known until answering closes. Only the player's own view
      // changes, so this is not a broadcast.
      socket.emit('session:state', games.view(state, playerId, false));
      void games.persist(state);
    });

    /**
     * A press of the buzzer.
     *
     * Unlike an answer, this goes to the whole room: who holds the buzzer is the
     * most public fact the format has, and the television has to say the name out
     * loud. `afterTransition` is what does it — it persists, broadcasts the new
     * view to everyone, and re-arms the session's timer, which here is the
     * arbitration window that decides the race a quarter of a second from now.
     */
    socket.on('answer:buzz', (payload, ack) => {
      // Before any parsing, exactly as an answer is: the race is decided on this.
      const receivedAt = Date.now();
      const respond = responder(ack);

      const { code, playerId } = socket.data;
      if (!code || !playerId) {
        respond({ ok: false, error: "Vous n'êtes pas dans une partie" });
        return;
      }

      const parsed = buzzPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        respond({ ok: false, error: 'Buzz invalide' });
        return;
      }

      const state = games.get(code);
      if (!state) {
        respond({ ok: false, error: 'Partie introuvable' });
        return;
      }

      const result = buzz({
        state,
        playerId,
        roundId: parsed.data.roundId,
        claimedAt: parsed.data.clientTime,
        receivedAt
      });

      respond(result.ok ? { ok: true } : { ok: false, error: result.error });
      if (!result.ok) return;

      games.touch(state);
      void games.afterTransition(state);
    });

    socket.on('answer:revealChoices', (payload, ack) => {
      const respond = responder(ack);
      const { code, playerId } = socket.data;

      if (!code || !playerId) {
        respond({ ok: false });
        return;
      }

      const parsed = revealChoicesPayloadSchema.safeParse(payload);
      const state = games.get(code);
      if (!parsed.success || !state) {
        respond({ ok: false });
        return;
      }

      const choices = revealChoices(state, playerId, parsed.data.roundId, parsed.data.fieldKey);
      if (!choices) {
        respond({ ok: false });
        return;
      }

      respond({ ok: true, choices });
      socket.emit('session:state', games.view(state, playerId, false));
    });

    socket.on('session:leave', () => {
      handleDisconnect(socket);
    });

    /* ------------------------------- CoronaZ ------------------------------- */

    /**
     * The raid this socket is attached to, but only if the payload carries the
     * credential the action needs. Returns undefined otherwise, so every caller
     * refuses the same way and no handler can forget the check.
     */
    function czRaidFor(
      token: 'hostToken' | 'gmToken',
      payload: { hostToken?: unknown; gmToken?: unknown } | undefined
    ) {
      const { czCode } = socket.data;
      const state = czCode ? cz.get(czCode) : undefined;
      if (!state) return undefined;
      const expected = token === 'hostToken' ? state.hostToken : state.gmToken;
      return payload?.[token] === expected ? state : undefined;
    }

    /**
     * Attaches this socket to a Mafia table in exactly one capacity.
     *
     * All three flags are assigned together because the three handlers each used
     * to set only their own: a screen that spectated and then took a seat stayed
     * flagged as a spectator for the rest of its life. Nothing leaked, because
     * every projection tests for a seat first — but a socket claiming to be two
     * things at once left that ordering as the only thing standing between the
     * town and the wolves, which is not where a secret should rest.
     */
    function mafiaAttach(
      code: string,
      as: { kind: 'player'; playerId: string } | { kind: 'host' } | { kind: 'spectator' }
    ): void {
      socket.data.mafiaCode = code;
      socket.data.mafiaPlayerId = as.kind === 'player' ? as.playerId : undefined;
      socket.data.mafiaHost = as.kind === 'host';
      socket.data.mafiaSpectator = as.kind === 'spectator';
      void socket.join(mafiaRoom(code));
    }

    /** The Mafia twin: this socket's table, if the payload holds the host token. */
    function mafiaTableForHost(payload: { hostToken?: unknown } | undefined) {
      const { mafiaCode } = socket.data;
      const state = mafiaCode ? mafia.get(mafiaCode) : undefined;
      return state && payload?.hostToken === state.hostToken ? state : undefined;
    }

    /** Attach this socket to a raid in a role, after checking its credential. */
    function czAttach(code: string, role: CzRole): void {
      socket.data.czCode = code;
      socket.data.czRole = role;
      void socket.join(czRoom(code));
    }

    socket.on('cz:open', (payload, ack) => {
      const respond = responder(ack);
      const code = readCode(payload);
      const state = cz.get(code);

      if (!state || payload?.hostToken !== state.hostToken) {
        respond({ ok: false, error: NO.noTable() });
        return;
      }

      czAttach(code, { kind: 'tv' });
      respond({ ok: true, view: toView(state, { kind: 'tv' }) });

      /**
       * The television learns the state the same way everyone else does.
       *
       * Same lesson as the quiz host screen, relearned the hard way: the ack's
       * copy is easy for a client to mishandle, and without this push the screen
       * waits for the next broadcast — which, on a TV opened alone or after the
       * players, never comes. "Connexion à la partie…" forever.
       */
      socket.emit('cz:state', toView(state, { kind: 'tv' }));
    });

    socket.on('cz:gmOpen', (payload, ack) => {
      const respond = responder(ack);
      const code = readCode(payload);
      const state = cz.get(code);

      if (!state || payload?.gmToken !== state.gmToken) {
        respond({ ok: false, error: 'Jeton du maître du jeu invalide' });
        return;
      }

      czAttach(code, { kind: 'gm' });
      respond({ ok: true, view: toView(state, { kind: 'gm' }) });
      // Same push as the TV: the game master's screen must not wait for a broadcast.
      socket.emit('cz:state', toView(state, { kind: 'gm' }));
    });

    socket.on('cz:mutations', (payload, ack) => {
      const respond = responder(ack);
      // The socket's own attachment is the credential: only a seated player may
      // change the table's handicap, and it is stored on the socket at join.
      const code = typeof socket.data.czCode === 'string' ? socket.data.czCode : '';
      const state = code ? cz.get(code) : undefined;
      if (!state || socket.data.czRole?.kind !== 'player') {
        respond({ ok: false, error: 'Pas dans cette partie' });
        return;
      }
      try {
        setMutations(state, Array.isArray(payload?.mutations) ? payload.mutations.slice(0, 12) : []);
        respond({ ok: true });
        czBroadcast(state);
        void cz.persist(state);
      } catch (error) {
        respond({ ok: false, error: error instanceof Error ? error.message : 'Impossible' });
      }
    });

    socket.on('cz:join', (payload, ack) => {
      const respond = responder(ack);
      const parsed = czJoinSchema.safeParse(payload);
      if (!parsed.success) {
        respond({ ok: false, error: NO.badRequest() });
        return;
      }

      const state = cz.get(parsed.data.code.trim().toUpperCase());
      if (!state) {
        respond({ ok: false, error: 'Aucune partie avec ce code' });
        return;
      }

      void (async () => {
        try {
          // A logged-in browser plays under its account: perks read from it and
          // rations are banked into it, whatever nickname the phone sent.
          const account = await accountOf(app, socket).catch(() => null);
          const ledger = account ? `@${account}` : parsed.data.name;
          // The roguelite perks this ledger has earned, resolved before the seat
          // exists: tough-skin has to be in the max HP from the first breath.
          const perks = await czCareerService.heroPerks(ledger).catch(() => []);
          const { hero } = joinHero(state, parsed.data.name, parsed.data.playerToken, perks, account ?? undefined);
          czAttach(state.code, { kind: 'player', playerId: hero.playerId });
          /**
           * The socket may have gone while the lookups above were out.
           *
           * `disconnect` fires in order, and it fired already - against a socket
           * that was not attached to anything yet, so it found nothing to release
           * and did nothing. Without this the seat stays lit for a phone that is not there, and the raid waits out its whole pause on somebody who left before they arrived.
           */
          if (!socket.connected) czHandleDisconnect(socket);

          const career = await czCareerService.forName(careerKey(hero)).catch(() => null);
          respond({
            ok: true,
            playerToken: hero.token,
            playerId: hero.playerId,
            view: toView(state, { kind: 'player', playerId: hero.playerId }),
            career: career ? { rations: career.stats.rations, unlockedHeroes: career.stats.unlockedHeroes } : undefined,
            account: account ?? undefined
          });
          czBroadcast(state);
          void cz.persist(state);

          void resultsService
            .titleFor(hero.name)
            .then((title) => {
              if (title) {
                hero.title = title;
                czBroadcast(state);
              }
            })
            .catch(() => undefined);
        } catch (error) {
          respond({ ok: false, error: refusalOf(error, NO.joinFailed()) });
        }
      })();
    });

    socket.on('cz:selectHero', (payload, ack) => {
      const respond = responder(ack);
      const { czCode, czRole } = socket.data;
      const state = czCode ? cz.get(czCode) : undefined;

      if (!state || czRole?.kind !== 'player') {
        respond({ ok: false, error: 'Vous n’êtes pas dans une partie' });
        return;
      }

      void (async () => {
        try {
          const heroId = typeof payload?.heroId === 'string' ? payload.heroId : '';
          const me = state.heroes[czRole.playerId];
          // The roster economy is server truth: a locked character stays locked
          // whatever the phone claims.
          if (me && !(await czCareerService.heroAllowed(careerKey(me), heroId))) {
            respond({ ok: false, error: 'Personnage à débloquer d’abord' });
            return;
          }
          switchHero(state, czRole.playerId, heroId);
          respond({ ok: true });
          czBroadcast(state);
          void cz.persist(state);
        } catch (error) {
          respond({ ok: false, error: error instanceof Error ? error.message : 'Impossible' });
        }
      })();
    });

    socket.on('cz:loadout', (payload, ack) => {
      const respond = responder(ack);
      const { czCode, czRole } = socket.data;
      const state = czCode ? cz.get(czCode) : undefined;
      if (!state || czRole?.kind !== 'player') {
        respond({ ok: false, error: 'Vous n’êtes pas dans une partie' });
        return;
      }

      try {
        const perks = Array.isArray(payload?.perks)
          ? payload.perks.filter((id): id is string => typeof id === 'string').slice(0, 3)
          : [];
        setLoadout(state, czRole.playerId, perks);
        respond({ ok: true });
        czBroadcast(state);
        void cz.persist(state);
      } catch (error) {
        respond({ ok: false, error: error instanceof Error ? error.message : 'Impossible' });
      }
    });

    socket.on('cz:unlockHero', (payload, ack) => {
      const respond = responder(ack);
      const { czCode, czRole } = socket.data;
      const state = czCode ? cz.get(czCode) : undefined;
      const me = state && czRole?.kind === 'player' ? state.heroes[czRole.playerId] : undefined;

      if (!me || me.isBot) {
        respond({ ok: false, error: 'Vous n’êtes pas dans une partie' });
        return;
      }

      void (async () => {
        try {
          const heroId = typeof payload?.heroId === 'string' ? payload.heroId : '';
          const result = await czCareerService.unlockHero(careerKey(me), heroId);
          if (!result.ok) {
            respond(result);
            return;
          }
          const career = await czCareerService.forName(careerKey(me));
          respond({
            ok: true,
            career: { rations: career.stats.rations, unlockedHeroes: career.stats.unlockedHeroes }
          });
        } catch (error) {
          respond({ ok: false, error: error instanceof Error ? error.message : 'Impossible' });
        }
      })();
    });

    socket.on('cz:addBot', (payload, ack) => {
      const respond = responder(ack);
      const state = czRaidFor('hostToken', payload);
      if (!state) {
        respond({ ok: false, error: 'Action réservée à l’écran hôte' });
        return;
      }
      respond(cz.addBot(state.code, typeof payload.skill === 'string' ? payload.skill : 'expert'));
    });

    socket.on('cz:removeBot', (payload) => {
      const state = czRaidFor('hostToken', payload);
      if (!state) return;
      cz.removeBot(state.code, typeof payload.playerId === 'string' ? payload.playerId : '');
    });

    socket.on('cz:start', (payload) => {
      const state = czRaidFor('hostToken', payload);
      if (!state) {
        socket.emit('cz:error', { message: 'Action réservée à l’écran hôte' });
        return;
      }
      if (state.phase !== 'lobby' || Object.keys(state.heroes).length === 0) return;

      void cz.start(state.code).catch((error: unknown) => {
        app.log.error({ err: error, code: state.code }, 'CoronaZ start failed');
      });
    });

    socket.on('cz:say', (payload, ack) => {
      const respond = responder(ack);
      const { czCode, czRole } = socket.data;
      if (!czCode || czRole?.kind !== 'player') {
        respond({ ok: false, error: 'Vous n’êtes pas dans une partie' });
        return;
      }

      const text = typeof payload?.text === 'string' ? payload.text : '';
      respond(cz.say(czCode, czRole.playerId, text));
    });

    socket.on('cz:action', (payload, ack) => {
      const respond = responder(ack);
      const { czCode, czRole } = socket.data;
      if (!czCode || czRole?.kind !== 'player') {
        respond({ ok: false, error: 'Vous n’êtes pas dans une partie' });
        return;
      }

      const parsed = czHeroActionSchema.safeParse(payload);
      if (!parsed.success) {
        respond({ ok: false, error: 'Action invalide' });
        return;
      }

      cz.heroAction(czCode, czRole.playerId, parsed.data)
        .then((result) =>
          respond({ ok: result.ok, error: result.error, loot: result.loot, hits: result.hits, killed: result.killed })
        )
        .catch((error: unknown) => {
          app.log.error({ err: error, code: czCode }, 'CoronaZ action failed');
          respond({ ok: false, error: 'Action impossible' });
        });
    });

    socket.on('cz:gmAction', (payload, ack) => {
      const respond = responder(ack);
      const { czCode, czRole } = socket.data;
      if (!czCode || czRole?.kind !== 'gm') {
        respond({ ok: false, error: 'Réservé au maître du jeu' });
        return;
      }

      const parsed = czGmActionSchema.safeParse(payload);
      if (!parsed.success) {
        respond({ ok: false, error: 'Action invalide' });
        return;
      }

      cz.gmAction(czCode, parsed.data)
        .then((result) => respond({ ok: result.ok, error: result.error }))
        .catch((error: unknown) => {
          app.log.error({ err: error, code: czCode }, 'CoronaZ GM action failed');
          respond({ ok: false, error: 'Action impossible' });
        });
    });

    socket.on('cz:gmEnd', (payload) => {
      const state = czRaidFor('gmToken', payload);
      if (!state) return;

      void cz.gmEnd(state.code).catch((error: unknown) => {
        app.log.error({ err: error, code: state.code }, 'CoronaZ gmEnd failed');
      });
    });

    /* The horde finishes itself, at the AI's pace. Same token check as gmEnd:
       only the phone holding the game master's token may drive the horde. */
    socket.on('cz:gmAuto', (payload) => {
      const state = czRaidFor('gmToken', payload);
      if (!state) return;

      cz.gmAuto(state.code);
    });

    /* Again, same table. Host token only: a guest must not be able to wipe the
       scoreboard everyone is still reading. */
    socket.on('cz:rematch', (payload) => {
      const state = czRaidFor('hostToken', payload);
      if (!state) return;

      void cz.rematch(state.code).catch((error: unknown) => {
        app.log.error({ err: error, code: state.code }, 'CoronaZ rematch failed');
      });
    });

    /** Same beat as Mafia, same reason: an open socket is not a present player. */
    socket.on('cz:beat', () => {
      const { czCode, czRole } = socket.data;
      if (czCode && czRole?.kind === 'player') cz.beat(czCode, czRole.playerId);
    });

    socket.on('cz:kick', (payload, ack) => {
      const respond = responder<{ ok: boolean; error?: string }>(ack);
      const { czCode, czRole } = socket.data;
      if (!czCode || czRole?.kind !== 'player') {
        respond({ ok: false, error: 'Vous n’êtes pas dans une partie' });
        return;
      }
      /**
       * Parsed rather than read defensively: without this, anything that is not
       * a proposal falls through to the ballot arm and a missing `yes` is cast
       * as a no — a real ballot, counted, overwriting whatever that player voted
       * before, and enough of them close the vote as failed for good.
       */
      const parsed = czKickSchema.safeParse(payload);
      if (!parsed.success) {
        respond({ ok: false, error: 'Requête invalide' });
        return;
      }

      const result =
        parsed.data.type === 'propose'
          ? cz.proposeKick(czCode, czRole.playerId, parsed.data.playerId)
          : cz.voteKick(czCode, czRole.playerId, parsed.data.yes);
      respond(result.ok ? { ok: true } : { ok: false, error: kickRefusalText(result.reason) });
    });

    /* -------------------------------- Mafia -------------------------------- */

    socket.on('mafia:join', (payload, ack) => {
      const respond = responder(ack);
      const parsed = mafiaJoinSchema.safeParse(payload);
      if (!parsed.success) {
        respond({ ok: false, error: NO.badRequest() });
        return;
      }

      const state = mafia.get(parsed.data.code.trim().toUpperCase());
      if (!state) {
        respond({ ok: false, error: NO.noTable() });
        return;
      }

      void (async () => {
        try {
          const account = await accountOf(app, socket).catch(() => null);
          const { player } = mafia.join(
            state.code,
            parsed.data.name,
            parsed.data.playerToken,
            account ?? undefined,
            parsed.data.locale
          );
          mafiaAttach(state.code, { kind: 'player', playerId: player.playerId });
          mafia.markConnected(state.code, player.playerId, true);
          /**
           * The socket may have gone while the lookups above were out.
           *
           * `disconnect` fires in order, and it fired already - against a socket
           * that was not attached to anything yet, so it found nothing to release
           * and did nothing. Without this the seat is marked connected for a phone that is not there, and the table stops for it at the next phase rather than playing on.
           */
          if (!socket.connected) mafiaHandleDisconnect(socket);

          respond({
            ok: true,
            playerId: player.playerId,
            playerToken: player.token,
            view: toMafiaView(state, { kind: 'player', playerId: player.playerId })
          });
        } catch (error) {
          respond({ ok: false, error: refusalOf(error, NO.joinFailed()) });
        }
      })();
    });

    socket.on('mafia:host', (payload, ack) => {
      const respond = responder(ack);
      const code = readCode(payload);
      const state = mafia.get(code);
      if (!state || payload?.hostToken !== state.hostToken) {
        respond({ ok: false, error: NO.noTable() });
        return;
      }
      mafiaAttach(code, { kind: 'host' });
      respond({ ok: true, view: toMafiaView(state, { kind: 'host' }) });
      // Same lesson as every host screen in this file: push, never wait.
      socket.emit('mafia:state', toMafiaView(state, { kind: 'host' }));
    });

    /**
     * A television, claiming the table by its code alone.
     *
     * No token on purpose: this projection is the host console's, which carries no
     * `me`, no living player's role and only the square's chat. A second screen
     * teaches a player nothing, so the price of a secret here would be paid in
     * setup friction and bought nothing back. It also cannot act — there is no
     * seat attached, so every mutation guard below refuses it.
     */
    socket.on('mafia:spectate', (payload, ack) => {
      const respond = responder(ack);
      const code = readCode(payload);
      const state = mafia.get(code);
      if (!state) {
        respond({ ok: false, error: NO.noTable() });
        return;
      }
      mafiaAttach(code, { kind: 'spectator' });
      respond({ ok: true, view: toMafiaView(state, { kind: 'spectator' }) });
      // Same lesson as every screen in this file: push, never wait.
      socket.emit('mafia:state', toMafiaView(state, { kind: 'spectator' }));
    });

    socket.on('mafia:start', (payload) => {
      const state = mafiaTableForHost(payload);
      if (!state) {
        socket.emit('mafia:error', { message: NO.hostOnly() });
        return;
      }
      try {
        mafia.start(state.code);
      } catch (error) {
        socket.emit('mafia:error', { message: refusalOf(error, NO.startFailed()) });
      }
    });

    socket.on('mafia:addBots', (payload) => {
      const state = mafiaTableForHost(payload);
      if (!state) return;
      const count = typeof payload.count === 'number' ? Math.max(0, Math.min(23, Math.floor(payload.count))) : 0;
      try {
        mafia.addBots(state.code, count);
      } catch (error) {
        socket.emit('mafia:error', { message: refusalOf(error, NO.impossible()) });
      }
    });

    /**
     * Seat-authenticated mutations share one guard, like the host actions above.
     *
     * The schema is passed in rather than applied by the caller: every call site
     * used to `safeParse` to test and then `parse` again to get the value, which
     * validated each payload twice and named the schema four times over.
     */
    function withMafiaSeat<T>(
      ack: unknown,
      schema: Parser<T>,
      payload: unknown,
      run: (code: string, playerId: string, data: T) => { ok: boolean; error?: Msg }
    ): void {
      const respond = responder<{ ok: boolean; error?: Msg }>(ack);
      const { mafiaCode, mafiaPlayerId } = socket.data;
      if (!mafiaCode || !mafiaPlayerId) {
        respond({ ok: false, error: NO.notSeated() });
        return;
      }
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        respond({ ok: false, error: NO.badRequest() });
        return;
      }
      respond(run(mafiaCode, mafiaPlayerId, parsed.data));
    }

    socket.on('mafia:chat', (payload, ack) => {
      withMafiaSeat(ack, mafiaChatSchema, payload, (code, playerId, data) =>
        mafia.playerChat(code, playerId, data.channel, data.text)
      );
    });

    socket.on('mafia:vote', (payload, ack) => {
      withMafiaSeat(ack, mafiaVoteSchema, payload, (code, playerId, data) =>
        mafia.vote(code, playerId, data.targetSlot)
      );
    });

    socket.on('mafia:ballot', (payload, ack) => {
      withMafiaSeat(ack, mafiaBallotSchema, payload, (code, playerId, data) =>
        mafia.ballot(code, playerId, data.verdict)
      );
    });

    socket.on('mafia:action', (payload, ack) => {
      withMafiaSeat(ack, mafiaActionSchema, payload, (code, playerId, data) =>
        mafia.nightAction(code, playerId, data.targetSlot, data.secondTargetSlot)
      );
    });

    socket.on('mafia:whisper', (payload, ack) => {
      withMafiaSeat(ack, mafiaWhisperSchema, payload, (code, playerId, data) =>
        mafia.whisper(code, playerId, data.targetSlot, data.text)
      );
    });

    socket.on('mafia:dayAction', (payload, ack) => {
      withMafiaSeat(ack, mafiaDayActionSchema, payload, (code, playerId, data) =>
        mafia.dayAction(code, playerId, data)
      );
    });

    socket.on('mafia:will', (payload, ack) => {
      withMafiaSeat(ack, mafiaWillSchema, payload, (code, playerId, data) => mafia.will(code, playerId, data.text));
    });

    /**
     * The heartbeat. No ack, no validation, no reply.
     *
     * Two seconds apart from every seated phone, so it is the highest-frequency
     * event on the socket by an order of magnitude and is written to be boring:
     * the manager only does real work when a seat comes back from the dark.
     */
    socket.on('mafia:beat', () => {
      const { mafiaCode, mafiaPlayerId } = socket.data;
      if (mafiaCode && mafiaPlayerId) mafia.beat(mafiaCode, mafiaPlayerId);
    });

    socket.on('mafia:kick', (payload, ack) => {
      withMafiaSeat(ack, mafiaKickSchema, payload, (code, playerId, data) => {
        const result =
          data.type === 'propose'
            ? mafia.proposeKick(code, playerId, data.targetSlot)
            : mafia.voteKick(code, playerId, data.yes);
        return result.ok ? { ok: true } : { ok: false, error: kickRefusal(result.reason) };
      });
    });

    /* ------------------------------- quick match ------------------------------ */

    /**
     * Takes a place in a quick room, or is matched into one.
     *
     * The member id doubles as the token, which is enough here and deliberately
     * not more: the worst a stolen lobby id buys is a vote in a room about to
     * dissolve, and requiring an account would shut out exactly the phones this
     * mode exists for.
     */
    socket.on('quick:join', (payload, ack) => {
      const respond = responder<QuickJoinAck>(ack);
      const parsed = quickJoinSchema.safeParse(payload);
      if (!parsed.success) {
        respond({ ok: false, error: msg('quick.badRequest') });
        return;
      }

      const memberId = parsed.data.memberToken || randomUUID();

      void quick
        .join({ game: parsed.data.game, code: parsed.data.code, memberId, name: parsed.data.name })
        .then((outcome) => {
          if (!outcome.ok) {
            respond({ ok: false, error: outcome.error });
            return;
          }

          attachQuick(outcome.lobby.code, memberId);
          /**
           * The socket may have gone while the lookups above were out.
           *
           * `disconnect` fires in order, and it fired already - against a socket
           * that was not attached to anything yet, so it found nothing to release
           * and did nothing. A lobby forgets a member the moment they go, so a ghost left behind here is worse than a lit seat: it holds the room above empty for ever, so the grace that closes an abandoned one never starts, and it counts against \`maxPlayers\` so the room looks full to everybody trying to get in.
           */
          if (!socket.connected) quickHandleDisconnect(socket);

          respond({
            ok: true,
            code: outcome.lobby.code,
            memberId,
            memberToken: memberId,
            view: toQuickView(outcome.lobby, outcome.specs, memberId, Date.now())
          });

          // Arrived after the room left: send them straight on rather than
          // leaving them looking at a lobby that will never move again.
          if (outcome.lobby.launch) {
            socket.emit('quick:launch', {
              game: outcome.lobby.game,
              lobbyCode: outcome.lobby.code,
              code: outcome.lobby.launch.code,
              path: quickJoinPath(outcome.lobby.game, outcome.lobby.launch.code)
            });
          }
        })
        .catch((error: unknown) => {
          app.log.error({ err: error }, 'quick join failed');
          respond({ ok: false, error: msg('quick.serverQuiet') });
        });
    });

    socket.on('quick:replay', (payload, ack) => {
      const respond = responder<QuickJoinAck>(ack);
      const parsed = quickReplaySchema.safeParse(payload);
      if (!parsed.success) {
        respond({ ok: false, error: msg('quick.badRequest') });
        return;
      }

      const memberId = randomUUID();

      void quick
        .replay({
          game: parsed.data.game,
          gameCode: parsed.data.gameCode,
          memberId,
          name: parsed.data.name
        })
        .then((outcome) => {
          if (!outcome.ok) {
            respond({ ok: false, error: outcome.error });
            return;
          }

          attachQuick(outcome.lobby.code, memberId);
          // Same race as `quick:join` above, same reason.
          if (!socket.connected) quickHandleDisconnect(socket);

          respond({
            ok: true,
            code: outcome.lobby.code,
            memberId,
            memberToken: memberId,
            view: toQuickView(outcome.lobby, outcome.specs, memberId, Date.now())
          });
        })
        .catch((error: unknown) => {
          app.log.error({ err: error }, 'quick replay failed');
          respond({ ok: false, error: msg('quick.serverQuiet') });
        });
    });

    socket.on('quick:ready', (payload) => {
      const parsed = quickReadySchema.safeParse(payload);
      const member = socket.data.quickMemberId;
      if (!parsed.success || !member || socket.data.quickCode !== parsed.data.code) return;
      quick.ready(parsed.data.code, member, parsed.data.ready);
    });

    socket.on('quick:vote', (payload) => {
      const parsed = quickVoteSchema.safeParse(payload);
      const member = socket.data.quickMemberId;
      if (!parsed.success || !member || socket.data.quickCode !== parsed.data.code) return;
      quick.vote(parsed.data.code, member, parsed.data.key, parsed.data.value);
    });

    socket.on('quick:bots', (payload) => {
      const parsed = quickBotsSchema.safeParse(payload);
      const member = socket.data.quickMemberId;
      if (!parsed.success || !member || socket.data.quickCode !== parsed.data.code) return;
      quick.bots(parsed.data.code, parsed.data.count);
    });

    socket.on('quick:beat', (payload) => {
      const parsed = quickBeatSchema.safeParse(payload);
      const member = socket.data.quickMemberId;
      if (!parsed.success || !member || socket.data.quickCode !== parsed.data.code) return;
      quick.beat(parsed.data.code, member);
    });

    socket.on('quick:leave', (payload) => {
      const parsed = quickLeaveSchema.safeParse(payload);
      const member = socket.data.quickMemberId;
      if (!parsed.success || !member || socket.data.quickCode !== parsed.data.code) return;
      quick.leave(parsed.data.code, member);
      socket.data.quickCode = undefined;
      socket.data.quickMemberId = undefined;
      void socket.leave(quickRoom(parsed.data.code));
    });

    /** One room at a time: joining a second leaves the first. */
    function attachQuick(code: string, memberId: string): void {
      const previous = socket.data.quickCode;
      if (previous && previous !== code && socket.data.quickMemberId) {
        quick.leave(previous, socket.data.quickMemberId);
      }
      if (previous && previous !== code) void socket.leave(quickRoom(previous));
      socket.data.quickCode = code;
      socket.data.quickMemberId = memberId;
      void socket.join(quickRoom(code));
    }

    socket.on('disconnect', () => {
      handleDisconnect(socket);
      czHandleDisconnect(socket);
      mafiaHandleDisconnect(socket);
      quickHandleDisconnect(socket);
    });

    /**
     * A quick room forgets you the moment you go.
     *
     * The opposite of every other disconnect here, and for the opposite reason:
     * elsewhere the seat holds a score and a role that must survive a phone
     * locking. A lobby member holds one vote, and leaving it behind would raise
     * the majority the people still present have to clear — a room of five that
     * became three could no longer start at all.
     */
    function quickHandleDisconnect(current: GameSocket): void {
      const { quickCode, quickMemberId } = current.data;
      if (!quickCode || !quickMemberId) return;
      quick.leave(quickCode, quickMemberId);
    }

    /**
     * Same policy as everywhere: the seat survives, only its light goes out.
     *
     * `markConnected` also opens the seat's resync window, which is what
     * eventually stops the clock if the phone does not come back.
     */
    function mafiaHandleDisconnect(current: GameSocket): void {
      const { mafiaCode, mafiaPlayerId } = current.data;
      if (!mafiaCode || !mafiaPlayerId) return;
      mafia.markConnected(mafiaCode, mafiaPlayerId, false);
    }

    /** Same policy as the quizzes: the seat survives, only its light goes out. */
    function czHandleDisconnect(current: GameSocket): void {
      const { czCode, czRole } = current.data;
      if (!czCode || czRole?.kind !== 'player') return;

      const state = cz.get(czCode);
      const hero = state?.heroes[czRole.playerId];
      if (!state || !hero) return;

      hero.connected = false;
      /**
       * Opens the seat's resync window, which is what eventually stops the clock
       * if the phone does not come back. It pauses nothing by itself.
       *
       * It also broadcasts and saves, so nothing more is done here. Repeating
       * either would not merely be wasteful: the pause model may have just ended
       * this raid — or destroyed an abandoned one — and writing the state again
       * afterwards puts the deleted row straight back.
       */
      cz.markGone(czCode, czRole.playerId);
    }

    /**
     * A disconnect marks the player absent but keeps their seat and score. They are
     * only removed if the host kicks them, so a phone that locks mid-round does not
     * cost anyone their game.
     */
    function handleDisconnect(current: GameSocket): void {
      const { code, playerId } = current.data;
      if (!code || !playerId) return;

      const state = games.get(code);
      const player = state?.players[playerId];
      if (!state || !player) return;

      player.connected = false;
      broadcast(state);
      void games.persist(state);
    }
  });

  return io as SocketServer;
}
