import { post, systemPost, visibleTo, type ChatMessage } from 'chat-core';
import type { Msg } from 'i18n';
import {
  castKickBallot,
  isPaused,
  markAway,
  markPresent,
  missing,
  openKickVote,
  parkDeadline,
  resetPresence,
  presenceView,
  restoreDeadline,
  tickPresence,
  type KickRefusal,
  type PresenceTick
} from 'presence-core';

import { BODY, CAUSE, M, type DeathSource } from './messages.js';

import {
  BYSTANDER_ROLES,
  FAMILIES,
  familyOf,
  isSoloKiller,
  roleDef,
  type FamilyId,
  type NightActionType,
  type RoleId
} from './roles.js';
import {
  alivePlayers,
  assignRoles,
  chatRules,
  jailChannel,
  nextBotName,
  nextFreeSlot,
  playerBySlot,
  playerFamily,
  pmChannel,
  seatPlayer,
  tablePresence,
  voteWeight,
  waitedOnSeats,
  type MafiaPlayer,
  type MafiaState,
  type NightAction,
  type PointEntry
} from './state.js';

/**
 * All mutation of a Mafia table. Every function validates against the state it
 * is given and returns plain results; timers, persistence and broadcasting are
 * the server manager's job. `now` is always passed in, `rng` is injectable, so
 * the whole engine replays deterministically under test.
 */

export interface ActionOutcome {
  ok: boolean;
  error?: string;
}

/**
 * What every game action answers while the table is stopped.
 *
 * Chat is deliberately *not* on this list. A pause is a social moment — "anyone
 * know where house 4 went?" — and the day clock is frozen for everybody, so
 * nobody is losing time they would otherwise have had. What is forbidden is
 * anything that changes the board: a vote, a ballot, a night order, a jailing.
 * Those would let the room act on an absence the pause exists to protect.
 */
const PAUSED_REFUSAL: ActionOutcome = { ok: false, error: 'La partie est en pause' };


const POINTS: Record<PointEntry['reason'], number> = {
  win: 5,
  'solo-win': 5,
  survive: 2,
  kill: 1,
  save: 2,
  'lynch-evil': 1,
  'execute-evil': 2,
  participation: 1
};

function addPoints(state: MafiaState, playerId: string, reason: PointEntry['reason']): void {
  state.points.push({ playerId, reason, amount: POINTS[reason] });
}

