import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import session from '@fastify/session';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';

import { mediaMigration } from './db/index.js';
import { SqliteSessionStore } from './db/session-store.js';
import { allowedOrigins, env, isProduction, packageRoot } from './env.js';
import { GameManager } from './game/manager.js';
import { MafiaManager } from './mafia/manager.js';
import authPlugin from './plugins/auth.js';
import { registerRealtime } from './realtime/index.js';
import mafiaRoutes from './routes/mafia.js';
import mediaRoutes from './routes/media.js';
import playRoutes from './routes/play.js';
import playlistRoutes from './routes/playlists.js';
import userRoutes from './routes/user.js';
import zombieRoutes from './routes/zombie.js';
import { CzManager } from './zombie/manager.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Where the built frontend lives.
 *
 * `FRONT_DIR` is resolved against the directory holding this package, which in the
 * workspace is `apps/`, so the frontend is `FRONT_DIR=front` with
 * `FRONT_DIR_BUILD=dist`. The pair is kept rather than collapsed into one path
 * because that is what the existing deployment sets.
 */
function resolveFrontendDir(): string | null {
  if (!env.FRONT_DIR || !env.FRONT_DIR_BUILD) {
    return null;
  }

  const candidate = resolve(packageRoot, '..', env.FRONT_DIR, env.FRONT_DIR_BUILD);
  return existsSync(join(candidate, 'index.html')) ? candidate : null;
}

/**
 * Quiet under test, so the smoke run's own output is what you read rather than a
 * request log per check. DEBUG=true still wins, for the run where the request log
 * is exactly what you need.
 */
function logLevel(): string {
  if (env.DEBUG) return 'debug';
  return env.NODE_ENV === 'test' ? 'warn' : 'info';
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: isProduction
      ? { level: logLevel() }
      : {
          level: logLevel(),
          transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
        },
    // Behind nginx on the Kune box, so trust its forwarding headers.
    trustProxy: isProduction
  }).withTypeProvider<ZodTypeProvider>();

  // Route schemas are Zod, not JSON Schema.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(sensible);

  app.log.info({ allowedOrigins }, 'CORS allow-list');

  await app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
    /**
     * Spelled out because the default is the three safelisted methods, and a
     * method missing from the preflight response is a method the browser refuses
     * to send: editing a playlist (PATCH) and deleting one (DELETE) both failed
     * with a CORS error while the same requests worked from curl, which does not
     * preflight. Anything the API answers has to be listed here.
     */
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']
  });

  /**
   * Registered but not applied globally.
   *
   * A blanket limit would be aimed at the wrong traffic. The asset proxy is the
   * busiest route by a wide margin — a forty-cell panel is forty requests per
   * phone, arriving within a second or two of each other — and throttling it
   * breaks the game it is serving. Guessing passwords is the thing worth
   * rationing, so the limits live on those two routes and nowhere else.
   */
  await app.register(rateLimit, { global: false });

  const sessionStore = new SqliteSessionStore(SESSION_TTL_MS);
  sessionStore.startSweeping();

  await app.register(cookie, { secret: env.SECRET });
  await app.register(session, {
    secret: env.SECRET,
    store: sessionStore,
    cookieName: 'kune.sid',
    saveUninitialized: false,
    rolling: true,
    cookie: {
      path: '/',
      httpOnly: true,
      // Deriving this from the frontend protocol rather than NODE_ENV: a secure
      // cookie over plain http is simply never sent, which would lock out the
      // LAN deployment.
      secure: env.FRONT_PROTOCOL === 'https',
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS
    }
  });

  await app.register(authPlugin);

  // Exposed so the socket layer can resolve the account behind a handshake
  // cookie; see realtime/account.ts.
  app.decorate('sessions', sessionStore);

  const games = new GameManager(app.log);
  app.decorate('games', games);

  const cz = new CzManager(app.log);
  app.decorate('cz', cz);

  const mafia = new MafiaManager(app.log);
  app.decorate('mafia', mafia);

  await app.register(
    async (api) => {
      await api.register(userRoutes);
      await api.register(mediaRoutes);
      await api.register(playlistRoutes);
      await api.register(playRoutes);
      await api.register(zombieRoutes);
      await api.register(mafiaRoutes);
    },
    { prefix: '/api' }
  );

  const frontendDir = resolveFrontendDir();
  if (frontendDir) {
    app.log.info({ frontendDir }, 'serving frontend build');
    await app.register(fastifyStatic, { root: frontendDir, wildcard: false });
  }

  // SPA fallback. API paths must keep returning JSON 404s rather than HTML,
  // otherwise a typo'd endpoint looks like a successful page load to the client.
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api') || !frontendDir) {
      return reply.code(404).send({ message: 'Not found' });
    }
    return reply.sendFile('index.html');
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;

    if (error.validation) {
      request.log.info({ err: error, url: request.url }, 'request failed validation');
      return reply.code(400).send({
        message: 'Invalid request',
        details: error.validation
      });
    }

    if (statusCode >= 500) {
      request.log.error({ err: error, url: request.url }, 'request failed');
      // Never leak an internal message or stack to the client.
      return reply.code(statusCode).send({ message: 'Internal Server Error' });
    }

    request.log.info({ err: error, url: request.url }, 'request rejected');
    return reply.code(statusCode).send({ message: error.message });
  });

  app.decorate('io', registerRealtime(app, games, cz, mafia));

  if (mediaMigration.ran && (mediaMigration.videos > 0 || mediaMigration.images > 0)) {
    app.log.info(
      {
        videos: mediaMigration.videos,
        images: mediaMigration.images,
        playlistItems: mediaMigration.playlistItems,
        incomplete: mediaMigration.incomplete.length
      },
      'migrated legacy Videos/Images into Media'
    );

    for (const entry of mediaMigration.incomplete) {
      app.log.warn({ mediaId: entry.mediaId, title: entry.title }, `média incomplet : ${entry.reason}`);
    }
  }

  app.addHook('onReady', async () => {
    const restored = await games.restore();
    if (restored > 0) {
      app.log.info({ restored }, 'restored games in progress');
    }
    games.startSweeping();

    const raids = await cz.restore();
    if (raids > 0) {
      app.log.info({ restored: raids }, 'restored CoronaZ raids in progress');
    }
    cz.startSweeping();

    const tables = await mafia.restore();
    if (tables > 0) {
      app.log.info({ restored: tables }, 'restored Mafia tables in progress');
    }
    mafia.startSweeping();
  });

  app.addHook('onClose', async () => {
    sessionStore.stopSweeping();
    games.stopSweeping();
    cz.stopSweeping();
    mafia.stopSweeping();
    await app.io.close();
  });

  return app;
}
