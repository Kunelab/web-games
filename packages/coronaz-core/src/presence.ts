import {
  castKickBallot,
  isPaused,
  markAway,
  noteBeat,
  openKickVote,
  parkDeadline,
  presenceView,
  resetPresence,
  restoreDeadline,
  tickPresence,
  type KickRefusal,
  type PresenceTick
} from 'presence-core';

import { activeHeroes, raidPresence, waitedOnHeroes, type CzState } from './state.js';

/**
 * The raid's half of the pause: presence-core supplies the rules, this file
 * connects them to a board.
 *
 * Its own module rather than another two hundred lines in `engine.ts`, which is
 * already the largest file here and is about zombies. Nothing in it touches the
 * board — it stops and starts the clock, and answers what the screens should
 * show — so it reads as one idea end to end.
 */

/**
 * Starts the clock on everybody's presence at the moment the raid begins.
 *
 * A lobby can sit open for twenty minutes, and somebody who wandered off during
 * it would otherwise start already past the kick delay — removable by the room
 * before they have had a single turn. So the windows are re-measured from now.
 *
 * The other half matters more: a seat that is already disconnected has to be
 * marked away again, not merely forgotten. Clearing the record alone would leave
 * it counting as present, no heartbeat would ever arrive to contradict that, and
 * the raid would play a whole night around an empty chair without pausing once.
 */
export function startRaidPresence(state: CzState, now: number): void {
  const presence = raidPresence(state);
  resetPresence(presence);
  for (const hero of Object.values(state.heroes)) {
    if (!hero.isBot && !hero.connected) markAway(presence, hero.playerId, now);
  }
}

/**
 * Puts a raid back on its feet after a restart. The counterpart to
 * `startRaidPresence`, for a state read back out of the database.
 *
 * Same trap as the lobby, and worse here. Every connection in the world died
 * with the process, so a `connected` flag read out of the snapshot describes the
 * moment before the restart and nothing about now; clearing the absences without
 * writing that down leaves an empty seat counting as a present survivor. No
 * heartbeat ever arrives to contradict it, so the raid never pauses for them —
 * and because it also never ends its hero phase without them (nobody sends their
 * ready, and a restored raid has no deadline), the room is stuck. The one remedy,
 * voting the seat out, is refused for the same reason: that player is here.
 *
 * Marking everybody away instead costs nothing when the phones reconnect on their
 * own inside the resync window, and gives the room its remedies back when they do
 * not.
 */
export function restoreRaidPresence(state: CzState, now: number): void {
  const presence = raidPresence(state);
  resetPresence(presence);

  for (const hero of Object.values(state.heroes)) {
    if (!hero.isBot) hero.connected = false;
  }
  // A raid that is not being played waits for nobody, and an absence recorded
  // there would only be a stale entry nothing ever clears.
  if (state.phase === 'heroes' || state.phase === 'enemy') {
    for (const playerId of waitedOnHeroes(state)) {
      // Not the ones already voted out: the room stopped waiting for those.
      if (!presence.kicked.includes(playerId)) markAway(presence, playerId, now);
    }
  }
}

/** A phone saying it is still there. True only when the seat was previously dark. */
export function noteHeroAlive(state: CzState, playerId: string, now: number): boolean {
  return noteBeat(raidPresence(state), playerId, now);
}

/** A socket that dropped, or a phone that has stopped beating. */
export function noteHeroSilent(state: CzState, playerId: string, now: number): boolean {
  return markAway(raidPresence(state), playerId, now);
}

/**
 * Advances the pause model, and stops or starts the phase clock with it.
 *
 * The clock is parked rather than left running: a paused raid sends
 * `phaseEndsAt: null`, so no screen counts down a hero phase that is not
 * passing, and what was left of it comes back untouched on resume.
 *
 * Idempotent, so the server may call it from its ticker, from every heartbeat
 * and from every phase change; calling it more often only makes it prompter.
 */
