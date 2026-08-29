import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  QUICK_STALE_MS,
  armQuickCountdown,
  createQuickLobby,
  dropQuickMember,
  joinQuickLobby,
  markQuickSeen,
  quickBotsAllowed,
  quickDecision,
  quickMaxBots,
  quickNeeded,
  quickSeats,
  setQuickBots,
  setQuickReady,
  setQuickVote,
  tallyQuick,
  type QuickLobby,
  type QuickOptionSpec
} from './state.js';
import { toQuickView } from './view.js';

/**
 * The arithmetic a room's evening depends on.
 *
 * All of it is pure — no clock it was not handed, no randomness it did not
 * receive — which is what makes it testable here rather than by standing up a
 * server and five sockets. The cases below are the ones that actually decided
 * design questions: what a tie means, who counts towards a majority, and what
 * happens when the person whose vote tipped it changes their mind.
 */

const SPECS: QuickOptionSpec[] = [
  {
    key: 'map',
    label: 'Carte',
    choices: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
      { value: 'c', label: 'C' }
    ],
    roll: true,
    fallback: 'a'
  },
  {
    key: 'pace',
    label: 'Rythme',
    choices: [
      { value: 'slow', label: 'Lent' },
      { value: 'fast', label: 'Rapide' }
    ],
    roll: false,
    fallback: 'slow'
  }
];

/** Always draws the last choice, so "what was rolled" is unambiguous in a test. */
const lastChoice = (maxExclusive: number) => maxExclusive - 1;

function lobbyWith(members: string[], now = 1000, max = 6): QuickLobby {
  const lobby = createQuickLobby({
    code: 'ABCDE',
    game: 'coronaz',
    specs: SPECS,
    minPlayers: 2,
    maxPlayers: max,
    randomInt: lastChoice,
    now
  });

  for (const id of members) {
    joinQuickLobby(lobby, { id, name: id, now });
  }
  return lobby;
}

describe('the roll', () => {
  it('draws a random value for options that ask for one', () => {
    const lobby = lobbyWith([]);
    assert.equal(lobby.rolled.map, 'c');
  });

  it('pins the declared fallback for options that do not', () => {
    const lobby = lobbyWith([]);
    assert.equal(lobby.rolled.pace, 'slow');
  });

  it('falls back rather than throwing when an option has no choices at all', () => {
    const lobby = createQuickLobby({
      code: 'ABCDE',
      game: 'quiz',
      specs: [{ key: 'playlist', label: 'Quiz', choices: [], roll: true, fallback: '' }],
      minPlayers: 1,
      maxPlayers: 4,
      randomInt: lastChoice,
      now: 0
    });
    assert.equal(lobby.rolled.playlist, '');
  });
});

describe('tallying the settings', () => {
  it('keeps the roll while nobody has voted', () => {
    const lobby = lobbyWith(['a', 'b']);
    assert.equal(tallyQuick(lobby, SPECS).map, 'c');
  });

  it('takes the plurality, not a majority', () => {
    const lobby = lobbyWith(['a', 'b', 'c']);
    setQuickVote(lobby, 'a', SPECS, 'map', 'a', 1000);
    setQuickVote(lobby, 'b', SPECS, 'map', 'b', 1000);
    setQuickVote(lobby, 'c', SPECS, 'map', 'a', 1000);

    assert.equal(tallyQuick(lobby, SPECS).map, 'a');
  });

  it('keeps the roll on a tie rather than letting the first voter win', () => {
    const lobby = lobbyWith(['a', 'b']);
    setQuickVote(lobby, 'a', SPECS, 'map', 'a', 1000);
    setQuickVote(lobby, 'b', SPECS, 'map', 'b', 1000);

    assert.equal(tallyQuick(lobby, SPECS).map, 'c');
  });

  it('ignores a vote for a value that is not on offer', () => {
    const lobby = lobbyWith(['a']);
    assert.equal(setQuickVote(lobby, 'a', SPECS, 'map', 'z', 1000), false);
    assert.equal(tallyQuick(lobby, SPECS).map, 'c');
  });

  it('ignores a vote from somebody who is not in the room', () => {
    const lobby = lobbyWith(['a']);
    assert.equal(setQuickVote(lobby, 'ghost', SPECS, 'map', 'a', 1000), false);
  });
});

