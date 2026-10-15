import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RoleId } from '../roles.js';
import { createMafiaGame, playerBySlot, type MafiaPlayer, type MafiaState } from '../state.js';
import { DEFAULT_PROFILE, suspicionParts, type Claim, type Personality } from './policies.js';
import { BotTable } from './table.js';

/** A table of the given roles, all bots, already on day `day`. */
function seated(roles: RoleId[], day = 3): MafiaState {
  const state = createMafiaGame({ code: 'TBL', hostToken: 'h', hostUserId: null, now: 0 });
  roles.forEach((role, index) => {
    const id = `s${index + 1}`;
    state.players[id] = {
      playerId: id,
      token: `t${id}`,
      name: `P${index + 1}`,
      slot: index + 1,
      isBot: true,
      connected: true,
      alive: true,
      role,
      charges: 3,
      obsessionId: null,
      revealed: false,
      doused: false,
      charged: false,
      poisonedNight: null,
      disguiseRole: null,
      bondPartnerId: null,
      bondKind: null,
      cooldownUntilDay: null,
      silencedDay: null,
      lastWill: '',
      notifications: [],
      intel: [],
      death: null
    } satisfies MafiaPlayer;
  });
  state.phase = 'day';
  state.stage = 'discussion';
  state.day = day;
  return state;
}

const steady = () => 0.5;
const as = (herd: number): Personality => ({ ...DEFAULT_PROFILE, herd });

/**
 * One table's bots, and nobody else's.
 *
 * The temperaments used to live in maps shared by every table in the process,
 * rebound before each decision, so two tables were one forgotten rebind away
 * from reading each other's seats. Each table now carries its own.
 */
describe('a bot table', () => {
  it('weighs the wagon by its own seats, whatever another table holds', () => {
    const follower = seated(['citizen', 'citizen', 'mafioso', 'doctor']);
    const sceptic = seated(['citizen', 'citizen', 'mafioso', 'doctor']);
    for (const state of [follower, sceptic]) {
      state.votes.s2 = 's3';
      state.votes.s4 = 's3';
    }

    const followers = new BotTable(follower, () => as(1));
    const sceptics = new BotTable(sceptic, () => as(0));
    const reader = (state: MafiaState) => playerBySlot(state, 1)!;

    const crowd = suspicionParts(3, reader(follower), followers.board('s1'), steady).wagon;
    const alone = suspicionParts(3, reader(sceptic), sceptics.board('s1'), steady).wagon;
    assert.ok(crowd > 0, 'a follower feels the wagon');
    assert.equal(alone, 0, 'a sceptic does not');
    assert.equal(
      suspicionParts(3, reader(follower), followers.board('s1'), steady).wagon,
      crowd,
      'and the follower still does after the sceptics sat down'
    );
  });

  /** A seeded stream per run, so a statement about "every night" is about many. */
  function dice(seed: number): () => number {
    let value = seed >>> 0;
    return () => {
      value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
      return value / 2 ** 32;
    };
  }

  /**
   * A family shares what it says in its room, not its notebooks.
   *
   * The Consigliere has found the Sheriff, but has not said so. The knife holds
   * nothing of its own that tells two quiet houses apart, so over many nights it
   * must sometimes go elsewhere: a knife that always found the Sheriff would be
   * reading a teammate's private record.
   */
  it("hands the knife its own night record and nobody else's", () => {
    const picks = new Set<number | null>();
    for (let seed = 1; seed <= 40; seed++) {
      const state = seated(['mafioso', 'consigliere', 'sheriff', 'citizen', 'citizen', 'citizen', 'citizen']);
      state.phase = 'night';
      state.stage = null;
      playerBySlot(state, 2)!.intel.push({ night: 2, kind: 'role', targetSlot: 3, value: 'sheriff' });
      const table = new BotTable(state, () => DEFAULT_PROFILE);
      picks.add(table.night('s1', dice(seed))?.targetSlot ?? null);
    }
    assert.ok([...picks].some((slot) => slot !== 3), 'the knife does not know where the Sheriff sleeps');
  });

  /**
   * A bound heart is a side. The room has piled onto seat 2, and seat 1 is
   * seat 2's lover: whatever the case against the partner, seat 1 does not
   * put its own rope on it.
   */
  it('never votes to hang its lover', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const state = seated(['citizen', 'citizen', 'mafioso', 'citizen', 'doctor', 'citizen']);
      const lover = playerBySlot(state, 1)!;
      const partner = playerBySlot(state, 2)!;
      lover.bondPartnerId = partner.playerId;
      lover.bondKind = 'lover';
      partner.bondPartnerId = lover.playerId;
      partner.bondKind = 'lover';
      for (const voter of ['s3', 's4', 's5', 's6']) state.votes[voter] = partner.playerId;

      const table = new BotTable(state, () => DEFAULT_PROFILE);
      for (const accuser of [4, 5, 6]) {
        table.hear({ day: 3, claimerSlot: accuser, targetSlot: 2, kind: 'accuse' } satisfies Omit<Claim, 'truthful'>);
      }
      const move = table.day('s1', dice(seed));
      assert.notEqual(move?.ballot.slot, 2, `seed ${seed}`);
    }
  });

  /**
   * A square that has found nothing says so.
   *
   * Nothing has been said, nobody has voted, and nobody has died in the open:
   * the ballot is a vote to hang nobody, not a coin flip with a corpse at the
   * end. That is the live table's ballot layer, and the bench used to cast the
   * raw proposal instead. A full table, early, so the parity clock is not
   * pushing anybody to hang somebody anyway.
   */
  it('votes to hang nobody on a board with no case on it', () => {
    const state = seated([
      'citizen',
      'citizen',
      'mafioso',
      'citizen',
      'doctor',
      'sheriff',
      'citizen',
      'citizen',
      'citizen',
      'citizen',
      'citizen',
      'citizen'
    ]);
    const table = new BotTable(state, () => DEFAULT_PROFILE);
    const move = table.day('s1', steady);
    assert.equal(move?.ballot.skip, true);
  });
});
