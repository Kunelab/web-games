/**
 * Who is still at the table, and what the game does about the ones who are not.
 *
 * Modelled on the way StarCraft II handles a drop, because that design has
 * survived twenty years of domestic routers: a player going dark stops the clock
 * rather than costing them the game, the room is told exactly who it is waiting
 * for, the wait is bounded, and removing somebody is a vote the room casts — but
 * not for the first half-minute, because most drops come back.
 *
 * Everything here is pure and JSON-serialisable. It lives inside the game's own
 * state, so it persists and restores with the game for free, and it knows
 * nothing about roles, boards or phases: the game passes in its roster and reads
 * back what changed. Transport and timers belong to the caller — the same split
 * chat-core uses.
 *
 * The one thing this file does not decide is what "away" means. The caller
 * reports heartbeats and disconnections; how patient to be is `PresenceRules`.
 */

/**
 * How often a phone says it is still there.
 *
 * Shared with the client so both sides agree what silence means: the server
 * counts missed beats, and `graceMs` is expressed in multiples of this. Two
 * seconds is frequent enough to notice a real problem inside a phase and cheap
 * enough that twenty-four phones cost nothing — it is one tiny event, not a
 * state broadcast.
 *
 * Deliberately far below socket.io's own ping timeout. That heartbeat exists to
 * decide whether the *connection* is dead; this one exists to decide whether the
 * *player* is there, which happens first and matters more.
 */
export const HEARTBEAT_MS = 2_000;

export interface PresenceRules {
  /**
   * The resync window: how long a seat may be silent before the room is stopped.
   *
   * Nothing happens during it. The game runs on, nobody else is interrupted, and
   * the absent phone is off retrying its socket and re-presenting its token —
   * which is where the overwhelming majority of disconnections end, several
   * seconds before anybody would have noticed.
   *
   * Five missed heartbeats. Long enough that a phone crossing from wifi to cell,
   * a laptop lid half-closed, or a tab throttled in the background all recover
   * invisibly; short enough that a real drop stops the clock inside one phase.
   * The alternative — pausing the moment a beat is late — means a table of
   * twenty-four freezing every few seconds because somebody walked past a lift,
   * and a pause that common is one nobody reads.
   */
  graceMs: number;
  /**
   * The longest the room will be held. Past this, play resumes without them.
   *
   * A bound rather than a promise to wait: somebody who closed the tab is never
   * coming back, and the other five people are still in the room.
   */
  maxPauseMs: number;
  /**
   * How long an absence must have lasted before a kick may be proposed.
   *
   * The reason this system exists. Most drops resolve in a few seconds, so the
   * kick button simply is not there yet — nobody can be punished for a reconnect
   * that was already going to finish.
   */
  kickAfterMs: number;
  /** How long a proposed kick stays open before it lapses. */
  voteMs: number;
  /**
   * The breath between everybody being back and play continuing.
   *
   * So the table is not resumed mid-sentence: every screen shows the same
   * countdown, and the player who just reconnected gets a moment to read the
   * board before their clock starts again.
   */
  resumeCountdownMs: number;
}

export const DEFAULT_RULES: PresenceRules = {
  graceMs: HEARTBEAT_MS * 5,
  maxPauseMs: 150_000,
  kickAfterMs: 30_000,
  voteMs: 45_000,
  resumeCountdownMs: 4_000
};

export interface PauseState {
  /** Server time the clock stopped. */
  since: number;
  /** Server time this pause lapses on its own, whoever is still missing. */
  expiresAt: number;
  /**
   * Set once everybody is back: play continues at this instant.
   *
   * A pause with a `resumesAt` is still a pause — nothing may act — but it is a
   * pause that is ending, which is a different thing to render.
   */
  resumesAt: number | null;
}

export interface KickVote {
  targetId: string;
  openedBy: string;
  closesAt: number;
  /** Ballots by voter id. An absent key is an abstention, not a no. */
  ballots: Record<string, boolean>;
}

