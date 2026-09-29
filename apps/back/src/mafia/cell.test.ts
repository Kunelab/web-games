import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import type { FastifyBaseLogger } from 'fastify';
import {
  addMafiaBot,
  createMafiaGame,
  jailChannel,
  joinMafia,
  playerBySlot,
  sayInChat,
  startMafia,
  type MafiaState
} from 'mafia-core';

import type { Decision } from './bots.js';
import type { Intent } from './mouth.js';

/**
 * A bot in somebody's cell must not be handed the keeper's name.
 *
 * Read off a real table: a person holding the Ravisseur's keys said "Hello" into
 * the cellar, and the bot sitting in it answered "La B1te?", the keeper's own
 * nickname. The phone already showed that line with no face; the prompt was
 * built from the raw log and carried the byline anyway, and the room ear filed
 * "I am the jailor" on the captive's board under the keeper's house.
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

type Driver = {
  write(
    state: MafiaState,
    botId: string,
    decision: Decision,
    room: string,
    intent: Intent,
    self: unknown
  ): Promise<Decision>;
  answering(state: MafiaState, botId: string, room: string): { who: string; text: string }[];
  stop(): void;
};

let server: Server;
let port = 0;
/** Every prompt the endpoint was sent. */
const prompts: string[] = [];

before(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      prompts.push(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ line: 'Doctor.' }) } }] }));
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

const KEEPER = 'Keyholder';

/** A person on slot 1 holding the keys, a bot on slot 3 in the cell, at night. */
function table(): { state: MafiaState; cell: string; prisonerId: string } {
  const state = createMafiaGame({ code: 'CELL', hostToken: 'h', hostUserId: null, now: 0 });
  let seed = 11;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  joinMafia(state, KEEPER, 'tok-human', 'human');
  for (let index = 0; index < 8; index++) addMafiaBot(state, `tok${index}`, `bot${index}`, rng);
  startMafia(state, 1000, rng);
  for (const player of Object.values(state.players)) player.role = 'citizen';
  const keeper = playerBySlot(state, 1)!;
  const prisoner = playerBySlot(state, 3)!;
  keeper.role = 'kidnapper';
  prisoner.role = 'doctor';
  state.phase = 'night';
  state.stage = null;
  state.day = 2;
  state.phaseStartedAt = 0;
  state.phaseEndsAt = Date.now() + 60_000;
  state.captives = { [keeper.playerId]: prisoner.playerId };

  const cell = jailChannel(state.day, keeper.playerId);
  assert.equal(sayInChat(state, keeper.playerId, cell, 'Hello', 10).ok, true);
  assert.equal(sayInChat(state, keeper.playerId, cell, 'I am the jailor, who are you?', 20).ok, true);
  return { state, cell, prisonerId: prisoner.playerId };
}

async function driverFor(state: MafiaState): Promise<Driver> {
  const { MafiaBotDriver } = await import('./bots.js');
  return new MafiaBotDriver(log, {
    chat: () => ({ ok: true as const }),
    vote: () => ({ ok: true as const }),
    ballot: () => ({ ok: true as const }),
    action: () => ({ ok: true as const }),
    dayAction: () => ({ ok: true as const }),
    will: () => ({ ok: true as const }),
    whisper: () => ({ ok: true as const }),
    busy: () => undefined,
    get: () => state
  }) as unknown as Driver;
}

describe('the voice through the cell door', () => {
  it('is answered without a name', async () => {
    const { state, cell, prisonerId } = table();
    const driver = await driverFor(state);
    const heard = driver.answering(state, prisonerId, cell);
    driver.stop();

    assert.ok(heard.length > 0, 'the prisoner still hears the question');
    assert.ok(heard.every((line) => line.who !== KEEPER));
  });

  it('never reaches the model with the keeper named', async () => {
    const { state, cell, prisonerId } = table();
    const driver = await driverFor(state);
    const intent: Intent = {
      act: 'answer the other voice in the cell, where only the two of you can hear',
      mood: 'blunt',
      fallback: 'Doctor.',
      answering: driver.answering(state, prisonerId, cell)
    };
    const decision: Decision = { say: null, targetSlot: null, verdict: null, claim: null };
    prompts.length = 0;
    await driver.write(state, prisonerId, decision, cell, intent, state.players[prisonerId]);
    driver.stop();

    assert.ok(prompts.length > 0, 'the mouth was asked');
    assert.ok(prompts.every((body) => !body.includes(KEEPER)));
    assert.ok(prompts.some((body) => body.includes('I am the jailor')), 'the words themselves still arrive');
  });
});
