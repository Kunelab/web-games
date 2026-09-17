import { post, systemPost, visibleTo, type ChatMessage, type PostRefusal } from 'chat-core';
import type { Msg } from 'i18n';
import {
  castKickBallot,
  isPaused,
  markAway,
  markPresent,
  missing,
  noteBeat,
  openKickVote,
  parkDeadline,
  resetPresence,
  presenceView,
  restoreDeadline,
  tickPresence,
  type KickRefusal,
  type PresenceTick
} from 'presence-core';

import { BODY, CAUSE, M, MafiaError, NO, NOTE, type DeathSource } from './messages.js';

import {
  BYSTANDER_ROLES,
  FAMILIES,
  familyOf,
  isSoloKiller,
  QUIET_TRADE,
  roleDef,
  type Faction,
  type FamilyId,
  type NightActionType,
  type RoleId
} from './roles.js';
import {
  ANONYMOUS,
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
  SKIP_VOTE,
  type SheriffVerdict,
  tablePresence,
  voteWeight,
  waitedOnSeats,
  WILL_MAX_CHARS,
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

/**
 * What an action answers.
 *
 * The refusal is a **key**, not a sentence. It used to be a French string
 * literal written at the point of refusal and put on screen verbatim, which meant
 * an English reader pressing a button they were not allowed to press got told
 * « Pas maintenant » — the one part of this game that had never been localised
 * because it never travelled through the catalogue at all. See `NO` in
 * messages.ts for the whole list.
 */
export interface ActionOutcome {
  ok: boolean;
  error?: Msg;
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
const PAUSED_REFUSAL: ActionOutcome = { ok: false, error: NO.paused() };

const POINTS: Record<PointEntry['reason'], number> = {
  win: 5,
  'solo-win': 5,
  survive: 2,
  kill: 1,
  save: 2,
  'lynch-evil': 1,
  'execute-evil': 2,
  // Paid on top of `solo-win`, and only where winning meant dying. See `PointEntry`.
  martyr: 3,
  participation: 1
};

function addPoints(state: MafiaState, playerId: string, reason: PointEntry['reason']): void {
  state.points.push({ playerId, reason, amount: POINTS[reason] });
}

/** Files one protector against the house they are standing in front of tonight. */
function addProtector(byHouse: Map<string, string[]>, houseId: string, protectorId: string): void {
  byHouse.set(houseId, [...(byHouse.get(houseId) ?? []), protectorId]);
}

/**
 * Records that somebody came for this seat and it is still here.
 *
 * The notification beside every call to this already tells a *person* what
 * happened. This is the same fact in a form the rest of the game can reason
 * from: what a seat may claim in the square tomorrow, and what the policy brain
 * weighs when it decides whether saying so is worth the target it paints.
 *
 * The latest rescue wins. A seat saved on two different nights says so about
 * the second one, which is the one still worth acting on.
 */
function rescued(player: MafiaPlayer, night: number, by: 'doctor' | 'bodyguard' | 'self'): void {
  player.rescuedNight = night;
  player.rescuedBy = by;
}

/** Records that somebody got in this seat's way tonight; see `disturbedNight`. */
function disturbed(player: MafiaPlayer, night: number, by: 'block' | 'control' | 'swap' | 'jail'): void {
  player.disturbedNight = night;
  player.disturbedBy = by;
}

function notify(player: MafiaPlayer, text: Msg): void {
  player.notifications.push(text);
  // The feed is private and unbounded otherwise; a phone needs the recent past only.
  if (player.notifications.length > 60) {
    const dropped = player.notifications.length - 60;
    player.notifications.splice(0, dropped);
    // The echo watermark points into this array; keep it pointing at the same line.
    player.notifiedUpTo = Math.max(0, (player.notifiedUpTo ?? 0) - dropped);
  }
}

/**
 * Echoes every note a seat has not yet seen in its chat into its own channel.
 *
 * The private feed has always been the role card's journal, which is the wrong
 * place for the one line a night that matters: a sheriff who checked somebody
 * had to leave the square, open the card and read the result off a side panel,
 * while the square went on without them. The result now also lands in the chat,
 * on a channel only that seat can read, so it sits in the conversation at the
 * moment it happened. The journal stays; this is the same line twice, once
 * where it is filed and once where it is read.
 *
 * Called from the places that own a clock rather than from `notify`, which is
 * called fifty times from code that has no `now` to give a message. A note is
 * therefore echoed at the next phase edge, which for night results is dawn,
 * which is when a person would read it anyway.
 */
function echoNotes(state: MafiaState, now: number): void {
  for (const player of Object.values(state.players)) {
    /**
     * People only. A bot reads its results off the structured record and never
     * opens a chat panel, so echoing for it only grows the log: at twenty-four
     * seats the per-seat channels would outrun the log's backstop and start
     * evicting the square's own history, which is the one channel people read.
     */
    if (player.isBot) continue;
    const from = player.notifiedUpTo ?? 0;
    for (const line of player.notifications.slice(from)) {
      systemPost(state.chat, `self:${player.playerId}`, line, now);
    }
    player.notifiedUpTo = player.notifications.length;
  }
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
        throw new MafiaError(NO.tableMovedOn(), 'La table a continué sans vous');
      }
      seated.connected = true;
      // Reclaiming a seat proves somebody is at it; the beat contract starts
      // with the phone's first beat, a moment later.
      markPresent(tablePresence(state), seated.playerId);
      return { player: seated, rejoined: true };
    }
  }

  if (state.phase !== 'lobby') throw new MafiaError(NO.alreadyStarted(), 'La partie a déjà commencé');

  const trimmed = name.trim().slice(0, 20);
  if (!trimmed) throw new MafiaError(NO.nameRequired(), 'Il faut un nom');
  if (Object.values(state.players).some((player) => player.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new MafiaError(NO.nameTaken(), 'Ce nom est déjà pris');
  }

  const slot = nextFreeSlot(state);
  if (slot === null) throw new MafiaError(NO.tableFull(), 'La table est pleine');

  const player = seatPlayer({ playerId, token, name: trimmed, slot, isBot: false, account });
  state.players[playerId] = player;
  return { player, rejoined: false };
}

/** `randomInt` draws the name; see `nextBotName`. */
export function addMafiaBot(
  state: MafiaState,
  token: string,
  playerId: string,
  randomInt: (maxExclusive: number) => number
): MafiaPlayer {
  if (state.phase !== 'lobby') throw new MafiaError(NO.alreadyStarted(), 'La partie a déjà commencé');
  const slot = nextFreeSlot(state);
  if (slot === null) throw new MafiaError(NO.tableFull(), 'La table est pleine');

  const player = seatPlayer({ playerId, token, name: nextBotName(state, randomInt), slot, isBot: true });
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
  if (state.phase !== 'lobby') throw new MafiaError(NO.alreadyRunning(), 'Déjà en cours');
  if (Object.keys(state.players).length < state.config.minPlayers) {
    throw new MafiaError(
      NO.needPlayers(state.config.minPlayers),
      `Il faut au moins ${state.config.minPlayers} joueurs`
    );
  }

  assignRoles(state, rng);

  for (const player of Object.values(state.players)) {
    notify(player, NOTE.roleDealt(player.role!));
    if (player.obsessionId) {
      const mark = state.players[player.obsessionId];
      if (mark) notify(player, NOTE.obsession(mark.name, mark.slot));
    }
  }

  startPresenceFresh(state, now);
  beginDay(state, now, [{ line: M.gameStart() }]);

  echoNotes(state, now);
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
): { ok: true; message: ChatMessage } | { ok: false; error: Msg } {
  const player = state.players[playerId];
  if (!player) return { ok: false, error: NO.notAtTable() };

  const rules = chatRules();
  if (!rules.canWrite(channel, playerId, state)) {
    return { ok: false, error: NO.cannotSpeakHere() };
  }

  /**
   * A voice in the square at night is the crier's, and the crier is anonymous.
   *
   * `canWrite` already lets only the crier speak there after dark; what it did
   * not do was hide who was speaking. The line went into the log with the
   * crier's own name and id, every phone printed it, and a role whose entire
   * value is that nobody knows which house it lives in had told the table on
   * its first night. Stripped at the source, so no projection and no live push
   * can forget to.
   */
  const result = post(state.chat, { channel, authorId: playerId, authorName: player.name, text, at: now });
  if (!result.ok) return { ok: false, error: CHAT_NO[result.reason]() };

  if (channel === 'day' && state.phase === 'night') {
    /**
     * Stripped after posting rather than posted anonymous, because the log's
     * flood control keys on the author: a crier has to be rate-limited as the
     * crier, not pooled with every announcement the game itself makes. `post`
     * hands back the very object it stored, so the identity comes off the log
     * entry itself, not off a copy.
     */
    result.message.authorId = null;
    result.message.authorName = ANONYMOUS;
  }
  return result;
}

