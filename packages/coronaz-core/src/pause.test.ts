import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_RULES } from 'presence-core';

import { applyHeroAction, checkEnd } from './engine.js';
import {
  czPresenceView,
  dropHeroSeat,
  noteHeroAlive,
  noteHeroSilent,
  proposeHeroKick,
  raidAbandoned,
  raidPaused,
  restoreRaidPresence,
  tickRaidPresence,
  voteHeroKick
} from './presence.js';
import { createGame, joinHero, raidPresence, type CzState } from './state.js';
import { gameConfigSchema } from './config.js';
import { czKickSchema } from './protocol.js';

/**
 * The pause, on a real raid with a real hero-phase clock.
 *
 * presence-core proves the rules in the abstract; these hold down the wiring —
 * that the clock is parked, that the horde and the survivors are both refused,
 * and that a resumed phase gets back the time it had.
 */

const GRACE = DEFAULT_RULES.graceMs;

/** A started raid with `count` human survivors, mid hero phase, clock running. */
function raid(count: number): CzState {
  const state = createGame({
    code: 'PAUSE',
    hostToken: 'h',
    gmToken: 'g',
    hostUserId: null,
    config: gameConfigSchema.parse({}),
    seed: 7
  });
  for (let index = 0; index < count; index++) {
    joinHero(state, `Survivant${index}`, undefined, []);
  }
  state.phase = 'heroes';
  state.phaseEndsAt = 60_000;
  return state;
}

function seatIds(state: CzState): string[] {
  return Object.keys(state.heroes);
}