export interface PresenceState {
  rules: PresenceRules;
  /**
   * When each silent seat was last heard from. Absent means present.
   *
   * A timestamp rather than a boolean because every decision here is about how
   * long: whether to pause yet, whether a kick may be proposed yet, and what to
   * tell the room it is waiting on.
   */
  awaySince: Record<string, number>;
  pause: PauseState | null;
  vote: KickVote | null;
  /** Seats the room voted out. They may not reclaim their token. */
  kicked: string[];
  /**
   * Total time this game has spent stopped.
   *
   * Kept so anything reasoning about elapsed play — an idle sweep, a stats line
   * — can tell "nobody has touched this in an hour" from "we were waiting".
   */
  pausedMs: number;
  /**
   * The phase clock, parked for the duration of the pause.
   *
   * A paused game sends `phaseEndsAt: null`, so no screen renders a countdown
   * that is not running — which is the honest thing to show and also stops a
   * phone from believing the night ended while everyone was waiting. What is
   * left of the phase is kept here instead, and handed back on resume.
   *
   * It lives with the pause rather than in each game's own state because both
   * games park exactly one deadline, and a pause that forgot to restore it would
   * leave a phase with no clock at all.
   */
  parkedMs: number | null;
}

export function createPresence(rules?: Partial<PresenceRules>): PresenceState {
  return {
    rules: { ...DEFAULT_RULES, ...rules },
    awaySince: {},
    pause: null,
    vote: null,
    kicked: [],
    pausedMs: 0,
    parkedMs: null
  };
}

/**
 * What is left of a phase deadline, to be held while the game is stopped.
 *
 * Clamped at zero: a phase whose clock had already run out when the pause began
 * resumes with nothing left, and resumes immediately, rather than coming back
 * with a negative deadline that fires in the past.
 */
export function parkDeadline(deadline: number | null, now: number): number | null {
  return deadline === null ? null : Math.max(0, deadline - now);
}

/** The deadline a resumed phase runs to: what was left of it, starting now. */
export function restoreDeadline(parkedMs: number | null, now: number): number | null {
  return parkedMs === null ? null : now + parkedMs;
}

/**
 * The seats the game actually waits for, supplied per call.
 *
 * A list rather than a lookup into game state, because only the game knows who
 * counts: a dead Mafia player has nothing left to do and must not be able to
 * freeze the town by closing their laptop, and neither must a hero who already
 * escaped the district. Bots never count — the server is always present.
 */
export type Roster = readonly string[];

/* ------------------------------ heartbeats ------------------------------- */

/**
 * Reports a seat as heard from. Returns true if this was news.
 *
 * Called on every heartbeat, so the common case is a no-op on a seat that was
 * never away: that check is why this returns a boolean rather than the caller
 * broadcasting on each beat.
 */
export function markPresent(presence: PresenceState, seatId: string): boolean {
  if (presence.awaySince[seatId] === undefined) return false;
  delete presence.awaySince[seatId];
  return true;
}

/**
 * Reports a seat as silent, keeping the earliest moment it went quiet.
 *
 * Earliest, because a socket that drops, retries and drops again is one absence
 * as far as the room is concerned — and if each attempt reset the clock, the
 * kick delay would never elapse for exactly the player it exists to handle.
 */
export function markAway(presence: PresenceState, seatId: string, now: number): boolean {
  if (presence.awaySince[seatId] !== undefined) return false;
  presence.awaySince[seatId] = now;
  return true;
}

/** Forgets a seat entirely: it left, was kicked, or the game is over for it. */
export function forgetSeat(presence: PresenceState, seatId: string): void {
  delete presence.awaySince[seatId];
  if (presence.vote?.targetId === seatId) presence.vote = null;
  if (presence.vote) delete presence.vote.ballots[seatId];
}

/** Seats that have been silent past the resync window, longest first. */
export function missing(presence: PresenceState, roster: Roster, now: number): string[] {
  return silent(presence, roster).filter((seatId) => age(presence, seatId, now) >= presence.rules.graceMs);
}

