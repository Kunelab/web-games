import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import type { FastifyBaseLogger } from 'fastify';
import { addMafiaBot, createMafiaGame, joinMafia, playerBySlot, startMafia, type MafiaState } from 'mafia-core';

import type { Decision } from './bots.js';
import type { Intent } from './mouth.js';

/**
 * What a family is allowed to say to itself.
 *
 * `confesses` exists because a model handed an intention will sometimes answer
 * with a *different* one, and a self-claimed killer is the heaviest term in the
 * ranking — so a line that owns a deed nobody decided on is thrown away. It ran
 * in every room, including the one room on the board where owning the deed is
 * the entire reason for opening your mouth.
 *
 * The exception is exactly as wide as the danger. A Spy in the roster with none
 * confirmed dead makes the room `hushed` upstream (`spyMayListen`), and there
 * the guard stays on: `leaks` scrubs names, houses and roles, and "I will kill
 * him tonight" carries none of the three.
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

type Writer = {
  write(
    state: MafiaState,
    botId: string,
    decision: Decision,
    room: string,
    intent: Intent,
    self: unknown
  ): Promise<Decision>;
};

let server: Server;
let port = 0;
/** What the endpoint answers with next. */
let line = '';

before(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ line }) } }] }));
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

/** A table with a mafioso on slot 2, sitting in its own family room on day 2. */
function table(): MafiaState {
  const state = createMafiaGame({ code: 'FAM', hostToken: 'h', hostUserId: null, now: 0 });
  let seed = 7;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  joinMafia(state, 'Humain', 'tok-human', 'human');
  for (let index = 0; index < 8; index++) addMafiaBot(state, `tok${index}`, `bot${index}`, rng);
  startMafia(state, 1000, rng);
  state.phase = 'day';
  state.stage = 'discussion';
  state.day = 2;
  for (const player of Object.values(state.players)) player.role = 'citizen';
  playerBySlot(state, 2)!.role = 'mafioso';
  return state;
}

const FALLBACK = 'Tonight: 7, he is the loudest one left.';
const PLAN = "I'll kill 7 tonight.";

async function saidIn(room: string, hushed: boolean): Promise<string | null> {
  const { MafiaBotDriver } = await import('./bots.js');
  const state = table();
  const self = playerBySlot(state, 2)!;
  const driver = new MafiaBotDriver(log, {
    chat: () => ({ ok: true as const }),
    vote: () => ({ ok: true as const }),
    ballot: () => ({ ok: true as const }),
    action: () => ({ ok: true as const }),
    dayAction: () => ({ ok: true as const }),
    will: () => ({ ok: true as const }),
    whisper: () => ({ ok: true as const }),
    busy: () => undefined,
    get: () => state
  });
  const intent: Intent = {
    act: 'tell your own family what you want done tonight',
    mood: 'blunt',
    fallback: FALLBACK,
    ...(hushed ? { hushed: true } : {})
  };
  const decision: Decision = { say: null, targetSlot: null, verdict: null, claim: null };
  line = PLAN;
  const out = await (driver as unknown as Writer).write(state, self.playerId, decision, room, intent, self);
  driver.stop();
  return out.say;
}

describe('a plan said in the family room', () => {
  it('is said, when no Spy can be listening', async () => {
    assert.equal(await saidIn('mafia', false), PLAN);
  });

  /**
   * The same sentence, one room over. In the square it is a confession of a
   * murder nobody decided on, which is the thing `confesses` was written for.
   */
  it('is thrown away in the square', async () => {
    assert.equal(await saidIn('day', false), FALLBACK);
  });

  it('is thrown away in the family room a Spy may be sitting in', async () => {
    assert.equal(await saidIn('mafia', true), FALLBACK);
  });

  /** And a seat has no licence in somebody else's family room. */
  it('is thrown away in a family room that is not this seat own', async () => {
    assert.equal(await saidIn('triad', false), FALLBACK);
  });
});
