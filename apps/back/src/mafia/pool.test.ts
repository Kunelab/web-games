import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BrainChain } from './chain.js';
import { chainOver, fakeEndpoints, silentLog, slots } from './chain-fakes.js';

/**
 * Picking an endpoint when nobody has asked for a rotation.
 *
 * `spread.test.ts` covers the opt-in working set, which takes turns. This is
 * the default, which ranks: the quickest healthy endpoint should get the call
 * when it is free, and the others should still be reached when it is not.
 *
 * It exists because the ranking had collapsed. Measured across fourteen real
 * games on ten configured slots, one endpoint answered 252 of the 372
 * successful calls and the next one down — 280ms slower, which nobody at a
 * table can perceive — took 87. The window for "close enough to the fastest"
 * was a quarter of a second, and a quarter of a second was deciding which of
 * ten free daily allowances got spent while the rest expired unused.
 *
 * Two properties, and they pull against each other on purpose:
 *
 *  - when there is one call to make, the fast endpoint makes it;
 *  - when there are more calls in flight than the fast ones can hold, the rest
 *    of the healthy field is used rather than the table waiting.
 */

const SLOTS = 6;
const PARALLEL = 1;

/** Six endpoints, each slower than the last: slot n answers in 60n - 40 ms. */
const endpoints = slots(...Array.from({ length: SLOTS }, (_, index) => `model-${String(index + 1)}`));
const delayOf = (model: string) => Number(model.replace('model-', '')) * 60 - 40;

/**
 * The default: no rotation asked for, so the ranking decides. The hedge would
 * ask a second endpoint on the slow ones and muddy the count, so it is off.
 */
const field = () =>
  new BrainChain(
    chainOver(endpoints, { spread: 0, apiParallel: PARALLEL, hedgeMs: 0 }),
    fakeEndpoints(endpoints, { delay: delayOf }),
    silentLog
  );

const ask = (chain: BrainChain) =>
  chain.ask({ system: 'system', user: 'user', format: {}, maxTokens: 50 }, { code: 'TEST' }, 'decide');

describe('choosing an endpoint when none was asked for by name', () => {
  /**
   * One call at a time, and the quick one takes all of them.
   *
   * The widened window must not turn into a lottery. With nothing in flight
   * there is no reason to ask anybody but the best, and an endpoint that is
   * merely acceptable should stay idle.
   */
  it('gives a lone call to the fastest healthy endpoint', async () => {
    const chain = field();

    // One warm-up per slot, so every endpoint has a measured speed to be ranked on.
    for (let round = 0; round < SLOTS * 2; round++) await ask(chain);

    const before = new Map(chain.scoreboard().map((row) => [row.model, row.ok]));
    for (let round = 0; round < 8; round++) await ask(chain);
    const after = chain.scoreboard();

    const gained = (model: string) => (after.find((row) => row.model === model)?.ok ?? 0) - (before.get(model) ?? 0);
    assert.ok(gained('model-1') >= 6, `the quickest should take a lone call: ${JSON.stringify(after)}`);
    assert.equal(gained('model-6'), 0, 'the slowest should be idle while the quickest is free');
  });

  /**
   * And when the quick ones are all busy, the rest of the field answers.
   *
   * This is the half that was broken. Twelve seats thinking at once is an
   * ordinary afternoon, and with one call in flight per endpoint it needs
   * twelve endpoints or it needs to wait. Waiting is what sends a seat to the
   * phrasebook, so the work goes wide instead.
   */
  it('reaches the rest of the field when the quick ones are full', async () => {
    const chain = field();

    for (let round = 0; round < SLOTS * 2; round++) await ask(chain);

    const before = new Map(chain.scoreboard().map((row) => [row.model, row.ok]));
    await Promise.all(Array.from({ length: SLOTS * 2 }, () => ask(chain)));
    const after = chain.scoreboard();

    const used = after.filter((row) => (row.ok ?? 0) - (before.get(row.model) ?? 0) > 0);
    assert.ok(
      used.length >= 4,
      `a burst should reach most of the field, reached ${String(used.length)}: ${JSON.stringify(after)}`
    );
  });
});
