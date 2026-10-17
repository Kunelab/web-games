// Before anything that reaches env.ts: see the file for why it must be first.
import './test-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addMafiaBot,
  createMafiaGame,
  joinMafia,
  playerBySlot,
  startMafia,
  suspicion,
  type MafiaState
} from 'mafia-core';

import { readRoom } from './asks.js';
import { mouthPrompt } from './mouth.js';
import { seatAlone } from './seat-fakes.js';

/**
 * The lodge, from the inside.
 *
 * `9RVWV`: the Master announced "Diddy Kong joins us tonight. Do not put them
 * on the stand", the one person in the lodge answered "no", "not him" and "go
 * for hulk", and the knock went to Diddy Kong, a Mass Murderer, because the
 * Master never read the room and a bare "no" names no house to refuse.
 */

interface Lodge {
  state: MafiaState;
  master: string;
  human: string;
  diddy: number;
  hulk: number;
  jon: number;
  now: number;
}

function lodge(): Lodge {
  const state = createMafiaGame({ code: 'LODGE', hostToken: 'h', hostUserId: null, now: 0 });
  let seed = 11;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  joinMafia(state, 'Max', 'tok-human', 'human');
  for (let index = 0; index < 8; index++) addMafiaBot(state, `tok${index}`, `bot${index}`, rng);
  startMafia(state, 1000, rng);
  for (const player of Object.values(state.players)) player.role = 'citizen';
  const human = Object.values(state.players).find((player) => !player.isBot)!;
  human.role = 'mason';
  const bots = Object.values(state.players).filter((player) => player.isBot);
  const [master, diddy, hulk, jon] = bots;
  master.role = 'mason-leader';
  diddy.name = 'Diddy Kong';
  hulk.name = 'Hulk';
  jon.name = 'Jon Snow';
  const now = 500_000;
  state.phase = 'night';
  state.stage = null;
  state.day = 3;
  state.phaseStartedAt = now - 5_000;
  state.phaseEndsAt = now + state.config.nightMs - 5_000;
  return {
    state,
    master: master.playerId,
    human: human.playerId,
    diddy: diddy.slot,
    hulk: hulk.slot,
    jon: jon.slot,
    now
  };
}

let nextId = 10_000;
function says(fixture: Lodge, who: string, text: string): void {
  const author = fixture.state.players[who];
  fixture.now += 2000;
  fixture.state.chat.messages.push({
    id: nextId++,
    channel: 'mason',
    authorId: who,
    authorName: author.name,
    text,
    at: fixture.now
  } as (typeof fixture.state.chat.messages)[number]);
}

const masterSlot = (fixture: Lodge): number => fixture.state.players[fixture.master].slot;
const read = (fixture: Lodge) =>
  readRoom(
    fixture.state,
    'mason',
    0,
    new Set([masterSlot(fixture), fixture.state.players[fixture.human].slot]),
    masterSlot(fixture)
  );

describe('a refusal with no house in it', () => {
  it('refuses the house the Master just put forward', () => {
    const fixture = lodge();
    says(fixture, fixture.master, 'Diddy Kong joins us tonight.');
    says(fixture, fixture.human, 'no');
    says(fixture, fixture.human, 'not him');

    const heard = read(fixture);
    assert.deepEqual(
      heard.spared.map((entry) => entry.slot),
      [fixture.diddy, fixture.diddy]
    );
    assert.equal(heard.ask, null, "the Master's own pick is not a request it made of itself");
  });

  it('is not a refusal when the sentence goes on to name somebody else', () => {
    const fixture = lodge();
    says(fixture, fixture.master, 'Diddy Kong joins us tonight.');
    says(fixture, fixture.human, 'no go to jon snow');

    assert.equal(read(fixture).ask?.slot, fixture.jon);
  });

  it('is not a refusal when it is a different sentence', () => {
    const fixture = lodge();
    says(fixture, fixture.master, 'Diddy Kong joins us tonight.');
    says(fixture, fixture.human, 'no idea honestly');

    assert.deepEqual(read(fixture).spared, []);
  });
});

