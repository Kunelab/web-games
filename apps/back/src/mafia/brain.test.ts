// Before anything that reaches env.ts: see the file for why it must be first.
import './test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addMafiaBot, createMafiaGame, type MafiaState } from 'mafia-core';

import { MafiaBotDriver } from './bots.js';
import { chainOver, fakeEndpoints, silentLog, slots } from './chain-fakes.js';

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

/** One quick endpoint, which refuses any question that asks it to. */
const endpoints = slots('quick-model');
const driverFor = () =>
  new MafiaBotDriver(silentLog, hooks, {
    chain: chainOver(endpoints),
    transport: fakeEndpoints(endpoints, { refuses: (_model, user) => user === 'REFUSE' })
  });

describe('which brain the board reports', () => {
  const ask = { system: 'system', user: 'user', format: {}, maxTokens: 50 };

  it('names the model for the one seat a walk was asked about', async () => {
    state = table();
    const driver = driverFor();

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
    state = table();
    const driver = driverFor();

    await driver.askChain(ask, { code: state.code }, 'listen');
    assert.deepEqual(brains(), ['quick-model', 'quick-model', 'quick-model']);
  });

  it('says the phrasebook drove the seat when nothing answered', async () => {
    state = table();
    const driver = driverFor();

    await driver.askChain(ask, { code: state.code, botId: 'bot2' });
    assert.deepEqual(brains(), [null, null, 'quick-model']);

    const dead = driverFor();
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
    state = table();
    const driver = driverFor();

    await driver.askChain(ask, { code: state.code }, 'listen');
    assert.deepEqual(brains(), ['quick-model', 'quick-model', 'quick-model']);

    const dead = driverFor();
    await dead.askChain({ ...ask, user: 'REFUSE' }, { code: state.code }, 'listen');
    assert.deepEqual(brains(), ['quick-model', 'quick-model', 'quick-model']);
  });
});
