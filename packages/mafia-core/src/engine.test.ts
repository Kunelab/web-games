import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addMafiaBot,
  advanceMafia,
  castBallot,
  castVote,
  jailTarget,
  joinMafia,
  legalNightAction,
  sayInChat,
  setNightAction,
  startMafia,
  whisperTo
} from './engine.js';
import type { RoleId } from './roles.js';
import { createMafiaGame, playerBySlot, type MafiaState } from './state.js';
import { toMafiaView } from './view.js';

/** Deterministic rng for reproducible deals. */
function lcg(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 2 ** 32;
  };
}

let uid = 0;
function freshId(): string {
  return `p${++uid}`;
}

/** A table with the given roles dealt in slot order, already on day `day`. */
function table(roles: RoleId[], day = 2): MafiaState {
  const state = createMafiaGame({ code: 'TEST1', hostToken: 'host', hostUserId: null, now: 0 });
  roles.forEach((role, index) => {
    const id = freshId();
    if (index === 0) joinMafia(state, `Humain${index}`, `tok${id}`, id);
    else addMafiaBot(state, `tok${id}`, id);
    const player = state.players[id];
    player.role = role;
    player.charges = role === 'vigilante' || role === 'veteran' || role === 'jailor' ? 3 : role === 'survivor' ? 4 : 0;
  });
  state.phase = 'day';
  state.stage = 'discussion';
  state.day = day;
  state.phaseEndsAt = 1000;
  return state;
}

function bySlot(state: MafiaState, slot: number) {
  return playerBySlot(state, slot)!;
}

