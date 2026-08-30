import type { ChatMessage } from 'chat-core';
import { msg, type Msg } from 'i18n';

import {
  chatVisibleTo,
  legalNightAction,
  mafiaPresenceView,
  voteThreshold,
  type LegalAction,
  type MafiaPresenceView
} from './engine.js';
import { ROLE } from './messages.js';
import { roleDef, type Faction, type RoleId } from './roles.js';
import type { SlotToken } from './setups.js';
import {
  chatRules,
  isLodgeMate,
  isMason,
  jailChannel,
  playerFamily,
  pmParticipants,
  pointsFor,
  SKIP_VOTE,
  tableRoleList,
  voteWeight,
  type DayStage,
  type IntelEntry,
  type MafiaPhase,
  type MafiaPlayer,
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
  /** True while this player is voting to hang nobody today. */
  votedSkip: boolean;
  /**
   * This player is on my side, and this is what they are — in *my* projection
   * only, and null in everybody else's.
   *
   * The family already knew each other; the trouble was that a phone had to go
   * and open a panel to find out which of the twenty-four names they were. An
   * ally is something you should be able to see while looking at the roster,
   * on the row you are about to not vote for.
   */
  allyRole: Msg | null;
  /**
   * How many of my family have aimed tonight's knife at this house.
   *
   * Zero for everyone who is not in a killing family, because it is the
   * family's own count and nobody else's business. It exists for the same
   * reason the day's vote tally does: three people choosing a victim in the
   * dark cannot agree on one if none of them can see the other two.
   */
  familyVotes: number;
  /**
   * Known to all only after death or at the end, and only as far as the table's
   * `revealOnDeath` policy allows. Under `faction` the camp is named and these
   * two stay null until the game ends; under `none` all three do.
   *
   * `roleName` is a *key*, not a word: the screen resolves it in its reader's
   * language. It used to be the French `RoleDef.name`, which is how an English
   * table was told that the body on the square had been "le Parrain".
   */
  role: RoleId | null;
  roleName: Msg | null;
  /** The camp a dead player belonged to, for the colour beside their name. */
  faction: Faction | null;
  death: { day: number; phase: 'day' | 'night'; cause: Msg } | null;
  /**
   * What this player left on their body, once there is a body.
   *
   * Public exactly when the death notice already read it out — so a will that a
   * cleaner erased stays erased here too. Carried on the roster rather than only
   * in the chat log because a will is a *document*: it gets re-read all game, and
   * hunting for it in a scrolled-away announcement is not reading.
   */
  lastWill: string | null;
}

export interface MafiaViewMe {
  playerId: string;
  slot: number;
  name: string;
  alive: boolean;
  /**
   * Your own role — as an id and two keys, never as prose.
   *
   * The screen renders `mafia.role.<id>.name` and `.desc` from its own reader's
   * catalogue, which is why `name` and `description` are `Msg` here: a French
   * host and an English guest at the same table each read their own card.
   */
  role: { id: RoleId; name: Msg; faction: Faction; description: Msg } | null;
  charges: number | null;
  /** Mafia only: the rest of the family. Null for everyone else. */
  teammates: { slot: number; name: string; roleName: Msg }[] | null;
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
  /** My accusation is "hang nobody today". Mutually exclusive with the above. */
  votedSkip: boolean;
  ballot: 'guilty' | 'innocent' | null;
  lastWill: string;
  notifications: Msg[];
  /** Own structured night results; same privacy as the notifications. */
  intel: IntelEntry[];
  /**
   * Channels this member can currently read, with write permission.
   *
   * `kind` and `with` rather than a rendered label: the square is called
   * "Place du village" or "Village Square" depending on who is looking, and a
   * whisper tab is somebody's name, which is nobody's to translate.
   */
  channels: { id: string; kind: MafiaChannelKind; with: string | null; canWrite: boolean }[];
  pointsSoFar: number;
}

/** The sort of room a chat tab is; the screen turns this into a word. */
export type MafiaChannelKind = 'day' | 'mafia' | 'triad' | 'cult' | 'mason' | 'dead' | 'jail' | 'pm';

