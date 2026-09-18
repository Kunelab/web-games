import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toPublicInfo } from '../observe.js';
import type { RoleId } from '../roles.js';
import { createMafiaGame, playerBySlot, type MafiaPlayer, type MafiaState } from '../state.js';
import { beliefs, surestSuspect } from './beliefs.js';
import { decideBallot, decideNightTarget, DEFAULT_PROFILE, makeBrain, type PublicInfo } from './policies.js';

/** A table of the given roles, already mid-game. */
function table(roles: RoleId[], day = 9): MafiaState {
  const state = createMafiaGame({ code: 'BEL', hostToken: 'h', hostUserId: null, now: 0 });
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

const always = (value: number) => () => value;

/**
 * The endgame this whole module was written for.
 *
 * Three seats: a Doctor, a Vigilante and a Serial Killer. The Doctor stopped a
 * knife on the Vigilante last night, so it knows for a fact that somebody
 * attacked, and the only person left who could have done it is the third chair.
 *
 * Every number the table had before this said the opposite. The killer had
 * voted correctly on two hanged evils, which made him the most trusted seat
 * alive; the Doctor healed him on three of the last four nights and the
 * Vigilante, holding a bullet, never fired. Reported from a real game, which the
 * killer won by arithmetic rather than by play.
 */
describe('what one seat can work out for itself', () => {
  const lastNightAttack = (state: MafiaState, healer: number, patient: number, night: number) => {
    playerBySlot(state, healer)!.intel.push({
      night,
      kind: 'saved',
      targetSlot: patient,
      value: 'saved'
    });
  };

  it('names the only seat that could have made last night attack', () => {
    const state = table(['doctor', 'vigilante', 'serial-killer']);
    lastNightAttack(state, 1, 2, 8);
    const doctor = playerBySlot(state, 1)!;
    const board: PublicInfo = { ...toPublicInfo(state, [], []), totalDead: 12, day: 9 };

    const read = beliefs(doctor, board);
    assert.ok(read.get(3)!.odds >= 0.9, 'nobody else is left to have done it');
    assert.equal(read.get(3)!.because[0].code, 'only-one-left');
    assert.ok(
      read.get(2)!.odds < read.get(3)!.odds,
      'and the seat it pulled off the knife is not the one that held it'
    );
  });

  it('turns that into a guilty ballot and a bullet', () => {
    const state = table(['doctor', 'vigilante', 'serial-killer']);
    lastNightAttack(state, 1, 2, 8);
    const doctor = playerBySlot(state, 1)!;
    const board: PublicInfo = { ...toPublicInfo(state, [], []), totalDead: 12, day: 9 };

    assert.equal(
      decideBallot(doctor, makeBrain(1, DEFAULT_PROFILE), board, 3, new Set(), always(0.5)),
      'guilty',
      'the booth reads what the seat knows'
    );

    /**
     * And the gun, from a chair that can do the same sum.
     *
     * The Vigilante woke up having been saved, so it knows an attack happened —
     * but with three alive it cannot tell its rescuer from its attacker, which
     * is the honest answer and the one the engine gives. It takes one more fact
     * to close: the record has signed for the Doctor, so the only chair left is
     * the third one.
     */
    const vig = playerBySlot(state, 2)!;
    vig.rescuedNight = 8;
    const withDoctorKnown: PublicInfo = {
      ...board,
      provenRoles: new Map([[1, 'doctor']])
    };
    assert.ok(
      beliefs(vig, board).get(3)!.odds < 0.85,
      'two chairs and no way to choose is not a deduction'
    );
    const shot = decideNightTarget(
      vig,
      makeBrain(2, DEFAULT_PROFILE),
      withDoctorKnown,
      [1, 3],
      'kill',
      new Set(),
      [],
      always(0.5)
    );
    assert.equal(shot, 3, 'the gun finally comes out');
  });

  it('keeps the doctor from healing the knife', () => {
    const state = table(['doctor', 'vigilante', 'serial-killer']);
    lastNightAttack(state, 1, 2, 8);
    const doctor = playerBySlot(state, 1)!;
    const board: PublicInfo = { ...toPublicInfo(state, [], []), totalDead: 12, day: 9 };

    for (let roll = 0; roll < 10; roll++) {
      const healed = decideNightTarget(
        doctor,
        makeBrain(1, DEFAULT_PROFILE),
        board,
        [2, 3],
        'heal',
        new Set(),
        [],
        always(roll / 10)
      );
      assert.notEqual(healed, 3, 'never a night spent protecting the killer');
    }
  });

  /**
   * And the guard that keeps this from being a gift to the family: the
   * arithmetic does not know whose side anybody is on, so a killer running it
   * would deduce its own brother. `surestSuspect` is told who to leave out, and
   * every caller that is on a side passes its own.
   */
  it('never hands a family its own name', () => {
    const state = table(['mafioso', 'doctor', 'godfather']);
    const mafioso = playerBySlot(state, 1)!;
    mafioso.intel.push({ night: 8, kind: 'saved', targetSlot: 2, value: 'saved' });
    const board: PublicInfo = { ...toPublicInfo(state, [], []), totalDead: 12, day: 9 };

    assert.equal(surestSuspect(mafioso, board, 0.8, new Set([3])), null, 'its own godfather is not a suspect');
    assert.notEqual(surestSuspect(mafioso, board, 0.8), null, 'and without the guard it would have been');
  });

  /**
   * A confession the reader can act on.
   *
   * It is priced in two places and they have to agree: `suspicionParts` for the
   * ordinary day vote, and `rank` for everything built on certainty — the gun,
   * the cell, and the booth's shortcut. The first version attached the reason to
   * the seat and left it out of the sum, so the strongest sentence in the game
   * moved the ranking by nothing at all and every one of those paths ignored it.
   */
  it('reads a confession as a near certainty', () => {
    const state = table(['doctor', 'citizen', 'godfather', 'sheriff', 'lookout'], 3);
    const doctor = playerBySlot(state, 1)!;
    const quiet: PublicInfo = toPublicInfo(state, [], []);
    const said: PublicInfo = toPublicInfo(
      state,
      [{ day: 3, claimerSlot: 3, targetSlot: 3, kind: 'role-claim', truthful: false, claimedRole: 'godfather' }],
      []
    );

    assert.ok(beliefs(doctor, quiet).get(3)!.odds < 0.6, 'nothing said, nothing known');
    assert.ok(beliefs(doctor, said).get(3)!.odds >= 0.85, 'and a man who says it is believed');
    assert.notEqual(surestSuspect(doctor, said, 0.85), null, 'so the gun and the cell can act on it');
  });

  /**
   * A corpse that nobody killed.
   *
   * A body in the morning with two chairs left is the strongest reading this
   * module produces, so it has to be sure the body was *attacked*. A Lover dies
   * of grief when their partner is hanged, a hand that pulled the Jester's rope
   * dies of remorse, and a seat that walks away from the table is recorded the
   * same way — all at night, none of them by anybody still sitting there. Read
   * as an attack, each one convicts an innocent at 0.93 and hands that number
   * to the gun, the cell and the booth.
   *
   * One board, three sources: only the third is somebody being out killing.
   */
  it('does not read grief or remorse as somebody being out killing', () => {
    const state = table(['doctor', 'sheriff', 'citizen', 'citizen'], 9);
    playerBySlot(state, 4)!.alive = false;
    const doctor = playerBySlot(state, 1)!;
    const board: PublicInfo = {
      ...toPublicInfo(state, [], []),
      totalDead: 11,
      day: 9,
      // The record has signed for the Sheriff, so the only chair left is the third.
      provenRoles: new Map([[2, 'sheriff' as const]])
    };
    const lastNight = (source: PublicInfo['deaths'][number]['source']): PublicInfo => ({
      ...board,
      deaths: [{ slot: 4, day: 8, phase: 'night', source }],
      lastNightDeathSlots: new Set([4])
    });

    assert.ok(
      beliefs(doctor, lastNight(null)).get(3)!.odds < 0.85,
      'a broken heart is not a knife, and nobody is narrowed down by it'
    );
    assert.ok(
      beliefs(doctor, lastNight('remorse')).get(3)!.odds < 0.85,
      'and neither is the Jester last laugh'
    );
    assert.ok(
      beliefs(doctor, lastNight('mafia')).get(3)!.odds >= 0.9,
      'a body with a killer behind it still narrows to the one chair left'
    );
  });

  /** A quiet night narrows nothing, and the reading says so rather than guessing. */
  it('claims nothing at all on a night when nobody was touched', () => {
    const state = table(['doctor', 'vigilante', 'serial-killer']);
    const doctor = playerBySlot(state, 1)!;
    const board: PublicInfo = { ...toPublicInfo(state, [], []), totalDead: 12, day: 9 };

    const read = beliefs(doctor, board);
    assert.ok(read.get(3)!.odds < 0.85, 'no attack, no elimination');
    assert.equal(read.get(3)!.because[0].code, 'record');
  });
});
