import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isLocked, mayEnter } from './door.js';

/**
 * The door, and the one rule about it that is easy to get wrong.
 *
 * Refusing the wrong password is the obvious half and nobody breaks it. The half
 * that breaks is `returning`: a phone reclaiming a seat it already holds must not
 * be asked again, or every reload, every lift and every screen that locked itself
 * during a night phase costs the room a retyped password. These cases are here so
 * that rule cannot be quietly dropped by whoever touches the join handlers next.
 */

describe('the room door', () => {
  it('is only a door when there is a password', () => {
    assert.equal(isLocked(''), false);
    assert.equal(isLocked(undefined), false);
    assert.equal(isLocked('hibou'), true);
  });

  it('lets anybody into a room that asks for nothing', () => {
    assert.equal(mayEnter('', undefined, false).ok, true);
    assert.equal(mayEnter(undefined, 'anything', false).ok, true);
  });

  it('refuses a new seat with no word, or the wrong one', () => {
    const empty = mayEnter('hibou', undefined, false);
    assert.equal(empty.ok, false);
    assert.equal(empty.ok === false && empty.needsPassword, true);
    assert.equal(mayEnter('hibou', 'chouette', false).ok, false);
  });

  it('accepts the right word, whitespace and all', () => {
    assert.equal(mayEnter('hibou', 'hibou', false).ok, true);
    // Phones add a trailing space by themselves; the config side is trimmed by
    // its schema, so trimming what arrives is what makes the two comparable.
    assert.equal(mayEnter('hibou', '  hibou ', false).ok, true);
  });

  it('never asks a seat that is already in the room', () => {
    assert.equal(mayEnter('hibou', undefined, true).ok, true);
    assert.equal(mayEnter('hibou', 'chouette', true).ok, true);
  });

  it('is case sensitive, because a password nobody can mistype is not one', () => {
    assert.equal(mayEnter('Hibou', 'hibou', false).ok, false);
  });
});