/**
 * Seats that are quiet but still inside their resync window.
 *
 * Reported separately from `missing` so a screen can show that somebody is
 * wobbling without the game stopping: a small mark against one name, rather than
 * an overlay across everybody. Most of these never become a pause at all, which
 * is exactly the point of telling them apart.
 */
export function recovering(presence: PresenceState, roster: Roster, now: number): string[] {
  return silent(presence, roster).filter((seatId) => age(presence, seatId, now) < presence.rules.graceMs);
}

/** Every quiet seat, oldest silence first. How quiet is the caller's question. */
function silent(presence: PresenceState, roster: Roster): string[] {
  return roster
    .filter((seatId) => presence.awaySince[seatId] !== undefined)
    .sort((a, b) => (presence.awaySince[a] ?? 0) - (presence.awaySince[b] ?? 0));
}

function age(presence: PresenceState, seatId: string, now: number): number {
  const since = presence.awaySince[seatId];
  return since === undefined ? 0 : now - since;
}

/* -------------------------------- the tick ------------------------------- */

/**
 * What one evaluation decided. Every field is something the caller must act on.
 *
 * Returned rather than applied through callbacks so the whole decision is one
 * value a test can assert against, and so the caller — which owns the timers,
 * the socket and the database — stays the only thing with side effects.
 */
export interface PresenceTick {
  /** The clock must stop now. */
  paused: boolean;
  /** The clock must start now. */
  resumed: boolean;
  /** Play is continuing without these seats; the game decides their fate. */
  abandoned: string[];
  /**
   * The vote closed, and who it was about.
   *
   * The seat is reported either way, because the room has to be told the outcome
   * of a vote it was asked to cast — "the table gives Bob more time" is as much a
   * result as removing him, and the caller cannot name Bob from `kicked` alone.
   */
  voteClosed: boolean;
  voteTargetId: string | null;
  /** Set only when the vote carried; the seat is now on `kicked`. */
  kicked: string | null;
  /** Anything above happened, so the room needs the new projection. */
  changed: boolean;
}

/**
 * Advances the presence model to `now`. Idempotent, so it is safe to call from a
 * ticker, from a heartbeat, and from a phase change.
 *
 * The order of the decisions is deliberate. A closing vote is resolved first,
 * because a seat the room has just removed is no longer a seat the room is
 * waiting for; then the pause is lifted or expired; then a fresh absence opens
 * one. So a game never pauses for a player it kicked in the same tick.
 */
export function tickPresence(presence: PresenceState, roster: Roster, now: number): PresenceTick {
  const result: PresenceTick = {
    paused: false,
    resumed: false,
    abandoned: [],
    voteClosed: false,
    voteTargetId: null,
    kicked: null,
    changed: false
  };

  const vote = presence.vote;
  if (vote && (now >= vote.closesAt || decided(presence, roster, vote))) {
    presence.vote = null;
    result.voteClosed = true;
    result.voteTargetId = vote.targetId;
    result.changed = true;
    if (carried(presence, roster, vote)) {
      result.kicked = vote.targetId;
      presence.kicked.push(vote.targetId);
      forgetSeat(presence, vote.targetId);
    }
  }

  // A kicked seat leaves the wait immediately: the caller has not applied the
  // removal yet, but the room has already stopped waiting for it.
  const waited = roster.filter((seatId) => !presence.kicked.includes(seatId));
  const gone = missing(presence, waited, now);
  const pause = presence.pause;

  if (pause) {
    if (gone.length === 0) {
      // Everybody is back: start the countdown, or finish it.
      if (pause.resumesAt === null) {
        pause.resumesAt = now + presence.rules.resumeCountdownMs;
        result.changed = true;
      } else if (now >= pause.resumesAt) {
        presence.pausedMs += now - pause.since;
        presence.pause = null;
        result.resumed = true;
        result.changed = true;
      }
      return result;
    }

    // Somebody dropped again mid-countdown: the wait is back on.
    if (pause.resumesAt !== null) {
      pause.resumesAt = null;
      result.changed = true;
    }

    if (now >= pause.expiresAt) {
      presence.pausedMs += now - pause.since;
      presence.pause = null;
      presence.vote = null;
      result.resumed = true;
      result.abandoned = gone;
      result.changed = true;
    }
    return result;
  }

  if (gone.length > 0) {
    presence.pause = { since: now, expiresAt: now + presence.rules.maxPauseMs, resumesAt: null };
    result.paused = true;
    result.changed = true;
  }

  return result;
}

