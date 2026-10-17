// Before anything that reaches env.ts: see the file for why it must be first.
import './test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addMafiaBot, createMafiaGame, joinMafia, playerBySlot, startMafia, type MafiaState } from 'mafia-core';

import { MafiaBotDriver } from './bots.js';
import type { Decision } from './seat.js';
import { chainOver, fakeEndpoints, silentLog, slots } from './chain-fakes.js';
import type { Intent } from './mouth.js';
import { seatAlone } from './seat-fakes.js';

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

/** What the endpoint answers with next. */
let line = '';
const endpoints = slots('quick-model');
const transport = fakeEndpoints(endpoints, { answer: () => ({ line }) });

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
  const state = table();
  const self = playerBySlot(state, 2)!;
  const driver = new MafiaBotDriver(
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
  );
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

/**
 * `J6D7G`: a person in the family typed "Don't kill max". The knife moved, and
 * the Godfather's line still said "Max will get the single death tonight",
 * because the act it was handed read "you want 1 dead".
 */
describe('a house the family was asked to leave alone', () => {
  it('is left alone, and said to be left alone, by name', () => {
    const state = createMafiaGame({ code: 'FAM2', hostToken: 'h', hostUserId: null, now: 0 });
    joinMafia(state, 'Xavier', 'tok-human', 'human');
    for (let index = 0; index < 8; index++) addMafiaBot(state, `tok${index}`, `bot${index}`, () => 0.3);
    startMafia(state, 1000, () => 0.5);
    for (const player of Object.values(state.players)) player.role = 'citizen';
    const human = state.players.human;
    human.role = 'blackmailer';
    const godfather = playerBySlot(state, human.slot === 2 ? 3 : 2)!;
    godfather.role = 'godfather';
    const max = Object.values(state.players).find((player) => player.isBot && player !== godfather)!;
    max.name = 'Max';
    state.phase = 'night';
    state.stage = null;
    state.day = 3;
    state.phaseStartedAt = 100_000;
    state.phaseEndsAt = 100_000 + state.config.nightMs;
    state.chat.messages.push(
      {
        id: 70_001,
        channel: 'mafia',
        authorId: godfather.playerId,
        authorName: godfather.name,
        text: 'Max tonight.',
        at: 101_000
      } as (typeof state.chat.messages)[number],
      {
        id: 70_002,
        channel: 'mafia',
        authorId: human.playerId,
        authorName: 'Xavier',
        text: "Don't kill max",
        at: 102_000
      } as (typeof state.chat.messages)[number]
    );

    const { seat, minds } = seatAlone({ rng: () => 0.5 });
    minds.mind(state, godfather.playerId)!.named = { night: state.day, slot: max.slot };
    const knife = seat.play(state, godfather.playerId, 'night').targetSlot;
    assert.notEqual(knife, max.slot, 'the knife went where the family was asked not to');

    state.nightActions[godfather.playerId] = {
      targetId: playerBySlot(state, knife!)!.playerId
    } as (typeof state.nightActions)[string];
    const act = seat.play(state, godfather.playerId, 'night', 'mafia').intent?.act ?? '';
    assert.match(act, /leaving Max alone/, act);
    assert.doesNotMatch(act, /\bwant \d+ dead\b/, act);
  });
});
