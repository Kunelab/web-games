import './test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FastifyBaseLogger } from 'fastify';
import { addMafiaBot, createMafiaGame, type IntelEntry, type MafiaState } from 'mafia-core';

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

const quiet = () => undefined;
const log = {
  info: quiet,
  warn: quiet,
  error: quiet,
  debug: quiet,
  fatal: quiet,
  trace: quiet,
  silent: quiet,
  level: 'silent',
  child() {
    return log;
  }
} as unknown as FastifyBaseLogger;

describe('a will names each night once', () => {
  async function willOf(nightsLived: number): Promise<string> {
    const { MafiaBotDriver } = await import('./bots.js');

    const state = createMafiaGame({ code: 'WILL1', hostToken: 'h', hostUserId: null, now: 0 });
    for (let i = 0; i < 6; i++) addMafiaBot(state, `tok${i}`, `bot${i}`, () => 0);
    for (const player of Object.values(state.players)) player.role = 'citizen';

    const seat = state.players['bot0'];
    assert.ok(seat);
    seat.role = 'doctor';
    state.phase = 'night';
    state.day = nightsLived;

    let filed = '';
    const driver = new MafiaBotDriver(log, {
      chat: () => ({ ok: true as const }),
      vote: () => ({ ok: true as const }),
      ballot: () => ({ ok: true as const }),
      action: () => ({ ok: true as const }),
      dayAction: () => ({ ok: true as const }),
      will: (_code: string, _botId: string, text: string) => {
        filed = text;
        return { ok: true as const };
      },
      whisper: () => ({ ok: true as const }),
      get: (code: string) => (code === state.code ? state : undefined),
      busy: () => undefined
    });

    /**
     * Every night resolved, and remembered from both ends: the engine's entry
     * for what the journey produced, and the seat's own note of where it was
     * going. That pairing is the whole of the bug.
     */
    const driven = driver as unknown as {
      minds: { wentTo(state: MafiaState, botId: string, slot: number): void };
      updateWill(state: MafiaState, botId: string, tonight?: number | null): void;
    };

    for (let night = 1; night <= nightsLived; night++) {
      const house = 2 + (night % 4);
      state.day = night;
      driven.minds.wentTo(state, 'bot0', house);
      seat.intel.push({ night, kind: 'went', targetSlot: house } as IntelEntry);
    }
    state.day = nightsLived;
    driven.updateWill(state, 'bot0');
    return filed;
  }

  it('does not repeat a night it has already reported', async () => {
    const text = await willOf(6);
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
  it('still writes down the night it has not lived through yet', async () => {
    const { MafiaBotDriver } = await import('./bots.js');
    const state = createMafiaGame({ code: 'WILL2', hostToken: 'h', hostUserId: null, now: 0 });
    for (let i = 0; i < 6; i++) addMafiaBot(state, `tok${i}`, `bot${i}`, () => 0);
    for (const player of Object.values(state.players)) player.role = 'citizen';
    const seat = state.players['bot0'];
    assert.ok(seat);
    seat.role = 'doctor';
    state.phase = 'night';
    state.day = 3;

    let filed = '';
    const driver = new MafiaBotDriver(log, {
      chat: () => ({ ok: true as const }),
      vote: () => ({ ok: true as const }),
      ballot: () => ({ ok: true as const }),
      action: () => ({ ok: true as const }),
      dayAction: () => ({ ok: true as const }),
      will: (_c: string, _b: string, text: string) => {
        filed = text;
        return { ok: true as const };
      },
      whisper: () => ({ ok: true as const }),
      get: (code: string) => (code === state.code ? state : undefined),
      busy: () => undefined
    });

    const driven = driver as unknown as {
      minds: { wentTo(state: MafiaState, botId: string, slot: number): void };
      updateWill(state: MafiaState, botId: string, tonight?: number | null): void;
    };

    // Night 3 is being spent right now: no intel for it, only the intention.
    driven.minds.wentTo(state, 'bot0', 4);
    driven.updateWill(state, 'bot0', 4);

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
