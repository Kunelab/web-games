// Before anything that reaches env.ts: see the file for why it must be first.
import './test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addMafiaBot, advanceMafia, createMafiaGame, startMafia, type MafiaState } from 'mafia-core';

import { seatAlone } from './seat-fakes.js';
import type { Seat } from './seat.js';

/**
 * A seat wearing somebody else's badge, and the somebody else.
 *
 * A real table let a mafioso claim Jailor for two days in front of the real
 * one. The policy drafted the counter-claim every turn; the driver picked it as
 * the best thing to say, found no sentence for it, and the Jailor said nothing
 * at all, not even the role claim and the accusation queued behind it.
 */

function table(): { state: MafiaState; seat: Seat; jailor: string; impostor: string } {
  const rng = () => 0.5;
  const state = createMafiaGame({
    code: 'BADGE',
    hostToken: 'h',
    hostUserId: null,
    config: { dayMs: 90_000, nightMs: 40_000, defenseMs: 20_000, judgementMs: 15_000, aftermathMs: 5_000 },
    now: 0
  });
  for (let index = 0; index < 9; index++) {
    addMafiaBot(state, `t${index}`, `bot-${index}`, (max) => Math.floor(rng() * max));
  }
  startMafia(state, 1000, rng);
  let now = 2000;
  for (let step = 0; step < 400 && (state.day < 3 || state.phase !== 'day' || state.stage !== 'discussion'); step++) {
    now += 5000;
    advanceMafia(state, now, rng);
  }
  const seats = Object.values(state.players).filter((player) => player.alive);
  const [jailor, impostor, ...rest] = seats;
  assert.ok(jailor && impostor);
  for (const player of Object.values(state.players)) player.role = 'citizen';
  jailor.role = 'jailor';
  impostor.role = 'mafioso';
  // Somebody is already voting for the impostor, so its badge is under fire.
  if (rest[0]) state.votes[rest[0].playerId] = impostor.playerId;

  const { seat, minds } = seatAlone({ rng });
  minds.record(state, impostor.playerId, 'role-claim', impostor.slot, { claimedRole: 'jailor' });
  return { state, seat, jailor: jailor.playerId, impostor: impostor.playerId };
}

describe('a seat claims the badge of the seat listening', () => {
  it('is contested out loud in the square', () => {
    const { state, seat, jailor, impostor } = table();
    const spoken = Array.from({ length: 6 }, () => seat.play(state, jailor, 'day'));

    const said = spoken.filter((decision) => decision.say);
    assert.ok(said.length > 0, `the real Jailor never spoke: ${JSON.stringify(spoken)}`);
    const contest = said.find(
      (decision) =>
        decision.claim?.kind === 'counter-claim' ||
        (decision.claim?.kind === 'role-claim' && decision.claim.slot === state.players[jailor].slot) ||
        (decision.claim?.kind === 'accuse' && decision.claim.slot === state.players[impostor].slot)
    );
    assert.ok(contest, `nothing it said answered the fake Jailor: ${JSON.stringify(said)}`);
  });

  it('is contested in the booth, with a guilty ballot', () => {
    const { state, seat, jailor, impostor } = table();
    state.stage = 'judgement';
    state.trial = { accusedId: impostor, ballots: {} };
    const decision = seat.play(state, jailor, 'judgement');

    assert.equal(decision.verdict, 'guilty');
    assert.equal(decision.claim?.kind, 'counter-claim');
    assert.equal(decision.claim?.deniedRole, 'jailor');
    assert.ok(decision.say && /jailor/i.test(decision.say), `the line does not name the badge: ${decision.say}`);
  });
});
