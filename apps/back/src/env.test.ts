import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * How the model endpoints are read out of the environment.
 *
 * Set before `env.js` is imported, because it is parsed once at module load;
 * hence the dynamic import. Blanked rather than deleted first, because dotenv
 * declines to overwrite what is already set and would otherwise fill the gaps
 * from a developer's real `.env`.
 */
for (let slot = 1; slot <= 24; slot++) {
  const suffix = slot === 1 ? '' : `_${slot}`;
  for (const part of ['URL', 'KEY', 'MODEL', 'MODELS']) process.env[`MAFIA_API${suffix}_${part}`] = '';
}
process.env.MAFIA_API_URL = 'http://127.0.0.1:1/stall';
process.env.MAFIA_API_KEY = 'test-key';
process.env.MAFIA_API_MODEL = 'stall-model';
process.env.MAFIA_API_2_URL = 'http://127.0.0.1:1/quick';
process.env.MAFIA_API_2_MODEL = 'quick-model';
// One slot, two models, no URL or key of its own: the common shape.
process.env.MAFIA_API_3_URL = 'http://127.0.0.1:1/quick';
process.env.MAFIA_API_3_MODELS = 'quick-b,quick-c';

const { apiSlots } = await import('./env.js');

describe('the model endpoints', () => {
  it('turns one key and a list of models into one rung each', () => {
    assert.deepEqual(
      apiSlots.map((slot) => slot.rung),
      ['api1', 'api2', 'api3', 'api3b']
    );
    // Slot 3 was given no key of its own, so both its models inherit slot one's.
    const inherited = apiSlots.filter((slot) => slot.rung.startsWith('api3'));
    assert.ok(inherited.every((slot) => slot.key === 'test-key'));
    assert.deepEqual(
      inherited.map((slot) => slot.model),
      ['quick-b', 'quick-c']
    );
  });
});