describe('the raid pause', () => {
  it('rides out a micro-lag without touching the clock', () => {
    const state = raid(3);
    const [, second] = seatIds(state);

    noteHeroSilent(state, second, 1_000);
    tickRaidPresence(state, 1_000 + GRACE / 2);

    assert.equal(raidPaused(state), false);
    assert.equal(state.phaseEndsAt, 60_000, 'the hero phase clock is untouched');
    const view = czPresenceView(state, 1_000 + GRACE / 2, null);
    assert.equal(view.paused, false);
    assert.deepEqual(view.waitingFor, []);
    assert.deepEqual(
      view.recovering.map((seat) => seat.playerId),
      [second]
    );
  });

  it('parks the phase clock, and hands back what was left of it', () => {
    const state = raid(3);
    const [, second] = seatIds(state);
    noteHeroSilent(state, second, 1_000);

    assert.equal(tickRaidPresence(state, 1_000 + GRACE).paused, true);
    assert.equal(state.phaseEndsAt, null);
    const left = raidPresence(state).parkedMs;
    assert.equal(left, 60_000 - (1_000 + GRACE));

    noteHeroAlive(state, second, 80_000);
    tickRaidPresence(state, 80_000);
    const resumeAt = 80_000 + DEFAULT_RULES.resumeCountdownMs;
    assert.equal(tickRaidPresence(state, resumeAt).resumed, true);
    assert.equal(state.phaseEndsAt, resumeAt + left);
  });

  it('refuses hero actions while stopped', () => {
    const state = raid(3);
    const [first, second] = seatIds(state);
    noteHeroSilent(state, second, 0);
    tickRaidPresence(state, GRACE);

    // Not even "I am done": ending the phase early is exactly what the absent
    // survivor is owed a say in.
    const result = applyHeroAction(state, first, { type: 'ready' });
    assert.equal(result.ok, false);
    assert.equal(state.heroes[first]?.ready, false);
  });

  it('does not stop for a bot, the dead, or the escaped', () => {
    const state = raid(4);
    const [first, second, third, fourth] = seatIds(state);
    state.heroes[first].isBot = true;
    state.heroes[second].alive = false;
    state.heroes[third].escaped = true;

    for (const seat of [first, second, third]) noteHeroSilent(state, seat, 0);
    assert.equal(tickRaidPresence(state, GRACE * 3).paused, false);

    // The one survivor still in play does stop it.
    noteHeroSilent(state, fourth, GRACE * 3);
    assert.equal(tickRaidPresence(state, GRACE * 4).paused, true);
  });

  it('waits before offering a kick, then carries it on a majority', () => {
    const state = raid(4);
    const [first, second, , fourth] = seatIds(state);

    noteHeroSilent(state, fourth, 0);
    tickRaidPresence(state, GRACE);

    const early = proposeHeroKick(state, first, fourth, DEFAULT_RULES.kickAfterMs - 1);
    assert.deepEqual(early, { ok: false, reason: 'too-soon' });
    assert.deepEqual(czPresenceView(state, GRACE, first).kickablePlayerIds, []);

    const at = DEFAULT_RULES.kickAfterMs;
    assert.deepEqual(proposeHeroKick(state, first, fourth, at), { ok: true });
    assert.deepEqual(voteHeroKick(state, second, true), { ok: true });
    assert.equal(tickRaidPresence(state, at + 1).kicked, fourth);
  });

  it('marks a removed survivor as having walked away, not died', () => {
    const state = raid(3);
    const [, , third] = seatIds(state);

    dropHeroSeat(state, third);

    const hero = state.heroes[third];
    assert.equal(hero.forfeited, true);
    // Not a death: the career ledger counts the two apart on purpose.
    assert.equal(hero.alive, true);
    // And the phase can end: a seat nobody is playing must not block it.
    assert.equal(hero.ready, true);
  });

  it('knows when nobody human is left to play for', () => {
    const state = raid(2);
    const [first, second] = seatIds(state);
    assert.equal(raidAbandoned(state), false);

    dropHeroSeat(state, first);
    assert.equal(raidAbandoned(state), false, 'one survivor is still a raid');
    dropHeroSeat(state, second);
    assert.equal(raidAbandoned(state), true);
  });

  it('waits for a survivor who never comes back from a restart', () => {
    const state = raid(3);
    const [first, second, third] = seatIds(state);
    for (const hero of Object.values(state.heroes)) hero.connected = true;

    const bootedAt = 500_000;
    restoreRaidPresence(state, bootedAt);

    /**
     * The raid has no deadline after a restart — it waits for its humans — so
     * believing a stale `connected` is not merely untidy here: the phase would
     * never end (nobody sends the missing survivor's ready), the raid would
     * never pause, and the room's one remedy would be refused because that
     * player is supposedly present.
     */
    assert.equal(state.heroes[third].connected, false);

    noteHeroAlive(state, first, bootedAt);
    noteHeroAlive(state, second, bootedAt);
    assert.equal(tickRaidPresence(state, bootedAt + GRACE / 2).paused, false);
    assert.equal(tickRaidPresence(state, bootedAt + GRACE).paused, true);
    assert.deepEqual(proposeHeroKick(state, first, third, bootedAt + DEFAULT_RULES.kickAfterMs), { ok: true });
  });

  it('refuses a malformed kick instead of counting it as a no', () => {
    /**
     * The dangerous shapes are the near-misses, not the nonsense: read
     * defensively, each of these lands on the ballot arm with `yes` falsy, which
     * is not an abstention — it is a counted no that overwrites the sender's
     * previous ballot and helps close the vote as failed for good.
     */
    for (const payload of [{}, { type: 'vote' }, { type: 'Vote', yes: true }, { type: 'propose' }, null]) {
      assert.equal(czKickSchema.safeParse(payload).success, false, JSON.stringify(payload));
    }

    assert.equal(czKickSchema.safeParse({ type: 'vote', yes: false }).success, true);
    assert.equal(czKickSchema.safeParse({ type: 'propose', playerId: 'p1' }).success, true);
  });

  it('calls a raid whose survivors got out a win, not an abandonment', () => {
    const state = raid(3);
    const [first, second, third] = seatIds(state);

    // Two are already outside the district; the third's phone dies and the
    // pause runs out on them.
    state.heroes[first].escaped = true;
    state.heroes[second].escaped = true;
    dropHeroSeat(state, third);

    /**
     * `raidAbandoned` counts *active* survivors, and somebody who escaped is not
     * one — so on its own it reads this finished raid as an empty room and would
     * have the manager delete it, results and all. The engine is the one that
     * knows an escape scenario with somebody outside has been won, so it gets
     * asked first.
     */
    assert.equal(raidAbandoned(state), true);
    checkEnd(state);
    assert.equal(state.phase, 'won');
  });

  it('calls a raid nobody escaped a loss, not an abandonment', () => {
    const state = raid(2);
    const [first, second] = seatIds(state);

    state.heroes[first].alive = false;
    dropHeroSeat(state, second);

    checkEnd(state);
    assert.equal(state.phase, 'lost');
  });
});
