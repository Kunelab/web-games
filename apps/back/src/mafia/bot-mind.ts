import {
  agendaOf,
  bindPersonalities,
  chatRules,
  contradicted,
  DEFAULT_PROFILE,
  feelPressure,
  isLodgeMate,
  makeBrain,
  makePersonality,
  stanceOf,
  toPublicInfo,
  type Agenda,
  type Brain,
  type Claim,
  type ClaimKind,
  type MafiaState,
  type PublicInfo,
  type RoleId,
  type Stance,
  type VoteRecord
} from 'mafia-core';

/**
 * Who may hear what, asked once. The rules are pure and the chat asks the same
 * object on every line it routes.
 */
const RULES = chatRules();

/**
 * What the bots at one table remember, and how they feel about it.
 *
 * The engine is stateless about opinion: it knows who voted for whom, not who
 * *said* what, because speech is chat and chat is prose. So the driver keeps a
 * structured ledger alongside it — every claim its bots make, in the same shape
 * the headless bench uses — and from that ledger plus authoritative state it can
 * build the exact `PublicInfo` the simulated seats reason over.
 *
 * That shared shape is the whole point of this file. It means a live LLM bot and
 * a benched scripted one read the same board, carry the same desperation meter,
 * and reach for the same masks. Without it we would have two social models and
 * only one of them measured.
 *
 * Memory is per table and lives only as long as the table does. Losing it to a
 * restart costs the bots their sense of the conversation, which is a real but
 * cheap loss: the board itself is persisted by the manager, and a bot that has
 * forgotten who it was arguing with behaves like a bot that just sat down.
 */

/** One bot's private continuity between rounds. */
export interface BotMind {
  brain: Brain;
  agenda: Agenda;
  /** Rolling stance, recomputed each dawn from the meter. */
  stance: Stance;
  /** Speech budget for the round, so a think-loop cannot monologue. */
  saidThisRound: number;
  /**
   * The face this seat has decided to wear if it ever has to, chosen once.
   *
   * A liar's story has to be the same story in the cell, on the stand and in
   * the will, so the mask is pinned the first time anything asks for it, and
   * only a role the seat actually claims in public can replace it.
   */
  mask: RoleId | null;
  /** What this seat has written down about the others, day by day. Append-only. */
  notes: WillNote[];
  /**
   * The day this seat opened its defence with "I am muted." and must now keep
   * to it: a muted person does not say a second thing. See `defenceLine`.
   */
  mutedBluffDay?: number;
}

/** One line of a seat's own journal, written into its will as the days go. */
export interface WillNote {
  day: number;
  slot: number;
  /** `liar`: caught out by the record. `evil`: voted on conviction. `wrong`: the corpse said otherwise. */
  kind: 'liar' | 'evil' | 'wrong';
}

interface TableMemory {
  minds: Map<string, BotMind>;
  claims: Claim[];
  voteHistory: VoteRecord[];
  /** The day `feelPressure` last ran, so the meter ticks once per dawn. */
  pressuredDay: number;
  /** Closing accusations already filed, so a day is recorded once. */
  recordedDay: number;
}

/** Ledger and speech caps. A table that argues forever still fits in memory. */
const MAX_CLAIMS = 400;
const MAX_VOTE_HISTORY = 400;

export class BotMinds {
  private readonly tables = new Map<string, TableMemory>();

  forget(code: string): void {
    this.tables.delete(code);
  }

  private memory(code: string): TableMemory {
    let table = this.tables.get(code);
    if (!table) {
      table = { minds: new Map(), claims: [], voteHistory: [], pressuredDay: -1, recordedDay: -1 };
      this.tables.set(code, table);
    }
    return table;
  }

  /**
   * The board as one seat is entitled to see it: authoritative state, plus
   * every claim that seat could actually have heard.
   *
   * A claim with no room on it was said in the square and is common property,
   * which is every claim this ledger held until private rooms started being
   * listened to. Anything else is checked against `chatRules` — the same
   * predicate the chat itself is routed by, so there is exactly one answer in
   * the codebase to "may this player read that room".
   *
   * With no reader, the public half. Diagnostics and the headless harness ask
   * that way, and so does anything whose answer must not depend on who is
   * asking; a reader is required to see anything more.
   */
  board(state: MafiaState, readerId?: string): PublicInfo {
    const table = this.memory(state.code);
    const heard =
      readerId === undefined
        ? table.claims.filter((claim) => claim.room === undefined)
        : table.claims.filter((claim) => claim.room === undefined || RULES.canRead(claim.room, readerId, state));
    return toPublicInfo(state, heard, table.voteHistory);
  }

