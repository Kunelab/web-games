import { legalNightAction, needsSecondTarget, type LegalAction } from '../engine.js';
import { closingAccusations, toPublicInfo } from '../observe.js';
import { staysHome } from '../powers.js';
import {
  chatRules,
  isLodgeMate,
  playerBySlot,
  playerFamily,
  SKIP_VOTE,
  type MafiaPlayer,
  type MafiaState
} from '../state.js';
import {
  decideBallot,
  decideDay,
  decideNightTarget,
  decideSecondTarget,
  feelPressure,
  isEvilRole,
  makeBrain,
  steadyVote,
  unclashedTargets,
  type Brain,
  type Claim,
  type DayDecision,
  type Personality,
  type PublicInfo,
  type SteadyVote,
  type VoteRecord
} from './policies.js';

/**
 * Who may hear what, asked once. The rules are pure and every board read asks
 * the same object.
 */
const RULES = chatRules();

/** Ledger caps. A table that argues forever still fits in memory. */
const MAX_CLAIMS = 400;
const MAX_VOTE_HISTORY = 400;

/** What a seat does with its day turn: what it says and does, and its ballot. */
export interface DayMove {
  decision: DayDecision;
  ballot: SteadyVote;
  /** The house this seat's ballot was already on, if any; a skip is none. */
  standing: number | null;
}

/** What a seat orders for the night, whole: a two-house power names both or neither. */
export interface NightOrder {
  type: LegalAction['type'];
  targetSlot: number | null;
  secondTargetSlot: number | null;
}

/** What a driver may see of a night choice before it is final. See `BotTable.night`. */
export interface NightAim {
  /** The houses this seat may go to without walking into its own family's work. */
  aimable: number[];
  /** Where the policy would go. */
  chosen: number | null;
  board: PublicInfo;
  brain: Brain;
  allies: ReadonlySet<number>;
}

/** How the mood of a morning landed on one seat. */
export type MorningMood = ReturnType<typeof feelPressure>;

/**
 * The bots at one table: what they have heard, what they remember, and the one
 * order in which they decide.
 *
 * The headless bench and the live driver both drive this, so the bench measures
 * what ships. They used to keep a copy each of the ledger, the brains and the
 * sequence of policy calls a seat's turn is made of, and the copies drifted: the
 * bench pooled a family's night records where the live seat read only its own,
 * cast raw votes where the live seat held or skipped, and left a lover out of
 * its partner's allies. Everything a seat decides goes through here, and only
 * the conversation around it (what a live bot says, and to whom) stays with the
 * driver.
 *
 * Per table, and only as long as the table: one instance per game.
 */
export class BotTable {
  private readonly brains = new Map<string, Brain>();
  /** The same characters by slot, carried on every board this table builds. */
  private readonly characters = new Map<number, Personality>();
  private readonly ledger: Claim[] = [];
  private readonly history: VoteRecord[] = [];
  /** The day the morning's mood was last taken, so it is taken once. */
  private dawnOf = -1;
  /** The day whose closing accusations were last filed, so a day is filed once. */
  private duskOf = -1;

  /**
   * @param personalityOf Who this table plays, and as whom: a personality for
   *   each seat it decides for, null for a seat somebody else plays. Asked once
   *   per seat, in seating order, so a seeded draw is reproducible.
   */
  constructor(
    private readonly state: MafiaState,
    private readonly personalityOf: (player: MafiaPlayer) => Personality | null
  ) {
    for (const player of Object.values(state.players)) this.brain(player.playerId);
  }

  /** The brain of a seat this table plays, made on first sight; null for anybody else. */
  brain(playerId: string): Brain | null {
    const known = this.brains.get(playerId);
    if (known) return known;
    const player = this.state.players[playerId];
    if (!player) return null;
    const personality = this.personalityOf(player);
    if (!personality) return null;
    const brain = makeBrain(player.slot, personality);
    this.brains.set(playerId, brain);
    this.characters.set(player.slot, personality);
    return brain;
  }

  /**
   * A seat that has a turn to take, with its brain: dealt, alive and played by
   * this table. Null for anybody else. The first thing every decision asks.
   */
  private livingSeat(playerId: string): { self: MafiaPlayer; brain: Brain } | null {
    const self = this.state.players[playerId];
    const brain = this.brain(playerId);
    if (!self?.role || !self.alive || !brain) return null;
    return { self, brain };
  }

