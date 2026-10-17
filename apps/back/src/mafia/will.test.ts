import './test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addMafiaBot,
  advanceMafia,
  createMafiaGame,
  joinMafia,
  setNightAction,
  startMafia,
  type IntelEntry
} from 'mafia-core';

import { seatAlone } from './seat-fakes.js';

/**
 * A will is a record, and a record says each night once.
 *
 * Two lists go into one: what the nights actually produced, filed by the engine
 * when each one resolved, and what the seat wrote down on its way out of the
 * door. The second exists for exactly one night — the one being spent right
 * now, which a seat that dies in it never gets another turn to write up.
 *
 * Nothing took those plan lines back down once the morning had turned them into
 * real entries, so every night was willed twice, in two voices, and the second
 * block went on saying "tonight" about night two. A real Doctor died leaving
 * eight nights written out twice over:
 *
 *   Night 2: I was at Mikasa.
 *   ...
 *   Tonight I am going to Mikasa.
 *
 * It reads as a bot that cannot remember what it has already said, and it spends
 * the will's character budget twice on the same nights, which pushes the notes
 * — the part nobody else can reconstruct — off the bottom.
 */

describe('a will names each night once', () => {
  function willOf(nightsLived: number): string {
    const state = createMafiaGame({ code: 'WILL1', hostToken: 'h', hostUserId: null, now: 0 });
    for (let i = 0; i < 6; i++) addMafiaBot(state, `tok${i}`, `bot${i}`, () => 0);
    for (const player of Object.values(state.players)) player.role = 'citizen';

    const seat = state.players['bot0'];
    assert.ok(seat);
    seat.role = 'doctor';
    state.phase = 'night';
    state.day = nightsLived;

    let filed = '';
    const { seat: played, minds } = seatAlone({
      will: (_code, _botId, text) => {
        filed = text;
      }
    });

    /**
     * Every night resolved, and remembered from both ends: the engine's entry
     * for what the journey produced, and the seat's own note of where it was
     * going. That pairing is the whole of the bug.
     */
    for (let night = 1; night <= nightsLived; night++) {
      const house = 2 + (night % 4);
      state.day = night;
      minds.wentTo(state, 'bot0', house);
      seat.intel.push({ night, kind: 'went', targetSlot: house } as IntelEntry);
    }
    state.day = nightsLived;
    played.updateWill(state, 'bot0');
    return filed;
  }

  it('does not repeat a night it has already reported', () => {
    const text = willOf(6);
    const lines = text.split('\n');
    assert.ok(text.length > 0, 'the seat filed something');

    /**
     * The line count is the assertion that actually catches this, because the
     * two halves were phrased differently and one of the plan phrasings —
     * "Tonight I am going to X" — carries no night number at all. Six nights
     * plus a role line and a closing line is eight; the duplicated version came
     * out at fourteen.
     */
    assert.ok(lines.length <= 8, `six nights should be eight lines, got ${lines.length}:\n${text}`);

    // And no night number is written out twice, which is the visible symptom.
    for (let night = 1; night <= 6; night++) {
      const mentions = lines.filter((line) => new RegExp(`\\b${night}\\b`).test(line)).length;
      assert.ok(mentions <= 1, `night ${night} appears ${mentions} times in:\n${text}`);
    }
  });

  /**
   * And the one line the plan exists for survives: the night being spent now
   * has no entry yet, so it is the seat's only chance to name where it went.
   */
  it('still writes down the night it has not lived through yet', () => {
    const state = createMafiaGame({ code: 'WILL2', hostToken: 'h', hostUserId: null, now: 0 });
    for (let i = 0; i < 6; i++) addMafiaBot(state, `tok${i}`, `bot${i}`, () => 0);
    for (const player of Object.values(state.players)) player.role = 'citizen';
    const seat = state.players['bot0'];
    assert.ok(seat);
    seat.role = 'doctor';
    state.phase = 'night';
    state.day = 3;

    let filed = '';
    const { seat: played, minds } = seatAlone({
      will: (_code, _botId, text) => {
        filed = text;
      }
    });

    // Night 3 is being spent right now: no intel for it, only the intention.
    minds.wentTo(state, 'bot0', 4);
    played.updateWill(state, 'bot0', 4);

    /**
     * Matched on the house rather than the night, because one of the three
     * phrasings is "Tonight I am going to X" and carries no number. The house
     * is the part the town can hold against somebody else's account, and it is
     * the whole reason this line is written before the night rather than after.
     */
    const destination = Object.values(state.players).find((player) => player.slot === 4)?.name;
    assert.ok(destination, 'there is a house 4');
    assert.ok(filed.includes(destination), `the unresolved night is still named in:\n${filed}`);
  });
});

