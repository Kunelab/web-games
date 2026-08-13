import type { FastifyInstance } from 'fastify';
import {
  answerPayloadSchema,
  joinPayloadSchema,
  revealChoicesPayloadSchema,
  type ClientToServerEvents,
  type ServerToClientEvents
} from 'game-core';
import { Server as SocketServer, type Socket } from 'socket.io';

import { allowedOrigins } from '../env.js';
import type { GameManager } from '../game/manager.js';
import { joinSession, revealChoices, submitAnswer, type SessionState } from '../game/session.js';

/** Per-connection bookkeeping, kept out of the game state. */
interface SocketData {
  code?: string;
  playerId?: string;
  isHost: boolean;
}

type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export function registerRealtime(app: FastifyInstance, games: GameManager): SocketServer {
  const io: SocketServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData> =
    new SocketServer(app.server, {
      cors: { origin: allowedOrigins, credentials: true },
      // Players are on phones that sleep and switch networks; a generous window
      // means a returning socket resumes rather than being treated as a new player.
      connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 }
    });

  /**
   * Pushes the current state to everyone in a session.
   *
   * Each recipient gets their own projection, because what a player may see differs
   * per player: their own solved fields, their own remaining attempts, and never the
   * answers. Broadcasting one shared payload would leak.
   */
  function broadcast(state: SessionState): void {
    for (const socket of io.sockets.sockets.values()) {
      const data = socket.data;
      if (data.code !== state.code) continue;

      socket.emit('session:state', games.view(state, data.playerId ?? null, data.isHost));
    }
  }

  games.onTransition(broadcast);

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
      const respond = typeof ack === 'function' ? ack : () => undefined;

      const parsed = joinPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        respond({ ok: false, error: parsed.error.issues[0]?.message ?? 'Requête invalide' });
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

      socket.data.code = state.code;
      socket.data.playerId = player.id;
      socket.data.isHost = false;
      void socket.join(state.code);

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
    });

    socket.on('host:open', (payload, ack) => {
      const respond = typeof ack === 'function' ? ack : () => undefined;
      const code = typeof payload?.code === 'string' ? payload.code.trim().toUpperCase() : '';

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
      void socket.join(state.code);

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

    socket.on('host:kick', (payload) => {
      withHost(payload?.hostToken, async (state) => {
        const playerId = typeof payload?.playerId === 'string' ? payload.playerId : '';
        if (!state.players[playerId]) return;

        delete state.players[playerId];

        for (const other of io.sockets.sockets.values()) {
          const data = other.data;
          if (data.code === state.code && data.playerId === playerId) {
            other.emit('session:error', { message: "Vous avez été retiré de la partie" });
            void other.leave(state.code);
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
      const respond = typeof ack === 'function' ? ack : () => undefined;

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

      // Points are deliberately not sent yet: they depend on the finishing order,
      // which is not known until answering closes. Only the player's own view
      // changes, so this is not a broadcast.
      socket.emit('session:state', games.view(state, playerId, false));
      void games.persist(state);
    });

    socket.on('answer:revealChoices', (payload, ack) => {
      const respond = typeof ack === 'function' ? ack : () => undefined;
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

    socket.on('disconnect', () => {
      handleDisconnect(socket);
    });

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