  /**
   * The board as one seat is entitled to see it: authoritative state, plus
   * every claim that seat could actually have heard.
   *
   * A claim with no room was said in the square and is common property.
   * Anything else is checked against `chatRules`, the same predicate the chat
   * itself is routed by. With no reader, the public half only.
   */
  board(readerId?: string): PublicInfo {
    // Nothing private on the record: hand over the ledger itself, so the board
    // cache sees the same claims and stays warm between readers.
    const heard = !this.ledger.some((claim) => claim.room !== undefined)
      ? this.ledger
      : readerId === undefined
        ? this.ledger.filter((claim) => claim.room === undefined)
        : this.ledger.filter((claim) => claim.room === undefined || RULES.canRead(claim.room, readerId, this.state));
    return toPublicInfo(this.state, heard, this.history, this.characters);
  }

  /** Everything said at this table, in order, as heard by nobody in particular. Diagnostic. */
  claims(): readonly Claim[] {
    return this.ledger;
  }

  /** Every day's closing accusations, as filed at each dusk. Diagnostic. */
  closings(): readonly VoteRecord[] {
    return this.history;
  }

  /**
   * Files a statement.
   *
   * Once per claimer, target, kind, day and room: a second reading of the same
   * line only raises how sure the record is of it. An account replaces the
   * account it corrects, because a seat has one night to account for, and the
   * newest reading of it is the one it answers for.
   *
   * `truthful` is stamped here, where the whole state is legible, for the
   * bench's diagnostics. No brain ever reads it.
   */
  hear(said: Omit<Claim, 'truthful'>): void {
    const ledger = this.ledger;
    const twin = ledger.find(
      (claim) =>
        claim.claimerSlot === said.claimerSlot &&
        claim.targetSlot === said.targetSlot &&
        claim.kind === said.kind &&
        claim.day === said.day &&
        claim.room === said.room
    );
    if (twin) {
      const offered = said.confidence;
      if (offered !== undefined && offered > (twin.confidence ?? 1)) twin.confidence = Math.min(1, offered + 0.1);
      return;
    }
    if (said.kind === 'account') {
      for (let index = ledger.length - 1; index >= 0; index--) {
        const claim = ledger[index];
        if (
          claim.kind === 'account' &&
          claim.claimerSlot === said.claimerSlot &&
          claim.day === said.day &&
          claim.room === said.room
        ) {
          ledger.splice(index, 1);
        }
      }
    }
    ledger.push({ ...said, truthful: this.truthOf(said) });
    if (ledger.length > MAX_CLAIMS) ledger.splice(0, ledger.length - MAX_CLAIMS);
  }

  /** Whether a statement was true, read off the whole state. */
  private truthOf(claim: Omit<Claim, 'truthful'>): boolean {
    const target = playerBySlot(this.state, claim.targetSlot);
    const targetEvil = target?.role ? isEvilRole(target.role) : false;
    switch (claim.kind) {
      case 'clear':
        return !targetEvil;
      case 'role-claim':
        return target?.role === claim.claimedRole;
      case 'account': {
        // Honest when it matches where the seat actually went.
        const claimer = playerBySlot(this.state, claim.claimerSlot);
        const went = claimer ? (this.brains.get(claimer.playerId)?.wentTo ?? null) : null;
        return claim.account === 'home' ? went === null : went === claim.targetSlot;
      }
      case 'question':
      case 'taunt':
        // Neither states a fact, so neither can be a lie.
        return true;
      default:
        return targetEvil;
    }
  }

  /**
   * Everyone who wins alongside this seat, alive: the bloc the game has told it
   * about (a family, the lodge), and a lover. A Heartbreaker's charm is a
   * hostage, not a side.
   */
  allies(playerId: string): Set<number> {
    const self = this.state.players[playerId];
    const allies = new Set<number>();
    if (!self?.role) return allies;
    for (const other of Object.values(this.state.players)) {
      if (other.playerId === playerId || !other.alive || !other.role) continue;
      const lovers =
        self.bondKind === 'lover' && (self.bondPartnerId === other.playerId || other.bondPartnerId === playerId);
      if (lovers || isLodgeMate(self, other)) allies.add(other.slot);
    }
    return allies;
  }

  /** The living members of this seat's own family: evil it does not have to work out. */
  private knownEvil(playerId: string): Set<number> {
    const self = this.state.players[playerId];
    const family = self ? playerFamily(self) : null;
    const known = new Set<number>();
    if (family === null) return known;
    for (const other of Object.values(this.state.players)) {
      if (other.playerId !== playerId && other.alive && playerFamily(other) === family) known.add(other.slot);
    }
    return known;
  }