/**
 * A will says how its author came by the badge it dies with.
 *
 * Read off the seat's history of rewrites, not guessed from the badge: a seat
 * the lodge took in and later made its Master signed "An Auditor made me the
 * Mason Leader" (`9RVWV`), and an Amnesiac who remembered a Vigilante signed as
 * a Vigilante with no word of where the badge came from.
 */
describe('a will tells how the badge changed', () => {
  function table(roles: string[]): ReturnType<typeof createMafiaGame> {
    const state = createMafiaGame({ code: 'WILL2', hostToken: 'h', hostUserId: null, now: 0 });
    roles.forEach((_, index) => addMafiaBot(state, `tok${index}`, `bot${index}`, () => 0));
    joinMafia(state, 'Max', 'tok-h', 'human');
    startMafia(state, 1000, () => 0.5);
    roles.forEach((role, index) => {
      state.players[`bot${index}`].role = role as never;
    });
    state.players.human.role = 'citizen';
    return state;
  }

  function willOf(state: ReturnType<typeof createMafiaGame>, botId: string): string {
    let filed = '';
    const { seat } = seatAlone({
      will: (_code, _botId, text) => {
        filed = text;
      }
    });
    seat.updateWill(state, botId);
    return filed;
  }

  function toNight(state: ReturnType<typeof createMafiaGame>): void {
    for (let step = 0; state.phase !== 'night' && step < 20; step++) {
      advanceMafia(state, (state.phaseEndsAt ?? 0) + 1, () => 0.5);
    }
  }

  function toDawn(state: ReturnType<typeof createMafiaGame>): void {
    advanceMafia(state, (state.phaseEndsAt ?? 0) + 1, () => 0.5);
  }

  it('names the badge an Amnesiac remembered, and that it was remembered', () => {
    const state = table(['amnesiac', 'vigilante', 'citizen', 'citizen', 'godfather', 'mafioso']);
    const vigilante = state.players.bot1;
    vigilante.alive = false;
    state.deaths.push({
      playerId: vigilante.playerId,
      day: 1,
      phase: 'night',
      cause: { k: 'mafia.cause.unknown' },
      role: 'vigilante',
      hidden: false,
      source: 'mafia'
    });

    toNight(state);
    setNightAction(state, 'bot0', vigilante.slot);
    toDawn(state);
    assert.equal(state.players.bot0.role, 'vigilante');

    const will = willOf(state, 'bot0');
    assert.match(will, /Amnesiac/, will);
    assert.match(will, /remember/i, will);
  });

  it('says the lodge raised it, never an Auditor', () => {
    const state = table(['mason-leader', 'lookout', 'citizen', 'citizen', 'godfather', 'mafioso']);
    toNight(state);
    setNightAction(state, 'bot0', state.players.bot1.slot);
    toDawn(state);
    state.players.bot0.alive = false;
    toNight(state);
    toDawn(state);
    assert.equal(state.players.bot1.role, 'mason-leader');

    const will = willOf(state, 'bot1');
    assert.match(will, /lodge/i, will);
    assert.doesNotMatch(will, /Auditor/, will);
  });
});