  /**
   * One bot's mind, created on first sight.
   *
   * Personality is drawn once and kept: a bot that is jumpy on Tuesday should be
   * jumpy on Wednesday, or the table has no characters in it. Seeded off the
   * player id so the same seat is the same person across a restart.
   */
  mind(state: MafiaState, playerId: string): BotMind | null {
    const player = state.players[playerId];
    if (!player?.role) return null;

    const table = this.memory(state.code);
    let mind = table.minds.get(playerId);
    if (!mind) {
      const rng = seededRng(playerId);
      const agenda = agendaOf(player.role);
      const brain = makeBrain(player.slot, makePersonality(DEFAULT_PROFILE, rng));
      mind = {
        brain,
        agenda,
        stance: stanceOf(agenda, brain.desperation, brain.personality),
        saidThisRound: 0,
        mask: null,
        notes: []
      };
      table.minds.set(playerId, mind);
    }
    // A converted, audited or remembered seat wants a different agenda than the
    // one it sat down with.
    mind.agenda = agendaOf(player.role);
    return mind;
  }

  /**
   * Takes every living bot's temperature, once per dawn.
   *
   * Called from the driver's phase planner rather than per decision, because
   * desperation is a mood: ticking it on every LLM call would compound it four
   * times a day and the whole table would be frantic by Tuesday.
   */
  openDay(state: MafiaState): void {
    const table = this.memory(state.code);
    if (table.pressuredDay === state.day) return;
    table.pressuredDay = state.day;

    for (const player of Object.values(state.players)) {
      if (!player.isBot || !player.alive || !player.role) continue;
      const mind = this.mind(state, player.playerId);
      if (!mind) continue;
      // Each seat's own board: a mafioso's dawn mood may know what the family
      // said in the night, and nobody else's may.
      const board = this.board(state, player.playerId);
      mind.saidThisRound = 0;
      const allies = new Set(
        Object.values(state.players)
          .filter(
            (other) =>
              other.playerId !== player.playerId && other.alive && sameSide(state, player.playerId, other.playerId)
          )
          .map((other) => other.slot)
      );
      const felt = feelPressure(player, mind.brain, board, allies);
      mind.agenda = felt.agenda;
      mind.stance = felt.stance;
    }
  }

  /**
   * Puts this table's temperaments where the policies read them.
   *
   * `suspicionParts` weighs the wagon by the seat's herd instinct, and reads it
   * from a module-level map that only the headless bench ever filled. Live
   * tables never bound anything, so every bot in production weighed the crowd
   * at exactly one half whatever its personality said: the one trait meant to
   * tell a follower from a sceptic did nothing at a real table.
   *
   * The map is keyed by slot and shared by every table in the process, so it
   * is rebound before each decision rather than once at the start. Decisions
   * are synchronous, so nothing runs between the bind and the reads that
   * follow it, and the next table's decision rebinds its own seats.
   */
  bind(state: MafiaState): void {
    const brains: Brain[] = [];
    for (const player of Object.values(state.players)) {
      if (!player.isBot || !player.alive) continue;
      const mind = this.mind(state, player.playerId);
      if (mind) brains.push(mind.brain);
    }
    bindPersonalities(brains);
  }

  /** Files the day's closing accusations, once, before night falls. */
  closeDay(state: MafiaState): void {
    const table = this.memory(state.code);
    if (table.recordedDay === state.day) return;
    table.recordedDay = state.day;
    for (const [voterId, targetId] of Object.entries(state.votes)) {
      const voter = state.players[voterId];
      const target = state.players[targetId];
      if (voter && target) table.voteHistory.push({ day: state.day, voterSlot: voter.slot, targetSlot: target.slot });
    }
    if (table.voteHistory.length > MAX_VOTE_HISTORY) {
      table.voteHistory.splice(0, table.voteHistory.length - MAX_VOTE_HISTORY);
    }
  }

  /** Remembers where a bot actually went, so tomorrow's answer can be checked. */
  wentTo(state: MafiaState, playerId: string, slot: number | null): void {
    const mind = this.mind(state, playerId);
    if (mind) mind.brain.wentTo = slot;
  }