describe('deciding to start', () => {
  it('waits below the minimum however many say yes', () => {
    const lobby = lobbyWith(['a'], 1000);
    setQuickReady(lobby, 'a', true, 1000);

    assert.equal(quickDecision(lobby, 1000), 'wait');
  });

  it('needs a strict majority of the people present', () => {
    const lobby = lobbyWith(['a', 'b', 'c'], 1000);
    assert.equal(quickNeeded(lobby, 1000), 2);

    setQuickReady(lobby, 'a', true, 1000);
    assert.equal(quickDecision(lobby, 1000), 'wait');

    setQuickReady(lobby, 'b', true, 1000);
    assert.equal(quickDecision(lobby, 1000), 'countdown');
  });

  it('starts a full room without waiting for a vote', () => {
    const lobby = lobbyWith(['a', 'b'], 1000, 2);
    assert.equal(quickDecision(lobby, 1000), 'countdown');
  });

  /**
   * The case the heartbeat exists for: a phone that locked must not be able to
   * hold a room hostage, because the majority is counted over who is actually
   * there.
   */
  it('stops counting a member who has gone quiet', () => {
    const now = 1000;
    const lobby = lobbyWith(['a', 'b', 'c'], now);
    setQuickReady(lobby, 'a', true, now);
    setQuickReady(lobby, 'b', true, now);

    const later = now + QUICK_STALE_MS + 1;
    markQuickSeen(lobby, 'a', later);
    markQuickSeen(lobby, 'b', later);
    // 'c' has said nothing since, so two of two present are ready.
    assert.equal(quickNeeded(lobby, later), 2);
    assert.equal(quickDecision(lobby, later), 'countdown');
  });

  it('calls the countdown off when the vote that tipped it is withdrawn', () => {
    const lobby = lobbyWith(['a', 'b', 'c'], 1000);
    setQuickReady(lobby, 'a', true, 1000);
    setQuickReady(lobby, 'b', true, 1000);
    armQuickCountdown(lobby, 1000);

    setQuickReady(lobby, 'b', false, 1100);
    assert.equal(quickDecision(lobby, 1100), 'cancel');
  });

  it('launches once the countdown has run out', () => {
    const lobby = lobbyWith(['a', 'b'], 1000);
    setQuickReady(lobby, 'a', true, 1000);
    setQuickReady(lobby, 'b', true, 1000);
    armQuickCountdown(lobby, 1000, 5000);

    assert.equal(quickDecision(lobby, 4000), 'wait');
    assert.equal(quickDecision(lobby, 6000), 'launch');
  });

  /**
   * Leaving removes you rather than marking you away, and this is why: the
   * majority is a fraction of the room, so a ghost in the roster raises the bar
   * for everybody still in it.
   */
  it('lowers the bar when somebody leaves', () => {
    const lobby = lobbyWith(['a', 'b', 'c'], 1000);
    setQuickReady(lobby, 'a', true, 1000);
    assert.equal(quickDecision(lobby, 1000), 'wait');

    dropQuickMember(lobby, 'c', 1000);
    setQuickReady(lobby, 'b', true, 1000);
    assert.equal(quickDecision(lobby, 1000), 'countdown');
  });
});

describe('joining', () => {
  it('reclaims the same seat for a returning member id', () => {
    const lobby = lobbyWith(['a'], 1000);
    const again = joinQuickLobby(lobby, { id: 'a', name: 'a', now: 2000 });

    assert.equal(again.ok, true);
    assert.equal(Object.keys(lobby.members).length, 1);
  });

  it('refuses a full room', () => {
    const lobby = lobbyWith(['a', 'b'], 1000, 2);
    const result = joinQuickLobby(lobby, { id: 'c', name: 'c', now: 1000 });

    assert.deepEqual(result, { ok: false, error: 'full' });
  });

  it('refuses a room that has already left', () => {
    const lobby = lobbyWith(['a'], 1000);
    lobby.phase = 'launched';

    assert.deepEqual(joinQuickLobby(lobby, { id: 'b', name: 'b', now: 1000 }), {
      ok: false,
      error: 'started'
    });
  });
});