describe('the Master listens to the lodge', () => {
  it('knocks where a brother asks', () => {
    const fixture = lodge();
    says(fixture, fixture.human, 'go for hulk');

    const { seat } = seatAlone({ rng: () => 0.5 });
    const decision = seat.play(fixture.state, fixture.master, 'night');
    assert.equal(decision.targetSlot, fixture.hulk);
  });

  /** What a model is asked to say has to carry the answer, not just the phrasebook fallback. */
  it('tells the model what it did with the request', () => {
    const fixture = lodge();
    says(fixture, fixture.human, 'go for hulk');
    const { seat } = seatAlone({ rng: () => 0.5 });
    const knock = seat.play(fixture.state, fixture.master, 'night').targetSlot;
    fixture.state.nightActions[fixture.master] = {
      targetId: playerBySlot(fixture.state, knock!)!.playerId
    } as (typeof fixture.state.nightActions)[string];

    const turn = seat.play(fixture.state, fixture.master, 'night', 'mason');
    assert.ok(turn.intent?.answering?.length, 'the brother was not answered');
    assert.match(turn.intent?.act ?? '', /Hulk/, `the act says nothing about the request: ${turn.intent?.act}`);
  });

  /** A lodge is a room of brothers: a line there is said to all of them, not to this one seat. */
  it('tells the model the line was said in the room', () => {
    const fixture = lodge();
    says(fixture, fixture.human, 'go for hulk');
    const { seat } = seatAlone({ rng: () => 0.5 });
    const turn = seat.play(fixture.state, fixture.master, 'night', 'mason');
    const prompt = mouthPrompt({ name: 'Remy', slot: masterSlot(fixture) }, turn.intent!, []);
    assert.match(prompt, /said in your room/);
    assert.doesNotMatch(prompt, /said to you/);
  });

  it('does not knock on a house a brother refused', () => {
    const fixture = lodge();
    const { seat, minds } = seatAlone({ rng: () => 0.5 });
    // The Master has said its pick in the room, and been told no.
    minds.mind(fixture.state, fixture.master)!.named = { night: fixture.state.day, slot: fixture.diddy };
    says(fixture, fixture.master, 'Diddy Kong joins us tonight.');
    says(fixture, fixture.human, 'not him');

    const decision = seat.play(fixture.state, fixture.master, 'night');
    assert.notEqual(decision.targetSlot, fixture.diddy);
    assert.notEqual(decision.targetSlot, null);
  });

  it('does not knock again on a door that stayed shut', () => {
    const fixture = lodge();
    playerBySlot(fixture.state, masterSlot(fixture))!.refused = [fixture.hulk];
    says(fixture, fixture.human, 'go for hulk');

    const { seat, minds } = seatAlone({ rng: () => 0.5 });
    const decision = seat.play(fixture.state, fixture.master, 'night');
    assert.notEqual(decision.targetSlot, fixture.hulk);
    assert.equal(minds.mind(fixture.state, fixture.master)?.knockAsk?.why, 'shut');
  });
});

describe('what the Master tells the lodge', () => {
  it("reports last night's shut door once, and files it as a doubt", () => {
    const fixture = lodge();
    const { seat, minds } = seatAlone({ rng: () => 0.5 });
    const master = playerBySlot(fixture.state, masterSlot(fixture))!;
    master.refused = [fixture.diddy];
    minds.mind(fixture.state, fixture.master)!.named = { night: fixture.state.day - 1, slot: fixture.diddy };

    const report = /stayed shut|did not open|refused us/i;
    const first = seat.play(fixture.state, fixture.master, 'night', 'mason');
    assert.ok(first.say && report.test(first.say) && first.say.includes('Diddy Kong'), `not reported: ${first.say}`);
    assert.ok(
      minds.ledger(fixture.state.code).some((claim) => claim.kind === 'hint' && claim.targetSlot === fixture.diddy),
      'the lodge holds nothing against the shut door'
    );

    const second = seat.play(fixture.state, fixture.master, 'night', 'mason');
    // Doubting the house out loud afterwards is fine; announcing the door again is not.
    assert.ok(!report.test(second.say ?? ''), `reported twice: ${second.say}`);
  });

  it('never tells the lodge to shield the seat it is testing', () => {
    const fixture = lodge();
    const { seat } = seatAlone({ rng: () => 0.5 });
    for (let night = 0; night < 5; night++) {
      const said = seat.play(fixture.state, fixture.master, 'night', 'mason').say ?? '';
      assert.ok(!/do not put them on the stand|treat them as one of ours/i.test(said), said);
    }
  });
});

