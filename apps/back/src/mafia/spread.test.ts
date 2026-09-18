import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import type { FastifyBaseLogger } from 'fastify';

/**
 * Spending every free tier that was configured, rather than the quickest few.
 *
 * Ten endpoints were set up on the deployment box and all ten answered a probe
 * inside 1.3 seconds. Four of them were ever asked anything. That is not a bug
 * in the ranking — it is the ranking working exactly as written, admitting only
 * what sits "within striking distance of the fastest" — and it is the wrong
 * trade for free tiers, because each of the other six has its own daily
 * allowance and an allowance nobody spends is not saved, it expires.
 *
 * `MAFIA_API_SPREAD` names a working set and takes turns inside it. These are
 * the two properties that has to have: everybody in the set gets asked, and
 * nobody outside it gets asked while the set has room.
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

/** How many endpoints exist, and how many of them are meant to be working. */
const SLOTS = 10;
const SPREAD = 8;

let server: Server;
let port = 0;

before(async () => {
  /**
   * Latency on purpose, and spread wide.
   *
   * Slot 4 answers in 10ms and slot 9 in 220ms, which under the old ranking is
   * the difference between carrying the table and never being asked at all.
   * The point of the test is that it stops making that difference.
   */
  const body = JSON.stringify({ choices: [{ message: { content: '{"line":"ok"}' } }] });
  server = createServer((request, response) => {
    const slot = Number(/\/slot(\d+)/.exec(request.url ?? '')?.[1] ?? 1);
    setTimeout(
      () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(body);
      },
      10 + slot * 20
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
  process.env.MAFIA_API_SPREAD = String(SPREAD);
  // The hedge would ask a second endpoint on the slow ones and muddy the count.
  process.env.MAFIA_HEDGE_MS = '0';
  process.env.GAME_TRACE = 'off';
});

after(() => {
  server.close();
});

describe('spreading the work across the free tiers', () => {
  it('asks every endpoint in the working set, however slow it is', async () => {
    const { MafiaBotDriver } = await import('./bots.js');
    const driver = new MafiaBotDriver(log, hooks);

    // Sequential, so nothing is ever busy: the only thing deciding who gets
    // asked is whose turn it is.
    for (let round = 0; round < SPREAD * 3; round++) {
      await driver.askChain({ system: 'system', user: 'user', format: {}, maxTokens: 50 }, { code: 'TEST' }, 'decide');
    }

    const board = driver.scoreboard();
    const slotOf = (model: string) => Number(model.replace('model-', ''));
    const working = board.filter((row) => slotOf(row.model) <= SPREAD);
    const reserve = board.filter((row) => slotOf(row.model) > SPREAD);

    const idle = working.filter((row) => row.ok === 0);
    assert.equal(
      idle.length,
      0,
      `these were never asked anything: ${idle.map((row) => row.model).join(', ')} — board ${board.map((row) => `${row.model}=${String(row.ok)}`).join(' ')}`
    );

    /**
     * And evenly, which is the property that makes it worth doing.
     *
     * Turn by turn over twenty-four calls and eight endpoints is three each. A
     * spread of more than one means something other than the rotation is
     * choosing, and the thing that would be choosing is speed.
     */
    const counts = working.map((row) => row.ok);
    assert.ok(
      Math.max(...counts) - Math.min(...counts) <= 1,
      `the work was not shared evenly: ${working.map((row) => `${row.model}=${String(row.ok)}`).join(' ')}`
    );

    /** The reserve stays a reserve while the working set has room. */
    const touched = reserve.filter((row) => row.ok > 0 || row.busy > 0);
    assert.equal(
      touched.length,
      0,
      `reserve endpoints were used while the working set was free: ${touched.map((row) => row.model).join(', ')}`
    );

    driver.stop();
  });

  it('falls through to the reserve when the working set is saturated', async () => {
    const { MafiaBotDriver } = await import('./bots.js');
    const driver = new MafiaBotDriver(log, hooks);

    /**
     * More questions at once than the working set can hold.
     *
     * One call in flight per endpoint is the default, so eight simultaneous
     * askers fill the set and the ninth has to go somewhere. A reserve that
     * cannot be reached under load is not a reserve, it is a misconfiguration
     * nobody would ever see.
     */
    await Promise.all(
      Array.from({ length: SLOTS + 4 }, () =>
        driver.askChain({ system: 'system', user: 'user', format: {}, maxTokens: 50 }, { code: 'TEST' }, 'decide')
      )
    );

    const board = driver.scoreboard();
    const reserve = board.filter((row) => Number(row.model.replace('model-', '')) > SPREAD);
    const used = reserve.filter((row) => row.ok > 0 || row.bad > 0);
    assert.ok(
      used.length > 0,
      `the reserve was never reached under load: ${board.map((row) => `${row.model}=${String(row.ok)}`).join(' ')}`
    );

    driver.stop();
  });
});
