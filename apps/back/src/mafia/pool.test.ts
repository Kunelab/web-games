import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import type { FastifyBaseLogger } from 'fastify';

/**
 * Picking an endpoint when nobody has asked for a rotation.
 *
 * `spread.test.ts` covers the opt-in working set, which takes turns. This is
 * the default, which ranks: the quickest healthy endpoint should get the call
 * when it is free, and the others should still be reached when it is not.
 *
 * It exists because the ranking had collapsed. Measured across fourteen real
 * games on ten configured slots, one endpoint answered 252 of the 372
 * successful calls and the next one down — 280ms slower, which nobody at a
 * table can perceive — took 87. The window for "close enough to the fastest"
 * was a quarter of a second, and a quarter of a second was deciding which of
 * ten free daily allowances got spent while the rest expired unused.
 *
 * Two properties, and they pull against each other on purpose:
 *
 *  - when there is one call to make, the fast endpoint makes it;
 *  - when there are more calls in flight than the fast ones can hold, the rest
 *    of the healthy field is used rather than the table waiting.
 */

const quiet = () => undefined;
const log = {
  info: quiet,
  warn: quiet,
  error: quiet,
  debug: quiet,
  fatal: quiet,
  trace: quiet,
  silent: quiet,
  level: 'silent',
  child() {
    return log;
  }
} as unknown as FastifyBaseLogger;

const hooks = {
  chat: () => ({ ok: true as const }),
  vote: () => ({ ok: true as const }),
  ballot: () => ({ ok: true as const }),
  action: () => ({ ok: true as const }),
  dayAction: () => ({ ok: true as const }),
  will: () => ({ ok: true as const }),
  whisper: () => ({ ok: true as const }),
  busy: () => undefined,
  get: () => undefined
};

const SLOTS = 6;
/** One call at a time per endpoint, so "busy" means what the test says it means. */
const PARALLEL = 1;

let server: Server;
let port = 0;

before(async () => {
  /**
   * Six endpoints from 20ms to 320ms, which is the shape of a real chain.
   *
   * Slot 1 is the quickest and slot 6 is sixteen times slower. Under the old
   * quarter-second window slots 4, 5 and 6 were unreachable while slot 1 was
   * alive; under a human tolerance they are all "fast enough" and the only
   * thing keeping them idle is that the quick ones are free.
   */
  const body = JSON.stringify({ choices: [{ message: { content: '{"line":"ok"}' } }] });
  server = createServer((request, response) => {
    const slot = Number(/\/slot(\d+)/.exec(request.url ?? '')?.[1] ?? 1);
    setTimeout(
      () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(body);
      },
      slot * 60 - 40
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;

  // Blanked rather than deleted: see the note in `chain.test.ts`.
  for (let slot = 1; slot <= 24; slot++) {
    const suffix = slot === 1 ? '' : `_${slot}`;
    for (const part of ['URL', 'KEY', 'MODEL', 'MODELS']) process.env[`MAFIA_API${suffix}_${part}`] = '';
  }

  process.env.MAFIA_BOT_PROVIDER = 'api*';
  for (let slot = 1; slot <= SLOTS; slot++) {
    const suffix = slot === 1 ? '' : `_${slot}`;
    process.env[`MAFIA_API${suffix}_URL`] = `http://127.0.0.1:${String(port)}/slot${String(slot)}`;
    process.env[`MAFIA_API${suffix}_KEY`] = 'test-key';
    process.env[`MAFIA_API${suffix}_MODEL`] = `model-${String(slot)}`;
  }
  // The default: no rotation asked for, so the ranking decides.
  process.env.MAFIA_API_SPREAD = '0';
  process.env.MAFIA_API_PARALLEL = String(PARALLEL);
  // The hedge would ask a second endpoint on the slow ones and muddy the count.
  process.env.MAFIA_HEDGE_MS = '0';
  process.env.GAME_TRACE = 'off';
});

after(() => {
  server.close();
});

const ask = (driver: { askChain: (...args: never[]) => Promise<unknown> }) =>
  (driver.askChain as unknown as (a: unknown, b: unknown, c: string) => Promise<unknown>)(
    { system: 'system', user: 'user', format: {}, maxTokens: 50 },
    { code: 'TEST' },
    'decide'
  );

describe('choosing an endpoint when none was asked for by name', () => {
  /**
   * One call at a time, and the quick one takes all of them.
   *
   * The widened window must not turn into a lottery. With nothing in flight
   * there is no reason to ask anybody but the best, and an endpoint that is
   * merely acceptable should stay idle.
   */
  it('gives a lone call to the fastest healthy endpoint', async () => {
    const { MafiaBotDriver } = await import('./bots.js');
    const driver = new MafiaBotDriver(log, hooks);

    // One warm-up per slot, so every endpoint has a measured speed to be ranked on.
    for (let round = 0; round < SLOTS * 2; round++) await ask(driver);

    const before = new Map(driver.scoreboard().map((row) => [row.model, row.ok]));
    for (let round = 0; round < 8; round++) await ask(driver);
    const after = driver.scoreboard();

    const gained = (model: string) => (after.find((row) => row.model === model)?.ok ?? 0) - (before.get(model) ?? 0);
    assert.ok(gained('model-1') >= 6, `the quickest should take a lone call: ${JSON.stringify(after)}`);
    assert.equal(gained('model-6'), 0, 'the slowest should be idle while the quickest is free');
  });

  /**
   * And when the quick ones are all busy, the rest of the field answers.
   *
   * This is the half that was broken. Twelve seats thinking at once is an
   * ordinary afternoon, and with one call in flight per endpoint it needs
   * twelve endpoints or it needs to wait. Waiting is what sends a seat to the
   * phrasebook, so the work goes wide instead.
   */
  it('reaches the rest of the field when the quick ones are full', async () => {
    const { MafiaBotDriver } = await import('./bots.js');
    const driver = new MafiaBotDriver(log, hooks);

    for (let round = 0; round < SLOTS * 2; round++) await ask(driver);

    const before = new Map(driver.scoreboard().map((row) => [row.model, row.ok]));
    await Promise.all(Array.from({ length: SLOTS * 2 }, () => ask(driver)));
    const after = driver.scoreboard();

    const used = after.filter((row) => (row.ok ?? 0) - (before.get(row.model) ?? 0) > 0);
    assert.ok(
      used.length >= 4,
      `a burst should reach most of the field, reached ${String(used.length)}: ${JSON.stringify(after)}`
    );
  });
});
