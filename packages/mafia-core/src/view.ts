import type { ChatMessage } from 'chat-core';
import type { Msg } from 'i18n';

import {
  chatVisibleTo,
  legalNightAction,
  mafiaPresenceView,
  type LegalAction,
  type MafiaPresenceView
} from './engine.js';
import { roleDef, type Faction, type RoleId } from './roles.js';
import {
  chatRules,
  isLodgeMate,
  isMason,
  jailChannel,
  playerFamily,
  pmParticipants,
  pointsFor,
  voteWeight,
  type DayStage,
  type IntelEntry,
  type MafiaPhase,
  type MafiaState
} from './state.js';

/**
 * The only shape a client ever receives. Built per recipient, on the server,
 * from the full state — this file is the entire anti-leak contract:
 *
 *  - a role appears in `players[].role` only once its owner is dead (or the
 *    game over);
 *  - `me` carries the recipient's own secrets and nobody else's;
 *  - `teammates` exists for mafia members only;
 *  - the chat is filtered through the channel rules before it leaves;
 *  - every field exists for every recipient (null when not applicable), so
 *    payload *structure* never betrays a role.
 */

export interface MafiaPublicPlayer {
  slot: number;
  name: string;
  alive: boolean;
  connected: boolean;
  isBot: boolean;
  onTrial: boolean;
  /** Mayor with the sash out; public by definition. */
  revealedMayor: boolean;
  /** Public accusation this player is currently casting, as a slot. */
  votedSlot: number | null;
  /** Weighted votes currently against this player. */
  votesAgainst: number;
  /**
   * Known to all only after death or at the end, and only as far as the table's
   * `revealOnDeath` policy allows. Under `faction` the camp is named and these
   * two stay null until the game ends; under `none` all three do.
   */
  role: RoleId | null;
  roleName: string | null;
  /** The camp a dead player belonged to, for the colour beside their name. */
  faction: Faction | null;
  death: { day: number; phase: 'day' | 'night'; cause: Msg } | null;
}

export interface MafiaViewMe {
  playerId: string;
  slot: number;
  name: string;
  alive: boolean;
  role: { id: RoleId; name: string; faction: Faction; description: string } | null;
  charges: number | null;
  /** Mafia only: the rest of the family. Null for everyone else. */
  teammates: { slot: number; name: string; roleName: string }[] | null;
  /** Executioner only: the slot to get lynched. */
  obsessionSlot: number | null;
  /** In a cell tonight. */
  jailed: boolean;
  /** Jailor only: slot currently marked for tonight's cell. */
  jailTargetSlot: number | null;
  /** Tonight's available power, with legal targets, or null. */
  action: LegalAction | null;
  /** What I currently submitted tonight, as a slot. */
  actionTargetSlot: number | null;
  voteTargetSlot: number | null;
  ballot: 'guilty' | 'innocent' | null;
  lastWill: string;
  notifications: string[];
  /** Own structured night results; same privacy as the notifications. */
  intel: IntelEntry[];
  /** Channels this member can currently read, with write permission. */
  channels: { id: string; label: string; canWrite: boolean }[];
  pointsSoFar: number;
}

export interface MafiaResultRow {
  slot: number;
  name: string;
  roleName: string;
  isBot: boolean;
  winner: boolean;
  winReason: string | null;
  points: number;
}

export interface MafiaView {
  code: string;
  phase: MafiaPhase;
  day: number;
  stage: DayStage | null;
  /**
   * The running phase's deadline, or null when no clock is running.
   *
   * Null during a pause, which is what stops every phone counting down a night
   * that is not passing. What is left of the phase is held server-side and comes
   * back untouched when play resumes — see `presence`.
   */
  phaseEndsAt: number | null;
  /**
   * Who the table is waiting for, and any vote to carry on without them.
   *
   * Sent to every recipient including the television, because a pause is the one
   * piece of game state that is not secret from anybody: the room cannot resolve
   * it without being told what it is.
   */
  presence: MafiaPresenceView;
  maxPlayers: number;
  minPlayers: number;
  players: MafiaPublicPlayer[];
  trial: { slot: number; name: string } | null;
  me: MafiaViewMe | null;
  chat: ChatMessage[];
  results: MafiaResultRow[] | null;
}

/**
 * Who is being projected for.
 *
 * `host` and `spectator` receive the identical, strictly-public projection: no
 * `me`, the day channel only, and nothing about a living player that the square
 * does not already know. They are two names for the same thing because they are
 * two ways of arriving — the creator's own console, and a television in the room
 * that claimed the table by its join code. Keeping them distinct in the type
 * costs nothing and makes the intent legible at the call site.
 */
export type MafiaViewer = { kind: 'player'; playerId: string } | { kind: 'host' } | { kind: 'spectator' };

const CHANNEL_LABELS: Record<string, string> = {
  day: 'Place du village',
  mafia: 'La Famille',
  triad: 'La Triade',
  cult: 'La Secte',
  mason: 'La Loge',
  dead: 'Cimetière'
};

