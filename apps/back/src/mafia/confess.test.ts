import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { selfClaim } from './asks.js';
import { confesses } from './bots.js';
import { wearableMask, type RoleId } from 'mafia-core';

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

/**
 * The same trap as the space-before-apostrophe bug, one layer along.
 *
 * `OWN_DEED` spells its apostrophes `'`, and `typos.ts` writes `’` throughout,
 * so a model line that went through the typo generator carried a punctuation
 * mark none of these rules could match. "I’ll kill 7 tonight" walked past a
 * guard whose entire job is that sentence, and a confession that reaches the
 * square gets its speaker hanged the same afternoon.
 */
describe('a confession is caught whichever apostrophe it is written with', () => {
  /** Nothing decided, so anything owned in the line is an invention. */
  const nothing = '7, say something';

  it('catches the straight apostrophe it always caught', () => {
    assert.equal(confesses("I'll kill 7 tonight", nothing), true);
    assert.equal(confesses("I'm gonna burn him", nothing), true);
  });

  it('catches the typographic one it used to miss', () => {
    assert.equal(confesses('I’ll kill 7 tonight', nothing), true);
    assert.equal(confesses('I’m gonna burn him', nothing), true);
  });

  it('catches both in French too', () => {
    assert.equal(confesses("je t'ai tue hier soir", nothing), true);
    assert.equal(confesses('je t’ai tue hier soir', nothing), true);
    assert.equal(confesses('j’ai brule sa maison', nothing), true);
  });

  it('still lets an ordinary line through', () => {
    assert.equal(confesses('7, you’re wasting everybody’s time', nothing), false);
    assert.equal(confesses('I’ll vote 7 today', nothing), false);
  });

  it('still treats a deed the bot decided on as a choice, not a slip', () => {
    // The whole point of measuring against the fallback: a seat that meant to
    // say it is not inventing it, whichever apostrophe the model reached for.
    assert.equal(confesses('I’ll kill 7 tonight', "I'll kill 7 tonight"), false);
  });
});

/**
 * The tense the guard could not read, and the afternoon it cost.
 *
 * A Poisoner on the stand said "I was the poisoner, as I claimed on Night 3 in
 * house 14" into the square and the room hanged him twenty votes to nothing.
 * Two things had to be wrong at once for that sentence to exist, and both were:
 * the sheet handed to the mouth said "what you have: you really are the
 * poisoner", and this guard, which exists to catch a model claiming a badge the
 * brain never decided on, only knew the present tense.
 *
 * Trace `mafia-2026-09-20T18-07-56-6QFZK`, house 5, day 3.
 */
describe('a badge owned in the past tense', () => {
  const nothing = '7, say something';

  it('catches the sentence that reached a real square', () => {
    assert.equal(confesses('I was the poisoner, as I claimed on Night 3 in house 14', nothing), true);
  });

  it('catches the other ways of saying it, in both languages', () => {
    assert.equal(confesses('I have been the arsonist all game', nothing), true);
    assert.equal(confesses('j’etais le parrain', nothing), true);
  });

  /**
   * And leaves alone the sentences that merely mention a badge in the past. A
   * guard that reads "I was with the sheriff" as a claim to be one would take
   * the phrasebook line off an honest seat every time it described its night.
   */
  it('does not read standing next to a badge as wearing it', () => {
    assert.equal(confesses('I was with the sheriff all night', nothing), false);
    assert.equal(confesses('I was at the doctor’s house', nothing), false);
    assert.equal(confesses('I was never the poisoner', nothing), false);
  });

  /** A badge the brain decided to claim is a bluff, not a slip. */
  it('still allows the claim the brain chose', () => {
    assert.equal(confesses('I was the vigilante, and you know it', 'I am the vigilante'), false);
  });
});

/**
 * The face a liar is allowed to put on, and the one that gives it away.
 *
 * A Mafioso claimed the Coroner on day three of a real game and then published
 * the nights it had actually had — "Night 1: I was at Ghostface", and two more
 * like it, every one of them a living seat. A Coroner works on corpses, so the
 * will refuted its own badge, the room said so out loud, and she hanged that
 * afternoon. The deduction layer was doing its job; the mask picker had handed
 * her a part she could not play.
 */
describe('a mask a liar can keep up', () => {
  it('offers the ordinary town badges worth lying about', () => {
    for (const face of ['doctor', 'sheriff', 'lookout', 'detective', 'bus-driver'] as RoleId[]) {
      assert.equal(wearableMask(face), true, `${face} is a face a liar can hold`);
    }
  });

  /** A mask is only worth wearing if it buys the room's benefit of the doubt. */
  it('never offers a face from a camp the town is hunting', () => {
    for (const evil of ['mafioso', 'godfather', 'cultist', 'serial-killer'] as RoleId[]) {
      assert.equal(wearableMask(evil), false);
    }
    // The morgue badges are town-side or family-side, and the family ones are
    // refused here for the same reason every other family badge is.
    for (const evil of ['janitor', 'incense-master'] as RoleId[]) {
      assert.equal(wearableMask(evil), false);
    }
  });

  /**
   * The Coroner is allowed, and it was not always. Banning it fixed the visible
   * symptom — a liar wearing it published an ordinary evening of house calls on
   * living people and hanged for it — by removing the badge rather than the
   * mistake. `fakeIntel` now writes a Coroner's notebook as autopsies of bodies
   * that were already in the ground, which is the claim that badge can actually
   * make, so it goes back in the pool and simply ranks last.
   */
  it('still allows the cheaply checkable badges, at the bottom of the pile', () => {
    for (const cheap of ['coroner', 'crier', 'mayor', 'marshall'] as RoleId[]) {
      assert.equal(wearableMask(cheap), true, `${cheap} is a poor lie, not an impossible one`);
    }
  });
});
