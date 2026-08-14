import {
  czGmActionSchema,
  czHeroActionSchema,
  czJoinSchema,
  joinHero,
  setLoadout,
  switchHero,
  toView,
  type CzClientToServer,
  type CzRole,
  type CzServerToClient,
  type CzState
} from 'coronaz-core';
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
import { czCareerService } from '../services/cz-career-service.js';
import { resultsService } from '../services/results-service.js';
import type { CzManager } from '../zombie/manager.js';

/** Per-connection bookkeeping, kept out of the game state. */
interface SocketData {
  code?: string;
  playerId?: string;
  isHost: boolean;
  /** CoronaZ attachment: one socket is in at most one raid, in one role. */
  czCode?: string;
  czRole?: CzRole;
}

type AllClientToServer = ClientToServerEvents & CzClientToServer;
type AllServerToClient = ServerToClientEvents & CzServerToClient;

type GameSocket = Socket<AllClientToServer, AllServerToClient, Record<string, never>, SocketData>;

export function registerRealtime(app: FastifyInstance, games: GameManager, cz: CzManager): SocketServer {
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

  /** Same projection-per-recipient rule as the quizzes: the fog is per role. */
  function czBroadcast(state: CzState): void {
    for (const socket of io.sockets.sockets.values()) {
      const data = socket.data;
      if (data.czCode !== state.code || !data.czRole) continue;
      socket.emit('cz:state', toView(state, data.czRole));
    }
  }

  cz.onTransition(czBroadcast);

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
            other.emit('session:error', { message: 'Vous avez été retiré de la partie' });
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

    /* ------------------------------- CoronaZ ------------------------------- */

    /** Attach this socket to a raid in a role, after checking its credential. */
    function czAttach(code: string, role: CzRole): void {
      socket.data.czCode = code;
      socket.data.czRole = role;
      void socket.join(`cz:${code}`);
    }

    socket.on('cz:open', (payload, ack) => {
      const respond = typeof ack === 'function' ? ack : () => undefined;
      const code = typeof payload?.code === 'string' ? payload.code.trim().toUpperCase() : '';
      const state = cz.get(code);

      if (!state || payload?.hostToken !== state.hostToken) {
        respond({ ok: false, error: 'Aucune partie avec ce code' });
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
      const respond = typeof ack === 'function' ? ack : () => undefined;
      const code = typeof payload?.code === 'string' ? payload.code.trim().toUpperCase() : '';
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

    socket.on('cz:join', (payload, ack) => {
      const respond = typeof ack === 'function' ? ack : () => undefined;
      const parsed = czJoinSchema.safeParse(payload);
      if (!parsed.success) {
        respond({ ok: false, error: parsed.error.issues[0]?.message ?? 'Requête invalide' });
        return;
      }

      const state = cz.get(parsed.data.code.trim().toUpperCase());
      if (!state) {
        respond({ ok: false, error: 'Aucune partie avec ce code' });
        return;
      }

      void (async () => {
        try {
          // The roguelite perks this nickname has earned, resolved before the seat
          // exists: tough-skin has to be in the max HP from the first breath.
          const perks = await czCareerService.heroPerks(parsed.data.name).catch(() => []);
          const { hero } = joinHero(state, parsed.data.name, parsed.data.playerToken, perks);
          czAttach(state.code, { kind: 'player', playerId: hero.playerId });
          const career = await czCareerService.forName(hero.name).catch(() => null);
          respond({
            ok: true,
            playerToken: hero.token,
            playerId: hero.playerId,
            view: toView(state, { kind: 'player', playerId: hero.playerId }),
            career: career ? { rations: career.stats.rations, unlockedHeroes: career.stats.unlockedHeroes } : undefined
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
          respond({ ok: false, error: error instanceof Error ? error.message : 'Impossible de rejoindre' });
        }
      })();
    });

    socket.on('cz:selectHero', (payload, ack) => {
      const respond = typeof ack === 'function' ? ack : () => undefined;
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
          if (me && !(await czCareerService.heroAllowed(me.name, heroId))) {
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
      const respond = typeof ack === 'function' ? ack : () => undefined;
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
      const respond = typeof ack === 'function' ? ack : () => undefined;
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
          const result = await czCareerService.unlockHero(me.name, heroId);
          if (!result.ok) {
            respond(result);
            return;
          }
          const career = await czCareerService.forName(me.name);
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
      const respond = typeof ack === 'function' ? ack : () => undefined;
      const { czCode } = socket.data;
      const state = czCode ? cz.get(czCode) : undefined;
      if (!state || payload?.hostToken !== state.hostToken) {
        respond({ ok: false, error: 'Action réservée à l’écran hôte' });
        return;
      }
      respond(cz.addBot(state.code, typeof payload.skill === 'string' ? payload.skill : 'expert'));
    });

    socket.on('cz:removeBot', (payload) => {
      const { czCode } = socket.data;
      const state = czCode ? cz.get(czCode) : undefined;
      if (!state || payload?.hostToken !== state.hostToken) return;
      cz.removeBot(state.code, typeof payload.playerId === 'string' ? payload.playerId : '');
    });

    socket.on('cz:start', (payload) => {
      const { czCode } = socket.data;
      const state = czCode ? cz.get(czCode) : undefined;
      if (!state || payload?.hostToken !== state.hostToken) {
        socket.emit('cz:error', { message: 'Action réservée à l’écran hôte' });
        return;
      }
      if (state.phase !== 'lobby' || Object.keys(state.heroes).length === 0) return;

      void cz.start(state.code).catch((error: unknown) => {
        app.log.error({ err: error, code: state.code }, 'CoronaZ start failed');
      });
    });

    socket.on('cz:action', (payload, ack) => {
      const respond = typeof ack === 'function' ? ack : () => undefined;
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
      const respond = typeof ack === 'function' ? ack : () => undefined;
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
      const { czCode } = socket.data;
      const state = czCode ? cz.get(czCode) : undefined;
      if (!state || payload?.gmToken !== state.gmToken) return;

      void cz.gmEnd(state.code).catch((error: unknown) => {
        app.log.error({ err: error, code: state.code }, 'CoronaZ gmEnd failed');
      });
    });

    socket.on('disconnect', () => {
      handleDisconnect(socket);
      czHandleDisconnect(socket);
    });

    /** Same policy as the quizzes: the seat survives, only its light goes out. */
    function czHandleDisconnect(current: GameSocket): void {
      const { czCode, czRole } = current.data;
      if (!czCode || czRole?.kind !== 'player') return;

      const state = cz.get(czCode);
      const hero = state?.heroes[czRole.playerId];
      if (!state || !hero) return;

      hero.connected = false;
      czBroadcast(state);
      void cz.persist(state);
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