/** True while nothing in the game may act: no clock, no bots, no actions. */
export function isPaused(presence: PresenceState): boolean {
  return presence.pause !== null;
}

/* --------------------------------- votes --------------------------------- */

/**
 * Why a kick was refused, as a value.
 *
 * The caller renders these in the reader's language, so they travel as keys —
 * the same rule the rest of this workspace follows for anything a person reads.
 */
export type KickRefusal =
  | 'not-seated'
  | 'no-vote'
  | 'target-not-seated'
  | 'target-present'
  | 'too-soon'
  | 'already-open'
  | 'already-kicked'
  | 'self';

export type VoteOutcome = { ok: true } | { ok: false; reason: KickRefusal };

/**
 * Proposes removing a seat the room has been waiting on.
 *
 * Every refusal here is a rule worth stating out loud: nobody may kick
 * themselves, nobody may kick a player who is present, and nobody may kick a
 * player who dropped four seconds ago. That last one is `kickAfterMs`, and it is
 * the point of the whole feature — the delay is what makes this a remedy for an
 * abandoned game rather than a weapon against a bad connection.
 */
export function openKickVote(
  presence: PresenceState,
  openerId: string,
  targetId: string,
  roster: Roster,
  now: number
): VoteOutcome {
  if (!roster.includes(openerId)) return { ok: false, reason: 'not-seated' };
  if (openerId === targetId) return { ok: false, reason: 'self' };
  if (!roster.includes(targetId)) return { ok: false, reason: 'target-not-seated' };
  if (presence.kicked.includes(targetId)) return { ok: false, reason: 'already-kicked' };
  if (presence.vote) return { ok: false, reason: 'already-open' };

  const since = presence.awaySince[targetId];
  if (since === undefined) return { ok: false, reason: 'target-present' };
  if (now - since < presence.rules.kickAfterMs) return { ok: false, reason: 'too-soon' };

  // The proposer's own yes is implied: nobody opens a vote they are against.
  presence.vote = {
    targetId,
    openedBy: openerId,
    closesAt: now + presence.rules.voteMs,
    ballots: { [openerId]: true }
  };
  return { ok: true };
}

export function castKickBallot(presence: PresenceState, voterId: string, yes: boolean, roster: Roster): VoteOutcome {
  const vote = presence.vote;
  if (!vote) return { ok: false, reason: 'no-vote' };
  if (!roster.includes(voterId)) return { ok: false, reason: 'not-seated' };
  if (voterId === vote.targetId) return { ok: false, reason: 'self' };
  vote.ballots[voterId] = yes;
  return { ok: true };
}

/** Seats entitled to a ballot: everyone still seated except the accused. */
function electorate(presence: PresenceState, roster: Roster, vote: KickVote): string[] {
  return roster.filter((seatId) => seatId !== vote.targetId && !presence.kicked.includes(seatId));
}

function yesCount(vote: KickVote, voters: string[]): number {
  return voters.filter((seatId) => vote.ballots[seatId] === true).length;
}

/** Ballots still needed to carry a vote, given who is entitled to cast one. */
function stillNeeded(vote: KickVote, voters: string[]): number {
  return Math.max(0, Math.floor(voters.length / 2) + 1 - yesCount(vote, voters));
}

/**
 * More than half the electorate said yes.
 *
 * Counted against everyone entitled to vote rather than everyone who did, so
 * silence protects the accused: one person awake at a table of six cannot remove
 * somebody by being the only one to press a button.
 */
