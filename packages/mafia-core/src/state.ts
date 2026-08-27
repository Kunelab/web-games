import { createChat, type ChannelRules, type ChatState } from 'chat-core';
import type { Locale, Msg } from 'i18n';

import type { DeathSource } from './messages.js';

import { familyOf, roleDef, rosterFor, type FamilyId, type NightActionType, type RoleId } from './roles.js';
import { censusSetup, chaosSetup, fitSetup, rollSetup, setupById, type SlotToken } from './setups.js';

/**
 * One Mafia table: up to 24 numbered seats around the town square. The state is
 * a plain JSON-serialisable object, snapshotted to SQLite on every transition
 * like the quizzes and CoronaZ. All mutation goes through engine.ts; timers
 * live in the server's manager, never here.
 */

export type MafiaPhase = 'lobby' | 'day' | 'night' | 'ended';

/** Sub-state of a day: open discussion, or a trial in one of its two beats. */
export type DayStage = 'discussion' | 'defense' | 'judgement';

export interface MafiaConfig {
  /** Seats on the map. Fixed positions, numbered 1..maxPlayers. */
  maxPlayers: number;
  minPlayers: number;
  /** Phase clocks, milliseconds. */
  dayMs: number;
  nightMs: number;
  defenseMs: number;
  judgementMs: number;
  /** Extra discussion granted after a spared trial. */
  aftermathMs: number;
  /** Trials a single day may hold before night falls by exhaustion. */
  trialsPerDay: number;
  /** Days before a draw is called. */
  maxDays: number;
  /**
   * What a corpse gives away.
   *
   * `role` is the classic reading: the body is identified and the town learns
   * exactly what it just hanged. `faction` names the camp and nothing more, which
   * keeps the shape of the game while making a Coroner's autopsy worth having.
   * `none` reveals nothing until the end, which turns every death into an
   * argument rather than a fact.
   *
   * Three things are deliberately *outside* this setting, because they are
   * mechanics rather than presentation. A cleaned corpse (Janitor, Incense
   * Master) stays nameless whatever the policy — that is what the power buys. A
   * borrowed face (Disguiser, Actress, Diva) never reaches the slab: the reveal
   * always reads the true `role`, because `disguiseRole` exists to fool
   * *examiners* and nothing else. And a role that has been *changed* — audited,
   * converted, remembered, initiated, or a widowed Executioner gone mad — reveals
   * what its owner had become, which is the whole point of those powers.
   */
  revealOnDeath: 'role' | 'faction' | 'none';
  /**
   * The language this table is *spoken* in.
   *
   * Not the same thing as a reader's language, and the distinction is the whole
   * localisation design. Announcements are keys, so every phone renders them in
   * its owner's language and a mixed table works. But a bot's chat line is free
   * text in a shared channel — it cannot be one thing to you and another to the
   * person arguing with you — so it picks this, once, for the table.
   */
  locale: Locale;
  /**
   * How the roles are dealt: the balanced automatic roster, a proposed
   * template, a player-saved slot list, or pure chaos.
   */
  setup: MafiaSetupChoice;
}

export type MafiaSetupChoice =
  | { mode: 'auto' }
  | { mode: 'chaos' }
  | { mode: 'census' }
  | { mode: 'preset'; presetId: string }
  | { mode: 'custom'; slots: SlotToken[] };

export const DEFAULT_CONFIG: MafiaConfig = {
  maxPlayers: 24,
  minPlayers: 4,
  dayMs: 120_000,
  nightMs: 40_000,
  defenseMs: 25_000,
  judgementMs: 20_000,
  aftermathMs: 45_000,
  trialsPerDay: 3,
  maxDays: 20,
  revealOnDeath: 'role',
  locale: 'en',
  setup: { mode: 'auto' }
};

/**
 * A structured night result, private to its owner. The notifications carry the
 * same information as prose for humans; bots and future UI read this instead
 * of parsing French.
 */
export interface IntelEntry {
  night: number;
  kind: 'sheriff' | 'trade' | 'role' | 'visitors' | 'tracked' | 'saved' | 'doused' | 'spied' | 'blocked' | 'swapped';
  targetSlot: number;
  /** sheriff: 'suspect' | 'clear'; trade: the trade line; role: a RoleId; saved/doused: constants. */
  value: string;
  /** visitors only: who called on the watched house. */
  slots?: number[];
}

