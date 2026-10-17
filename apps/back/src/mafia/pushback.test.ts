// Before anything that reaches env.ts: see the file for why it must be first.
import './test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addMafiaBot, advanceMafia, createMafiaGame, joinMafia, startMafia, type MafiaState } from 'mafia-core';

import type { Decision } from './seat.js';
import { seatAlone } from './seat-fakes.js';

/**
 * "What did I actually do?", said once per wagon and not once per turn.
 *
 * Up to one line in eight on the live tables was a bot demanding to know what
 * it had done, because every turn a seat spent under any vote at all opened
 * with it.
 */

interface Table {
  state: MafiaState;
  human: string;
  bots: string[];
  now: number;
}

function table(): Table {
  const rng = () => 0.5;
  const state = createMafiaGame({
    code: 'PUSH',
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
  for (const seat of Object.values(state.players)) seat.role = 'citizen';
  const bots = Object.values(state.players)
    .filter((seat) => seat.isBot && seat.alive)
    .map((seat) => seat.playerId);
  return { state, human: player.playerId, bots, now };
}

function says(fixture: Table, who: string, text: string): void {
  fixture.now += 2000;
  fixture.state.chat.messages.push({
    id: fixture.state.chat.messages.length + 90_000,
    channel: 'day',
    authorId: who,
    authorName: fixture.state.players[who].name,
    text,
    at: fixture.now
  } as (typeof fixture.state.chat.messages)[number]);
}

const pushesBack = (decision: Decision): boolean => decision.intent?.act.includes('push back') ?? false;

describe('a seat under a wagon', () => {
  it('pushes back once for one voter and one sentence, however many turns it gets', () => {
    const fixture = table();
    const jon = fixture.bots[0];
    fixture.state.votes[fixture.human] = jon;
    says(fixture, fixture.human, `${fixture.state.players[jon].name} you are lying`);

    const { seat } = seatAlone({ rng: () => 0.5 });
    const turns = [1, 2, 3, 4].map(() => seat.play(fixture.state, jon, 'react'));
    assert.equal(turns.filter(pushesBack).length, 1);
  });

  it('pushes back again when the person says something new to it', () => {
    const fixture = table();
    const jon = fixture.bots[0];
    const name = fixture.state.players[jon].name;
    fixture.state.votes[fixture.human] = jon;
    says(fixture, fixture.human, `${name} you are lying`);

    const { seat } = seatAlone({ rng: () => 0.5 });
    seat.play(fixture.state, jon, 'react');
    says(fixture, fixture.human, `${name} and you never said where you were`);
    assert.ok(pushesBack(seat.play(fixture.state, jon, 'react')));
  });

  /** "a few per table per day": the room hears the objection, not a chorus of it. */
  it('is one of a few seats doing it today, not all of them', () => {
    const fixture = table();
    const [first, ...rest] = fixture.bots;
    // Six seats each under one bot's vote, and nobody has said a word to any of them.
    const under = fixture.bots.slice(0, 6);
    under.forEach((bot, index) => {
      fixture.state.votes[rest[index + 3] ?? first] = bot;
    });

    const { seat } = seatAlone({ rng: () => 0.5 });
    const pushed = under.map((bot) => seat.play(fixture.state, bot, 'react')).filter(pushesBack);
    assert.ok(pushed.length > 0, 'nobody objected at all');
    assert.ok(pushed.length <= 3, `${pushed.length} seats pushed back`);
  });
});
