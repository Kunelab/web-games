import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BrainChain } from './chain.js';
import { chainOver, fakeEndpoints, silentLog, slots } from './chain-fakes.js';

/**
 * Spending every free tier that was configured, rather than the quickest few.
 *
 * Ten endpoints were set up on the deployment box and all ten answered a probe
 * inside 1.3 seconds. Four of them were ever asked anything. That is not a bug
 * in the ranking — it is the ranking working exactly as written, admitting only
 * what sits "within striking distance of the fastest" — and it is the wrong
 * trade for free tiers, because each of the other six has its own daily
 * allowance and an allowance nobody spends is not saved, it expires.
 *
 * `MAFIA_API_SPREAD` names a working set and takes turns inside it. These are
 * the two properties that has to have: everybody in the set gets asked, and
 * nobody outside it gets asked while the set has room.
 */

const SLOTS = 10;
const SPREAD = 8;

/** Ten endpoints, each slower than the last: slot n answers in 10 + 20n ms. */
const endpoints = slots(...Array.from({ length: SLOTS }, (_, index) => `model-${String(index + 1)}`));
const delayOf = (model: string) => 10 + Number(model.replace('model-', '')) * 20;

/** The hedge would ask a second endpoint on the slow ones and muddy the count, so it is off. */
const field = () =>
  new BrainChain(
    chainOver(endpoints, { spread: SPREAD, hedgeMs: 0 }),
    fakeEndpoints(endpoints, { delay: delayOf }),
    silentLog
  );

const ask = (chain: BrainChain) =>
  chain.ask({ system: 'system', user: 'user', format: {}, maxTokens: 50 }, { code: 'TEST' }, 'decide');

describe('spreading the work across the free tiers', () => {
  it('asks every endpoint in the working set, however slow it is', async () => {
    const chain = field();

    // Sequential, so nothing is ever busy: the only thing deciding who gets
    // asked is whose turn it is.
    for (let round = 0; round < SPREAD * 3; round++) {
      await ask(chain);
    }

    const board = chain.scoreboard();
    const slotOf = (model: string) => Number(model.replace('model-', ''));
    const working = board.filter((row) => slotOf(row.model) <= SPREAD);
    const reserve = board.filter((row) => slotOf(row.model) > SPREAD);

    const idle = working.filter((row) => row.ok === 0);
    assert.equal(
      idle.length,
      0,
      `these were never asked anything: ${idle.map((row) => row.model).join(', ')}: board ${board.map((row) => `${row.model}=${String(row.ok)}`).join(' ')}`
    );

    /**
     * And evenly, which is the property that makes it worth doing.
     *
     * Turn by turn over twenty-four calls and eight endpoints is three each. A
     * spread of more than one means something other than the rotation is
     * choosing, and the thing that would be choosing is speed.
     */
    const counts = working.map((row) => row.ok);
    assert.ok(
      Math.max(...counts) - Math.min(...counts) <= 1,
      `the work was not shared evenly: ${working.map((row) => `${row.model}=${String(row.ok)}`).join(' ')}`
    );

    /** The reserve stays a reserve while the working set has room. */
    const touched = reserve.filter((row) => row.ok > 0 || row.busy > 0);
    assert.equal(
      touched.length,
      0,
      `reserve endpoints were used while the working set was free: ${touched.map((row) => row.model).join(', ')}`
    );
  });

  it('falls through to the reserve when the working set is saturated', async () => {
    const chain = field();

    /**
     * More questions at once than the working set can hold.
     *
     * One call in flight per endpoint is the default, so eight simultaneous
     * askers fill the set and the ninth has to go somewhere. A reserve that
     * cannot be reached under load is not a reserve, it is a misconfiguration
     * nobody would ever see.
     */
    await Promise.all(Array.from({ length: SLOTS + 4 }, () => ask(chain)));

    const board = chain.scoreboard();
    const reserve = board.filter((row) => Number(row.model.replace('model-', '')) > SPREAD);
    const used = reserve.filter((row) => row.ok > 0 || row.bad > 0);
    assert.ok(
      used.length > 0,
      `the reserve was never reached under load: ${board.map((row) => `${row.model}=${String(row.ok)}`).join(' ')}`
    );
  });
});
