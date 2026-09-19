import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addMafiaBot, createMafiaGame, joinMafia, startMafia, type MafiaState } from 'mafia-core';

import { HEARD_FORMAT, readHeard, type DroppedClaim } from './ear.js';

/**
 * What the ear is allowed to put on the claims board.
 *
 * Both cases here are real: they were read off a table that people actually
 * played, and both cost somebody the game. The board is what every bot reasons
 * from, so an invented entry on it is worth more damage than a missing one, and
 * a dropped entry that should have been kept is worth a hanging.
 */

let seed = 3;
const rng = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};

/** A table whose slot 1 is a person, because the ear only reads people. */
function table(): MafiaState {
  const state = createMafiaGame({ code: 'HEARD', hostToken: 'h', hostUserId: null, now: 0 });
  joinMafia(state, 'Tintin', 'tok-human', 'human');
  for (let index = 0; index < 14; index++) addMafiaBot(state, `tok${index}`, `bot${index}`, rng);
  startMafia(state, 1000, rng);
  state.phase = 'day';
  state.stage = 'discussion';
  state.day = 4;
  return state;
}

const roles = (state: MafiaState): Set<string> =>
  new Set(
    Object.values(state.players)
      .map((player) => String(player.role ?? ''))
      .filter((role) => role !== '')
  );