/** The log's own refusals, in the reader's language rather than the log's. */
const CHAT_NO: Record<PostRefusal, () => Msg> = {
  empty: NO.emptyMessage,
  tooLong: NO.messageTooLong,
  flood: NO.slowDown
};

/**
 * One chat line as this reader is allowed to see it.
 *
 * The spy hears the families and never sees their faces, so the byline comes off
 * at delivery rather than in the view projection. The same line reaches a phone
 * twice: inside a broadcast view, and as an incremental `mafia:message` push in
 * between. Muffling only the projection left the push carrying the real name,
 * so the spy read the author for as long as it took the next transition to
 * rewrite the log under him. This is the one place both paths share.
 *
 * `ANONYMOUS` and not a key: `authorName` is the byline a player's own nickname
 * travels in, and the log has no notion of a translatable author. A symbol says
 * "somebody, and you do not get to know who" in every language.
 */
export function chatLineFor(state: MafiaState, playerId: string, message: ChatMessage): ChatMessage {
  // At the whistle the masks come off, transcript included.
  if (state.phase === 'ended') return message;
  const reader = state.players[playerId];
  if (reader?.role !== 'spy' || !message.authorId) return message;
  if (message.channel !== 'mafia' && message.channel !== 'triad') return message;
  return { ...message, authorId: null, authorName: ANONYMOUS };
}

export function chatVisibleTo(state: MafiaState, playerId: string): ChatMessage[] {
  return visibleTo(state.chat, playerId, state, chatRules()).map((message) => chatLineFor(state, playerId, message));
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
): { ok: true; message: ChatMessage; gossip: ChatMessage } | { ok: false; error: Msg } {
  const from = state.players[fromId];
  const target = playerBySlot(state, targetSlot);
  if (!from || !target) return { ok: false, error: NO.noRecipient() };
  if (target.playerId === fromId) return { ok: false, error: NO.whisperSelf() };

  const channel = pmChannel(fromId, target.playerId);
  const rules = chatRules();
  if (!rules.canWrite(channel, fromId, state)) {
    return { ok: false, error: NO.whisperNotNow() };
  }

  const result = post(state.chat, { channel, authorId: fromId, authorName: from.name, text, at: now });
  if (!result.ok) return { ok: false, error: CHAT_NO[result.reason]() };

  // Both messages are handed back rather than left for the caller to fish out of
  // the tail of the log: the square's notice is a second delivery to a second
  // audience, and which position it lands in is the chat's business, not ours.
  return { ok: true, message: result.message, gossip: announce(state, M.whisperSeen(from.name, target.name), now) };
}

export function setLastWill(state: MafiaState, playerId: string, text: string): ActionOutcome {
  const player = state.players[playerId];
  if (!player || !player.alive) return { ok: false, error: NO.tooLate() };
  player.lastWill = text.slice(0, WILL_MAX_CHARS);
  return { ok: true };
}

/* ----------------------------- day actions ------------------------------ */

export function revealMayor(state: MafiaState, playerId: string, now: number): ActionOutcome {
  if (mafiaPaused(state)) return PAUSED_REFUSAL;
  const player = state.players[playerId];
  if (!player?.alive || (player.role !== 'mayor' && player.role !== 'marshall')) {
    return { ok: false, error: NO.impossible() };
  }
  if (state.phase !== 'day') return { ok: false, error: NO.waitForDay() };
  if (player.revealed) return { ok: false, error: NO.alreadyRevealed() };

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
  if (!judge?.alive || judge.role !== 'judge') return { ok: false, error: NO.impossible() };
  if (judge.charges <= 0) return { ok: false, error: NO.courtSpent() };
  if (state.phase !== 'day' || state.stage !== 'discussion' || state.day <= 1) {
    return { ok: false, error: NO.notNow() };
  }

  /**
   * The court needs a defendant, and the room has to have named one.
   *
   * Three things were wrong with counting them. Heads rather than weight, so a
   * revealed Mayor's triple vote counted once here and three times everywhere
   * else in the same afternoon. Every ballot in the map, including those of
   * seats who have since died, when the ordinary threshold counts the living
   * only. And a tie broken by whichever id happened to be inserted first: a
   * room split seven against seven sent one of the two to judgement with no
   * defence and no reason, which is how it was reported.
   *
   * A split room is not an accusation. The charge is not spent, the day carries
   * on, and the judge can call the court once the square has made up its mind.
   */
  const counts = new Map<string, number>();
  for (const voter of alivePlayers(state)) {
    const targetId = state.votes[voter.playerId];
    if (!targetId || targetId === SKIP_VOTE || !state.players[targetId]?.alive) continue;
    counts.set(targetId, (counts.get(targetId) ?? 0) + voteWeight(voter));
  }

  let accusedId: string | null = null;
  let best = 0;
  let tied = false;
  for (const [targetId, count] of counts) {
    if (count > best) {
      accusedId = targetId;
      best = count;
      tied = false;
    } else if (count === best) {
      tied = true;
    }
  }
  if (!accusedId) return { ok: false, error: NO.nobodyAccused() };
  if (tied) return { ok: false, error: NO.courtSplit() };

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
  if (!player?.alive || player.role !== 'jailor') return { ok: false, error: NO.impossible() };
  if (state.phase !== 'day') return { ok: false, error: NO.dayOnly() };

  if (targetSlot === null) {
    state.jailedId = null;
    return { ok: true };
  }
  const target = playerBySlot(state, targetSlot);
  if (!target?.alive || target.playerId === playerId) return { ok: false, error: NO.badTarget() };
  state.jailedId = target.playerId;
  return { ok: true };
}

/** The weighted majority of the living: what it takes to move the day. */
export function voteThreshold(state: MafiaState): number {
  return Math.floor(alivePlayers(state).reduce((sum, player) => sum + voteWeight(player), 0) / 2) + 1;
}

/** Weighted votes currently sitting on one target id (a player, or `SKIP_VOTE`). */
function votesOn(state: MafiaState, targetId: string): number {
  return alivePlayers(state)
    .filter((player) => state.votes[player.playerId] === targetId)
    .reduce((sum, player) => sum + voteWeight(player), 0);
}

/**
 * An accusation, a withdrawal, or a vote to hang nobody at all.
 *
 * `'skip'` is a target like any other and deliberately so: it goes in the same
 * record, clears the same way, and passes at the same weighted majority. Before
 * it existed, a town that had already said everything it had to say could do
 * nothing but stand in the square and watch two minutes run out — the day had
 * exactly one exit and it was the clock.
 */
