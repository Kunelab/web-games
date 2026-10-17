// Before anything that reaches env.ts: see the file for why it must be first.
import './test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addMafiaBot,
  advanceMafia,
  createMafiaGame,
  joinMafia,
  sayInChat,
  startMafia,
  type MafiaState
} from 'mafia-core';

import { mouthPrompt, readLine } from './mouth.js';
import { seatAlone } from './seat-fakes.js';

/**
 * Who a person's line is handed to as "this was just said to you".
 *
 * Every case is a line from `9RVWV`, where the answer used to be "every seat
 * that spoke next": ten replies in one game to sentences that were never aimed
 * at the seat replying.
 */

interface Table {
  state: MafiaState;
  human: string;
  aragorn: string;
  jon: string;
  jack: string;
  now: number;
}

function table(): Table {
  const rng = () => 0.5;
  const state = createMafiaGame({
    code: 'TEST',
    hostToken: 'h',
    hostUserId: null,
    config: { dayMs: 90_000, nightMs: 40_000, defenseMs: 20_000, judgementMs: 15_000, aftermathMs: 5_000 },
    now: 0
  });
  const { player } = joinMafia(state, 'Max', 'token', 'uuid');
  for (let index = 0; index < 8; index++) {
    addMafiaBot(state, `t${index}`, `bot-${index}`, (max) => Math.floor(rng() * max));
  }
  startMafia(state, 1000, rng);
  let now = 2000;
  for (let step = 0; step < 400 && (state.day < 2 || state.phase !== 'day' || state.stage !== 'discussion'); step++) {
    now += 5000;
    advanceMafia(state, now, rng);
  }
  const bots = Object.values(state.players).filter((seat) => seat.isBot && seat.alive);
  const [aragorn, jon, jack] = bots;
  aragorn.name = 'Aragorn';
  jon.name = 'Jon Snow';
  jack.name = 'Jack Torrance';
  return { state, human: player.playerId, aragorn: aragorn.playerId, jon: jon.playerId, jack: jack.playerId, now };
}

function says(fixture: Table, who: string, text: string, after = 2000): void {
  fixture.now += after;
  const result = sayInChat(fixture.state, who, 'day', text, fixture.now);
  assert.ok(result.ok, `the engine refused the line: ${JSON.stringify(result)}`);
}

const heard = (fixture: Table, botId: string): string[] =>
  seatAlone()
    .seat.answering(fixture.state, botId, 'day')
    .map((line) => line.text);

describe('a line in the square is said to somebody', () => {
  it('reaches the seat it names, misspelt, and nobody else', () => {
    const fixture = table();
    says(fixture, fixture.human, 'Aragon I was mason with you before turning into a citizen');

    assert.deepEqual(heard(fixture, fixture.aragorn), ['Aragon I was mason with you before turning into a citizen']);
    assert.deepEqual(heard(fixture, fixture.jon), []);
    assert.deepEqual(heard(fixture, fixture.jack), []);
  });

  /**
   * Plan 1.2: the seat woken by a question answers that question, not the
   * newest thing a person said by the time its turn comes round.
   */
  it('is answered by the seat it woke, even after the person has turned to somebody else', () => {
    const fixture = table();
    says(fixture, fixture.human, 'Jon Snow, where were you last night?');
    says(fixture, fixture.human, 'Aragorn you are lying', 1500);

    const { seat } = seatAlone({ rng: () => 0.5 });
    const reply = seat.play(fixture.state, fixture.jon, 'react');
    for (const line of reply.intent?.answering ?? []) assert.doesNotMatch(line.text, /Aragorn/);
    assert.deepEqual(heard(fixture, fixture.jon), ['Jon Snow, where were you last night?']);
  });

  it('is said to the room when it names nobody', () => {
    const fixture = table();
    says(fixture, fixture.human, 'I got converted to citizen');

    for (const bot of [fixture.aragorn, fixture.jon, fixture.jack]) assert.deepEqual(heard(fixture, bot), []);
  });

  it('answers the seat that just spoke, and only that one', () => {
    const fixture = table();
    says(fixture, fixture.jon, 'Masons do not talk, so why start now?');
    says(fixture, fixture.human, 'why do you say that?', 5000);

    assert.deepEqual(heard(fixture, fixture.jon), ['why do you say that?']);
    assert.deepEqual(heard(fixture, fixture.jack), []);
  });

  it('is not a reply once the moment has passed', () => {
    const fixture = table();
    says(fixture, fixture.jon, 'Masons do not talk, so why start now?');
    says(fixture, fixture.human, 'why do you say that?', 60_000);

    assert.deepEqual(heard(fixture, fixture.jon), []);
  });

  it('belongs to the trial it was typed during, not the next one', () => {
    const fixture = table();
    const { state } = fixture;
    state.stage = 'judgement';
    state.trial = { accusedId: fixture.jack, ballots: {}, openedAt: fixture.now };
    says(fixture, fixture.human, 'who else did you jail ?');
    assert.deepEqual(heard(fixture, fixture.jack), ['who else did you jail ?']);

    // The same afternoon, a different seat on the stand.
    state.trial = { accusedId: fixture.jon, ballots: {}, openedAt: fixture.now + 1000 };
    fixture.now += 2000;
    assert.deepEqual(heard(fixture, fixture.jon), []);
  });

  it('still hands everything over in a cell, where there is nobody else to say it to', () => {
    const fixture = table();
    const { state } = fixture;
    const room = 'jail:2:abcdef';
    state.chat.messages.push({
      id: state.chat.messages.length + 1,
      channel: room,
      authorId: fixture.human,
      authorName: 'Max',
      text: 'Hello',
      at: fixture.now + 1000
    } as (typeof state.chat.messages)[number]);

    assert.deepEqual(
      seatAlone()
        .seat.answering(state, fixture.jack, room)
        .map((line) => line.text),
      ['Hello']
    );
  });
});

describe('what the mouth is told and allowed', () => {
  const intent = { act: 'push back at Hulk', mood: 'dry', fallback: 'Hulk, what did I do?' };

  it('is told to answer a question before anything else', () => {
    const asked = mouthPrompt(
      { name: 'Minnie', slot: 4 },
      { ...intent, answering: [{ who: 'Keeper', text: 'Minie what is your role?' }] },
      []
    );
    assert.match(asked, /They asked you something/);
    const told = mouthPrompt(
      { name: 'Minnie', slot: 4 },
      { ...intent, answering: [{ who: 'Keeper', text: 'I vote 4' }] },
      []
    );
    assert.doesNotMatch(told, /They asked you something/);
  });

  it('trades an insult for the phrasebook line', () => {
    const self = { name: 'Hulk', slot: 12 };
    assert.equal(
      readLine({ line: "Max, you're the only one who'd ask that stupid question." }, intent, self),
      intent.fallback
    );
    assert.equal(
      readLine({ line: 'Max, that question again? Bold.' }, intent, self),
      'Max, that question again? Bold.'
    );
  });

  it('trades narration for the phrasebook line', () => {
    const self = { name: 'Rukia', slot: 11 };
    assert.equal(
      readLine({ line: "Cell, 11: whispers I'm the one who follows orders" }, intent, self),
      intent.fallback
    );
    assert.equal(readLine({ line: 'leans back, sips imaginary drink' }, intent, self), intent.fallback);
  });
});
