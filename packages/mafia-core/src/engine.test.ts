import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addMafiaBot,
  advanceMafia,
  callCourt,
  castBallot,
  castVote,
  chatLineFor,
  checkVictory,
  chatVisibleTo,
  jailTarget,
  joinMafia,
  legalNightAction,
  revealMayor,
  sayInChat,
  setNightAction,
  startMafia,
  whisperTo
} from './engine.js';
import { translator, type Msg } from 'i18n';
import { en } from 'i18n/locales/en';
import { fr } from 'i18n/locales/fr';

import type { RoleId } from './roles.js';
import { chatRules, ANONYMOUS, createMafiaGame, playerBySlot, type MafiaState } from './state.js';
import { toMafiaView } from './view.js';
import { simulateGame } from './sim/simulate.js';

/**
 * What the square actually said, in French.
 *
 * The engine now emits keys, so an assertion about prose has to render them —
 * which makes these tests better than they were: they prove the whole path from a
 * rule firing to a sentence a person reads, catalogue included.
 */
const t = translator(fr, en);
const rendered = (message: { msg?: Msg; text: string }): string => (message.msg ? t(message.msg) : message.text);
const said = (state: MafiaState): string =>
  state.chat.messages.map((message) => (message.msg ? t(message.msg) : message.text)).join('\n');

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
    else addMafiaBot(state, `tok${id}`, id, () => 0);
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
      else addMafiaBot(state, `t${id}`, id, () => 0);
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

  /**
   * Day one has no corpse, no claim and no rope. Its clock is its own setting
   * rather than a fraction of the ordinary day, which is what it used to be —
   * 60% of two minutes is still seventy-two seconds of "hi".
   */
  it('gives the first day its own, much shorter clock', () => {
    const state = createMafiaGame({ code: 'GAME2', hostToken: 'h', hostUserId: null, now: 0 });
    for (let i = 0; i < 6; i++) {
      const id = freshId();
      if (i === 0) joinMafia(state, 'Max', `t${id}`, id);
      else addMafiaBot(state, `t${id}`, id, () => 0);
    }
    startMafia(state, 1000, lcg(7));

    assert.equal(state.day, 1);
    assert.equal(state.phaseEndsAt, 1000 + state.config.firstDayMs);
    assert.ok(state.config.firstDayMs < state.config.dayMs, 'the greeting day is the short one');
  });

  /**
   * The day's second exit. Before it existed a town with nothing left to say
   * could only wait for the clock, so a quiet afternoon was two minutes of
   * silence with a countdown on it.
   */
  it('ends the day early when a majority votes to hang nobody', () => {
    const state = table(['citizen', 'citizen', 'citizen', 'citizen', 'godfather', 'mafioso']);

    // Three of six is short of the four-vote majority: the day holds.
    for (const slot of [1, 2, 3]) {
      assert.equal(castVote(state, bySlot(state, slot).playerId, 'skip', 2000).ok, true);
    }
    assert.equal(state.phase, 'day');

    // The fourth carries it, and night falls on the spot.
    castVote(state, bySlot(state, 4).playerId, 'skip', 2100);
    assert.equal(state.phase, 'night');
    assert.ok(said(state).includes('ne pendre personne'));
  });

  it('treats a skip as one position among the accusations, not a second one', () => {
    const state = table(['citizen', 'citizen', 'citizen', 'citizen', 'godfather', 'mafioso']);
    const voter = bySlot(state, 1);

    castVote(state, voter.playerId, 'skip', 2000);
    let view = toMafiaView(state, { kind: 'player', playerId: voter.playerId });
    assert.equal(view.me?.votedSkip, true);
    assert.equal(view.me?.voteTargetSlot, null);
    assert.equal(view.skipVotes, 1);

    // Accusing somebody replaces the skip rather than sitting beside it.
    castVote(state, voter.playerId, 5, 2100);
    view = toMafiaView(state, { kind: 'player', playerId: voter.playerId });
    assert.equal(view.me?.votedSkip, false);
    assert.equal(view.me?.voteTargetSlot, 5);
    assert.equal(view.skipVotes, 0);
  });

  /**
   * The published role list says what the table *promised*, never what it dealt.
   * A preset shows its category slots; the automatic roster is deterministic in
   * the seat count, so it can be shown role for role.
   */
  it('publishes the slots a setup promised, not the roles it rolled', () => {
    const state = table(['citizen', 'citizen', 'citizen', 'citizen', 'godfather', 'mafioso']);
    state.config.setup = { mode: 'preset', presetId: 'classique-15' };

    const list = toMafiaView(state, { kind: 'host' }).roleList;
    assert.equal(list.length, Object.keys(state.players).length, 'one line per seat');
    assert.ok(list.includes('town-core'), 'a category stays a category');
    assert.ok(!list.includes('citizen'), 'and never leaks what it rolled');
    assert.ok(list.indexOf('sheriff') < list.indexOf('town-core'), 'exact roles read before their categories');
  });

  /**
   * The end of a game opens every door, and a door onto an empty room is not a
   * reveal — it is a statement about the setup made by a screen with no business
   * making it.
   */
  it('opens every room that was used at the end, and no others', () => {
    const state = table(['citizen', 'citizen', 'sheriff', 'doctor', 'godfather', 'mafioso']);
    const town = bySlot(state, 1);
    const boss = bySlot(state, 5);

    // The family talks; the triad and the lodge were never dealt.
    state.phase = 'night';
    sayInChat(state, boss.playerId, 'mafia', 'la maison 1, cette nuit', 5);
    state.phase = 'ended';

    const tabs = (id: string) =>
      toMafiaView(state, { kind: 'player', playerId: id }).me?.channels.map((channel) => channel.id) ?? [];

    assert.ok(tabs(town.playerId).includes('day'), 'the square is always there');
    assert.ok(tabs(town.playerId).includes('mafia'), 'and the family room, now that it is over');
    assert.ok(!tabs(town.playerId).includes('triad'), 'but not a triad that never sat down');
    assert.ok(!tabs(town.playerId).includes('mason'), 'nor a lodge nobody was in');
  });

  /** The masks come off on the roster, not only in the results table. */
  it('names every survivor once the game is over', () => {
    const state = table(['citizen', 'citizen', 'sheriff', 'doctor', 'godfather', 'mafioso']);
    const town = bySlot(state, 1);

    let mine = toMafiaView(state, { kind: 'player', playerId: town.playerId }).players.find((p) => p.slot === 5)!;
    assert.equal(mine.roleName, null, 'a living godfather keeps his face during the game');

    state.phase = 'ended';
    mine = toMafiaView(state, { kind: 'player', playerId: town.playerId }).players.find((p) => p.slot === 5)!;
    assert.equal(t(mine.roleName!), 'Parrain', 'and loses it at the end');
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
    assert.ok(sheriff.notifications.some((note) => t(note).includes('n’a rien de suspect')));
  });

  /**
   * A frame does not merely trip the needle, it aims it: the sheriff reads the
   * framer's own family, which is what makes the power worth a night.
   */
  it('framing points the sheriff at the framer’s family', () => {
    const state = table(['sheriff', 'citizen', 'framer', 'godfather', 'doctor', 'escort']);
    advanceMafia(state, 0, lcg(1));
    setNightAction(state, bySlot(state, 3).playerId, 2); // frame the citizen
    setNightAction(state, bySlot(state, 1).playerId, 2); // sheriff checks the citizen
    advanceMafia(state, 1, lcg(1));
    const sheriff = bySlot(state, 1);
    assert.ok(sheriff.notifications.some((note) => t(note).includes('MAFIA')));
    assert.equal(sheriff.intel.find((entry) => entry.kind === 'sheriff' && entry.targetSlot === 2)?.value, 'mafia');
  });

  /** And the needle names the blade rather than shrugging at it. */
  it('the sheriff names a lone killer', () => {
    const state = table(['sheriff', 'serial-killer', 'citizen', 'godfather', 'doctor', 'escort']);
    advanceMafia(state, 0, lcg(1));
    setNightAction(state, bySlot(state, 1).playerId, 2); // sheriff checks the serial killer
    advanceMafia(state, 1, lcg(1));
    const sheriff = bySlot(state, 1);
    assert.equal(
      sheriff.intel.find((entry) => entry.kind === 'sheriff' && entry.targetSlot === 2)?.value,
      'serial-killer'
    );
    assert.ok(sheriff.notifications.some((note) => t(note).includes('TUEUR EN SÉRIE')));
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
    // The gesture is a system announcement, so it is a key now: rendering it is
    // the assertion, because a key nobody can render is a leak of nothing.
    assert.ok(
      outsider.chat.some((m) => rendered(m).includes('murmure')),
      'the gesture is public'
    );
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
    const townWinners = purge.winners.filter((w) => w.kind === 'town');
    assert.equal(townWinners.length, 3);
  });

  /**
   * The endgame nobody has to sit through.
   *
   * A lone killer used to have exactly one victory condition — everybody left
   * is a bystander — so a Serial Killer and one Sheriff at dawn played out a
   * full day of a decided game and then a night, and only then heard the
   * headline. The Sheriff cannot hang him (one vote out of two never reaches a
   * majority), cannot outlive him and cannot hit back. That is the whole of
   * `beyondSaving`, and everything here is one of its exits.
   */
  describe('a lone killer wins the moment the last seat cannot stop him', () => {
    /** The ending, without a night in between: `checkVictory` on the morning. */
    const settles = (roles: RoleId[]): MafiaState => {
      const state = table(roles);
      checkVictory(state, 1000);
      return state;
    };

    it('crowns him against a seat with nothing to answer with', () => {
      for (const townie of ['sheriff', 'citizen', 'lookout', 'coroner'] as RoleId[]) {
        const state = settles(['serial-killer', townie]);
        assert.equal(state.phase, 'ended', `a serial killer beats a lone ${townie} without playing the night`);
        assert.ok(state.winners.some((w) => w.kind === 'solo-killer'));
      }
    });

    it('crowns the slow blades on the same morning', () => {
      // The fire and the poison take another night to land; the outcome does not.
      for (const killer of ['arsonist', 'poisoner', 'electromaniac', 'mass-murderer'] as RoleId[]) {
        assert.equal(settles([killer, 'citizen']).phase, 'ended', `${killer} against one citizen is over`);
      }
    });

    it('waits for the porch, the cell and the badge', () => {
      // A veteran shoots back at 2, a jailor's lever is 3, and a mayor who
      // stands up votes for three — which is the majority of two seats plus him.
      for (const clutch of ['veteran', 'jailor', 'mayor'] as RoleId[]) {
        assert.equal(settles(['serial-killer', clutch]).phase, 'day', `a ${clutch} still has the game`);
      }
    });

    it('waits for anything that can take the night away from him', () => {
      for (const clutch of ['escort', 'bus-driver'] as RoleId[]) {
        assert.equal(settles(['serial-killer', clutch]).phase, 'day', `a ${clutch} still has the game`);
      }
    });

    it('does not count a power that cannot be pointed at its own owner', () => {
      // Neither may heal or guard itself, so the last doctor alive is a doctor
      // who dies — and a rule that called that a rescue would never end.
      for (const alone of ['doctor', 'bodyguard'] as RoleId[]) {
        assert.equal(settles(['serial-killer', alone]).phase, 'ended', `a lone ${alone} cannot save itself`);
      }
    });

    it('weighs the blade against the armour rather than naming roles', () => {
      // The Stump does not die at night. A serial killer's blade is power 2 and
      // goes through that; a massacre is power 1 and never will.
      assert.equal(settles(['serial-killer', 'stump']).phase, 'ended');
      assert.equal(settles(['mass-murderer', 'stump']).phase, 'day');
      // And a bullet is power 1 against a killer who is night-immune to a man.
      assert.equal(settles(['serial-killer', 'vigilante']).phase, 'ended');
    });

    it('leaves a rope the room can still reach', () => {
      // Two seats out of three make the majority, so the day is a real day.
      assert.equal(settles(['serial-killer', 'citizen', 'citizen']).phase, 'day');
    });

    it('will not cut a rope that hangs the killer too', () => {
      // Grief takes the partner of anybody who dies, so this knife cannot be used.
      const state = table(['serial-killer', 'citizen']);
      const killer = bySlot(state, 1);
      const lover = bySlot(state, 2);
      killer.bondPartnerId = lover.playerId;
      killer.bondKind = 'lover';
      lover.bondPartnerId = killer.playerId;
      lover.bondKind = 'lover';
      checkVictory(state, 1000);
      assert.equal(state.phase, 'day');
    });
  });

  /**
   * A game that reaches the end and hangs somebody on the way.
   *
   * Every other test here checks one rule in isolation, and a fifteen-second
   * ballot lock passed all of them while making the game unplayable: the lock
   * is longer than a simulated day, so every vote in every game was refused and
   * nothing was ever hanged. Town win rate went from 45% to nought and the
   * suite stayed green, because nothing in it played a game to the end.
   *
   * So this asserts the coarsest possible thing, which is exactly what was
   * missing: games finish, ropes get pulled, and some of them are the right
   * ones.
   */
  it('plays whole games that actually hang people', () => {
    let lynches = 0;
    let evilLynches = 0;
    let decided = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const result = simulateGame({ players: 15, seed });
      lynches += result.lynches;
      evilLynches += result.evilLynches;
      if (result.winner !== 'draw') decided++;
    }
    assert.ok(lynches > 20, `twenty games produced only ${String(lynches)} hangings — the ballot is blocked`);
    assert.ok(evilLynches > 0, 'not one hanging in twenty games caught an evil seat');
    assert.ok(decided > 10, `only ${String(decided)} of twenty games reached a winner`);
  });

  it('a parasite wins only when the town does not', () => {
    // The Witch feeds on the town's failure, so the same seat has to lose one
    // ending and win the other. The gate used to be a French string comparison
    // against a second copy of itself; this holds it down whatever it is.
    const purged = table(['vigilante', 'mafioso', 'citizen', 'witch']);
    advanceMafia(purged, 0, lcg(1));
    setNightAction(purged, bySlot(purged, 1).playerId, 2);
    advanceMafia(purged, 1, lcg(1));
    assert.equal(purged.phase, 'ended');
    const survivingWitch = bySlot(purged, 4);
    assert.equal(survivingWitch.alive, true);
    assert.ok(!purged.winners.some((w) => w.playerId === survivingWitch.playerId));

    const overrun = table(['godfather', 'citizen', 'witch']);
    advanceMafia(overrun, 0, lcg(1));
    setNightAction(overrun, bySlot(overrun, 1).playerId, 2);
    advanceMafia(overrun, 1, lcg(1));
    assert.equal(overrun.phase, 'ended');
    const thrivingWitch = bySlot(overrun, 3);
    assert.equal(thrivingWitch.alive, true);
    assert.ok(overrun.winners.some((w) => w.playerId === thrivingWitch.playerId));
  });

  it('scores every solo win as a solo win, not only the hanged jester', () => {
    const state = table(['godfather', 'citizen', 'witch']);
    advanceMafia(state, 0, lcg(1));
    setNightAction(state, bySlot(state, 1).playerId, 2);
    advanceMafia(state, 1, lcg(1));

    const witch = bySlot(state, 3);
    const entry = state.points.find((point) => point.playerId === witch.playerId && point.reason === 'solo-win');
    assert.ok(entry, 'a lone winner banks a solo-win entry');

    /**
     * And the prose does not carry the fact.
     *
     * The career ledger used to count solo wins by testing the winner's `reason`
     * for 'gagne seul', a phrase only the hanged Jester's line contains — so
     * every other seat that wins alone banked the points and never the tally.
     * The structured entry above is the one source of that truth.
     */
    const win = state.winners.find((winner) => winner.playerId === witch.playerId);
    assert.ok(!(win && t(win.reason).includes('gagne seul')));
  });

  it('counts a revealed mayor the same way on the phone as in the threshold', () => {
    const state = table(['mayor', 'citizen', 'doctor', 'sheriff', 'godfather', 'mafioso']);
    const mayor = bySlot(state, 1);
    assert.equal(revealMayor(state, mayor.playerId, 1000).ok, true);
    assert.equal(castVote(state, mayor.playerId, 5, 2000).ok, true);

    // Three weighted votes on one head, and 5 of 8 still needed: no trial yet,
    // and the tally every screen renders says three rather than one.
    assert.equal(state.stage, 'discussion');
    const view = toMafiaView(state, { kind: 'host' });
    assert.equal(view.players.find((player) => player.slot === 5)?.votesAgainst, 3);
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

    // Serialize what the town view says about *people*: the word 'godfather'
    // must not appear anywhere in it while its owner breathes. The published role
    // list is deliberately excluded — it names the roles in play, which is the
    // one place that word is supposed to appear, and never says whose seat holds
    // one.
    const raw = JSON.stringify({ players: sheriffView.players, me: sheriffView.me, chat: sheriffView.chat });
    assert.ok(!raw.includes('godfather'));
  });

  /* ---------------- visits are complete before anything punishes one --------------- */

  /**
   * The whole class of bug these three cover: `visits` is read by the veteran's
   * porch, by the mass murderer's house and by the lookout's notebook, and it
   * used to be *written* by the investigators after two of those three had
   * already read it. So the town's most common visitors — its investigators —
   * walked through both retaliations untouched.
   */
  it('an alerted veteran shoots the investigators who call on him', () => {
    const state = table(['veteran', 'sheriff', 'lookout', 'citizen', 'mafioso']);
    advanceMafia(state, 0, lcg(3)); // night
    const veteran = bySlot(state, 1);

    setNightAction(state, veteran.playerId, veteran.slot); // on alert
    setNightAction(state, bySlot(state, 2).playerId, veteran.slot); // sheriff sounds him out
    setNightAction(state, bySlot(state, 3).playerId, veteran.slot); // lookout watches him
    advanceMafia(state, 1, lcg(3));

    assert.equal(bySlot(state, 2).alive, false, 'the sheriff walked onto the porch');
    assert.equal(bySlot(state, 3).alive, false, 'so did the lookout');
    assert.equal(veteran.alive, true);
  });

  it('records every visitor’s journey, result or none', () => {
    const state = table(['veteran', 'sheriff', 'doctor', 'citizen', 'mafioso']);
    advanceMafia(state, 0, lcg(3)); // night
    const veteran = bySlot(state, 1);

    setNightAction(state, veteran.playerId, veteran.slot); // on alert
    setNightAction(state, bySlot(state, 2).playerId, veteran.slot); // the sheriff calls
    setNightAction(state, bySlot(state, 3).playerId, bySlot(state, 4).slot); // the doctor goes elsewhere
    advanceMafia(state, 1, lcg(3));

    const sheriff = bySlot(state, 2);
    assert.equal(sheriff.alive, false, 'the porch is still the porch');
    assert.ok(
      sheriff.intel.some((entry) => entry.kind === 'went' && entry.targetSlot === 1),
      'the dead sheriff still carries where it went, which is what its will needs'
    );
    // A doctor who healed nobody used to leave no trace of the night at all.
    assert.ok(bySlot(state, 3).intel.some((entry) => entry.kind === 'went' && entry.targetSlot === 4));
  });

  it('the crier speaks into the night without a name', () => {
    const state = table(['crier', 'citizen', 'citizen', 'mafioso']);
    advanceMafia(state, 0, lcg(7)); // night
    const crier = bySlot(state, 1);

    const result = sayInChat(state, crier.playerId, 'day', 'Somebody here is lying.', 5);
    assert.equal(result.ok, true, 'the crier may speak after dark');
    if (!result.ok) return;
    assert.equal(result.message.authorId, null, 'and nobody learns which house');
    assert.equal(result.message.authorName, ANONYMOUS);
    assert.equal(result.message.text, 'Somebody here is lying.');

    const stored = state.chat.messages.find((message) => message.id === result.message.id);
    assert.equal(stored?.authorId, null, 'stripped in the log itself, not only in the reply');
  });

  it('echoes a seat’s night results into a channel only that seat can read', () => {
    const state = table(['sheriff', 'citizen', 'mafioso', 'doctor']);
    advanceMafia(state, 0, lcg(9)); // night
    const sheriff = bySlot(state, 1);
    setNightAction(state, sheriff.playerId, 3); // checks the mafioso
    advanceMafia(state, 1, lcg(9)); // dawn

    const own = state.chat.messages.filter((message) => message.channel === `self:${sheriff.playerId}`);
    assert.ok(own.length > 0, 'the result reached the square, privately');
    assert.ok(own.every((message) => message.kind === 'system'));
    // A bot reads its record, not a chat panel; echoing for it only fills the log.
    const bot = bySlot(state, 2);
    assert.equal(
      state.chat.messages.some((message) => message.channel === `self:${bot.playerId}`),
      false,
      'no echo for a bot'
    );

    const rules = chatRules();
    assert.equal(rules.canRead(`self:${sheriff.playerId}`, sheriff.playerId, state), true);
    assert.equal(rules.canRead(`self:${sheriff.playerId}`, bySlot(state, 2).playerId, state), false, 'nobody else');
    assert.equal(rules.canWrite(`self:${sheriff.playerId}`, sheriff.playerId, state), false, 'and nobody writes there');
  });

  it('the mass murderer kills everyone who visits the house he rampages', () => {
    const state = table(['mass-murderer', 'lookout', 'citizen', 'doctor', 'citizen']);
    advanceMafia(state, 0, lcg(4)); // night
    const victimSlot = 3;

    setNightAction(state, bySlot(state, 1).playerId, victimSlot);
    setNightAction(state, bySlot(state, 2).playerId, victimSlot); // watching the door
    setNightAction(state, bySlot(state, 4).playerId, victimSlot); // and a doctor calling in
    advanceMafia(state, 1, lcg(4));

    assert.equal(bySlot(state, 2).alive, false, 'the lookout was in the massacre');
    assert.equal(bySlot(state, 4).alive, false, 'the doctor could not heal through it');
    assert.equal(bySlot(state, 1).alive, true);
  });

  it('a lookout still sees the other investigators who called', () => {
    const state = table(['lookout', 'sheriff', 'citizen', 'citizen']);
    advanceMafia(state, 0, lcg(5)); // night
    const watched = bySlot(state, 3);

    setNightAction(state, bySlot(state, 1).playerId, watched.slot);
    setNightAction(state, bySlot(state, 2).playerId, watched.slot);
    advanceMafia(state, 1, lcg(5));

    const seen = bySlot(state, 1).intel.find((entry) => entry.kind === 'visitors');
    assert.deepEqual(seen?.slots, [2], 'the sheriff was on the doorstep too');
  });

  /* ------------------------- the court votes in secret ------------------------- */

  it('the judge is not identifiable from the public verdict', () => {
    const state = table(['judge', 'citizen', 'citizen', 'citizen', 'mafioso']);
    const judge = bySlot(state, 1);
    judge.charges = 1;

    // Two accusations put the mafioso on top, then the judge convenes the court.
    castVote(state, bySlot(state, 2).playerId, 5, 0);
    castVote(state, bySlot(state, 3).playerId, 5, 0);
    assert.equal(callCourt(state, judge.playerId, 10).ok, true);

    castBallot(state, judge.playerId, 'guilty');
    castBallot(state, bySlot(state, 2).playerId, 'guilty');
    advanceMafia(state, 20, lcg(6));

    const spoken = said(state);
    // The weighted tally is public; the names that would give the weight away are not.
    assert.ok(spoken.includes('Verdict : 4 coupable'), 'the tally still lands');
    assert.ok(!spoken.includes('Ont voté coupable'), 'no roll call to subtract from');
    assert.ok(spoken.includes('bulletin secret'));
    // But the record keeps every hand, for the end-of-game reveal.
    const logged = state.trialLog?.at(-1);
    assert.equal(logged?.guiltyIds.length, 2);
  });

  it('an ordinary trial still publishes who wanted the rope', () => {
    const state = table(['citizen', 'citizen', 'citizen', 'mafioso']);
    castVote(state, bySlot(state, 1).playerId, 4, 0);
    castVote(state, bySlot(state, 2).playerId, 4, 0);
    castVote(state, bySlot(state, 3).playerId, 4, 0);
    assert.equal(state.stage, 'defense', 'the threshold fell');

    advanceMafia(state, 10, lcg(7)); // to judgement
    castBallot(state, bySlot(state, 1).playerId, 'guilty');
    castBallot(state, bySlot(state, 2).playerId, 'innocent');
    advanceMafia(state, 20, lcg(7));

    const spoken = said(state);
    assert.ok(spoken.includes('Ont voté coupable'), 'the roll call is safe without a hidden weight');
  });

  it('an accusation moves the count without posting a line', () => {
    const state = table(['citizen', 'citizen', 'citizen', 'citizen', 'mafioso']);
    const before = state.chat.messages.length;
    castVote(state, bySlot(state, 1).playerId, 5, 0);
    castVote(state, bySlot(state, 1).playerId, 4, 0); // changed their mind
    assert.equal(state.chat.messages.length, before, 'the square stays quiet');

    const view = toMafiaView(state, { kind: 'player', playerId: bySlot(state, 2).playerId });
    const accused = view.players.find((player) => player.slot === 4);
    assert.equal(accused?.votesAgainst, 1, 'the list carries the count instead');
    assert.equal(view.players.find((player) => player.slot === 1)?.votedSlot, 4);
  });

  /* --------------------- what a corpse gives away --------------------- */

  /**
   * Hangs the Godfather in slot 5 under the given policy, leaving a Mafioso alive
   * so the game does *not* end — otherwise the end-of-game reveal would lift the
   * policy and the assertion would be measuring the wrong moment.
   */
  function lynchUnder(reveal: 'role' | 'faction' | 'none') {
    const state = table(['citizen', 'citizen', 'citizen', 'citizen', 'godfather', 'mafioso']);
    state.config.revealOnDeath = reveal;
    for (const slot of [1, 2, 3, 4]) castVote(state, bySlot(state, slot).playerId, 5, 0);
    advanceMafia(state, 10, lcg(9)); // defense → judgement
    for (const slot of [1, 2, 3, 4]) castBallot(state, bySlot(state, slot).playerId, 'guilty');
    advanceMafia(state, 20, lcg(9));
    assert.equal(bySlot(state, 5).alive, false, 'the godfather hanged');
    assert.notEqual(state.phase, 'ended', 'and the game goes on, so the policy still applies');
    return {
      state,
      said: said(state),
      row: toMafiaView(state, { kind: 'player', playerId: bySlot(state, 1).playerId }).players.find(
        (player) => player.slot === 5
      )!
    };
  }

  it('reveals the whole role when the table asks for it', () => {
    const { said, row } = lynchUnder('role');
    assert.equal(t(row.roleName!), 'Parrain');
    assert.equal(row.faction, 'mafia');
    assert.ok(said.includes('Parrain'));
  });

  it('names only the camp under the faction policy', () => {
    const { said, row } = lynchUnder('faction');
    assert.equal(row.roleName, null, 'the role stays secret');
    assert.equal(row.role, null);
    assert.equal(row.faction, 'mafia', 'but the camp is public');
    assert.ok(said.includes('de la Mafia'));
    assert.ok(!said.includes('Parrain'), 'the exact role never reaches the square');
  });

  it('gives away nothing when the table reveals nothing', () => {
    const { said, row } = lynchUnder('none');
    assert.equal(row.role, null);
    assert.equal(row.roleName, null);
    assert.equal(row.faction, null);
    assert.ok(!said.includes('Parrain'));
    assert.ok(!said.includes('de la Mafia'));
    assert.ok(said.includes('Son secret est mort avec lui'));
  });

  it('the end of the game lifts every policy', () => {
    // One lone godfather, so hanging him purges the town and ends it there.
    const state = table(['citizen', 'citizen', 'citizen', 'godfather']);
    state.config.revealOnDeath = 'none';
    for (const slot of [1, 2, 3]) castVote(state, bySlot(state, slot).playerId, 4, 0);
    advanceMafia(state, 10, lcg(9));
    for (const slot of [1, 2, 3]) castBallot(state, bySlot(state, slot).playerId, 'guilty');
    advanceMafia(state, 20, lcg(9));

    assert.equal(state.phase, 'ended');
    const row = toMafiaView(state, { kind: 'host' }).players.find((player) => player.slot === 4)!;
    assert.equal(t(row.roleName!), 'Parrain', 'the masks come off regardless');
    assert.equal(row.faction, 'mafia');
  });

  /**
   * The three carve-outs that are mechanics rather than presentation: a cleaned
   * body says nothing whatever the policy, a borrowed face never reaches the
   * slab, and a role that was genuinely changed reveals what it became.
   */
  it('a borrowed face does not change what the body says', () => {
    // The mafioso is here so the family has a knife of its own: a one-man
    // family of Disguisers cannot kill, and `promoteCarriers` would hand this
    // seat the knife at dusk and stop it being a Disguiser at all.
    const state = table(['disguiser', 'sheriff', 'citizen', 'vigilante', 'mafioso']);
    state.config.revealOnDeath = 'role';
    advanceMafia(state, 0, lcg(11)); // night
    const disguiser = bySlot(state, 1);
    // Wear the sheriff's face, and get shot for it the same night.
    setNightAction(state, disguiser.playerId, 2);
    setNightAction(state, bySlot(state, 4).playerId, 1);
    advanceMafia(state, 1, lcg(11));

    assert.equal(disguiser.alive, false);
    const row = toMafiaView(state, { kind: 'host' }).players.find((player) => player.slot === 1)!;
    assert.equal(t(row.roleName!), 'Imposteur', 'the undertaker is not fooled');
    assert.equal(row.faction, 'mafia');
  });

  it('a cleaned corpse stays anonymous even under the full-reveal policy', () => {
    const state = table(['janitor', 'mafioso', 'citizen', 'citizen', 'citizen', 'doctor']);
    state.config.revealOnDeath = 'role';
    bySlot(state, 1).charges = 2;
    advanceMafia(state, 0, lcg(13)); // night
    setNightAction(state, bySlot(state, 2).playerId, 4); // the family kills slot 4
    setNightAction(state, bySlot(state, 1).playerId, 4); // and the janitor tidies up
    advanceMafia(state, 1, lcg(13));

    assert.equal(bySlot(state, 4).alive, false);
    const row = toMafiaView(state, { kind: 'host' }).players.find((player) => player.slot === 4)!;
    assert.equal(row.roleName, null);
    assert.equal(row.faction, null, 'not even the camp leaks');
  });

  /**
   * The shared-screen contract: every line that names an identity is flagged at
   * the source, so a television can hold it back without reading French. If this
   * breaks, the TV's spoiler mode silently starts leaking.
   */
  it('flags every announcement that gives an identity away', () => {
    const { state } = lynchUnder('role');
    const day = state.chat.messages.filter((message) => message.channel === 'day' && message.kind === 'system');

    const gallows = day.find((message) => rendered(message).includes('se balance au bout de la corde'))!;
    assert.equal(gallows.reveals, true, 'the gallows names the body');

    const verdict = day.find((message) => rendered(message).startsWith('Verdict :'))!;
    assert.notEqual(verdict.reveals, true, 'a tally is not an identity');

    const rollCall = day.find((message) => rendered(message).startsWith('Ont voté coupable'))!;
    assert.notEqual(rollCall.reveals, true, 'who wanted the rope is a vote, not a role');

    // And nothing carrying a role name is left unflagged.
    const leaked = day.filter((message) => !message.reveals && rendered(message).includes('Parrain'));
    assert.deepEqual(leaked, [], 'an unflagged line named a role');
  });

  it('flags the dawn report and the closing roster too', () => {
    const state = table(['mafioso', 'citizen', 'citizen', 'doctor', 'sheriff']);
    advanceMafia(state, 0, lcg(21)); // night
    setNightAction(state, bySlot(state, 1).playerId, 2); // the family kills slot 2
    advanceMafia(state, 1, lcg(21));

    const dawn = state.chat.messages.find((message) => rendered(message).includes('a été retrouvé mort'))!;
    assert.equal(dawn.reveals, true, 'the dawn report names the body and its killer');

    const quiet = state.chat.messages.find((message) => rendered(message).includes('Fermez vos portes'));
    assert.notEqual(quiet?.reveals, true, 'nightfall is not a reveal');
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

  /**
   * The end of a game is still a morning: the bodies that ended it are named
   * before the headline, and a town nobody survived did not win anything.
   */
  it('reads out the last night before the last word, and gives an empty town to nobody', () => {
    const state = table(['judge', 'poisoner', 'serial-killer'], 7);
    const judge = bySlot(state, 1);
    const poisoner = bySlot(state, 2);
    const killer = bySlot(state, 3);

    advanceMafia(state, 0, lcg(5)); // night 7
    setNightAction(state, poisoner.playerId, 3); // the dose, which takes a night
    advanceMafia(state, 1, lcg(5)); // day 8, everybody still up
    assert.equal(state.phase, 'day');

    advanceMafia(state, 2, lcg(5)); // night 8
    setNightAction(state, killer.playerId, 2); // the blade, while the poison works
    advanceMafia(state, 3, lcg(5)); // dawn: both killers go

    assert.equal(poisoner.alive, false, 'the blade lands');
    assert.equal(killer.alive, false, 'and so does the poison');
    assert.equal(judge.alive, true, 'the judge is the last one standing');

    const transcript = said(state);
    assert.ok(transcript.includes(poisoner.name), 'the poisoner is named in the dawn report');
    assert.ok(transcript.includes(killer.name), 'and so is the killer');

    assert.equal(state.phase, 'ended');
    assert.ok(!transcript.includes('La Ville l’emporte'), 'a town with nobody in it wins nothing');
    assert.ok(transcript.includes('Il ne reste personne à sauver'), 'the empty-town ending, said as such');
    const win = state.winners.find((entry) => entry.playerId === judge.playerId);
    assert.ok(win, 'the judge wins: the town lost, which is the whole of its condition');
  });

  /**
   * The judge's court needs a defendant the room actually named. A square split
   * down the middle has not named one, and picking whichever id came first is
   * how a seven-against-seven afternoon put somebody on the stand with no
   * defence and no reason.
   */
  it('refuses the judge’s court while the square is tied, and keeps the charge', () => {
    const state = table(['judge', 'citizen', 'citizen', 'citizen', 'citizen', 'godfather', 'mafioso']);
    const judge = bySlot(state, 1);
    judge.charges = 1;

    castVote(state, bySlot(state, 2).playerId, 4, 2000);
    castVote(state, bySlot(state, 3).playerId, 5, 2010);

    const split = callCourt(state, judge.playerId, 2100);
    assert.equal(split.ok, false, 'two houses level at the top is not an accusation');
    assert.equal(state.trial, null);
    assert.equal(judge.charges, 1, 'and the charge is still in his pocket');

    // The room makes up its mind, and the court sits.
    castVote(state, bySlot(state, 6).playerId, 4, 2200);
    const called = callCourt(state, judge.playerId, 2300);
    assert.equal(called.ok, true);
    assert.equal(state.players[state.trial!.accusedId]?.slot, 4);
    assert.equal(judge.charges, 0);
  });

  it('the spy hears the family without a byline, and not at all once dead', () => {
    const state = table(['spy', 'godfather', 'mafioso', 'citizen', 'doctor', 'escort']);
    advanceMafia(state, 0, lcg(1)); // night

    const gf = bySlot(state, 2);
    assert.equal(sayInChat(state, gf.playerId, 'mafia', 'on tue le shérif', 10).ok, true);
    const posted = state.chat.messages.find((message) => message.channel === 'mafia')!;

    const spy = bySlot(state, 1);
    const heard = chatVisibleTo(state, spy.playerId).filter((message) => message.channel === 'mafia');
    assert.equal(heard.length, 1, 'the ear is at the wall');
    assert.equal(heard[0].authorId, null, 'and never sees a face');
    assert.equal(heard[0].authorName, ANONYMOUS);

    // The same line also goes out on its own between broadcasts, muffled there too.
    assert.equal(chatLineFor(state, spy.playerId, posted).authorName, ANONYMOUS);
    assert.equal(chatLineFor(state, bySlot(state, 3).playerId, posted).authorName, gf.name, 'the family sees its own');

    spy.alive = false;
    assert.equal(chatRules().canRead('mafia', spy.playerId, state), false, 'a corpse eavesdrops on nobody');
    const ghostView = toMafiaView(state, { kind: 'player', playerId: spy.playerId });
    assert.ok(ghostView.chat.every((message) => message.channel !== 'mafia'));
    assert.ok(ghostView.me?.channels.every((channel) => channel.id !== 'mafia'));
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