/** Files one protector against the house they are standing in front of tonight. */
function addProtector(byHouse: Map<string, string[]>, houseId: string, protectorId: string): void {
  byHouse.set(houseId, [...(byHouse.get(houseId) ?? []), protectorId]);
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function notify(player: MafiaPlayer, text: string): void {
  player.notifications.push(text);
  // The feed is private and unbounded otherwise; a phone needs the recent past only.
  if (player.notifications.length > 60) player.notifications.splice(0, player.notifications.length - 60);
}

function announce(state: MafiaState, line: Msg, now: number): ChatMessage {
  return systemPost(state.chat, 'day', line, now);
}

/**
 * An announcement that names somebody's identity — or their killer's.
 *
 * Marked at the source so a shared screen can withhold it. Every phone at the
 * table still receives it in full; the flag is not privacy, it is a label saying
 * "this line is a reveal", for surfaces that more than one person is looking at.
 */
function announceReveal(state: MafiaState, line: Msg, now: number): void {
  systemPost(state.chat, 'day', line, now, { reveals: true });
}

/** A line of the dawn report, and whether it gives an identity away. */
interface Announcement {
  line: Msg;
  reveals?: boolean;
}

/* ------------------------------- lobby ---------------------------------- */

export function joinMafia(
  state: MafiaState,
  name: string,
  token: string,
  playerId: string,
  presetToken?: string,
  account?: string
): { player: MafiaPlayer; rejoined: boolean } {
  // A returning phone proves its seat with the token it stored.
  if (presetToken) {
    const seated = Object.values(state.players).find((player) => player.token === presetToken);
    if (seated) {
      /**
       * A seat the room voted out cannot be reclaimed by the token that held it.
       *
       * Without this the vote is decoration: the removed player reconnects two
       * seconds later, the reclaim succeeds because the token is still valid, and
       * the table is back where it started with no way to say so.
       */
      if (tablePresence(state).kicked.includes(seated.playerId)) {
        throw new Error('La table a continué sans vous');
      }
      seated.connected = true;
      noteSeatAlive(state, seated.playerId);
      return { player: seated, rejoined: true };
    }
  }

  if (state.phase !== 'lobby') throw new Error('La partie a déjà commencé');

  const trimmed = name.trim().slice(0, 20);
  if (!trimmed) throw new Error('Il faut un nom');
  if (Object.values(state.players).some((player) => player.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new Error('Ce nom est déjà pris');
  }

  const slot = nextFreeSlot(state);
  if (slot === null) throw new Error('La table est pleine');

  const player = seatPlayer({ playerId, token, name: trimmed, slot, isBot: false, account });
  state.players[playerId] = player;
  return { player, rejoined: false };
}

export function addMafiaBot(state: MafiaState, token: string, playerId: string): MafiaPlayer {
  if (state.phase !== 'lobby') throw new Error('La partie a déjà commencé');
  const slot = nextFreeSlot(state);
  if (slot === null) throw new Error('La table est pleine');

  const player = seatPlayer({ playerId, token, name: nextBotName(state), slot, isBot: true });
  state.players[playerId] = player;
  return player;
}

export function removeMafiaBot(state: MafiaState, playerId: string): void {
  const player = state.players[playerId];
  if (state.phase === 'lobby' && player?.isBot) {
    delete state.players[playerId];
  }
}

export function startMafia(state: MafiaState, now: number, rng: () => number): void {
  if (state.phase !== 'lobby') throw new Error('Déjà en cours');
  if (Object.keys(state.players).length < state.config.minPlayers) {
    throw new Error(`Il faut au moins ${state.config.minPlayers} joueurs`);
  }

  assignRoles(state, rng);

  for (const player of Object.values(state.players)) {
    const def = roleDef(player.role!);
    notify(player, `Vous êtes ${def.name}. ${def.description}`);
    if (player.obsessionId) {
      const mark = state.players[player.obsessionId];
      if (mark) notify(player, `Votre obsession : faire pendre ${mark.name} (maison ${mark.slot}).`);
    }
  }

  startPresenceFresh(state, now);
  beginDay(state, now, [{ line: M.gameStart() }]);
}

/**
 * Starts the clock on everybody's presence at the moment the game begins.
 *
 * A lobby can sit open for twenty minutes, and somebody who wandered off during
 * it would otherwise start the game already past the kick delay — removable by
 * the room before they have had a single turn. So the windows are re-measured
 * from now.
 *
 * The other half matters more: a seat that is *already* disconnected has to be
 * marked away again, not merely forgotten. Clearing the record alone would leave
 * it counting as present, no heartbeat would ever arrive to contradict that, and
 * the table would play a whole game around an empty chair without pausing once.
 */
function startPresenceFresh(state: MafiaState, now: number): void {
  const presence = tablePresence(state);
  resetPresence(presence);
  for (const player of Object.values(state.players)) {
    if (!player.isBot && !player.connected) markAway(presence, player.playerId, now);
  }
}

/* -------------------------------- chat ---------------------------------- */

export function sayInChat(
  state: MafiaState,
  playerId: string,
  channel: string,
  text: string,
  now: number
): { ok: true; message: ChatMessage } | { ok: false; error: string } {
  const player = state.players[playerId];
  if (!player) return { ok: false, error: 'Pas à cette table' };

  const rules = chatRules();
  if (!rules.canWrite(channel, playerId, state)) {
    return { ok: false, error: 'Vous ne pouvez pas parler ici' };
  }

  return post(state.chat, { channel, authorId: playerId, authorName: player.name, text, at: now });
}

export function chatVisibleTo(state: MafiaState, playerId: string): ChatMessage[] {
  return visibleTo(state.chat, playerId, state, chatRules());
}

/**
 * A whisper: private words, public gesture. The message lands in the pair's
 * pm channel; the whole square sees *that* two players leaned together —
 * which is half the fun and most of the danger.
 */
export function whisperTo(
  state: MafiaState,
  fromId: string,
  targetSlot: number,
  text: string,
  now: number
): { ok: true; message: ChatMessage; gossip: ChatMessage } | { ok: false; error: string } {
  const from = state.players[fromId];
  const target = playerBySlot(state, targetSlot);
  if (!from || !target) return { ok: false, error: 'Destinataire introuvable' };
  if (target.playerId === fromId) return { ok: false, error: 'Se parler à soi-même, ça inquiète les voisins' };

  const channel = pmChannel(fromId, target.playerId);
  const rules = chatRules();
  if (!rules.canWrite(channel, fromId, state)) {
    return { ok: false, error: 'Impossible de murmurer maintenant' };
  }

  const result = post(state.chat, { channel, authorId: fromId, authorName: from.name, text, at: now });
  if (!result.ok) return result;

  // Both messages are handed back rather than left for the caller to fish out of
  // the tail of the log: the square's notice is a second delivery to a second
  // audience, and which position it lands in is the chat's business, not ours.
  return { ok: true, message: result.message, gossip: announce(state, M.whisperSeen(from.name, target.name), now) };
}

export function setLastWill(state: MafiaState, playerId: string, text: string): ActionOutcome {
  const player = state.players[playerId];
  if (!player || !player.alive) return { ok: false, error: 'Trop tard' };
  player.lastWill = text.slice(0, 400);
  return { ok: true };
}

/* ----------------------------- day actions ------------------------------ */

export function revealMayor(state: MafiaState, playerId: string, now: number): ActionOutcome {
  if (mafiaPaused(state)) return PAUSED_REFUSAL;
  const player = state.players[playerId];
  if (!player?.alive || (player.role !== 'mayor' && player.role !== 'marshall')) {
    return { ok: false, error: 'Impossible' };
  }
  if (state.phase !== 'day') return { ok: false, error: 'Attendez le jour' };
  if (player.revealed) return { ok: false, error: 'Déjà révélé' };

  player.revealed = true;
  announce(state, player.role === 'mayor' ? M.mayorReveal(player.name) : M.marshallReveal(player.name), now);
  return { ok: true };
}

/** A revealed, living marshall turns the day into an assembly line of justice. */
function marshallActive(state: MafiaState): boolean {
  return Object.values(state.players).some((player) => player.alive && player.role === 'marshall' && player.revealed);
}

/**
 * The judge's exceptional court: the current top-voted player goes straight to
 * judgement — no accusation threshold, no defense — and the judge's secret
 * ballot counts triple. Once per game, and nobody knows who called it.
 */
export function callCourt(state: MafiaState, playerId: string, now: number): ActionOutcome {
  if (mafiaPaused(state)) return PAUSED_REFUSAL;
  const judge = state.players[playerId];
  if (!judge?.alive || judge.role !== 'judge') return { ok: false, error: 'Impossible' };
  if (judge.charges <= 0) return { ok: false, error: 'Le tribunal a déjà siégé' };
  if (state.phase !== 'day' || state.stage !== 'discussion' || state.day <= 1) {
    return { ok: false, error: 'Pas maintenant' };
  }

  // The court needs a defendant: the current top-voted player.
  const counts = new Map<string, number>();
  for (const targetId of Object.values(state.votes)) {
    counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  }
  let accusedId: string | null = null;
  let best = 0;
  for (const [targetId, count] of counts) {
    if (count > best && state.players[targetId]?.alive) {
      accusedId = targetId;
      best = count;
    }
  }
  if (!accusedId) return { ok: false, error: 'Personne n’est accusé' };

  judge.charges -= 1;
  state.trial = { accusedId, ballots: {}, court: true };
  state.stage = 'judgement';
  state.votes = {};
  state.trialsToday += 1;
  state.phaseEndsAt = now + state.config.judgementMs;
  const accused = state.players[accusedId];
  announce(state, M.trialCourt(accused.name), now);
  return { ok: true };
}

/** The jailor picks his prisoner in daylight; the cell locks at dusk. */
export function jailTarget(state: MafiaState, playerId: string, targetSlot: number | null): ActionOutcome {
  if (mafiaPaused(state)) return PAUSED_REFUSAL;
  const player = state.players[playerId];
  if (!player?.alive || player.role !== 'jailor') return { ok: false, error: 'Impossible' };
  if (state.phase !== 'day') return { ok: false, error: 'Choisissez pendant le jour' };

  if (targetSlot === null) {
    state.jailedId = null;
    return { ok: true };
  }
  const target = playerBySlot(state, targetSlot);
  if (!target?.alive || target.playerId === playerId) return { ok: false, error: 'Cible invalide' };
  state.jailedId = target.playerId;
  return { ok: true };
}

export function castVote(state: MafiaState, voterId: string, targetSlot: number | null, now: number): ActionOutcome {
  if (mafiaPaused(state)) return PAUSED_REFUSAL;
  const voter = state.players[voterId];
  if (!voter?.alive) return { ok: false, error: 'Les morts ne votent pas' };
  if (state.phase !== 'day' || state.stage !== 'discussion') return { ok: false, error: 'Pas maintenant' };
  if (state.day <= 1) return { ok: false, error: 'Pas de vote le premier jour' };

  if (targetSlot === null) {
    delete state.votes[voterId];
    return { ok: true };
  }

  const target = playerBySlot(state, targetSlot);
  if (!target?.alive) return { ok: false, error: 'Cible invalide' };
  if (target.playerId === voterId) return { ok: false, error: 'Pas contre soi-même' };

  state.votes[voterId] = target.playerId;

  const alive = alivePlayers(state);
  const needed = Math.floor(alive.reduce((sum, p) => sum + voteWeight(p), 0) / 2) + 1;
  const against = alive
    .filter((p) => state.votes[p.playerId] === target.playerId)
    .reduce((sum, p) => sum + voteWeight(p), 0);

  /**
   * An accusation is no longer announced.
   *
   * It used to post a system line on every single vote, including every change of
   * mind — twenty-four players revising twice is seventy-odd lines a day, and the
   * chat log is a fixed ring, so the day phase was steadily deleting its own
   * record of who died and what they turned out to be. The live count belongs on
   * the player list, where it now sits beside each name and updates without
   * costing anything; only the moment that actually changes the game — the
   * threshold falling — is worth a line in the square.
   */
  if (against >= needed) {
    state.trial = { accusedId: target.playerId, ballots: {} };
    state.votes = {};
    state.trialsToday += 1;
    if (marshallActive(state)) {
      // The marshall's day: straight to the verdict.
      state.stage = 'judgement';
      state.phaseEndsAt = now + state.config.judgementMs;
      announce(state, M.trialNoDefence(target.name), now);
    } else {
      state.stage = 'defense';
      state.phaseEndsAt = now + state.config.defenseMs;
      announce(state, M.trialDragged(target.name), now);
    }
  }
  return { ok: true };
}

export function castBallot(
  state: MafiaState,
  voterId: string,
  verdict: 'guilty' | 'innocent' | 'abstain'
): ActionOutcome {
  if (mafiaPaused(state)) return PAUSED_REFUSAL;
  const voter = state.players[voterId];
  if (!voter?.alive) return { ok: false, error: 'Les morts ne votent pas' };
  if (state.phase !== 'day' || state.stage !== 'judgement' || !state.trial) {
    return { ok: false, error: 'Pas maintenant' };
  }
  if (state.trial.accusedId === voterId) return { ok: false, error: "L'accusé ne vote pas" };

  if (verdict === 'abstain') delete state.trial.ballots[voterId];
  else state.trial.ballots[voterId] = verdict;
  return { ok: true };
}

/* ---------------------------- night actions ----------------------------- */

export interface LegalAction {
  type: NightActionType;
  /** Slots this action may target; empty for self-targeted powers. */
  targets: number[];
  charges: number | null;
}

export function legalNightAction(state: MafiaState, playerId: string): LegalAction | null {
  const player = state.players[playerId];
  if (!player?.alive || state.phase !== 'night' || !player.role) return null;
  if (state.jailedId === playerId) return null;

  const def = roleDef(player.role);
  if (!def.nightAction) return null;
  if (def.charges !== undefined && player.charges <= 0) return null;

  const family = playerFamily(player);
  const others = alivePlayers(state).filter((other) => other.playerId !== playerId);
  const outsiders = others.filter((other) => family === null || playerFamily(other) !== family);
  const slots = (list: MafiaPlayer[]) => list.map((entry) => entry.slot);
  const uses = def.charges !== undefined ? player.charges : null;

  switch (def.nightAction) {
    case 'alert':
    case 'vest':
      return { type: def.nightAction, targets: [], charges: player.charges };
    case 'jail-execute': {
      if (!state.jailedId) return null;
      const jailed = state.players[state.jailedId];
      return jailed?.alive ? { type: 'jail-execute', targets: [jailed.slot], charges: player.charges } : null;
    }
    case 'kill': {
      // The vigilante holds fire the first night; the town has met nobody yet.
      if (player.role === 'vigilante' && state.day <= 1) return null;
      return { type: 'kill', targets: slots(family ? outsiders : others), charges: uses };
    }
    case 'frame':
    case 'silence':
    case 'charm':
    case 'rampage':
    case 'poison':
    case 'kidnap':
    case 'audit':
      return { type: def.nightAction, targets: slots(outsiders), charges: uses };
    case 'clean':
      // You only clean bodies the family made; anybody outside is fair prep.
      return { type: 'clean', targets: slots(outsiders), charges: uses };
    case 'douse':
    case 'charge':
      // Any house can be prepared; his own house means pulling the trigger.
      return { type: def.nightAction, targets: [...slots(others), player.slot], charges: null };
    case 'swap':
      // Two houses trade fates; the driver may ride his own bus.
      return { type: 'swap', targets: [...slots(others), player.slot], charges: null };
    case 'convert':
      if (player.cooldownUntilDay !== null && state.day < player.cooldownUntilDay) return null;
      return { type: 'convert', targets: slots(outsiders), charges: null };
    case 'bond':
      if (player.bondPartnerId !== null) return null;
      return { type: 'bond', targets: slots(others), charges: uses };
    case 'remember':
    case 'autopsy': {
      const dead = Object.values(state.players).filter((entry) => !entry.alive);
      return dead.length > 0 ? { type: def.nightAction, targets: slots(dead), charges: uses } : null;
    }
    default:
      return { type: def.nightAction, targets: slots(others), charges: null };
  }
}

export function setNightAction(
  state: MafiaState,
  playerId: string,
  targetSlot: number | null,
  secondTargetSlot?: number | null
): ActionOutcome {
  if (mafiaPaused(state)) return PAUSED_REFUSAL;
  const legal = legalNightAction(state, playerId);
  if (!legal) return { ok: false, error: 'Aucune action possible' };

  if (targetSlot === null) {
    delete state.nightActions[playerId];
    return { ok: true };
  }

  let targetId: string | null = null;
  if (legal.targets.length > 0) {
    const target = playerBySlot(state, targetSlot);
    if (!target || !legal.targets.includes(target.slot)) return { ok: false, error: 'Cible invalide' };
    targetId = target.playerId;
  }

  // Second target (witch destination, bus's other house): optional; the night
  // resolver rolls one when it's missing.
  let secondTargetId: string | null = null;
  if ((legal.type === 'control' || legal.type === 'swap') && secondTargetSlot != null) {
    const destination = playerBySlot(state, secondTargetSlot);
    if (destination?.alive) secondTargetId = destination.playerId;
  }

  state.nightActions[playerId] = { type: legal.type, targetId, secondTargetId };
  return { ok: true };
}

/* -------------------------------- presence ------------------------------- */

/**
 * A phone saying it is still there. Cheap, and the common case changes nothing.
 *
 * Returns true only when this beat was news — a seat coming back from the dead —
 * so the caller broadcasts once per return rather than once per heartbeat.
 */
export function noteSeatAlive(state: MafiaState, playerId: string): boolean {
  return markPresent(tablePresence(state), playerId);
}

/** A socket that dropped, or a phone that has stopped beating. */
export function noteSeatSilent(state: MafiaState, playerId: string, now: number): boolean {
  return markAway(tablePresence(state), playerId, now);
}

/**
 * Advances the pause model, and stops or starts the phase clock with it.
 *
 * The clock is parked rather than left running: a paused table sends
 * `phaseEndsAt: null`, so no phone counts down a night that is not passing, and
 * what was left of the phase comes back untouched on resume. That is the whole
 * reason a pause is safe to use in a game whose every phase is on a timer.
 *
 * Called from the server ticker, from every heartbeat and from every phase
 * change; it is idempotent, so calling it more often only makes it more prompt.
 */
export function tickMafiaPresence(state: MafiaState, now: number): PresenceTick {
  const presence = tablePresence(state);
  const waiting = waitedOnSeats(state);
  const tick = tickPresence(presence, waiting, now);

  if (tick.paused) {
    presence.parkedMs = parkDeadline(state.phaseEndsAt, now);
    state.phaseEndsAt = null;
    // The square is told, because the square has to be able to resolve it: a
    // frozen clock with no explanation reads as the server having died.
    announce(state, M.paused(namesOf(state, missing(presence, waiting, now))), now);
  }
  if (tick.resumed) {
    state.phaseEndsAt = restoreDeadline(presence.parkedMs, now);
    presence.parkedMs = null;
    if (tick.abandoned.length === 0) announce(state, M.resumed(), now);
  }
  if (tick.voteClosed && tick.voteTargetId !== null) {
    const name = state.players[tick.voteTargetId]?.name ?? '?';
    announce(state, tick.kicked === null ? M.kickFailed(name) : M.kickCarried(name), now);
  }
  return tick;
}

/** A readable list of seats, for an announcement that names several people. */
function namesOf(state: MafiaState, playerIds: string[]): string {
  return playerIds.map((playerId) => state.players[playerId]?.name ?? '?').join(', ');
}

/** True while the table is stopped: no clock, no bots, no game actions. */
export function mafiaPaused(state: MafiaState): boolean {
  return isPaused(tablePresence(state));
}

/**
 * The room proposes removing a seat it has been waiting on.
 *
 * Addressed by slot, like every other target in this game, so the wire never
 * carries another player's id and the phone speaks the same vocabulary
 * throughout: you vote against house 7, not against a uuid.
 */
export function proposeMafiaKick(
  state: MafiaState,
  playerId: string,
  targetSlot: number,
  now: number
): { ok: true } | { ok: false; reason: KickRefusal } {
  const target = playerBySlot(state, targetSlot);
  if (!target) return { ok: false, reason: 'target-not-seated' };
  const opened = openKickVote(tablePresence(state), playerId, target.playerId, waitedOnSeats(state), now);
  // Announced without naming the proposer: who wanted somebody gone is exactly
  // the sort of thing a deduction game would turn into evidence about the
  // network rather than about the wolves.
  if (opened.ok) announce(state, M.kickProposed(target.name), now);
  return opened;
}

export function voteMafiaKick(
  state: MafiaState,
  playerId: string,
  yes: boolean
): { ok: true } | { ok: false; reason: KickRefusal } {
  return castKickBallot(tablePresence(state), playerId, yes, waitedOnSeats(state));
}

/**
 * A seat the room removed, or one the pause ran out on, leaves the game.
 *
 * Not a death: it is recorded as a departure, the seat stops being counted for
 * victory, and — the part that matters for a deduction game — its role goes
 * public, because a table that has to keep guessing about somebody who is not
 * there any more is not playing the game it sat down to play.
 */
export function dropMafiaSeat(state: MafiaState, playerId: string, now: number): void {
  const player = state.players[playerId];
  if (!player?.alive) return;
  kill(state, player, state.phase === 'night' ? 'night' : 'day', CAUSE.left());
  announceReveal(state, M.seatLeft(player.name, bodyReads(state, player)), now);
  for (const line of cascadeBonds(state)) announceReveal(state, line, now);
}

/** The pause, the wait and any vote, in this table's own vocabulary of slots. */
export function mafiaPresenceView(state: MafiaState, now: number, viewerId: string | null): MafiaPresenceView {
  const presence = tablePresence(state);
  const view = presenceView(presence, waitedOnSeats(state), now, viewerId);
  const slotOf = (id: string): number => state.players[id]?.slot ?? 0;
  const nameOf = (id: string): string => state.players[id]?.name ?? '?';

  return {
    paused: view.paused,
    waitingFor: view.waitingFor.map((seat) => ({
      slot: slotOf(seat.seatId),
      name: nameOf(seat.seatId),
      awayMs: seat.awayMs
    })),
    recovering: view.recovering.map((seat) => ({ slot: slotOf(seat.seatId), name: nameOf(seat.seatId) })),
    pauseExpiresAt: view.pauseExpiresAt,
    resumesAt: view.resumesAt,
    kickableSlots: view.kickableSeatIds.map(slotOf),
    vote: view.vote
      ? {
          slot: slotOf(view.vote.targetId),
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

/** What a phone is told about the pause. Slots, never ids — see `mafiaPresenceView`. */
export interface MafiaPresenceView {
  paused: boolean;
  waitingFor: { slot: number; name: string; awayMs: number }[];
  /**
   * Quiet, but still inside the resync window, so nothing has stopped.
   *
   * Rendered as a mark against one name rather than a screen over the game: most
   * silences end here without ever becoming a pause, and interrupting the whole
   * table for each of them would make the pause itself unreadable.
   */
  recovering: { slot: number; name: string }[];
  pauseExpiresAt: number | null;
  resumesAt: number | null;
  kickableSlots: number[];
  vote: {
    slot: number;
    name: string;
    closesAt: number;
    yes: number;
    no: number;
    needed: number;
    mine: boolean | null;
  } | null;
}

/* ------------------------------ transitions ----------------------------- */

function beginDay(state: MafiaState, now: number, announcements: Announcement[]): void {
  state.day += 1;
  state.phase = 'day';
  state.stage = 'discussion';
  state.trial = null;
  state.trialsToday = 0;
  state.votes = {};
  state.nightActions = {};
  state.phaseEndsAt = now + (state.day === 1 ? Math.round(state.config.dayMs * 0.6) : state.config.dayMs);

  announce(state, M.dayHeader(state.day), now);
  for (const line of announcements) {
    if (line.reveals) announceReveal(state, line.line, now);
    else announce(state, line.line, now);
  }
}

function beginNight(state: MafiaState, now: number): void {
  state.phase = 'night';
  state.stage = null;
  state.trial = null;
  state.votes = {};
  state.nightActions = {};
  state.phaseEndsAt = now + state.config.nightMs;

  announce(state, M.nightFall(state.day), now);

  const jailed = state.jailedId ? state.players[state.jailedId] : null;
  const jailor = Object.values(state.players).find((player) => player.role === 'jailor' && player.alive);
  if (jailed?.alive && jailor?.alive) {
    notify(jailed, 'On vous a traîné en cellule pour la nuit. Le Geôlier vous écoute.');
    systemPost(state.chat, jailChannel(state.day), M.jailLocked(jailed.name), now);
  } else {
    state.jailedId = null;
  }
}

/**
 * Advances whatever phase just hit its deadline. Idempotent per deadline.
 *
 * Refuses outright while the table is stopped. The manager already declines to
 * arm a timer during a pause, so this is the second lock on the same door: a
 * stale timer that fires as the pause begins must not push the town into night.
 */
export function advanceMafia(state: MafiaState, now: number, rng: () => number): void {
  if (mafiaPaused(state)) return;
  if (state.phase === 'day' && state.stage === 'discussion') {
    beginNight(state, now);
    return;
  }
  if (state.phase === 'day' && state.stage === 'defense') {
    state.stage = 'judgement';
    state.phaseEndsAt = now + state.config.judgementMs;
    const accused = state.trial ? state.players[state.trial.accusedId] : null;
    if (accused) announce(state, M.trialJudging(accused.name), now);
    return;
  }
  if (state.phase === 'day' && state.stage === 'judgement') {
    concludeTrial(state, now);
    return;
  }
  if (state.phase === 'night') {
    const announcements = resolveNight(state, rng);
    if (checkVictory(state, now)) return;
    if (state.day >= state.config.maxDays) {
      endGame(state, now, M.winDraw(), 'draw');
      return;
    }
    beginDay(state, now, announcements);
  }
}

function concludeTrial(state: MafiaState, now: number): void {
  const trial = state.trial;
  const accused = trial ? state.players[trial.accusedId] : null;
  state.trial = null;
  state.stage = 'discussion';

  if (!trial || !accused?.alive) {
    beginNight(state, now);
    return;
  }

  let guilty = 0;
  let innocent = 0;
  for (const [voterId, verdict] of Object.entries(trial.ballots)) {
    const voter = state.players[voterId];
    if (!voter?.alive) continue;
    // In the judge's exceptional court, his own gavel weighs triple.
    const weight = trial.court && voter.role === 'judge' ? 3 : voteWeight(voter);
    if (verdict === 'guilty') guilty += weight;
    else innocent += weight;
  }

  announce(state, M.trialVerdict(guilty, innocent), now);

  // The ballots go public with the verdict: the town sees who wanted the rope
  // and who wanted mercy. Saving a mafioso in public is how trust dies.
  const votersWho = (verdict: 'guilty' | 'innocent'): string[] =>
    Object.entries(trial.ballots)
      .filter(([voterId, cast]) => cast === verdict && state.players[voterId]?.alive)
      .map(([voterId]) => voterId);
  const guiltyIds = votersWho('guilty');
  const innocentIds = votersWho('innocent');
  // Recorded either way: the end-of-game replay shows every hand that was raised.
  (state.trialLog ??= []).push({
    day: state.day,
    accusedId: accused.playerId,
    lynched: guilty > innocent,
    guiltyIds,
    innocentIds
  });

  /**
   * In the judge's court the ballots stay sealed, and that is not flavour.
   *
   * The tally is *weighted* and the name lists are *headcounts*, so publishing both
   * hands out the difference — and in a court the only hidden weight on the
   * board is the judge's own triple gavel. Four guilty votes beside two names,
   * with no mayor revealed, names the judge as surely as a confession; with one
   * voter it reads "3 coupable" beside one name. The role's entire promise is
   * that nobody knows who called the court, so the court votes in secret and the
   * arithmetic has nothing to subtract from.
   *
   * An ordinary trial publishes both safely: the revealed mayor is the only
   * weight above one, and everyone can already see his sash.
   */
  if (trial.court) {
    announce(state, M.trialSecret(), now);
  } else {
    const names = (ids: string[]) => {
      const listed = ids.map((id) => state.players[id]?.name).filter(Boolean).join(', ');
      // "nobody" is a word, so it travels as a fragment rather than a literal.
      return listed || M.nobody();
    };
    announce(state, M.trialBallots(names(guiltyIds), names(innocentIds)), now);
  }

  if (guilty > innocent) {
    lynch(state, accused, trial, now);
    if (checkVictory(state, now)) return;
    beginNight(state, now);
    return;
  }

  announce(state, M.trialSpared(accused.name), now);
  const trialCap = state.config.trialsPerDay + (marshallActive(state) ? 2 : 0);
  if (state.trialsToday >= trialCap) {
    beginNight(state, now);
  } else {
    state.phaseEndsAt = now + state.config.aftermathMs;
  }
}

/** Evil in the sheriff's sense: families and solo killers. */
function evilRole(role: RoleId): boolean {
  return familyOf(role) !== null || isSoloKiller(role);
}

/**
 * What the town is told a body was, under the table's `revealOnDeath` policy.
 *
 * The announcements and the projected view have to agree exactly — a corpse whose
 * role is withheld from the roster but named in the square is withheld from
 * nobody. Reads the true `role` on purpose: a borrowed face is an examiner's
 * problem, and a role that was genuinely changed reveals what it became.
 */
function bodyReads(state: MafiaState, player: MafiaPlayer): Msg {
  const role = player.role;
  if (!role) return BODY.unknown();
  switch (state.config.revealOnDeath ?? 'role') {
    case 'none':
      return BODY.none();
    case 'faction':
      return BODY.faction(roleDef(role).faction);
    default:
      return BODY.role(role);
  }
}

function lynch(state: MafiaState, accused: MafiaPlayer, trial: { ballots: Record<string, 'guilty' | 'innocent'> }, now: number): void {
  const role = accused.role!;
  kill(state, accused, 'day', CAUSE.lynched());
  announceReveal(state, M.hanged(accused.name, bodyReads(state, accused)), now);
  if (accused.lastWill) announceReveal(state, M.lastWill(accused.name, accused.lastWill), now);

  if (evilRole(role)) {
    for (const [voterId, verdict] of Object.entries(trial.ballots)) {
      const voter = state.players[voterId];
      if (verdict === 'guilty' && voter?.alive) addPoints(state, voterId, 'lynch-evil');
    }
  }

  if (role === 'jester') {
    state.winners.push({ playerId: accused.playerId, reason: 'Bouffon pendu : il gagne seul', kind: 'jester' });
    addPoints(state, accused.playerId, 'solo-win');
    notify(accused, 'Ils vous ont pendu. Vous avez gagné.');
    announce(state, M.winJester(), now);
  }

  for (const player of Object.values(state.players)) {
    if (player.role === 'executioner' && player.alive && player.obsessionId === accused.playerId) {
      state.winners.push({ playerId: player.playerId, reason: 'Obsession pendue : le Bourreau gagne', kind: 'executioner' });
      addPoints(state, player.playerId, 'solo-win');
      notify(player, 'Votre obsession se balance. Vous avez gagné.');
    }
  }

  // A broken heart follows its owner into the grave, even from the gallows.
  for (const line of cascadeBonds(state)) {
    announceReveal(state, line, now);
  }
}

function kill(
  state: MafiaState,
  victim: MafiaPlayer,
  phase: 'day' | 'night',
  cause: Msg,
  source?: DeathSource
): void {
  victim.alive = false;
  victim.death = { day: state.day, phase, cause };
  state.deaths.push({ playerId: victim.playerId, day: state.day, phase, cause, source, role: victim.role! });

  // A dead jailor frees his prisoner; a dead prisoner empties the cell.
  const jailor = Object.values(state.players).find((player) => player.role === 'jailor');
  if (victim.playerId === state.jailedId || victim.playerId === jailor?.playerId) {
    state.jailedId = null;
  }
}

/**
 * Bound hearts stop together: lovers die of grief, the heartbreaker's charmed
 * follow him down. Loops until stable (a chain of hearts falls link by link).
 * Returns the announcement lines.
 */
function cascadeBonds(state: MafiaState): Msg[] {
  const lines: Msg[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const player of Object.values(state.players)) {
      if (!player.alive || !player.bondPartnerId) continue;
      const partner = state.players[player.bondPartnerId];
      if (partner && !partner.alive) {
        kill(state, player, state.phase === 'day' ? 'day' : 'night', CAUSE.grief());
        lines.push(M.grief(player.name, bodyReads(state, player)));
        changed = true;
      }
    }
  }
  return lines;
}

/* --------------------------- night resolution --------------------------- */

interface Attack {
  attackerId: string;
  targetId: string;
  power: number;
  /**
   * Who struck, as an identifier rather than a sentence.
   *
   * The resolver branches on this — whether a doctor can reach the victim, and
   * whether armour applies — and it used to branch on the French display string
   * instead (`label === 'le Geôlier'`). A rule keyed on prose is a rule that
   * breaks the moment somebody improves the prose, and localisation improves all
   * of it at once.
   */
  source: DeathSource;
}

/**
 * The powers that read the town rather than change it.
 *
 * Named once because two passes need to agree on the list: the movement pass
 * that puts these visitors on the street, and the results pass that tells them
 * what they saw. They disagreed before, and that was the bug.
 */
const INVESTIGATIVE: NightActionType[] = ['investigate', 'examine', 'watch', 'track', 'shadow', 'autopsy'];

function resolveNight(state: MafiaState, rng: () => number): Announcement[] {
  const acts = state.nightActions;
  const jailedId = state.jailedId;
  const announcements: Announcement[] = [];

  const actionOf = (player: MafiaPlayer): NightAction | undefined => acts[player.playerId];
  const players = Object.values(state.players);
  const living = (id: string | null | undefined): MafiaPlayer | null => {
    if (!id) return null;
    const player = state.players[id];
    return player?.alive ? player : null;
  };
  const randomOther = (excludeId: string): MafiaPlayer | null => {
    const pool = players.filter((entry) => entry.alive && entry.playerId !== excludeId);
    return pool[Math.floor(rng() * pool.length)] ?? null;
  };

  const blocked = new Set<string>();
  if (jailedId) blocked.add(jailedId);

  // Yesterday's borrowed faces wash off before tonight's are painted on.
  for (const player of players) player.disguiseRole = null;

  // Self-preparations first: they cannot be blocked (short of a jail cell).
  const alerted = new Set<string>();
  const vested = new Set<string>();
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId)) continue;
    const action = actionOf(player);
    if (action?.type === 'alert' && player.charges > 0) {
      player.charges -= 1;
      alerted.add(player.playerId);
      notify(player, 'Vous passez la nuit en alerte, fusil sur les genoux.');
    }
    if (action?.type === 'vest' && player.charges > 0) {
      player.charges -= 1;
      vested.add(player.playerId);
      notify(player, 'Gilet enfilé pour la nuit.');
    }
  }

  /** Who stepped out to whose house tonight; the lookout and veteran read this. */
  const visits: { visitorId: string; targetId: string }[] = [];
  const visit = (visitorId: string, targetId: string): void => {
    visits.push({ visitorId, targetId });
  };

  // The witch weaves before anyone leaves home: her victim's hand is guided to
  // another door. Acting first is her roleblock immunity.
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId) || player.role !== 'witch') continue;
    const action = actionOf(player);
    if (action?.type !== 'control') continue;
    const victim = living(action.targetId);
    if (!victim) continue;
    visit(player.playerId, victim.playerId);

    const victimAction = acts[victim.playerId];
    if (victimAction && victimAction.targetId && victimAction.targetId !== victim.playerId) {
      const destination = living(action.secondTargetId) ?? randomOther(victim.playerId);
      if (destination) {
        victimAction.targetId = destination.playerId;
        notify(victim, 'Une volonté étrangère a guidé vos pas cette nuit.');
        notify(player, `Vous avez envoûté ${victim.name} et détourné son geste vers ${destination.name}.`);
      }
    } else {
      notify(player, `${victim.name} n'avait aucun geste à détourner cette nuit.`);
    }
  }

  // The bus rolls next: two houses trade fates, and everything aimed at one
  // arrives at the other. The driver is on the road before the roadblocks.
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId) || player.role !== 'bus-driver') continue;
    const action = actionOf(player);
    if (action?.type !== 'swap') continue;
    const first = living(action.targetId);
    const second = living(action.secondTargetId) ?? randomOther(first?.playerId ?? player.playerId);
    if (!first || !second || first.playerId === second.playerId) continue;

    visit(player.playerId, first.playerId);
    visit(player.playerId, second.playerId);
    for (const [actorId, other] of Object.entries(acts)) {
      if (actorId === player.playerId) continue;
      // Self-aimed deeds (the match, the lever) stay home; journeys reroute.
      if (other.targetId === actorId) continue;
      if (other.targetId === first.playerId) other.targetId = second.playerId;
      else if (other.targetId === second.playerId) other.targetId = first.playerId;
    }
    notify(first, 'Un bus vous a déposé ailleurs cette nuit.');
    notify(second, 'Un bus vous a déposé ailleurs cette nuit.');
    notify(player, `Vous avez échangé ${first.name} et ${second.name}. Vous seul savez qui dormait où.`);
    player.intel.push({
      night: state.day,
      kind: 'swapped',
      targetSlot: first.slot,
      value: `${first.slot},${second.slot}`,
      slots: [first.slot, second.slot]
    });
  }

  // Kidnappings: gone for the night — unreachable, harmless, furious.
  const sheltered = new Set<string>();
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId)) continue;
    const action = actionOf(player);
    if (action?.type !== 'kidnap') continue;
    const target = living(action.targetId);
    if (!target) continue;
    visit(player.playerId, target.playerId);
    blocked.add(target.playerId);
    sheltered.add(target.playerId);
    notify(target, 'Un sac sur la tête, une cave inconnue : on vous a enlevé pour la nuit.');
    player.intel.push({ night: state.day, kind: 'blocked', targetSlot: target.slot, value: 'kidnapped' });
  }

  // Roleblocks. An alerted veteran is home armed — nobody "keeps him busy".
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId)) continue;
    const action = actionOf(player);
    if (action?.type !== 'block') continue;
    const target = living(action.targetId);
    if (!target) continue;
    visit(player.playerId, target.playerId);
    if (!alerted.has(target.playerId)) {
      blocked.add(target.playerId);
      notify(target, 'Quelqu’un vous a retenu toute la nuit. Votre action est tombée à l’eau.');
      // The blocker knows whom they kept busy — a quiet night says a lot.
      player.intel.push({ night: state.day, kind: 'blocked', targetSlot: target.slot, value: 'blocked' });
    }
  }

  // Preparations, protections and marks.
  const framed = new Set<string>();
  const healers = new Map<string, string[]>();
  const guards = new Map<string, string[]>();
  const hideHosts = new Map<string, string>();
  const cleanTargets = new Map<string, string>();
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId)) continue;
    const action = actionOf(player);
    if (!action) continue;
    const target = living(action.targetId);
    if (!target) continue;

    switch (action.type) {
      case 'frame':
        framed.add(target.playerId);
        visit(player.playerId, target.playerId);
        break;
      case 'heal':
        addProtector(healers, target.playerId, player.playerId);
        visit(player.playerId, target.playerId);
        break;
      case 'guard':
        addProtector(guards, target.playerId, player.playerId);
        visit(player.playerId, target.playerId);
        break;
      case 'silence':
        target.silencedDay = state.day + 1;
        visit(player.playerId, target.playerId);
        notify(target, 'Une lettre sous votre porte : « Un mot demain et tout le monde saura. » Vous voilà muet.');
        notify(player, `${target.name} se taira demain.`);
        break;
      case 'douse':
        if (target.playerId !== player.playerId) {
          target.doused = true;
          visit(player.playerId, target.playerId);
          notify(target, 'Une odeur d’essence imprègne vos murs…');
          notify(player, `La maison de ${target.name} est imbibée.`);
          player.intel.push({ night: state.day, kind: 'doused', targetSlot: target.slot, value: 'doused' });
        }
        break;
      case 'charge':
        if (target.playerId !== player.playerId) {
          target.charged = true;
          visit(player.playerId, target.playerId);
          notify(player, `La maison de ${target.name} est câblée.`);
          player.intel.push({ night: state.day, kind: 'doused', targetSlot: target.slot, value: 'charged' });
        }
        break;
      case 'poison':
        target.poisonedNight = state.day;
        visit(player.playerId, target.playerId);
        notify(target, 'Un goût amer au fond de la gorge. Vous vous sentez fiévreux…');
        notify(player, `${target.name} est empoisonné : il s’éteindra demain, sauf médecin.`);
        break;
      case 'imitate':
        player.disguiseRole = target.role;
        visit(player.playerId, target.playerId);
        notify(player, `Cette nuit, les curieux vous prendront pour ${roleDef(target.role!).name}.`);
        break;
      case 'hide':
        hideHosts.set(player.playerId, target.playerId);
        visit(player.playerId, target.playerId);
        notify(player, `Vous passez la nuit caché chez ${target.name}. Ce qui vous visait le trouvera.`);
        break;
      case 'charm':
        target.bondPartnerId = player.playerId;
        target.bondKind = 'charm';
        visit(player.playerId, target.playerId);
        notify(target, 'Un parfum entêtant vous colle à la peau. Votre cœur ne bat plus tout à fait pour vous.');
        notify(player, `${target.name} vous appartient : si vous tombez, ce cœur s’arrête aussi.`);
        break;
      case 'bond':
        if (player.charges > 0 && player.bondPartnerId === null) {
          player.charges -= 1;
          player.bondPartnerId = target.playerId;
          player.bondKind = 'lover';
          target.bondPartnerId = player.playerId;
          target.bondKind = 'lover';
          visit(player.playerId, target.playerId);
          notify(player, `Votre cœur a choisi ${target.name}. Vivez ensemble, ou mourez ensemble.`);
          notify(target, `Quelqu’un vous aime à la folie : ${player.name}. Vivez ensemble, ou mourez ensemble.`);
        }
        break;
      case 'clean':
        cleanTargets.set(player.playerId, target.playerId);
        visit(player.playerId, target.playerId);
        break;
      default:
        break;
    }
  }

  /**
   * The investigators step out with everybody else.
   *
   * Their *journeys* are declared here, in the movement pass, and their
   * *findings* are computed much further down once the shooting is over. Those
   * are two different things and they were previously one: recording the visits
   * next to the results meant they landed after the veteran's porch and after
   * the mass murderer's house, so a sheriff could sound out an alerted veteran
   * for free and a lookout could watch a massacre from the doorway. Both were
   * the most common visitors on the board, which made both mechanics ornamental.
   *
   * Nothing reads `visits` before this point; everything that punishes a visitor
   * reads it after. That ordering is the whole contract, and there is a test per
   * mechanic holding it down.
   */
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId)) continue;
    const action = actionOf(player);
    if (!action?.targetId || !INVESTIGATIVE.includes(action.type)) continue;
    // An autopsy is performed on a slab, not on a doorstep: nobody goes out.
    if (action.type === 'autopsy') continue;
    if (!state.players[action.targetId]) continue;
    visit(player.playerId, action.targetId);
  }

  // Attacks.
  const attacks: Attack[] = [];

  // Yesterday's poison runs its course tonight — unless a doctor purges it.
  for (const player of players) {
    if (!player.alive || player.poisonedNight === null) continue;
    if (player.poisonedNight <= state.day - 1) {
      const poisoner = players.find((entry) => entry.alive && entry.role === 'poisoner');
      attacks.push({
        attackerId: poisoner?.playerId ?? player.playerId,
        targetId: player.playerId,
        power: 2,
        source: 'poison'
      });
    }
  }

  // The match drops: everything soaked burns. Fire is power 3 — no doctor, no
  // bodyguard, no vest argues with it. Only a jail cell is stone enough.
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId) || player.role !== 'arsonist') continue;
    const action = actionOf(player);
    if (action?.type !== 'douse' || action.targetId !== player.playerId) continue;
    for (const soaked of players) {
      if (soaked.alive && soaked.doused && soaked.playerId !== player.playerId) {
        attacks.push({ attackerId: player.playerId, targetId: soaked.playerId, power: 3, source: 'arsonist' });
      }
    }
  }

  // The lever drops: every wired house takes the surge. Power 2 — curable.
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId) || player.role !== 'electromaniac') continue;
    const action = actionOf(player);
    if (action?.type !== 'charge' || action.targetId !== player.playerId) continue;
    for (const wired of players) {
      if (wired.alive && wired.charged && wired.playerId !== player.playerId) {
        attacks.push({ attackerId: player.playerId, targetId: wired.playerId, power: 2, source: 'electromaniac' });
      }
    }
  }

  // The family kills: each family's leader orders, an executor carries.
  const familyKillTargets = new Map<keyof typeof FAMILIES, string>();
  for (const familyId of Object.keys(FAMILIES) as (keyof typeof FAMILIES)[]) {
    const members = players.filter((entry) => entry.alive && playerFamily(entry) === familyId);
    if (members.length === 0) continue;
    const leader = members.find((entry) => roleDef(entry.role!).familyRank === 'leader');
    const executors = members.filter((entry) => roleDef(entry.role!).familyRank === 'executor');

    const leaderOrder = leader ? actionOf(leader) : undefined;
    const executorOrder = executors.map((entry) => actionOf(entry)).find((order) => order?.type === 'kill');
    const targetId = (leaderOrder?.type === 'kill' ? leaderOrder.targetId : null) ?? executorOrder?.targetId ?? null;
    const target = living(targetId);
    const carrier =
      executors.find((entry) => !blocked.has(entry.playerId)) ??
      (leader && !blocked.has(leader.playerId) ? leader : null);
    if (target && carrier) {
      attacks.push({ attackerId: carrier.playerId, targetId: target.playerId, power: 1, source: familyId });
      visit(carrier.playerId, target.playerId);
      familyKillTargets.set(familyId, target.playerId);
    }
  }

  // Lone guns, lone blades, and one massacre.
  const rampages: { attackerId: string; houseId: string }[] = [];
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId)) continue;
    const action = actionOf(player);
    if (!action) continue;
    const target = living(action.targetId);
    if (!target) continue;

    if (action.type === 'kill' && playerFamily(player) === null) {
      if (player.role === 'vigilante') {
        if (player.charges <= 0) continue;
        player.charges -= 1;
        attacks.push({ attackerId: player.playerId, targetId: target.playerId, power: 1, source: 'vigilante' });
        visit(player.playerId, target.playerId);
      }
      if (player.role === 'serial-killer') {
        // Power 2: the blade goes through night immunity and vests — the
        // Godfather's predator (a 1v1 of untouchables was 84% of all draws).
        attacks.push({ attackerId: player.playerId, targetId: target.playerId, power: 2, source: 'serialKiller' });
        visit(player.playerId, target.playerId);
      }
    }

    // The massacre: the house, and everyone unlucky enough to be in it. Who was
    // in it is settled below, once every journey has been declared.
    if (action.type === 'rampage' && player.role === 'mass-murderer') {
      attacks.push({ attackerId: player.playerId, targetId: target.playerId, power: 1, source: 'massMurderer' });
      visit(player.playerId, target.playerId);
      rampages.push({ attackerId: player.playerId, houseId: target.playerId });
    }
  }

  /**
   * And now the collateral, after the last visitor is on the street.
   *
   * Expanded in its own pass rather than inline, because inline it could only
   * see the journeys declared by players the loop had already reached — so
   * whether a killer or a family carrier died in someone else's massacre came
   * down to seat order, and no investigator was ever caught at all.
   */
  for (const { attackerId, houseId } of rampages) {
    const caught = new Set(
      visits.filter((entry) => entry.targetId === houseId && entry.visitorId !== attackerId).map((entry) => entry.visitorId)
    );
    for (const visitorId of caught) {
      attacks.push({ attackerId, targetId: visitorId, power: 1, source: 'massMurderer' });
    }
  }

  // The jailor's execution: inside the cell, no protection reaches it.
  const jailor = players.find((p) => p.alive && p.role === 'jailor');
  const jailed = living(jailedId);
  if (jailor && jailed && actionOf(jailor)?.type === 'jail-execute' && jailor.charges > 0) {
    jailor.charges -= 1;
    attacks.push({ attackerId: jailor.playerId, targetId: jailed.playerId, power: 3, source: 'jailor' });
  }

  // The veteran shoots everything that moves on his porch.
  for (const { visitorId, targetId } of visits) {
    if (alerted.has(targetId) && visitorId !== targetId) {
      attacks.push({ attackerId: targetId, targetId: visitorId, power: 2, source: 'veteran' });
    }
  }

  // Resolution, one attack at a time.
  const diedTonight = new Set<string>();
  for (const attack of attacks) {
    // A hidden coward hands his fate to his host.
    const hiddenAt = hideHosts.get(attack.targetId);
    const finalTargetId = hiddenAt && state.players[hiddenAt]?.alive ? hiddenAt : attack.targetId;
    const target = state.players[finalTargetId];
    const attacker = state.players[attack.attackerId];
    if (!target || !target.alive || diedTonight.has(target.playerId)) continue;

    const fromJailor = attack.source === 'jailor';
    const isPoison = attack.source === 'poison';

    // The cell protects its prisoner from the outside world, never from its keeper.
    if (target.playerId === jailedId && !fromJailor && !isPoison) {
      if (attacker) notify(attacker, 'Votre cible était introuvable cette nuit.');
      continue;
    }
    // A kidnapped player is somewhere nobody knows.
    if (sheltered.has(target.playerId) && !isPoison) {
      if (attacker) notify(attacker, 'Votre cible était introuvable cette nuit.');
      continue;
    }

    let defense = 0;
    if (target.role && roleDef(target.role).nightImmune) defense = Math.max(defense, 1);
    if (vested.has(target.playerId)) defense = Math.max(defense, 1);
    if (alerted.has(target.playerId)) defense = Math.max(defense, 2);
    if (isPoison) defense = 0; // the poison is already inside; armour is irrelevant

    if (attack.power <= defense) {
      notify(target, 'On vous a attaqué cette nuit, mais vous avez tenu bon.');
      if (attacker) notify(attacker, 'Votre cible a survécu à votre attaque.');
      continue;
    }

    // A bodyguard steps in front of anything short of an execution or a fire.
    const guardList = (guards.get(target.playerId) ?? []).map((id) => state.players[id]).filter((g) => g?.alive);
    if (!fromJailor && !isPoison && attack.power <= 2 && guardList.length > 0) {
      const guard = guardList[0];
      if (guard) {
        diedTonight.add(guard.playerId);
        kill(state, guard, 'night', CAUSE.guard(target.name));
        addPoints(state, guard.playerId, 'save');
        notify(target, 'Quelqu’un est mort pour vous cette nuit.');
        if (attacker && attacker.playerId !== guard.playerId) {
          const counterDefense = attacker.role && roleDef(attacker.role).nightImmune ? 1 : 0;
          if (2 > counterDefense && !diedTonight.has(attacker.playerId)) {
            diedTonight.add(attacker.playerId);
            kill(state, attacker, 'night', CAUSE.bodyguard());
          } else {
            notify(attacker, 'Un garde du corps vous a repoussé.');
          }
        }
        continue;
      }
    }

    // The doctor saves anything short of an execution or a fire — and purges poison.
    const healerList = (healers.get(target.playerId) ?? []).map((id) => state.players[id]).filter((h) => h?.alive);
    if (!fromJailor && attack.power <= 2 && healerList.length > 0) {
      if (isPoison) {
        target.poisonedNight = null;
        notify(target, 'La fièvre tombe : on vous a purgé le sang à temps.');
      } else {
        notify(target, 'On vous a laissé pour mort, mais des mains expertes vous ont recousu.');
      }
      for (const healer of healerList) {
        if (healer) {
          notify(healer, 'Votre patient a été attaqué cette nuit. Vous l’avez sauvé.');
          healer.intel.push({ night: state.day, kind: 'saved', targetSlot: target.slot, value: 'saved' });
          addPoints(state, healer.playerId, 'save');
        }
      }
      continue;
    }

    diedTonight.add(target.playerId);
    kill(state, target, 'night', CAUSE.killedBy(attack.source), attack.source);
    if (isPoison) target.poisonedNight = null;
    if (attacker && attacker.playerId !== target.playerId) {
      addPoints(state, attacker.playerId, 'kill');
      if (fromJailor) {
        if (target.role && evilRole(target.role)) {
          addPoints(state, attacker.playerId, 'execute-evil');
        } else {
          attacker.charges = 0;
          notify(attacker, 'Vous avez exécuté un innocent. Vos mains tremblent : plus aucune exécution.');
        }
      }
    }
  }

  // Spent or cured poison clears; a fresh dose keeps ticking toward tomorrow.
  for (const player of players) {
    if (player.poisonedNight !== null && player.poisonedNight <= state.day - 1) {
      player.poisonedNight = null;
    }
  }

  // Bound hearts stop together.
  for (const line of cascadeBonds(state)) {
    announcements.push({ line, reveals: true });
  }

  // The cleaners pass before dawn: a nameless body, one more family secret.
  for (const [cleanerId, targetId] of cleanTargets) {
    const cleaner = state.players[cleanerId];
    const target = state.players[targetId];
    if (!cleaner?.alive || cleaner.charges <= 0 || !target || target.alive) continue;
    const record = state.deaths.find((death) => death.playerId === targetId && death.day === state.day);
    if (!record) continue;
    record.hidden = true;
    cleaner.charges -= 1;
    cleaner.intel.push({ night: state.day, kind: 'role', targetSlot: target.slot, value: target.role! });
    notify(cleaner, `Le cadavre de ${target.name} est méconnaissable. C'était ${roleDef(target.role!).name}.`);
  }

  // Dawn report.
  for (const player of players) {
    if (diedTonight.has(player.playerId)) {
      const record = state.deaths.find((death) => death.playerId === player.playerId);
      const roleLine = record?.hidden ? BODY.cleaned() : bodyReads(state, player);
      announcements.push({
        line: M.found(player.name, record?.cause ?? CAUSE.unknown(), roleLine),
        reveals: true
      });
      if (player.lastWill && !record?.hidden) {
        // A will is a claim about roles; on a shared screen it is a reveal too.
        announcements.push({ line: M.lastWill(player.name, player.lastWill), reveals: true });
      }
    }
  }
  if (announcements.length === 0) {
    announcements.push({ line: M.nightQuiet() });
  }

  // A widowed executioner grieves into motley.
  for (const player of players) {
    if (player.role === 'executioner' && player.alive && player.obsessionId && !state.players[player.obsessionId]?.alive) {
      player.role = 'jester';
      player.obsessionId = null;
      notify(player, 'Votre obsession est morte sans corde. Le deuil vous rend fou : vous êtes désormais le Bouffon.');
    }
  }

  // The spy's ear: which doors the families chose tonight.
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId) || player.role !== 'spy') continue;
    for (const [familyId, targetId] of familyKillTargets) {
      const target = state.players[targetId];
      if (!target) continue;
      // The family's own name, from the one place it is spelled: a two-way
      // ternary here would report the Cult as the Triad the day it can kill.
      notify(player, `${capitalise(FAMILIES[familyId].label)} a visé la maison ${target.slot} cette nuit.`);
      player.intel.push({ night: state.day, kind: 'spied', targetSlot: target.slot, value: familyId });
    }
  }

  /**
   * Now the findings — the town as it stood tonight, deaths included.
   *
   * The journeys themselves were declared far above, in the movement pass, so by
   * the time anything here reads `visits` it is complete: a lookout sees the
   * other investigators who called at the house, which is the point. What this
   * pass adds is the `diedTonight` filter — an investigator shot on somebody's
   * porch went out, and everyone watching saw him go, but he does not live to
   * report what he found.
   */
  const investigators = players.filter((player) => {
    if (!player.alive || blocked.has(player.playerId) || diedTonight.has(player.playerId)) return false;
    const action = actionOf(player);
    if (!action?.targetId || !state.players[action.targetId]) return false;
    return INVESTIGATIVE.includes(action.type);
  });
  for (const player of investigators) {
    const action = actionOf(player)!;
    const target = state.players[action.targetId!];
    if (!target) continue;
    // A borrowed face fools every examiner.
    const shownRole = target.disguiseRole ?? target.role!;
    const shown = roleDef(shownRole);

    if (action.type === 'investigate') {
      const suspect =
        framed.has(target.playerId) ||
        !!shown.suspicious ||
        (familyOf(shownRole) !== null && !shown.detectionImmune);
      notify(player, `${target.name} ${suspect ? 'est SUSPECT' : 'n’a rien de suspect'}.`);
      player.intel.push({ night: state.day, kind: 'sheriff', targetSlot: target.slot, value: suspect ? 'suspect' : 'clear' });
    }
    if (action.type === 'examine') {
      if (player.role === 'consigliere' || player.role === 'administrator') {
        notify(player, `${target.name} est ${shown.name}.`);
        player.intel.push({ night: state.day, kind: 'role', targetSlot: target.slot, value: shownRole });
      } else {
        const line = framed.has(target.playerId) ? roleDef('framer').investigated : shown.investigated;
        notify(player, `${target.name} ${line}.`);
        player.intel.push({ night: state.day, kind: 'trade', targetSlot: target.slot, value: line });
      }
    }
    if (action.type === 'watch' || action.type === 'shadow') {
      const seenPlayers = [
        ...new Set(
          visits
            .filter((entry) => entry.targetId === target.playerId && entry.visitorId !== player.playerId)
            .map((entry) => state.players[entry.visitorId])
            .filter((visitor): visitor is MafiaPlayer => !!visitor)
        )
      ];
      notify(
        player,
        seenPlayers.length > 0
          ? `Chez ${target.name} cette nuit : ${seenPlayers.map((v) => v.name).join(', ')}.`
          : `Personne n’a rendu visite à ${target.name} cette nuit.`
      );
      player.intel.push({
        night: state.day,
        kind: 'visitors',
        targetSlot: target.slot,
        value: seenPlayers.map((v) => String(v.slot)).join(','),
        slots: seenPlayers.map((v) => v.slot)
      });
    }
    if (action.type === 'track' || action.type === 'shadow') {
      const wentTo = [
        ...new Set(
          visits
            .filter((entry) => entry.visitorId === target.playerId)
            .map((entry) => state.players[entry.targetId])
            .filter((house): house is MafiaPlayer => !!house)
        )
      ];
      notify(
        player,
        wentTo.length > 0
          ? `${target.name} est sorti cette nuit : vu chez ${wentTo.map((v) => v.name).join(', ')}.`
          : `${target.name} n’a pas quitté sa maison cette nuit.`
      );
      player.intel.push({
        night: state.day,
        kind: 'tracked',
        targetSlot: target.slot,
        value: wentTo.map((v) => String(v.slot)).join(','),
        slots: wentTo.map((v) => v.slot)
      });
    }
    if (action.type === 'autopsy' && !target.alive) {
      notify(player, `Sous votre scalpel, ${target.name} livre son secret : c'était ${roleDef(target.role!).name}.`);
      player.intel.push({ night: state.day, kind: 'role', targetSlot: target.slot, value: target.role! });
    }
  }

  // Conversions, initiations and paperwork — after the blood has dried.
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId)) continue;
    const action = actionOf(player);
    if (!action?.targetId) continue;
    const target = state.players[action.targetId];
    if (!target) continue;

    if (action.type === 'recruit' && player.role === 'mason-leader' && target.alive) {
      visit(player.playerId, target.playerId);
      if (target.role === 'citizen') {
        target.role = 'mason';
        notify(target, 'On vous a initié à la loge. Vos frères vous connaissent désormais.');
        notify(player, `${target.name} a rejoint la loge.`);
      } else {
        notify(player, `${target.name} a décliné l’initiation.`);
      }
    }

    if (action.type === 'convert' && player.role === 'cultist' && target.alive) {
      visit(player.playerId, target.playerId);
      if (target.role && roleDef(target.role).faction === 'town') {
        const converted: RoleId = target.role === 'doctor' ? 'witch-doctor' : 'cultist';
        target.role = converted;
        target.charges = roleDef(converted).charges ?? 0;
        player.cooldownUntilDay = state.day + 2;
        notify(target, 'Des voix dans la nuit… et soudain tout est clair. Vous appartenez à la Secte.');
        notify(player, `${target.name} a rejoint la Secte.`);
        announcements.push({ line: M.cultChant(), reveals: true });
      } else {
        notify(player, `${target.name} a résisté à l’appel.`);
      }
    }

    if (action.type === 'remember' && player.role === 'amnesiac' && !target.alive && target.role) {
      const remembered = target.role;
      player.role = remembered;
      player.charges = roleDef(remembered).charges ?? 0;
      notify(player, `Tout vous revient : vous êtes ${roleDef(remembered).name}.`);
      announcements.push({
        line: M.amnesiacRemembered(roleDef(remembered).name, target.name),
        reveals: true
      });
    }

    if (action.type === 'audit' && player.role === 'auditor' && target.alive && player.charges > 0) {
      visit(player.playerId, target.playerId);
      const targetDef = roleDef(target.role!);
      let audited: RoleId | null = null;
      if (targetDef.faction === 'town') audited = 'citizen';
      else if (targetDef.faction === 'mafia' && targetDef.familyRank !== 'leader') audited = 'mafioso';
      else if (targetDef.faction === 'triad' && targetDef.familyRank !== 'leader') audited = 'enforcer';
      else if (targetDef.faction === 'neutral' && !targetDef.soloKiller && target.role !== 'auditor') audited = 'scumbag';
      if (audited && audited !== target.role) {
        player.charges -= 1;
        target.role = audited;
        target.charges = roleDef(audited).charges ?? 0;
        notify(target, `Un contrôle implacable : vos papiers, vos outils, votre vie d'avant — saisis. Vous êtes ${roleDef(audited).name}.`);
        notify(player, `${target.name} a été réduit à néant administratif.`);
      } else {
        notify(player, `${target.name} est inattaquable sur le papier.`);
      }
    }
  }

  state.jailedId = null;
  state.nightActions = {};
  return announcements;
}