export interface MafiaPlayer {
  playerId: string;
  /** Credential the phone stores; proves the seat on reconnection. */
  token: string;
  name: string;
  /** Seat number, 1-based, doubles as the house position on the map. */
  slot: number;
  /**
   * The language this person reads in, from their browser.
   *
   * Only used to decide what the *bots* speak: see `spokenLocale`. A player's own
   * screen is localised client-side and needs no help from the server.
   */
  locale?: Locale;
  /** Kune login when the browser was signed in; points bank here. */
  account?: string;
  isBot: boolean;
  connected: boolean;
  alive: boolean;
  role: RoleId | null;
  /** Remaining uses of a limited power (bullets, alerts, executes, vests). */
  charges: number;
  /** Executioner only: the head this player wants on a pike. */
  obsessionId: string | null;
  /** Mayor only: whether the sash is out. Triples the vote. */
  revealed: boolean;
  /** Soaked in the arsonist's gasoline. Burns when the match drops. */
  doused: boolean;
  /** Wired by the electromaniac. Zapped when the lever drops. */
  charged: boolean;
  /** Night the poisoner struck; death comes the following night unless cured. */
  poisonedNight: number | null;
  /** Day number this player may not speak on (the blackmailer's gag). */
  silencedDay: number | null;
  /** What examiners see instead of the real role (imposteur, actrice, diva). */
  disguiseRole: RoleId | null;
  /** Bound heart: lover pairs and the heartbreaker's victims. */
  bondPartnerId: string | null;
  bondKind: 'lover' | 'charm' | null;
  /** Next day this player's cooldown power may fire again (cult conversion). */
  cooldownUntilDay: number | null;
  lastWill: string;
  /** Private feed: night results, warnings. Only ever sent to this player. */
  notifications: string[];
  /** The same night results, structured. Same privacy as the notifications. */
  intel: IntelEntry[];
  /** Filled at death; role goes public with it. */
  death: { day: number; phase: 'day' | 'night'; cause: Msg } | null;
}

export interface TrialState {
  accusedId: string;
  /** Guilty/innocent ballots, by voter id. Abstention = absent key. */
  ballots: Record<string, 'guilty' | 'innocent'>;
  /** The judge's exceptional court: no defense, and his ballot counts triple. */
  court?: boolean;
}

export interface NightAction {
  type: NightActionType;
  targetId: string | null;
  /** Witch only: where the controlled player is sent. Absent = fate decides. */
  secondTargetId?: string | null;
}

export interface PointEntry {
  playerId: string;
  reason:
    | 'win'
    | 'solo-win'
    | 'survive'
    | 'kill'
    | 'save'
    | 'lynch-evil'
    | 'execute-evil'
    | 'participation';
  amount: number;
}

export interface MafiaState {
  code: string;
  hostToken: string;
  hostUserId: number | null;
  config: MafiaConfig;
  phase: MafiaPhase;
  /** Day counter; day 1 is the greeting day (no votes). */
  day: number;
  stage: DayStage | null;
  /** Server deadline of the running phase; clients render the countdown. */
  phaseEndsAt: number | null;
  players: Record<string, MafiaPlayer>;
  /** Day accusations: voter id -> accused id. */
  votes: Record<string, string>;
  trial: TrialState | null;
  trialsToday: number;
  /** Night submissions, by actor id. */
  nightActions: Record<string, NightAction>;
  /** Who the jailor locked up for tonight (chosen during the day). */
  jailedId: string | null;
  chat: ChatState;
  /**
   * Public record of every completed trial: after the verdict, the town sees
   * who voted to hang and who voted to save. Reads are made of this.
   */
  trialLog: {
    day: number;
    accusedId: string;
    lynched: boolean;
    guiltyIds: string[];
    innocentIds: string[];
  }[];
  /** The public graveyard, in order of death. `hidden` = cleaned by a janitor. */
  deaths: {
    playerId: string;
    day: number;
    phase: 'day' | 'night';
    cause: Msg;
    /**
     * Who struck, when a killer did. Absent for a lynching or a broken heart.
     *
     * Stored alongside the sentence because two things count these: the lone-blade
     * tally that briefly puts the families on the town's side, and the bench. Both
     * used to do it by searching the French cause text for 'Tueur', which worked
     * until the day the text stopped being French.
     */
    source?: DeathSource;
    role: RoleId;
    hidden?: boolean;
  }[];
  /** Personal and faction wins, filled as they happen and at the end. */
  winners: { playerId: string; reason: string }[];
  points: PointEntry[];
  createdAt: number;
  lastActivityAt: number;
}

export interface CreateMafiaInput {
  code: string;
  hostToken: string;
  hostUserId: number | null;
  config?: Partial<MafiaConfig>;
  now: number;
}

/**
 * What this game keeps, channel by channel.
 *
 * The square is the record — every death, every verdict, every role that came to
 * light — and a table of twenty-four argues in it for twenty days, so it gets an
 * allowance an order of magnitude past a whisper thread. Announcements are
 * counted separately from talk inside every channel (see `Retention`), so 250
 * here means the last 250 things *said* in the square and the last 250 things the
 * game *announced* there, and no amount of shouting can push out a dawn report.
 *
 * `total` is the ceiling that keeps the state serialisable: 276 possible whisper
 * threads at a table of 24 is more channels than any per-channel budget should be
 * trusted to bound on its own.
 */
