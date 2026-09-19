import {
  agendaOf,
  bindPersonalities,
  chatRules,
  contradicted,
  DEFAULT_PROFILE,
  feelPressure,
  closingAccusations,
  isEvilRole,
  isLodgeMate,
  makeBrain,
  makePersonality,
  stanceOf,
  staysHome,
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
   * Jailor only: the prisoners this seat has told its own name to.
   *
   * A Jailor that trusts its captive identifies itself, because the cell is the
   * only room in the game where that can be said without the square hearing it.
   * Kept per prisoner so it is said once and not re-introduced on every turn of
   * a long night, and kept on the mind rather than the brain because it is a
   * fact about a conversation rather than about the board. See `cellLine`.
   */
  namedSelfTo?: string[];
  /**
   * Where this seat went, night by night, kept rather than recomputed.
   *
   * The will is rebuilt from scratch every time anything touches it, and the
   * journey line used to be built from the *argument* of that call: present on
   * the turn that chose tonight's target, gone on the next turn, back on the
   * one after. A real seat watched its own will gain and lose the same night
   * three times before dawn, and whichever version happened to be current when
   * it died is what the town read.
   *
   * A will is a record. Records are kept, not derived.
   */
  went: { night: number; slot: number }[];
  /**
   * Nights this seat spent at home spending its own power on itself.
   *
   * Kept apart from `went` because it is not a journey and must never be
   * written down as one. The Veteran's alert and the Survivor's vest name no
   * house — nobody is visited, no door is knocked on, and a Lookout watching
   * either of them sees nothing. Filed as a trip, the only slot available to
   * name is the seat's own, which is how a Veteran's will came to read "Night
   * 5: Garuda is where I will be" about Garuda himself.
   *
   * A night, and nothing else: which power it was is on the role card.
   */
  stayedIn: number[];
  /**
   * The night lines of this seat's own will, as last written.
   *
   * Cached here rather than rebuilt, because the will is rewritten every dawn
   * anyway and these are the expensive half of it. What reads them is the
   * stand: a seat arguing for its life should be reading out the record it has
   * been keeping all game, and until it could get at that record it was
   * improvising instead — four different accounts of night 3 in four lines,
   * while the will in its pocket said something else again.
   */
  willNights: string[];
  /**
   * The day this seat opened its defence with "I am muted." and must now keep
   * to it: a muted person does not say a second thing. See `defenceLine`.
   */
  mutedBluffDay?: number;
  /**
   * What other seats have told this one in private, waiting on the graveyard.
   *
   * Private because that is the whole point: a whisper is worth something to
   * the person it was whispered to and worth nothing to anybody else, so it
   * cannot live on the shared board. See `confide` and `settleConfidences`.
   */
  confided: Confided[];
  /**
   * What each seat's private word has actually been worth, by house.
   *
   * Earned, never given. A bot used to become more biddable simply because
   * somebody had messaged it — which is not trust, it is a remote control, and
   * it is exactly the hole a person walks through by whispering to all eleven
   * bots at once. This moves only when a confidence is *settled by an outcome*:
   * you told me 7 was mafia and 7 died mafia, so I will listen to you again.
   */
  privateTrust: Map<number, number>;
}

/**
 * One thing somebody told this seat privately, and whether it came true.
 *
 * Only the two kinds the graveyard can settle. "I am the Sheriff" whispered in
 * a cell is not settleable by anything, so it is not banked here; what is
 * banked is a claim about a *house*, which a corpse eventually answers.
 */
