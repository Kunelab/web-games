import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HEARTBEAT_MS, DEFAULT_RULES } from 'presence-core';

import {
  addMafiaBot,
  advanceMafia,
  castVote,
  dropMafiaSeat,
  mafiaPaused,
  noteSeatAlive,
  noteSeatSilent,
  joinMafia,
  proposeMafiaKick,
  restoreMafiaTable,
  setNightAction,
  startMafia,
  tickMafiaPresence,
  voteMafiaKick
} from './engine.js';
import type { RoleId } from './roles.js';
import { createMafiaGame, playerBySlot, tablePresence, type MafiaState } from './state.js';
import { toMafiaView } from './view.js';

/**
 * The pause, at the level that matters: a real table, a real phase clock.
 *
 * presence-core already proves the rules in the abstract. What these hold down is
 * the wiring — that the clock is actually parked, that the engine actually
 * refuses, and that a resumed phase gets back the time it had rather than a
 * fresh one.
 */

const GRACE = DEFAULT_RULES.graceMs;

function lcg(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 2 ** 32;
  };
}

let uid = 0;

/** A table of humans, dealt the given roles, mid-day with a clock running. */
function humanTable(roles: RoleId[], options: { bots?: number; now?: number } = {}): MafiaState {
  const now = options.now ?? 0;
  const state = createMafiaGame({ code: 'PAUSE', hostToken: 'h', hostUserId: null, now });
  roles.forEach((role, index) => {
    const id = `p${++uid}`;
    joinMafia(state, `Joueur${index}`, `tok${id}`, id);
    const player = state.players[id];
    player.role = role;
  });
  // Bots are seated while it is still a lobby, which is the only time they may be.
  for (let i = 0; i < (options.bots ?? 0); i++) {
    const bot = addMafiaBot(state, `botTok${++uid}`, `bot${uid}`, () => 0);
    bot.role = 'citizen';
  }
  state.phase = 'day';
  state.stage = 'discussion';
  state.day = 2;
  state.phaseEndsAt = now + 60_000;
  return state;
}

