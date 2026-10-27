import { buildApp } from './app.js';
import { closeDb } from './db/index.js';
import { env } from './env.js';
import { catalogAvailable } from './services/blindtest-catalog.js';
import { tagEras } from './services/blindtest-eras.js';
import { reopenLostHitsOnce, schedulePrefill } from './services/blindtest-prefill.js';
import { catalogue } from './services/catalogue-service.js';

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
if (catalogAvailable()) catalogue.warmSeeds();

// Every catalogue round in the eras its year is in; next to nothing after the first boot.
try {
  const tagged = tagEras();
  if (tagged > 0) app.log.info({ tagged }, 'blind test rounds filed in their eras');
} catch (error) {
  app.log.warn({ err: error }, 'could not file the blind test rounds in their eras');
}

// And the day's unused searches spent on the catalogue before they lapse, once
// the hits the old artist searches lost are back in the stock.
void reopenLostHitsOnce(app.log)
  .catch((error: unknown) => app.log.warn({ err: error }, 'could not put the blind test hits back'))
  .finally(() => schedulePrefill(app.log));
