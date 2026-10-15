import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toPublicInfo } from './observe.js';
import type { Faction, RoleId } from './roles.js';
import { createMafiaGame, playerBySlot, type MafiaPlayer, type MafiaState } from './state.js';
import type { Claim } from './sim/policies.js';
import { toMafiaView } from './view.js';

/** A table of the given roles, already mid-game. */
function table(roles: RoleId[], day: number): MafiaState {
  const state = createMafiaGame({ code: 'OBS', hostToken: 'h', hostUserId: null, now: 0 });
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

function hanged(state: MafiaState, slot: number, day: number): void {
  const seat = playerBySlot(state, slot)!;
  seat.alive = false;
  state.deaths.push({
    playerId: seat.playerId,
    day,
    phase: 'day',
    cause: { k: 'mafia.cause.lynched' },
    role: seat.role!,
    hidden: false
  });
}

/**
 * The record vouches only with what the table was told.
 *
 * Seat 1 says it is the Sheriff and accuses seat 2; the room hangs seat 2, who
 * was the Serial Killer. Under full reveal the town saw a killer go in the
 * ground on the badge's word, and the badge has earned its trust. Under faction
 * reveal the town saw "a neutral": a Jester or a Survivor would have read the
 * same, so the hanging proves nothing about the badge.
 */
describe('what a hanging proves about the badge that called it', () => {
  const said: Claim[] = [
    { day: 2, claimerSlot: 1, targetSlot: 1, kind: 'role-claim', truthful: true, claimedRole: 'sheriff' },
    { day: 2, claimerSlot: 1, targetSlot: 2, kind: 'accuse', truthful: true, worked: true }
  ];

  function afterTheHanging(reveal: MafiaState['config']['revealOnDeath']): MafiaState {
    const state = table(['sheriff', 'serial-killer', 'citizen', 'citizen', 'doctor'], 3);
    state.config.revealOnDeath = reveal;
    hanged(state, 2, 2);
    return state;
  }

  it('vouches for the badge when the corpse was shown as a killer', () => {
    const board = toPublicInfo(afterTheHanging('role'), said, []);
    assert.equal(board.provenRoles.get(1), 'sheriff');
  });

  it('does not vouch when the corpse was only shown as a neutral', () => {
    const board = toPublicInfo(afterTheHanging('faction'), said, []);
    assert.equal(board.provenRoles.get(1), undefined);
  });
});

/**
 * What a corpse gives away, on every screen at once.
 *
 * The roster on the phones and the board the bots read are two projections of
 * one rule: the table's reveal policy, a cleaned body that says nothing, and the
 * end of the game lifting every mask. When they disagree, a bot knows something
 * no person at the table was shown, or the reverse. Seat 2 is a Godfather found
 * dead at dawn; the board's faction stand-in for the Mafia is a plain Mafioso.
 */
describe('what a corpse gives away', () => {
  function corpse(reveal: MafiaState['config']['revealOnDeath'], cleaned: boolean, ended: boolean) {
    const state = table(['citizen', 'godfather', 'mafioso', 'citizen', 'doctor'], 3);
    state.config.revealOnDeath = reveal;
    const seat = playerBySlot(state, 2)!;
    seat.alive = false;
    state.deaths.push({
      playerId: seat.playerId,
      day: 2,
      phase: 'night',
      cause: { k: 'mafia.cause.unknown' },
      role: 'godfather',
      hidden: cleaned,
      source: 'vigilante'
    });
    if (ended) state.phase = 'ended';
    const row = toMafiaView(state, { kind: 'player', playerId: 's1' }).players.find((player) => player.slot === 2)!;
    return { view: { role: row.role, faction: row.faction }, board: toPublicInfo(state, [], []).deadRoles.get(2) };
  }

  const cases: [
    MafiaState['config']['revealOnDeath'],
    boolean,
    boolean,
    { role: RoleId | null; faction: Faction | null },
    RoleId | undefined
  ][] = [
    ['role', false, false, { role: 'godfather', faction: 'mafia' }, 'godfather'],
    ['faction', false, false, { role: null, faction: 'mafia' }, 'mafioso'],
    ['none', false, false, { role: null, faction: null }, undefined],
    ['role', true, false, { role: null, faction: null }, undefined],
    ['faction', true, false, { role: null, faction: null }, undefined],
    ['none', true, false, { role: null, faction: null }, undefined],
    ['role', true, true, { role: 'godfather', faction: 'mafia' }, 'godfather'],
    ['faction', false, true, { role: 'godfather', faction: 'mafia' }, 'godfather'],
    ['none', true, true, { role: 'godfather', faction: 'mafia' }, 'godfather']
  ];
  for (const [reveal, cleaned, ended, view, board] of cases) {
    const when = `${reveal} reveal${cleaned ? ', cleaned' : ''}${ended ? ', game over' : ''}`;
    it(`agrees on the roster and the board under ${when}`, () => {
      const told = corpse(reveal, cleaned, ended);
      assert.deepEqual(told.view, view, 'the roster');
      assert.equal(told.board, board, 'the board');
    });
  }
});

/**
 * What a seat's will tells the table, and when.
 *
 * Its own rule rather than the reveal policy's. The policy decides what a body
 * is shown as; a will is what its owner chose to write, and it is read off any
 * body that was found, whatever the policy. A cleaned body keeps it, as it keeps
 * its badge, and a living seat's will is its own, sash or no sash. The end of
 * the game lifts both. Seat 2 is a Mayor who has written one.
 */
describe('what a will tells the table', () => {
  interface Seat {
    reveal: MafiaState['config']['revealOnDeath'];
    alive: boolean;
    sash?: boolean;
    cleaned?: boolean;
    ended?: boolean;
    will?: string;
  }

  function willShown(seat: Seat): string | null {
    const state = table(['citizen', 'mayor', 'mafioso', 'citizen', 'doctor'], 3);
    state.config.revealOnDeath = seat.reveal;
    const mayor = playerBySlot(state, 2)!;
    mayor.lastWill = seat.will ?? 'Mayor. Seat 3 lied about the doctor.';
    mayor.revealed = seat.sash ?? false;
    if (!seat.alive) {
      mayor.alive = false;
      state.deaths.push({
        playerId: mayor.playerId,
        day: 2,
        phase: 'night',
        cause: { k: 'mafia.cause.unknown' },
        role: 'mayor',
        hidden: seat.cleaned ?? false,
        source: 'mafia'
      });
    }
    if (seat.ended) state.phase = 'ended';
    return toMafiaView(state, { kind: 'player', playerId: 's1' }).players.find((player) => player.slot === 2)!.lastWill;
  }

  const cases: [string, Seat, string | null][] = [
    ['a body found under full reveal', { reveal: 'role', alive: false }, 'Mayor. Seat 3 lied about the doctor.'],
    ['a body found under no reveal at all', { reveal: 'none', alive: false }, 'Mayor. Seat 3 lied about the doctor.'],
    ['a cleaned body', { reveal: 'role', alive: false, cleaned: true }, null],
    [
      'a cleaned body once the game is over',
      { reveal: 'none', alive: false, cleaned: true, ended: true },
      'Mayor. Seat 3 lied about the doctor.'
    ],
    ['a living seat with its sash out', { reveal: 'role', alive: true, sash: true }, null],
    ['a living seat once the game is over', { reveal: 'role', alive: true, ended: true }, 'Mayor. Seat 3 lied about the doctor.'],
    ['a body found with nothing written', { reveal: 'role', alive: false, will: '' }, null]
  ];
  for (const [when, seat, shown] of cases) {
    it(`shows ${shown === null ? 'nothing' : 'the will'} for ${when}`, () => {
      assert.equal(willShown(seat), shown);
    });
  }
});
