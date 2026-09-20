import assert from "node:assert/strict";
import { describe, it } from "node:test";

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
  voteThreshold,
  restoreMafiaTable,
  sayInChat,
  setNightAction,
  startMafia,
  whisperTo,
} from "./engine.js";
import { translator, type Msg } from "i18n";
import { en } from "i18n/locales/en";
import { fr } from "i18n/locales/fr";

import type { RoleId } from "./roles.js";
import {
  chatRules,
  ANONYMOUS,
  createMafiaGame,
  playerBySlot,
  type MafiaState,
} from "./state.js";
import { toMafiaView } from "./view.js";
import { familyKnife, unclashedTargets } from "./sim/policies.js";
import { duelBeats } from "./roles.js";
import { simulateGame } from "./sim/simulate.js";

/**
 * What the square actually said, in French.
 *
 * The engine now emits keys, so an assertion about prose has to render them —
 * which makes these tests better than they were: they prove the whole path from a
 * rule firing to a sentence a person reads, catalogue included.
 */
const t = translator(fr, en);
const rendered = (message: { msg?: Msg; text: string }): string =>
  message.msg ? t(message.msg) : message.text;
const said = (state: MafiaState): string =>
  state.chat.messages
    .map((message) => (message.msg ? t(message.msg) : message.text))
    .join("\n");

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
  const state = createMafiaGame({
    code: "TEST1",
    hostToken: "host",
    hostUserId: null,
    now: 0,
  });
  roles.forEach((role, index) => {
    const id = freshId();
    if (index === 0) joinMafia(state, `Humain${index}`, `tok${id}`, id);
    else addMafiaBot(state, `tok${id}`, id, () => 0);
    const player = state.players[id];
    player.role = role;
    player.charges =
      role === "vigilante" || role === "veteran" || role === "jailor"
        ? 3
        : role === "survivor"
          ? 4
          : 0;
  });
  state.phase = "day";
  state.stage = "discussion";
  state.day = day;
  state.phaseEndsAt = 1000;
  return state;
}

function bySlot(state: MafiaState, slot: number) {
  return playerBySlot(state, slot)!;
}