export function toMafiaView(state: MafiaState, viewer: MafiaViewer, now = Date.now()): MafiaView {
  const ended = state.phase === 'ended';
  const players = Object.values(state.players).sort((a, b) => a.slot - b.slot);

  const votesAgainst = new Map<string, number>();
  for (const [voterId, targetId] of Object.entries(state.votes)) {
    const voter = state.players[voterId];
    if (!voter?.alive) continue;
    votesAgainst.set(targetId, (votesAgainst.get(targetId) ?? 0) + voteWeight(voter));
  }

  /**
   * What the body says, per the table's policy.
   *
   * The end of the game overrides everything — that is the moment the masks come
   * off. Before it, a cleaned corpse says nothing whatever the policy (the power
   * was paid for), and what an identified corpse says is the setting's business:
   * the whole role, the camp alone, or nothing at all.
   *
   * Always read from `player.role`, never `disguiseRole`: a borrowed face fools
   * examiners, not the undertaker. A role that was genuinely *changed* — audited,
   * converted, remembered, initiated — reveals what it became, which is the point.
   */
  const reveal = state.config.revealOnDeath ?? 'role';
  const publicPlayers: MafiaPublicPlayer[] = players.map((player) => {
    const cleaned = !ended && state.deaths.some((death) => death.playerId === player.playerId && death.hidden);
    const identified = ended || (!player.alive && !cleaned);
    const showRole = identified && (ended || reveal === 'role');
    const showFaction = identified && (ended || reveal === 'role' || reveal === 'faction');
    const votedId = state.votes[player.playerId];
    return {
      slot: player.slot,
      name: player.name,
      alive: player.alive,
      connected: player.connected,
      isBot: player.isBot,
      onTrial: state.trial?.accusedId === player.playerId,
      revealedMayor: player.revealed,
      votedSlot: votedId ? (state.players[votedId]?.slot ?? null) : null,
      votesAgainst: votesAgainst.get(player.playerId) ?? 0,
      role: showRole ? player.role : null,
      roleName: showRole && player.role ? roleDef(player.role).name : null,
      faction: showFaction && player.role ? roleDef(player.role).faction : null,
      death: player.death
    };
  });

  const accused = state.trial ? state.players[state.trial.accusedId] : null;

  let me: MafiaViewMe | null = null;
  if (viewer.kind === 'player') {
    const self = state.players[viewer.playerId];
    if (self) {
      const def = self.role ? roleDef(self.role) : null;
      const rules = chatRules();
      // Whisper threads this player is part of surface as their own tabs.
      const pmIds = [
        ...new Set(
          state.chat.messages
            .map((message) => message.channel)
            .filter((channel) => pmParticipants(channel)?.includes(self.playerId))
        )
      ];
      const channelIds = ['day', 'dead', 'mafia', 'triad', 'cult', 'mason', jailChannel(state.day), ...pmIds];
      const channels = channelIds
        .filter((id) => rules.canRead(id, self.playerId, state))
        .map((id) => {
          const pm = pmParticipants(id);
          const other = pm ? state.players[pm[0] === self.playerId ? pm[1] : pm[0]] : null;
          return {
            id,
            label: other ? `🤫 ${other.name}` : (CHANNEL_LABELS[id] ?? 'Cellule'),
            canWrite: rules.canWrite(id, self.playerId, state)
          };
        });

      const submitted = state.nightActions[self.playerId];
      const submittedSlot = submitted?.targetId ? (state.players[submitted.targetId]?.slot ?? null) : null;
      const voteId = state.votes[self.playerId];
      const obsession = self.obsessionId ? state.players[self.obsessionId] : null;

      me = {
        playerId: self.playerId,
        slot: self.slot,
        name: self.name,
        alive: self.alive,
        role: def && self.role ? { id: self.role, name: def.name, faction: def.faction, description: def.description } : null,
        charges: def?.charges !== undefined ? self.charges : null,
        teammates: (() => {
          // Family members know each other; so do the masons of the lodge.
          const mates = players.filter((other) => other.playerId !== self.playerId && isLodgeMate(self, other));
          if (mates.length === 0 && playerFamily(self) === null && !isMason(self)) return null;
          return mates.map((other) => ({ slot: other.slot, name: other.name, roleName: roleDef(other.role!).name }));
        })(),
        obsessionSlot: obsession?.slot ?? null,
        jailed: state.jailedId === self.playerId && state.phase === 'night',
        jailTargetSlot:
          self.role === 'jailor' && state.jailedId ? (state.players[state.jailedId]?.slot ?? null) : null,
        action: legalNightAction(state, self.playerId),
        actionTargetSlot: submittedSlot,
        voteTargetSlot: voteId ? (state.players[voteId]?.slot ?? null) : null,
        ballot: state.trial?.ballots[self.playerId] ?? null,
        lastWill: self.lastWill,
        notifications: self.notifications,
        intel: self.intel,
        channels,
        pointsSoFar: pointsFor(state, self.playerId)
      };
    }
  }

  let chat =
    viewer.kind === 'player'
      ? chatVisibleTo(state, viewer.playerId)
      : state.chat.messages.filter((message) => message.channel === 'day' || ended);

  // The spy hears the families' words but never sees their faces.
  if (viewer.kind === 'player' && !ended) {
    const self = state.players[viewer.playerId];
    if (self?.role === 'spy') {
      chat = chat.map((message) =>
        (message.channel === 'mafia' || message.channel === 'triad') && message.authorId
          ? { ...message, authorId: null, authorName: 'Voix étouffée' }
          : message
      );
    }
  }

  const results: MafiaResultRow[] | null = ended
    ? players.map((player) => {
        const win = state.winners.find((entry) => entry.playerId === player.playerId);
        return {
          slot: player.slot,
          name: player.name,
          roleName: player.role ? roleDef(player.role).name : '?',
          isBot: player.isBot,
          winner: !!win,
          winReason: win?.reason ?? null,
          points: pointsFor(state, player.playerId)
        };
      })
    : null;

  return {
    code: state.code,
    phase: state.phase,
    day: state.day,
    stage: state.stage,
    phaseEndsAt: state.phaseEndsAt,
    presence: mafiaPresenceView(state, now, viewer.kind === 'player' ? viewer.playerId : null),
    maxPlayers: state.config.maxPlayers,
    minPlayers: state.config.minPlayers,
    players: publicPlayers,
    trial: accused ? { slot: accused.slot, name: accused.name } : null,
    me,
    chat,
    results
  };
}
