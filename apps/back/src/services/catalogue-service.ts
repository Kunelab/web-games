import { systemClock } from '../clock.js';
import { db } from '../db/index.js';
import { env } from '../env.js';
import { createCatalogue } from './blindtest-catalog.js';
import { httpSources } from './blindtest-sources.js';

/**
 * The deployment's one blind test catalogue: the real services, the app's
 * database, the wall clock and the configured search budget.
 *
 * A module-level instance, like the other services, rather than one built in
 * `buildApp`: the game manager deals every endless round through `drawRounds`
 * and the quick-match launch draws its first, and neither is handed anything
 * to draw from. Built once here, everything that reads the catalogue shares its
 * pools, its in-flight fills and its view of the day's searches.
 */
export const catalogue = createCatalogue({
  sources: httpSources,
  db,
  clock: systemClock,
  budget: env.BLINDTEST_SEARCH_BUDGET
});
