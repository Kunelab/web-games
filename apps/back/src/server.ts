import { buildApp } from './app.js';
import { closeDb } from './db/index.js';
import { env } from './env.js';
import { GENRES, catalogAvailable } from './services/blindtest-catalog.js';
import { warmSeeds } from './services/blindtest-seeds.js';

const app = await buildApp();

/**
 * The Express version swallowed `uncaughtException` and `unhandledRejection`
 * with a bare `console.error` and kept running in an unknown state. Fastify logs
 * and then exits so the process supervisor can restart it cleanly.
 */
async function shutdown(reason: string, error?: unknown): Promise<never> {
  if (error) {
    app.log.fatal({ err: error }, reason);
  } else {
    app.log.info(reason);
  }

  try {
    await app.close();
    closeDb();
  } catch (closeError) {
    app.log.error({ err: closeError }, 'error during shutdown');
  }

  process.exit(error ? 1 : 0);
}

process.on('uncaughtException', (error) => void shutdown('uncaught exception', error));
process.on('unhandledRejection', (error) => void shutdown('unhandled rejection', error));
process.on('SIGTERM', () => void shutdown('SIGTERM received'));
process.on('SIGINT', () => void shutdown('SIGINT received'));

try {
  await app.listen({ port: env.PORT, host: env.HOST });
} catch (error) {
  app.log.fatal({ err: error }, 'failed to start');
  process.exit(1);
}

/**
 * The blind test's seed catalogues, fetched ahead of the first host.
 *
 * Only what is due, one source at a time, in the background: nothing at all on
 * most boots, and on the monthly one a few minutes of Deezer, AniList and
 * Wikidata before anybody opens the setup screen, rather than a first round
 * that waits for them. Skipped where the blind test cannot run.
 */
if (catalogAvailable()) warmSeeds(GENRES);