  /**
   * Takes every living seat's temperature, once per morning, before a word is
   * said. Desperation is a mood rather than a per-decision reading: ticked per
   * call it would compound several times a day and the whole table would be
   * frantic by Tuesday. Returns how it landed on each seat; empty the second
   * time it is asked on the same day.
   */
  settleMorningMoods(): Map<string, MorningMood> {
    const moods = new Map<string, MorningMood>();
    if (this.dawnOf === this.state.day) return moods;
    this.dawnOf = this.state.day;
    for (const player of Object.values(this.state.players)) {
      if (!player.alive || !player.role) continue;
      const brain = this.brain(player.playerId);
      if (!brain) continue;
      moods.set(player.playerId, feelPressure(player, brain, this.board(player.playerId), this.allies(player.playerId)));
    }
    return moods;
  }

  /**
   * Files the day's closing accusations, once, before night falls, and returns
   * what it filed; null when this day was already filed. Read off the engine's
   * vote log rather than the ballot box, which a day that opened a trial has
   * already emptied. See `closingAccusations`.
   */
  fileClosingVotes(): VoteRecord[] | null {
    if (this.duskOf === this.state.day) return null;
    this.duskOf = this.state.day;
    const closing = closingAccusations(this.state, this.state.day);
    this.history.push(...closing);
    if (this.history.length > MAX_VOTE_HISTORY) this.history.splice(0, this.history.length - MAX_VOTE_HISTORY);
    return closing;
  }

  /** A day turn: what the seat says and does, and what it does with its ballot. Null for a seat this table does not play. */
  day(playerId: string, rng: () => number): DayMove | null {
    const seat = this.livingSeat(playerId);
    if (!seat) return null;
    const { self, brain } = seat;
    const board = this.board(playerId);
    const allies = this.allies(playerId);
    const decision = decideDay(self, brain, board, allies, this.knownEvil(playerId), rng);
    const standingId = this.state.votes[playerId];
    const standing =
      standingId && standingId !== SKIP_VOTE ? (this.state.players[standingId]?.slot ?? null) : null;
    return { decision, ballot: steadyVote(self, board, standing, decision.voteSlot, allies, rng), standing };
  }

  /** A juror's verdict on whoever is on the stand. Null without a trial, or for a seat this table does not play. */
  ballot(playerId: string, rng: () => number): 'guilty' | 'innocent' | 'abstain' | null {
    const seat = this.livingSeat(playerId);
    const accused = this.state.trial ? this.state.players[this.state.trial.accusedId] : null;
    if (!seat || !accused || accused.playerId === playerId) return null;
    return decideBallot(seat.self, seat.brain, this.board(playerId), accused.slot, this.allies(playerId), rng);
  }

  /**
   * A night order, whole, or null for a seat with nothing to do tonight.
   *
   * The seat reads its own night record and nobody else's: a family shares
   * what it says in its room, not its notebooks. `steer` lets a driver overrule
   * the house the policy chose (a teammate's request, a forced scenario), after
   * the family's own clashes are taken out and before the second house is
   * picked, so the order stays whole either way.
   */
  night(playerId: string, rng: () => number, steer?: (aim: NightAim) => number | null): NightOrder | null {
    const seat = this.livingSeat(playerId);
    const legal = legalNightAction(this.state, playerId);
    if (!seat || !legal) return null;
    const { self, brain } = seat;
    const board = this.board(playerId);
    const allies = this.allies(playerId);

    if (legal.targets.length === 0) {
      // A power worked on the seat itself (the porch, the vest): only whether.
      const home = decideNightTarget(self, brain, board, [], legal.type, allies, self.intel, rng);
      return { type: legal.type, targetSlot: home, secondTargetSlot: null };
    }

    const aimable = unclashedTargets(this.state, playerId, legal.type, legal.targets);
    const chosen = decideNightTarget(self, brain, board, aimable, legal.type, allies, self.intel, rng);
    const target = steer ? steer({ aimable, chosen, board, brain, allies }) : chosen;
    if (target === null) return { type: legal.type, targetSlot: null, secondTargetSlot: null };
    if (!needsSecondTarget(legal.type)) return { type: legal.type, targetSlot: target, secondTargetSlot: null };
    const second = decideSecondTarget(self, board, legal.type, target, legal.secondTargets ?? [], rng);
    // Both houses or none: the engine refuses a two-house power that names one.
    return second === null
      ? { type: legal.type, targetSlot: null, secondTargetSlot: null }
      : { type: legal.type, targetSlot: target, secondTargetSlot: second };
  }

  /**
   * Remembers where a seat actually went tonight, so tomorrow's account of it
   * can be checked. Returns whether it was a journey at all: a power worked at
   * home, or on the seat itself, names no door and leaves nothing to answer for.
   */
  recordVisit(playerId: string, slot: number | null): boolean {
    const self = this.state.players[playerId];
    const brain = this.brain(playerId);
    if (!self?.role || !brain) return false;
    const journey = slot !== null && slot !== self.slot && !staysHome(self.role);
    brain.wentTo = journey ? slot : null;
    return journey;
  }
}