export const MAFIA_RETENTION = { perChannel: 50, channels: { day: 250 }, total: 900 };

export function createMafiaGame(input: CreateMafiaInput): MafiaState {
  return {
    code: input.code,
    hostToken: input.hostToken,
    hostUserId: input.hostUserId,
    config: { ...DEFAULT_CONFIG, ...input.config },
    phase: 'lobby',
    day: 0,
    stage: null,
    phaseEndsAt: null,
    players: {},
    votes: {},
    trial: null,
    trialsToday: 0,
    nightActions: {},
    jailedId: null,
    chat: createChat(MAFIA_RETENTION),
    trialLog: [],
    deaths: [],
    winners: [],
    points: [],
    createdAt: input.now,
    lastActivityAt: input.now
  };
}

export function alivePlayers(state: MafiaState): MafiaPlayer[] {
  return Object.values(state.players).filter((player) => player.alive);
}

export function playerBySlot(state: MafiaState, slot: number): MafiaPlayer | undefined {
  return Object.values(state.players).find((player) => player.slot === slot);
}

/** The killing-or-converting family this player belongs to, if any. */
export function playerFamily(player: MafiaPlayer): FamilyId | null {
  return player.role !== null ? familyOf(player.role) : null;
}

/** Kept for readability at call sites that specifically mean the mafia. */
export function isMafia(player: MafiaPlayer): boolean {
  return playerFamily(player) === 'mafia';
}

/** Family members plus masons: the people who share a private channel. */
export function isLodgeMate(a: MafiaPlayer, b: MafiaPlayer): boolean {
  const familyA = playerFamily(a);
  if (familyA !== null) return familyA === playerFamily(b);
  const masonA = a.role === 'mason' || a.role === 'mason-leader';
  const masonB = b.role === 'mason' || b.role === 'mason-leader';
  return masonA && masonB;
}

/** The jail channel is per night, so yesterday's interrogation stays sealed. */
export function jailChannel(day: number): string {
  return `jail:${day}`;
}

/** The whisper channel between two players, whoever sends first. */
export function pmChannel(a: string, b: string): string {
  return `pm:${[a, b].sort().join(':')}`;
}

/** The two participant ids of a pm channel, or null for any other channel. */
export function pmParticipants(channel: string): [string, string] | null {
  if (!channel.startsWith('pm:')) return null;
  const parts = channel.slice(3).split(':');
  return parts.length === 2 ? [parts[0], parts[1]] : null;
}

/**
 * Who may read and write each channel. This is the whole anti-leak story for
 * the chat: the server evaluates these rules per recipient, the client never
 * receives a message it may not read.
 *
 *  - `day`    — the town square. Everyone reads; the living write in daylight.
 *  - `dead`   — the graveyard. Only the dead read and write, until game end.
 *  - `mafia`  — the family. Mafia members read always, write at night.
 *  - `jail:N` — night N's cell. The jailor and that night's prisoner.
 */
export function chatRules(): ChannelRules<MafiaState> {
  return {
    canRead(channel, memberId, state) {
      if (state.phase === 'ended') return true;
      const member = state.players[memberId];
      if (!member) return false;
      if (channel === 'day') return true;
      if (channel === 'dead') return !member.alive;
      // Family rooms — and the spy's ear pressed to the killing families' walls.
      if (channel === 'mafia' || channel === 'triad' || channel === 'cult') {
        if (playerFamily(member) === channel) return true;
        return member.role === 'spy' && channel !== 'cult';
      }
      if (channel === 'mason') return member.role === 'mason' || member.role === 'mason-leader';
      if (channel.startsWith('jail:')) {
        return member.role === 'jailor' || (channel === jailChannel(state.day) && state.jailedId === memberId);
      }
      const pm = pmParticipants(channel);
      if (pm) return pm.includes(memberId);
      return false;
    },
    canWrite(channel, memberId, state) {
      const member = state.players[memberId];
      if (!member || state.phase === 'ended' || state.phase === 'lobby') {
        // The lobby small talk happens in `day` before roles exist.
        return state.phase === 'lobby' && channel === 'day' && !!member;
      }
      if (channel === 'dead') return !member.alive;
      if (!member.alive) return false;
      // A stump has opinions and a vote, but no mouth.
      if (member.role === 'stump') return false;
      if (channel === 'day') {
        // The crier's anonymous voice carries through the night.
        if (state.phase === 'night') return member.role === 'crier';
        if (state.phase !== 'day') return false;
        // The blackmailer's gag: present, voting, silent.
        if (member.silencedDay === state.day) return false;
        // During a trial only the accused speaks; the town murmurs after.
        if (state.stage === 'defense') return state.trial?.accusedId === memberId;
        return true;
      }
      if (channel === 'mafia' || channel === 'triad' || channel === 'cult') {
        return state.phase === 'night' && playerFamily(member) === channel;
      }
      if (channel === 'mason') {
        return state.phase === 'night' && (member.role === 'mason' || member.role === 'mason-leader');
      }
      if (channel === 'jail:' + String(state.day)) {
        return (
          state.phase === 'night' &&
          (state.jailedId === memberId || (member.role === 'jailor' && state.jailedId !== null))
        );
      }
      // Whispers: daylight only, between two living players, and a gagged
      // mouth whispers no better than it talks.
      const pm = pmParticipants(channel);
      if (pm) {
        const other = state.players[pm[0] === memberId ? pm[1] : pm[0]];
        return (
          state.phase === 'day' &&
          pm.includes(memberId) &&
          member.silencedDay !== state.day &&
          !!other?.alive
        );
      }
      return false;
    }
  };
}

