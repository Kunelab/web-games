import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FastifyBaseLogger } from 'fastify';

import { MafiaBotDriver, type Decision } from './bots.js';

import { addMafiaBot, createMafiaGame, joinMafia, playerBySlot, SKIP_VOTE, startMafia, type MafiaState } from 'mafia-core';

/**
 * The ballot a seat casts, against the one it decided on.
 *
 * A day turn under the policy mind is split in two: the move lands at once and
 * the sentence follows when a model has written it. The vote was then pulled
 * out of the first half as well, so the room hears the argument before the
 * tally moves — and pulling it out has to mean *not voting yet* rather than
 * voting something else.
 *
 * The first attempt at it blanked `targetSlot` and `skipVote` on the way in,
 * which made a seat that had decided to accuse look exactly like a seat with
 * nothing to say. There is a branch for that seat: it joins a skip the room has
 * already opened. So the bot voted to hang nobody, and then changed to its real
 * accusation a few seconds later when the mouth came back — two ballots on the
 * record, one of which it never decided, and a skip that counts towards ending
 * the afternoon.
 *
 * Tested at the seam rather than through a game, because the fault was one
 * argument wide and every other route to it runs through a model, a scheduler
 * and a policy that is allowed to change its mind.
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

/** The private half of the driver, which is what the contract lives on. */
type Applier = {
  apply(
    state: MafiaState,
    botId: string,
    task: string,
    channel: string,
    decision: Decision,
    part?: 'all' | 'act' | 'speak',
    reserved?: boolean,
    castBallot?: boolean
  ): void;
};

function table(): { state: MafiaState; cast: (number | 'skip' | null)[]; driver: MafiaBotDriver } {
  const state = createMafiaGame({ code: 'BAL', hostToken: 'h', hostUserId: null, now: 0 });
  let seed = 11;
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
  state.votes = {};

  const cast: (number | 'skip' | null)[] = [];
  const driver = new MafiaBotDriver(log, {
    chat: () => ({ ok: true }),
    vote: (_code, _botId, target) => {
      cast.push(target);
      return { ok: true };
    },
    ballot: () => ({ ok: true }),
    action: () => ({ ok: true }),
    dayAction: () => ({ ok: true }),
    will: () => ({ ok: true }),
    whisper: () => ({ ok: true }),
    busy: () => undefined,
    get: () => state
  });
  return { state, cast, driver };
}

const accusing = (slot: number): Decision => ({ say: null, targetSlot: slot, verdict: null, claim: null });

describe('a ballot held back for the sentence', () => {
  it('casts nothing at all, even with a skip open', () => {
    const { state, cast, driver } = table();
    const speaker = playerBySlot(state, 2)!;

    /**
     * The precondition, which is ordinary: somebody has opened a skip, and this
     * seat has no ballot standing yet because it is its first turn of the day.
     */
    state.votes[playerBySlot(state, 3)!.playerId] = SKIP_VOTE;

    (driver as unknown as Applier).apply(state, speaker.playerId, 'day', 'day', accusing(5), 'act', false, false);

    assert.deepEqual(cast, [], 'a held ballot is not a shrug, and must not be read as one');
    driver.stop();
  });

  it('casts the seat own decision when it is not held', () => {
    const { state, cast, driver } = table();
    const speaker = playerBySlot(state, 2)!;
    state.votes[playerBySlot(state, 3)!.playerId] = SKIP_VOTE;

    (driver as unknown as Applier).apply(state, speaker.playerId, 'day', 'day', accusing(5), 'act', false, true);

    assert.deepEqual(cast, [5], 'and when it is not held, it is the accusation the brain decided');
    driver.stop();
  });

  /**
   * A question that has already been answered is not a question.
   *
   * The first seat to shrug asks the room for anything at all before the day is
   * thrown away, and it used to ask and vote in the same breath, with the rest
   * joining within seconds. On a live table that closed every afternoon at
   * about 40% of its clock — before the ear had read a single will, which is
   * why ten days in a row produced no accusation at all and no trial.
   *
   * So a skip waits while the question is open. Only a skip: an accusation is
   * somebody answering it.
   */
  it('holds every skip while the room is waiting on an answer', () => {
    const { state, cast, driver } = table();
    const speaker = playerBySlot(state, 2)!;
    const other = playerBySlot(state, 4)!;
    state.votes[playerBySlot(state, 3)!.playerId] = SKIP_VOTE;

    const waiting = driver as unknown as Applier & { clueCall: Map<string, number> };
    waiting.clueCall.set(state.code, Date.now());

    const shrug: Decision = { say: null, targetSlot: null, verdict: null, claim: null, skipVote: true };
    waiting.apply(state, speaker.playerId, 'day', 'day', shrug, 'act');
    // And the seat with no opinion, which would otherwise join the open skip.
    const nothing: Decision = { say: null, targetSlot: null, verdict: null, claim: null };
    waiting.apply(state, other.playerId, 'day', 'day', nothing, 'act');
    assert.deepEqual(cast, [], 'the room asked for something and is waiting for it');

    // An accusation is an answer, and never waits.
    waiting.apply(state, other.playerId, 'day', 'day', accusing(5), 'act');
    assert.deepEqual(cast, [5], 'a seat that found something says so immediately');

    // And once the window has run, the day may end as it always could.
    waiting.clueCall.set(state.code, Date.now() - 20_000);
    waiting.apply(state, speaker.playerId, 'day', 'day', shrug, 'act');
    assert.deepEqual(cast, [5, 'skip'], 'nobody answered, so the afternoon is spent');
    driver.stop();
  });

  /**
   * The branch the fault fell into is still there and still wanted: a seat with
   * genuinely nothing to say follows the room rather than abstaining.
   */
  it('still lets a seat with no opinion join an open skip', () => {
    const { state, cast, driver } = table();
    const speaker = playerBySlot(state, 2)!;
    state.votes[playerBySlot(state, 3)!.playerId] = SKIP_VOTE;

    const nothingToSay: Decision = { say: null, targetSlot: null, verdict: null, claim: null };
    (driver as unknown as Applier).apply(state, speaker.playerId, 'day', 'day', nothingToSay, 'act', false, true);

    assert.deepEqual(cast, ['skip']);
    driver.stop();
  });
});