export function castVote(
  state: MafiaState,
  voterId: string,
  targetSlot: number | 'skip' | null,
  now: number
): ActionOutcome {
  if (mafiaPaused(state)) return PAUSED_REFUSAL;
  const voter = state.players[voterId];
  if (!voter?.alive) return { ok: false, error: NO.deadNoVote() };
  if (state.phase !== 'day' || state.stage !== 'discussion') return { ok: false, error: NO.notNow() };
  if (state.day <= 1) return { ok: false, error: NO.firstDay() };
  /**
   * Withdrawing is always allowed; committing waits for the floor.
   *
   * A seat that has changed its mind must be able to take its name off a wagon
   * at any moment — the lock is on ending the day early, not on thinking again.
   */
  if (targetSlot !== null && state.voteOpensAt != null && now < state.voteOpensAt) {
    return { ok: false, error: NO.stillTalking() };
  }

  if (targetSlot === null) {
    delete state.votes[voterId];
    noteVote(state, voter.slot, null, false);
    return { ok: true };
  }

  if (targetSlot === 'skip') {
    state.votes[voterId] = SKIP_VOTE;
    noteVote(state, voter.slot, null, true);
    if (votesOn(state, SKIP_VOTE) >= voteThreshold(state)) {
      announce(state, M.voteSkipped(), now);
      beginNight(state, now);
    }
    return { ok: true };
  }

  const target = playerBySlot(state, targetSlot);
  if (!target?.alive) return { ok: false, error: NO.badTarget() };
  if (target.playerId === voterId) return { ok: false, error: NO.notYourself() };

  state.votes[voterId] = target.playerId;
  noteVote(state, voter.slot, target.slot, false);

  const needed = voteThreshold(state);
  const against = votesOn(state, target.playerId);

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
      // A gagged mouth gets its one sentence said for it; see `trialMuted`.
      if (target.silencedDay === state.day) announce(state, M.trialMuted(target.name), now);
    }
  }
  return { ok: true };
}

/**
 * Files one accusation, and keeps the file from growing without limit.
 *
 * Six hundred entries is several long games' worth and a few kilobytes; past
 * that the oldest go, on the same reasoning as the chat ring — except that this
 * ring only ever contains votes, so a busy afternoon cannot push a death out of
 * anything.
 *
 * A repeat of what this seat already said is dropped: a client that resends the
 * same vote should not write a second line, and neither should a bot that
 * reaffirms one.
 */
function noteVote(state: MafiaState, voterSlot: number, targetSlot: number | null, skip: boolean): void {
  state.voteLog ??= [];
  const last = [...state.voteLog].reverse().find((note) => note.voterSlot === voterSlot && note.day === state.day);
  if (last && last.targetSlot === targetSlot && last.skip === skip) return;

  state.voteLog.push({ day: state.day, voterSlot, targetSlot, skip });
  if (state.voteLog.length > 600) state.voteLog.splice(0, state.voteLog.length - 600);
}

export function castBallot(
  state: MafiaState,
  voterId: string,
  verdict: 'guilty' | 'innocent' | 'abstain'
): ActionOutcome {
  if (mafiaPaused(state)) return PAUSED_REFUSAL;
  const voter = state.players[voterId];
  if (!voter?.alive) return { ok: false, error: NO.deadNoVote() };
  if (state.phase !== 'day' || state.stage !== 'judgement' || !state.trial) {
    return { ok: false, error: NO.notNow() };
  }
  if (state.trial.accusedId === voterId) return { ok: false, error: NO.accusedSilent() };

  if (verdict === 'abstain') delete state.trial.ballots[voterId];
  else state.trial.ballots[voterId] = verdict;
  return { ok: true };
}

/* ---------------------------- night actions ----------------------------- */

export interface LegalAction {
  type: NightActionType;
  /** Slots this action may target; empty for self-targeted powers. */
  targets: number[];
  /**
   * The second half of a two-target power: the Witch's destination, the Bus
   * Driver's other house. Absent for every other power.
   *
   * Declared separately from `targets` because the two pools are not the same
   * question — "whose hand do I guide" and "towards which door" — and because a
   * screen has to know whether to ask twice at all. Whoever is picked first is
   * filtered out of this list by the caller; the engine refuses the pair anyway.
   */
  secondTargets?: number[];
  charges: number | null;
}

