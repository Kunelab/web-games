import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { advanceDesperation, agendaOf, CALM, MASKS, pickMask, stanceOf, type Pressure } from './social.js';

const CALM_TABLE: Pressure = {
  day: 2,
  aliveCount: 12,
  votesAgainstMe: 0,
  onTrial: false,
  roleOuted: false,
  targetedLastNight: false,
  losingClock: 0
};

const traits = { deceit: 0.5, aggression: 0.5 };
/** A roll that always fires, and one that never does. */
const always = () => 0;
const never = () => 0.999;

describe('the social model', () => {
  it('reads what a role actually wants, not merely its faction', () => {
    assert.equal(agendaOf('sheriff'), 'town');
    assert.equal(agendaOf('godfather'), 'family');
    assert.equal(agendaOf('dragon-head'), 'family', 'the triad is a family too');
    assert.equal(agendaOf('serial-killer'), 'butcher');
    assert.equal(agendaOf('jester'), 'jester');
    assert.equal(agendaOf('executioner'), 'executioner');
    // Both are "neutral" and want opposite things from the evening.
    assert.equal(agendaOf('witch'), 'parasite');
    assert.equal(agendaOf('survivor'), 'passenger');
  });

  /* ----------------------------- the meter ----------------------------- */

  it('nobody is desperate before the first night', () => {
    assert.equal(advanceDesperation(0.9, { ...CALM_TABLE, day: 0, onTrial: true }), CALM);
  });

  it('the rope, the wagon, an outed role and a visitor all raise it', () => {
    const base = advanceDesperation(CALM, CALM_TABLE);
    assert.equal(base, 0, 'a quiet day changes nothing');

    const tried = advanceDesperation(CALM, { ...CALM_TABLE, onTrial: true });
    const wagon = advanceDesperation(CALM, { ...CALM_TABLE, votesAgainstMe: 7 });
    const outed = advanceDesperation(CALM, { ...CALM_TABLE, roleOuted: true });
    const visited = advanceDesperation(CALM, { ...CALM_TABLE, targetedLastNight: true });

    for (const [label, value] of [
      ['trial', tried],
      ['wagon', wagon],
      ['outed', outed],
      ['visited', visited]
    ] as const) {
      assert.ok(value > 0, `${label} should register`);
    }
    assert.ok(tried > visited, 'the barre is worse than a knock at the door');
  });

  it('a wagon means more at a small table than a big one', () => {
    const small = advanceDesperation(CALM, { ...CALM_TABLE, aliveCount: 5, votesAgainstMe: 3 });
    const large = advanceDesperation(CALM, { ...CALM_TABLE, aliveCount: 24, votesAgainstMe: 3 });
    assert.ok(small > large);
  });

  it('panic eases when the danger passes, but never below the board', () => {
    const scared = advanceDesperation(CALM, { ...CALM_TABLE, onTrial: true });
    const spared = advanceDesperation(scared, CALM_TABLE);
    assert.ok(spared < scared, 'yesterday fades');
    assert.ok(spared > 0, 'but it is not forgotten');

    // A structural floor is not a mood: it does not fade at all.
    const losing = advanceDesperation(0.9, { ...CALM_TABLE, losingClock: 0.8 });
    assert.ok(losing >= 0.8);
    assert.equal(advanceDesperation(losing, { ...CALM_TABLE, losingClock: 0.8 }), 0.8);
  });

  it('stays inside its bounds however bad things get', () => {
    const doomed = advanceDesperation(1, {
      ...CALM_TABLE,
      onTrial: true,
      votesAgainstMe: 20,
      roleOuted: true,
      targetedLastNight: true,
      losingClock: 1
    });
    assert.equal(doomed, 1);
  });

  /* ----------------------------- the stance ---------------------------- */

  it('a calm townie asks questions and answers them straight', () => {
    const stance = stanceOf('town', 0, traits);
    assert.ok(stance.seekInfo > 0.5);
    assert.equal(stance.answerHonestly, 1);
    assert.ok(stance.fakeClaim < 0.05, 'no reason to lie yet');
  });

  it('a cornered townie will lie about its own night', () => {
    const calm = stanceOf('town', 0, traits);
    const cornered = stanceOf('town', 0.9, traits);
    assert.ok(cornered.answerHonestly < calm.answerHonestly);
    assert.ok(cornered.fakeClaim > calm.fakeClaim, 'even the town wears a mask at the barre');
    assert.ok(cornered.pushHard > calm.pushHard);
  });

  it('a comfortable family builds trust; a cornered one sells a brother', () => {
    const early = stanceOf('family', 0.1, traits);
    const late = stanceOf('family', 0.9, traits);
    assert.ok(early.buildTrust > late.buildTrust, 'credibility is earned early');
    assert.equal(early.sacrificeAlly, 0, 'nobody is expendable while things are fine');
    assert.ok(late.sacrificeAlly > 0.5, 'and everybody is when they are not');
    assert.ok(late.jesterGambit > 0, 'the last resort unlocks late');
  });

  it('the jester runs backwards: being ignored is his emergency', () => {
    const ignored = stanceOf('jester', 0, traits);
    const wanted = stanceOf('jester', 0.9, traits);
    assert.ok(ignored.troll > wanted.troll);
    assert.ok(ignored.falseAccuse > wanted.falseAccuse);
    assert.ok(ignored.fakeClaim > wanted.fakeClaim, 'he shouts louder when nobody looks');
    assert.ok(ignored.buildTrust < 0.1, 'he is not here to be trusted');
  });

  it('a passenger cooperates until it is personally cornered', () => {
    const calm = stanceOf('passenger', 0.1, traits);
    const cornered = stanceOf('passenger', 0.95, traits);
    assert.ok(calm.buildTrust > 0.5, 'being useful is how you are not chosen');
    assert.ok(calm.fakeClaim < 0.05);
    assert.ok(cornered.fakeClaim > 0, 'the one thing it will lie about is being worth killing');
  });

  /* ------------------------------ the masks ---------------------------- */

  it('a jester claims something big enough to be called a liar', () => {
    const stance = stanceOf('jester', 0, traits);
    const mask = pickMask('jester', stance, always);
    assert.ok(mask !== null);
    assert.ok(MASKS.bait.includes(mask), `${mask} should be a bait face`);
  });

  it('a cornered villain hides behind the jester, because hanging one is a mistake', () => {
    const stance = stanceOf('family', 0.95, traits);
    assert.equal(pickMask('family', stance, always), 'jester');
  });

  it('and picks another face once the jester is already in the ground', () => {
    const stance = stanceOf('family', 0.95, traits);
    const mask = pickMask('family', stance, always, new Set(['jester']));
    assert.notEqual(mask, 'jester');
    assert.ok(mask !== null && MASKS.quiet.includes(mask));
  });

  it('never claims a face already taken or already buried', () => {
    const stance = stanceOf('butcher', 0.5, traits);
    const burned = new Set([...MASKS.quiet, ...MASKS.scary, ...MASKS.bait]);
    assert.equal(pickMask('butcher', stance, always, burned), null, 'no safe face left, so none is claimed');
  });

  it('stays bare-faced when the dice say so', () => {
    const stance = stanceOf('town', 0, traits);
    assert.equal(pickMask('town', stance, never), null);
  });
});
