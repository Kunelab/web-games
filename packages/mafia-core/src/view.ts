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
import { ACTION, ROLE } from './messages.js';
import { roleDef, type Faction, type RoleId } from './roles.js';
import type { SlotToken } from './setups.js';
import {
  chatRules,
  isLodgeMate,
  isMason,
  jailChannel,
  isKeeper,
  captiveOf,
  keeperHolding,
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
  /**
   * What wrote this bot's last line: a model name, or `'scripted'`.
   *
   * Null for a person, and for a bot that has not spoken yet.
   */
  botBrain: string | null;
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
   * What this ally has told the family they are doing tonight — in *my*
   * projection only, and null in everybody else's.
   *
   * The family could already see each other's names and a count of knives on a
   * house. What it could not see was who was holding any of them, or what the
   * half of the family that does not kill was doing at all: a Consort spends her
   * night deciding which town power to switch off, and until now the two people
   * she is conspiring with could not tell whether she had chosen, let alone
   * whom. Three people planning in the dark cannot plan if each can only see
   * their own hands.
   *
   * Present for every living family ally who has a night power, decided or not:
   * `targetSlot: null` is "has not said yet", which is the thing you most need
   * to know while the clock runs. Null for everybody else — the viewer's own row
   * included, because their own orders are already on their own screen.
   *
   * Night only. The orders are cleared at dawn, so a day projection would be a
   * column of "has not decided" beside every ally.
   */
  allyIntent: { action: Msg; targetSlot: number | null; secondSlot: number | null } | null;
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
  /**
   * The second house of a two-target order, once it is named.
   *
   * Witch and Bus Driver only. It rides back to the phone so a re-render, a
   * reconnection or a second device shows the order as it actually stands rather
   * than resetting the picker to step one and losing half of it.
   */
  actionSecondTargetSlot: number | null;
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
   * And when it began, which is how anything tells a line from a memory.
   *
   * The deadline alone says how long is left and nothing about how long this
   * has been going on, so every reader of the transcript treated a greeting
   * from four days ago exactly like one said a moment ago. From a real game, a
   * bot answered "Hi Max" on three separate days, the last of them while
   * standing on the gallows, to a player who had been dead since day three.
   *
   * As public as the deadline it sits beside: every phone already draws a
   * countdown from one end of this interval, and knowing where the other end is
   * tells nobody anything they could not time with a watch.
   */
  phaseStartedAt: number | null;
  /** When accusations open, so a phone can grey the buttons until then. */
  voteOpensAt: number | null;
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
  /**
   * Who accused whom, in order — the afternoon's paper trail.
   *
   * Names rather than ids, because it is rendered next to the chat and read the
   * same way. Trimmed to the tail: a screen shows the last stretch of an
   * argument, and the whole history of a nine-day game is not something anybody
   * scrolls back through on a phone.
   */
  voteLog: {
    day: number;
    voter: string;
    voterSlot: number;
    target: string | null;
    targetSlot: number | null;
    skip: boolean;
  }[];
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
 * When the phase now running started, worked back from its own deadline.
 *
 * Stored nowhere, because it does not need to be: the deadline is on the state
 * and the length of each kind of phase is on the config, so the beginning is
 * arithmetic. Null while the game is paused, exactly as `phaseEndsAt` is —
 * during a pause there is no interval to be inside.
 */
function phaseStartedAt(state: MafiaState): number | null {
  if (state.phaseEndsAt === null) return null;
  // Recorded where the phase opened, when this table is new enough to have done so. See `MafiaState.phaseStartedAt`.
  if (typeof state.phaseStartedAt === 'number') return state.phaseStartedAt;
  const config = state.config;
  const length =
    state.phase === 'night'
      ? config.nightMs
      : state.phase === 'ended'
        ? config.aftermathMs
        : state.stage === 'defense'
          ? config.defenseMs
          : state.stage === 'judgement'
            ? config.judgementMs
            : state.day <= 1
              ? (config.firstDayMs ?? config.dayMs)
              : config.dayMs;
  return state.phaseEndsAt - length;
}

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
        /**
         * Only the hands that hold the knife.
         *
         * The badge says "aiming tonight's knife at this house" and the loop
         * counted every family night action, so a Consigliere reading a file, a
         * Framer planting evidence and a Janitor prepping a clean each added
         * one — three marks on three different houses, not one of them a vote
         * for tonight's victim.
         */
        if (!actor?.alive || !actor.role || playerFamily(actor) !== family) continue;
        if (roleDef(actor.role).nightAction !== 'kill' || !action.targetId) continue;
        aim.set(action.targetId, (aim.get(action.targetId) ?? 0) + 1);
      }
    }

    /**
     * Every ally's order, by the hand holding it.
     *
     * Deliberately every night power and not only the knife, which is what
     * `aim` above is for. The knife is one decision the family takes together;
     * the rest of the night is four people spending their own powers, and those
     * are exactly the ones nobody could see. A Blackmailer gagging the seat the
     * Consort was about to block is two nights wasted, and neither of them could
     * have known.
     *
     * The family, not the lodge: `isLodgeMate` also answers true for two masons,
     * who are on the same side without being a family with a shared night, and
     * whose powers are nobody's business but their own.
     */
    const intent = new Map<string, { action: Msg; targetSlot: number | null; secondSlot: number | null }>();

    if (family !== null && state.phase === 'night') {
      for (const other of players) {
        if (other.playerId === viewerId || !other.alive || !other.role) continue;
        if (playerFamily(other) !== family) continue;

        const power = roleDef(other.role).nightAction;
        if (!power) continue;

        const chosen = state.nightActions[other.playerId];
        const slotOf = (id: string | null | undefined): number | null =>
          id ? (state.players[id]?.slot ?? null) : null;

        /**
         * A keeper's row says who is in its cell, not what it is aiming at.
         *
         * The cell is filled in daylight, so it is not in `nightActions` and this
         * row showed the Ravisseur as having decided nothing all night — while
         * the single most useful fact in the room was that it had somebody
         * locked up. It matters to every other hand: a captive is blocked and
         * sheltered, so a knife sent to that house spends the evening killing
         * nobody and a Consort sent there roleblocks somebody already in a
         * cellar.
         *
         * On the row rather than in the chat on purpose. The family reads the
         * roster while it plans, the fact holds all night whether or not
         * anybody was listening when it was said, and it does not cost the room
         * one of its lines.
         */
        const held = captiveOf(state, other.playerId);
        if (held !== null) {
          intent.set(other.playerId, {
            action: ACTION(power),
            targetSlot: slotOf(held),
            secondSlot: null
          });
          continue;
        }

        intent.set(other.playerId, {
          action: ACTION(power),
          targetSlot: slotOf(chosen?.targetId),
          secondSlot: slotOf(chosen?.secondTargetId)
        });
      }
    }

    return {
      aim,
      intent,
      roleOf: (other: MafiaPlayer): Msg | null =>
        other.playerId !== viewerId && other.role && isLodgeMate(self, other) ? ROLE.name(other.role) : null
    };
  }

  const side = viewer.kind === 'player' ? sideOf(viewer.playerId) : null;
  const familyAim = side?.aim ?? new Map<string, number>();
  const allyRoleOf = (player: MafiaPlayer): Msg | null => side?.roleOf(player) ?? null;
  const allyIntentOf = (player: MafiaPlayer) => side?.intent.get(player.playerId) ?? null;

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
    /**
     * A seat that has taken the sash out is public, by definition.
     *
     * Revealing is an engine action and the town announces it by name, so
     * naming the role on the roster leaks nothing the chat has not already
     * said out loud. It was reduced to a ribbon glyph, which left the one
     * identity in the game that is beyond doubt as the only one a player
     * could not read off the list — and the glyph was the Mayor's icon, so it
     * was wrong on every revealed Marshall.
     */
    const sashOut = player.alive && player.revealed && player.role !== null;
    const showRole = sashOut || (identified && (ended || reveal === 'role'));
    const showFaction = sashOut || (identified && (ended || reveal === 'role' || reveal === 'faction'));
    const votedId = state.votes[player.playerId];
    return {
      slot: player.slot,
      name: player.name,
      alive: player.alive,
      connected: player.connected,
      isBot: player.isBot,
      botBrain: player.isBot ? (player.botBrain ?? null) : null,
      onTrial: state.trial?.accusedId === player.playerId,
      revealedMayor: player.revealed,
      votedSlot: votedId && votedId !== SKIP_VOTE ? (state.players[votedId]?.slot ?? null) : null,
      votesAgainst: votesAgainst.get(player.playerId) ?? 0,
      votedSkip: votedId === SKIP_VOTE,
      allyRole: allyRoleOf(player),
      familyVotes: familyAim.get(player.playerId) ?? 0,
      allyIntent: allyIntentOf(player),
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
      /**
       * The distinct channels this table has actually used. One pass.
       *
       * Two separate full walks of the transcript used to start here, one for
       * the whisper tabs and one for the end-of-game reveal below, and this
       * whole function runs once per recipient per broadcast. On a table of
       * twenty-four with nine hundred messages in the log that was forty-odd
       * thousand iterations a push, plus a `pmParticipants` parse per message
       * where a parse per *distinct* channel is all anybody wanted: there are
       * a couple of dozen channel names in the set and hundreds of lines.
       *
       * Insertion order is first-mention order, which is the order the whisper
       * tabs were already in.
       */
      const used = new Set<string>();
      for (const message of state.chat.messages) used.add(message.channel);

      // Whisper threads this player is part of surface as their own tabs.
      const pmIds = [...used].filter((channel) => pmParticipants(channel)?.includes(self.playerId));
      /**
       * Tonight's cell, from whichever end of it this seat is on.
       *
       * One id rather than every keeper's, because a seat is in at most one
       * cell and `canRead` would refuse the others anyway — offering them would
       * only tell the reader how many cells exist. A keeper sees the room it
       * keeps; a captive sees the room it is in; everybody else has no cell tab
       * at all.
       */
      const ownCellKeeper = isKeeper(self) ? self.playerId : keeperHolding(state, self.playerId);
      const cellIds = ownCellKeeper ? [jailChannel(state.day, ownCellKeeper)] : [];
      const channelIds = ['day', 'dead', 'mafia', 'triad', 'cult', 'mason', ...cellIds, ...pmIds];

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
      const channels = channelIds
        .filter((id) => id === 'day' || !ended || used.has(id))
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
      const submittedSecondSlot = submitted?.secondTargetId
        ? (state.players[submitted.secondTargetId]?.slot ?? null)
        : null;
      const voteId = state.votes[self.playerId];
      const obsession = self.obsessionId ? state.players[self.obsessionId] : null;

      me = {
        playerId: self.playerId,
        slot: self.slot,
        name: self.name,
        alive: self.alive,
        role:
          def && self.role
            ? {
                id: self.role,
                name: ROLE.name(self.role),
                faction: def.faction,
                description: ROLE.description(self.role)
              }
            : null,
        charges: def?.charges !== undefined ? self.charges : null,
        teammates: (() => {
          // Family members know each other; so do the masons of the lodge.
          const mates = players.filter((other) => other.playerId !== self.playerId && isLodgeMate(self, other));
          if (mates.length === 0 && playerFamily(self) === null && !isMason(self)) return null;
          return mates.map((other) => ({ slot: other.slot, name: other.name, roleName: ROLE.name(other.role!) }));
        })(),
        obsessionSlot: obsession?.slot ?? null,
        jailed: keeperHolding(state, self.playerId) !== null && state.phase === 'night',
        /**
         * The seat this keeper has picked, whichever cell it keeps.
         *
         * Gated on the Jailor alone before, so the Ravisseur and the
         * Interrogateur had no way to see or clear their own pick: the screen
         * showed them nothing and the row offered no way to take it back.
         */
        jailTargetSlot: (() => {
          if (!isKeeper(self)) return null;
          const heldId = captiveOf(state, self.playerId);
          return heldId ? (state.players[heldId]?.slot ?? null) : null;
        })(),
        action: legalNightAction(state, self.playerId),
        actionTargetSlot: submittedSlot,
        actionSecondTargetSlot: submittedSecondSlot,
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

  const chat =
    viewer.kind === 'player'
      ? chatVisibleTo(state, viewer.playerId)
      : state.chat.messages.filter((message) => message.channel === 'day' || ended);

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
    phaseStartedAt: phaseStartedAt(state),
    voteOpensAt: state.voteOpensAt ?? null,
    presence: mafiaPresenceView(state, now, viewer.kind === 'player' ? viewer.playerId : null),
    maxPlayers: state.config.maxPlayers,
    minPlayers: state.config.minPlayers,
    players: publicPlayers,
    roleList: tableRoleList(state, players.length),
    /**
     * The paper trail, resolved to names and trimmed to what a panel shows.
     *
     * Older tables predate the field, hence the coalesce: a game saved before
     * this existed reloads with an empty trail rather than crashing the
     * projection.
     */
    voteLog: (state.voteLog ?? []).slice(-80).map((note) => ({
      day: note.day,
      voterSlot: note.voterSlot,
      voter: players.find((player) => player.slot === note.voterSlot)?.name ?? String(note.voterSlot),
      targetSlot: note.targetSlot,
      target: players.find((player) => player.slot === note.targetSlot)?.name ?? null,
      skip: note.skip
    })),
    skipVotes: votesAgainst.get(SKIP_VOTE) ?? 0,
    voteThreshold: voteThreshold(state),
    trial: accused ? { slot: accused.slot, name: accused.name } : null,
    me,
    chat,
    results
  };
}