function carried(presence: PresenceState, roster: Roster, vote: KickVote): boolean {
  const voters = electorate(presence, roster, vote);
  if (voters.length === 0) return false;
  return yesCount(vote, voters) * 2 > voters.length;
}

/** True once no further ballot could change the outcome; closes the vote early. */
function decided(presence: PresenceState, roster: Roster, vote: KickVote): boolean {
  const voters = electorate(presence, roster, vote);
  if (voters.length === 0) return true;
  if (carried(presence, roster, vote)) return true;
  const no = voters.filter((seatId) => vote.ballots[seatId] === false).length;
  // Enough refusals that the remaining yeses could no longer reach a majority.
  return (voters.length - no) * 2 <= voters.length;
}

/* ------------------------------ projection ------------------------------- */

/**
 * What a screen is told, with the ballots reduced to counts.
 *
 * Who voted which way is deliberately not sent. In Mafia it would be read as
 * evidence — a graveyard arguing about who tried to remove whom is a game about
 * the network, not about the wolves — and in a co-op raid it is somebody's bad
 * evening being put to a recorded vote.
 */
export interface PresenceView {
  paused: boolean;
  /** Seats being waited on, with how long each has been silent. */
  waitingFor: { seatId: string; awayMs: number }[];
  /**
   * Seats quiet but still inside the resync window, so play has not stopped.
   *
   * Rendered as a mark beside one name rather than an overlay over the game: a
   * micro-lag is worth showing and not worth interrupting anybody for.
   */
  recovering: { seatId: string; awayMs: number }[];
  /** When this pause lapses on its own; the room sees the bound it is inside. */
  pauseExpiresAt: number | null;
  /** Set while the resume countdown runs. Every screen shows the same number. */
  resumesAt: number | null;
  /** Absentees a kick may now be proposed against. */
  kickableSeatIds: string[];
  vote: {
    targetId: string;
    closesAt: number;
    yes: number;
    no: number;
    /** Ballots still needed to carry it, so the room knows where it stands. */
    needed: number;
    /** Whether this recipient has already voted, and which way. */
    mine: boolean | null;
  } | null;
  kicked: string[];
}

export function presenceView(
  presence: PresenceState,
  roster: Roster,
  now: number,
  viewerId: string | null
): PresenceView {
  const waited = roster.filter((seatId) => !presence.kicked.includes(seatId));
  const gone = missing(presence, waited, now);
  const vote = presence.vote;
  const voters = vote ? electorate(presence, roster, vote) : [];

  return {
    paused: presence.pause !== null,
    waitingFor: gone.map((seatId) => ({ seatId, awayMs: age(presence, seatId, now) })),
    recovering: recovering(presence, waited, now).map((seatId) => ({ seatId, awayMs: age(presence, seatId, now) })),
    pauseExpiresAt: presence.pause?.expiresAt ?? null,
    resumesAt: presence.pause?.resumesAt ?? null,
    kickableSeatIds: vote ? [] : gone.filter((seatId) => age(presence, seatId, now) >= presence.rules.kickAfterMs),
    vote: vote
      ? {
          targetId: vote.targetId,
          closesAt: vote.closesAt,
          yes: yesCount(vote, voters),
          no: voters.filter((seatId) => vote.ballots[seatId] === false).length,
          needed: stillNeeded(vote, voters),
          mine: viewerId === null ? null : (vote.ballots[viewerId] ?? null)
        }
      : null,
    kicked: [...presence.kicked]
  };
}

/**
 * Clears everything transient, keeping the record.
 *
 * Called when a game is restored from the database: every socket in the world is
 * gone, so an absence measured before the restart says nothing about now, and a
 * pause nobody is left to end is a game frozen forever. The kick list survives —
 * somebody the room voted out stays voted out across a deploy.
 */
export function resetPresence(presence: PresenceState): void {
  presence.awaySince = {};
  presence.pause = null;
  presence.vote = null;
  presence.parkedMs = null;
}
