import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { selfClaim } from './asks.js';

/**
 * The sentences a table says about itself, and the two ways of reading them
 * wrong.
 *
 * Both halves of this file are about the same afternoon: a bot that said
 * something it never decided to say, and a reader that heard something nobody
 * said. They are tested together because the fix for one is now load-bearing
 * for the other — `confesses` screens the mouth's output with `selfClaim`, so
 * a reader that calls every denial a confession would silently replace every
 * denial with a phrasebook line.
 */
describe('a denial is not a confession', () => {
  it('reads a first-person denial as no claim at all', () => {
    /**
     * The single most common sentence at a Mafia table. It used to come back
     * as a self-claimed Serial Killer, which is now the heaviest term in the
     * ranking: jailed, convicted by every juror, shot by the Vigilante.
     */
    assert.equal(selfClaim("I'm not the serial killer"), null);
    assert.equal(selfClaim('im not the godfather guys'), null);
    assert.equal(selfClaim('I am not the arsonist, check me'), null);
  });

  it('reads it in French too', () => {
    assert.equal(selfClaim('je suis pas le parrain'), null);
    assert.equal(selfClaim('je ne suis pas le tueur en serie'), null);
  });

  it('still reads a real claim', () => {
    // The guard is on the run-up, so the badge a line actually claims survives.
    assert.equal(selfClaim("I'm the sheriff"), 'sheriff');
    assert.equal(selfClaim('je suis le medecin'), 'doctor');
  });

  it('still refuses a role put on somebody else', () => {
    // The rule `REPORTING` already kept, unchanged by the one beside it.
    assert.equal(selfClaim('I think the sheriff is 7'), null);
  });

  /**
   * The guard reads the run-up, and the run-up is twenty characters, which is
   * long enough to reach back over a comma into a different sentence. A player
   * defending a claim writes the denial and the claim in one breath, and for a
   * while that cost them the claim: the "not" in the first clause cancelled the
   * badge in the second.
   */
  it('lets a claim survive a denial in the clause before it', () => {
    assert.equal(selfClaim("I'm not lying, I'm the doctor"), 'doctor');
    assert.equal(selfClaim('I never lie, I am the sheriff'), 'sheriff');
    assert.equal(selfClaim('je mens pas, je suis le medecin'), 'doctor');
  });

  it("still refuses a denial in the claim's own clause", () => {
    // The comma is what ends a "not"; without one it reaches the role as before.
    assert.equal(selfClaim("I'm the sheriff, I'm not the doctor"), 'sheriff');
    assert.equal(selfClaim('trust me guys im not the doctor'), null);
  });
});
