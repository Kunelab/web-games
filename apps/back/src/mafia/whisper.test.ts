// Before anything that reaches env.ts: see the file for why it must be first.
import './test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addMafiaBot, advanceMafia, createMafiaGame, joinMafia, startMafia, type MafiaState } from 'mafia-core';

import { seatAlone } from './seat-fakes.js';

/**
 * Asides: what a seat says to one person, and what it says when asked what it is.
 *
 * Ten live games had three revealed sashes alive for a day or more and not a
 * single whisper, because the silent re-vote turns chose the aside and then
 * threw it away. And a bot asked its role anywhere but on the stand never once
 * said it.
 */

function table(): { state: MafiaState; human: string; now: number } {
  const rng = () => 0.5;
  const state = createMafiaGame({
    code: 'WSP',
    hostToken: 'h',
    hostUserId: null,
    config: { dayMs: 90_000, nightMs: 40_000, defenseMs: 20_000, judgementMs: 15_000, aftermathMs: 5_000 },
    now: 0
  });
  const { player } = joinMafia(state, 'Max', 'token', 'uuid');
  for (let index = 0; index < 10; index++) {
    addMafiaBot(state, `t${index}`, `bot-${index}`, (max) => Math.floor(rng() * max));
  }
  startMafia(state, 1000, rng);
  let now = 2000;
  for (let step = 0; step < 400 && (state.day < 3 || state.phase !== 'day' || state.stage !== 'discussion'); step++) {
    now += 5000;
    advanceMafia(state, now, rng);
  }
  return { state, human: player.playerId, now };
}

describe('an aside to the sash', () => {
  it('survives a silent re-vote', () => {
    const { state } = table();
    const bots = Object.values(state.players).filter((player) => player.isBot && player.alive);
    const [mayor, ...rest] = bots;
    mayor.role = 'mayor';
    mayor.revealed = true;
    for (const bot of rest) bot.role = 'doctor';

    const { seat } = seatAlone({ rng: () => 0.1 });
    const whispered = rest.map((bot) => seat.play(state, bot.playerId, 'revote').whisper).filter(Boolean);
    assert.ok(whispered.length > 0, 'no re-vote carried its aside');
    assert.ok(whispered.every((aside) => aside?.toSlot === mayor.slot && aside.role === 'doctor'));
  });

  it('is never the truth from a Jester', () => {
    const { state } = table();
    const bots = Object.values(state.players).filter((player) => player.isBot && player.alive);
    const [mayor, jester] = bots;
    mayor.role = 'mayor';
    mayor.revealed = true;
    jester.role = 'jester';

    const { seat } = seatAlone({ rng: () => 0.1 });
    for (let turn = 0; turn < 5; turn++) {
      assert.notEqual(seat.play(state, jester.playerId, 'day').whisper?.role, 'jester');
    }
  });
});

describe('asked its role outside the stand', () => {
  interface Setup {
    room: 'day' | 'pm';
    /** Seats voting for the one being asked, besides the asker. */
    voters?: number;
    /** What the asker has done to the seat it asks. */
    asker?: 'votes it' | 'vouched for it';
  }

  /** Every bot at a table of citizens asked the same question by the person; how many say a role. */
  function answered(text: string, setup: Setup): { said: number; asked: number } {
    const fixture = table();
    const { state } = fixture;
    const bots = Object.values(state.players).filter((player) => player.isBot && player.alive);
    for (const bot of bots) bot.role = 'citizen';
    const { seat, minds } = seatAlone({ rng: () => 0.5 });
    let said = 0;
    for (const [index, bot] of bots.entries()) {
      for (const voter of bots.filter((other) => other !== bot).slice(0, setup.voters ?? 0)) {
        state.votes[voter.playerId] = bot.playerId;
      }
      if (setup.asker === 'votes it') state.votes[fixture.human] = bot.playerId;
      if (setup.asker === 'vouched for it') minds.record(state, fixture.human, 'clear', bot.slot);
      const channel = setup.room === 'pm' ? `pm:${[fixture.human, bot.playerId].sort().join(':')}` : 'day';
      state.chat.messages.push({
        id: 50_000 + index,
        channel,
        authorId: fixture.human,
        authorName: 'Max',
        text: `${bot.name} ${text}`,
        at: fixture.now + index
      } as (typeof state.chat.messages)[number]);
      const decision =
        setup.room === 'pm'
          ? seat.play(state, bot.playerId, 'night', channel)
          : seat.play(state, bot.playerId, 'react');
      const named =
        setup.room === 'pm'
          ? decision.intent?.act.includes('tell them you are')
          : decision.claim?.kind === 'role-claim';
      if (named) said++;
      state.votes = {};
    }
    return { said, asked: bots.length };
  }

  /** The same setup asked thirty different ways, so each answer is its own roll. */
  function rate(setup: Setup): number {
    let said = 0;
    let asked = 0;
    for (let ask = 1; ask <= 30; ask++) {
      const result = answered(`your role${'?'.repeat(ask)}`, setup);
      said += result.said;
      asked += result.asked;
    }
    return said / asked;
  }

  /** Sentences with "who are you" or "claim" in them that are not asking what the seat is. */
  it('does not hear a role question in a sentence that is not one', () => {
    let said = 0;
    for (const text of [
      'who are you voting for?',
      'who are you going to vote',
      'your claim is fake',
      'that claim makes no sense',
      'who are you accusing now?',
      'claim all you want, I vote you'
    ]) {
      said += answered(text, { room: 'pm' }).said + answered(text, { room: 'day' }).said;
    }
    assert.equal(said, 0);
  });

  // The odds asked for: 15% in the square, 15 more with two votes on the seat, 30% in a whisper.
  it('answers about one time in seven in the square', () => {
    const square = rate({ room: 'day' });
    assert.ok(square >= 0.08 && square <= 0.22, `square ${square.toFixed(2)}`);
  });

  it('answers about twice as often with two votes on it', () => {
    const pressed = rate({ room: 'day', voters: 2 });
    assert.ok(pressed >= 0.2 && pressed <= 0.4, `under two votes ${pressed.toFixed(2)}`);
  });

  it('is not pressed by a single vote', () => {
    const one = rate({ room: 'day', voters: 1 });
    assert.ok(one <= 0.22, `under one vote ${one.toFixed(2)}`);
  });

  it('answers about one time in three in a whisper', () => {
    const whisper = rate({ room: 'pm' });
    assert.ok(whisper >= 0.2 && whisper <= 0.4, `whisper ${whisper.toFixed(2)}`);
  });

  /** And who is asking: a seat tells the person it trusts, and keeps it from the one hunting it. */
  it('tells somebody voting for it less, and somebody who vouched for it more', () => {
    const hostile = rate({ room: 'pm', asker: 'votes it' });
    const neutral = rate({ room: 'pm' });
    const friendly = rate({ room: 'pm', asker: 'vouched for it' });
    assert.ok(hostile < neutral, `hostile ${hostile.toFixed(2)}, neutral ${neutral.toFixed(2)}`);
    assert.ok(friendly > neutral, `friendly ${friendly.toFixed(2)}, neutral ${neutral.toFixed(2)}`);
  });
});
