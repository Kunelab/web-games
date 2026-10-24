import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { batched, remembered } from './request-batching.js';

describe('remembered', () => {
  it('shares one answer between everyone asking the same thing', async () => {
    let asked = 0;
    const ask = remembered(
      async (name: string) => {
        asked += 1;
        return name.length;
      },
      (name) => name
    );
    assert.deepEqual(await Promise.all([ask('Jul'), ask('Jul'), ask('Ninho')]), [3, 3, 5]);
    assert.equal(asked, 2);
  });

  it('asks again after an answer that failed', async () => {
    let asked = 0;
    const ask = remembered(
      async () => {
        asked += 1;
        return asked === 1 ? undefined : 'found';
      },
      () => 'same'
    );
    assert.equal(await ask(), undefined);
    assert.equal(await ask(), 'found');
    assert.equal(asked, 2);
  });
});

describe('batched', () => {
  it('sends a full batch at once, and the rest once it has waited', async () => {
    const batches: number[][] = [];
    const ask = batched<number, number>(
      async (keys) => {
        batches.push(keys);
        return new Map(keys.map((key) => [key, key * 10]));
      },
      { size: 2, waitMs: 5, absent: 0 }
    );
    assert.deepEqual(await Promise.all([ask(1), ask(2), ask(3)]), [10, 20, 30]);
    assert.deepEqual(batches, [[1, 2], [3]]);
  });

  it('gathers what arrives while a request is out into the next one', async () => {
    const batches: number[][] = [];
    let release = () => {};
    const ask = batched<number, number>(
      async (keys) => {
        batches.push(keys);
        if (batches.length === 1) await new Promise<void>((resolve) => (release = resolve));
        return new Map(keys.map((key) => [key, key]));
      },
      { size: 50, waitMs: 1, absent: 0 }
    );
    const first = ask(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const rest = [ask(2), ask(3), ask(4)];
    release();
    assert.deepEqual(await Promise.all([first, ...rest]), [1, 2, 3, 4]);
    assert.deepEqual(batches, [[1], [2, 3, 4]]);
  });

  it('asks a key once per batch, however many wait on it', async () => {
    const batches: string[][] = [];
    const ask = batched<string, string>(
      async (keys) => {
        batches.push(keys);
        return new Map(keys.map((key) => [key, key.toUpperCase()]));
      },
      { size: 50, waitMs: 5, absent: '' }
    );
    assert.deepEqual(await Promise.all([ask('a'), ask('a'), ask('b')]), ['A', 'A', 'B']);
    assert.deepEqual(batches, [['a', 'b']]);
  });

  it('answers absent for what the service did not return, and undefined for a failed request', async () => {
    const found = batched<string, number>(async () => new Map([['known', 1]]), { size: 50, waitMs: 1, absent: 0 });
    assert.deepEqual(await Promise.all([found('known'), found('unknown')]), [1, 0]);

    const failed = batched<string, number>(async () => undefined, { size: 50, waitMs: 1, absent: 0 });
    assert.equal(await failed('anything'), undefined);
  });
});