export interface MafiaResultRow {
  slot: number;
  name: string;
  roleName: Msg;
  isBot: boolean;
  winner: boolean;
  winReason: Msg | null;
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
  /**
   * The role list the table is playing, sorted town-first — the thing every
   * deduction in this game is measured against.
   *
   * Slots, not the deal: "Random Town" stays "Random Town" because what it rolled
   * is the secret. See `tableRoleList`.
   */
  roleList: SlotToken[];
  /** Weighted "hang nobody" votes, and the majority that would carry them. */
  skipVotes: number;
  voteThreshold: number;
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

/**
 * What sort of room a channel id names.
 *
 * Ids are structural (`jail-3`, `pm:a:b`), so this maps back to the handful of
 * kinds a screen has a word for. The words themselves live in the catalogues:
 * this used to be a table of French labels shipped to every reader.
 */
const CHANNEL_KINDS: Record<string, MafiaChannelKind> = {
  day: 'day',
  mafia: 'mafia',
  triad: 'triad',
  cult: 'cult',
  mason: 'mason',
  dead: 'dead'
};

/**
 * What the Spy sees instead of a face.
 *
 * Not a key, and not an oversight: `authorName` is the byline on a chat line,
 * the same field a player's own nickname travels in, and the log has no notion
 * of a translatable author. A symbol says "somebody, and you do not get to know
 * who" in every language, which is exactly the rule being enforced.
 */
const MUFFLED = '· · ·';

export function toMafiaView(state: MafiaState, viewer: MafiaViewer, now = Date.now()): MafiaView {
  const ended = state.phase === 'ended';
  const players = Object.values(state.players).sort((a, b) => a.slot - b.slot);

  const votesAgainst = new Map<string, number>();
  for (const [voterId, targetId] of Object.entries(state.votes)) {
    const voter = state.players[voterId];
    if (!voter?.alive) continue;
    votesAgainst.set(targetId, (votesAgainst.get(targetId) ?? 0) + voteWeight(voter));
  }

  /** Who is on the viewer's side, and where the family's knife is pointing. */
  function sideOf(viewerId: string) {
    const self = state.players[viewerId];
    if (!self?.role) return null;
    const family = playerFamily(self);
    const aim = new Map<string, number>();

    if (family !== null) {
      for (const [actorId, action] of Object.entries(state.nightActions)) {
        const actor = state.players[actorId];
        if (!actor?.alive || playerFamily(actor) !== family || !action.targetId) continue;
        aim.set(action.targetId, (aim.get(action.targetId) ?? 0) + 1);
      }
    }

    return {
      aim,
      roleOf: (other: MafiaPlayer): Msg | null =>
        other.playerId !== viewerId && other.role && isLodgeMate(self, other) ? ROLE.name(other.role) : null
    };
  }

  const side = viewer.kind === 'player' ? sideOf(viewer.playerId) : null;
  const familyAim = side?.aim ?? new Map<string, number>();
  const allyRoleOf = (player: MafiaPlayer): Msg | null => side?.roleOf(player) ?? null;

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
      votedSlot: votedId && votedId !== SKIP_VOTE ? (state.players[votedId]?.slot ?? null) : null,
      votesAgainst: votesAgainst.get(player.playerId) ?? 0,
      votedSkip: votedId === SKIP_VOTE,
      allyRole: allyRoleOf(player),
      familyVotes: familyAim.get(player.playerId) ?? 0,
      role: showRole ? player.role : null,
      roleName: showRole && player.role ? ROLE.name(player.role) : null,
      faction: showFaction && player.role ? roleDef(player.role).faction : null,
      death: player.death,
      // A cleaned body says nothing, will included: that is what the power buys.
      lastWill: identified && player.lastWill ? player.lastWill : null
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

      /**
       * At the end every door opens — but only onto rooms that were ever used.
       *
       * `canRead` answers `true` for everything once the game is over, which is
       * right: the masks come off and the transcript is the whole story. It was
       * too literal, though. A table dealt without a Triad still grew a Triad tab
       * at the final whistle, and an empty room is not a reveal — it is a hint
       * about the setup, offered to a screen that has no business making the
       * point. A room that never held a word does not exist at all.
       *
       * The square is exempt: it always carries the announcements, and it is the
       * one tab a player must never be left without.
       */
      const spoken = new Set(state.chat.messages.map((message) => message.channel));
      const channels = channelIds
        .filter((id) => id === 'day' || !ended || spoken.has(id))
        .filter((id) => rules.canRead(id, self.playerId, state))
        .map((id) => {
          const pm = pmParticipants(id);
          const other = pm ? state.players[pm[0] === self.playerId ? pm[1] : pm[0]] : null;
          return {
            id,
            kind: pm ? ('pm' as const) : (CHANNEL_KINDS[id] ?? ('jail' as const)),
            with: other?.name ?? null,
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
        role:
          def && self.role
            ? { id: self.role, name: ROLE.name(self.role), faction: def.faction, description: ROLE.description(self.role) }
            : null,
        charges: def?.charges !== undefined ? self.charges : null,
        teammates: (() => {
          // Family members know each other; so do the masons of the lodge.
          const mates = players.filter((other) => other.playerId !== self.playerId && isLodgeMate(self, other));
          if (mates.length === 0 && playerFamily(self) === null && !isMason(self)) return null;
          return mates.map((other) => ({ slot: other.slot, name: other.name, roleName: ROLE.name(other.role!) }));
        })(),
        obsessionSlot: obsession?.slot ?? null,
        jailed: state.jailedId === self.playerId && state.phase === 'night',
        jailTargetSlot:
          self.role === 'jailor' && state.jailedId ? (state.players[state.jailedId]?.slot ?? null) : null,
        action: legalNightAction(state, self.playerId),
        actionTargetSlot: submittedSlot,
        voteTargetSlot: voteId && voteId !== SKIP_VOTE ? (state.players[voteId]?.slot ?? null) : null,
        votedSkip: voteId === SKIP_VOTE,
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
          ? { ...message, authorId: null, authorName: MUFFLED }
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
          roleName: player.role ? ROLE.name(player.role) : msg('mafia.slot.any'),
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
    roleList: tableRoleList(state, players.length),
    skipVotes: votesAgainst.get(SKIP_VOTE) ?? 0,
    voteThreshold: voteThreshold(state),
    trial: accused ? { slot: accused.slot, name: accused.name } : null,
    me,
    chat,
    results
  };
}
