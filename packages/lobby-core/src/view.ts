import {
  quickNeeded,
  quickPresent,
  tallyQuick,
  type LobbyGame,
  type QuickLobby,
  type QuickOptionSpec,
  type QuickPhase
} from './state.js';

/**
 * What a phone in a quick lobby is allowed to see.
 *
 * Everything, as it happens: there is no hidden information in a room deciding
 * what to play. The projection exists anyway, because the lobby state carries
 * bookkeeping (tokens, timestamps, per-member vote maps) that a screen has no use
 * for, and because the counts every screen wants are arithmetic the server should
 * do once rather than five phones doing it five ways.
 */

export interface QuickMemberView {
  id: string;
  name: string;
  connected: boolean;
  ready: boolean;
}

export interface QuickChoiceView {
  value: string;
  label: string;
  votes: number;
}

export interface QuickOptionView {
  key: string;
  label: string;
  hint?: string;
  /** The value that would be used if the game started now. */
  value: string;
  choices: QuickChoiceView[];
  /** What you voted for, or null if you have not. */
  yours: string | null;
}

export interface QuickLobbyView {
  code: string;
  game: LobbyGame;
  phase: QuickPhase;
  /** Your member id, or null when watching without a seat. */
  you: string | null;
  members: QuickMemberView[];
  minPlayers: number;
  maxPlayers: number;
  /** Yes votes among the people actually present. */
  ready: number;
  /** Yes votes needed to start. */
  needed: number;
  /** Server deadline once the room has decided; the screen renders the countdown. */
  startsAt: number | null;
  options: QuickOptionView[];
  /** The real game's join code, once it exists. */
  launch: { code: string } | null;
  fromGameCode: string | null;
}

export function toQuickView(
  lobby: QuickLobby,
  specs: QuickOptionSpec[],
  memberId: string | null,
  now: number
): QuickLobbyView {
  const settings = tallyQuick(lobby, specs);
  const present = quickPresent(lobby, now);
  const you = memberId !== null && memberId in lobby.members ? memberId : null;

  return {
    code: lobby.code,
    game: lobby.game,
    phase: lobby.phase,
    you,
    members: Object.values(lobby.members)
      .sort((left, right) => left.joinedAt - right.joinedAt)
      .map((member) => ({
        id: member.id,
        name: member.name,
        connected: member.connected,
        ready: member.ready
      })),
    minPlayers: lobby.minPlayers,
    maxPlayers: lobby.maxPlayers,
    ready: present.filter((member) => member.ready).length,
    needed: quickNeeded(lobby, now),
    startsAt: lobby.startsAt,
    options: specs.map((spec) => ({
      key: spec.key,
      label: spec.label,
      hint: spec.hint,
      value: settings[spec.key] ?? spec.fallback,
      choices: spec.choices.map((choice) => ({
        value: choice.value,
        label: choice.label,
        votes: Object.values(lobby.members).filter((member) => member.votes[spec.key] === choice.value).length
      })),
      yours: (you !== null ? lobby.members[you]?.votes[spec.key] : undefined) ?? null
    })),
    launch: lobby.launch,
    fromGameCode: lobby.fromGameCode
  };
}

/**
 * One open room, as the browse screen lists it.
 *
 * Deliberately the same shape for all three games. A player looking for something
 * to join is asking "what, who, how many, is there space" — the answers differ per
 * game only in the words, which is what `title` and `detail` carry.
 */
export interface LobbyCard {
  game: LobbyGame;
  code: string;
  /** What is being played: the quiz's name, the scenario, the setup. */
  title: string;
  /** A second line, when the game has one worth reading. */
  detail: string | null;
  /** Who opened it, or null for a hostless quick match. */
  host: string | null;
  players: number;
  /** Null when the game has no cap of its own. */
  maxPlayers: number | null;
  createdAt: number;
  /** True for a quick-match room: no host, and the table votes the start. */
  quick: boolean;
}
