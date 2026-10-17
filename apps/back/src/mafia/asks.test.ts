import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mentions } from './asks.js';

const seats = [
  { slot: 5, name: 'Jon Snow' },
  { slot: 10, name: 'Minnie' },
  { slot: 13, name: 'Atlas' }
];
const kinds = (text: string) => mentions(text, seats).map((hit) => `${hit.slot}:${hit.kind}`);

describe('what a private line asks for', () => {
  /**
   * A human Mason told his Leader "no go to jon snow", meaning no, visit Jon
   * Snow instead, and the lodge filed it as a reprieve for Jon Snow.
   */
  it('reads a leading "no" before an order as disagreement, not a reprieve', () => {
    assert.deepEqual(kinds('no go to jon snow'), ['5:target']);
    assert.deepEqual(kinds('no, take 10'), ['10:target']);
    assert.deepEqual(kinds('non, va chez Minnie'), ['10:target']);
  });

  it('still reads a negated verb as a reprieve', () => {
    assert.deepEqual(kinds("don't go to jon snow"), ['5:spare']);
    assert.deepEqual(kinds('no 13'), ['13:spare']);
    assert.deepEqual(kinds('not 13, take 10'), ['13:spare', '10:target']);
  });
});

describe('a number that is not a house', () => {
  /**
   * `J6D7G`: "Arsonist take 2 day to kill" was a person explaining a clock,
   * and "night 5 ?" a person asking about a night. Both were read as houses.
   */
  it('reads a duration and a night as what they are', () => {
    assert.deepEqual(kinds('take 10 days if you have to'), []);
    assert.deepEqual(kinds('night 10 we take 13'), ['13:target']);
    assert.deepEqual(kinds('nuit 5, on prend 10'), ['10:target']);
  });

  it('still reads the house a night marker dates', () => {
    assert.deepEqual(kinds('take 10 night 2'), ['10:target']);
    assert.deepEqual(kinds('kill 13 tonight'), ['13:target']);
  });
});