/* ------------------------------- endings -------------------------------- */

const FAMILY_WIN: Record<FamilyId, { reason: string; headline: Msg }> = {
  mafia: { reason: 'Victoire de la Mafia', headline: M.winFamily('mafia') },
  triad: { reason: 'Victoire de la Triade', headline: M.winFamily('triad') },
  cult: { reason: 'Victoire de la Secte', headline: M.winFamily('cult') }
};

const SOLO_WIN: Partial<Record<RoleId, { reason: string; headline: Msg }>> = {
  'serial-killer': {
    reason: 'Dernier tueur debout',
    headline: M.winSolo('serial-killer')
  },
  arsonist: { reason: 'Dernière flamme debout', headline: M.winSolo('arsonist') },
  'mass-murderer': { reason: 'Dernier massacre debout', headline: M.winSolo('mass-murderer') },
  poisoner: {
    reason: 'Dernière fiole debout',
    headline: M.winSolo('poisoner')
  },
  electromaniac: { reason: 'Dernier courant debout', headline: M.winSolo('electromaniac') }
};

/**
 * How the evening ended.
 *
 * The parasites win exactly when the town does not, and that condition used to
 * be `reason === 'Victoire de la Ville'` — a magic string matched against a
 * second copy of itself two hundred lines away, in a file whose own comments
 * warn twice about rules keyed on sentences.
 *
 * It is a parameter rather than a `winners.some(kind === 'town')` lookup, even
 * though `WinKind` would now answer it, because the lookup would only be true
 * once the town's entries had been pushed: a caller that crowned after ending
 * would silently pay out the parasites. Stated by the caller, it cannot.
 */