describe('what the ear files', () => {
  /**
   * A Mason Leader stood up in the middle of his own Mason's trial, said "I am
   * mason leader", and the board never heard it: the ear tested the model's
   * answer with `role in ROLES`, which only accepts a canonical id, while the
   * prompt hands the model the roster in the table's own language. So it
   * answered "Maître de loge" and every role claim it heard was thrown away.
   * They hanged her, and he watched it happen.
   */
  it('accepts a role named in the language the table is playing in', () => {
    const state = table();
    const self = Object.values(state.players).find((player) => !player.isBot)!;
    self.role = 'mason-leader';
    const claimable = roles(state);
    if (!claimable.has('mason-leader')) return; // not dealt at this size; nothing to assert

    for (const said of ['Maître de loge', 'maitre de loge', 'mason-leader', 'mason leader']) {
      const dropped: DroppedClaim[] = [];
      const filed = readHeard(
        state,
        { claims: [{ speaker: self.slot, kind: 'role-claim', role: said }] },
        claimable,
        new Set(),
        dropped
      );
      assert.equal(filed.length, 1, `"${said}" was dropped: ${JSON.stringify(dropped)}`);
      assert.equal(filed[0]?.claimedRole, 'mason-leader', said);
    }
  });

  it('still refuses a role this table does not contain', () => {
    const state = table();
    const self = Object.values(state.players).find((player) => !player.isBot)!;
    const dropped: DroppedClaim[] = [];
    const filed = readHeard(
      state,
      { claims: [{ speaker: self.slot, kind: 'role-claim', role: 'Père Noël' }] },
      roles(state),
      new Set(),
      dropped
    );
    assert.equal(filed.length, 0);
    assert.equal(dropped[0]?.why, 'role not in this game');
  });

  /**
   * "I just used vest on n3, n4 & n6" came back as two sightings, of houses 3
   * and 23, from a seat whose previous line was "I don't visit people". A bot
   * then voted somebody guilty citing a sighting nobody had ever made.
   */
  it('refuses a sighting whose house was only ever spoken as a night', () => {
    const state = table();
    const self = Object.values(state.players).find((player) => !player.isBot)!;
    const said = "I am Survivor.\nI don't visit people.\nI just used vest on n3, n4 & n6.";
    const dropped: DroppedClaim[] = [];
    const filed = readHeard(
      state,
      {
        claims: [
          { speaker: self.slot, kind: 'sighting', about: 3 },
          { speaker: self.slot, kind: 'sighting', about: 6 },
          { speaker: self.slot, kind: 'account-home' }
        ]
      },
      roles(state),
      new Set(),
      dropped,
      said
    );
    assert.equal(filed.length, 1, 'only the account survives');
    assert.equal(filed[0]?.kind, 'account');
    assert.deepEqual(
      dropped.map((entry) => entry.why),
      ['that number was a night', 'that number was a night']
    );
  });

  /** A number said as both is still a house: only the never-a-house ones go. */
  it('keeps a sighting when the same number was also spoken as a house', () => {
    const state = table();
    const self = Object.values(state.players).find((player) => !player.isBot)!;
    const dropped: DroppedClaim[] = [];
    const filed = readHeard(
      state,
      { claims: [{ speaker: self.slot, kind: 'sighting', about: 3 }] },
      roles(state),
      new Set(),
      dropped,
      'night 3 I watched 3 and somebody went in',
    );
    assert.equal(filed.length, 1, `wrongly dropped: ${JSON.stringify(dropped)}`);
  });

  /**
   * And the other half of the same mistake, which cost the room an accusation.
   *
   * A second pass used to read a comma-separated run after one night marker as
   * more nights, with nothing to stop it, so it swallowed whatever number came
   * next in the sentence. "night 3, 7 was out" and "night 3 and 7 is the killer"
   * both filed 7 as a night and the claim about house 7 was refused. The room
   * said it out loud and the board never heard it.
   */
  it('keeps the house in "night 3, 7 was out"', () => {
    const state = table();
    const self = Object.values(state.players).find((player) => !player.isBot)!;
    for (const said of [
      'night 3, 7 was out',
      'night 3 and 7 is the killer',
      'nuit 4, 7 a visité quelqu’un',
      'n3, 7 visited me'
    ]) {
      const dropped: DroppedClaim[] = [];
      const filed = readHeard(
        state,
        { claims: [{ speaker: self.slot, kind: 'sighting', about: 7 }] },
        roles(state),
        new Set(),
        dropped,
        said
      );
      assert.equal(filed.length, 1, `"${said}" lost house 7: ${JSON.stringify(dropped)}`);
    }
  });

  /** And with no transcript to check against, nothing changes. */
  it('files a sighting as before when it is given no transcript', () => {
    const state = table();
    const self = Object.values(state.players).find((player) => !player.isBot)!;
    const filed = readHeard(
      state,
      { claims: [{ speaker: self.slot, kind: 'sighting', about: 3 }] },
      roles(state),
      new Set(),
      []
    );
    assert.equal(filed.length, 1);
  });

  /**
   * A seat saying it spent the night in the cell is the one ailment with a
   * living witness: the jailor confirms it, or catches a liar. `AILMENTS` was
   * written out by hand beside the schema and left `jailed` out of it, so the
   * schema offered the model a word, the rules spelled out how to use it, the
   * board priced it highest of the lot, and then the reader threw every one of
   * them away as unknown. It is read off the schema now, and this is what says
   * so the next time one is added.
   */
  it('accepts every ailment its own schema names', () => {
    const state = table();
    const self = Object.values(state.players).find((player) => !player.isBot)!;
    const named = (HEARD_FORMAT.properties.claims.items.properties.ailment.enum as readonly (string | null)[]).filter(
      (name): name is string => name !== null
    );
    assert.ok(named.includes('jailed'), 'the schema stopped offering the cell');

    for (const ailment of named) {
      const dropped: DroppedClaim[] = [];
      const filed = readHeard(
        state,
        { claims: [{ speaker: self.slot, kind: 'ailing', ailment }] },
        roles(state),
        new Set(),
        dropped
      );
      assert.equal(filed.length, 1, `${ailment} was dropped: ${JSON.stringify(dropped)}`);
      assert.equal(filed[0]?.ailment, ailment);
    }
  });

  /** And nothing it does not name. */
  it('still refuses an ailment nobody can suffer', () => {
    const state = table();
    const self = Object.values(state.players).find((player) => !player.isBot)!;
    const dropped: DroppedClaim[] = [];
    const filed = readHeard(
      state,
      { claims: [{ speaker: self.slot, kind: 'ailing', ailment: 'haunted' }] },
      roles(state),
      new Set(),
      dropped
    );
    assert.equal(filed.length, 0);
    assert.equal(dropped[0]?.why, 'unknown ailment');
  });
});
