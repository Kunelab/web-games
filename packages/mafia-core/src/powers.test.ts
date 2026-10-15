import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { staysHome } from './powers.js';
import type { RoleId } from './roles.js';

/**
 * Who leaves the house at night, as the engine walks it.
 *
 * The bots read this to tell an honest itinerary from a lie: a seat wearing a
 * badge that never steps out has no business being seen at a door, and one
 * whose job is going out is not suspicious for having gone. It has to say what
 * the night actually does, and it had drifted: the engine performs an autopsy
 * on a slab, works the cell from the keeper's own house and remembers a corpse
 * from the Amnesiac's chair, and none of those is a visit any watcher sees.
 */
describe('who stays home at night', () => {
  const home: RoleId[] = ['citizen', 'veteran', 'survivor', 'coroner', 'jailor', 'kidnapper', 'interrogator', 'amnesiac'];
  const out: RoleId[] = ['sheriff', 'lookout', 'doctor', 'escort', 'mafioso', 'janitor', 'arsonist', 'bus-driver'];

  for (const role of home) {
    it(`keeps the ${role} at home`, () => assert.equal(staysHome(role), true));
  }
  for (const role of out) {
    it(`sends the ${role} out`, () => assert.equal(staysHome(role), false));
  }
});