/** The powers that are only half an order until a second house is named. */
export function needsSecondTarget(type: NightActionType): boolean {
  return type === 'control' || type === 'swap';
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
      return {
        type: 'swap',
        targets: [...slots(others), player.slot],
        secondTargets: [...slots(others), player.slot],
        charges: null
      };
    case 'convert': {
      if (player.cooldownUntilDay !== null && state.day < player.cooldownUntilDay) return null;
      /**
       * Only the townsfolk can be preached to, which the picker did not say.
       *
       * It offered every living outsider — mafiosi, triads, neutrals — while the
       * resolver converts town seats only, so a cultist could spend its one
       * night in two on a Godfather and be told merely that he "resisted the
       * call". A bot picks uniformly from what it is offered, so as the town
       * thinned the failure rate climbed, and once no town seat remained the
       * action stayed selectable and could never succeed again. That is the
       * "stopped converting for many turns" report.
       */
      const flock = outsiders.filter((entry) => entry.role !== null && roleDef(entry.role).faction === 'town');
      if (flock.length === 0) return null;
      return { type: 'convert', targets: slots(flock), charges: null };
    }
    case 'bond':
      if (player.bondPartnerId !== null) return null;
      return { type: 'bond', targets: slots(others), charges: uses };
    case 'control':
      /**
       * Whose hand, and then which door.
       *
       * The destination pool is every living house, the witch's own included:
       * pointing a vigilante at herself is a terrible idea rather than an illegal
       * one, and a rule that quietly removes the bad options removes the bluff
       * with them. The bewitched seat is filtered out by whoever asks, since it is
       * only known once the first half is picked.
       */
      return {
        type: 'control',
        targets: slots(others),
        secondTargets: alivePlayers(state).map((entry) => entry.slot),
        charges: null
      };
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
  if (!legal) return { ok: false, error: NO.noAction() };

  if (targetSlot === null) {
    delete state.nightActions[playerId];
    return { ok: true };
  }

  let targetId: string | null = null;
  if (legal.targets.length > 0) {
    const target = playerBySlot(state, targetSlot);
    if (!target || !legal.targets.includes(target.slot)) return { ok: false, error: NO.badTarget() };
    targetId = target.playerId;
  }

  /**
   * The second half: the Witch's destination, the Bus Driver's other house.
   *
   * **Required**, where it used to be optional with the resolver rolling a random
   * house when it was missing — and it was always missing, because no screen ever
   * sent it. Measured over 200 seeded nights, that fallback sent the Vigilante's
   * bullet to a uniformly random seat and put it through the Witch's own head 25 %
   * of the time, while the Bus Driver swapped the mafia's target with a stranger
   * and rode into the kill himself just as often. Two roles whose entire point is
   * deciding *where* something lands were deciding nothing.
   *
   * Refused rather than defaulted, because there is no sane default: a half-given
   * order is an unfinished one, and the caller has a second question to ask.
   */
  let secondTargetId: string | null = null;
  if (needsSecondTarget(legal.type)) {
    if (secondTargetSlot == null) return { ok: false, error: NO.needsSecondTarget() };
    const destination = playerBySlot(state, secondTargetSlot);
    if (!destination?.alive || !(legal.secondTargets ?? []).includes(destination.slot)) {
      return { ok: false, error: NO.badTarget() };
    }
    if (destination.slot === targetSlot) return { ok: false, error: NO.sameTwice() };
    secondTargetId = destination.playerId;
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
export function noteSeatAlive(state: MafiaState, playerId: string, now: number): boolean {
  return noteBeat(tablePresence(state), playerId, now);
}

/** A socket that dropped, or a phone that has stopped beating. */
export function noteSeatSilent(state: MafiaState, playerId: string, now: number): boolean {
  return markAway(tablePresence(state), playerId, now);
}

/**
 * How long a restored table gets before its phase runs out.
 *
 * Whatever was left of the phase died with the process, and resuming a night
 * with four seconds on it would resolve it before anybody had finished
 * reconnecting. A flat half-minute is long enough for the room to come back and
 * read the board, short enough that it is not a second phase.
 */
const RESTORE_CLOCK_MS = 30_000;

/**
 * Puts a table back on its feet after a restart. The counterpart to
 * `startPresenceFresh`, for a state read back out of the database.
 *
 * The clock is the delicate part, and the order here is the whole point. A table
 * snapshotted mid-pause has no `phaseEndsAt` at all — the pause parked it, and
 * what was left of the phase lives in `presence.parkedMs` — so whether this
 * phase was running has to be asked *before* the presence record that answers it
 * is cleared. Asking afterwards reads a paused table as one with no clock by
 * design, and since every phase in this game ends on a server timer, the table
 * would come back with no deadline and nothing left that could ever arm one:
 * frozen until the idle sweep noticed it hours later.
 */
export function restoreMafiaTable(state: MafiaState, now: number): void {
  const presence = tablePresence(state);
  const running = state.phaseEndsAt !== null || presence.parkedMs !== null;

  /**
   * Every socket in the world is gone, so an absence measured before the restart
   * says nothing about now — and a pause with nobody left to end it would freeze
   * the table forever. The kick list survives: somebody the room voted out stays
   * voted out across a deploy.
   */
  resetPresence(presence);

  /**
   * And then the truth about the sockets: there are none.
   *
   * Every connection in the world died with the process, so a `connected` flag
   * read back out of the snapshot records what was true before the restart and
   * nothing at all about now. Leaving it is worse than having no information —
   * the table counts an empty chair as occupied, no heartbeat ever arrives to
   * contradict it, so it never pauses for that seat and the room cannot even
   * vote it out ("that player is here"). The same trap `startPresenceFresh`
   * exists to avoid at the other end of the game.
   *
   * So everybody starts the resync window together, and whoever comes back
   * inside it — which is nearly everybody, the phones reconnect on their own —
   * is never noticed by anyone.
   */
  for (const player of Object.values(state.players)) {
    if (!player.isBot) player.connected = false;
  }
  // A lobby and a finished game wait for nobody, and an absence recorded there
  // would only be a stale entry nothing ever clears.
  if (state.phase !== 'lobby' && state.phase !== 'ended') {
    for (const seatId of waitedOnSeats(state)) {
      // Not the ones already voted out: the room stopped waiting for those.
      if (!presence.kicked.includes(seatId)) markAway(presence, seatId, now);
    }
  }

  if (running) state.phaseEndsAt = now + RESTORE_CLOCK_MS;
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

/**
 * The knife changes hands when there is nobody left holding it.
 *
 * A family whose leader and executors are all in the ground stops being a
 * threat forever: `resolveNight` finds no carrier and quietly skips the attack,
 * so the survivors become scenery the town still has to clear seat by seat
 * before it is allowed to win. That is the shape of a lot of long, drawn games.
 *
 * The Caporegime's own description has advertised this since the day it was
 * written — "when the Godfather falls, he learns to smile like him" — and
 * nothing implemented it. Any surviving member will take the knife; the
 * counsellor first, because a family promotes its second in command.
 *
 * The Cult carries no knife, so its version of this is the pulpit: see below.
 * Private in every case, because who holds either is the family's business.
 */
function promoteCarriers(state: MafiaState): void {
  for (const [faction, knife] of [
    ['mafia', 'mafioso'],
    ['triad', 'enforcer']
  ] as const) {
    const members = Object.values(state.players).filter(
      (player) => player.alive && player.role !== null && roleDef(player.role).faction === faction
    );
    if (members.length === 0) continue;
    const armed = members.some((member) => {
      const rank = roleDef(member.role!).familyRank;
      return rank === 'leader' || rank === 'executor';
    });
    if (armed) continue;

    const heir =
      members.find((member) => member.role === 'consigliere' || member.role === 'administrator') ?? members[0];
    heir.role = knife;
    heir.charges = roleDef(knife).charges ?? 0;
    notify(heir, NOTE.promoted(knife));
  }

  /**
   * And somebody has to keep preaching.
   *
   * Only a seat whose role is literally `cultist` can convert, and converting a
   * Doctor produces a Witch Doctor — a full cult member whose night is a heal,
   * not a sermon. So a cult that lost its cultists was finished as a cult while
   * still blocking the town's victory: its survivors counted for parity, could
   * never convert again, and nobody was told. Reported from a real game as two
   * cult deaths and one survivor who simply stopped working.
   *
   * The same succession the families get. It is not a free extra conversion:
   * the heir starts with no cooldown, which is exactly where a fresh cultist
   * starts, and the cult still only converts a night in two.
   */
  const flock = Object.values(state.players).filter(
    (player) => player.alive && player.role !== null && roleDef(player.role).faction === 'cult'
  );
  if (flock.length > 0 && !flock.some((member) => member.role === 'cultist')) {
    const heir = flock[0];
    heir.role = 'cultist';
    heir.charges = roleDef('cultist').charges ?? 0;
    notify(heir, NOTE.promoted('cultist'));
  }
}

function beginDay(state: MafiaState, now: number, announcements: Announcement[]): void {
  echoNotes(state, now);
  state.day += 1;
  state.phase = 'day';
  state.stage = 'discussion';
  state.trial = null;
  state.trialsToday = 0;
  state.votes = {};
  state.nightActions = {};
  // Day one has no corpse to argue about and no rope to pull, so it runs on its
  // own much shorter clock. Older persisted tables predate the field.
  state.phaseEndsAt = now + (state.day === 1 ? (state.config.firstDayMs ?? 35_000) : state.config.dayMs);
  /**
   * The ballot opens a little after the day does.
   *
   * Day one is exempt: there is no vote on it at all, so a lock would be a lock
   * on nothing. Every other day gets a window in which the only thing anybody
   * can do is talk — which is the point, because the vote that follows is then
   * taken against a board that has something on it.
   */
  state.voteOpensAt = state.day === 1 ? null : now + (state.config.voteLockMs ?? 15_000);

  announce(state, M.dayHeader(state.day), now);
  for (const line of announcements) {
    if (line.reveals) announceReveal(state, line.line, now);
    else announce(state, line.line, now);
  }
}

function beginNight(state: MafiaState, now: number): void {
  echoNotes(state, now);
  promoteCarriers(state);
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
    notify(jailed, NOTE.jailedNight());
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
    /**
     * The dawn report goes out even when there is no morning after it.
     *
     * `beginDay` prints the night's bodies, and a game that ended *on* that
     * night never reached it: victory was decided first and returned, so the
     * two corpses that finished the game, their wills and the weapons that made
     * them went straight into the bin. The table read "Night 8 falls" and then,
     * with nothing in between, the headline — the one death everybody wanted to
     * see explained was the one nobody was told about. Reported from a real
     * table, twice over: the last Serial Killer and the last Poisoner killed
     * each other in silence.
     */
    if (checkVictory(state, now, announcements)) return;
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
      const listed = ids
        .map((id) => state.players[id]?.name)
        .filter(Boolean)
        .join(', ');
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

function lynch(
  state: MafiaState,
  accused: MafiaPlayer,
  trial: { ballots: Record<string, 'guilty' | 'innocent'> },
  now: number
): void {
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
    state.winners.push({ playerId: accused.playerId, reason: M.winReason('jester'), kind: 'jester' });
    addPoints(state, accused.playerId, 'solo-win');
    // The rope was the plan, so the seat can never be paid for surviving it.
    addPoints(state, accused.playerId, 'martyr');
    notify(accused, NOTE.jesterWon());
    announce(state, M.winJester(), now);
    /**
     * And somebody pays for it in the morning.
     *
     * The Jester won by being hanged and that was the end of it, which makes
     * him the one role at the table with no teeth: voting guilty on a seat that
     * might be the Jester cost exactly nothing, so the square hanged him
     * cheerfully and played on. One of the hands that pulled the rope does not
     * wake up, chosen in the night from the guilty ballots — so a Jester is a
     * real reason to hesitate, and the seats who voted to spare him are the
     * ones who are safe.
     *
     * The verdict is public and so is the list, which is the point: everybody
     * can see who is at risk before the night falls.
     */
    const pulled = Object.entries(trial.ballots)
      .filter(([voterId, verdict]) => verdict === 'guilty' && state.players[voterId]?.alive)
      .map(([voterId]) => voterId);
    if (pulled.length > 0) state.jesterHaunt = pulled;
  }

  for (const player of Object.values(state.players)) {
    if (player.role === 'executioner' && player.alive && player.obsessionId === accused.playerId) {
      state.winners.push({ playerId: player.playerId, reason: M.winReason('executioner'), kind: 'executioner' });
      addPoints(state, player.playerId, 'solo-win');
      notify(player, NOTE.execWon());
    }
  }

  // A broken heart follows its owner into the grave, even from the gallows.
  for (const line of cascadeBonds(state)) {
    announceReveal(state, line, now);
  }
}

function kill(state: MafiaState, victim: MafiaPlayer, phase: 'day' | 'night', cause: Msg, source?: DeathSource): void {
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
  const blocked = new Set<string>();
  /**
   * A cell takes the night like a roleblock, and is remembered as its own thing.
   *
   * It was remembered as nothing at all: `blocked` swallowed the prisoner and no `disturbed` was filed, so a Sheriff
   * who spent the night in jail woke with no result, no explanation for it, and nothing to say when the square asked
   * — while `why.silent` votes people for having nothing to say. The jailor can corroborate this one, which makes it
   * the only one of the four with a witness.
   */
  if (jailedId) {
    blocked.add(jailedId);
    const prisoner = state.players[jailedId];
    if (prisoner) {
      disturbed(prisoner, state.day, 'jail');
      // And the jailor remembers its own night. See the `jailed` intel kind.
      const keeper = players.find((player) => player.alive && player.role === 'jailor');
      if (keeper && keeper.playerId !== prisoner.playerId) {
        keeper.intel.push({
          night: state.day,
          kind: 'jailed',
          targetSlot: prisoner.slot,
          value: acts[prisoner.playerId] ? 'tried' : 'quiet'
        });
      }
    }
  }

  // Yesterday's borrowed faces wash off before tonight's are painted on.
  for (const player of players) player.disguiseRole = null;

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
      // No destination, no redirection. `setNightAction` refuses a control without
      // one, so this only catches a destination who died before the night resolved.
      const destination = living(action.secondTargetId);
      if (destination) {
        victimAction.targetId = destination.playerId;
        notify(victim, NOTE.controlled());
        disturbed(victim, state.day, 'control');
        notify(player, NOTE.controlDone(victim.name, destination.name));
        // The experiment, written down. See the `controlled` intel kind.
        player.intel.push({
          night: state.day,
          kind: 'controlled',
          targetSlot: victim.slot,
          value: 'sent',
          slots: [destination.slot]
        });
      }
    } else {
      notify(player, NOTE.controlIdle(victim.name));
      player.intel.push({ night: state.day, kind: 'controlled', targetSlot: victim.slot, value: 'idle' });
    }
  }

  // The bus rolls next: two houses trade fates, and everything aimed at one
  // arrives at the other. The driver is on the road before the roadblocks.
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId) || player.role !== 'bus-driver') continue;
    const action = actionOf(player);
    if (action?.type !== 'swap') continue;
    const first = living(action.targetId);
    // Both houses or no bus: the driver names the pair, the engine never guesses.
    const second = living(action.secondTargetId);
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
    notify(first, NOTE.bussed());
    notify(second, NOTE.bussed());
    disturbed(first, state.day, 'swap');
    disturbed(second, state.day, 'swap');
    notify(player, NOTE.busDone(first.name, second.name));
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
    notify(target, NOTE.kidnapped());
    // And the kidnapper is told it worked, which it never was: the whole of the
    // feedback was an `intel` row, and no screen in the game renders those. You
    // pressed the button and observed nothing, which is exactly how it was
    // reported — "the kidnapper does not seem to work".
    notify(player, NOTE.kidnapDone(target.name));
    player.intel.push({ night: state.day, kind: 'blocked', targetSlot: target.slot, value: 'kidnapped' });
  }

  /**
   * Self-preparations: the alert and the vest, which cannot be blocked short of
   * being taken out of your own house.
   *
   * After the cell and the sack, and that ordering is the whole point. These ran
   * first, so a kidnapped Veteran spent a charge going on alert inside somebody
   * else's cellar, the kidnap counted as a visit to his porch, and the porch
   * pass shot the kidnapper — who was killed by the man he had just abducted,
   * while the abduction rendered that man untouchable. The jail has always got
   * this right by seeding `blocked` before this loop; the sack now does too.
   *
   * Still before the roleblock pass below, which reads `alerted` to decide that
   * an armed Veteran at home is nobody's idea of "kept busy".
   */
  const alerted = new Set<string>();
  const vested = new Set<string>();
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId)) continue;
    const action = actionOf(player);
    if (action?.type === 'alert' && player.charges > 0) {
      player.charges -= 1;
      alerted.add(player.playerId);
      notify(player, NOTE.onAlert());
    }
    if (action?.type === 'vest' && player.charges > 0) {
      player.charges -= 1;
      vested.add(player.playerId);
      notify(player, NOTE.vestOn());
    }
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
      notify(target, NOTE.blocked());
      disturbed(target, state.day, 'block');
      // The blocker knows whom they kept busy — a quiet night says a lot.
      player.intel.push({ night: state.day, kind: 'blocked', targetSlot: target.slot, value: 'blocked' });
    }
  }

  // Preparations, protections and marks.
  const framed = new Map<string, Faction>();
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
        // Whose frame it is decides what the sheriff reads: a Forger's target
        // reads Triad, a Framer's reads Mafia. That is the point of the power.
        framed.set(target.playerId, roleDef(player.role!).faction);
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
        notify(target, NOTE.silenced());
        notify(player, NOTE.silenceDone(target.name));
        break;
      case 'douse':
        if (target.playerId !== player.playerId) {
          target.doused = true;
          visit(player.playerId, target.playerId);
          notify(target, NOTE.doused());
          notify(player, NOTE.douseDone(target.name));
          player.intel.push({ night: state.day, kind: 'doused', targetSlot: target.slot, value: 'doused' });
        }
        break;
      case 'charge':
        if (target.playerId !== player.playerId) {
          target.charged = true;
          visit(player.playerId, target.playerId);
          notify(player, NOTE.chargeDone(target.name));
          player.intel.push({ night: state.day, kind: 'doused', targetSlot: target.slot, value: 'charged' });
        }
        break;
      case 'poison':
        target.poisonedNight = state.day;
        visit(player.playerId, target.playerId);
        notify(target, NOTE.poisoned());
        notify(player, NOTE.poisonDone(target.name));
        break;
      case 'imitate':
        player.disguiseRole = target.role;
        visit(player.playerId, target.playerId);
        notify(player, NOTE.disguised(target.role!));
        break;
      case 'hide':
        hideHosts.set(player.playerId, target.playerId);
        visit(player.playerId, target.playerId);
        notify(player, NOTE.hiding(target.name));
        break;
      case 'charm':
        target.bondPartnerId = player.playerId;
        target.bondKind = 'charm';
        visit(player.playerId, target.playerId);
        notify(target, NOTE.charmed());
        notify(player, NOTE.charmDone(target.name));
        break;
      case 'bond':
        if (player.charges > 0 && player.bondPartnerId === null) {
          player.charges -= 1;
          player.bondPartnerId = target.playerId;
          player.bondKind = 'lover';
          target.bondPartnerId = player.playerId;
          target.bondKind = 'lover';
          visit(player.playerId, target.playerId);
          notify(player, NOTE.bondDone(target.name));
          notify(target, NOTE.bonded(player.name));
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

  /**
   * The current spreads by touch: a wired house electrifies whoever walks in.
   *
   * This is what the Électromane is *for*, and without it the role was a slower
   * arsonist that a single doctor switched off. One charged house is a trap rather
   * than a corpse: wire the seat everyone visits — the claimed doctor, the loud
   * sheriff — and every investigator who calls on them that night joins the
   * circuit. The lever then takes the whole network at once.
   *
   * Read off the charged set as it stands *after* tonight's preparations and
   * applied exactly once, so it is one hop and not a chain: you are charged by the
   * house you walked into, never by the person who walked in behind you. A chain
   * would make a single wire eventually reach the whole town, which is a different
   * and much worse game.
   *
   * Silent on both sides, like the direct charge above: the visitor is told
   * nothing, and neither is the maniac. A tell here would give the town a free
   * detector for the one role whose entire threat is that nobody knows the map of
   * it. The maniac's own visit is exempt, for the obvious reason.
   */
  const maniac = players.find((entry) => entry.alive && entry.role === 'electromaniac') ?? null;
  if (maniac) {
    const liveWires = new Set(players.filter((entry) => entry.alive && entry.charged).map((entry) => entry.playerId));
    for (const { visitorId, targetId } of visits) {
      if (!liveWires.has(targetId) || visitorId === maniac.playerId) continue;
      const visitor = state.players[visitorId];
      if (visitor?.alive && !visitor.charged) visitor.charged = true;
    }
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

  /**
   * The lever drops: every wired house takes the surge. Power 3, like the fire.
   *
   * It was power 2, which meant one doctor or one bodyguard cancelled the entire
   * payoff of three nights of wiring — measured head to head against the arsonist
   * on the same table, the same two marked houses and the same two protectors, the
   * fire killed 2 of 2 and the surge killed 0 of 2. A finisher that a single
   * common town role switches off is not a finisher.
   *
   * Both solo killers now end their raid the same way, and the difference between
   * them is the shape of the setup rather than the strength of the payoff: petrol
   * is poured deliberately house by house, current spreads itself along the town's
   * own footpaths. Only a jail cell stops either.
   */
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId) || player.role !== 'electromaniac') continue;
    const action = actionOf(player);
    if (action?.type !== 'charge' || action.targetId !== player.playerId) continue;
    for (const wired of players) {
      if (wired.alive && wired.charged && wired.playerId !== player.playerId) {
        attacks.push({ attackerId: player.playerId, targetId: wired.playerId, power: 3, source: 'electromaniac' });
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
      visits
        .filter((entry) => entry.targetId === houseId && entry.visitorId !== attackerId)
        .map((entry) => entry.visitorId)
    );
    for (const visitorId of caught) {
      attacks.push({ attackerId, targetId: visitorId, power: 1, source: 'massMurderer' });
    }
  }

  // The jailor's execution: inside the cell, no protection reaches it.
  const jailor = players.find((p) => p.alive && p.role === 'jailor');
  const jailed = living(jailedId);
  // A jailor who has been kidnapped or roleblocked pulls no lever: every other
  // kill in this file checks `blocked` and this one did not, so the single most
  // valuable use of a kidnap — the man with the keys — did nothing at all.
  if (
    jailor &&
    jailed &&
    !blocked.has(jailor.playerId) &&
    actionOf(jailor)?.type === 'jail-execute' &&
    jailor.charges > 0
  ) {
    jailor.charges -= 1;
    attacks.push({ attackerId: jailor.playerId, targetId: jailed.playerId, power: 3, source: 'jailor' });
  }

  // The veteran shoots everything that moves on his porch.
  for (const { visitorId, targetId } of visits) {
    if (alerted.has(targetId) && visitorId !== targetId) {
      attacks.push({ attackerId: targetId, targetId: visitorId, power: 2, source: 'veteran' });
    }
  }

  /**
   * Every journey goes on its traveller's own record.
   *
   * Before this, only powers that came back with a *result* left a trace: the
   * sheriff's verdict, the lookout's list. A doctor, an escort, a bodyguard who
   * visited somebody and learned nothing had no entry for the night at all, and
   * a seat with no entry for its last night is a corpse whose will cannot say
   * where it died. Recorded before the attacks resolve, so the traveller who
   * does not come home still has the line.
   */
  for (const { visitorId, targetId } of visits) {
    if (visitorId === targetId) continue;
    const traveller = state.players[visitorId];
    const house = state.players[targetId];
    if (!traveller || !house) continue;
    if (
      traveller.intel.some(
        (entry) => entry.night === state.day && entry.kind === 'went' && entry.targetSlot === house.slot
      )
    ) {
      continue;
    }
    traveller.intel.push({ night: state.day, kind: 'went', targetSlot: house.slot, value: 'went' });
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
      if (attacker) notify(attacker, NOTE.targetMissing());
      continue;
    }
    /**
     * A kidnapped player is somewhere nobody knows — except the man holding
     * them in his own cell.
     *
     * `!fromJailor` is on the cell check above and was missing here, so an
     * outsider could reach into the jail, sack the prisoner, and void a
     * power-three execution the jailor had already spent a charge on.
     */
    if (sheltered.has(target.playerId) && !fromJailor && !isPoison) {
      if (attacker) notify(attacker, NOTE.targetMissing());
      continue;
    }

    let defense = 0;
    if (target.role && roleDef(target.role).nightImmune) defense = Math.max(defense, 1);
    if (vested.has(target.playerId)) defense = Math.max(defense, 1);
    if (alerted.has(target.playerId)) defense = Math.max(defense, 2);
    if (isPoison) defense = 0; // the poison is already inside; armour is irrelevant

    if (attack.power <= defense) {
      notify(target, NOTE.survived());
      rescued(target, state.day, 'self');
      if (attacker) notify(attacker, NOTE.attackFailed());
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
        notify(target, NOTE.guarded());
        rescued(target, state.day, 'bodyguard');
        if (attacker && attacker.playerId !== guard.playerId) {
          const counterDefense = attacker.role && roleDef(attacker.role).nightImmune ? 1 : 0;
          if (2 > counterDefense && !diedTonight.has(attacker.playerId)) {
            diedTonight.add(attacker.playerId);
            kill(state, attacker, 'night', CAUSE.bodyguard());
          } else {
            notify(attacker, NOTE.bodyguardRepelled());
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
        notify(target, NOTE.purged());
      } else {
        notify(target, NOTE.healed());
      }
      // Either way a doctor spent its night here, and the seat knows it.
      rescued(target, state.day, 'doctor');
      for (const healer of healerList) {
        if (healer) {
          notify(healer, NOTE.healSaved());
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
          notify(attacker, NOTE.executedInnocent());
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

  /**
   * The Jester's last laugh, collected after every other knife has fallen.
   *
   * One of the hands that pulled the rope does not wake up. Last on purpose:
   * remorse is not an attack, so no doctor heals it, no bodyguard steps in
   * front of it and no vest turns it — nothing in the night was ever aimed at
   * this seat and there is nothing for a protector to have been pointed at.
   * Drawn from the guilty ballots that are still alive at dawn, so a voter the
   * family happened to kill the same night does not spend the Jester's revenge
   * on an empty chair. See `jesterHaunt`.
   */
  const haunted = (state.jesterHaunt ?? []).filter((voterId) => living(voterId));
  state.jesterHaunt = undefined;
  if (haunted.length > 0) {
    const chosen = haunted[Math.floor(rng() * haunted.length)];
    const mourner = chosen ? state.players[chosen] : undefined;
    if (mourner?.alive) {
      diedTonight.add(mourner.playerId);
      kill(state, mourner, 'night', CAUSE.remorse(), 'remorse');
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
    notify(cleaner, NOTE.cleaned(target.name, target.role!));
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
    if (
      player.role === 'executioner' &&
      player.alive &&
      player.obsessionId &&
      !state.players[player.obsessionId]?.alive
    ) {
      player.role = 'jester';
      player.obsessionId = null;
      notify(player, NOTE.griefMad());
    }
  }

  // The spy's ear: which doors the families chose tonight.
  for (const player of players) {
    if (!player.alive || blocked.has(player.playerId) || player.role !== 'spy') continue;
    for (const [familyId, targetId] of familyKillTargets) {
      const target = state.players[targetId];
      if (!target) continue;
      // The family's own name as a camp key, so the Cult never reports as the
      // Triad the day it can kill.
      notify(player, NOTE.familyAimed(familyId, target.slot));
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
      /**
       * Not "suspicious", but suspicious *of what*.
       *
       * A verdict the town can act on: the family it belongs to, or the blade
       * it carries. "Suspicious" is a shrug the room argues about for a day;
       * "a Serial Killer" is a name, a threat level and an instruction, and it
       * is what every version of this game outside this file has always said.
       *
       * Order matters. A frame overrides everything, because that is what a
       * frame is for. Detection immunity comes next and reads clean. Then the
       * families, then the lone blades, and last the seat that simply smells
       * wrong without belonging to anybody.
       */
      const framedAs = framed.get(target.playerId);
      const family = familyOf(shownRole);
      const verdict: SheriffVerdict = framedAs
        ? framedAs === 'triad'
          ? 'triad'
          : framedAs === 'cult'
            ? 'cult'
            : 'mafia'
        : shown.detectionImmune
          ? 'clear'
          : family !== null
            ? family
            : shown.soloKiller
              ? (shownRole as SheriffVerdict)
              : shown.suspicious
                ? 'suspect'
                : 'clear';
      notify(player, NOTE.sheriff(target.name, verdict));
      player.intel.push({ night: state.day, kind: 'sheriff', targetSlot: target.slot, value: verdict });
    }
    if (action.type === 'examine') {
      if (player.role === 'consigliere' || player.role === 'administrator') {
        notify(player, NOTE.exactRole(target.name, shown.id));
        player.intel.push({ night: state.day, kind: 'role', targetSlot: target.slot, value: shownRole });
      } else {
        /**
         * No crime committed, no crime detected.
         *
         * An examiner reads what its target *did* last night, not what it is:
         * a seat that stayed in, or was held at home, leaves nothing to find
         * and comes back with the quiet line. That is the rule everywhere this
         * game comes from, and it is what makes the Investigator a reader of
         * behaviour rather than a slower Sheriff — a Mafioso on a night the
         * family sent somebody else is genuinely invisible to it.
         *
         * It also puts a real cost on the power: examine the wrong night and
         * you learn nothing, and the town cannot treat a quiet result as a
         * clean one. See `tradeVerdict`, which refuses to read it as clean.
         */
        const acted = !!acts[target.playerId]?.targetId && !blocked.has(target.playerId);
        const line = framed.has(target.playerId)
          ? roleDef('framer').investigated
          : acted
            ? shown.investigated
            : QUIET_TRADE;
        notify(player, NOTE.tradeLine(target.name, line));
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
        NOTE.visitors(
          target.name,
          seenPlayers.map((visitor) => visitor.name)
        )
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
        NOTE.tracked(
          target.name,
          wentTo.map((house) => house.name)
        )
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
      notify(player, NOTE.autopsy(target.name, target.role!));
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
        notify(target, NOTE.initiated());
        notify(player, NOTE.initiateDone(target.name));
      } else {
        notify(player, NOTE.initiateRefused(target.name));
      }
    }

    if (action.type === 'convert' && player.role === 'cultist' && target.alive) {
      visit(player.playerId, target.playerId);
      if (target.role && roleDef(target.role).faction === 'town') {
        const converted: RoleId = target.role === 'doctor' ? 'witch-doctor' : 'cultist';
        target.role = converted;
        target.charges = roleDef(converted).charges ?? 0;
        player.cooldownUntilDay = state.day + 2;
        notify(target, NOTE.converted());
        notify(player, NOTE.convertDone(target.name));
        announcements.push({ line: M.cultChant(), reveals: true });
      } else {
        notify(player, NOTE.convertRefused(target.name));
      }
    }

    if (action.type === 'remember' && player.role === 'amnesiac' && !target.alive && target.role) {
      const remembered = target.role;
      player.role = remembered;
      player.charges = roleDef(remembered).charges ?? 0;
      notify(player, NOTE.remembered(remembered));
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
      else if (targetDef.faction === 'neutral' && !targetDef.soloKiller && target.role !== 'auditor')
        audited = 'scumbag';
      if (audited && audited !== target.role) {
        player.charges -= 1;
        target.role = audited;
        target.charges = roleDef(audited).charges ?? 0;
        notify(target, NOTE.audited(audited));
        notify(player, NOTE.auditDone(target.name));
      } else {
        notify(player, NOTE.auditFailed(target.name));
      }
    }
  }

  state.jailedId = null;
  state.nightActions = {};
  return announcements;
}

/* ------------------------------- endings -------------------------------- */

const FAMILY_WIN: Record<FamilyId, { reason: Msg; headline: Msg }> = {
  mafia: { reason: M.winReason('mafia'), headline: M.winFamily('mafia') },
  triad: { reason: M.winReason('triad'), headline: M.winFamily('triad') },
  cult: { reason: M.winReason('cult'), headline: M.winFamily('cult') }
};

const SOLO_WIN: Partial<Record<RoleId, { reason: Msg; headline: Msg }>> = {
  'serial-killer': {
    reason: M.winReason('serial-killer'),
    headline: M.winSolo('serial-killer')
  },
  arsonist: { reason: M.winReason('arsonist'), headline: M.winSolo('arsonist') },
  'mass-murderer': { reason: M.winReason('mass-murderer'), headline: M.winSolo('mass-murderer') },
  poisoner: {
    reason: M.winReason('poisoner'),
    headline: M.winSolo('poisoner')
  },
  electromaniac: { reason: M.winReason('electromaniac'), headline: M.winSolo('electromaniac') }
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
      state.winners.push({ playerId: player.playerId, reason: M.winReason('survivor'), kind: 'survivor' });
      addPoints(state, player.playerId, 'solo-win');
    }
    // Misfortune's parasites: alive while the town failed is a win.
    if (
      player.alive &&
      (player.role === 'witch' || player.role === 'scumbag' || player.role === 'judge' || player.role === 'auditor') &&
      !townWon
    ) {
      state.winners.push({ playerId: player.playerId, reason: M.winReason('parasite'), kind: 'parasite' });
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
      state.winners.push({ playerId: player.playerId, reason: M.winReason('lovers'), kind: 'lovers' });
      state.winners.push({ playerId: player.bondPartnerId, reason: M.winReason('lovers'), kind: 'lovers' });
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

/**
 * What a killer's worst night can put through a door.
 *
 * Read off the attacks `resolveNight` actually pushes, because the whole value of this table is that it matches
 * them: a fire is power 3 and a massacre is power 1, and a rule that guessed "a killer kills" would hand the
 * arsonist's win to the mass murderer standing in front of a night-immune seat he can never touch. Poison is the odd
 * one — `resolveNight` zeroes the target's armour before it lands — so it is written as 3 here, which is the same
 * thing said in the only language this function speaks.
 */
const BLADE: Partial<Record<RoleId, number>> = {
  'serial-killer': 2,
  'mass-murderer': 1,
  arsonist: 3,
  poisoner: 3,
  electromaniac: 3
};

/**
 * Powers that can still change a night, whoever holds them.
 *
 * Not "powers that are useful" — powers that make tonight something other than a foregone conclusion. A roleblock, a
 * redirection or a swap takes the killer's night away; a cell takes his whole day; a memory turns a bystander into
 * somebody with a gun. Healing and guarding are on the list and gated separately below, because neither can be
 * pointed at its own owner.
 */
const INTERFERES: ReadonlySet<NightActionType> = new Set<NightActionType>([
  'block',
  'control',
  'swap',
  'kidnap',
  'jail-execute',
  'heal',
  'guard',
  'remember'
]);

/**
 * Whether the seats about to lose can still do anything about it.
 *
 * The rule the endgame was missing. A Serial Killer and one Sheriff at dawn is not an open game: the Sheriff cannot
 * hang anybody — one vote out of two never reaches a majority — and the blade comes through his door tonight. The
 * table played the day out anyway, everybody already knowing how it ended, then played the night, and only then was
 * told. The families never had this problem because parity settles them on the same morning; a lone killer needed it
 * said out loud.
 *
 * Deliberately pessimistic about the killer's side: anything at all that could still turn the night defers the crown,
 * because ending a game one night late costs a phase and ending one a night early steals a win somebody was about to
 * earn. Every entry below is something `resolveNight` or `castVote` can genuinely do tonight, not something that
 * merely sounds dangerous.
 *
 * Deliberately *not* on the list: the Marshall. A revealed Marshall skips the defence and raises the day's trial cap,
 * and neither moves the majority a rope needs — with two seats alive the survivor still cannot reach it, so the badge
 * changes nothing about this particular morning.
 */
function beyondSaving(state: MafiaState, killers: readonly MafiaPlayer[], rest: readonly MafiaPlayer[]): boolean {
  if (rest.length === 0) return true;

  /**
   * The rope first, because it is the one answer every seat holds.
   *
   * Counted as weight rather than heads, and a Mayor counts for three whether or not he has stood up yet: revealing
   * is a free action he can take on this very afternoon, and a rule that ignored it would end the game on the one
   * seat still holding a lynch. The threshold moves with him, so both sides of the comparison are recomputed as
   * though the badge were already out.
   */
  const standing = rest.some((player) => player.role === 'mayor' && !player.revealed) ? 2 : 0;
  const table = alivePlayers(state).reduce((sum, player) => sum + voteWeight(player), 0) + standing;
  const theirs = rest.reduce((sum, player) => sum + voteWeight(player), 0) + standing;
  if (theirs >= Math.floor(table / 2) + 1) return false;

  const blade = Math.max(0, ...killers.map((player) => BLADE[player.role!] ?? 1));
  const killerIds = new Set(killers.map((player) => player.playerId));

  for (const player of rest) {
    const def = roleDef(player.role!);

    // A door the blade does not open. Only the massacre is blunt enough to care.
    if (def.nightImmune && blade <= 1) return false;

    /**
     * An unspent charge, weighed against what it is unspent on.
     *
     * The porch always counts: an alerted Veteran is armour 2 and shoots back at 2, which is more than any lone
     * killer has and enough to drop one. The rest is arithmetic. A vest is armour 1 and a blade of 2 or more goes
     * straight through it. A cell's lever is power 3 and opens everything. A bullet is power 1, and every lone killer
     * sleeps behind night immunity, so the gun in the last townie's drawer is a rescue only against a killer who can
     * actually be shot.
     */
    if (player.charges > 0 && def.nightAction === 'alert') return false;
    if (player.charges > 0 && def.nightAction === 'vest' && blade <= 1) return false;
    if (player.charges > 0 && def.nightAction === 'jail-execute') return false;
    if (player.charges > 0 && def.nightAction === 'kill' && killers.some((k) => !roleDef(k.role!).nightImmune)) {
      return false;
    }

    /**
     * And a power that gets in the killer's way.
     *
     * A heal and a guard are the exception twice over: neither role may point its night at itself, so the last doctor
     * alive is a doctor who dies, and they count only while there is somebody else on that side to stand in front of.
     */
    if (def.nightAction !== null && INTERFERES.has(def.nightAction)) {
      const selfless = def.nightAction === 'heal' || def.nightAction === 'guard';
      if (!selfless || rest.length > 1) return false;
    }

    // A killer who cannot cut the last rope without hanging himself: grief takes
    // the partner of anybody who dies, lovers included.
    if (player.bondPartnerId !== null && killerIds.has(player.bondPartnerId)) return false;
  }

  return true;
}

/** True when the game just ended; the caller stops scheduling. */
export function checkVictory(state: MafiaState, now: number, pending: Announcement[] = []): boolean {
  if (state.phase === 'ended') return true;
  const alive = alivePlayers(state);
  const families: FamilyId[] = ['mafia', 'triad', 'cult'];
  const byFamily = new Map<FamilyId, MafiaPlayer[]>(
    families.map((familyId) => [familyId, alive.filter((player) => playerFamily(player) === familyId)])
  );
  const soloKillers = alive.filter((player) => player.role !== null && isSoloKiller(player.role));

  /**
   * The last night's report, said before the last word about the game.
   *
   * Empty for every call that is not the end of a night — a lynch has already
   * announced its own body — and printed exactly once, immediately before the
   * headline that ends the table, so the story reads in the order it happened.
   */
  const report = (): void => {
    for (const line of pending) {
      if (line.reveals) announceReveal(state, line.line, now);
      else announce(state, line.line, now);
    }
    pending.length = 0;
  };

  const crownFamily = (familyId: FamilyId): void => {
    const win = FAMILY_WIN[familyId];
    for (const player of Object.values(state.players)) {
      if (player.role && familyOf(player.role) === familyId) {
        state.winners.push({ playerId: player.playerId, reason: win.reason, kind: familyId });
        addPoints(state, player.playerId, 'win');
      }
    }
    report();
    endGame(state, now, win.headline, 'family');
  };

  const familiesAlive = families.filter((familyId) => (byFamily.get(familyId)?.length ?? 0) > 0);

  // The town wins when every family and every lone killer is in the ground.
  if (familiesAlive.length === 0 && soloKillers.length === 0) {
    /**
     * And when there is a town left to win it.
     *
     * The last three seats were a Poisoner, a Serial Killer and a Judge; the
     * killers took each other on night 8 and the Judge, alone in an empty town,
     * was told the Town had won — which cost it the game, because a Judge wins
     * exactly when the town does not. "Every enemy is dead" is not the town's
     * victory condition on its own: somebody has to have survived to be the
     * town. Nobody did, so nobody carried it, and the seats that live off the
     * town's failure are paid by `endGame` as they should be. Reported from a
     * real table.
     */
    const townStanding = alive.some((player) => player.role && roleDef(player.role).faction === 'town');
    if (!townStanding) {
      report();
      endGame(state, now, M.winHollow(), 'draw');
      return true;
    }
    for (const player of Object.values(state.players)) {
      if (player.role && roleDef(player.role).faction === 'town') {
        state.winners.push({ playerId: player.playerId, reason: M.winReason('town'), kind: 'town' });
        addPoints(state, player.playerId, 'win');
      }
    }
    report();
    endGame(state, now, M.winTown(), 'town');
    return true;
  }

  /**
   * A lone killer wins once nothing that could stop him still breathes — or once nothing that still breathes could
   * stop him.
   *
   * Two conditions, and the second one is new. The first is the old rule and the plain one: everybody left is a
   * bystander, so there is no night left to play. The second is the endgame the table used to sit through anyway — a
   * killer and one seat that cannot hang him, cannot outlive him and cannot hit back. See `beyondSaving`, which is
   * where every exception to that lives.
   */
  if (familiesAlive.length === 0 && soloKillers.length > 0) {
    const kinds = new Set(soloKillers.map((player) => player.role));
    const rest = alive.filter((player) => !soloKillers.includes(player));
    const threats = rest.filter((player) => !BYSTANDER_ROLES.has(player.role!));
    if (kinds.size === 1 && (threats.length === 0 || beyondSaving(state, soloKillers, rest))) {
      const win = SOLO_WIN[soloKillers[0].role!] ?? SOLO_WIN['serial-killer']!;
      for (const player of soloKillers) {
        state.winners.push({ playerId: player.playerId, reason: win.reason, kind: 'solo-killer' });
        addPoints(state, player.playerId, 'solo-win');
      }
      report();
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