const BOT_NAMES = [
  'Dracula',
  'Link',
  'Tarzan',
  'Lara Croft',
  'Son Goku',
  'Pikachu',
  'Han Solo',
  'Kratos',
  'James Bond',
  'Saitama',
  'Voldemort',
  'Gandalf',
  'Legolas',
  'Mickey Mouse',
  'Wolverine',
  'Batman',
  'Yoda',
  'Homer Simpson',
  'Jon Snow',
  'Tony Soprano',
  'Garfield',
  'Shrek',
  'Barbie',
  'Mario'
] as const;

/**
 * What language the bots speak at this table.
 *
 * English by default, because a table is usually strangers and English is the
 * common floor. The one exception is a table with exactly **one** human on it: a
 * solo player against a house of bots is not a shared room, it is their room, so
 * the bots meet them in their language.
 *
 * Two or more people and it goes back to English — a bot cannot say one thing to
 * a French speaker and another to a German one in the same channel, and picking
 * one of their languages would leave the other out of the conversation entirely.
 *
 * `config.locale` is the explicit override for a host who knows better than this
 * heuristic; it wins whenever it is set to something other than the default.
 */
export function spokenLocale(state: MafiaState): Locale {
  const humans = Object.values(state.players).filter((player) => !player.isBot);
  if (humans.length === 1) {
    const only = humans[0]?.locale;
    if (only) return only;
  }
  return state.config.locale;
}

export function nextBotName(state: MafiaState): string {
  const taken = new Set(Object.values(state.players).map((player) => player.name));
  for (const name of BOT_NAMES) {
    if (!taken.has(name)) return name;
  }
  return `Villageois ${Object.keys(state.players).length + 1}`;
}

export function nextFreeSlot(state: MafiaState): number | null {
  const taken = new Set(Object.values(state.players).map((player) => player.slot));
  for (let slot = 1; slot <= state.config.maxPlayers; slot++) {
    if (!taken.has(slot)) return slot;
  }
  return null;
}

/**
 * Deals the roles. `rng` is injectable so tests replay the same deal; the
 * server passes a crypto-backed one.
 */
/** The role list this table's setup deals for `n` seats. */
export function rosterForSetup(state: MafiaState, n: number, rng: () => number): RoleId[] {
  // Older persisted tables predate the field; they deal the automatic roster.
  const choice = state.config.setup ?? { mode: 'auto' as const };
  if (choice.mode === 'chaos') return chaosSetup(n, rng);
  if (choice.mode === 'census') return censusSetup(n, rng);
  if (choice.mode === 'preset') {
    const preset = setupById(choice.presetId);
    if (preset) return rollSetup(fitSetup(preset.slots, n), rng);
  }
  if (choice.mode === 'custom' && choice.slots.length > 0) {
    return rollSetup(fitSetup(choice.slots, n), rng);
  }
  return rosterFor(n);
}

export function assignRoles(state: MafiaState, rng: () => number): void {
  const players = Object.values(state.players);
  const roster = rosterForSetup(state, players.length, rng);

  // Fisher–Yates on the roster; seats keep their numbers.
  for (let i = roster.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = roster[i];
    roster[i] = roster[j]!;
    roster[j] = tmp;
  }

  players.forEach((player, index) => {
    const role = roster[index] ?? 'citizen';
    player.role = role;
    player.charges = roleDef(role).charges ?? 0;
  });

  // The executioner needs someone to destroy: a town player, never himself.
  for (const player of players) {
    if (player.role === 'executioner') {
      const marks = players.filter((other) => other.role !== null && roleDef(other.role).faction === 'town');
      if (marks.length === 0) {
        player.role = 'jester';
      } else {
        player.obsessionId = marks[Math.floor(rng() * marks.length)]?.playerId ?? null;
      }
    }
  }
}
