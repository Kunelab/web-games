import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BrainChain } from './chain.js';
import { chainOver, fakeEndpoints, silentLog, slots } from './chain-fakes.js';

/**
 * The chain, against endpoints that behave the way free tiers actually behave.
 *
 * Everything here is about the *tail*. A free endpoint is not slow on average —
 * a few hundred milliseconds — it is slow sometimes, and the sometimes is what a
 * person at the table experiences, because an answer that arrives late arrives
 * after the moment it was about. The two mechanisms under test are the only two
 * that help: ask a second endpoint when the first stalls, and remember which
 * ones stall.
 *
 * The endpoints are in-memory fakes with the delays a free tier has on a bad
 * evening; see `chain-fakes.ts`.
 */

/** One endpoint that always stalls, three that always answer. */
const STALL_MS = 2000;
const QUICK_MS = 30;
const HEDGE_MS = 400;

const endpoints = slots('stall-model', 'quick-model', 'quick-b', 'quick-c');
const delayOf = (model: string) => (model === 'stall-model' ? STALL_MS : QUICK_MS);
const question = { system: 'system', user: 'user', format: {}, maxTokens: 50 };

describe('the chain', () => {
  it('never waits out a stalled endpoint when another one is idle', async () => {
    const took: number[] = [];
    for (let round = 0; round < 6; round++) {
      const chain = new BrainChain(
        chainOver(endpoints, { hedgeMs: HEDGE_MS }),
        fakeEndpoints(endpoints, { delay: delayOf }),
        silentLog
      );
      const at = Date.now();
      const answer = await chain.ask(question, { code: 'TEST' }, 'decide');
      took.push(Date.now() - at);
      assert.ok(answer, 'nothing answered at all');
    }

    const worst = Math.max(...took);
    assert.ok(
      worst < STALL_MS - 500,
      `a call waited ${worst}ms for a ${String(STALL_MS)}ms endpoint instead of asking somebody else: ${took.join(', ')}`
    );
  });

  it('uses every endpoint at once rather than leaning on the quickest', async () => {
    const chain = new BrainChain(
      chainOver(endpoints, { hedgeMs: HEDGE_MS }),
      fakeEndpoints(endpoints, { delay: delayOf }),
      silentLog
    );

    const answers = await Promise.all(Array.from({ length: 6 }, () => chain.ask(question, { code: 'TEST' }, 'decide')));

    const board = chain.scoreboard();
    // Still in flight counts as asked: the stalled endpoint is, by definition,
    // not going to have answered by the time the hedge has won the race.
    const used = board.filter((row) => row.ok > 0 || row.bad > 0 || row.busy > 0);
    assert.equal(
      used.length,
      board.length,
      `only ${String(used.length)} of ${String(board.length)} endpoints were asked: ${board.map((row) => `${row.model}=${String(row.ok)}`).join(' ')}`
    );
    assert.ok(answers.filter(Boolean).length >= 3, 'fewer answers than endpoints');
  });

  it('prefers the quick endpoint while it has room', async () => {
    const chain = new BrainChain(
      chainOver(endpoints, { hedgeMs: HEDGE_MS }),
      fakeEndpoints(endpoints, { delay: delayOf }),
      silentLog
    );

    for (let round = 0; round < 6; round++) await chain.ask(question, { code: 'TEST' }, 'decide');

    const board = chain.scoreboard();
    const stalled = board.find((row) => row.model === 'stall-model');
    assert.ok(stalled, 'the stalled endpoint is on the board');
    const quick = board.filter((row) => row.model !== 'stall-model').reduce((sum, row) => sum + row.ok, 0);
    assert.ok(
      quick > stalled.ok,
      `the slow endpoint kept its share: quick ${String(quick)}, stalled ${String(stalled.ok)}`
    );
  });
});
