import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BOT_NAMES, pickBotName, tooAlike } from './bots.js';

/**
 * The cast, and the one thing it must never do: seat somebody the room will
 * confuse with somebody else.
 *
 * A name is printed beside every line of chat and again on every row of the
 * roster, and it is what people type when they vote. Two seats a letter apart
 * are two seats nobody can tell apart while a clock is running.
 */
describe('drawing a name for a bot', () => {
  const inOrder = () => 0;

  it('never draws a name a player is already wearing', () => {
    const name = pickBotName(['Batman'], inOrder);
    assert.notEqual(name, 'Batman');
  });

  /**
   * The near misses, which are the ones that actually cost a vote. Each pair
   * here is a real shape: one letter out, a name sitting inside another, and
   * the same name typed with different furniture around it.
   */
  it('reads a letter or two out as the same person', () => {
    assert.ok(tooAlike('Mario', 'Wario'), 'one letter, five long');
    assert.ok(tooAlike('Thor', 'Thorin'), 'a name inside a name');
    assert.ok(tooAlike('R2-D2', 'r2d2'), 'punctuation is not a difference');
    assert.ok(tooAlike('Léa', 'Lea'), 'and neither is an accent');
    assert.ok(tooAlike('Luigi', 'Waluigi'), 'a prefix somebody typed for fun');

    assert.ok(!tooAlike('Mario', 'Luigi'), 'two different people stay two people');
    assert.ok(!tooAlike('Tom', 'Toad'), 'short names are only ever the same or not');
    assert.ok(!tooAlike('Leia', 'Leela'), 'four letters and two changes is a different name');
  });

  it('keeps the cast away from what a player typed', () => {
    /**
     * The player is the one who chose; the bots move. Drawn a hundred times so
     * the check is on the whole cast rather than on one lucky roll.
     */
    for (let roll = 0; roll < 100; roll++) {
      const name = pickBotName(['Thor', 'Mario'], (max) => roll % max);
      assert.ok(!tooAlike(name, 'Thor'), `${name} is too close to Thor`);
      assert.ok(!tooAlike(name, 'Mario'), `${name} is too close to Mario`);
    }
  });

  it('still answers when the cast is used up', () => {
    const name = pickBotName(BOT_NAMES, inOrder);
    assert.match(name, /^Bot \d+$/);
  });

  /**
   * And the cast itself is big enough for the biggest table in the house, even
   * after a full row of near misses has been struck out of it.
   */
  it('seats a full table of twenty-four without repeating itself', () => {
    const seated: string[] = ['ma bite'];
    for (let seat = 0; seat < 24; seat++) {
      const name = pickBotName(seated, (max) => (seat * 7 + 3) % max);
      assert.ok(
        !seated.some((sitting) => tooAlike(name, sitting)),
        `${name} collides with one of ${seated.join(', ')}`
      );
      seated.push(name);
    }
  });
});