describe('what the knock is for', () => {
  /**
   * A lodge of two grows unless somebody is badly wanted: the decision says a
   * strong suspect is worth a night, and nothing less is. The line has to say
   * what the knock actually is, so a grow is never announced as a test.
   */
  it('grows past a mild suspect, and says it is growing', () => {
    const fixture = lodge();
    const { seat, minds } = seatAlone({ rng: () => 0.5 });
    const master = fixture.state.players[fixture.master];
    // Accusations piled on Diddy Kong until the Master doubts him, but not hard.
    const accusers = Object.values(fixture.state.players).filter(
      (player) => player.isBot && player.slot !== fixture.diddy && player.playerId !== fixture.master
    );
    const doubt = () => suspicion(fixture.diddy, master, minds.board(fixture.state, fixture.master), () => 0.5);
    for (const accuser of accusers) {
      if (doubt() >= 1) break;
      minds.record(fixture.state, accuser.playerId, 'accuse', fixture.diddy);
      fixture.state.votes[accuser.playerId] = playerBySlot(fixture.state, fixture.diddy)!.playerId;
    }
    assert.ok(doubt() >= 1 && doubt() < 2, `fixture doubt ${doubt().toFixed(2)} is not mild`);

    const knock = seat.play(fixture.state, fixture.master, 'night').targetSlot;
    fixture.state.nightActions[fixture.master] = {
      targetId: Object.values(fixture.state.players).find((player) => player.slot === knock)!.playerId
    } as (typeof fixture.state.nightActions)[string];
    const said = seat.play(fixture.state, fixture.master, 'night', 'mason').say ?? '';

    assert.notEqual(knock, fixture.diddy, 'a lodge of two spent its night testing a mild suspect');
    assert.doesNotMatch(said, /test|to see/i, `a grow knock was announced as a test: ${said}`);
  });

  it('tests a strong suspect, and says it is a test', () => {
    const fixture = lodge();
    const { seat, minds } = seatAlone({ rng: () => 0.5 });
    const master = fixture.state.players[fixture.master];
    const doubt = () => suspicion(fixture.diddy, master, minds.board(fixture.state, fixture.master), () => 0.5);
    const accusers = Object.values(fixture.state.players).filter(
      (player) => player.isBot && player.slot !== fixture.diddy && player.playerId !== fixture.master
    );
    for (const accuser of accusers) {
      minds.record(fixture.state, accuser.playerId, 'accuse', fixture.diddy);
      minds.record(fixture.state, accuser.playerId, 'sighting', fixture.diddy);
      fixture.state.votes[accuser.playerId] = playerBySlot(fixture.state, fixture.diddy)!.playerId;
    }
    assert.ok(doubt() >= 2.5, `fixture doubt ${doubt().toFixed(2)} is not strong`);

    const knock = seat.play(fixture.state, fixture.master, 'night').targetSlot;
    assert.equal(knock, fixture.diddy);
    fixture.state.nightActions[fixture.master] = {
      targetId: playerBySlot(fixture.state, fixture.diddy)!.playerId
    } as (typeof fixture.state.nightActions)[string];
    assert.match(seat.play(fixture.state, fixture.master, 'night', 'mason').say ?? '', /test|to see|as a test/i);
  });
});
