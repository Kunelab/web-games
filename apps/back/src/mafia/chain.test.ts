import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import type { FastifyBaseLogger } from 'fastify';

/**
 * The chain, against endpoints that behave the way free tiers actually behave.
 *
 * Everything here is about the *tail*. A free endpoint is not slow on average —
 * a few hundred milliseconds — it is slow sometimes, and the sometimes is what a
 * person at the table experiences, because an answer that arrives late arrives
 * after the moment it was about. The two mechanisms under test are the only two
 * that help: ask a second endpoint when the first stalls, and remember which
 * ones stall.
 *
 * The environment is set before the driver is imported, because `env` is parsed
 * once at module load. Hence the dynamic import.
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
  get: () => undefined
};

/** One endpoint that always stalls, one that always answers. */
const STALL_MS = 2000;
const QUICK_MS = 30;
const HEDGE_MS = 400;

let server: Server;
let port = 0;

before(async () => {
  const body = JSON.stringify({ choices: [{ message: { content: '{"line":"ok"}' } }] });
  server = createServer((request, response) => {
    const slow = (request.url ?? '').includes('stall');
    setTimeout(
      () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(body);
      },
      slow ? STALL_MS : QUICK_MS
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;

  /**
   * One endpoint that stalls and three that answer, which is the shape of an
   * evening on free tiers: they are not slow, one of them is slow right now.
   */
  process.env.MAFIA_BOT_PROVIDER = 'api*';
  process.env.MAFIA_API_URL = `http://127.0.0.1:${port}/stall`;
  process.env.MAFIA_API_KEY = 'test-key';
  process.env.MAFIA_API_MODEL = 'stall-model';
  process.env.MAFIA_API_2_URL = `http://127.0.0.1:${port}/quick`;
  process.env.MAFIA_API_2_MODEL = 'quick-model';
  // One slot, two models, no URL or key of its own: the common shape.
  process.env.MAFIA_API_3_URL = `http://127.0.0.1:${port}/quick`;
  process.env.MAFIA_API_3_MODELS = 'quick-b,quick-c';
  process.env.MAFIA_HEDGE_MS = String(HEDGE_MS);
  process.env.GAME_TRACE = 'off';
});

after(() => {
  server.close();
});

describe('the chain', () => {
  it('turns one key and a list of models into one rung each', async () => {
    const { apiSlots } = await import('../env.js');
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

  it('never waits out a stalled endpoint when another one is idle', async () => {
    const { MafiaBotDriver } = await import('./bots.js');

    /**
     * A fresh driver each time, so every call draws from a pool nobody has
     * measured — which is the first call of an evening, and the one case where
     * picking the stalled endpoint cannot be avoided by being clever.
     */
    const took: number[] = [];
    for (let round = 0; round < 6; round++) {
      const driver = new MafiaBotDriver(log, hooks);
      const at = Date.now();
      const answer = await driver.askChain(
        { system: 'system', user: 'user', format: {}, maxTokens: 50 },
        { code: 'TEST' },
        'decide'
      );
      took.push(Date.now() - at);
      driver.stop();
      assert.ok(answer, 'nothing answered at all');
    }

    const worst = Math.max(...took);
    assert.ok(
      worst < STALL_MS - 500,
      `a call waited ${worst}ms for a ${String(STALL_MS)}ms endpoint instead of asking somebody else: ${took.join(', ')}`
    );
  });

  it('uses every endpoint at once rather than leaning on the quickest', async () => {
    const { MafiaBotDriver } = await import('./bots.js');
    const driver = new MafiaBotDriver(log, hooks);

    /**
     * Six questions at once against three endpoints that take one call each.
     *
     * The ranking decides who is asked *first*, never who is asked at all: with
     * more questions than idle endpoints, every endpoint that is up takes one,
     * including the slow one, because a slow answer is worth more than no
     * answer. What the caps prevent is the opposite mistake, six calls to the
     * same free tier, which is what earns a 429 and benches it for everybody.
     */
    const answers = await Promise.all(
      Array.from({ length: 6 }, () =>
        driver.askChain({ system: 'system', user: 'user', format: {}, maxTokens: 50 }, { code: 'TEST' }, 'decide')
      )
    );

    const board = driver.scoreboard();
    // Still in flight counts as asked: the stalled endpoint is, by definition,
    // not going to have answered by the time the hedge has won the race.
    const used = board.filter((row) => row.ok > 0 || row.bad > 0 || row.busy > 0);
    assert.equal(
      used.length,
      board.length,
      `only ${String(used.length)} of ${String(board.length)} endpoints were asked: ${board.map((row) => `${row.model}=${String(row.ok)}`).join(' ')}`
    );
    assert.ok(answers.filter(Boolean).length >= 3, 'fewer answers than endpoints');
    driver.stop();
  });

  it('prefers the quick endpoint while it has room', async () => {
    const { MafiaBotDriver } = await import('./bots.js');
    const driver = new MafiaBotDriver(log, hooks);

    for (let round = 0; round < 6; round++) {
      await driver.askChain({ system: 'system', user: 'user', format: {}, maxTokens: 50 }, { code: 'TEST' }, 'decide');
    }

    const board = new Map(driver.scoreboard().map((row) => [row.model, row]));
    const quick = board.get('quick-model');
    const stalled = board.get('stall-model');
    assert.ok(quick && stalled);
    assert.ok(
      quick.ok > stalled.ok,
      `the slow endpoint kept its share: quick ${String(quick.ok)}, stalled ${String(stalled.ok)}`
    );
    driver.stop();
  });
});