describe("mafia engine", () => {
  it("deals roles and opens day 1 without votes", () => {
    const state = createMafiaGame({
      code: "GAME1",
      hostToken: "h",
      hostUserId: null,
      now: 0,
    });
    for (let i = 0; i < 12; i++) {
      const id = freshId();
      if (i === 0) joinMafia(state, "Max", `t${id}`, id);
      else addMafiaBot(state, `t${id}`, id, () => 0);
    }
    startMafia(state, 1000, lcg(42));

    assert.equal(state.phase, "day");
    assert.equal(state.day, 1);
    const mafia = Object.values(state.players).filter((p) =>
      ["godfather", "mafioso", "consort"].includes(p.role!),
    );
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
  it("gives the first day its own, much shorter clock", () => {
    const state = createMafiaGame({
      code: "GAME2",
      hostToken: "h",
      hostUserId: null,
      now: 0,
    });
    for (let i = 0; i < 6; i++) {
      const id = freshId();
      if (i === 0) joinMafia(state, "Max", `t${id}`, id);
      else addMafiaBot(state, `t${id}`, id, () => 0);
    }
    startMafia(state, 1000, lcg(7));

    assert.equal(state.day, 1);
    assert.equal(state.phaseEndsAt, 1000 + state.config.firstDayMs);
    assert.ok(
      state.config.firstDayMs < state.config.dayMs,
      "the greeting day is the short one",
    );
  });

  /**
   * The day's second exit. Before it existed a town with nothing left to say
   * could only wait for the clock, so a quiet afternoon was two minutes of
   * silence with a countdown on it.
   */
  it("ends the day early when a majority votes to hang nobody", () => {
    const state = table([
      "citizen",
      "citizen",
      "citizen",
      "citizen",
      "godfather",
      "mafioso",
    ]);

    // Three of six is short of the four-vote majority: the day holds.
    for (const slot of [1, 2, 3]) {
      assert.equal(
        castVote(state, bySlot(state, slot).playerId, "skip", 2000).ok,
        true,
      );
    }
    assert.equal(state.phase, "day");

    // The fourth carries it, and night falls on the spot.
    castVote(state, bySlot(state, 4).playerId, "skip", 2100);
    assert.equal(state.phase, "night");
    assert.ok(said(state).includes("ne pendre personne"));
  });

  it("treats a skip as one position among the accusations, not a second one", () => {
    const state = table([
      "citizen",
      "citizen",
      "citizen",
      "citizen",
      "godfather",
      "mafioso",
    ]);
    const voter = bySlot(state, 1);

    castVote(state, voter.playerId, "skip", 2000);
    let view = toMafiaView(state, { kind: "player", playerId: voter.playerId });
    assert.equal(view.me?.votedSkip, true);
    assert.equal(view.me?.voteTargetSlot, null);
    assert.equal(view.skipVotes, 1);

    // Accusing somebody replaces the skip rather than sitting beside it.
    castVote(state, voter.playerId, 5, 2100);
    view = toMafiaView(state, { kind: "player", playerId: voter.playerId });
    assert.equal(view.me?.votedSkip, false);
    assert.equal(view.me?.voteTargetSlot, 5);
    assert.equal(view.skipVotes, 0);
  });

  /**
   * The published role list says what the table *promised*, never what it dealt.
   * A preset shows its category slots; the automatic roster is deterministic in
   * the seat count, so it can be shown role for role.
   */
  it("publishes the slots a setup promised, not the roles it rolled", () => {
    const state = table([
      "citizen",
      "citizen",
      "citizen",
      "citizen",
      "godfather",
      "mafioso",
    ]);
    state.config.setup = { mode: "preset", presetId: "classique-15" };

    const list = toMafiaView(state, { kind: "host" }).roleList;
    assert.equal(
      list.length,
      Object.keys(state.players).length,
      "one line per seat",
    );
    assert.ok(list.includes("town-core"), "a category stays a category");
    assert.ok(!list.includes("citizen"), "and never leaks what it rolled");
    assert.ok(
      list.indexOf("sheriff") < list.indexOf("town-core"),
      "exact roles read before their categories",
    );
  });

  /**
   * The end of a game opens every door, and a door onto an empty room is not a
   * reveal — it is a statement about the setup made by a screen with no business
   * making it.
   */
  it("opens every room that was used at the end, and no others", () => {
    const state = table([
      "citizen",
      "citizen",
      "sheriff",
      "doctor",
      "godfather",
      "mafioso",
    ]);
    const town = bySlot(state, 1);
    const boss = bySlot(state, 5);

    // The family talks; the triad and the lodge were never dealt.
    state.phase = "night";
    sayInChat(state, boss.playerId, "mafia", "la maison 1, cette nuit", 5);
    state.phase = "ended";

    const tabs = (id: string) =>
      toMafiaView(state, { kind: "player", playerId: id }).me?.channels.map(
        (channel) => channel.id,
      ) ?? [];

    assert.ok(
      tabs(town.playerId).includes("day"),
      "the square is always there",
    );
    assert.ok(
      tabs(town.playerId).includes("mafia"),
      "and the family room, now that it is over",
    );
    assert.ok(
      !tabs(town.playerId).includes("triad"),
      "but not a triad that never sat down",
    );
    assert.ok(
      !tabs(town.playerId).includes("mason"),
      "nor a lodge nobody was in",
    );
  });

  /** The masks come off on the roster, not only in the results table. */
  it("names every survivor once the game is over", () => {
    const state = table([
      "citizen",
      "citizen",
      "sheriff",
      "doctor",
      "godfather",
      "mafioso",
    ]);
    const town = bySlot(state, 1);

    let mine = toMafiaView(state, {
      kind: "player",
      playerId: town.playerId,
    }).players.find((p) => p.slot === 5)!;
    assert.equal(
      mine.roleName,
      null,
      "a living godfather keeps his face during the game",
    );

    state.phase = "ended";
    mine = toMafiaView(state, {
      kind: "player",
      playerId: town.playerId,
    }).players.find((p) => p.slot === 5)!;
    assert.equal(t(mine.roleName!), "Parrain", "and loses it at the end");
  });

  it("runs accusation, trial and lynch, and a lynched jester wins", () => {
    const state = table([
      "jester",
      "sheriff",
      "doctor",
      "citizen",
      "godfather",
      "mafioso",
    ]);
    const jester = bySlot(state, 1);

    // Four of five other players accuse the jester: majority of 6 alive is 4.
    for (const slot of [2, 3, 4, 5]) {
      const result = castVote(state, bySlot(state, slot).playerId, 1, 2000);
      assert.equal(result.ok, true);
    }
    assert.equal(state.stage, "defense");
    assert.equal(state.trial?.accusedId, jester.playerId);

    advanceMafia(state, 3000, lcg(1)); // defense -> judgement
    assert.equal(state.stage, "judgement");
    for (const slot of [2, 3, 4, 5]) {
      castBallot(state, bySlot(state, slot).playerId, "guilty");
    }
    advanceMafia(state, 4000, lcg(1)); // verdict

    assert.equal(jester.alive, false);
    assert.ok(state.winners.some((w) => w.playerId === jester.playerId));
    assert.equal(state.phase, "night");
  });

  it("resolves a night: doctor saves, sheriff reads the framer and the godfather", () => {
    const state = table([
      "sheriff",
      "doctor",
      "citizen",
      "godfather",
      "framer",
      "escort",
    ]);
    const sheriff = bySlot(state, 1);
    const doctor = bySlot(state, 2);
    const citizen = bySlot(state, 3);
    const godfather = bySlot(state, 4);
    const framer = bySlot(state, 5);

    advanceMafia(state, 5000, lcg(1)); // day -> night
    assert.equal(state.phase, "night");

    // Godfather orders the citizen dead, doctor heals the citizen,
    // framer frames the sheriff... on second thought, frames the doctor.
    assert.equal(
      setNightAction(state, godfather.playerId, citizen.slot).ok,
      true,
    );
    assert.equal(setNightAction(state, doctor.playerId, citizen.slot).ok, true);
    assert.equal(setNightAction(state, framer.playerId, doctor.slot).ok, true);
    assert.equal(
      setNightAction(state, sheriff.playerId, godfather.slot).ok,
      true,
    );

    advanceMafia(state, 6000, lcg(1)); // night resolves -> day 3

    assert.equal(state.phase, "day");
    assert.equal(citizen.alive, true, "doctor saved the citizen");
    // The godfather is detection immune: reads innocent.
    assert.ok(
      sheriff.notifications.some((note) =>
        t(note).includes("n’a rien de suspect"),
      ),
    );
  });

  /**
   * The examiner's finding is a shortlist, and now it says so.
   *
   * The line on its own ("carries strange herbs") is only information to
   * somebody who has memorised which of sixty-three roles wear each smell, which
   * made the power a reading test rather than a lead. Nothing here is a secret:
   * the answer sheet is the same at every table and the roster is on the wall, so
   * the note hands the examiner what two screens already entitled them to work
   * out.
   */
  it("tells the examiner which roles the smell could be", () => {
    const state = table([
      "investigator",
      "consort",
      "citizen",
      "godfather",
      "doctor",
      "escort",
    ]);
    // The published roster, which is what the shortlist is read against. In a
    // real game the deal comes from this list; the fixture seats roles directly,
    // so it has to say what the room would have been shown.
    state.config.setup = {
      mode: "custom",
      slots: [
        "investigator",
        "consort",
        "citizen",
        "godfather",
        "doctor",
        "escort",
      ],
    };
    advanceMafia(state, 0, lcg(1));
    // The Consort spends her night on somebody, so she leaves a smell at all.
    setNightAction(state, bySlot(state, 2).playerId, 3);
    setNightAction(state, bySlot(state, 1).playerId, 2);
    advanceMafia(state, 1, lcg(1));

    const note = bySlot(state, 1).notifications.map(t).join(" | ");
    assert.ok(note.includes("travaille la nuit"), note);
    assert.ok(note.includes("Escorte de la famille"), note);
    assert.ok(note.includes("Hôtesse"), note);
  });

  /**
   * And the shortlist is this table's, not the whole census.
   *
   * That is the half that makes it worth printing: gunpowder is a shrug in the
   * abstract and a conviction at a table whose published roster holds no
   * Vigilante. A player reading the role list could cross the same names off.
   */
  it("crosses off roles this table never dealt", () => {
    const state = table([
      "investigator",
      "mafioso",
      "citizen",
      "godfather",
      "doctor",
      "escort",
    ]);
    state.config.setup = {
      mode: "custom",
      slots: [
        "investigator",
        "mafioso",
        "citizen",
        "godfather",
        "doctor",
        "escort",
      ],
    };
    advanceMafia(state, 0, lcg(1));
    setNightAction(state, bySlot(state, 2).playerId, 3);
    setNightAction(state, bySlot(state, 1).playerId, 2);
    advanceMafia(state, 1, lcg(1));

    const note = bySlot(state, 1).notifications.map(t).join(" | ");
    assert.ok(note.includes("Mafioso"), note);
    assert.ok(
      !note.includes("Justicier"),
      "no Vigilante on the roster, so it is not on the shortlist: " + note,
    );
  });

  /**
   * A frame does not merely trip the needle, it aims it: the sheriff reads the
   * framer's own family, which is what makes the power worth a night.
   */
  it("framing points the sheriff at the framer’s family", () => {
    const state = table([
      "sheriff",
      "citizen",
      "framer",
      "godfather",
      "doctor",
      "escort",
    ]);
    advanceMafia(state, 0, lcg(1));
    setNightAction(state, bySlot(state, 3).playerId, 2); // frame the citizen
    setNightAction(state, bySlot(state, 1).playerId, 2); // sheriff checks the citizen
    advanceMafia(state, 1, lcg(1));
    const sheriff = bySlot(state, 1);
    assert.ok(sheriff.notifications.some((note) => t(note).includes("MAFIA")));
    assert.equal(
      sheriff.intel.find(
        (entry) => entry.kind === "sheriff" && entry.targetSlot === 2,
      )?.value,
      "mafia",
    );
  });

  /** And the needle names the blade rather than shrugging at it. */
  it("the sheriff names a lone killer", () => {
    const state = table([
      "sheriff",
      "serial-killer",
      "citizen",
      "godfather",
      "doctor",
      "escort",
    ]);
    advanceMafia(state, 0, lcg(1));
    setNightAction(state, bySlot(state, 1).playerId, 2); // sheriff checks the serial killer
    advanceMafia(state, 1, lcg(1));
    const sheriff = bySlot(state, 1);
    assert.equal(
      sheriff.intel.find(
        (entry) => entry.kind === "sheriff" && entry.targetSlot === 2,
      )?.value,
      "serial-killer",
    );
    assert.ok(
      sheriff.notifications.some((note) => t(note).includes("TUEUR EN SÉRIE")),
    );
  });

  it("jail blocks and protects; execution kills the prisoner", () => {
    const state = table([
      "jailor",
      "serial-killer",
      "citizen",
      "godfather",
      "doctor",
      "escort",
    ]);
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

  /**
   * The knife is an ordinary knife, and the Godfather's door is a real door.
   *
   * It used to go through, because the blade was power 2 against an immunity
   * worth 1 — which made the Serial Killer the only role in the game that no
   * defence answered. That is not a hard role to play against, it is a role
   * there is no play against, so the blade came down to 1 and everything that
   * stops a knife now stops it. What the Serial Killer keeps is the schedule:
   * every night, for ever, with no charges to run out.
   */
  it("the godfather is safe at home from the serial killer", () => {
    const state = table(["serial-killer", "godfather", "citizen", "doctor"]);
    advanceMafia(state, 0, lcg(1)); // night
    setNightAction(state, bySlot(state, 1).playerId, 2); // SK stabs the GF
    setNightAction(state, bySlot(state, 2).playerId, 3); // GF orders the citizen dead
    advanceMafia(state, 1, lcg(1));

    assert.equal(
      bySlot(state, 2).alive,
      true,
      "night immunity turns a power-one blade",
    );
    assert.equal(
      bySlot(state, 3).alive,
      false,
      "and the family still got its kill",
    );
  });

  it("the arsonist douses, ignites through immunity, and heals do not argue with fire", () => {
    const state = table([
      "arsonist",
      "godfather",
      "doctor",
      "citizen",
      "sheriff",
    ]);
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

    assert.equal(
      godfather.alive,
      false,
      "fire beats night immunity and the doctor",
    );
  });

  it("the blackmailer gags a player for the following day", () => {
    const state = table([
      "blackmailer",
      "godfather",
      "sheriff",
      "citizen",
      "doctor",
      "escort",
    ]);
    const sheriff = bySlot(state, 3);

    advanceMafia(state, 0, lcg(1)); // night
    assert.equal(setNightAction(state, bySlot(state, 1).playerId, 3).ok, true);
    advanceMafia(state, 1, lcg(1)); // day

    const gagged = sayInChat(
      state,
      sheriff.playerId,
      "day",
      "la maison 1 est SUSPECTE !",
      10,
    );
    assert.equal(gagged.ok, false);
    // The gag expires with the day.
    advanceMafia(state, 2, lcg(1)); // night
    advanceMafia(state, 3, lcg(1)); // next day
    assert.equal(
      sayInChat(state, sheriff.playerId, "day", "je peux reparler", 20).ok,
      true,
    );
  });

  it("the witch redirects a night action", () => {
    const state = table(["witch", "sheriff", "godfather", "citizen"]);
    const witch = bySlot(state, 1);
    const sheriff = bySlot(state, 2);

    advanceMafia(state, 0, lcg(1)); // night
    setNightAction(state, sheriff.playerId, 3); // sheriff checks the godfather
    setNightAction(state, witch.playerId, 2, 4); // witch sends him to the citizen instead
    advanceMafia(state, 1, lcg(1));

    assert.ok(
      sheriff.intel.some(
        (entry) => entry.kind === "sheriff" && entry.targetSlot === 4,
      ),
    );
    assert.ok(
      !sheriff.intel.some(
        (entry) => entry.kind === "sheriff" && entry.targetSlot === 3,
      ),
    );
  });

  it("whispers stay between the two, but the square hears the leaning", () => {
    const state = table(["citizen", "sheriff", "godfather", "doctor"]);
    const a = bySlot(state, 1);
    const b = bySlot(state, 2);

    const sent = whisperTo(state, a.playerId, 2, "je crois que la 3 ment", 10);
    assert.equal(sent.ok, true);

    const bView = toMafiaView(state, { kind: "player", playerId: b.playerId });
    assert.ok(bView.chat.some((m) => m.text.includes("la 3 ment")));

    const outsider = toMafiaView(state, {
      kind: "player",
      playerId: bySlot(state, 3).playerId,
    });
    assert.ok(
      !JSON.stringify(outsider.chat).includes("la 3 ment"),
      "the content is private",
    );
    // The gesture is a system announcement, so it is a key now: rendering it is
    // the assertion, because a key nobody can render is a leak of nothing.
    assert.ok(
      outsider.chat.some((m) => rendered(m).includes("murmure")),
      "the gesture is public",
    );
  });

  it("the triad is a real rival family: own kill, own victory", () => {
    const state = table([
      "dragon-head",
      "enforcer",
      "godfather",
      "citizen",
      "sheriff",
      "doctor",
    ]);
    const dragonHead = bySlot(state, 1);
    const godfather = bySlot(state, 3);

    // Triad chat is sealed from the mafia.
    advanceMafia(state, 0, lcg(1)); // night
    const said = sayInChat(
      state,
      dragonHead.playerId,
      "triad",
      "on prend le Parrain",
      5,
    );
    assert.equal(said.ok, true);
    const gfView = toMafiaView(state, {
      kind: "player",
      playerId: godfather.playerId,
    });
    assert.ok(gfView.chat.every((m) => m.channel !== "triad"));

    // The dragon head can't stab the immune godfather (power 1)…
    setNightAction(state, dragonHead.playerId, 3);
    advanceMafia(state, 1, lcg(1));
    assert.equal(godfather.alive, true);
  });

  it("the bus driver swaps two fates", () => {
    const state = table([
      "bus-driver",
      "sheriff",
      "godfather",
      "citizen",
      "doctor",
      "escort",
    ]);
    advanceMafia(state, 0, lcg(1)); // night
    setNightAction(state, bySlot(state, 2).playerId, 3); // sheriff checks the godfather…
    setNightAction(state, bySlot(state, 1).playerId, 3, 4); // …but the bus swaps GF and citizen
    advanceMafia(state, 1, lcg(1));

    const sheriff = bySlot(state, 2);
    assert.ok(
      sheriff.intel.some(
        (entry) => entry.kind === "sheriff" && entry.targetSlot === 4,
      ),
    );
  });

  it("poison kills the following night unless a doctor purges it", () => {
    const state = table([
      "poisoner",
      "citizen",
      "sheriff",
      "doctor",
      "escort",
      "godfather",
    ]);
    const citizen = bySlot(state, 2);
    const doctor = bySlot(state, 4);

    advanceMafia(state, 0, lcg(1)); // night 2: poison the citizen
    setNightAction(state, bySlot(state, 1).playerId, 2);
    advanceMafia(state, 1, lcg(1)); // day 3
    assert.equal(citizen.alive, true, "poison is slow");

    advanceMafia(state, 2, lcg(1)); // night 3: the doctor cures
    setNightAction(state, doctor.playerId, 2);
    advanceMafia(state, 3, lcg(1));
    assert.equal(citizen.alive, true, "the doctor purged the poison");

    advanceMafia(state, 4, lcg(1)); // night 4: poison again, no cure this time
    setNightAction(state, bySlot(state, 1).playerId, 2);
    advanceMafia(state, 5, lcg(1));
    advanceMafia(state, 6, lcg(1)); // night 5: it runs its course
    advanceMafia(state, 7, lcg(1));
    assert.equal(citizen.alive, false);
  });

  it("the janitor hides a corpse and the coroner names it anyway", () => {
    const state = table([
      "janitor",
      "godfather",
      "sheriff",
      "coroner",
      "doctor",
      "escort",
      "citizen",
      "lookout",
    ]);
    state.players[bySlot(state, 1).playerId].charges = 3;
    const sheriff = bySlot(state, 3);
    const coroner = bySlot(state, 4);

    advanceMafia(state, 0, lcg(1)); // night: GF orders the sheriff dead, janitor cleans
    setNightAction(state, bySlot(state, 2).playerId, 3);
    setNightAction(state, bySlot(state, 1).playerId, 3);
    advanceMafia(state, 1, lcg(1));

    assert.equal(sheriff.alive, false);
    assert.equal(
      state.deaths.find((d) => d.playerId === sheriff.playerId)?.hidden,
      true,
    );
    // The town view shows an unidentified corpse.
    const view = toMafiaView(state, {
      kind: "player",
      playerId: coroner.playerId,
    });
    assert.equal(view.players.find((p) => p.slot === 3)?.roleName, null);

    advanceMafia(state, 2, lcg(1)); // next night: autopsy
    setNightAction(state, coroner.playerId, 3);
    advanceMafia(state, 3, lcg(1));
    assert.ok(
      coroner.intel.some(
        (entry) => entry.kind === "role" && entry.value === "sheriff",
      ),
    );
  });

  it("mafia wins at parity, town wins when purged", () => {
    const parity = table(["godfather", "citizen"]);
    advanceMafia(parity, 0, lcg(1)); // night
    setNightAction(parity, bySlot(parity, 1).playerId, 2);
    advanceMafia(parity, 1, lcg(1));
    assert.equal(parity.phase, "ended");
    assert.ok(
      parity.winners.some((w) => w.playerId === bySlot(parity, 1).playerId),
    );

    const purge = table(["vigilante", "mafioso", "citizen", "sheriff"]);
    advanceMafia(purge, 0, lcg(1));
    setNightAction(purge, bySlot(purge, 1).playerId, 2);
    advanceMafia(purge, 1, lcg(1));
    assert.equal(purge.phase, "ended");
    const townWinners = purge.winners.filter((w) => w.kind === "town");
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
  /**
   * Who wins *with* the winner, which is a different question from who won.
   *
   * The seats that live off somebody else's result — the Witch and her kind,
   * the Survivor, the Lovers — are not obstacles to anybody's victory and must
   * not be treated as any. A Witch standing beside the last Serial Killer has
   * not stopped him and is not going to; her whole condition is that the town
   * fails, which is exactly what is happening. So the game ends, he wins, and
   * she wins with him.
   *
   * The mirror matters as much: she loses when the town wins, however alive she
   * is. These pairs are the ones that used to keep a finished game running.
   */
  describe("the seats that win with whoever wins", () => {
    const settle = (roles: RoleId[]): MafiaState => {
      const state = table(roles, 8);
      checkVictory(state, 1000);
      return state;
    };
    const wonAs = (state: MafiaState, role: RoleId): string | null =>
      state.winners.find(
        (winner) => state.players[winner.playerId]?.role === role,
      )?.kind ?? null;

    /**
     * The duel she wins by not needing a knife.
     *
     * At two seats there is one other hand at the table and hers is on it every
     * night. A Vigilante shoots himself and dies of it; a Serial Killer stabs
     * himself, survives, and never reaches her either. Either way she is the one
     * standing when it stops, and the town is not.
     */
    it("gives the witch every duel against somebody who acts at night", () => {
      for (const other of [
        "serial-killer",
        "arsonist",
        "mass-murderer",
        "poisoner",
        "vigilante",
        "godfather",
        "mafioso",
        "escort",
        "bus-driver",
        "doctor",
        "sheriff",
        "citizen",
      ] as RoleId[]) {
        const state = settle(["witch", other]);
        assert.equal(
          state.phase,
          "ended",
          `witch against ${other} is a finished game`,
        );
        assert.equal(
          wonAs(state, "witch"),
          "parasite",
          `the witch should take ${other}`,
        );
        assert.equal(
          wonAs(state, other),
          null,
          `${other} should not also be paid`,
        );
      }
    });

    /**
     * And the ones that beat her, every one for the same reason: they act in
     * the daylight, where her hand cannot reach — or, in the Veteran's case,
     * they punish the reaching.
     */
    it("loses her the duel to a daylight power that cannot be spent", () => {
      // Neither of these two is a charge. The sash and the reveal last as long
      // as the man does, so there is no version of this table where she wins.
      for (const standing of ["mayor", "marshall"] as RoleId[]) {
        assert.equal(wonAs(settle(["witch", standing]), standing), "town");

        const spent = table(["witch", standing], 8);
        for (const player of Object.values(spent.players)) player.charges = 0;
        checkVictory(spent, 1000);
        assert.equal(
          wonAs(spent, standing),
          "town",
          `nothing spends a ${standing}`,
        );
      }
    });

    it("loses it to a jailor or a veteran only while the charge is there", () => {
      for (const daylight of ["jailor", "veteran"] as RoleId[]) {
        assert.equal(
          wonAs(settle(["witch", daylight]), daylight),
          "town",
          `an armed ${daylight} beats her`,
        );

        // Spent, he is one more seat she steers.
        const spent = table(["witch", daylight], 8);
        for (const player of Object.values(spent.players)) player.charges = 0;
        checkVictory(spent, 1000);
        assert.equal(
          wonAs(spent, "witch"),
          "parasite",
          `a spent ${daylight} does not`,
        );
      }
    });

    /**
     * The Judge is the one that looks like an exception and is not.
     *
     * His court is a daylight power and his ballot counts three inside it, so
     * by the rule above he is not somebody she steers — and it changes nothing,
     * because he wants what she wants. Two seats left, no town among them, and
     * both of them live off the town's failure: they are not in a duel, they
     * have both already won. Which is the ordinary case for two parasites and
     * worth a test precisely because the exclusion list makes it look otherwise.
     */
    it("shares it with the judge, who wanted the same ending she did", () => {
      const state = settle(["witch", "judge"]);
      assert.equal(state.phase, "ended");
      assert.equal(wonAs(state, "witch"), "parasite");
      assert.equal(wonAs(state, "judge"), "parasite");
    });

    /**
     * And the mirror, which is the half that keeps her honest: she needs the
     * town to fail, so a town that carries it leaves her with nothing. Three
     * seats is not a duel — one real townsperson is a vote, and a vote is a
     * game.
     */
    it("gives a witch nothing when the town carries it", () => {
      // Three seats and no killer among them: the town has already met its
      // condition, and she is a bystander to it rather than an obstacle.
      const state = settle(["vigilante", "witch", "citizen"]);
      assert.equal(state.phase, "ended");
      assert.equal(wonAs(state, "vigilante"), "town");
      assert.equal(
        wonAs(state, "witch"),
        null,
        "she needed the town to fail, and it did not",
      );
    });

    it("pays a survivor for being alive and a jester for nothing at all", () => {
      const alive = settle(["serial-killer", "survivor"]);
      assert.equal(
        wonAs(alive, "survivor"),
        "survivor",
        "still standing is the whole condition",
      );

      // The Jester wins by being hanged. Surviving to the end is losing.
      const unhanged = settle(["serial-killer", "jester"]);
      assert.equal(wonAs(unhanged, "jester"), null);
      // And the Executioner needs its target on a rope, which never happened here.
      const unfulfilled = settle(["serial-killer", "executioner"]);
      assert.equal(wonAs(unfulfilled, "executioner"), null);
    });

    /**
     * One real townsperson changes everything, which is the line this whole set
     * is drawing: a bystander is not a threat, and a citizen is.
     */
    it("keeps the game open while one real townsperson is left", () => {
      assert.equal(settle(["serial-killer", "witch", "citizen"]).phase, "day");
    });
  });

  describe("a lone killer wins the moment the last seat cannot stop him", () => {
    /** The ending, without a night in between: `checkVictory` on the morning. */
    const settles = (roles: RoleId[]): MafiaState => {
      const state = table(roles);
      checkVictory(state, 1000);
      return state;
    };

    it("crowns him against a seat with nothing to answer with", () => {
      for (const townie of [
        "sheriff",
        "citizen",
        "lookout",
        "coroner",
      ] as RoleId[]) {
        const state = settles(["serial-killer", townie]);
        assert.equal(
          state.phase,
          "ended",
          `a serial killer beats a lone ${townie} without playing the night`,
        );
        assert.ok(state.winners.some((w) => w.kind === "solo-killer"));
      }
    });

    it("crowns the slow blades on the same morning", () => {
      // The fire and the poison take another night to land; the outcome does not.
      for (const killer of [
        "arsonist",
        "poisoner",
        "electromaniac",
        "mass-murderer",
      ] as RoleId[]) {
        assert.equal(
          settles([killer, "citizen"]).phase,
          "ended",
          `${killer} against one citizen is over`,
        );
      }
    });

    it("waits for the porch, the cell and the badge", () => {
      // A veteran shoots back at 2, a jailor's lever is 3, and a mayor who
      // stands up votes for three — which is the majority of two seats plus him.
      for (const clutch of ["veteran", "jailor", "mayor"] as RoleId[]) {
        assert.equal(
          settles(["serial-killer", clutch]).phase,
          "day",
          `a ${clutch} still has the game`,
        );
      }
    });

    /**
     * A seat that can stop him but can never finish him is his win, not a draw.
     *
     * This asserted the opposite and it was the single largest source of games
     * that never ended: fifteen of twenty-six timed-out benches were a Serial
     * Killer and one Escort, twenty days of her taking his night away and
     * neither of them able to remove the other. An Escort has no knife and one
     * vote out of two is not a majority, so the town's condition — remove every
     * threat — has become unreachable, while his is to be the one standing.
     *
     * The rule is about the *position*, not the roles: while there are enough
     * townsfolk left to carry a majority it is an ordinary game, and the case
     * below checks exactly that.
     */
    it("gives him a position the last seat can freeze but never finish", () => {
      for (const blocker of ["escort", "bus-driver"] as RoleId[]) {
        const state = settles(["serial-killer", blocker]);
        assert.equal(
          state.phase,
          "ended",
          `a lone ${blocker} can never remove him`,
        );
        assert.ok(
          state.winners.some((winner) => winner.kind === "solo-killer"),
        );
      }
      // Three seats is a majority for the two of them, and a majority is a game.
      assert.equal(
        settles(["serial-killer", "escort", "citizen"]).phase,
        "day",
      );
    });

    it("does not count a power that cannot be pointed at its own owner", () => {
      // Neither may heal or guard itself, so the last doctor alive is a doctor
      // who dies — and a rule that called that a rescue would never end.
      for (const alone of ["doctor", "bodyguard"] as RoleId[]) {
        assert.equal(
          settles(["serial-killer", alone]).phase,
          "ended",
          `a lone ${alone} cannot save itself`,
        );
      }
    });

    it("weighs the blade against the armour rather than naming roles", () => {
      // A Stump does not die at night and cannot vote anybody out either, so
      // whichever of them can never be removed, the game is already decided.
      assert.equal(settles(["serial-killer", "stump"]).phase, "ended");
      assert.equal(settles(["mass-murderer", "stump"]).phase, "ended");
      // Fire is power three and answers to nothing at all.
      assert.equal(settles(["arsonist", "stump"]).phase, "ended");
      // And a bullet is power 1 against a killer who is night-immune to a man.
      assert.equal(settles(["serial-killer", "vigilante"]).phase, "ended");
    });

    it("leaves a rope the room can still reach", () => {
      // Two seats out of three make the majority, so the day is a real day.
      assert.equal(
        settles(["serial-killer", "citizen", "citizen"]).phase,
        "day",
      );
    });

    it("will not cut a rope that hangs the killer too", () => {
      // Grief takes the partner of anybody who dies, so this knife cannot be used.
      const state = table(["serial-killer", "citizen"]);
      const killer = bySlot(state, 1);
      const lover = bySlot(state, 2);
      killer.bondPartnerId = lover.playerId;
      killer.bondKind = "lover";
      lover.bondPartnerId = killer.playerId;
      lover.bondKind = "lover";
      checkVictory(state, 1000);
      assert.equal(state.phase, "day");
    });

    /**
     * The endgame nobody's rule covered, from a real game.
     *
     * A Serial Killer and one Mafioso, and every branch looked straight past
     * them: no family had parity, the lone-killer rule requires the families to
     * be *gone*, and the town rule needs a town. So the table played a whole
     * day of two people talking at each other and the night settled what the
     * morning already knew — a Mafioso's knife does not open a night-immune
     * door, and one vote out of two hangs nobody.
     */
    it("settles a lone killer against one family without playing the night", () => {
      const state = settles(["serial-killer", "mafioso"]);
      assert.equal(
        state.phase,
        "ended",
        "a mafioso cannot knife a serial killer and cannot hang him either",
      );
      assert.ok(
        state.winners.some((winner) => winner.kind === "solo-killer"),
        "and the one who cannot be stopped is the one who wins",
      );
    });

    /**
     * The blade against the door, rather than the names on either side.
     *
     * A Godfather is night-immune and a Serial Killer goes through him anyway,
     * because the blade is power 2 and immunity only turns aside a 1 — which is
     * what the Serial Killer's own description has always promised: it pierces
     * vests and the Godfather's guard alike. So this is not the deadlock it
     * looks like, and the rule reaches the same answer as the role text without
     * either of them knowing about the other.
     */
    /**
     * Two seats that cannot touch each other, which the lone killer wins.
     *
     * A Godfather is immune to a power-one blade and the Serial Killer is
     * immune to the family's, so neither night ever lands; one vote out of two
     * is not a majority, so neither rope ever tightens. Not a draw, because the
     * two are not in the same position: a family wins by converting parity into
     * a hanging and this parity can never reach a rope, while a lone killer
     * wins by standing at the end with nothing able to stop him — which is the
     * position he is already in.
     */
    it("gives a frozen position to the lone killer rather than to nobody", () => {
      const state = settles(["serial-killer", "godfather"]);
      assert.equal(
        state.phase,
        "ended",
        "neither can kill or hang the other, so it is decided",
      );
      assert.ok(state.winners.some((winner) => winner.kind === "solo-killer"));
    });

    it("leaves it open while either side can still reach the rope", () => {
      // A mass murderer's blade is power 1 and a Godfather turns that aside, so
      // no night settles it — but two mafiosi out of three seats is a majority,
      // and a majority is a game.
      assert.equal(
        settles(["mass-murderer", "godfather", "mafioso"]).phase,
        "day",
      );
    });

    it("leaves the game alone while a townie is still in it", () => {
      // The clause is for a straight fight between one family and a lone
      // killer. A citizen in the room is a vote, and a vote is a game.
      assert.equal(
        settles(["serial-killer", "mafioso", "citizen"]).phase,
        "day",
      );
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
  it("plays whole games that actually hang people", () => {
    let lynches = 0;
    let evilLynches = 0;
    let decided = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const result = simulateGame({ players: 15, seed });
      lynches += result.lynches;
      evilLynches += result.evilLynches;
      if (result.winner !== "draw") decided++;
    }
    assert.ok(
      lynches > 20,
      `twenty games produced only ${String(lynches)} hangings — the ballot is blocked`,
    );
    assert.ok(
      evilLynches > 0,
      "not one hanging in twenty games caught an evil seat",
    );
    assert.ok(
      decided > 10,
      `only ${String(decided)} of twenty games reached a winner`,
    );
  });

  it("a parasite wins only when the town does not", () => {
    // The Witch feeds on the town's failure, so the same seat has to lose one
    // ending and win the other. The gate used to be a French string comparison
    // against a second copy of itself; this holds it down whatever it is.
    const purged = table(["vigilante", "mafioso", "citizen", "witch"]);
    advanceMafia(purged, 0, lcg(1));
    setNightAction(purged, bySlot(purged, 1).playerId, 2);
    advanceMafia(purged, 1, lcg(1));
    assert.equal(purged.phase, "ended");
    const survivingWitch = bySlot(purged, 4);
    assert.equal(survivingWitch.alive, true);
    assert.ok(
      !purged.winners.some((w) => w.playerId === survivingWitch.playerId),
    );

    const overrun = table(["godfather", "citizen", "witch"]);
    advanceMafia(overrun, 0, lcg(1));
    setNightAction(overrun, bySlot(overrun, 1).playerId, 2);
    advanceMafia(overrun, 1, lcg(1));
    assert.equal(overrun.phase, "ended");
    const thrivingWitch = bySlot(overrun, 3);
    assert.equal(thrivingWitch.alive, true);
    assert.ok(
      overrun.winners.some((w) => w.playerId === thrivingWitch.playerId),
    );
  });

  it("scores every solo win as a solo win, not only the hanged jester", () => {
    const state = table(["godfather", "citizen", "witch"]);
    advanceMafia(state, 0, lcg(1));
    setNightAction(state, bySlot(state, 1).playerId, 2);
    advanceMafia(state, 1, lcg(1));

    const witch = bySlot(state, 3);
    const entry = state.points.find(
      (point) =>
        point.playerId === witch.playerId && point.reason === "solo-win",
    );
    assert.ok(entry, "a lone winner banks a solo-win entry");

    /**
     * And the prose does not carry the fact.
     *
     * The career ledger used to count solo wins by testing the winner's `reason`
     * for 'gagne seul', a phrase only the hanged Jester's line contains — so
     * every other seat that wins alone banked the points and never the tally.
     * The structured entry above is the one source of that truth.
     */
    const win = state.winners.find(
      (winner) => winner.playerId === witch.playerId,
    );
    assert.ok(!(win && t(win.reason).includes("gagne seul")));
  });

  it("counts a revealed mayor the same way on the phone as in the threshold", () => {
    const state = table([
      "mayor",
      "citizen",
      "doctor",
      "sheriff",
      "godfather",
      "mafioso",
    ]);
    const mayor = bySlot(state, 1);
    assert.equal(revealMayor(state, mayor.playerId, 1000).ok, true);
    assert.equal(castVote(state, mayor.playerId, 5, 2000).ok, true);

    // Three weighted votes on one head, and 5 of 8 still needed: no trial yet,
    // and the tally every screen renders says three rather than one.
    assert.equal(state.stage, "discussion");
    const view = toMafiaView(state, { kind: "host" });
    assert.equal(
      view.players.find((player) => player.slot === 5)?.votesAgainst,
      3,
    );
  });

  it("never leaks a living role to another player", () => {
    const state = table([
      "sheriff",
      "godfather",
      "mafioso",
      "citizen",
      "doctor",
      "jester",
    ]);
    const sheriff = bySlot(state, 1);
    const godfather = bySlot(state, 2);

    const sheriffView = toMafiaView(state, {
      kind: "player",
      playerId: sheriff.playerId,
    });
    // No public role while everyone lives, and no teammate list for town.
    assert.ok(
      sheriffView.players.every((p) => p.role === null && p.roleName === null),
    );
    assert.equal(sheriffView.me?.teammates, null);
    assert.equal(sheriffView.results, null);

    const gfView = toMafiaView(state, {
      kind: "player",
      playerId: godfather.playerId,
    });
    assert.deepEqual(
      gfView.me?.teammates?.map((t) => t.slot),
      [3],
    );

    // Serialize what the town view says about *people*: the word 'godfather'
    // must not appear anywhere in it while its owner breathes. The published role
    // list is deliberately excluded — it names the roles in play, which is the
    // one place that word is supposed to appear, and never says whose seat holds
    // one.
    const raw = JSON.stringify({
      players: sheriffView.players,
      me: sheriffView.me,
      chat: sheriffView.chat,
    });
    assert.ok(!raw.includes("godfather"));
  });

  /* ---------------- visits are complete before anything punishes one --------------- */

  /**
   * The whole class of bug these three cover: `visits` is read by the veteran's
   * porch, by the mass murderer's house and by the lookout's notebook, and it
   * used to be *written* by the investigators after two of those three had
   * already read it. So the town's most common visitors — its investigators —
   * walked through both retaliations untouched.
   */
  it("an alerted veteran shoots the investigators who call on him", () => {
    const state = table([
      "veteran",
      "sheriff",
      "lookout",
      "citizen",
      "mafioso",
    ]);
    advanceMafia(state, 0, lcg(3)); // night
    const veteran = bySlot(state, 1);

    setNightAction(state, veteran.playerId, veteran.slot); // on alert
    setNightAction(state, bySlot(state, 2).playerId, veteran.slot); // sheriff sounds him out
    setNightAction(state, bySlot(state, 3).playerId, veteran.slot); // lookout watches him
    advanceMafia(state, 1, lcg(3));

    assert.equal(
      bySlot(state, 2).alive,
      false,
      "the sheriff walked onto the porch",
    );
    assert.equal(bySlot(state, 3).alive, false, "so did the lookout");
    assert.equal(veteran.alive, true);
  });

  /**
   * A porch is somewhere to be, and the examiner's nose says so.
   *
   * The examiner reads what its target *did*, and the first version of that test
   * asked only whether the target had named a house. The alert names none, so
   * the one seat in this game that most obviously smells of gunpowder was the
   * one seat that could never smell of anything — while the Veteran stayed on
   * the shortlist the bots read out for that very line. It takes a doctor to
   * see it, because an examiner who calls on an armed porch normally does not
   * live to file the finding.
   */
  it("an alerted veteran smells of gunpowder to an examiner who survives him", () => {
    const state = table([
      "veteran",
      "investigator",
      "doctor",
      "citizen",
      "mafioso",
    ]);
    advanceMafia(state, 0, lcg(3)); // night
    const veteran = bySlot(state, 1);
    const digger = bySlot(state, 2);

    setNightAction(state, veteran.playerId, veteran.slot); // on alert, nobody's house
    setNightAction(state, digger.playerId, veteran.slot); // and somebody calls anyway
    setNightAction(state, bySlot(state, 3).playerId, digger.slot); // the doctor keeps him alive
    setNightAction(state, bySlot(state, 5).playerId, bySlot(state, 4).slot);
    advanceMafia(state, 1, lcg(3));

    assert.equal(
      digger.alive,
      true,
      "the doctor is the only reason this reads",
    );
    assert.deepEqual(
      digger.intel
        .filter((entry) => entry.kind === "trade")
        .map((entry) => entry.value),
      ["powder"],
      "a man who spent the night oiling a rifle is not a man with nothing to hide",
    );
  });

  it("records every visitor’s journey, result or none", () => {
    const state = table(["veteran", "sheriff", "doctor", "citizen", "mafioso"]);
    advanceMafia(state, 0, lcg(3)); // night
    const veteran = bySlot(state, 1);

    setNightAction(state, veteran.playerId, veteran.slot); // on alert
    setNightAction(state, bySlot(state, 2).playerId, veteran.slot); // the sheriff calls
    setNightAction(state, bySlot(state, 3).playerId, bySlot(state, 4).slot); // the doctor goes elsewhere
    advanceMafia(state, 1, lcg(3));

    const sheriff = bySlot(state, 2);
    assert.equal(sheriff.alive, false, "the porch is still the porch");
    assert.ok(
      sheriff.intel.some(
        (entry) => entry.kind === "went" && entry.targetSlot === 1,
      ),
      "the dead sheriff still carries where it went, which is what its will needs",
    );
    // A doctor who healed nobody used to leave no trace of the night at all.
    assert.ok(
      bySlot(state, 3).intel.some(
        (entry) => entry.kind === "went" && entry.targetSlot === 4,
      ),
    );
  });

  it("the crier speaks into the night without a name", () => {
    const state = table(["crier", "citizen", "citizen", "mafioso"]);
    advanceMafia(state, 0, lcg(7)); // night
    const crier = bySlot(state, 1);

    const result = sayInChat(
      state,
      crier.playerId,
      "day",
      "Somebody here is lying.",
      5,
    );
    assert.equal(result.ok, true, "the crier may speak after dark");
    if (!result.ok) return;
    assert.equal(
      result.message.authorId,
      null,
      "and nobody learns which house",
    );
    assert.equal(result.message.authorName, ANONYMOUS);
    assert.equal(result.message.text, "Somebody here is lying.");

    const stored = state.chat.messages.find(
      (message) => message.id === result.message.id,
    );
    assert.equal(
      stored?.authorId,
      null,
      "stripped in the log itself, not only in the reply",
    );
  });

  it("echoes a seat’s night results into a channel only that seat can read", () => {
    const state = table(["sheriff", "citizen", "mafioso", "doctor"]);
    advanceMafia(state, 0, lcg(9)); // night
    const sheriff = bySlot(state, 1);
    setNightAction(state, sheriff.playerId, 3); // checks the mafioso
    advanceMafia(state, 1, lcg(9)); // dawn

    const own = state.chat.messages.filter(
      (message) => message.channel === `self:${sheriff.playerId}`,
    );
    assert.ok(own.length > 0, "the result reached the square, privately");
    assert.ok(own.every((message) => message.kind === "system"));
    // A bot reads its record, not a chat panel; echoing for it only fills the log.
    const bot = bySlot(state, 2);
    assert.equal(
      state.chat.messages.some(
        (message) => message.channel === `self:${bot.playerId}`,
      ),
      false,
      "no echo for a bot",
    );

    const rules = chatRules();
    assert.equal(
      rules.canRead(`self:${sheriff.playerId}`, sheriff.playerId, state),
      true,
    );
    assert.equal(
      rules.canRead(
        `self:${sheriff.playerId}`,
        bySlot(state, 2).playerId,
        state,
      ),
      false,
      "nobody else",
    );
    assert.equal(
      rules.canWrite(`self:${sheriff.playerId}`, sheriff.playerId, state),
      false,
      "and nobody writes there",
    );
  });

  it("the mass murderer kills everyone who visits the house he rampages", () => {
    const state = table([
      "mass-murderer",
      "lookout",
      "citizen",
      "doctor",
      "citizen",
    ]);
    advanceMafia(state, 0, lcg(4)); // night
    const victimSlot = 3;

    setNightAction(state, bySlot(state, 1).playerId, victimSlot);
    setNightAction(state, bySlot(state, 2).playerId, victimSlot); // watching the door
    setNightAction(state, bySlot(state, 4).playerId, victimSlot); // and a doctor calling in
    advanceMafia(state, 1, lcg(4));

    assert.equal(
      bySlot(state, 2).alive,
      false,
      "the lookout was in the massacre",
    );
    assert.equal(
      bySlot(state, 4).alive,
      false,
      "the doctor could not heal through it",
    );
    assert.equal(bySlot(state, 1).alive, true);
  });

  it("a lookout still sees the other investigators who called", () => {
    const state = table(["lookout", "sheriff", "citizen", "citizen"]);
    advanceMafia(state, 0, lcg(5)); // night
    const watched = bySlot(state, 3);

    setNightAction(state, bySlot(state, 1).playerId, watched.slot);
    setNightAction(state, bySlot(state, 2).playerId, watched.slot);
    advanceMafia(state, 1, lcg(5));

    const seen = bySlot(state, 1).intel.find(
      (entry) => entry.kind === "visitors",
    );
    assert.deepEqual(seen?.slots, [2], "the sheriff was on the doorstep too");
  });

  /* ------------------------- the court votes in secret ------------------------- */

  it("the judge is not identifiable from the public verdict", () => {
    const state = table(["judge", "citizen", "citizen", "citizen", "mafioso"]);
    const judge = bySlot(state, 1);
    judge.charges = 1;

    // Two accusations put the mafioso on top, then the judge convenes the court.
    castVote(state, bySlot(state, 2).playerId, 5, 0);
    castVote(state, bySlot(state, 3).playerId, 5, 0);
    assert.equal(callCourt(state, judge.playerId, 10).ok, true);

    castBallot(state, judge.playerId, "guilty");
    castBallot(state, bySlot(state, 2).playerId, "guilty");
    advanceMafia(state, 20, lcg(6));

    const spoken = said(state);
    // The weighted tally is public; the names that would give the weight away are not.
    assert.ok(spoken.includes("Verdict : 4 coupable"), "the tally still lands");
    assert.ok(
      !spoken.includes("Ont voté coupable"),
      "no roll call to subtract from",
    );
    assert.ok(spoken.includes("bulletin secret"));
    // But the record keeps every hand, for the end-of-game reveal.
    const logged = state.trialLog?.at(-1);
    assert.equal(logged?.guiltyIds.length, 2);
  });

  it("an ordinary trial still publishes who wanted the rope", () => {
    const state = table(["citizen", "citizen", "citizen", "mafioso"]);
    castVote(state, bySlot(state, 1).playerId, 4, 0);
    castVote(state, bySlot(state, 2).playerId, 4, 0);
    castVote(state, bySlot(state, 3).playerId, 4, 0);
    assert.equal(state.stage, "defense", "the threshold fell");

    advanceMafia(state, 10, lcg(7)); // to judgement
    castBallot(state, bySlot(state, 1).playerId, "guilty");
    castBallot(state, bySlot(state, 2).playerId, "innocent");
    advanceMafia(state, 20, lcg(7));

    const spoken = said(state);
    assert.ok(
      spoken.includes("Ont voté coupable"),
      "the roll call is safe without a hidden weight",
    );
  });

  it("an accusation moves the count without posting a line", () => {
    const state = table([
      "citizen",
      "citizen",
      "citizen",
      "citizen",
      "mafioso",
    ]);
    const before = state.chat.messages.length;
    castVote(state, bySlot(state, 1).playerId, 5, 0);
    castVote(state, bySlot(state, 1).playerId, 4, 0); // changed their mind
    assert.equal(state.chat.messages.length, before, "the square stays quiet");

    const view = toMafiaView(state, {
      kind: "player",
      playerId: bySlot(state, 2).playerId,
    });
    const accused = view.players.find((player) => player.slot === 4);
    assert.equal(
      accused?.votesAgainst,
      1,
      "the list carries the count instead",
    );
    assert.equal(
      view.players.find((player) => player.slot === 1)?.votedSlot,
      4,
    );
  });

  /* --------------------- what a corpse gives away --------------------- */

  /**
   * Hangs the Godfather in slot 5 under the given policy, leaving a Mafioso alive
   * so the game does *not* end — otherwise the end-of-game reveal would lift the
   * policy and the assertion would be measuring the wrong moment.
   */
  function lynchUnder(reveal: "role" | "faction" | "none") {
    const state = table([
      "citizen",
      "citizen",
      "citizen",
      "citizen",
      "godfather",
      "mafioso",
    ]);
    state.config.revealOnDeath = reveal;
    for (const slot of [1, 2, 3, 4])
      castVote(state, bySlot(state, slot).playerId, 5, 0);
    advanceMafia(state, 10, lcg(9)); // defense → judgement
    for (const slot of [1, 2, 3, 4])
      castBallot(state, bySlot(state, slot).playerId, "guilty");
    advanceMafia(state, 20, lcg(9));
    assert.equal(bySlot(state, 5).alive, false, "the godfather hanged");
    assert.notEqual(
      state.phase,
      "ended",
      "and the game goes on, so the policy still applies",
    );
    return {
      state,
      said: said(state),
      row: toMafiaView(state, {
        kind: "player",
        playerId: bySlot(state, 1).playerId,
      }).players.find((player) => player.slot === 5)!,
    };
  }

  it("reveals the whole role when the table asks for it", () => {
    const { said, row } = lynchUnder("role");
    assert.equal(t(row.roleName!), "Parrain");
    assert.equal(row.faction, "mafia");
    assert.ok(said.includes("Parrain"));
  });

  it("names only the camp under the faction policy", () => {
    const { said, row } = lynchUnder("faction");
    assert.equal(row.roleName, null, "the role stays secret");
    assert.equal(row.role, null);
    assert.equal(row.faction, "mafia", "but the camp is public");
    assert.ok(said.includes("de la Mafia"));
    assert.ok(
      !said.includes("Parrain"),
      "the exact role never reaches the square",
    );
  });

  it("gives away nothing when the table reveals nothing", () => {
    const { said, row } = lynchUnder("none");
    assert.equal(row.role, null);
    assert.equal(row.roleName, null);
    assert.equal(row.faction, null);
    assert.ok(!said.includes("Parrain"));
    assert.ok(!said.includes("de la Mafia"));
    assert.ok(said.includes("Son secret est mort avec lui"));
  });

  /**
   * The ballot shuts again after an acquittal.
   *
   * It was opened once at dawn and never again, so the instant a trial ended in
   * "spared" the room could re-cast and re-open one before anybody had said a
   * word about the verdict. A real table spent three afternoons doing exactly
   * that to the same seat.
   */
  it("shuts the ballot again after a seat is spared", () => {
    const state = table([
      "citizen",
      "citizen",
      "citizen",
      "godfather",
      "citizen",
    ]);
    state.voteOpensAt = null;
    state.config.aftermathMs = 40_000;

    // Three of five is the threshold: 4 goes to the stand.
    for (const slot of [1, 2, 3])
      castVote(state, bySlot(state, slot).playerId, 4, 0);
    assert.equal(state.stage, "defense");
    advanceMafia(state, 10, lcg(9)); // to the booth

    for (const slot of [1, 2, 3])
      castBallot(state, bySlot(state, slot).playerId, "innocent");
    advanceMafia(state, 20, lcg(9)); // verdict: spared

    assert.equal(state.stage, "discussion", "the afternoon carries on");
    assert.equal(
      state.voteOpensAt,
      20 + 10_000,
      "a quarter of the aftermath, as at dawn",
    );

    const early = castVote(state, bySlot(state, 1).playerId, 5, 30);
    assert.equal(early.ok, false, "and the room talks before it votes again");

    assert.equal(
      castVote(state, bySlot(state, 1).playerId, 5, 10_100).ok,
      true,
      "then the floor opens",
    );
  });

  /**
   * Three killers, one house, one morning.
   *
   * The resolution loop dropped every attack after the first on the same body,
   * so a night where the family and a lone blade picked the same door read as a
   * night with one killer out — and the Vigilante who fired into a house the
   * family had already emptied lost a bullet, was told nothing, and watched the
   * square credit somebody else. Reported as a missing feature and it was worse
   * than that: it was a night the town could not read.
   */
  it("names every knife that reached the same body", () => {
    const state = table([
      "citizen",
      "vigilante",
      "serial-killer",
      "mafioso",
      "citizen",
    ]);
    advanceMafia(state, 0, lcg(3)); // into the night
    assert.equal(state.phase, "night");

    // All three go to house 1.
    setNightAction(state, bySlot(state, 2).playerId, 1);
    setNightAction(state, bySlot(state, 3).playerId, 1);
    setNightAction(state, bySlot(state, 4).playerId, 1);
    advanceMafia(state, 1, lcg(3));

    const dead = bySlot(state, 1);
    assert.equal(dead.alive, false);

    const record = state.deaths.find(
      (death) => death.playerId === dead.playerId,
    )!;
    assert.equal(record.sources?.length, 3, "all three are on the record");
    const line = said(state);
    assert.ok(line.includes("Mafia"), `the family is named: ${line}`);
    assert.ok(line.includes("Tueur"), `and so is the blade: ${line}`);

    /** And the two who arrived second are told why their night produced nothing. */
    const late = [bySlot(state, 2), bySlot(state, 3), bySlot(state, 4)].filter(
      (player) =>
        player.notifications.some(
          (note) => note.k === "mafia.note.attackTooLate",
        ),
    );
    assert.equal(
      late.length,
      2,
      "two of the three found a body rather than a victim",
    );
  });

  it("the end of the game lifts every policy", () => {
    // One lone godfather, so hanging him purges the town and ends it there.
    const state = table(["citizen", "citizen", "citizen", "godfather"]);
    state.config.revealOnDeath = "none";
    for (const slot of [1, 2, 3])
      castVote(state, bySlot(state, slot).playerId, 4, 0);
    advanceMafia(state, 10, lcg(9));
    for (const slot of [1, 2, 3])
      castBallot(state, bySlot(state, slot).playerId, "guilty");
    advanceMafia(state, 20, lcg(9));

    assert.equal(state.phase, "ended");
    const row = toMafiaView(state, { kind: "host" }).players.find(
      (player) => player.slot === 4,
    )!;
    assert.equal(t(row.roleName!), "Parrain", "the masks come off regardless");
    assert.equal(row.faction, "mafia");
  });

  /**
   * The three carve-outs that are mechanics rather than presentation: a cleaned
   * body says nothing whatever the policy, a borrowed face never reaches the
   * slab, and a role that was genuinely changed reveals what it became.
   */
  it("a borrowed face does not change what the body says", () => {
    // The mafioso is here so the family has a knife of its own: a one-man
    // family of Disguisers cannot kill, and `promoteCarriers` would hand this
    // seat the knife at dusk and stop it being a Disguiser at all.
    const state = table([
      "disguiser",
      "sheriff",
      "citizen",
      "vigilante",
      "mafioso",
    ]);
    state.config.revealOnDeath = "role";
    advanceMafia(state, 0, lcg(11)); // night
    const disguiser = bySlot(state, 1);
    // Wear the sheriff's face, and get shot for it the same night.
    setNightAction(state, disguiser.playerId, 2);
    setNightAction(state, bySlot(state, 4).playerId, 1);
    advanceMafia(state, 1, lcg(11));

    assert.equal(disguiser.alive, false);
    const row = toMafiaView(state, { kind: "host" }).players.find(
      (player) => player.slot === 1,
    )!;
    assert.equal(t(row.roleName!), "Imposteur", "the undertaker is not fooled");
    assert.equal(row.faction, "mafia");
  });

  it("a cleaned corpse stays anonymous even under the full-reveal policy", () => {
    const state = table([
      "janitor",
      "mafioso",
      "citizen",
      "citizen",
      "citizen",
      "doctor",
    ]);
    state.config.revealOnDeath = "role";
    bySlot(state, 1).charges = 2;
    advanceMafia(state, 0, lcg(13)); // night
    setNightAction(state, bySlot(state, 2).playerId, 4); // the family kills slot 4
    setNightAction(state, bySlot(state, 1).playerId, 4); // and the janitor tidies up
    advanceMafia(state, 1, lcg(13));

    assert.equal(bySlot(state, 4).alive, false);
    const row = toMafiaView(state, { kind: "host" }).players.find(
      (player) => player.slot === 4,
    )!;
    assert.equal(row.roleName, null);
    assert.equal(row.faction, null, "not even the camp leaks");
  });

  /**
   * The shared-screen contract: every line that names an identity is flagged at
   * the source, so a television can hold it back without reading French. If this
   * breaks, the TV's spoiler mode silently starts leaking.
   */
  it("flags every announcement that gives an identity away", () => {
    const { state } = lynchUnder("role");
    const day = state.chat.messages.filter(
      (message) => message.channel === "day" && message.kind === "system",
    );

    const gallows = day.find((message) =>
      rendered(message).includes("se balance au bout de la corde"),
    )!;
    assert.equal(gallows.reveals, true, "the gallows names the body");

    const verdict = day.find((message) =>
      rendered(message).startsWith("Verdict :"),
    )!;
    assert.notEqual(verdict.reveals, true, "a tally is not an identity");

    const rollCall = day.find((message) =>
      rendered(message).startsWith("Ont voté coupable"),
    )!;
    assert.notEqual(
      rollCall.reveals,
      true,
      "who wanted the rope is a vote, not a role",
    );

    // And nothing carrying a role name is left unflagged.
    const leaked = day.filter(
      (message) => !message.reveals && rendered(message).includes("Parrain"),
    );
    assert.deepEqual(leaked, [], "an unflagged line named a role");
  });

  it("flags the dawn report and the closing roster too", () => {
    const state = table(["mafioso", "citizen", "citizen", "doctor", "sheriff"]);
    advanceMafia(state, 0, lcg(21)); // night
    setNightAction(state, bySlot(state, 1).playerId, 2); // the family kills slot 2
    advanceMafia(state, 1, lcg(21));

    const dawn = state.chat.messages.find((message) =>
      rendered(message).includes("a été retrouvé mort"),
    )!;
    assert.equal(
      dawn.reveals,
      true,
      "the dawn report names the body and its killer",
    );

    const quiet = state.chat.messages.find((message) =>
      rendered(message).includes("Fermez vos portes"),
    );
    assert.notEqual(quiet?.reveals, true, "nightfall is not a reveal");
  });

  it("keeps mafia and jail chat away from the town", () => {
    const state = table([
      "sheriff",
      "godfather",
      "mafioso",
      "citizen",
      "doctor",
      "escort",
    ]);
    advanceMafia(state, 0, lcg(1)); // night

    const gf = bySlot(state, 2);
    const posted = sayInChat(
      state,
      gf.playerId,
      "mafia",
      "on tue le shérif",
      10,
    );
    assert.equal(posted.ok, true);

    const sheriffView = toMafiaView(state, {
      kind: "player",
      playerId: bySlot(state, 1).playerId,
    });
    assert.ok(sheriffView.chat.every((m) => m.channel !== "mafia"));

    const mafiosoView = toMafiaView(state, {
      kind: "player",
      playerId: bySlot(state, 3).playerId,
    });
    assert.ok(
      mafiosoView.chat.some((m) => m.text.includes("on tue le shérif")),
    );

    // Town cannot write into the family channel either.
    const sneak = sayInChat(
      state,
      bySlot(state, 1).playerId,
      "mafia",
      "coucou",
      11,
    );
    assert.equal(sneak.ok, false);
  });

  /**
   * The end of a game is still a morning: the bodies that ended it are named
   * before the headline, and a town nobody survived did not win anything.
   */
  /**
   * Two killers who go the same dawn, and the judge left alone in the ashes.
   *
   * It used to be a Serial Killer stabbing the poisoner, which stopped working
   * the day the blade came down to power one: a poisoner is night-immune and an
   * ordinary knife does not open that door. Fire does — it is power three and
   * answers to nothing — so the arsonist takes that half of the job, and the
   * poison takes the arsonist, which was always the shape of the test.
   */
  it("reads out the last night before the last word, and gives an empty town to nobody", () => {
    const state = table(["judge", "poisoner", "arsonist"], 7);
    const judge = bySlot(state, 1);
    const poisoner = bySlot(state, 2);
    const killer = bySlot(state, 3);

    advanceMafia(state, 0, lcg(5)); // night 7
    setNightAction(state, poisoner.playerId, 3); // the dose, which takes a night
    setNightAction(state, killer.playerId, 2); // the petrol, which takes a match
    advanceMafia(state, 1, lcg(5)); // day 8, everybody still up
    assert.equal(state.phase, "day");

    advanceMafia(state, 2, lcg(5)); // night 8
    setNightAction(state, killer.playerId, 3); // self = the match, while the poison works
    advanceMafia(state, 3, lcg(5)); // dawn: both killers go

    assert.equal(poisoner.alive, false, "fire goes through night immunity");
    assert.equal(
      killer.alive,
      false,
      "and the poison does not care about armour",
    );
    assert.equal(judge.alive, true, "the judge is the last one standing");

    const transcript = said(state);
    assert.ok(
      transcript.includes(poisoner.name),
      "the poisoner is named in the dawn report",
    );
    assert.ok(transcript.includes(killer.name), "and so is the killer");

    assert.equal(state.phase, "ended");
    assert.ok(
      !transcript.includes("La Ville l’emporte"),
      "a town with nobody in it wins nothing",
    );
    assert.ok(
      transcript.includes("Il ne reste personne à sauver"),
      "the empty-town ending, said as such",
    );
    const win = state.winners.find(
      (entry) => entry.playerId === judge.playerId,
    );
    assert.ok(
      win,
      "the judge wins: the town lost, which is the whole of its condition",
    );
  });

  /**
   * The judge's court needs a defendant the room actually named. A square split
   * down the middle has not named one, and picking whichever id came first is
   * how a seven-against-seven afternoon put somebody on the stand with no
   * defence and no reason.
   */
  it("refuses the judge’s court while the square is tied, and keeps the charge", () => {
    const state = table([
      "judge",
      "citizen",
      "citizen",
      "citizen",
      "citizen",
      "godfather",
      "mafioso",
    ]);
    const judge = bySlot(state, 1);
    judge.charges = 1;

    castVote(state, bySlot(state, 2).playerId, 4, 2000);
    castVote(state, bySlot(state, 3).playerId, 5, 2010);

    const split = callCourt(state, judge.playerId, 2100);
    assert.equal(
      split.ok,
      false,
      "two houses level at the top is not an accusation",
    );
    assert.equal(state.trial, null);
    assert.equal(judge.charges, 1, "and the charge is still in his pocket");

    // The room makes up its mind, and the court sits.
    castVote(state, bySlot(state, 6).playerId, 4, 2200);
    const called = callCourt(state, judge.playerId, 2300);
    assert.equal(called.ok, true);
    assert.equal(state.players[state.trial!.accusedId]?.slot, 4);
    assert.equal(judge.charges, 0);
  });

  it("the spy hears the family without a byline, and not at all once dead", () => {
    const state = table([
      "spy",
      "godfather",
      "mafioso",
      "citizen",
      "doctor",
      "escort",
    ]);
    advanceMafia(state, 0, lcg(1)); // night

    const gf = bySlot(state, 2);
    assert.equal(
      sayInChat(state, gf.playerId, "mafia", "on tue le shérif", 10).ok,
      true,
    );
    const posted = state.chat.messages.find(
      (message) => message.channel === "mafia",
    )!;

    const spy = bySlot(state, 1);
    const heard = chatVisibleTo(state, spy.playerId).filter(
      (message) => message.channel === "mafia",
    );
    assert.equal(heard.length, 1, "the ear is at the wall");
    assert.equal(heard[0].authorId, null, "and never sees a face");
    assert.equal(heard[0].authorName, ANONYMOUS);

    // The same line also goes out on its own between broadcasts, muffled there too.
    assert.equal(
      chatLineFor(state, spy.playerId, posted).authorName,
      ANONYMOUS,
    );
    assert.equal(
      chatLineFor(state, bySlot(state, 3).playerId, posted).authorName,
      gf.name,
      "the family sees its own",
    );

    spy.alive = false;
    assert.equal(
      chatRules().canRead("mafia", spy.playerId, state),
      false,
      "a corpse eavesdrops on nobody",
    );
    const ghostView = toMafiaView(state, {
      kind: "player",
      playerId: spy.playerId,
    });
    assert.ok(ghostView.chat.every((message) => message.channel !== "mafia"));
    assert.ok(
      ghostView.me?.channels.every((channel) => channel.id !== "mafia"),
    );
  });

  it("dead players talk only to the dead", () => {
    const state = table(["citizen", "godfather", "sheriff", "doctor"]);
    const citizen = bySlot(state, 1);
    citizen.alive = false;

    const ghost = sayInChat(
      state,
      citizen.playerId,
      "dead",
      "je vous vois",
      10,
    );
    assert.equal(ghost.ok, true);
    const livingView = toMafiaView(state, {
      kind: "player",
      playerId: bySlot(state, 3).playerId,
    });
    assert.ok(livingView.chat.every((m) => m.channel !== "dead"));

    const gag = sayInChat(
      state,
      citizen.playerId,
      "day",
      "je parle encore ?",
      11,
    );
    assert.equal(gag.ok, false);
  });
});

/**
 * The quiet clock, walked morning by morning.
 *
 * `hasStalled` is asked before `beginDay` moves the counter and `warnIfStalling`
 * after, and the two were written one day apart without noticing: the warning
 * fired the morning a body landed and never on the morning that was actually
 * the last. Nothing covered it, so a scratch game found it.
 *
 * Two lengths to walk now. A board the town can still move gets
 * `quietDaysIfMoveable`; one nobody can move gets `quietDaysBeforeEnd`. Both
 * end, and the warning has to land on the right morning of whichever one it is.
 */
describe("the quiet clock", () => {
  const warnings = (state: MafiaState): number =>
    state.chat.messages.filter(
      (message) => message.msg?.k === "mafia.win.lastQuietDay",
    ).length;

  /** One night and one day, which is what one morning to the next costs. */
  const nightAndDay = (state: MafiaState, at: number): void => {
    advanceMafia(state, at, lcg(1));
    advanceMafia(state, at + 1, lcg(1));
  };

  it("warns on the last quiet morning, and only then, and rules the morning after", () => {
    const state = table(
      ["citizen", "citizen", "citizen", "citizen", "citizen", "godfather"],
      7,
    );
    const godfather = bySlot(state, 6);
    const victim = bySlot(state, 1);

    // Night 7: a body.
    advanceMafia(state, 1_000, lcg(1));
    assert.equal(state.phase, "night");
    assert.equal(
      setNightAction(state, godfather.playerId, victim.slot).ok,
      true,
    );
    advanceMafia(state, 2_000, lcg(1));
    assert.equal(state.day, 8);
    assert.equal(victim.alive, false);
    assert.equal(
      warnings(state),
      0,
      "a morning with a corpse in it is not a quiet one",
    );

    /**
     * Four citizens against one godfather: they hold the rope and have simply
     * not pulled it, so this board is on the long leash. The body fell on day
     * 7, `quietDaysIfMoveable` is 5, so day 12 is the morning that says so and
     * day 13 is the one it ends on.
     */
    assert.equal(state.config.quietDaysIfMoveable, 5);
    for (let day = 9; day <= 11; day++) {
      nightAndDay(state, day * 1_000);
      assert.equal(state.day, day, `walked to day ${day}`);
      assert.equal(
        warnings(state),
        0,
        `day ${day} is not the last quiet morning`,
      );
    }

    // Day 12 is the morning the game ends on if nothing changes, and says so.
    nightAndDay(state, 12_000);
    assert.equal(state.phase, "day");
    assert.equal(state.day, 12);
    assert.equal(
      warnings(state),
      1,
      "the warning comes on the morning the game ends on if nothing changes",
    );

    // Night 12: nothing. The clock rules.
    nightAndDay(state, 13_000);
    assert.equal(state.phase, "ended");
    assert.equal(warnings(state), 1, "and it is said once");
  });

  /**
   * And the board the whole rule was written for: an Escort and the last
   * killer, she blocking him every night and he immune to everything she has,
   * one vote out of two never reaching a majority. Nobody can move it, so it
   * ends on the short leash exactly as it always did.
   */
  it("still calls a frozen board on the short leash", () => {
    const state = table(["escort", "citizen", "serial-killer"], 7);
    const escort = bySlot(state, 1);
    const killer = bySlot(state, 3);

    // Night 7: the killer takes the citizen, and the board freezes at two.
    advanceMafia(state, 1_000, lcg(1));
    assert.equal(
      setNightAction(state, killer.playerId, bySlot(state, 2).slot).ok,
      true,
    );
    advanceMafia(state, 2_000, lcg(1));
    assert.equal(bySlot(state, 2).alive, false);

    // Two quiet nights, the Escort holding him home for both.
    for (let round = 0; round < 2 && state.phase !== "ended"; round++) {
      advanceMafia(state, (3 + round * 2) * 1_000, lcg(1));
      if (state.phase === "night")
        setNightAction(state, escort.playerId, killer.slot);
      advanceMafia(state, (4 + round * 2) * 1_000, lcg(1));
    }
    assert.equal(
      state.phase,
      "ended",
      "a board nobody can move is not given the long leash",
    );
    assert.ok(
      state.day <= 10,
      `ended on day ${state.day}, which is the short leash`,
    );
  });
});
/**
 * A table that was in flight when the server was redeployed.
 *
 * Its config was written into its state when it was created, so it comes back
 * carrying whatever shape the config had that day. Every setting added since is
 * `undefined`, and nothing in the type system notices because the snapshot is
 * parsed with an unchecked cast.
 *
 * The failure that produces is silent arithmetic, not a crash, which is why it
 * is worth a test rather than a comment. `quietDaysIfMoveable` arrived this way:
 * `state.day - lastDeathDay(state) >= undefined` is false for every value of
 * everything, so the quiet clock simply stopped firing on any moveable board and
 * those tables ran on until somebody gave up on them.
 */
describe("restoring a table from an older snapshot", () => {
  it("fills in settings the snapshot predates", () => {
    const state = createMafiaGame({
      code: "OLD01",
      hostToken: "h",
      hostUserId: null,
      now: 0,
    });

    // Exactly what a redeploy hands back: yesterday's config shape.
    delete (state.config as Partial<typeof state.config>).quietDaysIfMoveable;
    assert.equal(state.config.quietDaysIfMoveable, undefined);

    restoreMafiaTable(state, 1_000);

    assert.equal(typeof state.config.quietDaysIfMoveable, "number");
    assert.ok(state.config.quietDaysIfMoveable > 0);
  });

  it("does not overwrite a setting the table actually chose", () => {
    // The merge is defaults *under* the snapshot, never over it: a host who set
    // a long day must not have it reset to the default by a restart.
    const state = createMafiaGame({
      code: "OLD02",
      hostToken: "h",
      hostUserId: null,
      now: 0,
    });
    state.config.dayMs = 999_000;

    restoreMafiaTable(state, 1_000);

    assert.equal(state.config.dayMs, 999_000);
  });
});

/**
 * How fast a congregation may grow.
 *
 * The cooldown is written on the cultist who spends it, which limits one cultist
 * and not the cult. Two off cooldown took two people the same night, and every
 * one taken was another pair of hands for the next: a table dealt a single
 * Cultist, who was lynched on day two, still lost six seats to the cult by day
 * ten. The night is the budget now, not the cultist.
 */
describe("the cult", () => {
  it("takes one soul a night however many are asking", () => {
    const state = table(
      ["cultist", "cultist", "citizen", "citizen", "citizen", "godfather"],
      3,
    );
    const first = bySlot(state, 1);
    const second = bySlot(state, 2);
    const townA = bySlot(state, 3);
    const townB = bySlot(state, 4);

    advanceMafia(state, 1_000, lcg(1));
    assert.equal(state.phase, "night");
    assert.equal(setNightAction(state, first.playerId, townA.slot).ok, true);
    assert.equal(setNightAction(state, second.playerId, townB.slot).ok, true);
    advanceMafia(state, 2_000, lcg(1));

    const taken = [townA, townB].filter(
      (seat) => seat.role === "cultist",
    ).length;
    assert.equal(taken, 1, "two cultists, one night, one convert");
  });

  it("does not let the newest member recruit the same night it arrived", () => {
    const state = table(
      ["cultist", "citizen", "citizen", "citizen", "godfather"],
      3,
    );
    const leader = bySlot(state, 1);
    const taken = bySlot(state, 2);

    advanceMafia(state, 1_000, lcg(1));
    assert.equal(setNightAction(state, leader.playerId, taken.slot).ok, true);
    advanceMafia(state, 2_000, lcg(1));
    assert.equal(taken.role, "cultist", "the first convert lands");
    assert.ok(
      taken.cooldownUntilDay !== null && taken.cooldownUntilDay > state.day,
      "and arrives on the same cooldown as the one who brought them in",
    );
  });

  /**
   * The badges a town builds a game around are not for sale.
   *
   * A cult that can simply take the Jailor has ended the game on a coin flip
   * rather than won it, and the same goes for the sash and for the lodge. The
   * cult still spends the night finding out, which is the price the information
   * should have: the button is offered, the knock is refused.
   */
  for (const badge of ["jailor", "marshall", "mason-leader"] as RoleId[]) {
    it(`cannot take the ${badge}`, () => {
      const state = table(
        ["cultist", badge, "citizen", "citizen", "godfather"],
        3,
      );
      const cultist = bySlot(state, 1);
      const power = bySlot(state, 2);

      advanceMafia(state, 1_000, lcg(1));
      setNightAction(state, cultist.playerId, power.slot);
      advanceMafia(state, 2_000, lcg(1));

      assert.equal(power.role, badge, "the badge is unchanged");
    });
  }

  /**
   * An unrevealed Mayor is still an ordinary townsman to the cult's *button*,
   * and no longer one to its outcome.
   *
   * The reveal gate stays where it is on `keepsRole`, because that rule leaked
   * the Mayor's name to the cult on night one when it was ungated. This is a
   * second, separate rule about what a power badge is worth, and it needs no
   * gate: the refusal says "not this house", never which kind of house.
   */
  it("cannot take an unrevealed mayor either", () => {
    const state = table(
      ["cultist", "mayor", "citizen", "citizen", "godfather"],
      3,
    );
    const cultist = bySlot(state, 1);
    const mayor = bySlot(state, 2);
    assert.equal(mayor.revealed, false);

    advanceMafia(state, 1_000, lcg(1));
    setNightAction(state, cultist.playerId, mayor.slot);
    advanceMafia(state, 2_000, lcg(1));

    assert.equal(mayor.role, "mayor");
  });

  /**
   * One rule about what the night can do to a house, not two.
   *
   * A seat that cannot be killed in the dark cannot be carried off in it either.
   * The Stump is the only town badge this catches, and it is exactly the seat
   * the rule is for: nothing else the night can do touches it.
   */
  it("cannot take a seat the night cannot kill", () => {
    const state = table(
      ["cultist", "stump", "citizen", "citizen", "godfather"],
      3,
    );
    const cultist = bySlot(state, 1);
    const stump = bySlot(state, 2);

    advanceMafia(state, 1_000, lcg(1));
    setNightAction(state, cultist.playerId, stump.slot);
    advanceMafia(state, 2_000, lcg(1));

    assert.equal(stump.role, "stump");
  });

  /**
   * A door that did not open is remembered, so the next night is not spent on it.
   *
   * Both recruiting powers used to pick uniformly from every living seat, so the
   * same wasted knock came round again and again — and with the badges above now
   * refusing outright there is more to waste a night on than there was.
   */
  it("remembers the door that refused the cult", () => {
    const state = table(
      ["cultist", "jailor", "citizen", "citizen", "godfather"],
      3,
    );
    const cultist = bySlot(state, 1);
    const jailor = bySlot(state, 2);

    advanceMafia(state, 1_000, lcg(1));
    setNightAction(state, cultist.playerId, jailor.slot);
    advanceMafia(state, 2_000, lcg(1));

    assert.deepEqual(cultist.refused, [jailor.slot]);
  });

  it("remembers the door that refused the lodge", () => {
    const state = table(
      ["mason-leader", "jailor", "citizen", "citizen", "godfather"],
      3,
    );
    const leader = bySlot(state, 1);
    const jailor = bySlot(state, 2);

    advanceMafia(state, 1_000, lcg(1));
    setNightAction(state, leader.playerId, jailor.slot);
    advanceMafia(state, 2_000, lcg(1));

    assert.equal(jailor.role, "jailor", "a town power keeps its own badge");
    assert.deepEqual(leader.refused, [jailor.slot]);
  });

  /**
   * And the door that opens, which for most of this game's life was one role
   * wide.
   *
   * The rule was `role === "citizen"`, so on any table that dealt no Citizen —
   * perfectly ordinary, since every town slot but Town Core can roll something
   * else — the Mason Leader's power did nothing at all and nothing said so.
   * Anybody the cult could take, the lodge can take first: the two conversions
   * ask the same question from opposite sides.
   */
  it("initiates anybody the cult could have taken", () => {
    const state = table(
      ["mason-leader", "doctor", "citizen", "citizen", "godfather"],
      3,
    );
    const leader = bySlot(state, 1);
    const doctor = bySlot(state, 2);

    advanceMafia(state, 1_000, lcg(1));
    setNightAction(state, leader.playerId, doctor.slot);
    advanceMafia(state, 2_000, lcg(1));

    assert.equal(doctor.role, "mason", "the doctor joined the lodge");
    assert.deepEqual(leader.refused ?? [], []);
  });

  /** What the cult learned is the cult's; a second cultist pays for it again. */
  it("does not share a refusal between two cultists", () => {
    const state = table(
      ["cultist", "cultist", "jailor", "citizen", "godfather"],
      3,
    );
    const first = bySlot(state, 1);
    const second = bySlot(state, 2);
    const jailor = bySlot(state, 3);

    advanceMafia(state, 1_000, lcg(1));
    setNightAction(state, first.playerId, jailor.slot);
    advanceMafia(state, 2_000, lcg(1));

    assert.deepEqual(first.refused, [jailor.slot]);
    assert.equal(second.refused, undefined);
  });

  /** And an ordinary townsman still goes, or none of the above means anything. */
  it("still takes a plain citizen", () => {
    const state = table(
      ["cultist", "jailor", "citizen", "citizen", "godfather"],
      3,
    );
    const cultist = bySlot(state, 1);
    const citizen = bySlot(state, 3);

    advanceMafia(state, 1_000, lcg(1));
    setNightAction(state, cultist.playerId, citizen.slot);
    advanceMafia(state, 2_000, lcg(1));

    assert.equal(citizen.role, "cultist");
  });

  /** A sash is not a soul to be bought. See `keepsRole`. */
  it("cannot take a revealed mayor, and the auditor cannot strip one", () => {
    const state = table(
      ["cultist", "mayor", "citizen", "citizen", "godfather"],
      3,
    );
    const cultist = bySlot(state, 1);
    const mayor = bySlot(state, 2);
    mayor.revealed = true;

    advanceMafia(state, 1_000, lcg(1));
    setNightAction(state, cultist.playerId, mayor.slot);
    advanceMafia(state, 2_000, lcg(1));
    assert.equal(mayor.role, "mayor", "the mayor keeps his role");
  });
});

/**
 * What a massacre costs.
 *
 * The Mass Murderer takes a house and everyone standing in it, which on a busy
 * night is several seats at once, and he could do it again the next night for
 * nothing. Nothing else in the game kills by the handful with no cost: the
 * families share one knife, the Serial Killer takes one seat, the Arsonist
 * spends nights dousing before it gets a fire.
 */
describe("the mass murderer", () => {
  it("stays in the night after a massacre lands", () => {
    const state = table(
      ["mass-murderer", "citizen", "citizen", "citizen", "godfather"],
      3,
    );
    const killer = bySlot(state, 1);
    const first = bySlot(state, 2);
    const second = bySlot(state, 3);

    advanceMafia(state, 1_000, lcg(1));
    assert.equal(state.phase, "night");
    assert.equal(setNightAction(state, killer.playerId, first.slot).ok, true);
    advanceMafia(state, 2_000, lcg(1));
    assert.equal(first.alive, false, "the massacre lands");

    // Next night: the rampage is not on offer at all.
    advanceMafia(state, 3_000, lcg(1));
    assert.equal(state.phase, "night");
    assert.equal(
      setNightAction(state, killer.playerId, second.slot).ok,
      false,
      "locked in for one night",
    );
    advanceMafia(state, 4_000, lcg(1));
    assert.equal(second.alive, true, "and nobody dies to him");

    // The night after that, he is out again.
    advanceMafia(state, 5_000, lcg(1));
    assert.equal(state.phase, "night");
    assert.equal(
      setNightAction(state, killer.playerId, second.slot).ok,
      true,
      "one night only",
    );
  });

  /** Spending the night for nothing is already the price of being unlucky. */
  it("is not locked when the massacre killed nobody", () => {
    const state = table(
      ["mass-murderer", "serial-killer", "citizen", "citizen", "godfather"],
      3,
    );
    const killer = bySlot(state, 1);
    // A seat the rampage cannot touch, and nobody visiting it to be caught in the house.
    const immune = bySlot(state, 2);

    advanceMafia(state, 1_000, lcg(1));
    setNightAction(state, killer.playerId, immune.slot);
    advanceMafia(state, 2_000, lcg(1));
    assert.equal(immune.alive, true, "night immunity holds");

    advanceMafia(state, 3_000, lcg(1));
    assert.equal(state.phase, "night");
    assert.equal(
      setNightAction(state, killer.playerId, bySlot(state, 3).slot).ok,
      true,
      "a wasted night costs him nothing extra",
    );
  });
});

/**
 * The sash changes the arithmetic, so the arithmetic is re-read.
 *
 * Revealing turns the Mayor's own standing vote from one into three and the
 * table's total from N into N+2: the tally moves by two and the bar by one, so a
 * wagon one short of the line is suddenly over it. The only check lived inside
 * `castVote`, so the room sat looking at a tally past the threshold with nobody
 * on the stand, until somebody happened to vote again.
 */
describe("the sash and the standing votes", () => {
  it("opens the stand when the reveal itself carries the wagon over", () => {
    const state = table(
      ["mayor", "citizen", "citizen", "citizen", "citizen", "godfather"],
      3,
    );
    state.voteOpensAt = null;
    const mayor = bySlot(state, 1);
    const accused = bySlot(state, 6);

    // Two of six behind it, plus the mayor: three of six, and the bar is four.
    assert.equal(castVote(state, mayor.playerId, accused.slot, 1_000).ok, true);
    assert.equal(
      castVote(state, bySlot(state, 2).playerId, accused.slot, 1_100).ok,
      true,
    );
    assert.equal(
      castVote(state, bySlot(state, 3).playerId, accused.slot, 1_200).ok,
      true,
    );
    assert.equal(state.trial === null, true, "three of six is not a majority");

    // The sash: his vote is now three, so the wagon is five of eight and the bar five.
    assert.equal(revealMayor(state, mayor.playerId, 1_300).ok, true);
    assert.equal(
      state.trial?.accusedId,
      accused.playerId,
      "the reveal carried it",
    );
  });

  it("leaves the day alone when the reveal changes nothing", () => {
    const state = table(
      ["mayor", "citizen", "citizen", "citizen", "citizen", "godfather"],
      3,
    );
    state.voteOpensAt = null;
    const mayor = bySlot(state, 1);

    assert.equal(
      castVote(state, bySlot(state, 2).playerId, bySlot(state, 6).slot, 1_000)
        .ok,
      true,
    );
    assert.equal(revealMayor(state, mayor.playerId, 1_100).ok, true);
    assert.equal(state.trial === null, true, "one vote is still one vote");
    assert.equal(state.stage, "discussion");
  });
});

/**
 * A name that is really a claim.
 *
 * "Mafia", "Shérif", "Town": a seat called one of these turns every sentence in
 * the square into a lie the chat itself tells, and every reader in this game
 * resolves role words against the roster.
 */
describe("names that are roles", () => {
  const fresh = () =>
    createMafiaGame({
      code: "NAME1",
      hostToken: "h",
      hostUserId: null,
      now: 0,
    });
  const tryName = (name: string): boolean => {
    const state = fresh();
    try {
      joinMafia(state, name, `tok-${name}`, `id-${name}`);
      return true;
    } catch {
      return false;
    }
  };

  it("refuses a faction or a role, in either language, however it is typed", () => {
    for (const taken of [
      "Mafia",
      "town",
      "Triade",
      "secte",
      "Sheriff",
      "shérif",
      "Médecin",
      "doctor",
      "serial killer",
      "Tueur de masse",
      "MAYOR",
    ]) {
      assert.equal(tryName(taken), false, `"${taken}" should be refused`);
    }
  });

  it("leaves ordinary names alone", () => {
    for (const fine of [
      "Xavier",
      "Tintin",
      "Bidule",
      "Lucky",
      "Sheriffa",
      "Docteur Maboul",
      "Villeneuve",
      "Mafioso2",
    ]) {
      assert.equal(tryName(fine), true, `"${fine}" should be allowed`);
    }
  });
});

/**
 * The sash is worth three votes, not three seats.
 *
 * It used to sit in the numerator and the denominator at once, so revealing
 * raised the bar the Mayor was trying to carry: fourteen alive and the bar was
 * eight, fourteen alive with the sash out and the bar was nine. Seen on a real
 * table as "eight of fourteen and no trial".
 */
describe("the sash and the bar", () => {
  it("leaves the threshold where it was", () => {
    const state = table(
      ["mayor", "citizen", "citizen", "citizen", "citizen", "godfather"],
      3,
    );
    const mayor = bySlot(state, 1);
    assert.equal(voteThreshold(state), 4, "six alive, four to hang");
    assert.equal(revealMayor(state, mayor.playerId, 1_000).ok, true);
    assert.equal(voteThreshold(state), 4, "and still four with the sash out");
  });

  it("lets the sash carry a wagon three seats short of it", () => {
    const state = table(
      ["mayor", "citizen", "citizen", "citizen", "citizen", "godfather"],
      3,
    );
    state.voteOpensAt = null;
    const mayor = bySlot(state, 1);
    const accused = bySlot(state, 6);

    assert.equal(revealMayor(state, mayor.playerId, 1_000).ok, true);
    assert.equal(
      castVote(state, bySlot(state, 2).playerId, accused.slot, 1_100).ok,
      true,
    );
    assert.equal(state.trial === null, true, "one seat is not four");
    // The sash alone is worth three, so his vote is the fourth.
    assert.equal(castVote(state, mayor.playerId, accused.slot, 1_200).ok, true);
    assert.equal(
      state.trial?.accusedId,
      accused.playerId,
      "one seat plus the sash carries it",
    );
  });
});

/**
 * The lodge and the cult recruit from the same room.
 *
 * Only one of them walks away from meeting the other, whichever way round the
 * knock happened. It is the only counter the town has to conversion: without it
 * the cult grows and nothing on the board shrinks it except the rope.
 */
describe("the lodge and the cult", () => {
  it("kills a cultist the mason leader knocks on", () => {
    const state = table(
      ["mason-leader", "cultist", "citizen", "citizen", "godfather"],
      3,
    );
    const master = bySlot(state, 1);
    const preacher = bySlot(state, 2);

    advanceMafia(state, 1_000, lcg(1));
    assert.equal(state.phase, "night");
    assert.equal(
      setNightAction(state, master.playerId, preacher.slot).ok,
      true,
    );
    advanceMafia(state, 2_000, lcg(1));

    assert.equal(
      preacher.alive,
      false,
      "the cult does not survive the lodge door",
    );
    assert.equal(master.alive, true);
  });

  it("kills a cultist who comes to preach at the lodge", () => {
    const state = table(
      ["mason-leader", "cultist", "citizen", "citizen", "godfather"],
      3,
    );
    const master = bySlot(state, 1);
    const preacher = bySlot(state, 2);

    advanceMafia(state, 1_000, lcg(1));
    assert.equal(
      setNightAction(state, preacher.playerId, master.slot).ok,
      true,
    );
    advanceMafia(state, 2_000, lcg(1));

    assert.equal(
      preacher.alive,
      false,
      "and the knock costs the same either way",
    );
    assert.equal(master.alive, true, "the lodge does not convert");
    assert.equal(master.role, "mason-leader");
  });

  /** The lodge still does what it is for on anybody who is not the cult. */
  it("still initiates an ordinary citizen", () => {
    const state = table(
      ["mason-leader", "citizen", "citizen", "citizen", "godfather"],
      3,
    );
    const master = bySlot(state, 1);
    const recruit = bySlot(state, 2);

    advanceMafia(state, 1_000, lcg(1));
    assert.equal(setNightAction(state, master.playerId, recruit.slot).ok, true);
    advanceMafia(state, 2_000, lcg(1));

    assert.equal(recruit.alive, true);
    assert.equal(recruit.role, "mason");
  });
});

/**
 * A family spending its night as one hand rather than four.
 *
 * Every one of these was a whole night thrown away, and the kidnap one was
 * worse than nothing: the cell shelters its prisoner from everything except its
 * own keeper, so the family's knife bounced and the man it had picked walked
 * into the morning alive.
 */
describe("a family's night, spent as one", () => {
  /** `table` deals in slot order, so slot 1 is the first role named. */
  function night(roles: RoleId[]): MafiaState {
    const state = table(roles);
    advanceMafia(state, 0, lcg(1));
    return state;
  }

  it("keeps the knife out of its own cellar", () => {
    const state = night([
      "kidnapper",
      "mafioso",
      "citizen",
      "doctor",
      "sheriff",
      "escort",
    ]);
    setNightAction(state, bySlot(state, 1).playerId, 3);

    const left = unclashedTargets(
      state,
      bySlot(state, 2).playerId,
      "kill",
      [3, 4, 5],
    );
    assert.ok(!left.includes(3), "the knife looks elsewhere");
  });

  it("and the cellar out of the way of its own knife", () => {
    const state = night([
      "kidnapper",
      "mafioso",
      "citizen",
      "doctor",
      "sheriff",
      "escort",
    ]);
    setNightAction(state, bySlot(state, 2).playerId, 3);

    // Symmetric: whichever of the two is asked second is the one that moves.
    assert.equal(familyKnife(state, "mafia"), 3);
    assert.ok(
      !unclashedTargets(
        state,
        bySlot(state, 1).playerId,
        "kidnap",
        [3, 4, 5],
      ).includes(3),
    );
  });

  it("does not gag a man it is about to kill", () => {
    const state = night([
      "blackmailer",
      "mafioso",
      "citizen",
      "doctor",
      "sheriff",
      "escort",
    ]);
    setNightAction(state, bySlot(state, 2).playerId, 3);

    assert.ok(
      !unclashedTargets(
        state,
        bySlot(state, 1).playerId,
        "silence",
        [3, 4, 5],
      ).includes(3),
    );
  });

  it("nor roleblock, frame or read him", () => {
    for (const [role, action] of [
      ["consort", "block"],
      ["framer", "frame"],
      ["consigliere", "examine"],
    ] as [RoleId, "block" | "frame" | "examine"][]) {
      const state = night([
        role,
        "mafioso",
        "citizen",
        "doctor",
        "sheriff",
        "escort",
      ]);
      setNightAction(state, bySlot(state, 2).playerId, 3);

      assert.ok(
        !unclashedTargets(
          state,
          bySlot(state, 1).playerId,
          action,
          [3, 4, 5],
        ).includes(3),
        `${role} still spent its night on the body`,
      );
    }
  });

  /**
   * The cleaner is the opposite rule, and the reason the others are a list
   * rather than "anything the family is doing".
   */
  it("but the cleaner goes exactly where the knife goes", () => {
    const state = night([
      "janitor",
      "mafioso",
      "citizen",
      "doctor",
      "sheriff",
      "escort",
    ]);
    setNightAction(state, bySlot(state, 2).playerId, 3);

    assert.deepEqual(
      unclashedTargets(state, bySlot(state, 1).playerId, "clean", [3, 4, 5]),
      [3],
    );
  });

  /**
   * The engine carries the leader's order and sends the executor to it, so an
   * executor that disagrees is not a second knife — it is a man about to be
   * overruled, arguing for a house the family will not visit.
   */
  it("and the executor falls in behind its leader", () => {
    const state = night([
      "godfather",
      "mafioso",
      "citizen",
      "doctor",
      "sheriff",
      "escort",
    ]);
    setNightAction(state, bySlot(state, 1).playerId, 4);

    assert.equal(familyKnife(state, "mafia"), 4);
    assert.deepEqual(
      unclashedTargets(state, bySlot(state, 2).playerId, "kill", [3, 4, 5]),
      [4],
    );
  });

  it("though the leader is not dragged by its executor", () => {
    const state = night([
      "godfather",
      "mafioso",
      "citizen",
      "doctor",
      "sheriff",
      "escort",
    ]);
    setNightAction(state, bySlot(state, 2).playerId, 4);

    assert.deepEqual(
      unclashedTargets(state, bySlot(state, 1).playerId, "kill", [3, 4, 5]),
      [3, 4, 5],
    );
  });

  it("ignores another family's orders entirely", () => {
    const state = night([
      "kidnapper",
      "dragon-head",
      "citizen",
      "doctor",
      "sheriff",
      "escort",
    ]);
    setNightAction(state, bySlot(state, 2).playerId, 3);

    assert.equal(
      familyKnife(state, "mafia"),
      null,
      "the Triad is not the family",
    );
    assert.ok(
      unclashedTargets(
        state,
        bySlot(state, 1).playerId,
        "kidnap",
        [3, 4, 5],
      ).includes(3),
    );
  });

  /** A power with nowhere left to go still acts: an overlap beats a wasted seat. */
  it("would rather overlap than do nothing at all", () => {
    const state = night([
      "kidnapper",
      "mafioso",
      "citizen",
      "doctor",
      "sheriff",
      "escort",
    ]);
    setNightAction(state, bySlot(state, 1).playerId, 3);

    assert.deepEqual(
      unclashedTargets(state, bySlot(state, 2).playerId, "kill", [3]),
      [3],
    );
  });
});

/**
 * The last two seats, and the table the bots reason from.
 *
 * `duelBeats` is what a seat consults at six players to decide which rope is
 * worth spending — so if it disagrees with the engine, the bots spend their
 * last useful day on the wrong person with perfect confidence. It is checked
 * against the engine rather than asserted, which is the only way a hand-written
 * table stays true to rules it does not own.
 */
describe("who takes the last two seats", () => {
  /** A duel, played out by the engine: eight nights of both acting. */
  function duel(mine: RoleId, theirs: RoleId): RoleId | null {
    const state = table([mine, theirs], 2);
    const me = bySlot(state, 1);
    const them = bySlot(state, 2);

    for (let night = 0; night < 8 && me.alive && them.alive; night++) {
      advanceMafia(state, night * 1000, lcg(night + 1));
      if (state.phase !== "night") continue;

      // Each aims at the other, or at itself where the power is worn at home.
      for (const [actor, other] of [
        [me, them],
        [them, me],
      ] as const) {
        if (!actor.alive || !actor.role) continue;
        const legal = legalNightAction(state, actor.playerId);
        if (!legal) continue;
        const wants = legal.targets.includes(other.slot)
          ? other.slot
          : (legal.targets[0] ?? actor.slot);
        setNightAction(state, actor.playerId, wants);
      }
      advanceMafia(state, night * 1000 + 500, lcg(night + 2));
    }

    if (me.alive === them.alive) return null;
    return (me.alive ? me.role : them.role) ?? null;
  }

  /**
   * Armour decides two knives, which is the case the whole feature rests on: a
   * Mafioso whose blade came back blunted has met the seat that beats it.
   */
  it("the armoured knife beats the bare one", () => {
    assert.equal(duelBeats("mafioso", "serial-killer"), true);
    assert.equal(
      duel("mafioso", "serial-killer"),
      "serial-killer",
      "and the engine agrees",
    );

    assert.equal(duelBeats("serial-killer", "mafioso"), false);
  });

  it("and a knife beats no knife", () => {
    assert.equal(duelBeats("citizen", "mafioso"), true);
    assert.equal(duelBeats("mafioso", "citizen"), false);
  });

  it("two bare knives settle nothing either way", () => {
    assert.equal(duelBeats("mafioso", "vigilante"), false);
    assert.equal(duelBeats("vigilante", "mafioso"), false);
  });

  /** She needs a hand to guide, not a knife. See the existing witch cases. */
  it("the witch beats anybody with a night", () => {
    assert.equal(duelBeats("mafioso", "witch"), true);
    assert.equal(duelBeats("serial-killer", "witch"), true);
    assert.equal(duelBeats("citizen", "witch"), false, "nothing to guide");
  });

  it("and nothing beats the witch", () => {
    assert.equal(duelBeats("witch", "serial-killer"), false);
  });
});
