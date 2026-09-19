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
import type { ChatMessage } from 'chat-core';
import type { FastifyBaseLogger } from 'fastify';

import { MafiaBotDriver } from './bots.js';

/**
 * What the table does with a sentence somebody typed.
 *
 * The parser half of this is unit-tested in `square.test.ts`; what is tested
 * here is the wiring, which is where it went wrong before: a reader that files
 * perfect claims into a board nothing re-reads, or a seat that is woken and then
 * refused the floor, looks exactly like a table that cannot read.
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

interface Table {
  state: MafiaState;
  driver: MafiaBotDriver;
  said: { botId: string; channel: string; text: string }[];
  human: string;
}

/** A table mid-game: one person, eight bots, day two, arguing. */
function table(): Table {
  const rng = () => 0.5;
  const state = createMafiaGame({
    code: 'TEST',
    hostToken: 'h',
    hostUserId: null,
    config: { dayMs: 90_000, nightMs: 40_000, defenseMs: 20_000, judgementMs: 15_000, aftermathMs: 5_000 },
    now: 0
  });

  const { player } = joinMafia(state, 'Human', 'token', 'uuid');
  for (let index = 0; index < 8; index++) {
    addMafiaBot(state, `t${index}`, `bot-${index}`, (max) => Math.floor(rng() * max));
  }
  startMafia(state, 1000, rng);

  // Forward to a day with something to argue about.
  let now = 2000;
  for (let step = 0; step < 400 && (state.day < 2 || state.phase !== 'day' || state.stage !== 'discussion'); step++) {
    now += 5000;
    advanceMafia(state, now, rng);
  }

  const said: Table['said'] = [];
  const driver = new MafiaBotDriver(log, {
    chat: (_code, botId, channel, text) => {
      said.push({ botId, channel, text });
      return { ok: true };
    },
    vote: () => ({ ok: true }),
    ballot: () => ({ ok: true }),
    action: () => ({ ok: true }),
    dayAction: () => ({ ok: true }),
    will: () => ({ ok: true }),
    whisper: () => ({ ok: true }),
    busy: () => undefined,
    get: () => state
  });

  return { state, driver, said, human: player.playerId };
}

/** Says something as the person, the way the manager does. */
function types(fixture: Table, text: string): ChatMessage {
  const result = sayInChat(fixture.state, fixture.human, 'day', text, Date.now());
  assert.ok(result.ok, `the engine refused the line: ${JSON.stringify(result)}`);
  fixture.driver.onChat(fixture.state, result.message);
  return result.message;
}

describe('a person says something in a private room', () => {
  /**
   * The Triad and the Cult were mute for the whole game.
   *
   * `onChange` posts each family's plan in its own room and `answerPrivately`
   * prefers the seat holding the knife in any of the three, and then the line
   * reached `sayChannelFor`, which whitelisted `mafia` alone, got null back and
   * was dropped. A person typing into a room of three silent triad soldiers is
   * the one thing this driver exists to prevent.
   */
  for (const family of [
    { room: 'triad', role: 'enforcer' },
    { room: 'cult', role: 'cultist' }
  ] as const) {
    it(`gets an answer in the ${family.room}'s room`, async () => {
      const fixture = table();

      // A person and a bot in the same family, at night, where that room is live.
      const bot = Object.values(fixture.state.players).find((player) => player.isBot && player.alive);
      assert.ok(bot);
      fixture.state.players[fixture.human].role = family.role;
      bot.role = family.role;
      fixture.state.phase = 'night';
      fixture.state.stage = null;
      fixture.state.phaseEndsAt = Date.now() + 40_000;

      const result = sayInChat(fixture.state, fixture.human, family.room, 'take 4 tonight', Date.now());
      assert.ok(result.ok, `the engine refused the line: ${JSON.stringify(result)}`);
      fixture.driver.onChat(fixture.state, result.message);

      await new Promise((resolve) => setTimeout(resolve, 4000));
      assert.ok(
        fixture.said.some((line) => line.channel === family.room),
        `nothing was said in the ${family.room}'s room: ${JSON.stringify(fixture.said)}`
      );
      fixture.driver.stop();
    });
  }
});