  /**
   * Files a statement.
   *
   * `truthful` is stamped here, where the full state is legible, purely so the
   * bench-style diagnostics keep working — no brain ever reads it, and nothing in
   * the briefing exposes it.
   */
  record(state: MafiaState, claimerId: string, kind: ClaimKind, targetSlot: number, extra?: Partial<Claim>): void {
    const table = this.memory(state.code);
    const claimer = state.players[claimerId];
    if (!claimer) return;
    /**
     * Once per claimer, target, kind and day — per room.
     *
     * The room belongs in the key now that private ones are read. Without it,
     * a person who whispers "7 is mafia" to one bot and then says it out loud
     * in the square files the whisper and has the announcement swallowed as a
     * duplicate: the same sentence, but one of them was evidence the whole
     * town could weigh and the other was not.
     */
    const alreadySaid = table.claims.some(
      (claim) =>
        claim.claimerSlot === claimer.slot &&
        claim.targetSlot === targetSlot &&
        claim.kind === kind &&
        claim.day === state.day &&
        claim.room === extra?.room
    );
    if (alreadySaid) return;

    /**
     * An account replaces the account it corrects, rather than joining it.
     *
     * Every other kind of claim accumulates, because saying two things about
     * two houses is two claims. An account is about the claimer's own night and
     * there is only one of those: "I stayed home" followed by "I went to 4"
     * is not a person holding two positions, it is a person correcting
     * themselves, or a reader that got the first one wrong.
     *
     * Which happens, and is the reason this exists. Human speech reaches the
     * board through two readers now, one of them a set of regular expressions
     * running on a half-typed sentence, and the price of reading a hesitation
     * as an alibi used to be permanent: the seat kept both entries and the town
     * hanged them for the one they withdrew. The newest reading wins, so the
     * better reader arriving a few seconds later genuinely corrects the quicker
     * one, and a person who changes their story is answerable for the story
     * they are actually telling.
     *
     * Same day only. Yesterday's account was about yesterday's night and is
     * still evidence about it.
     */
    if (kind === 'account') {
      for (let index = table.claims.length - 1; index >= 0; index--) {
        const claim = table.claims[index];
        if (
          claim.kind === 'account' &&
          claim.claimerSlot === claimer.slot &&
          claim.day === state.day &&
          claim.room === extra?.room
        ) {
          table.claims.splice(index, 1);
        }
      }
    }

    table.claims.push({
      day: state.day,
      claimerSlot: claimer.slot,
      targetSlot,
      kind,
      truthful: false,
      ...extra
    });
    if (table.claims.length > MAX_CLAIMS) table.claims.splice(0, table.claims.length - MAX_CLAIMS);
  }

  /**
   * The raw ledger, for the headless harness.
   *
   * Read-only and diagnostic: it answers the question a transcript cannot, which
   * is whether a bot that *said* something also *recorded* it. A table where every
   * line is a question and the board holds no questions means the models are
   * writing prose and leaving the structured field null — invisible in the chat,
   * fatal to the game.
   */
  ledger(code: string): readonly Claim[] {
    return this.tables.get(code)?.claims ?? [];
  }

  /** Seats the record has caught contradicting their own account. */
  caughtLying(state: MafiaState): number[] {
    const board = this.board(state);
    return board.aliveSlots.filter((slot) => contradicted(slot, board));
  }
}

/**
 * Everyone who wins alongside this seat.
 *
 * `isLodgeMate` already answers it for the two blocs that know each other — a
 * family and the masons' lodge — and it is the same predicate the view uses to
 * decide who appears in your teammates list, so "my allies" here means exactly
 * the people the game has told me about. Bound hearts count too: lovers win
 * together whoever else does.
 */
function sameSide(state: MafiaState, a: string, b: string): boolean {
  const one = state.players[a];
  const two = state.players[b];
  if (!one?.role || !two?.role) return false;
  if (one.bondPartnerId === two.playerId || two.bondPartnerId === one.playerId) return true;
  return isLodgeMate(one, two);
}

/**
 * A stable per-seat RNG, so a bot's personality survives a server restart.
 * Small, fast and deterministic; nothing here needs cryptographic quality.
 */
function seededRng(seed: string): () => number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  let state = hash >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