export function tickRaidPresence(state: CzState, now: number): PresenceTick {
  const presence = raidPresence(state);
  const tick = tickPresence(presence, waitedOnHeroes(state), now);

  if (tick.paused) {
    presence.parkedMs = parkDeadline(state.phaseEndsAt, now);
    state.phaseEndsAt = null;
  }
  if (tick.resumed) {
    state.phaseEndsAt = restoreDeadline(presence.parkedMs, now);
    presence.parkedMs = null;
  }
  return tick;
}

/** True while the raid is stopped: no clock, no horde, no hero actions. */
export function raidPaused(state: CzState): boolean {
  return isPaused(raidPresence(state));
}

export function proposeHeroKick(
  state: CzState,
  playerId: string,
  targetId: string,
  now: number
): { ok: true } | { ok: false; reason: KickRefusal } {
  return openKickVote(raidPresence(state), playerId, targetId, waitedOnHeroes(state), now);
}

export function voteHeroKick(
  state: CzState,
  playerId: string,
  yes: boolean
): { ok: true } | { ok: false; reason: KickRefusal } {
  return castKickBallot(raidPresence(state), playerId, yes, waitedOnHeroes(state));
}

/**
 * A seat the room removed, or one the pause ran out on, leaves the raid.
 *
 * Recorded as a forfeit, which the game already had a word for: out of play like
 * a death, but not a death. The career ledger counts the two separately on
 * purpose — "their connection died" and "the horde ate them" are different
 * evenings, and a leaderboard that confuses them is lying.
 */
export function dropHeroSeat(state: CzState, playerId: string): void {
  const hero = state.heroes[playerId];
  if (!hero || !hero.alive || hero.escaped || hero.forfeited) return;
  hero.forfeited = true;
  hero.ready = true;
  hero.connected = false;
}

/** What a phone is told about the pause: names, so a screen can say who. */
export interface CzPresenceView {
  paused: boolean;
  waitingFor: { playerId: string; name: string; awayMs: number }[];
  /** Quiet, but still inside the resync window: a mark, not an overlay. */
  recovering: { playerId: string; name: string }[];
  pauseExpiresAt: number | null;
  resumesAt: number | null;
  kickablePlayerIds: string[];
  vote: {
    playerId: string;
    name: string;
    closesAt: number;
    yes: number;
    no: number;
    needed: number;
    mine: boolean | null;
  } | null;
}

export function czPresenceView(state: CzState, now: number, viewerId: string | null): CzPresenceView {
  const view = presenceView(raidPresence(state), waitedOnHeroes(state), now, viewerId);
  const nameOf = (playerId: string): string => state.heroes[playerId]?.name ?? '?';

  return {
    paused: view.paused,
    waitingFor: view.waitingFor.map((seat) => ({
      playerId: seat.seatId,
      name: nameOf(seat.seatId),
      awayMs: seat.awayMs
    })),
    recovering: view.recovering.map((seat) => ({ playerId: seat.seatId, name: nameOf(seat.seatId) })),
    pauseExpiresAt: view.pauseExpiresAt,
    resumesAt: view.resumesAt,
    kickablePlayerIds: view.kickableSeatIds,
    vote: view.vote
      ? {
          playerId: view.vote.targetId,
          name: nameOf(view.vote.targetId),
          closesAt: view.vote.closesAt,
          yes: view.vote.yes,
          no: view.vote.no,
          needed: view.vote.needed,
          mine: view.vote.mine
        }
      : null
  };
}

/**
 * Whether the raid still has anybody in it to play for.
 *
 * Asked after a kick or an expired pause: a raid whose last human has left is
 * over, and continuing to run the horde against four bots nobody is watching is
 * how a table becomes a row in the database that never ends.
 */
export function raidAbandoned(state: CzState): boolean {
  return activeHeroes(state).every((hero) => hero.isBot);
}