type Ending = 'town' | 'family' | 'solo-killer' | 'draw';

function endGame(state: MafiaState, now: number, headline: Msg, ending: Ending): void {
  state.phase = 'ended';
  state.stage = null;
  state.trial = null;
  state.phaseEndsAt = null;

  const townWon = ending === 'town';
  const lovers = new Set<string>();
  for (const player of Object.values(state.players)) {
    if (player.alive) addPoints(state, player.playerId, 'survive');
    if (player.alive && player.role === 'survivor') {
      state.winners.push({ playerId: player.playerId, reason: 'A survécu jusqu’au bout', kind: 'survivor' });
      addPoints(state, player.playerId, 'solo-win');
    }
    // Misfortune's parasites: alive while the town failed is a win.
    if (
      player.alive &&
      (player.role === 'witch' || player.role === 'scumbag' || player.role === 'judge' || player.role === 'auditor') &&
      !townWon
    ) {
      state.winners.push({ playerId: player.playerId, reason: 'A prospéré dans le malheur', kind: 'parasite' });
      addPoints(state, player.playerId, 'solo-win');
    }
    // Lovers win together, whoever else won.
    if (
      player.alive &&
      player.bondKind === 'lover' &&
      player.bondPartnerId &&
      state.players[player.bondPartnerId]?.alive &&
      !lovers.has(player.playerId)
    ) {
      lovers.add(player.playerId);
      lovers.add(player.bondPartnerId);
      state.winners.push({ playerId: player.playerId, reason: 'L’amour a survécu à la ville', kind: 'lovers' });
      state.winners.push({ playerId: player.bondPartnerId, reason: 'L’amour a survécu à la ville', kind: 'lovers' });
      addPoints(state, player.playerId, 'solo-win');
      addPoints(state, player.bondPartnerId, 'solo-win');
    }
    if (!player.isBot) addPoints(state, player.playerId, 'participation');
  }

  announce(state, headline, now);
  const roster = Object.values(state.players)
    .sort((a, b) => a.slot - b.slot)
    .map((player) => `${player.slot}. ${player.name} — ${roleDef(player.role!).name}`)
    .join(' · ');
  announceReveal(state, M.unmasked(roster), now);
}