describe('a person says something', () => {
  it('reaches the board before anything is awaited', () => {
    const fixture = table();
    const target = Object.values(fixture.state.players).find((player) => player.isBot && player.alive);
    assert.ok(target);

    types(fixture, `${target.slot}, where were you last night?`);

    // Synchronously: no timer has run and no model exists, and the claim is
    // already filed. This is the whole point of the deterministic reader.
    const filed = fixture.driver.ledger('TEST');
    const question = filed.find((claim) => claim.kind === 'question' && claim.targetSlot === target.slot);
    assert.ok(question, `nothing filed: ${JSON.stringify(filed)}`);
    assert.equal(question.claimerSlot, fixture.state.players[fixture.human].slot);
    fixture.driver.stop();
  });

  it('reads five short lines as five readings, not one', () => {
    const fixture = table();
    const bots = Object.values(fixture.state.players).filter((player) => player.isBot && player.alive);
    const [one, two] = bots;

    types(fixture, 'i stayed home');
    types(fixture, `${one.slot} is mafia`);
    types(fixture, 'i am the sheriff');
    types(fixture, `not ${two.slot}`);
    types(fixture, `${one.slot}?`);

    const kinds = fixture.driver.ledger('TEST').map((claim) => claim.kind);
    assert.ok(kinds.includes('account'), `no alibi: ${kinds.join()}`);
    assert.ok(kinds.includes('accuse'), `no accusation: ${kinds.join()}`);
    assert.ok(kinds.includes('role-claim'), `no role claim: ${kinds.join()}`);
    assert.ok(kinds.includes('clear'), `no reprieve: ${kinds.join()}`);
    fixture.driver.stop();
  });

  it('gets an answer from the seat it named', async () => {
    const fixture = table();
    const target = Object.values(fixture.state.players).find((player) => player.isBot && player.alive);
    assert.ok(target);

    types(fixture, `${target.slot}, where were you last night?`);
    await new Promise((resolve) => setTimeout(resolve, 3200));

    assert.ok(fixture.said.length > 0, 'the table said nothing at all');
    assert.ok(
      fixture.said.some((line) => line.botId === target.playerId),
      `the seat that was asked never answered: ${JSON.stringify(fixture.said)}`
    );
    fixture.driver.stop();
  });
});

/**
 * What a read line actually carries onto the board.
 *
 * The instant reader forwarded three fields and produced six. For the three it
 * dropped, the field *is* the claim: an `urge` with nothing on it is read by
 * `steadyVote` as `claim.urge === 'vote' ? 1 : -1`, so a person asking the room
 * to vote was counted, at their own credibility, as asking for the day off.
 *
 * And it could not be repaired afterwards. `record` keys a claim by claimer,
 * target, kind, day and room, so the hollow entry filed here was exactly what
 * the ear's own correct reading was then swallowed as a duplicate of.
 */
describe('a read line keeps what it was read as', () => {
  it('carries which way an urge was pushing', () => {
    const fixture = table();
    types(fixture, 'we need to vote today, no more skipping');

    const urge = fixture.driver.ledger('TEST').find((claim) => claim.kind === 'urge');
    assert.ok(urge, 'the push on the clock never reached the board');
    assert.equal(urge.urge, 'vote', 'a call to vote was filed as a call to skip');
    fixture.driver.stop();
  });

  it('carries the other direction too', () => {
    const fixture = table();
    types(fixture, "let's skip today, there is nothing here");

    const urge = fixture.driver.ledger('TEST').find((claim) => claim.kind === 'urge');
    assert.ok(urge, 'the push on the clock never reached the board');
    assert.equal(urge.urge, 'skip');
    fixture.driver.stop();
  });

  it('carries what a promise was a promise of', () => {
    const fixture = table();
    types(fixture, 'spare me and I will prove it tonight, I mean it');

    const bet = fixture.driver.ledger('TEST').find((claim) => claim.kind === 'promise');
    assert.ok(bet, 'the bet never reached the board');
    assert.equal(bet.promise, 'night', 'a promise with nothing promised is never settled by dawn');
    fixture.driver.stop();
  });

  it('carries which badge a counter-claim denies', () => {
    const fixture = table();
    const target = Object.values(fixture.state.players).find((player) => player.isBot && player.alive);
    assert.ok(target);

    types(fixture, `${target.slot} can't be the doctor`);

    const denial = fixture.driver.ledger('TEST').find((claim) => claim.kind === 'counter-claim');
    assert.ok(denial, 'the denial never reached the board');
    assert.equal(denial.deniedRole, 'doctor', 'a denial with no badge on it is weighed as nothing');
    fixture.driver.stop();
  });
});
