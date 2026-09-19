import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import type { FastifyBaseLogger } from 'fastify';
import { addMafiaBot, createMafiaGame, type MafiaState } from 'mafia-core';

/**
 * Which brain the board says is driving a seat.
 *
 * The flag on a bot's row answers one question — is a model doing this, or is it
 * the phrasebook — and for a long time it could only answer it about the mouth,
 * because the mouth was the only rung that wrote it down. A seat whose *move* a
 * model had chosen, and a whole table whose ear was turning every sentence
 * anybody typed into claims, both showed the phrasebook robot. All three rungs
 * go through one walk, so all three report from it now.
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

let server: Server;
let port = 0;
let state: MafiaState;

function table(): MafiaState {
  const made = createMafiaGame({ code: 'BRAIN', hostToken: 'host', hostUserId: null, now: 0 });
  for (let i = 0; i < 3; i++) addMafiaBot(made, `tok${i}`, `bot${i}`, () => 0);
  return made;
}

const hooks = {
  chat: () => ({ ok: true as const }),
  vote: () => ({ ok: true as const }),
  ballot: () => ({ ok: true as const }),
  action: () => ({ ok: true as const }),
  dayAction: () => ({ ok: true as const }),
  will: () => ({ ok: true as const }),
  whisper: () => ({ ok: true as const }),
  get: (code: string) => (code === state.code ? state : undefined),
  busy: () => undefined
};

const brains = () => Object.values(state.players).map((player) => player.botBrain ?? null);

before(async () => {
  const body = JSON.stringify({ choices: [{ message: { content: '{"line":"ok"}' } }] });
  server = createServer((request, response) => {
    let sent = '';
    request.on('data', (chunk: Buffer) => {
      sent += chunk.toString();
    });
    request.on('end', () => {
      // A refusal is asked for by name, because `env` is read once at import
      // and a rung cannot be taken away after this file has loaded the driver.
      if (sent.includes('REFUSE')) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;

  // See the note in `chain.test.ts`: blanked rather than deleted, because of dotenv.
  for (let slot = 1; slot <= 24; slot++) {
    const suffix = slot === 1 ? '' : `_${slot}`;
    for (const part of ['URL', 'KEY', 'MODEL', 'MODELS']) process.env[`MAFIA_API${suffix}_${part}`] = '';
  }
  process.env.MAFIA_BOT_PROVIDER = 'api*';
  process.env.MAFIA_API_URL = `http://127.0.0.1:${port}/quick`;
  process.env.MAFIA_API_KEY = 'test-key';
  process.env.MAFIA_API_MODEL = 'quick-model';
  process.env.MAFIA_HEDGE_MS = '0';
  process.env.GAME_TRACE = 'off';
});

after(() => {
  server.close();
});

describe('which brain the board reports', () => {
  const ask = { system: 'system', user: 'user', format: {}, maxTokens: 50 };

  it('names the model for the one seat a walk was asked about', async () => {
    const { MafiaBotDriver } = await import('./bots.js');
    state = table();
    const driver = new MafiaBotDriver(log, hooks);

    assert.deepEqual(brains(), [null, null, null], 'nothing has answered for anybody yet');
    const answer = await driver.askChain(ask, { code: state.code, botId: 'bot1' });
    assert.notEqual(answer, null, 'the endpoint answered');
    assert.deepEqual(brains(), [null, 'quick-model', null], 'and only that seat is flagged');
  });

  /**
   * The ear, the jury reader and the room reader are one call for the whole
   * table: the claims that come back are handed to every bot on the board, so
   * one answer to any of them is a model driving all of them.
   */
  it('names it for every bot when the walk was for the table', async () => {
    const { MafiaBotDriver } = await import('./bots.js');
    state = table();
    const driver = new MafiaBotDriver(log, hooks);

    await driver.askChain(ask, { code: state.code }, 'listen');
    assert.deepEqual(brains(), ['quick-model', 'quick-model', 'quick-model']);
  });

  it('says the phrasebook drove the seat when nothing answered', async () => {
    const { MafiaBotDriver } = await import('./bots.js');
    state = table();
    const driver = new MafiaBotDriver(log, hooks);

    await driver.askChain(ask, { code: state.code, botId: 'bot2' });
    assert.deepEqual(brains(), [null, null, 'quick-model']);

    const dead = new MafiaBotDriver(log, hooks);
    const answer = await dead.askChain({ ...ask, user: 'REFUSE' }, { code: state.code, botId: 'bot2' });
    assert.equal(answer, null, 'the endpoint refused');
    assert.deepEqual(brains(), [null, null, 'scripted'], 'and the seat says so');
  });

  /**
   * The asymmetry, on purpose. The ear runs on the tightest budget on the chain
   * and times out on tables whose every seat is being decided by a model
   * perfectly well; flipping the whole board to the phrasebook on that would be
   * a worse lie than the one this whole mechanism is here to fix.
   */
  it('does not flip the whole table back when a table-wide walk fails', async () => {
    const { MafiaBotDriver } = await import('./bots.js');
    state = table();
    const driver = new MafiaBotDriver(log, hooks);

    await driver.askChain(ask, { code: state.code }, 'listen');
    assert.deepEqual(brains(), ['quick-model', 'quick-model', 'quick-model']);

    const dead = new MafiaBotDriver(log, hooks);
    await dead.askChain({ ...ask, user: 'REFUSE' }, { code: state.code }, 'listen');
    assert.deepEqual(brains(), ['quick-model', 'quick-model', 'quick-model']);
  });
});
