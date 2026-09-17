/**
 * An empty table of endpoints, for tests that must not phone anybody.
 *
 * `env.ts` opens with `import 'dotenv/config'`, and `readApiSlots` reads the
 * environment rather than a config object — so a developer with a real `.env`
 * gives every test a dozen live rungs, and a test that builds a
 * `MafiaBotDriver` starts making paid calls to free tiers from a unit suite.
 * Slow, flaky, quota-spending, and it fails on exactly the machines that are
 * configured correctly.
 *
 * Blanked rather than deleted, because dotenv declines to overwrite what is
 * already set and an empty string counts as set, while `readApiSlots` reads
 * empty as absent. Deleting would simply invite dotenv to put it back.
 *
 * Import this *before* anything that pulls in `env.js`; ESM runs imports in the
 * order they are written, which is what makes that work.
 */
for (let slot = 1; slot <= 24; slot++) {
  const suffix = slot === 1 ? '' : `_${slot}`;
  for (const part of ['URL', 'KEY', 'MODEL', 'MODELS']) process.env[`MAFIA_API${suffix}_${part}`] = '';
}

/** And no local daemon either: the floor is the played brain, which is instant. */
process.env.MAFIA_BOT_PROVIDER = 'scripted';
process.env.OLLAMA_URL = '';