describe('mafia engine', () => {
  it('deals roles and opens day 1 without votes', () => {
    const state = createMafiaGame({ code: 'GAME1', hostToken: 'h', hostUserId: null, now: 0 });
    for (let i = 0; i < 12; i++) {
      const id = freshId();
      if (i === 0) joinMafia(state, 'Max', `t${id}`, id);
      else addMafiaBot(state, `t${id}`, id);
    }
    startMafia(state, 1000, lcg(42));

    assert.equal(state.phase, 'day');
    assert.equal(state.day, 1);
    const mafia = Object.values(state.players).filter((p) => ['godfather', 'mafioso', 'consort'].includes(p.role!));
    assert.equal(mafia.length, 3);

    const someone = Object.values(state.players)[0];
    const vote = castVote(state, someone.playerId, 2, 1500);
    assert.equal(vote.ok, false);
  });

  it('runs accusation, trial and lynch, and a lynched jester wins', () => {
    const state = table(['jester', 'sheriff', 'doctor', 'citizen', 'godfather', 'mafioso']);
    const jester = bySlot(state, 1);

    // Four of five other players accuse the jester: majority of 6 alive is 4.
    for (const slot of [2, 3, 4, 5]) {
      const result = castVote(state, bySlot(state, slot).playerId, 1, 2000);
      assert.equal(result.ok, true);
    }
    assert.equal(state.stage, 'defense');
    assert.equal(state.trial?.accusedId, jester.playerId);

    advanceMafia(state, 3000, lcg(1)); // defense -> judgement
    assert.equal(state.stage, 'judgement');
    for (const slot of [2, 3, 4, 5]) {
      castBallot(state, bySlot(state, slot).playerId, 'guilty');
    }
    advanceMafia(state, 4000, lcg(1)); // verdict

    assert.equal(jester.alive, false);
    assert.ok(state.winners.some((w) => w.playerId === jester.playerId));
    assert.equal(state.phase, 'night');
  });

  it('resolves a night: doctor saves, sheriff reads the framer and the godfather', () => {
    const state = table(['sheriff', 'doctor', 'citizen', 'godfather', 'framer', 'escort']);
    const sheriff = bySlot(state, 1);
    const doctor = bySlot(state, 2);
    const citizen = bySlot(state, 3);
    const godfather = bySlot(state, 4);
    const framer = bySlot(state, 5);

    advanceMafia(state, 5000, lcg(1)); // day -> night
    assert.equal(state.phase, 'night');

    // Godfather orders the citizen dead, doctor heals the citizen,
    // framer frames the sheriff... on second thought, frames the doctor.
    assert.equal(setNightAction(state, godfather.playerId, citizen.slot).ok, true);
    assert.equal(setNightAction(state, doctor.playerId, citizen.slot).ok, true);
    assert.equal(setNightAction(state, framer.playerId, doctor.slot).ok, true);
    assert.equal(setNightAction(state, sheriff.playerId, godfather.slot).ok, true);

    advanceMafia(state, 6000, lcg(1)); // night resolves -> day 3

    assert.equal(state.phase, 'day');
    assert.equal(citizen.alive, true, 'doctor saved the citizen');
    // The godfather is detection immune: reads innocent.
    assert.ok(sheriff.notifications.some((n) => n.includes('n’a rien de suspect')));
  });

  it('framing flips the sheriff result', () => {
    const state = table(['sheriff', 'citizen', 'framer', 'godfather', 'doctor', 'escort']);
    advanceMafia(state, 0, lcg(1));
    setNightAction(state, bySlot(state, 3).playerId, 2); // frame the citizen
    setNightAction(state, bySlot(state, 1).playerId, 2); // sheriff checks the citizen
    advanceMafia(state, 1, lcg(1));
    assert.ok(bySlot(state, 1).notifications.some((n) => n.includes('SUSPECT')));
  });

  it('jail blocks and protects; execution kills the prisoner', () => {
    const state = table(['jailor', 'serial-killer', 'citizen', 'godfather', 'doctor', 'escort']);
    const jailor = bySlot(state, 1);
    const sk = bySlot(state, 2);

    // The jailor cells the serial killer during the day.
    assert.equal(jailTarget(state, jailor.playerId, sk.slot).ok, true);

    advanceMafia(state, 0, lcg(1)); // night
    // The jailed SK has no action available.
    assert.equal(legalNightAction(state, sk.playerId), null);
    // Execute.
    assert.equal(setNightAction(state, jailor.playerId, sk.slot).ok, true);
    advanceMafia(state, 1, lcg(1));

    assert.equal(sk.alive, false);
    assert.equal(jailor.charges, 2);
  });

  it('the serial killer cuts through the godfather at night', () => {
    const state = table(['serial-killer', 'godfather', 'citizen', 'doctor']);
    advanceMafia(state, 0, lcg(1)); // night
    setNightAction(state, bySlot(state, 1).playerId, 2); // SK stabs the GF
    setNightAction(state, bySlot(state, 2).playerId, 3); // GF orders the citizen dead
    advanceMafia(state, 1, lcg(1));

    assert.equal(bySlot(state, 2).alive, false, 'night immunity does not stop the blade');
  });

  it('the arsonist douses, ignites through immunity, and heals do not argue with fire', () => {
    const state = table(['arsonist', 'godfather', 'doctor', 'citizen', 'sheriff']);
    const arsonist = bySlot(state, 1);
    const godfather = bySlot(state, 2);
    const doctor = bySlot(state, 3);

    advanceMafia(state, 0, lcg(1)); // night: douse the godfather
    setNightAction(state, arsonist.playerId, 2);
    advanceMafia(state, 1, lcg(1));
    assert.equal(godfather.doused, true);

    advanceMafia(state, 2, lcg(1)); // next night: ignite; the doctor tries to save
    setNightAction(state, arsonist.playerId, 1); // self = the match
    setNightAction(state, doctor.playerId, 2);
    advanceMafia(state, 3, lcg(1));

    assert.equal(godfather.alive, false, 'fire beats night immunity and the doctor');
  });

  it('the blackmailer gags a player for the following day', () => {
    const state = table(['blackmailer', 'godfather', 'sheriff', 'citizen', 'doctor', 'escort']);
    const sheriff = bySlot(state, 3);

    advanceMafia(state, 0, lcg(1)); // night
    assert.equal(setNightAction(state, bySlot(state, 1).playerId, 3).ok, true);
    advanceMafia(state, 1, lcg(1)); // day

    const gagged = sayInChat(state, sheriff.playerId, 'day', 'la maison 1 est SUSPECTE !', 10);
    assert.equal(gagged.ok, false);
    // The gag expires with the day.
    advanceMafia(state, 2, lcg(1)); // night
    advanceMafia(state, 3, lcg(1)); // next day
    assert.equal(sayInChat(state, sheriff.playerId, 'day', 'je peux reparler', 20).ok, true);
  });

  it('the witch redirects a night action', () => {
    const state = table(['witch', 'sheriff', 'godfather', 'citizen']);
    const witch = bySlot(state, 1);
    const sheriff = bySlot(state, 2);

    advanceMafia(state, 0, lcg(1)); // night
    setNightAction(state, sheriff.playerId, 3); // sheriff checks the godfather
    setNightAction(state, witch.playerId, 2, 4); // witch sends him to the citizen instead
    advanceMafia(state, 1, lcg(1));

    assert.ok(sheriff.intel.some((entry) => entry.kind === 'sheriff' && entry.targetSlot === 4));
    assert.ok(!sheriff.intel.some((entry) => entry.kind === 'sheriff' && entry.targetSlot === 3));
  });

  it('whispers stay between the two, but the square hears the leaning', () => {
    const state = table(['citizen', 'sheriff', 'godfather', 'doctor']);
    const a = bySlot(state, 1);
    const b = bySlot(state, 2);

    const sent = whisperTo(state, a.playerId, 2, 'je crois que la 3 ment', 10);
    assert.equal(sent.ok, true);

    const bView = toMafiaView(state, { kind: 'player', playerId: b.playerId });
    assert.ok(bView.chat.some((m) => m.text.includes('la 3 ment')));

    const outsider = toMafiaView(state, { kind: 'player', playerId: bySlot(state, 3).playerId });
    assert.ok(!JSON.stringify(outsider.chat).includes('la 3 ment'), 'the content is private');
    assert.ok(outsider.chat.some((m) => m.text.includes('murmure')), 'the gesture is public');
  });

  it('the triad is a real rival family: own kill, own victory', () => {
    const state = table(['dragon-head', 'enforcer', 'godfather', 'citizen', 'sheriff', 'doctor']);
    const dragonHead = bySlot(state, 1);
    const godfather = bySlot(state, 3);

    // Triad chat is sealed from the mafia.
    advanceMafia(state, 0, lcg(1)); // night
    const said = sayInChat(state, dragonHead.playerId, 'triad', 'on prend le Parrain', 5);
    assert.equal(said.ok, true);
    const gfView = toMafiaView(state, { kind: 'player', playerId: godfather.playerId });
    assert.ok(gfView.chat.every((m) => m.channel !== 'triad'));

    // The dragon head can't stab the immune godfather (power 1)…
    setNightAction(state, dragonHead.playerId, 3);
    advanceMafia(state, 1, lcg(1));
    assert.equal(godfather.alive, true);
  });

  it('the bus driver swaps two fates', () => {
    const state = table(['bus-driver', 'sheriff', 'godfather', 'citizen', 'doctor', 'escort']);
    advanceMafia(state, 0, lcg(1)); // night
    setNightAction(state, bySlot(state, 2).playerId, 3); // sheriff checks the godfather…
    setNightAction(state, bySlot(state, 1).playerId, 3, 4); // …but the bus swaps GF and citizen
    advanceMafia(state, 1, lcg(1));

    const sheriff = bySlot(state, 2);
    assert.ok(sheriff.intel.some((entry) => entry.kind === 'sheriff' && entry.targetSlot === 4));
  });

  it('poison kills the following night unless a doctor purges it', () => {
    const state = table(['poisoner', 'citizen', 'sheriff', 'doctor', 'escort', 'godfather']);
    const citizen = bySlot(state, 2);
    const doctor = bySlot(state, 4);

    advanceMafia(state, 0, lcg(1)); // night 2: poison the citizen
    setNightAction(state, bySlot(state, 1).playerId, 2);
    advanceMafia(state, 1, lcg(1)); // day 3
    assert.equal(citizen.alive, true, 'poison is slow');

    advanceMafia(state, 2, lcg(1)); // night 3: the doctor cures
    setNightAction(state, doctor.playerId, 2);
    advanceMafia(state, 3, lcg(1));
    assert.equal(citizen.alive, true, 'the doctor purged the poison');

    advanceMafia(state, 4, lcg(1)); // night 4: poison again, no cure this time
    setNightAction(state, bySlot(state, 1).playerId, 2);
    advanceMafia(state, 5, lcg(1));
    advanceMafia(state, 6, lcg(1)); // night 5: it runs its course
    advanceMafia(state, 7, lcg(1));
    assert.equal(citizen.alive, false);
  });

  it('the janitor hides a corpse and the coroner names it anyway', () => {
    const state = table(['janitor', 'godfather', 'sheriff', 'coroner', 'doctor', 'escort', 'citizen', 'lookout']);
    state.players[bySlot(state, 1).playerId].charges = 3;
    const sheriff = bySlot(state, 3);
    const coroner = bySlot(state, 4);

    advanceMafia(state, 0, lcg(1)); // night: GF orders the sheriff dead, janitor cleans
    setNightAction(state, bySlot(state, 2).playerId, 3);
    setNightAction(state, bySlot(state, 1).playerId, 3);
    advanceMafia(state, 1, lcg(1));

    assert.equal(sheriff.alive, false);
    assert.equal(state.deaths.find((d) => d.playerId === sheriff.playerId)?.hidden, true);
    // The town view shows an unidentified corpse.
    const view = toMafiaView(state, { kind: 'player', playerId: coroner.playerId });
    assert.equal(view.players.find((p) => p.slot === 3)?.roleName, null);

    advanceMafia(state, 2, lcg(1)); // next night: autopsy
    setNightAction(state, coroner.playerId, 3);
    advanceMafia(state, 3, lcg(1));
    assert.ok(coroner.intel.some((entry) => entry.kind === 'role' && entry.value === 'sheriff'));
  });

  it('mafia wins at parity, town wins when purged', () => {
    const parity = table(['godfather', 'citizen']);
    advanceMafia(parity, 0, lcg(1)); // night
    setNightAction(parity, bySlot(parity, 1).playerId, 2);
    advanceMafia(parity, 1, lcg(1));
    assert.equal(parity.phase, 'ended');
    assert.ok(parity.winners.some((w) => w.playerId === bySlot(parity, 1).playerId));

    const purge = table(['vigilante', 'mafioso', 'citizen', 'sheriff']);
    advanceMafia(purge, 0, lcg(1));
    setNightAction(purge, bySlot(purge, 1).playerId, 2);
    advanceMafia(purge, 1, lcg(1));
    assert.equal(purge.phase, 'ended');
    const townWinners = purge.winners.filter((w) => w.reason.includes('Ville'));
    assert.equal(townWinners.length, 3);
  });

  it('never leaks a living role to another player', () => {
    const state = table(['sheriff', 'godfather', 'mafioso', 'citizen', 'doctor', 'jester']);
    const sheriff = bySlot(state, 1);
    const godfather = bySlot(state, 2);

    const sheriffView = toMafiaView(state, { kind: 'player', playerId: sheriff.playerId });
    // No public role while everyone lives, and no teammate list for town.
    assert.ok(sheriffView.players.every((p) => p.role === null && p.roleName === null));
    assert.equal(sheriffView.me?.teammates, null);
    assert.equal(sheriffView.results, null);

    const gfView = toMafiaView(state, { kind: 'player', playerId: godfather.playerId });
    assert.deepEqual(
      gfView.me?.teammates?.map((t) => t.slot),
      [3]
    );

    // Serialize the whole town view of a non-mafia player: the word 'godfather'
    // must not appear anywhere in it while its owner breathes.
    const raw = JSON.stringify(sheriffView);
    assert.ok(!raw.includes('godfather'));
  });

  it('keeps mafia and jail chat away from the town', () => {
    const state = table(['sheriff', 'godfather', 'mafioso', 'citizen', 'doctor', 'escort']);
    advanceMafia(state, 0, lcg(1)); // night

    const gf = bySlot(state, 2);
    const posted = sayInChat(state, gf.playerId, 'mafia', 'on tue le shérif', 10);
    assert.equal(posted.ok, true);

    const sheriffView = toMafiaView(state, { kind: 'player', playerId: bySlot(state, 1).playerId });
    assert.ok(sheriffView.chat.every((m) => m.channel !== 'mafia'));

    const mafiosoView = toMafiaView(state, { kind: 'player', playerId: bySlot(state, 3).playerId });
    assert.ok(mafiosoView.chat.some((m) => m.text.includes('on tue le shérif')));

    // Town cannot write into the family channel either.
    const sneak = sayInChat(state, bySlot(state, 1).playerId, 'mafia', 'coucou', 11);
    assert.equal(sneak.ok, false);
  });

  it('dead players talk only to the dead', () => {
    const state = table(['citizen', 'godfather', 'sheriff', 'doctor']);
    const citizen = bySlot(state, 1);
    citizen.alive = false;

    const ghost = sayInChat(state, citizen.playerId, 'dead', 'je vous vois', 10);
    assert.equal(ghost.ok, true);
    const livingView = toMafiaView(state, { kind: 'player', playerId: bySlot(state, 3).playerId });
    assert.ok(livingView.chat.every((m) => m.channel !== 'dead'));

    const gag = sayInChat(state, citizen.playerId, 'day', 'je parle encore ?', 11);
    assert.equal(gag.ok, false);
  });
});