export interface Confided {
  /** The house that said it. */
  from: number;
  day: number;
  kind: 'accuse' | 'clear';
  /** The house it was about. */
  about: number;
  /** Settled once the graveyard has answered, so a claim is banked once. */
  settled?: boolean;
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
   * Somebody said something in a private room, and everybody who heard it
   * writes it down against the person who said it.
   *
   * The shared board already scopes the *content* of a whisper correctly — see
   * `board` — so this is not about who knows what. It is about who is owed
   * what: a claim made in private is a favour asked and a reputation staked,
   * and until now neither was tracked, so the only thing a whisper could do was
   * make a bot more compliant the moment it arrived.
   *
   * Written per listener rather than per table, because that is the asymmetry
   * that makes private play interesting: the same seat can be a trusted source
   * to one bot and a proven liar to another, and neither of them can see the
   * other's ledger.
   */
  confide(state: MafiaState, room: string, fromSlot: number, kind: 'accuse' | 'clear', about: number): void {
    const table = this.memory(state.code);
    for (const [playerId, mind] of table.minds) {
      const listener = state.players[playerId];
      if (!listener?.isBot || listener.slot === fromSlot) continue;
      if (!RULES.canRead(room, playerId, state)) continue;
      const already = mind.confided.some(
        (entry) => entry.from === fromSlot && entry.about === about && entry.kind === kind && entry.day === state.day
      );
      if (!already) mind.confided.push({ from: fromSlot, day: state.day, kind, about });
    }
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
        notes: [],
        went: [],
        stayedIn: [],
        willNights: [],
        confided: [],
        privateTrust: new Map()
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
      settleConfidences(state, mind);
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

  /**
   * Files the day's closing accusations, once, before night falls.
   *
   * Read off `state.voteLog` rather than off `state.votes`. This runs at
   * nightfall, and by then the live ballot box has been cleared twice — once by
   * the wagon that opened the trial and once by nightfall itself — so on every
   * day that actually put somebody on trial it filed nothing at all. The days
   * the town did something were the days the record forgot. See
   * `closingAccusations`.
   */
  closeDay(state: MafiaState): void {
    const table = this.memory(state.code);
    if (table.recordedDay === state.day) return;
    table.recordedDay = state.day;
    for (const record of closingAccusations(state, state.day)) table.voteHistory.push(record);
    if (table.voteHistory.length > MAX_VOTE_HISTORY) {
      table.voteHistory.splice(0, table.voteHistory.length - MAX_VOTE_HISTORY);
    }
  }

  /**
   * Remembers where a bot actually went, so tomorrow's answer can be checked.
   *
   * "Went" is meant literally, and the check below is what makes it so. Not
   * every power is a visit: the Veteran's alert and the Survivor's vest are a
   * night spent at home, and the only slot the engine has to hand for either is
   * the seat's own. Recorded as a journey, that became an alibi naming
   * yourself — a will that read "Night 5: Garuda is where I will be" over
   * Garuda's own body, and a `wentTo` the seat would then have to defend in the
   * square tomorrow.
   *
   * The simulator has always drawn this line (see `brain.wentTo` there); the
   * live driver did not, which is why only real tables saw it.
   */
  wentTo(state: MafiaState, playerId: string, slot: number | null): void {
    const mind = this.mind(state, playerId);
    if (!mind) return;

    const player = state.players[playerId];
    const homebound = !!player?.role && (staysHome(player.role) || slot === player.slot);

    if (homebound) {
      // Nowhere to be seen going, so there is nothing to answer for tomorrow.
      mind.brain.wentTo = null;
      if (slot !== null && !mind.stayedIn.includes(state.day)) mind.stayedIn.push(state.day);
      return;
    }

    mind.brain.wentTo = slot;
    // And the same journey on the permanent record, one line per night. See `went`.
    if (slot === null) return;
    const already = mind.went.find((trip) => trip.night === state.day);
    if (already) already.slot = slot;
    else mind.went.push({ night: state.day, slot });
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
    const alreadySaid = table.claims.find(
      (claim) =>
        claim.claimerSlot === claimer.slot &&
        claim.targetSlot === targetSlot &&
        claim.kind === kind &&
        claim.day === state.day &&
        claim.room === extra?.room
    );
    if (alreadySaid) {
      /**
       * Two readers reaching the same reading is worth more than one.
       *
       * A person's line is read twice: instantly, off cue words, and a few
       * seconds later by a model. The second reading used to be swallowed whole
       * as a duplicate, which was right when a claim was a claim and wrong now
       * that one carries how sure its reader was — the quick reader's 0.65 hung
       * around even after the careful one had agreed with it.
       *
       * Agreement raises it; it never lowers. A reader that missed something is
       * silent rather than contradicting, so a lower number arriving second is
       * an absence of evidence and not evidence of absence.
       */
      const offered = extra?.confidence;
      if (offered !== undefined && offered > (alreadySaid.confidence ?? 1)) {
        alreadySaid.confidence = Math.min(1, offered + 0.1);
      }
      return;
    }

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
      /**
       * Said today, so it is last night it is talking about.
       *
       * Written down rather than left for the driver to infer, because the
       * driver's guess was wrong for every claim read out of a will: those
       * carry the night in `day`, so subtracting one from it named a night too
       * early. `extra` wins, which is how a testament sets its own. See
       * `Claim.night`.
       */
      night: Math.max(1, state.day - 1),
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

/**
 * The dawn reckoning on what people told this seat in private.
 *
 * Trust earned by outcome, which is the whole design and the thing that was
 * missing. The old arrangement gave a whisperer influence for having whispered:
 * `heeded` was a hash of the request, granted three times in four, so a person
 * could message eleven bots and move eight knives on the strength of nothing.
 * That is not a table listening to somebody, it is a table with no memory.
 *
 * A confidence settles when the graveyard answers it. You told me in the dark
 * that 7 was mafia; 7 is now a corpse with a name on it, and either you were
 * right or you were not. Clearing a killer costs more than accusing a townie,
 * for the same reason it does on the public board: it is the one move that is
 * almost never an honest mistake.
 *
 * What it does *not* do is leak. Nothing here reaches the shared board, nothing
 * here is visible to anybody but the seat that was told, and a seat that was
 * never whispered to has an empty ledger and behaves exactly as it always did.
 */
export function settleConfidences(state: MafiaState, mind: BotMind): void {
  /**
   * What the graveyard has actually said, which is not the same as who is dead.
   *
   * A janitor-cleaned corpse settles nothing: the table never learned what it
   * was, so a confidence about that house is still open and the person who gave
   * it has neither earned nor lost anything. Read off `state.deaths`, which is
   * the public record, rather than off the player, which knows the truth.
   */
  const cleaned = new Set(state.deaths.filter((death) => death.hidden).map((death) => death.playerId));
  const roleOf = new Map<number, RoleId>();
  for (const player of Object.values(state.players)) {
    if (!player.alive && player.role && !cleaned.has(player.playerId)) roleOf.set(player.slot, player.role);
  }

  for (const entry of mind.confided) {
    if (entry.settled) continue;
    const revealed = roleOf.get(entry.about);
    if (!revealed) continue;
    entry.settled = true;

    const wasEvil = isEvilRole(revealed);
    /**
     * Priced like `settledCredit` on the public board, and deliberately a
     * little heavier both ways: a private word is a favour, and a favour that
     * was a lie is worse than a shout that was wrong.
     */
    const worth = entry.kind === 'accuse' ? (wasEvil ? 1.2 : -1.2) : wasEvil ? -1.8 : 0.8;
    mind.privateTrust.set(entry.from, (mind.privateTrust.get(entry.from) ?? 0) + worth);
  }
}

/**
 * How much this seat's private word is worth to that one, as a multiplier.
 *
 * One by default, which is the point: an unknown whisperer is neither trusted
 * nor distrusted, and everything away from one has been earned. Saturating, so
 * a seat with five good calls is not five times as persuasive as one with a
 * single good call.
 */
export function privateWeight(mind: BotMind, slot: number): number {
  const credit = mind.privateTrust.get(slot) ?? 0;
  return 1 + 0.7 * Math.tanh(credit * 0.6);
}

/**
 * Whether this seat does what it was privately asked to do.
 *
 * Three things decide it, and the old version had only the third.
 *
 *  - What that person's private word has been worth so far. A seat that has
 *    lied to you in the dark once gets listened to less, and one that handed
 *    you a killer gets listened to more.
 *  - Temperament, because some people are biddable and some are not, and a
 *    family where every request is granted is a remote control while one where
 *    none are is what a real table complained about.
 *  - A stable roll, so the same request does not flicker between turns.
 *
 * A seat that has been badly misled in private can refuse outright, which is
 * the behaviour the ledger exists to make possible: the point of earning trust
 * is that it can also be spent.
 */
export function willHeed(mind: BotMind, fromSlot: number, roll: number): boolean {
  const credit = mind.privateTrust.get(fromSlot) ?? 0;
  if (credit <= -2) return false; // burned: this voice does not move this seat
  /**
   * The base rate is the biddable half of a temperament rather than a constant.
   * `herd` is what already decides how much this seat moves for other people
   * anywhere else in the model, so it decides it here too.
   */
  const base = 0.35 + mind.brain.personality.herd * 0.45;
  const earned = 0.2 * Math.tanh(credit * 0.6);
  return roll < Math.max(0.05, Math.min(0.95, base + earned));
}