describe('the pause', () => {
  it('rides out a micro-lag without touching the clock', () => {
    const state = humanTable(['sheriff', 'doctor', 'citizen', 'godfather']);
    const deadline = state.phaseEndsAt;

    noteSeatSilent(state, playerBySlot(state, 2)!.playerId, 1_000);
    tickMafiaPresence(state, 1_000 + GRACE / 2);

    assert.equal(mafiaPaused(state), false);
    assert.equal(state.phaseEndsAt, deadline, 'the day clock is untouched');
    // The room is told somebody is wobbling, and nothing else changes.
    const view = toMafiaView(state, { kind: 'host' }, 1_000 + GRACE / 2);
    assert.equal(view.presence.paused, false);
    assert.deepEqual(view.presence.waitingFor, []);
    assert.deepEqual(
      view.presence.recovering.map((seat) => seat.slot),
      [2]
    );
  });

  it('parks the phase clock once the resync window is spent', () => {
    const state = humanTable(['sheriff', 'doctor', 'citizen', 'godfather']);
    noteSeatSilent(state, playerBySlot(state, 2)!.playerId, 1_000);

    const tick = tickMafiaPresence(state, 1_000 + GRACE);
    assert.equal(tick.paused, true);
    assert.equal(mafiaPaused(state), true);
    // Null, so no phone counts down a day that is not passing.
    assert.equal(state.phaseEndsAt, null);
    // And what was left of it is held, not lost.
    assert.equal(tablePresence(state).parkedMs, 60_000 - (1_000 + GRACE));
  });

  it('hands the phase back the time it had, not a fresh one', () => {
    const state = humanTable(['sheriff', 'doctor', 'citizen', 'godfather']);
    const absentee = playerBySlot(state, 2)!.playerId;
    noteSeatSilent(state, absentee, 1_000);
    tickMafiaPresence(state, 1_000 + GRACE);
    const left = tablePresence(state).parkedMs!;

    // Away for a further minute, then back.
    noteSeatAlive(state, absentee, 90_000);
    tickMafiaPresence(state, 90_000);
    const resumeAt = 90_000 + DEFAULT_RULES.resumeCountdownMs;
    const resumed = tickMafiaPresence(state, resumeAt);

    assert.equal(resumed.resumed, true);
    assert.equal(mafiaPaused(state), false);
    assert.equal(state.phaseEndsAt, resumeAt + left, 'the day resumes with exactly what was left of it');
  });

  it('refuses every action that would move the board', () => {
    const state = humanTable(['sheriff', 'doctor', 'citizen', 'godfather']);
    noteSeatSilent(state, playerBySlot(state, 2)!.playerId, 0);
    tickMafiaPresence(state, GRACE);

    const voter = playerBySlot(state, 1)!.playerId;
    assert.equal(castVote(state, voter, 4, GRACE).ok, false);
    assert.equal(setNightAction(state, voter, 4).ok, false);
    // Nothing was recorded, so resuming finds the board exactly as it was.
    assert.deepEqual(state.votes, {});
    assert.deepEqual(state.nightActions, {});
  });

  it('will not let a stale timer advance the phase', () => {
    const state = humanTable(['sheriff', 'doctor', 'citizen', 'godfather']);
    noteSeatSilent(state, playerBySlot(state, 2)!.playerId, 0);
    tickMafiaPresence(state, GRACE);

    // A timer armed before the pause, firing just after it began.
    advanceMafia(state, GRACE + 1, lcg(1));
    assert.equal(state.phase, 'day', 'the town is not pushed into night while stopped');
    assert.equal(state.stage, 'discussion');
  });

  it('does not stop for a bot, or for the dead', () => {
    const state = humanTable(['sheriff', 'doctor', 'citizen', 'godfather'], { bots: 1 });
    const bot = Object.values(state.players).find((player) => player.isBot)!;

    // A hanged player closing their laptop must not hold the town hostage.
    const corpse = playerBySlot(state, 3)!;
    corpse.alive = false;

    noteSeatSilent(state, corpse.playerId, 0);
    noteSeatSilent(state, bot.playerId, 0);
    assert.equal(tickMafiaPresence(state, GRACE * 3).paused, false);
    assert.equal(mafiaPaused(state), false);
  });

  it('waits before offering a kick, then carries it on a majority', () => {
    const state = humanTable(['sheriff', 'doctor', 'citizen', 'godfather']);
    const absentee = playerBySlot(state, 4)!;
    const [a, b] = [playerBySlot(state, 1)!, playerBySlot(state, 2)!];

    noteSeatSilent(state, absentee.playerId, 0);
    tickMafiaPresence(state, GRACE);

    // The delay is the point: for the first half-minute there is nothing to press.
    const early = proposeMafiaKick(state, a.playerId, 4, DEFAULT_RULES.kickAfterMs - 1);
    assert.deepEqual(early, { ok: false, reason: 'too-soon' });
    assert.deepEqual(toMafiaView(state, { kind: 'host' }, GRACE).presence.kickableSlots, []);

    const at = DEFAULT_RULES.kickAfterMs;
    assert.deepEqual(proposeMafiaKick(state, a.playerId, 4, at), { ok: true });
    // Three entitled voters (the absentee does not vote): two yeses carry it.
    assert.deepEqual(voteMafiaKick(state, b.playerId, true), { ok: true });

    const resolved = tickMafiaPresence(state, at + 1);
    assert.equal(resolved.kicked, absentee.playerId);

    /**
     * The room stops waiting, and then takes the same breath a returning player
     * would have been given: the resume countdown runs, so every screen says
     * when play restarts instead of the board jumping under everybody.
     */
    assert.equal(tablePresence(state).pause?.resumesAt, at + 1 + DEFAULT_RULES.resumeCountdownMs);
    tickMafiaPresence(state, at + 1 + DEFAULT_RULES.resumeCountdownMs);
    assert.equal(mafiaPaused(state), false);
    assert.notEqual(state.phaseEndsAt, null, 'and the day clock is running again');
  });

  it('sends a removed seat away as a departure, not a killing', () => {
    const state = humanTable(['sheriff', 'doctor', 'citizen', 'godfather']);
    const leaver = playerBySlot(state, 4)!;

    dropMafiaSeat(state, leaver.playerId, 5_000);

    assert.equal(leaver.alive, false);
    const record = state.deaths.find((death) => death.playerId === leaver.playerId);
    assert.equal(record?.cause.k, 'mafia.cause.left');
    // No killer is credited, which is what stops the town deducing from it.
    assert.equal(record?.source, undefined);
    // And the role goes public: a table cannot keep guessing about somebody who
    // is not there any more.
    const view = toMafiaView(state, { kind: 'host' }, 5_000);
    assert.equal(view.players.find((player) => player.slot === 4)?.role, 'godfather');
  });

  it('re-measures everybody when the game actually starts', () => {
    const state = createMafiaGame({ code: 'LOBBY', hostToken: 'h', hostUserId: null, now: 0 });
    for (let index = 0; index < 5; index++) {
      const id = 'lobby' + String(++uid);
      joinMafia(state, 'Joueur' + String(index), 'tok' + id, id);
    }
    const [absent, ...rest] = Object.values(state.players);

    // Wandered off during a long lobby, and the room started without noticing.
    absent.connected = false;
    noteSeatSilent(state, absent.playerId, 0);
    const startedAt = 20 * 60 * 1000;
    startMafia(state, startedAt, lcg(3));

    // The absence is measured from the start, not from the lobby: the room may
    // not remove somebody before they have had a single turn.
    assert.deepEqual(proposeMafiaKick(state, rest[0].playerId, absent.slot, startedAt), {
      ok: false,
      reason: 'too-soon'
    });
    // But the seat is still known to be dark, so the table does stop for it.
    assert.equal(tickMafiaPresence(state, startedAt + GRACE).paused, true);
  });

  it('gives a table restored mid-pause its clock back', () => {
    const state = humanTable(['sheriff', 'doctor', 'citizen', 'godfather']);
    noteSeatSilent(state, playerBySlot(state, 2)!.playerId, 1_000);
    tickMafiaPresence(state, 1_000 + GRACE);
    // The pause parked the day: this is the snapshot the server writes.
    assert.equal(state.phaseEndsAt, null);
    assert.notEqual(tablePresence(state).parkedMs, null);

    const restored = JSON.parse(JSON.stringify(state)) as MafiaState;
    const bootedAt = 500_000;
    restoreMafiaTable(restored, bootedAt);

    /**
     * The parked clock is the trap: read after the presence reset it looks like a
     * phase that never had a deadline, and since every phase here ends on a
     * server timer, the table would sit in that night until the idle sweep.
     */
    assert.equal(mafiaPaused(restored), false);
    assert.equal(restored.phaseEndsAt, bootedAt + 30_000, 'the day runs to a fresh clock');
  });

  it('does not invent a clock for a table that had none', () => {
    const state = createMafiaGame({ code: 'LOBBY2', hostToken: 'h', hostUserId: null, now: 0 });
    joinMafia(state, 'Joueur', 'tokL', 'lobby-solo');

    restoreMafiaTable(state, 500_000);

    // A lobby waits for its host, not for a timer.
    assert.equal(state.phaseEndsAt, null);
  });

  it('waits for a seat that never comes back from a restart', () => {
    const state = humanTable(['sheriff', 'doctor', 'citizen', 'godfather'], { bots: 1 });
    const bot = Object.values(state.players).find((player) => player.isBot)!;
    // The snapshot says everyone was connected, because everyone was — until the
    // process died underneath them.
    for (const player of Object.values(state.players)) player.connected = true;

    const bootedAt = 500_000;
    restoreMafiaTable(state, bootedAt);

    /**
     * A restored `connected: true` is not evidence of anything, and believing it
     * is the trap: the table would count an empty chair as occupied, never pause
     * for it, and refuse to vote it out on the grounds that the player is here.
     */
    const absentee = playerBySlot(state, 2)!;
    assert.equal(absentee.connected, false);
    assert.equal(bot.connected, true, 'the server is always present');

    // One phone comes back inside the resync window; the rest of the table never
    // learns it was gone.
    for (const player of Object.values(state.players)) {
      if (player !== absentee && !player.isBot) noteSeatAlive(state, player.playerId, bootedAt);
    }
    assert.equal(tickMafiaPresence(state, bootedAt + GRACE / 2).paused, false);

    // The one that does not stops the clock, and can be voted out.
    assert.equal(tickMafiaPresence(state, bootedAt + GRACE).paused, true);
    assert.deepEqual(
      proposeMafiaKick(state, playerBySlot(state, 1)!.playerId, 2, bootedAt + DEFAULT_RULES.kickAfterMs),
      { ok: true }
    );
  });

  it('keeps the kick list across a restart, and re-measures the absences', () => {
    const state = humanTable(['sheriff', 'doctor', 'citizen', 'godfather']);
    const removed = playerBySlot(state, 4)!.playerId;
    const absentee = playerBySlot(state, 2)!.playerId;
    tablePresence(state).kicked.push(removed);
    noteSeatSilent(state, absentee, 0);

    const bootedAt = 500_000;
    restoreMafiaTable(state, bootedAt);

    const presence = tablePresence(state);
    // Somebody the room voted out stays voted out across a deploy, and the room
    // does not start waiting for them again.
    assert.deepEqual(presence.kicked, [removed]);
    assert.equal(presence.awaySince[removed], undefined);
    // An absence measured before the restart says nothing about now, so it is
    // re-measured from it: nobody comes back already past the kick delay.
    assert.equal(presence.awaySince[absentee], bootedAt);
  });

  it('beats often enough that the window means what it says', () => {
    // Five beats inside the window: a phone has to miss most of them to count as
    // gone, which is what makes a single dropped packet invisible.
    assert.equal(GRACE / HEARTBEAT_MS, 5);
  });
});
