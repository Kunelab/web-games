// Before anything that reaches env.ts: see the file for why it must be first.
import './test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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

import { MafiaBotDriver } from './bots.js';
import type { Decision } from './seat.js';
import { chainOver, fakeEndpoints, silentLog, slots } from './chain-fakes.js';
import { seatAlone } from './seat-fakes.js';
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

type Driver = {
  write(
    state: MafiaState,
    botId: string,
    decision: Decision,
    room: string,
    intent: Intent,
    self: unknown
  ): Promise<Decision>;
  stop(): void;
};

/** One quick endpoint that always answers "Doctor.", keeping every prompt it was sent. */
const endpoints = slots('quick-model');
const transport = fakeEndpoints(endpoints, { answer: () => ({ line: 'Doctor.' }) });

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

function driverFor(state: MafiaState): Driver {
  return new MafiaBotDriver(
    silentLog,
    {
      chat: () => ({ ok: true as const }),
      vote: () => ({ ok: true as const }),
      ballot: () => ({ ok: true as const }),
      action: () => ({ ok: true as const }),
      dayAction: () => ({ ok: true as const }),
      will: () => ({ ok: true as const }),
      whisper: () => ({ ok: true as const }),
      busy: () => undefined,
      get: () => state
    },
    { chain: chainOver(endpoints), transport }
  ) as unknown as Driver;
}

describe('the voice through the cell door', () => {
  it('is answered without a name', () => {
    const { state, cell, prisonerId } = table();
    const heard = seatAlone().seat.answering(state, prisonerId, cell);

    assert.ok(heard.length > 0, 'the prisoner still hears the question');
    assert.ok(heard.every((line) => line.who !== KEEPER));
  });

  it('never reaches the model with the keeper named', async () => {
    const { state, cell, prisonerId } = table();
    const driver = driverFor(state);
    const intent: Intent = {
      act: 'answer the other voice in the cell, where only the two of you can hear',
      mood: 'blunt',
      fallback: 'Doctor.',
      answering: seatAlone().seat.answering(state, prisonerId, cell)
    };
    const decision: Decision = { say: null, targetSlot: null, verdict: null, claim: null };
    transport.sent.length = 0;
    await driver.write(state, prisonerId, decision, cell, intent, state.players[prisonerId]);
    driver.stop();

    // Every prompt the endpoint was sent, whole.
    const prompts = transport.sent.map((one) => one.system + one.user);
    assert.ok(prompts.length > 0, 'the mouth was asked');
    assert.ok(prompts.every((body) => !body.includes(KEEPER)));
    assert.ok(prompts.some((body) => body.includes('I am the jailor')), 'the words themselves still arrive');
  });
});