describe('the projection', () => {
  it('marks which vote is yours and how the room stands', () => {
    const lobby = lobbyWith(['a', 'b'], 1000);
    setQuickVote(lobby, 'a', SPECS, 'map', 'a', 1000);
    setQuickVote(lobby, 'b', SPECS, 'map', 'a', 1000);
    setQuickReady(lobby, 'a', true, 1000);

    const view = toQuickView(lobby, SPECS, 'a', 1000);
    const map = view.options.find((option) => option.key === 'map');

    assert.equal(view.you, 'a');
    assert.equal(view.ready, 1);
    assert.equal(view.needed, 2);
    assert.equal(map?.yours, 'a');
    assert.equal(map?.value, 'a');
    assert.equal(map?.choices.find((choice) => choice.value === 'a')?.votes, 2);
  });

  it('gives a watcher with no seat a null `you` rather than somebody else’s', () => {
    const lobby = lobbyWith(['a'], 1000);
    const view = toQuickView(lobby, SPECS, 'nobody', 1000);

    assert.equal(view.you, null);
    assert.equal(view.options[0]?.yours, null);
  });
});

/**
 * Bots exist so a room that is short of people can still play, which makes them
 * part of the launch arithmetic rather than decoration. These are the cases that
 * decided how far that goes: they count towards the minimum, they never count as
 * a vote, and they always give a seat back to a person.
 */
describe('bots', () => {
  it('lets a room short of people reach the minimum', () => {
    const lobby = lobbyWith(['a'], 1000);
    lobby.minPlayers = 4;

    assert.equal(quickDecision(lobby, 1000), 'wait');

    assert.equal(setQuickBots(lobby, 3, 1000), true);
    setQuickReady(lobby, 'a', true, 1000);

    assert.equal(quickDecision(lobby, 1000), 'countdown');
  });

  it('drops the yes votes needed by however many it seated', () => {
    const lobby = lobbyWith(['a'], 1000);
    lobby.minPlayers = 5;

    // Five needed from one phone: unreachable, which is the bug this guards.
    assert.equal(quickNeeded(lobby, 1000), 5);

    setQuickBots(lobby, 4, 1000);
    assert.equal(quickNeeded(lobby, 1000), 1);
  });

  it('never lets a bot vote: a room of one plus bots still needs that one yes', () => {
    const lobby = lobbyWith(['a'], 1000);
    lobby.minPlayers = 3;
    setQuickBots(lobby, 2, 1000);

    assert.equal(quickDecision(lobby, 1000), 'wait');
    setQuickReady(lobby, 'a', true, 1000);
    assert.equal(quickDecision(lobby, 1000), 'countdown');
  });

  it('clamps to the seats left rather than refusing the whole request', () => {
    const lobby = lobbyWith(['a', 'b'], 1000, 6);

    setQuickBots(lobby, 99, 1000);
    assert.equal(lobby.bots, 4);
    assert.equal(quickMaxBots(lobby), 4);
    assert.equal(quickSeats(lobby), 6);
  });

  it('gives a bot’s seat back when a person arrives at a full table', () => {
    const lobby = lobbyWith(['a'], 1000, 3);
    setQuickBots(lobby, 2, 1000);
    assert.equal(quickSeats(lobby), 3);

    joinQuickLobby(lobby, { id: 'b', name: 'b', now: 1000 });

    assert.equal(lobby.bots, 1);
    assert.equal(quickSeats(lobby), 3);
  });

  it('refuses them for the quiz, which has nothing for a bot to do', () => {
    const lobby = createQuickLobby({
      code: 'QUIZZ',
      game: 'quiz',
      specs: SPECS,
      minPlayers: 2,
      maxPlayers: 6,
      randomInt: lastChoice,
      now: 1000,
    });

    assert.equal(quickBotsAllowed('quiz'), false);
    assert.equal(setQuickBots(lobby, 3, 1000), false);
    assert.equal(lobby.bots, 0);
    assert.equal(toQuickView(lobby, SPECS, null, 1000).botsAllowed, false);
  });

  it('does not start a room on its own just because bots filled every seat', () => {
    const lobby = lobbyWith(['a'], 1000, 4);
    setQuickBots(lobby, 3, 1000);

    // Full, but nobody said yes: a full house of machines is not a decision.
    assert.equal(quickSeats(lobby), 4);
    assert.equal(quickDecision(lobby, 1000), 'wait');
  });

  it('reports them to the screen, with the room’s own ceiling', () => {
    const lobby = lobbyWith(['a', 'b'], 1000, 5);
    setQuickBots(lobby, 2, 1000);
    const view = toQuickView(lobby, SPECS, 'a', 1000);

    assert.equal(view.bots, 2);
    assert.equal(view.maxBots, 3);
    assert.equal(view.botsAllowed, true);
  });
});