/** True when the game just ended; the caller stops scheduling. */
export function checkVictory(state: MafiaState, now: number): boolean {
  if (state.phase === 'ended') return true;
  const alive = alivePlayers(state);
  const families: FamilyId[] = ['mafia', 'triad', 'cult'];
  const byFamily = new Map<FamilyId, MafiaPlayer[]>(
    families.map((familyId) => [familyId, alive.filter((player) => playerFamily(player) === familyId)])
  );
  const soloKillers = alive.filter((player) => player.role !== null && isSoloKiller(player.role));

  const crownFamily = (familyId: FamilyId): void => {
    const win = FAMILY_WIN[familyId];
    for (const player of Object.values(state.players)) {
      if (player.role && familyOf(player.role) === familyId) {
        state.winners.push({ playerId: player.playerId, reason: win.reason, kind: familyId });
        addPoints(state, player.playerId, 'win');
      }
    }
    endGame(state, now, win.headline, 'family');
  };

  const familiesAlive = families.filter((familyId) => (byFamily.get(familyId)?.length ?? 0) > 0);

  // The town wins when every family and every lone killer is in the ground.
  if (familiesAlive.length === 0 && soloKillers.length === 0) {
    for (const player of Object.values(state.players)) {
      if (player.role && roleDef(player.role).faction === 'town') {
        state.winners.push({ playerId: player.playerId, reason: 'Victoire de la Ville', kind: 'town' });
        addPoints(state, player.playerId, 'win');
      }
    }
    endGame(state, now, M.winTown(), 'town');
    return true;
  }

  // A lone killer wins once nothing that could stop him still breathes.
  if (familiesAlive.length === 0 && soloKillers.length > 0) {
    const kinds = new Set(soloKillers.map((player) => player.role));
    const threats = alive.filter((player) => !soloKillers.includes(player) && !BYSTANDER_ROLES.has(player.role!));
    if (kinds.size === 1 && threats.length === 0) {
      const win = SOLO_WIN[soloKillers[0].role!] ?? SOLO_WIN['serial-killer']!;
      for (const player of soloKillers) {
        state.winners.push({ playerId: player.playerId, reason: win.reason, kind: 'solo-killer' });
        addPoints(state, player.playerId, 'solo-win');
      }
      endGame(state, now, win.headline, 'solo-killer');
      return true;
    }
    return false;
  }

  // A family wins at parity, once its rivals and the lone killers are gone.
  if (familiesAlive.length === 1 && soloKillers.length === 0) {
    const familyId = familiesAlive[0];
    const members = byFamily.get(familyId)!;
    const rest = alive.filter((player) => playerFamily(player) !== familyId);
    if (members.length >= rest.length) {
      crownFamily(familyId);
      return true;
    }
  }
  return false;
}
