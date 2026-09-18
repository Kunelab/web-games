import type { DeathSource } from '../messages.js';
import type { NightActionType, RoleId } from '../roles.js';
import { familyOf, isSoloKiller, QUIET_TRADE, roleDef, ROLES } from '../roles.js';
import { beliefs, surestSuspect } from './beliefs.js';
import { deductions, deductionWeight } from './deduce.js';
export { QUIET_TRADE };
import {
  advanceDesperation,
  agendaOf,
  CALM,
  pickMask,
  stanceOf,
  type Agenda,
  type Pressure,
  type Stance
} from '../social.js';
import { sheriffSuspects, type IntelEntry, type MafiaPlayer, type SheriffVerdict } from '../state.js';
export { sheriffSuspects, type SheriffVerdict };

/**
 * The "dumb but rational" brains for the fast simulation. No LLM, no chat —
 * but the *effect* of chat is modelled as a public claims board:
 *
 *  - `accuse`  — "house N is suspect" (a sheriff result, a lookout deduction,
 *                or a lie);
 *  - `clear`   — "house N is fine" (a sheriff clear, a doctor vouching for a
 *                patient he saved, or a mafioso covering a teammate);
 *  - `hint`    — soft evidence (an investigator's trade line).
 *
 * Lying is priced: a claimer whose accusation dies town — or whose "clear"
 * dies evil — is a proven liar, loses all voice and becomes a prime lynch
 * candidate. Evils therefore lie *carefully*: fake accusations pile onto
 * already-suspected targets, and covering a teammate is saved for when the
 * rope is close. Loud truthful claimers, symmetrically, paint a target on
 * their own back: the mafia hunts them at night.
 *
 * Everything a brain reads is information its player legitimately has: its
 * own role and intel, the public board, and — for mafia — the family's
 * pooled intel. No brain ever reads another player's hidden role; the
 * `truthful` flag on claims is stamped by the simulator for diagnostics only.
 */

/**
 * The dials that make one seat a different player from the next.
 *
 * Two kinds, and the difference matters. The five below are **appetites**, 0..1:
 * how much this seat wants to push, follow, claim, lie, pull a trigger. The
 * three in `Temperament` are **coefficients**, 0.6..1.4, and they multiply the
 * meters rather than setting them — 1 is the average player, 0.6 is somebody
 * who feels half of it, 1.4 somebody who feels it half again as hard.
 *
 * Kept as multipliers because a meter has a meaning the seat does not get to
 * argue with: three votes on you *is* three votes on you. What a temperament
 * changes is how loudly that lands, which is the actual difference between one
 * player and another at the same table reading the same board.
 */
export interface Temperament {
  /**
   * How hard the panic meter swings, 0.6..1.4.
   *
   * Low is steady under a wagon: the seat argues its way out. High spikes early
   * and reaches for a mask sooner, because `stanceOf` reads desperation.
   */
  nerve: number;
  /**
   * How far the public record moves this seat's read of others, 0.6..1.4.
   *
   * Low takes a lot of convincing and keeps voting its own book; high swings
   * hard on one ballot somebody got wrong.
   */
  suspicion: number;
  /**
   * How soon it says what it knows, 0.6..1.4.
   *
   * The one the table feels most. At 0.6 a Sheriff with a hit sits on it an
   * extra day, afraid of the knife that comes for whoever speaks; at 1.4 it is
   * out with it the morning it has it. Neither one is silence: a careful
   * Sheriff still reports, it just waits for cover — see `patience`.
   */
  haste: number;
}

/**
 * The ways a person at the table does not behave like a policy.
 *
 * Every bot in this file is a well-behaved correspondent: asked a question it
 * answers, having answered it does not change its story, and having settled on
 * a vote it needs real evidence to move. People are none of those things, and
 * the gap matters more than it sounds, because the whole human-facing half of
 * this brain has never once run in the bench — every bench game is bots, so
 * `humanSlots` is empty, the one line that reads it multiplies nothing, and any
 * rule about a seat that ignores the room has nothing to fire on.
 *
 * So the bench can seat people-shaped players: the same brain, with the four
 * habits that actually distinguish a person from a policy at a Mafia table.
 * Not an attempt at realism. It is coverage — a way to make the human paths
 * run, and to see what the bots do when somebody stonewalls them.
 *
 * All zero by default, and every one of them is read behind a `> 0` guard so
 * an unquirked table draws exactly the random numbers it drew before.
 */
export interface Quirks {
  /** Chance of letting a question aimed at this seat go unanswered. */
  stonewall: number;
  /** Chance of volunteering a fresh account that does not match the standing one. */
  waffle: number;
  /** How much less evidence it takes to move this seat off its vote, 0..1. */
  lateSwitch: number;
  /** Chance of asking again, of a seat that answered the first ask with nothing. */
  press: number;
}

/** The policy's own habits: answers when asked, keeps its story, holds its vote. */
export const NO_QUIRKS: Quirks = { stonewall: 0, waffle: 0, lateSwitch: 0, press: 0 };

/**
 * A quirk fires, without touching the random stream when it cannot.
 *
 * The short-circuit is the whole point: `rng() < 0` is still a draw, and a
 * bench whose every seat rolled four extra numbers a day would no longer be
 * the bench the balance numbers were measured against.
 */
function quirked(chance: number, rng: () => number): boolean {
  return chance > 0 && rng() < chance;
}

export interface Personality {
  /** Propensity to vote without hard evidence. */
  aggression: number;
  /** Weight given to joining an existing wagon. */
  herd: number;
  /** Chance per day an investigative role publishes what it found. */
  claimRate: number;
  /** Mafia / jester / executioner: propensity to publish fake claims. */
  deceit: number;
  /** Vigilante trigger discipline and jailor execution nerve. */
  courage: number;
  /** The meter coefficients. See `Temperament`. */
  temperament: Temperament;
  /** The people-shaped habits. Absent, as for every bot, means none. See `Quirks`. */
  quirks?: Quirks;
}

/** The average player: every meter at exactly its face value. */
export const EVEN_TEMPERAMENT: Temperament = { nerve: 1, suspicion: 1, haste: 1 };

/** The range a rolled coefficient lives in. Symmetric around the average. */
export const TEMPERAMENT_MIN = 0.6;
export const TEMPERAMENT_MAX = 1.4;

export const DEFAULT_PROFILE: Personality = {
  aggression: 0.5,
  herd: 0.5,
  claimRate: 0.7,
  deceit: 0.4,
  courage: 0.5,
  temperament: EVEN_TEMPERAMENT,
  quirks: NO_QUIRKS
};

/**
 * A seat that plays like somebody typing, for the bench.
 *
 * Tuned to be awkward rather than strong: it talks early, it does not always
 * answer, it changes its story, and it moves its vote on less than a bot would.
 * A table that handles this one gracefully is a table that handles a person.
 */
export const HUMAN_PROFILE: Partial<Personality> = {
  aggression: 0.65,
  herd: 0.35,
  claimRate: 0.85,
  deceit: 0.5,
  courage: 0.6,
  quirks: { stonewall: 0.45, waffle: 0.25, lateSwitch: 0.6, press: 0.5 }
};

/**
 * What a seat can say out loud.
 *
 * `question` and `account` are what make a day phase feel like a day phase:
 * somebody asks a seat to say where it was, and the answer goes on the record
 * where a lookout can later contradict it. That contradiction is the only
 * mechanism in this model that catches a liar *without* waiting for a corpse to
 * prove it — which is what a real table spends its afternoons doing.
 */
export type ClaimKind =
  | 'accuse'
  | 'clear'
  | 'hint'
  | 'role-claim'
  | 'question'
  | 'account'
  | 'taunt'
  | 'sighting'
  /**
   * "Somebody did something to me last night."
   *
   * The one thing a seat can say about itself that costs nothing to say and
   * hands the room something to act on: poison kills at the next dawn unless a
   * doctor gets there, petrol says an arsonist is live and has already been to
   * your door. It accuses nobody, so `suspicionParts` weighs it at nothing —
   * and that is exactly what makes it a comfortable lie, which is why liars
   * tell it too.
   */
  | 'ailing'
  /**
   * "We need to vote." / "Let us skip today."
   *
   * The room pushing on the clock rather than on a person. It names nobody, so
   * no suspicion moves — and it was the single most consequential sentence the
   * board could not hear: `steadyVote` skips a day whose evidence is below
   * `NO_CASE_CEILING`, which on day two is every day, so the bots ended day two
   * in the first second while a person was still typing. A human asking for a
   * vote is the one thing that should override a machine's verdict that there
   * is nothing to vote on.
   */
  | 'urge'
  /**
   * "Why me?" / "Who put my name up?"
   *
   * The reciprocal of `question`: not a seat being asked to account for itself,
   * but a seat demanding that its accusers account for *theirs*. The reason is
   * already computed — `why()` builds one for every accusation a bot makes and
   * throws it away unless the line happens to carry it — so this costs nothing
   * to answer and turns a silent wagon into an argument.
   */
  | 'demand'
  /**
   * "He cannot be the doctor."
   *
   * Denying somebody else's badge, which is not the same as calling them mafia
   * and was being flattened into `accuse` — losing the one thing that makes it
   * checkable, which is *which* badge is contested. Two seats claiming one role
   * is already a contradiction the board knows how to price; one seat denying
   * another's claim is the same contradiction asserted by a voice that can
   * itself be weighed.
   */
  | 'counter-claim'
  /**
   * "Spare me and I will prove it tonight."
   *
   * A bet the room can settle, which is rarer and worth more than a bluff. The
   * Town Crier speaks anonymously in the dark and can give that up to name
   * itself; a Mayor can reveal; a Sheriff can name tomorrow's check in advance.
   * Each converts an unfalsifiable claim into one the next dawn either confirms
   * or hangs them for — and gives the town a reason to wait a day rather than
   * pull the rope on a board with nothing on it.
   */
  | 'promise'
  /**
   * "The sheriff checked 3 and got nothing."
   *
   * Somebody else's claim, repeated. Real tables run on this and the board had
   * no way to tell it from a firsthand report, which matters because it is the
   * cheapest lie available: nobody can fabricate the Sheriff's check, but
   * anybody can fabricate having *heard* it. Carried with the seat it is
   * attributed to, so it can be weighed below the thing it claims to relay and
   * contradicted by the seat it is put in the mouth of.
   */
  | 'relay';

/** A public statement about a house. `truthful` is ground truth, sim-stamped. */
export interface Claim {
  day: number;
  claimerSlot: number;
  targetSlot: number;
  kind: ClaimKind;
  truthful: boolean;
  /**
   * How sure whatever filed this was that it is what the seat actually said.
   *
   * A bot's own line is certain: it wrote the sentence and the claim from one
   * decision, so there is nothing to misread. Everything a *person* types is
   * read by a machine — the instant parser off a handful of cue words, the ear
   * off a model — and neither is ever sure. "He is the bad guy" was filed as a
   * clearing of the man being accused; "OK On Nami now" as a vote of confidence
   * in Nami. Both from one real afternoon.
   *
   * So a reading carries what it should count for, and the weighing reads it: a
   * misfiled claim now costs the board a fraction of what a certain one does
   * rather than the same. Absent means certain, which leaves every claim the
   * bots file about themselves exactly where it was.
   */
  confidence?: number;
  /**
   * The night this is *about*, when it is about a night at all.
   *
   * `day` means two different things depending on where the claim came from,
   * and always has: a spoken claim carries the day it was said, so the night it
   * describes is the one before; a claim read out of a will carries the night
   * itself, because that is what the record it was built from stores. The board
   * knew this and worked around it for deduplication, and the driver did not —
   * so every reason a bot gave off a dead seat's will named a night one too
   * early. "You were seen on night 2" about a sighting made on night 3, which
   * the room can check and find false, from the one source that was telling the
   * truth. Reported from a real table.
   *
   * So the night is written down rather than inferred. Absent on a claim that
   * is not about a night, and on one built before this existed, where the old
   * guess is still the best available.
   */
  night?: number;
  /**
   * urge only: which way the speaker is pushing the day.
   *
   * `vote` is "we have to hang somebody", `skip` is "there is nothing here
   * today". Read by `steadyVote`, which otherwise decides that on its own and
   * decides it instantly.
   */
  urge?: 'vote' | 'skip';
  /**
   * counter-claim only: the badge being denied to `targetSlot`.
   *
   * Without it the denial is just an accusation and the room cannot check the
   * thing that makes it answerable — whether anybody else is standing up for
   * that same role.
   */
  deniedRole?: RoleId;
  /**
   * promise only: what the speaker is offering to prove, and by when.
   *
   * `night` is a thing the next dawn settles — the Crier naming itself in the
   * dark, a Sheriff announcing tomorrow's check in advance. `now` is settled on
   * the spot, which is the Mayor's sash. Kept apart because only the first is a
   * reason to *wait*, and waiting is the whole point of hearing it.
   */
  promise?: 'night' | 'now';
  /**
   * sighting only: the doorstep they were seen on.
   *
   * The single most useful number in the game and it was being thrown away. A
   * sighting recorded *who* was seen out and never *where*, so "4 was out last
   * night" and "4 was standing on the doorstep of the house that died last
   * night" were the same claim on the board, worth the same 0.5, when the
   * second is very nearly a confession and the first is nothing at all.
   *
   * The information always existed: a Lookout watches one named house, a
   * Detective follows one seat to named houses, and both had it in hand at the
   * moment they published. Optional because a person saying "I saw 4 moving
   * about" genuinely does not know the destination, and a sighting with no
   * doorstep is still worth what it always was.
   */
  at?: number;
  /**
   * relay only: the seat this is being attributed to.
   *
   * The speaker is not making this claim, they are reporting it. Weighed below
   * a firsthand claim and answerable by the seat named, who can simply say they
   * never said it.
   */
  relayedFrom?: number;
  /** role-claim only: "je suis <rôle>" (targetSlot is the claimer). */
  claimedRole?: RoleId;
  /**
   * account only: what the claimer says they did last night. `home` means
   * "I went nowhere"; otherwise `targetSlot` is the house they admit visiting.
   */
  account?: 'home' | 'visited';
  /**
   * ailing only: what the claimer says happened to them last night.
   *
   * `poison` and `douse` are things still working on them. The other three are
   * an attack that failed, and they are a different kind of evidence: they say
   * a *killer* picked this house, and — for `healed` and `guarded` — that a
   * protective role is alive and was pointed here. `guarded` is the one the
   * room can check without trusting anybody, because a bodyguard who steps in
   * front of a knife is a corpse in the morning report.
   */
  ailment?:
    | 'poison'
    | 'douse'
    | 'healed'
    | 'guarded'
    | 'survived'
    | 'silenced'
    | 'blocked'
    | 'controlled'
    | 'bussed'
    | 'jailed';
  /**
   * The room it was said in. Absent means the square, which everybody heard.
   *
   * The board is one object and every bot reads it, so a claim taken from a
   * family channel, a cell or a whisper had to be kept off it entirely or a
   * town seat's suspicion would move on words it could not possibly have
   * heard. That is the worst kind of bug this game can have: from the outside
   * it looks like a bot being clever. With the room on the claim, the ledger
   * can be filtered per reader against the same `chatRules` the chat itself
   * obeys, and a private room can be listened to without leaking out of it.
   */
  room?: string;
}

/** One day's closing accusation, for the town's pattern-readers. */
export interface VoteRecord {
  day: number;
  voterSlot: number;
  targetSlot: number;
}

/** One completed trial as the whole town saw it: verdicts included. */
export interface TrialRecord {
  day: number;
  accusedSlot: number;
  lynched: boolean;
  guiltySlots: number[];
  innocentSlots: number[];
}

/** What every seat can see. Built by the simulator each decision round. */
export interface PublicInfo {
  day: number;
  aliveSlots: number[];
  /** Revealed graveyard: slot -> role. */
  deadRoles: Map<number, RoleId>;
  /** Who died last night, for morning deductions. */
  lastNightDeathSlots: Set<number>;
  /** All night deaths so far — "a quiet night" only means something after loud ones. */
  nightDeathsTotal: number;
  /**
   * Corpses signed by the solo killers (SK, arsonist) so far — public, since
   * the dawn report names the weapon. Past 2, everyone smells the bigger
   * threat and even the mafia briefly votes with the town.
   */
  rampage: number;
  /** Current running accusations: voter slot -> target slot. */
  votes: Map<number, number>;
  /** Every seat that ever died, cleaned corpses included. */
  totalDead: number;
  /** Completed trials with their public ballots. */
  trials: TrialRecord[];
  /** Final accusations of past days: who was pushing whom. */
  voteHistory: VoteRecord[];
  revealedMayorSlot: number | null;
  /**
   * Every role the published list says this table could contain.
   *
   * Public knowledge — the roster is on every screen — and it is what makes a
   * lie answerable. "A doctor healed me" is a bluff worth telling at a table
   * with a doctor on the list and an announcement that the teller cannot count
   * at one without; "I was blackmailed" said where no role can gag anybody is
   * not a bluff, it is a confession that the speaker has not read the roster
   * the rest of the room is looking at. Categories are expanded to their pool,
   * so a `town-protective` slot counts as every protective role it might be.
   *
   * Optional because a board can be built by hand in a test; absent reads as
   * "unknown", and the checks that use it fall back to allowing the claim.
   */
  rolesInPlay?: ReadonlySet<RoleId>;
  /**
   * How many copies of each role the deal can contain, from the same roster.
   *
   * The number `unique` was standing in for, and standing in for badly: the
   * flag is engine semantics (there is one Jailor) and says nothing about the
   * Sheriff, the Doctor or the Lookout, which are the badges a liar actually
   * reaches for. A category slot counts as one copy of everything it might be,
   * so this is an upper bound and a claim is only called contested when even
   * the most generous reading of the roster cannot fit it.
   *
   * Optional for the same reason as `rolesInPlay`: a hand-built test board has
   * none, and absent falls back to the old flag.
   */
  dealCopies?: ReadonlyMap<RoleId, number>;
  /**
   * The seats a person is sitting in, which the roster shows anyway.
   *
   * Not a secret — every screen prints a marker beside a bot's name — and it is
   * what lets `claimerWeight` hear a person differently from a machine. See the
   * note there.
   */
  humanSlots: Set<number>;
  trialSlot: number | null;
  claims: Claim[];
  /**
   * Every death the table was told about, with what killed it.
   *
   * The dawn report names the weapon even when the janitor took the face, so the
   * source is public knowledge whatever the reveal policy. `deadRoles` answers
   * "what was this corpse"; this answers "when did it die and to whom", which is
   * the half a will has to be joined against.
   */
  deaths: { slot: number; day: number; phase: 'day' | 'night'; source: DeathSource | null }[];
  /**
   * Roles the board can vouch for on living seats, and how it knows.
   *
   * Not what people *claim*: that is on the claims board and weighed like any
   * other word. This is what the record *proves*: a corpse's will says it went
   * to house 4 on the night the dawn report says the Veteran shot it, so 4 is
   * the Veteran. A living seat that claimed Sheriff and whose accusation then
   * hanged a mafioso has a badge the graveyard signed for. Read by the trust
   * weights, the shortlist and the night planners, so a proven Veteran's porch
   * is a place nobody goes and a proven Sheriff's word is the loudest voice in
   * the room.
   */
  provenRoles: Map<number, RoleId>;
}

export interface Brain {
  slot: number;
  personality: Personality;
  /** Slots this investigator already checked, to spread the net. */
  checked: Set<number>;
  /** Killers only: who I went for last night, for the failed-kill deduction. */
  lastKillTarget: number | null;
  /**
   * How cornered this seat feels, 0..1, carried between rounds. Starts calm on
   * day zero and is advanced once per day by `feelPressure`.
   */
  desperation: number;
  /** Where I actually went last night, so `account` can be honest — or not. */
  wentTo: number | null;
  /** The way this seat plays the whole game, for the two roles that get to choose one. See `styleOf`. */
  style: Style | null;
}

/**
 * How a Jester or a Survivor has decided to play, chosen once and kept.
 *
 * Two roles whose win has nothing to do with who else wins, and therefore
 * nothing that tells the table how they will vote. A single scripted habit
 * would: after three games everybody knows the Jester votes at random and the
 * Survivor votes with the town, and both are then read straight through. So
 * each seat rolls a style at its first decision and plays it to the end, and
 * from outside the two styles look like two different people.
 *
 *  - A `clown` Jester is the one this file has always had: odd accusations,
 *    a big checkable claim once he has been ignored long enough, ballots cast
 *    at random. He gets hanged for being noise.
 *  - A `scum` Jester plays like a mafioso with no self-control: guilty on the
 *    seats the room trusts, innocent on the ones it has caught, always on the
 *    wagon when the wagon is on a townsperson and conspicuously off it when it
 *    is not. He gets hanged by the town's own trust model, which prices an
 *    innocent ballot on a revealed evil as the loudest tell in the game.
 *  - A `hurried` Survivor wants the game over, because every extra night is
 *    another knife that might pick his door: from day four he rides the
 *    biggest wagon and votes guilty on the stand.
 *  - A `careful` Survivor votes as a cautious townsperson does, which is what
 *    every Survivor did before there was a choice.
 *
 * Whatever the style, a Survivor follows the tide (see `tide`): when the town
 * is losing, its suspects are the wrong wagon to be on, and he rides the
 * biggest one instead; when the town is winning he votes with it. The side
 * can change during a game and so does he, which is the one thing about him
 * the table *can* read, if it is paying attention.
 */
export type Style = 'clown' | 'scum' | 'hurried' | 'careful';

/** The seat's style, rolled at first use with the game's own dice and kept on the brain. */
export function styleOf(self: MafiaPlayer, brain: Brain, rng: () => number): Style | null {
  if (self.role !== 'jester' && self.role !== 'survivor') return null;
  if (!brain.style) {
    brain.style = self.role === 'jester' ? (rng() < 0.5 ? 'clown' : 'scum') : rng() < 0.5 ? 'hurried' : 'careful';
  }
  return brain.style;
}

/**
 * Which side is winning, read off what every seat can see.
 *
 * The town's parity clock says when the town is losing; a graveyard holding
 * nearly every evil the roster implies, with the clock quiet, says when it is
 * winning. Between the two the game is open. Used by the Survivor, whose only
 * interest in the answer is which wagon ends the game soonest with him alive.
 */
export function tide(info: PublicInfo): 'town' | 'evil' | 'even' {
  const clock = parityPressure(info);
  if (clock >= 0.6) return 'evil';
  const initial = info.aliveSlots.length + info.totalDead;
  const expectedEvils = Math.max(1, Math.round(initial * 0.3));
  const deadEvils = [...info.deadRoles.values()].filter((role) => isEvilRole(role)).length;
  if (clock === 0 && deadEvils >= expectedEvils - 1) return 'town';
  return 'even';
}

/** A fresh brain, calm and with nothing to hide yet. */
export function makeBrain(slot: number, personality: Personality): Brain {
  return {
    slot,
    personality,
    checked: new Set<number>(),
    lastKillTarget: null,
    desperation: CALM,
    wentTo: null,
    style: null
  };
}

export function makePersonality(profile: Personality, rng: () => number): Personality {
  const jitter = (value: number) => Math.min(1, Math.max(0, value + (rng() - 0.5) * 0.4));
  /**
   * A coefficient, rolled once and kept for the game.
   *
   * Flat across the range rather than clustered on 1: a table where everybody
   * is nearly average is a table of one character, and the whole reason these
   * exist is that the seat which sits on a Sheriff hit for two days and the
   * seat which blurts it at dawn should both be at it.
   */
  const coefficient = () => TEMPERAMENT_MIN + rng() * (TEMPERAMENT_MAX - TEMPERAMENT_MIN);
  return {
    aggression: jitter(profile.aggression),
    herd: jitter(profile.herd),
    claimRate: jitter(profile.claimRate),
    deceit: jitter(profile.deceit),
    courage: jitter(profile.courage),
    temperament: { nerve: coefficient(), suspicion: coefficient(), haste: coefficient() },
    // Carried through untouched: a habit is a habit, not a meter to roll.
    quirks: profile.quirks ?? NO_QUIRKS
  };
}

/**
 * How many seats could be wearing one badge, as the room can work out.
 *
 * Falls back to the `unique` flag when the board was built without a roster,
 * which keeps every hand-written test reading exactly as it did.
 */
export function copiesOf(info: PublicInfo, role: RoleId): number {
  /**
   * A unique role is unique whatever the roster says.
   *
   * `unique` is the dealer's own guarantee: every setup, `chaos` included,
   * refuses to deal a second Jailor or a second Godfather. The roster, on the
   * other hand, describes what a *slot* might turn out to be — and a chaos
   * table's slots are all "any", so counting them gives the Jailor twenty-four
   * possible copies and no two claimants can ever contradict each other.
   *
   * Which is what happened: on a live chaos table two seats claimed badges
   * nobody could be wearing twice and the board scored it at nothing, because
   * the count replaced the flag instead of standing beside it. The flag is a
   * ceiling, the count is a ceiling, and the truth is the lower of the two.
   */
  const capped = roleDef(role).unique ? 1 : Number.POSITIVE_INFINITY;
  const counted = info.dealCopies?.get(role);
  return counted === undefined ? capped : Math.min(capped, counted);
}

export function isEvilRole(role: RoleId): boolean {
  return familyOf(role) !== null || isSoloKiller(role);
}

/** Reads SUSPECT to a sheriff without being anyone's enemy (the scumbag). */
function harmlessSuspect(role: RoleId): boolean {
  return !!roleDef(role).suspicious && !isEvilRole(role);
}

/* ------------------------- the investigator's nose ------------------------- */

/**
 * Every role an investigator's trade line could be pointing at.
 *
 * The result of an examine is not a name, it is a *smell*: gunpowder, new rope,
 * ink on the fingers. Several roles share each one, and which roles those are is
 * public — the line is the same at every table. So the finding is a shortlist,
 * and a shortlist is evidence in exactly the way a name is not: it narrows.
 */
export function rolesWithTrade(trade: string): RoleId[] {
  return (Object.keys(ROLES) as RoleId[]).filter((role) => roleDef(role).investigated === trade);
}

/**
 * What a shortlist is worth once you cross off the roles this table cannot hold.
 *
 * The whole point of the mechanic, and the thing that decides whether a finding
 * is an accusation, a defence or a shrug:
 *
 *  - **damning** — every role it could be is somebody's enemy. New rope is the
 *    Kidnapper or the Interrogator and there is no third option, so the seat
 *    that smells of it is caught;
 *  - **clean** — every role it could be is town. Well-kept hands are the
 *    Doctor's and nobody else's, which is a seat worth standing up for;
 *  - **mixed** — gunpowder is a Vigilante *or* a Mafioso, which is why the
 *    Investigator is a hint machine rather than a Sheriff.
 *
 * `rolesInPlay` is what makes this sharp. A table whose roster has no Vigilante
 * turns gunpowder from a shrug into a conviction, and the room can work that out
 * for itself because the roster is on the wall — so a bot that reasons this way
 * is reasoning from something a person at the same table could check.
 */
/** Sharpest first: a conviction outranks an exoneration outranks a shrug. */
const rank = (verdict: 'damning' | 'clean' | 'mixed'): number =>
  verdict === 'damning' ? 2 : verdict === 'clean' ? 1 : 0;

export function tradeVerdict(trade: string, rolesInPlay?: ReadonlySet<RoleId>): 'damning' | 'clean' | 'mixed' {
  /**
   * "Nothing to hide" is never an exoneration.
   *
   * A seat that took no night action at all comes back with this line whatever
   * it is — see the examiner in the engine — so a Mafioso on a night the family
   * sent somebody else reads exactly like a Citizen. That makes it the one
   * trade whose shortlist lies: the roles that *wear* it are harmless, and the
   * roles that can *produce* it are everybody. It stays a shrug forever.
   */
  if (trade === QUIET_TRADE) return 'mixed';
  const all = rolesWithTrade(trade);
  const possible = rolesInPlay ? all.filter((role) => rolesInPlay.has(role)) : all;
  const shortlist = possible.length > 0 ? possible : all;
  if (shortlist.every((role) => isEvilRole(role))) return 'damning';
  if (shortlist.every((role) => roleDef(role).faction === 'town')) return 'clean';
  return 'mixed';
}

/* -------------------------------- trust ---------------------------------- */

/**
 * The trust meter: what the public record says about a seat's *behavior*.
 * Positive = has acted like town, negative = has acted like its enemy.
 *
 * Reads come from the published trial ballots, judged against what the town
 * has learned since: voting to SAVE someone later revealed evil is the
 * loudest tell in the game (−2.5); guilty on a revealed evil earns trust;
 * guilty on a mislynched townie costs it. Recomputed from scratch every time,
 * so a spared player's later death re-scores every old ballot retroactively.
 */
/**
 * Could somebody at this table still do that to you tonight?
 *
 * The test every lie about an effect has to pass. A seat claiming it was
 * blackmailed, healed, poisoned or doused is claiming that a role which does
 * that thing is sitting at the table and used its night — so if the published
 * roster contains no such role, or the only ones it could contain are lying in
 * the graveyard with their names on, the claim is not a bluff. It is a sentence
 * the whole room can disprove from the two screens it is already looking at.
 *
 * Deliberately generous where it is unsure: an unknown roster (a board built by
 * hand, a chaos table that promises nothing) allows the claim, and so does a
 * corpse the game refused to identify. A liar should be caught by evidence, not
 * by this function guessing.
 */
export function couldStillAct(action: NightActionType, info: PublicInfo): boolean {
  const capable = (Object.keys(ROLES) as RoleId[]).filter((role) => roleDef(role).nightAction === action);
  const possible = info.rolesInPlay ? capable.filter((role) => info.rolesInPlay!.has(role)) : capable;
  if (possible.length === 0) return false;
  const buried = new Set(info.deadRoles.values());
  return possible.some((role) => !buried.has(role));
}

export function trustOf(slot: number, info: PublicInfo, through: Temperament = EVEN_TEMPERAMENT): number {
  let trust = 0;
  for (const trial of info.trials) {
    const revealed = info.deadRoles.get(trial.accusedSlot);
    if (!revealed) continue; // fate still unknown (alive, or a cleaned corpse)
    const guilty = trial.guiltySlots.includes(slot);
    const innocent = trial.innocentSlots.includes(slot);
    if (!guilty && !innocent) continue;

    if (isEvilRole(revealed)) {
      /**
       * A guilty vote is worth what it cost to cast.
       *
       * Every correct rope paid the same flat point, and the commonest rope in
       * the game is the one the whole room was already pulling — including the
       * family, whose own policy is to vote with the room on a brother it
       * cannot save. So the cheapest possible ballot, joining a verdict that
       * was never in doubt, bought the same credit as standing alone against
       * ten people and being right.
       *
       * A killer can farm the flat version, and did: a seat that voted with the
       * room on two hanged evils came out of it as the most trusted person at
       * the table and could not be convicted of anything afterwards. So the
       * credit scales with how divided the room was — near nothing when nobody
       * disagreed, most of a point when the verdict was close and the vote
       * genuinely said something.
       */
      const cast = trial.guiltySlots.length + trial.innocentSlots.length;
      const divided = cast > 0 ? trial.innocentSlots.length / cast : 0;
      if (guilty) trust += 0.2 + 0.9 * divided;
      if (innocent) trust -= 2.5; // tried to save the mafia, in public
    } else if (roleDef(revealed).faction === 'town') {
      if (guilty) trust -= 1.2;
      if (innocent) trust += 0.8;
    }
    // Jester and other harmless suspects: an honest mistake either way.
  }
  // Read through the reader: the meter is public, how much it moves you is not.
  return trust * through.suspicion;
}

/**
 * Tunnel vision is a tell: someone voting the same head day after day with
 * no evidence behind it smells like an executioner's obsession.
 */
export function monomaniacScore(slot: number, info: PublicInfo): number {
  const targets = info.voteHistory.filter((entry) => entry.voterSlot === slot);
  const byTarget = new Map<number, Set<number>>();
  for (const entry of targets) {
    byTarget.set(entry.targetSlot, (byTarget.get(entry.targetSlot) ?? new Set()).add(entry.day));
  }
  for (const [targetSlot, days] of byTarget) {
    if (days.size < 3) continue;
    const evidence = info.claims.some(
      (claim) => claim.kind === 'accuse' && claim.targetSlot === targetSlot && claim.claimerSlot !== slot
    );
    if (!evidence) return 2;
  }
  return 0;
}

/**
 * The parity clock. When the living evils are one bad day away from parity,
 * not lynching *is* losing: pressure rises from 0 (comfortable) to 1 (LyLo).
 * Evils-remaining is an estimate from public data — expected share of the
 * original table, minus the confirmed evil corpses.
 */
export function parityPressure(info: PublicInfo): number {
  const alive = info.aliveSlots.length;
  const initial = alive + info.totalDead;
  const expectedEvils = Math.max(1, Math.round(initial * 0.3));
  const deadEvils = [...info.deadRoles.values()].filter((role) => isEvilRole(role)).length;
  const evilsLeft = Math.max(info.lastNightDeathSlots.size > 0 ? 1 : 0, expectedEvils - deadEvils);
  const margin = alive - 2 * evilsLeft;
  if (margin <= 1) return 1;
  if (margin <= 3) return 0.6;
  if (margin <= 5) return 0.3;
  return 0;
}

/* ----------------------------- desperation ------------------------------- */

/**
 * How badly this seat's side is losing, 0..1 — the floor under its panic.
 *
 * Deliberately asymmetric, because "losing" means opposite things across the
 * table. The town loses to the parity clock. A family loses when its own numbers
 * thin out and the graveyard fills with its colours. A butcher, having no bloc,
 * measures how few strangers are left to hide among. And a Jester "loses" by
 * being ignored, which is why his clock runs on *inattention*.
 */
export function losingClock(self: MafiaPlayer, agenda: Agenda, info: PublicInfo, allies: ReadonlySet<number>): number {
  if (agenda === 'jester') {
    // Nobody has looked at him in days: that is his emergency.
    const heat = votesAgainst(self.slot, info) + (info.trialSlot === self.slot ? 3 : 0);
    const ignored = Math.max(0, 1 - heat / 3);
    return info.day >= 3 ? ignored : ignored * 0.4;
  }

  if (agenda === 'town' || agenda === 'passenger' || agenda === 'parasite') {
    // The parity clock, straight. Parasites read it inverted below.
    const clock = parityPressure(info);
    return agenda === 'parasite' ? Math.max(0, 1 - clock) * 0.5 : clock;
  }

  // Families and butchers: how thin am I, and how much of my side is already cold.
  const mine = [...allies].filter((slot) => info.aliveSlots.includes(slot)).length + 1;
  const theirs = Math.max(1, info.aliveSlots.length - mine);
  const buried = [...info.deadRoles.values()].filter((role) => isEvilRole(role)).length;
  const thin = Math.min(1, Math.max(0, 1 - mine / Math.max(2, theirs)));
  return Math.min(1, thin * 0.75 + Math.min(0.35, buried * 0.12));
}

/**
 * Advances one seat's desperation for the day and hands back the stance it
 * implies. Called once per dawn, before anything is decided, so every choice
 * that morning is made in the same mood.
 */
export function feelPressure(
  self: MafiaPlayer,
  brain: Brain,
  info: PublicInfo,
  allies: ReadonlySet<number>
): { agenda: Agenda; stance: Stance; desperation: number } {
  const agenda = agendaOf(self.role!);
  const outed = info.claims.some(
    (claim) => claim.kind === 'role-claim' && claim.targetSlot === self.slot && claim.claimerSlot !== self.slot
  );
  /**
   * The Jester's meter runs on being ignored, and on nothing else.
   *
   * For everybody else a wagon is a spike; for him it is the plan working, so
   * counting it as pressure sent his meter up in both cases and the stance
   * could not tell a Jester nobody looks at from one on the stand. His floor,
   * from `losingClock`, is already how ignored he is; the personal spikes are
   * switched off so the meter reads that and only that.
   */
  const jester = agenda === 'jester';
  const pressure: Pressure = {
    day: info.day,
    aliveCount: info.aliveSlots.length,
    votesAgainstMe: jester ? 0 : votesAgainst(self.slot, info),
    onTrial: jester ? false : info.trialSlot === self.slot,
    roleOuted: jester ? false : outed,
    targetedLastNight: jester
      ? false
      : self.intel.some((entry) => entry.night === info.day - 1 && entry.kind === 'saved'),
    losingClock: losingClock(self, agenda, info, allies)
  };
  brain.desperation = advanceDesperation(brain.desperation, pressure, brain.personality.temperament.nerve);
  return {
    agenda,
    desperation: brain.desperation,
    stance: stanceOf(agenda, brain.desperation, brain.personality)
  };
}

/**
 * Seats caught out by their own mouth: they said they stayed home, and somebody
 * credible says they saw them out.
 *
 * The evidence has to be a **sighting** specifically — a lookout's doorstep, a
 * detective's tail, a spy's ear — and not merely an accusation. That distinction
 * is the whole mechanism. Accepting any credible accusation as a contradiction
 * was the first version, and it did the opposite of its job: it made "I stayed
 * home" a liability for the honest (a framed townie telling the truth got hit
 * twice) while adding no information the board did not already have. Measured
 * cost of that mistake: correct lynches fell by up to nine points and the
 * families picked up every one of them.
 *
 * Now the loop is tight. Asking is cheap, answering is forced, "home" is the
 * comfortable lie, and exactly one kind of role can prove it false — so the
 * town's afternoon of questions is worth having, and the liar's risk is real.
 */
/**
 * The floor a voice has to clear to be worth listening to at all.
 *
 * Not "fully believed" — that used to be the test, written as a weight of one,
 * back when an ordinary seat weighed exactly one. An ordinary seat now weighs
 * less than that until it has shown the room something (see `claimerWeight`),
 * and leaving the test where it was quietly switched the contradiction
 * mechanic off for the first three days of every game: nobody could catch
 * anybody, because nobody had proved anything yet. What the test always meant
 * was "somebody the room has not already written off", and that is what it now
 * says: a proven liar is out, a seat caught saving evils is out, and a
 * stranger with an ordinary reputation is a witness like anybody else.
 */
const CREDIBLE = 0.6;

export function contradicted(slot: number, info: PublicInfo): boolean {
  /**
   * The account a seat is standing on *now*, not every account it has ever
   * given.
   *
   * People correct themselves. "I stayed home — no wait, I went to 4's, sorry"
   * is one person remembering, and reading it as two stories held at once hangs
   * them for the sentence they withdrew. It matters more since human speech
   * started reaching the board: a reader that turns one hesitant sentence into
   * an alibi has handed the town a rope, and the person it hangs never said the
   * thing they are being hanged for.
   *
   * So the newest account wins outright. A seat that now admits going out is
   * not caught by a sighting; a seat that has said nothing since "I was home"
   * still is, which is the catch this function exists for.
   */
  const accounts = info.claims.filter((claim) => claim.kind === 'account' && claim.claimerSlot === slot);
  const standing = accounts[accounts.length - 1];
  if (!standing || standing.account !== 'home') return false;
  return info.claims.some(
    (claim) =>
      claim.kind === 'sighting' &&
      claim.targetSlot === slot &&
      claim.claimerSlot !== slot &&
      claimerWeight(claim.claimerSlot, info) >= CREDIBLE
  );
}

/**
 * Process of elimination: the seats that could still be the killer, once the
 * cleared, the trusted and the accounted-for are crossed off. When this set
 * gets small, the town stops guessing and starts counting.
 */
export function possibilitySet(self: MafiaPlayer, info: PublicInfo): Set<number> {
  const remaining = new Set(info.aliveSlots.filter((slot) => slot !== self.slot));
  for (const slot of [...remaining]) {
    // Own hard clears.
    if (self.intel.some((entry) => entry.targetSlot === slot && entry.kind === 'sheriff' && entry.value === 'clear')) {
      remaining.delete(slot);
      continue;
    }
    // Public clears from credible voices.
    const clearScore = info.claims
      .filter((claim) => claim.kind === 'clear' && claim.targetSlot === slot)
      .reduce((sum, claim) => sum + claimerWeight(claim.claimerSlot, info), 0);
    if (clearScore >= 1.5) {
      remaining.delete(slot);
      continue;
    }
    // Behavioral trust: someone who has repeatedly hanged evils isn't one.
    if (trustOf(slot, info) >= 1.5) remaining.delete(slot);
    // A role the record proved, and it is a town one.
    const proven = info.provenRoles.get(slot);
    if (proven && roleDef(proven).faction === 'town') remaining.delete(slot);
  }
  return remaining;
}

/* ------------------------------ credibility ------------------------------ */

/**
 * The price of lying, and the reward for being right. An accusation that died
 * town — or a clear that died evil — zeroes the claimer's voice forever; an
 * accusation that died evil makes them a proven sheriff whose word doubles.
 */
/**
 * The town's investigative badges: roles whose word is a checkable report.
 *
 * Every one of them, not only the Sheriff. A Lookout's list of callers, a
 * Detective's tail, a Coroner's autopsy and an Investigator's trade line are
 * each a night's work the room can hold against later events, so a seat that
 * claims any of them is making the same kind of promise a Sheriff makes.
 * Read by the credibility weights and by the proven-role deduction.
 */
export const BADGE_ROLES: ReadonlySet<RoleId> = new Set<RoleId>([
  'sheriff',
  'investigator',
  'lookout',
  'detective',
  'coroner',
  'spy'
]);

/**
 * The badge this seat wears, if it claimed one and nobody living disputes it.
 *
 * The latest role a seat claimed for itself, when that role is investigative,
 * no other living seat claims the same one, and, for a unique role, the
 * graveyard has not already produced its holder. Null otherwise: a contested
 * badge is at least one liar, and neither claimant gets the benefit until the
 * room sorts them out.
 */
/**
 * Where a board's derived answers are kept, and why it is not a WeakMap.
 *
 * Several things here are pure functions of the board and are asked the same
 * question hundreds of times per decision. They used to cache against the board
 * object's identity, which was correct and nearly useless: `toPublicInfo` hands
 * back a fresh object whenever a single vote moves, and a vote moves on almost
 * every read during the afternoon, so the caches were thrown away four times a
 * day per seat.
 *
 * The builder therefore hangs a scratch container on the board and carries the
 * *same* container onto the next board whenever only the votes changed, so what
 * does not depend on the votes survives. It is attached non-enumerably, so a
 * caller that builds a variant with `{ ...board, voteHistory }` gets a board
 * with no container and falls back to the map below, which is keyed by identity
 * and therefore always correct. See `BoardMemo` in `observe.ts`.
 */
export const BOARD_MEMO = Symbol.for('mafia.boardMemo');

const LOOSE_MEMO = new WeakMap<PublicInfo, Record<string, unknown>>();

function boardMemo(info: PublicInfo): Record<string, unknown> {
  const carried = (info as unknown as Record<symbol, unknown>)[BOARD_MEMO];
  if (carried) return carried as Record<string, unknown>;
  let loose = LOOSE_MEMO.get(info);
  if (!loose) {
    loose = {};
    LOOSE_MEMO.set(info, loose);
  }
  return loose;
}

export function uncontestedBadge(slot: number, info: PublicInfo): RoleId | null {
  return badgesOf(info).get(slot) ?? null;
}

/**
 * Every seat's badge, worked out once per board.
 *
 * `claimerWeight` asks about a badge for every claim it weighs, and it is
 * itself asked for every claim about every seat on every decision, so a
 * per-call scan of the claims list made the bench a third slower. A board is
 * built fresh for each decision and never changes afterwards, so the answer is
 * computed on first ask and kept with the board.
 */
const BADGES = new WeakMap<PublicInfo, Map<number, RoleId>>();

function badgesOf(info: PublicInfo): Map<number, RoleId> {
  const cached = BADGES.get(info);
  if (cached) return cached;

  // The latest badge each seat claimed for itself.
  const claimed = new Map<number, RoleId>();
  for (const claim of info.claims) {
    if (claim.kind === 'role-claim' && claim.claimedRole && BADGE_ROLES.has(claim.claimedRole)) {
      claimed.set(claim.claimerSlot, claim.claimedRole);
    }
  }
  // How many living seats wear each one.
  const wearers = new Map<RoleId, number>();
  for (const [slot, role] of claimed) {
    if (info.aliveSlots.includes(slot)) wearers.set(role, (wearers.get(role) ?? 0) + 1);
  }
  const badges = new Map<number, RoleId>();
  for (const [slot, role] of claimed) {
    const others = (wearers.get(role) ?? 0) - (info.aliveSlots.includes(slot) ? 1 : 0);
    if (others > 0) continue;
    if (
      roleDef(role).unique &&
      [...info.deadRoles.entries()].some(([dead, buried]) => dead !== slot && buried === role)
    ) {
      continue;
    }
    badges.set(slot, role);
  }
  BADGES.set(info, badges);
  return badges;
}

/**
 * This seat's record of calls the graveyard has since settled, on one number.
 *
 * Positive means it named killers and they were killers. Negative means it
 * named neighbours, or vouched for a murderer.
 *
 * Read twice, for two different questions, which is why it lives out here.
 * `claimerWeight` asks *how loudly this seat is heard*, because a voice that
 * has been wrong is a quieter voice. `suspicionParts` asks *whether this seat
 * is one of them*, because a voice that has been wrong repeatedly, in the
 * direction that helps the killers, is doing what a killer does. They are not
 * the same question and the old code conflated them into one cliff at zero.
 *
 * Fading with age on purpose: a misread on day two is not what a room is
 * arguing about on day ten, and a ledger that never forgets ends up being the
 * only thing on the board.
 */
export function settledCredit(claimerSlot: number, info: PublicInfo): number {
  let credit = 0;
  for (const claim of info.claims) {
    if (claim.claimerSlot !== claimerSlot) continue;
    const deadRole = info.deadRoles.get(claim.targetSlot);
    if (!deadRole) continue;
    const wasEvil = isEvilRole(deadRole);
    // Accusing a jester or a scumbag is an honest mistake — the sheriff's
    // needle genuinely points at them, so it costs nothing either way.
    const honestMiss = deadRole === 'jester' || harmlessSuspect(deadRole);
    const fade = 1 / (1 + Math.max(0, info.day - claim.day) * 0.2);
    if (claim.kind === 'accuse') credit += (wasEvil ? 1 : honestMiss ? 0 : -1.1) * fade;
    else if (claim.kind === 'clear') credit += (wasEvil ? -1.6 : 0.6) * fade;
  }
  return credit;
}

export function claimerWeight(claimerSlot: number, info: PublicInfo): number {
  let weight = 1;

  // A dead claimer's words are read against their revealed role: a town
  // corpse's testament is gospel, a revealed liar's testament is kindling.
  // A janitor-cleaned corpse keeps full weight — nobody knows what it was,
  // which is exactly why fake wills and cleaners are dangerous together.
  const claimerDeadRole = info.deadRoles.get(claimerSlot);
  if (claimerDeadRole) {
    if (isEvilRole(claimerDeadRole) || claimerDeadRole === 'jester' || harmlessSuspect(claimerDeadRole)) return 0;
    if (roleDef(claimerDeadRole).faction === 'town') weight = 1.6;
    else weight = 0.3; // a dead neutral's will: read with one raised eyebrow
  }

  /**
   * Every settled claim this seat made, priced and added up.
   *
   * This was a cliff: one accusation on a seat that turned out town and the
   * voice was worth *nothing*, permanently, with no way back. Which reads as
   * strict and plays as a bug, because being wrong once is the normal condition
   * of an honest townie. A Sheriff whose check was framed, a Lookout who saw
   * the doctor arrive, anybody who read a nervous villager as a liar — all
   * silenced for the rest of the game, by the same rule, after doing exactly
   * what the town needs somebody to do. Meanwhile being right capped at 1.6, so
   * a wrong call was infinitely worse than a right one was good.
   *
   * Graded instead, and three things follow from that. A voice can *recover*:
   * two good calls outweigh one bad one, which is how a room actually treats
   * somebody. Old mistakes fade, because a day-two misread should not still be
   * silencing a seat on day ten. And clearing a killer stays the worst thing
   * you can do — it is the one move that is nearly always either the liar's or
   * the fool's — but it is a heavy debit rather than an execution.
   *
   * The floor is deliberate. A seat can become the least credible voice in the
   * room and never an inaudible one, because a board that cannot hear a seat at
   * all cannot be argued with by it either, and the seat it silences most
   * reliably is the honest one who spoke early.
   */
  const credit = settledCredit(claimerSlot, info);
  if (credit !== 0) {
    // Saturating, so a seat with six settled calls is not six times as loud as
    // one with a single call; being right is evidence, not a multiplier.
    const settled = 1 + 0.6 * Math.tanh(credit * 0.7);
    weight *= settled;
  }

  // Behavior colours the voice: a seat caught saving evils is half-heard,
  // a seat that keeps hanging them speaks louder.
  const trust = trustOf(claimerSlot, info);
  if (trust <= -2) weight *= 0.5;
  else if (trust >= 2) weight *= 1.3;

  /**
   * And a person is heard further than a machine.
   *
   * Not flattery: it is what the table is for. Twenty bots reading each other's
   * claims off a shared board agree far more readily than a room of people
   * does, so a human Sheriff spent an afternoon shouting into a square that had
   * already made up its mind among itself. Weighing a person half again as
   * heavily is the cheapest way to make the one seat that is actually playing
   * the loudest voice in the room, and — with the chorus discount in
   * `suspicionParts` — the anchor a wagon forms around rather than a footnote
   * to it.
   *
   * It cuts both ways, which is the point: a person who talks is heard, and a
   * person who is heard is worth killing. Every headless bench is all bots, so
   * this multiplies nothing there and the balance numbers still mean what they
   * meant.
   */
  if (info.humanSlots.has(claimerSlot)) weight *= 1.5;

  /**
   * A badge nobody has disputed is worth something before anybody dies.
   *
   * A living seat saying "I am the Sheriff, and 7 came back bad" used to be
   * heard exactly like a seat shouting "7 is bad" with no badge at all: until a
   * corpse settled it, the claim moved nothing. A real table does not play that
   * way. An investigative claim that no living rival contests and that the
   * graveyard has not already filled is provisionally believed, which is what
   * makes claiming worth the target it paints on the claimant, and what lets a
   * human investigator feel heard the afternoon they speak rather than a day
   * later. Every town investigative role counts, because a Lookout's list or a
   * Detective's tail is exactly as checkable as a Sheriff's verdict.
   *
   * Modest, and gone the moment it is contested. The living only: a corpse's
   * badge was settled by the graveyard above.
   */
  if (info.aliveSlots.includes(claimerSlot) && uncontestedBadge(claimerSlot, info) !== null) weight *= 1.3;

  /**
   * A badge the record signed for outranks everything above.
   *
   * A living seat whose role the board can prove is a town investigator speaks
   * as loudly as a town corpse's will, and louder than a stranger who happened
   * to guess right once. A proven evil is a voice worth nothing, whoever it is
   * still fooling.
   */
  const proven = info.provenRoles.get(claimerSlot);
  if (proven) {
    if (isEvilRole(proven)) return 0;
    if (roleDef(proven).faction === 'town') weight = Math.max(weight, 2.0);
  }

  /**
   * And a stranger is only a stranger.
   *
   * Everything above raises a voice for a reason: a badge nobody disputes, a
   * corpse the graveyard vouched for, a record of hanging the right people. A
   * seat with none of them has shown the room precisely nothing, and it was
   * still heard at full volume — so on day two, when *nobody* has shown
   * anything yet, twenty strangers agreeing with the first stranger to speak
   * was a case. Blind trust in somebody who has not earned any is the loudest
   * thing wrong with a table of bots, and it is loudest on the day there is
   * least to go on.
   *
   * So an unproven voice is discounted, and the discount lifts as the game
   * gives people chances to show what they are: a third off on the first days,
   * a fifth off later. It never reaches zero — a stranger saying "7 is lying"
   * is still worth hearing — and it does not touch anybody the record speaks
   * for, which is the whole point of speaking up.
   */
  const unproven =
    weight === 1 && !info.deadRoles.has(claimerSlot) && uncontestedBadge(claimerSlot, info) === null && !proven;
  if (unproven) weight *= info.day <= 3 ? 0.65 : 0.8;

  /**
   * The floor, and the two things that still go through it.
   *
   * A living seat is never worth nothing: it can be the least credible voice in
   * the room and still be a voice. The exceptions are both the graveyard's
   * doing — a corpse revealed evil, and a living seat whose role the record has
   * proven evil — and both returned zero above, before any of this.
   */
  return Math.max(weight, 0.2);
}

/**
 * Is this slot a proven liar in the public record?
 *
 * This used to be `claimerWeight(slot) === 0`, which made it a synonym for
 * "has been wrong once": accuse a seat that turns out town, and the weight
 * cliff drops you to zero, and this hands you +2.5 suspicion of your own. So
 * one bad read did not merely silence a townie, it nominated them — and since
 * the seat most likely to have made a public accusation early is a town
 * investigator, the town spent its afternoons hanging the people who had been
 * trying to help it, one after another, each hanging manufacturing the next
 * one's evidence. That is a chain reaction, and it ran on nothing.
 *
 * A lie is not a mistake. What is left here is the short list of things the
 * record can prove *nobody honest* does: vouching for a killer, and being one.
 */
export function provenLiar(slot: number, info: PublicInfo): boolean {
  const proven = info.provenRoles.get(slot);
  if (proven && isEvilRole(proven)) return true;
  const dead = info.deadRoles.get(slot);
  if (dead && isEvilRole(dead)) return true;
  // Vouched for somebody the graveyard then revealed as a killer. Either they
  // were lying or they were used, and the room cannot tell which.
  return info.claims.some((claim) => {
    if (claim.claimerSlot !== slot || claim.kind !== 'clear') return false;
    const role = info.deadRoles.get(claim.targetSlot);
    return role !== undefined && isEvilRole(role);
  });
}

/**
 * Two seats who have spent the whole game never voting for each other.
 *
 * The oldest read in Mafia and the one the model never made, despite the data
 * sitting in `voteHistory` untouched since it was added: a family votes
 * together and, far more tellingly, *never votes for its own*. Across eight
 * days the town will have scattered its votes everywhere, and the two seats
 * whose lines never once crossed are worth a look.
 *
 * Deliberately conservative. Three days of evidence minimum and two actual
 * co-votes, because on day two everybody looks like everybody's partner and a
 * confident accusation built on one coincidence is how a town lynches itself.
 * The number it returns is a nudge, not a verdict — it sits alongside the
 * evidence in `suspicion` rather than above it.
 */
/**
 * The ballots, indexed by day, with the table's own rate of agreeing with itself.
 *
 * Built once per board rather than per seat: `buddyScore` is asked about every
 * house by every seat on every pass, and it used to scan the whole history
 * twice per candidate partner.
 */
interface VoteIndex {
  /** day -> voter slot -> the house they closed the day on. */
  byDay: Map<number, Map<number, number>>;
  /**
   * Every day-pair of seats who both voted, and how many of those agreed.
   *
   * Kept as the two totals rather than as a rate so a pair can be measured
   * against the table *minus itself*. See `buddyScore`.
   */
  pairs: number;
  agreed: number;
}

function voteIndexOf(info: PublicInfo): VoteIndex {
  const memo = boardMemo(info);
  const cached = memo.voteIndex as VoteIndex | undefined;
  if (cached) return cached;

  const byDay = new Map<number, Map<number, number>>();
  for (const entry of info.voteHistory) {
    let day = byDay.get(entry.day);
    if (!day) {
      day = new Map();
      byDay.set(entry.day, day);
    }
    day.set(entry.voterSlot, entry.targetSlot);
  }

  let pairs = 0;
  let agreed = 0;
  for (const day of byDay.values()) {
    const ballots = [...day.values()];
    for (let i = 0; i < ballots.length; i++) {
      for (let j = i + 1; j < ballots.length; j++) {
        pairs++;
        if (ballots[i] === ballots[j]) agreed++;
      }
    }
  }

  const index: VoteIndex = { byDay, pairs, agreed };
  memo.voteIndex = index;
  return index;
}

/**
 * What the ballots say about a seat, and who they say it with.
 *
 * The partner comes back with the number because a read nobody can name is
 * worse than no read at all. This one was worth a fifth of a lynch and had no
 * sentence behind it anywhere in the driver, so when it fired it fired on every
 * seat at once, silently, off public information — which is precisely how five
 * bots land on one house in one beat with nothing to say for themselves. Now it
 * can be quoted.
 */
export interface BuddyRead {
  score: number;
  /** The seat this one has been shadowing, when there is one. */
  partner: number | null;
}

export function buddyScore(targetSlot: number, info: PublicInfo): number {
  return buddyRead(targetSlot, info).score;
}

export function buddyRead(targetSlot: number, info: PublicInfo): BuddyRead {
  const { byDay, pairs, agreed } = voteIndexOf(info);
  if (byDay.size < 3) return { score: 0, partner: null };

  /**
   * Measured against how much this table agrees with itself, not against zero.
   *
   * The read is "these two vote together and never against each other", and as
   * a raw rate it was worthless the moment the ballots actually started being
   * recorded. Every seat at this table computes the same suspicion from the
   * same public board, so the square herds: on a normal afternoon most pairs
   * who both voted voted for the same house, and a flat `together / bothVoted`
   * therefore handed +1.2 of evidence to half the town for the crime of
   * agreeing with the room. Measured: turning the ballots back on cost 1.3
   * points of lynch accuracy, all of it here.
   *
   * What is suspicious is agreeing *more than this table agrees anyway*. On a
   * square that scattered its votes, two seats who never once crossed stand
   * out and the read fires as it was meant to; on a square that voted as one
   * bloc all game, nobody stands out and it stays quiet, which is correct —
   * when everybody looks like partners, nobody is evidence.
   *
   * The pair is measured against the table *minus itself*, or a bonded pair
   * would be most of the very average it is supposed to stand out from, and
   * the tighter the pair the higher the bar it set for itself. With nobody
   * else on the record there is no table to compare to, and the read falls
   * back to the plain rate.
   */
  let best = 0;
  let partner: number | null = null;
  for (const other of info.aliveSlots) {
    if (other === targetSlot) continue;

    let together = 0;
    let against = 0;
    let bothVoted = 0;

    for (const day of byDay.values()) {
      const mine = day.get(targetSlot);
      const theirs = day.get(other);
      if (mine === undefined || theirs === undefined) continue;
      bothVoted++;
      if (mine === theirs) together++;
      if (mine === other || theirs === targetSlot) against++;
    }

    if (bothVoted < 3 || against > 0 || together < 2) continue;

    const otherPairs = pairs - bothVoted;
    const baseline = otherPairs > 0 ? (agreed - together) / otherPairs : 0;
    const room = 1 - baseline;
    if (room <= 0) continue;

    // How much of their shared record was spent agreeing, over and above what
    // agreeing with this table is worth at all.
    const edge = (together / bothVoted - baseline) / room;
    if (edge > best) {
      best = edge;
      partner = other;
    }
  }

  return { score: best * BUDDY_WEIGHT, partner: best > 0 ? partner : null };
}

/**
 * What the buddy read is worth, and why it is worth so little.
 *
 * It was 1.2, which is most of a lynch, and it was measured: of the seats it
 * pointed at, 35.1% were evil, against 37.6% of the seats it looked at. It
 * fired slightly *worse* than chance, on one seat in nine, and it cost 1.3
 * points of the town's lynch accuracy from the day the ballots it reads were
 * first recorded properly.
 *
 * The premise is sound at a table of people and hollow at this one. Every seat
 * here scores the same public board, so the square herds: "these two vote
 * together" describes the whole room, and "these two never crossed" describes
 * every pair that spent the game voting the day's wagon instead of each other.
 * Measuring the pair against the table's own rate of agreeing with itself, and
 * against the table minus the pair, did not rescue it — there is no signal to
 * recover.
 *
 * Kept, at a nudge's worth, for the table this game is actually for. A human
 * square scatters its votes, and there the read is the oldest one in Mafia and
 * a genuine pleasure to have pointed out. It must simply never again be allowed
 * to build a wagon on its own.
 */
const BUDDY_WEIGHT = 0.3;

/**
 * The seats a killer would be a fool to kill, and how sorry it would be.
 *
 * Every killing role in this game picked its target by asking which seat was
 * loudest, best trusted, or closest to a badge — that is, by asking who was
 * most *useful to the town*. Nobody ever asked who was useful to the killer.
 * So the family would routinely knife the one seat that had stood up at a
 * brother's trial and voted innocent, the seat whose vote they could count on
 * tomorrow, the seat doing their argument for them. A real family protects that
 * seat with its life. It is the oldest instinct in the game and it was missing
 * entirely.
 *
 * What counts as a friend is only what the *record* shows, so this is the same
 * public board everybody else reads and no seat learns anything it should not:
 *
 *  - **They voted to spare one of ours, at a trial, in public.** The loudest of
 *    the four and the only one that cost them something to do.
 *  - **They vouched for one of ours out loud**, or refused to accuse them.
 *  - **They follow our lead**: they keep closing the day on the house we were
 *    already on. Whether they are a friend or merely a follower does not
 *    matter — the effect on tomorrow's vote is identical.
 *  - And against all of that, **anything they have done to us**: a guilty
 *    ballot at a brother's trial, or an accusation, and they are not a friend,
 *    they are an enemy who once happened to agree.
 *
 * `mine` is whoever this killer counts as its own: the family for a mafioso or
 * a triad enforcer, and nobody but itself for a butcher working alone — the
 * solo killer's friends are the seats who defended *it*, which is the same
 * question asked of a smaller side.
 *
 * Returns only the seats worth sparing, with how strongly. Sparing is a
 * preference and never an obligation: a killer with nobody else to visit still
 * visits, because a night not spent killing is a night the town gets for free.
 */
export function friendlySeats(self: MafiaPlayer, info: PublicInfo, allies: ReadonlySet<number>): Map<number, number> {
  const mine = new Set<number>(allies);
  mine.add(self.slot);

  const score = new Map<number, number>();
  const add = (slot: number, amount: number): void => {
    if (mine.has(slot) || !info.aliveSlots.includes(slot)) return;
    score.set(slot, (score.get(slot) ?? 0) + amount);
  };

  // The stand: who spoke for us with a ballot, and who voted to hang us.
  for (const trial of info.trials) {
    if (!mine.has(trial.accusedSlot)) continue;
    for (const slot of trial.innocentSlots) add(slot, 2.5);
    for (const slot of trial.guiltySlots) add(slot, -3);
  }

  // The square: who vouched for us, and who named us.
  for (const claim of info.claims) {
    if (!mine.has(claim.targetSlot) || mine.has(claim.claimerSlot)) continue;
    if (claim.kind === 'clear') add(claim.claimerSlot, 1.5);
    if (claim.kind === 'accuse') add(claim.claimerSlot, -2.5);
  }

  /**
   * The ballot box: who keeps ending the day where we already were.
   *
   * Only where we pointed at somebody who is not one of us, or the whole thing
   * is circular: a seat "following our lead" onto a brother we were bussing is
   * a seat helping hang him.
   */
  const { byDay } = voteIndexOf(info);
  for (const day of byDay.values()) {
    const ours = new Set<number>();
    for (const slot of mine) {
      const target = day.get(slot);
      if (target !== undefined && !mine.has(target)) ours.add(target);
    }
    if (ours.size === 0) continue;
    for (const [voter, target] of day) {
      if (ours.has(target)) add(voter, 0.9);
    }
  }

  for (const [slot, value] of score) if (value < FRIEND_ENOUGH) score.delete(slot);
  return score;
}

/**
 * How much of a friend a seat has to be before a knife goes elsewhere.
 *
 * One innocent ballot at a brother's trial clears it on its own, and so does a
 * vouching plus a couple of afternoons spent voting our way. Deliberately
 * reachable: the cost of sparing somebody who was not really a friend is one
 * night's knife pointed at the second name on the list, and the cost of killing
 * a real one is the vote that would have saved the next brother.
 */
const FRIEND_ENOUGH = 2.4;

/** A butcher's side: itself and nobody else. */
const EMPTY_SIDE: ReadonlySet<number> = new Set<number>();

/**
 * Why a seat looks guilty, split into the two things that are not the same.
 *
 * `evidence` is what the board actually holds against them: an account that did
 * not survive a sighting, an investigator's report, two people claiming one
 * role, a proven lie. `wagon` is how many people are already standing on them.
 *
 * They were one number, and that is most of why a table of these bots would
 * pile onto somebody nobody had said anything about. Momentum fed the score,
 * the score crossed the voting threshold, and crossing it added momentum: a
 * lynch could bootstrap itself out of nothing at all. Keeping them apart lets
 * the caller say the thing that was always intended — a wagon may *amplify* a
 * suspicion but must not *be* one.
 */
export interface SuspicionParts {
  evidence: number;
  wagon: number;
  /**
   * The half of `evidence` this seat could actually stand up and point to.
   *
   * Its own nights, the graveyard's verdicts, a seat caught contradicting its
   * own alibi, two people wearing one unique badge: things a juror can name
   * without saying "well, everybody says so". The rest is the room agreeing
   * with itself, and `decideBallot` treats the two very differently — see the
   * doubt it buys there.
   */
  hard: number;
}

export function suspicionParts(
  targetSlot: number,
  self: MafiaPlayer,
  info: PublicInfo,
  rng: () => number
): SuspicionParts {
  let score = 0;

  /**
   * The crowd, counted once and then discounted.
   *
   * Every accusation used to add its full weight, so a room of twenty seats
   * that all agreed added twenty times the evidence of the one seat that
   * actually knew something — and since suspicion is what makes a bot accuse,
   * the first accusation manufactured the second, which manufactured the third.
   * Tables reached twenty-to-one verdicts on an afternoon in which exactly one
   * seat had said anything of its own, and every other line was "X already
   * called you out, so I am voting X". Reported from a real table, and it is
   * the single loudest way these bots stop looking like people.
   *
   * So the loudest voice is worth what it was always worth and each one after
   * it is worth rather less, which is what a room of people actually does with
   * a chorus: the second person to agree adds something, the eighth adds
   * nothing. The sum converges near four and a half times the top voice
   * instead of growing without limit, so a badge with a check still hangs
   * somebody and a pile-on on its own no longer does.
   *
   * Clearings decay the same way and for the same reason: a chorus of friends
   * vouching is not proof of innocence either, and leaving that side linear
   * while capping the other would simply have moved the runaway.
   */
  const ECHO = 0.65;
  const chorus = (kind: ClaimKind): number => {
    /**
     * Firsthand, and then the room repeating it.
     *
     * A `relay` is somebody else's finding said again, so it belongs in the
     * same chorus as the thing it repeats and it cannot be worth as much: it is
     * capped by whichever of the two seats the room trusts less, and halved
     * again, so twenty people passing one rumour along never outweigh the one
     * person who actually saw something. A relay whose source never made that
     * claim contributes nothing at all, and if the source denies it out loud,
     * `deductions` holds it against the seat that repeated it.
     *
     * An accusation the room asked about and never got an answer to is halved
     * as well. See `dodgedTheQuestion`.
     */
    const firsthand = info.claims
      .filter((claim) => claim.kind === kind && claim.targetSlot === targetSlot && claim.claimerSlot !== self.slot)
      .map((claim) =>
        kind === 'accuse' && dodgedTheQuestion(claim.claimerSlot, targetSlot, info)
          ? claimerWeight(claim.claimerSlot, info) * 0.5 * (claim.confidence ?? 1)
          : claimerWeight(claim.claimerSlot, info) * (claim.confidence ?? 1)
      );

    const repeated = info.claims
      .filter(
        (claim) =>
          claim.kind === 'relay' &&
          claim.targetSlot === targetSlot &&
          claim.claimerSlot !== self.slot &&
          claim.relayedFrom !== undefined &&
          info.claims.some(
            (source) =>
              source.claimerSlot === claim.relayedFrom && source.kind === kind && source.targetSlot === targetSlot
          )
      )
      .map((claim) => Math.min(claimerWeight(claim.claimerSlot, info), claimerWeight(claim.relayedFrom!, info)) * 0.5);

    const voices = [...firsthand, ...repeated].sort((left, right) => right - left);
    let total = 0;
    let echo = 1;
    for (const weight of voices) {
      total += weight * echo;
      echo *= ECHO;
    }
    return total;
  };

  score += 2.0 * chorus('accuse');
  score -= 2.2 * chorus('clear');

  for (const claim of info.claims) {
    if (claim.targetSlot !== targetSlot) continue;
    if (claim.claimerSlot === self.slot) continue; // own claims counted via intel below
    const weight = claimerWeight(claim.claimerSlot, info) * (claim.confidence ?? 1);
    if (claim.kind === 'hint') score += 0.8 * weight;
    /**
     * Being out at night is not a crime — half the town is out at night. Left
     * linear on purpose: two people putting the same house on two different
     * doorsteps are two observations, not one opinion said twice.
     */
    if (claim.kind === 'sighting') score += 0.5 * weight;
  }

  /** Everything below that a juror could point to itself, kept apart. */
  let hard = 0;

  // Being out at night *after saying you were home* is a different matter.
  if (contradicted(targetSlot, info)) {
    score += 3;
    hard += 3;
  }

  // A proven liar is himself a prime candidate.
  if (provenLiar(targetSlot, info)) {
    score += 2.5;
    hard += 2.5;
  }

  /**
   * A record of pointing the town at its own people.
   *
   * This is what `provenLiar` used to do by accident, and it mattered more than
   * it looked: it was most of how a Jester got himself hanged and most of how
   * an Executioner built a case. Retiring the accidental version took both
   * engines out with it — the bench showed the Executioner falling from 38% to
   * 9% — so here it is on purpose, and shaped like evidence rather than like a
   * verdict.
   *
   * The difference from the old rule is the whole point. One wrong call is a
   * bad afternoon and costs about a fifth of what being a proven liar cost; it
   * takes a *pattern* to reach the old number, and the pattern is capped, so a
   * seat can never be hanged on its voting record alone. And it counts as hard
   * evidence, because it is: every entry in it was settled by a corpse the
   * whole room watched being identified.
   */
  /**
   * And what the night itself says about them. See `deduce.ts`.
   *
   * Hard, because every finding in there is arithmetic off the morning report
   * and the roster rather than somebody's word: a bodyguard who blocked a knife
   * is a corpse, poison kills at the second dawn, the cell holds one. This is
   * the only way the town catches a liar with no Lookout alive to have watched
   * them, and it is why it belongs in the half of the score a juror can point
   * to rather than the half it has to be talked into.
   */
  const caught = deductionWeight(deductions(targetSlot, info));
  score += caught;
  hard += caught;

  const record = settledCredit(targetSlot, info);
  if (record < 0) {
    const misled = Math.min(1.5, -record * 0.5);
    score += misled;
    hard += misled;
  }

  // The trust meter: saving mafiosi at trials is remembered; hanging them too.
  /**
   * Read through this seat's own suspicion, so the same ballot moves a wary
   * reader further than a trusting one — see `Temperament`.
   *
   * Capped on the way up and not on the way down, which is the asymmetry the
   * record actually supports. A good voting history is weak evidence of
   * innocence: it is a thing anybody can do, the family included, and letting
   * it accumulate without limit produced seats the arithmetic could not convict
   * whatever they said or did afterwards — including one who announced he was
   * the Serial Killer. Voting to save a hanged killer, on the other hand, is a
   * thing almost nobody does by accident, so it keeps its full weight.
   */
  score -= Math.min(trustOf(targetSlot, info, temperamentOf(self.slot)), 1.2) * 0.6;

  // Tunnel vision smells like an obsession.
  score += monomaniacScore(targetSlot, info);

  // Role-claim cross-checks: two living claimants of one unique role means at
  // least one liar; claiming a role the graveyard already revealed is worse.
  const roleClaim = info.claims.find((claim) => claim.kind === 'role-claim' && claim.claimerSlot === targetSlot);
  if (roleClaim?.claimedRole) {
    /**
     * Somebody saying, out loud, that they are one of the killers.
     *
     * The board had no term for it whatsoever. A role claim was only ever
     * checked for being *contested* — two live claimants, or a badge already in
     * the ground — so "I am the Serial Killer" passed through the arithmetic
     * worth exactly nothing, and the sentence that ought to end an afternoon
     * ended nothing at all. Reported from a real table, where a man said it
     * five times across two days, was tried six times, and was acquitted six
     * times by a town that had him down as its most trustworthy seat.
     *
     * Priced above any single investigator's report, because it is a confession
     * and the room can act on it without waiting for a check. A liar claiming
     * a killer's badge to protect somebody, or to be interesting, pays for it:
     * that is a price worth paying, and the price the room would charge.
     */
    if (isEvilRole(roleClaim.claimedRole)) {
      score += 4;
      hard += 4;
    }

    /**
     * Distinct claimants, not distinct claims.
     *
     * `record` deduplicates a claim per claimer, per target, per kind, per day
     * and per room — so one seat honestly repeating "I am the Sheriff" on
     * Tuesday and again on Thursday is two rows on the board. Counted as rows,
     * that is two rivals rather than one, and the arithmetic below charges the
     * *other* Sheriff twice over for a contest only one person was having.
     */
    const rivals = new Set(
      info.claims
        .filter(
          (claim) =>
            claim.kind === 'role-claim' &&
            claim.claimedRole === roleClaim.claimedRole &&
            claim.claimerSlot !== targetSlot &&
            info.aliveSlots.includes(claim.claimerSlot)
        )
        .map((claim) => claim.claimerSlot)
    );

    /**
     * More people wearing a badge than the table was dealt.
     *
     * This was two rules, both gated on `unique`, and the gate was the bug: of
     * the sixty-three roles in the game thirteen carry the flag, and not one of
     * them is the Sheriff, the Doctor or the Lookout. So the three badges every
     * liar in every game reaches for were unfalsifiable — a bluff could claim
     * Sheriff with the real one alive and arguing, or with the real one lying
     * in the graveyard under a will listing every night they worked, and the
     * board scored it at zero.
     *
     * Counted against the roster instead, living claimants and buried ones
     * together. Two seats wearing the table's one Sheriff is a liar in the
     * room; a badge whose every copy is already in the ground is a liar with no
     * room left to argue, which is why it is worth more.
     */
    const buriedSame = [...info.deadRoles.entries()].filter(
      ([slot, role]) => role === roleClaim.claimedRole && slot !== targetSlot
    ).length;
    const copies = copiesOf(info, roleClaim.claimedRole);
    const claimants = 1 + rivals.size + buriedSame;

    if (copies > 0 && buriedSame >= copies) {
      score += 3;
      hard += 3;
    } else if (copies > 0 && claimants > copies) {
      // Capped: a badge four people are wearing is one liar's problem, not four times one.
      const over = Math.min(2, claimants - copies);
      score += 1.5 * over;
      hard += 1.5 * over;
    }

    /**
     * And somebody saying the badge is not theirs, without claiming it back.
     *
     * The rule above needs two seats to both *claim* the role before the room
     * notices a contest, which misses the commonest form of it by far: a seat
     * that already claimed Doctor on Tuesday simply says "he is not the Doctor"
     * on Thursday rather than claiming it all over again. That denial carries
     * the same information and the board was discarding it.
     *
     * Weighed by who is saying it, so a stranger denying a badge is a
     * disagreement and a proven investigator denying one is close to a verdict.
     * Deliberately worth less than a double claim: the denier is risking
     * nothing, where two live claimants have both put their names on it.
     */
    const denied = info.claims
      .filter(
        (claim) =>
          claim.kind === 'counter-claim' &&
          claim.targetSlot === targetSlot &&
          claim.deniedRole === roleClaim.claimedRole &&
          claim.claimerSlot !== self.slot &&
          info.aliveSlots.includes(claim.claimerSlot)
      )
      .reduce((most, claim) => Math.max(most, claimerWeight(claim.claimerSlot, info)), 0);
    if (denied > 0) {
      const weight = Math.min(1.2, denied);
      score += weight;
      hard += weight;
    }
    /**
     * A contested claim that the graveyard has now settled, in your favour.
     *
     * Two seats both claim Jailor, so at least one is lying and both look bad:
     * that is the +1.5 above, and it is right. The town hangs one of them, and
     * the corpse turns out to be Triad. The question the room was arguing about
     * has now been *answered*. The liar has been found and it was not this seat.
     *
     * Nothing said so. The penalty merely stopped applying, because `rivals`
     * only counts the living, which returned the survivor to the middle of the
     * pack with a warm wagon still parked on them, and they got hanged second.
     * That was reported from a real table, and it is the wrong read twice over:
     * the evidence does not merely evaporate, it reverses.
     *
     * Read off the graveyard, so it needs no memory of who argued what: a dead
     * seat that claimed the same unique role, revealed as evil, is a claim
     * contest this seat won. Worth more than the contest cost, and less than an
     * investigator's own report, so a second liar is still catchable.
     */
    for (const [deadSlot, deadRole] of info.deadRoles) {
      if (deadSlot === targetSlot) continue;
      const claimedTheSame = info.claims.some(
        (claim) =>
          claim.kind === 'role-claim' && claim.claimerSlot === deadSlot && claim.claimedRole === roleClaim.claimedRole
      );
      if (claimedTheSame && isEvilRole(deadRole)) score -= 2.5;
    }
  }

  // Own hard evidence outweighs the rumour mill, and is the model of what a
  // juror can point to: it saw it happen.
  for (const entry of self.intel) {
    if (entry.targetSlot !== targetSlot) continue;
    let own = 0;
    if (entry.kind === 'sheriff') own += sheriffSuspects(entry.value) ? 3 : -4;
    if (entry.kind === 'role') own += isEvilRole(entry.value as RoleId) ? 4 : -4;
    if (entry.kind === 'saved') own -= 2; // an attacked patient is rarely the killer
    score += own;
    hard += own;
  }

  // Never once voted for each other, and often together. See `buddyScore`.
  score += buddyScore(targetSlot, info);

  // What the record proves outweighs what anybody says. A proven Veteran is a
  // townie whatever the wagon thinks; a proven wolf is done.
  const proven = info.provenRoles.get(targetSlot);
  if (proven) {
    const weight = isEvilRole(proven) ? 4 : -3;
    score += weight;
    hard += weight;
  }

  // The wagon: herd instinct, weighted by personality. Returned separately, so
  // the caller decides whether momentum is allowed to carry the day.
  const wagon = [...info.votes.values()].filter((voted) => voted === targetSlot).length;

  return { evidence: score + rng() * 0.3, wagon: wagon * 0.5 * brainHerd(self), hard };
}

/**
 * How much better a new suspect has to look before a seat abandons its vote.
 *
 * Some hysteresis is needed or a second look is worse than no second look:
 * `suspicionParts` carries a `rng() * 0.3` jitter and `pickVote` has a small
 * hunch path, so re-running it on an unchanged board flips votes for no reason,
 * which reads as a table of weathervanes rather than a table being persuaded.
 * Above this margin, something on the board actually moved.
 */
const SWITCH_MARGIN = 0.75;

/**
 * What a tied leader has to be worth before a seat crosses the floor to it.
 *
 * Breaking a deadlock is the one moment where moving matters more than being
 * consistent: two seats level at the bell means nobody hangs, and a day spent
 * for nothing is a day the night side keeps. But only towards a real case, or
 * the tie-break becomes a coin flip that hangs whoever the noise favoured.
 */
const TIEBREAK_FLOOR = 1.6;

/**
 * Below this, the board is empty and the honest vote is to hang nobody.
 *
 * Read as the best evidence standing against *anybody*, not as a per-seat
 * score: a square where the strongest case is this weak has not found anything,
 * and a rope thrown at its best guess is a coin flip with a corpse at the end.
 */
const NO_CASE_CEILING = 0.5;

/** What a seat should do with its ballot: a slot, a skip, or leave it alone. */
export interface SteadyVote {
  /** The slot to accuse, or null to leave the standing vote where it is. */
  slot: number | null;
  /** Vote to hang nobody today. */
  skip: boolean;
}

/**
 * What to do with the ballot, given what this seat has already said with it.
 *
 * Four answers, and the last two are the ones that were missing.
 *
 * **Cast it** when the seat has no vote standing. This alone closes most of
 * the gap: a seat whose first turn found nothing worth a rope never voted
 * again that day, whatever the afternoon turned up.
 *
 * **Leave it** when the proposal is the standing vote, or is not clearly
 * better than it. Without that floor a second look is noise: the proposal is
 * recomputed with jitter and a hunch path, so it flips on an unchanged board
 * and the table reads as fickle rather than as persuadable.
 *
 * **Cross the floor to a tied leader** when the day is about to end level.
 * Two seats on the same count at the bell means nobody hangs and the night
 * side keeps a free day, so a deadlock is the one moment where moving matters
 * more than consistency. Only towards a case worth `TIEBREAK_FLOOR`, or the
 * tie-break is a coin flip that hangs whoever the noise favoured.
 *
 * **Vote to hang nobody** when the best case standing against *anybody* is
 * under `NO_CASE_CEILING`. A square that has found nothing should say so;
 * throwing the rope at its best guess is a coin flip with a corpse at the end.
 * Not at the parity clock, where a wasted day loses the game outright, which is
 * the same guard the driver has always applied to joining somebody else's skip.
 */
export function steadyVote(
  self: MafiaPlayer,
  info: PublicInfo,
  /** The slot this seat is already accusing. Null for no vote, and for a skip. */
  standing: number | null,
  /** What `decideDay` would like this seat to vote for. */
  proposed: number | null,
  /**
   * Seats this one will not cross the floor onto: the family, a bonded heart.
   *
   * The proposal comes from `pickVote`, which knows never to name a brother.
   * The tie-break below did not, and it reads the tally rather than the
   * proposal: a mafioso standing on a townie while the room sat level between
   * that townie and its own Godfather would break the tie onto the Godfather,
   * since the case against a mafioso under a wagon generally looks strong.
   * Bussing is a decision the brain takes on purpose in `pickVote`, behind a
   * temperament gate; it is not something a tie-break may do by accident.
   */
  allies: ReadonlySet<number>,
  rng: () => number
): SteadyVote {
  const scoreOf = (slot: number): number => suspicion(slot, self, info, rng);

  /* --------------------- nothing proposed: pass, or hold ------------------ */
  if (proposed === null) {
    if (standing !== null) return { slot: null, skip: false };

    const townish = self.role ? roleDef(self.role).faction === 'town' : false;
    const desperate = townish && parityPressure(info) >= 0.6;
    const best = info.aliveSlots
      .filter((slot) => slot !== self.slot)
      .reduce((most, slot) => Math.max(most, suspicionParts(slot, self, info, rng).evidence), 0);

    /**
     * A board this empty has not found anybody, so say so — unless saying so
     * loses the game, or the room has asked not to.
     *
     * The last clause is `urge`, and it is the reason that kind exists. This
     * branch is a machine deciding on its own authority that there is nothing
     * to talk about, and on a slow afternoon that is every board: the bots
     * ended day two in the first second while a person was still typing. A seat
     * asking for a vote is the one thing that should outweigh it, and a seat
     * asking for a quiet day should be able to argue for one.
     *
     * Weighed rather than counted, so it is not a poll: one credible voice
     * asking for a vote beats three strangers asking for the day off, and the
     * family pushing for a quiet day is heard exactly as loudly as the room
     * trusts it.
     */
    let pushing = 0;
    for (const claim of info.claims) {
      if (claim.kind !== 'urge' || claim.day !== info.day || claim.claimerSlot === self.slot) continue;
      pushing += (claim.urge === 'vote' ? 1 : -1) * claimerWeight(claim.claimerSlot, info);
    }

    /**
     * A family seat does not help the town go home while the town is halfway to
     * hanging somebody who is not one of theirs.
     *
     * The complaint this comes from, in a real transcript: three afternoons
     * running ended in "the town would rather hang nobody" with a wagon already
     * well built on a townie. Every one of those was a free hanging the family
     * declined to take, and it declined it by *voting for the skip itself* —
     * because the skip branch reads the evidence, the evidence was thin, and
     * thin evidence is exactly the position a family should want a vote in.
     *
     * Only about the skip. What the seat votes *for* is still its own business
     * and still goes through the whole ranking above; this says only that
     * hanging nobody is not an option worth offering while somebody else's neck
     * is halfway into the noose.
     */
    /**
     * A family or a lone killer, not merely "not town". The comment above says family and the test said
     * `!townish`, which swept in the Survivor and the Jester — and a Survivor voting to hang nobody on thin evidence
     * is a Survivor playing well, not a knife declining a free hanging.
     */
    if (self.role && isEvilRole(self.role) && info.day >= 3) {
      const running = info.aliveSlots.some(
        (slot) => slot !== self.slot && !allies.has(slot) && wagonAlong(slot, info) >= 0.5
      );
      if (running) return { slot: null, skip: false };
    }

    if (!desperate && best < NO_CASE_CEILING && pushing <= 0) return { slot: null, skip: true };
    return { slot: null, skip: false };
  }

  if (standing === null) return { slot: proposed, skip: false };

  /* ------------------------- a deadlock at the bell ---------------------- */
  /**
   * Weighed before "my proposal has not changed", and that ordering is the
   * whole of the tie-break.
   *
   * The seat under a deadlock usually proposes exactly what it proposed an hour
   * ago: its own read has not moved, the *room* has. Checking for an unchanged
   * proposal first therefore returned early and the tie stood, which is the case
   * that was reported. What has to move the seat here is the tally, not its own
   * opinion.
   */
  const tally = new Map<number, number>();
  for (const target of info.votes.values()) tally.set(target, (tally.get(target) ?? 0) + 1);
  const most = Math.max(0, ...tally.values());
  const leaders = [...tally.entries()].filter(([, count]) => count === most).map(([slot]) => slot);

  if (most > 0 && leaders.length > 1) {
    const best = leaders
      .filter((slot) => slot !== self.slot && !allies.has(slot))
      .map((slot) => ({ slot, score: scoreOf(slot) }))
      .sort((left, right) => right.score - left.score)[0];

    if (best && best.score >= TIEBREAK_FLOOR && best.slot !== standing) {
      return { slot: best.slot, skip: false };
    }
  }

  if (standing === proposed) return { slot: null, skip: false };

  /* --------------------- otherwise, only for a real gain ----------------- */
  /**
   * The hysteresis, softened for a seat that changes its mind easily.
   *
   * `SWITCH_MARGIN` is what stops a bot reading as a weathervane, and it is
   * right for a bot. A person is a weathervane: they park a vote, hear an
   * argument, and move on much less than this. Read off the seat rather than
   * passed in, the same way `temperamentOf` is, so no caller has to care.
   */
  const margin = SWITCH_MARGIN * (1 - quirksOf(self.slot).lateSwitch);
  return scoreOf(proposed) - scoreOf(standing) >= margin
    ? { slot: proposed, skip: false }
    : { slot: null, skip: false };
}

/** Public suspicion of a slot, as a town-aligned seat computes it. */
export function suspicion(targetSlot: number, self: MafiaPlayer, info: PublicInfo, rng: () => number): number {
  const parts = suspicionParts(targetSlot, self, info, rng);
  return parts.evidence + parts.wagon;
}

/** The herd factor lives on the personality; this indirection keeps call sites short. */
let herdBySlot: Map<number, number> = new Map();
/**
 * And the meter coefficients, by seat, for the same reason.
 *
 * `suspicionParts` is handed a `MafiaPlayer` rather than a `Brain` — it is
 * asked "how suspicious is that one, to this one", and the answer depends on
 * who is reading. Rather than thread a brain through every caller, the binding
 * that already exists for `herd` carries this too. An unbound seat reads at the
 * even temperament, which is what a bare board in a test should do.
 */
let temperamentBySlot: Map<number, Temperament> = new Map();
let quirksBySlot: Map<number, Quirks> = new Map();

export function temperamentOf(slot: number): Temperament {
  return temperamentBySlot.get(slot) ?? EVEN_TEMPERAMENT;
}

/** This seat's people-shaped habits. An unbound seat has none. See `Quirks`. */
export function quirksOf(slot: number): Quirks {
  return quirksBySlot.get(slot) ?? NO_QUIRKS;
}

export function bindPersonalities(brains: Brain[]): void {
  herdBySlot = new Map(brains.map((brain) => [brain.slot, brain.personality.herd]));
  temperamentBySlot = new Map(brains.map((brain) => [brain.slot, brain.personality.temperament]));
  quirksBySlot = new Map(brains.map((brain) => [brain.slot, brain.personality.quirks ?? NO_QUIRKS]));
}
function brainHerd(self: MafiaPlayer): number {
  return herdBySlot.get(self.slot) ?? 0.5;
}

function votesAgainst(slot: number, info: PublicInfo): number {
  return [...info.votes.values()].filter((voted) => voted === slot).length;
}

/**
 * How far along the rope already is for this seat, 0..1.
 *
 * The town's own momentum, read as a fraction rather than as a countdown. The
 * first version of the family's opportunism asked "is this wagon one or two
 * votes short", and the bench answered that it is, on 2.4% of the votes a
 * family seat ever scores: a majority of the living is a lot of names to
 * gather and the trial opens the instant the last one lands, so "nearly there"
 * is a doorway rather than a room. A family that only acts in the doorway never
 * acts.
 */
function wagonAlong(slot: number, info: PublicInfo): number {
  const needed = Math.max(1, Math.floor(info.aliveSlots.length / 2) + 1);
  return Math.min(1, votesAgainst(slot, info) / needed);
}

/**
 * The clutch factor. Nobody plays the theoretical optimum every night: given
 * a ranked list of choices, each rank has a `slip` chance of being passed
 * over for the next — 75% first choice, ~19% second, ~5% third. The doctor
 * who just saved the loud sheriff *knows* the mafia might rotate, so a
 * quarter of the time he rotates first; the mafia, same reasoning, sometimes
 * shoots the second-loudest voice instead.
 */
export function pickRanked<T>(items: T[], rng: () => number, slip = 0.25): T | null {
  let index = 0;
  while (index < items.length - 1 && rng() < slip) index++;
  return items[index] ?? null;
}

/** Living claimers still worth listening to, loudest first — the mafia's hit list. */
export function credibleClaimersRanked(info: PublicInfo, excluding: Set<number>): number[] {
  const counts = new Map<number, number>();
  for (const claim of info.claims) {
    if (claim.kind !== 'accuse') continue;
    if (!info.aliveSlots.includes(claim.claimerSlot)) continue;
    if (excluding.has(claim.claimerSlot)) continue;
    if (claimerWeight(claim.claimerSlot, info) === 0) continue;
    counts.set(claim.claimerSlot, (counts.get(claim.claimerSlot) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([slot]) => slot);
}

/* ------------------------------ day choices ------------------------------ */

export interface DayDecision {
  voteSlot: number | null;
  publishes: Claim[];
  jailSlot: number | null;
  revealMayor: boolean;
  /** Judge only: convene the exceptional court on the current top-voted. */
  callCourt: boolean;
}

export function decideDay(
  self: MafiaPlayer,
  brain: Brain,
  info: PublicInfo,
  teammates: Set<number>,
  familyKnownEvil: Set<number>,
  rng: () => number
): DayDecision {
  const role = self.role!;
  const decision: DayDecision = { voteSlot: null, publishes: [], jailSlot: null, revealMayor: false, callCourt: false };
  const others = info.aliveSlots.filter((slot) => slot !== self.slot);
  if (others.length === 0) return decision;

  // The mood this seat woke up in. `feelPressure` advanced the meter at dawn;
  // everything below reads it rather than recomputing danger ad hoc.
  const agenda = agendaOf(role);
  const stance = stanceOf(agenda, brain.desperation, brain.personality);
  /** The people-shaped habits, all zero for a bot. See `Quirks`. */
  const quirks = brain.personality.quirks ?? NO_QUIRKS;

  /** The fields only the newer kinds carry. See `Claim`. */
  type Extra = Partial<Pick<Claim, 'urge' | 'deniedRole' | 'promise' | 'relayedFrom' | 'at'>>;

  const publish = (
    targetSlot: number,
    kind: ClaimKind,
    claimedRole?: RoleId,
    account?: 'home' | 'visited',
    ailment?: Claim['ailment'],
    extra?: Extra
  ) => {
    if (!alreadyClaimed(info, self.slot, targetSlot, kind)) {
      decision.publishes.push({
        day: info.day,
        // Said today, so it is last night it is talking about. See `Claim.night`.
        night: Math.max(1, info.day - 1),
        claimerSlot: self.slot,
        targetSlot,
        kind,
        truthful: false,
        claimedRole,
        account,
        ailment,
        ...extra
      });
    }
  };

  /* -------- Claims: talk to the town (or poison it). -------- */
  // A gagged mouth publishes nothing today; the vote still counts.
  const gagged = self.silencedDay === info.day;

  /**
   * "They came to my door last night."
   *
   * Free information, which is the whole reason to say it: naming what was done
   * to you accuses nobody, contradicts nothing you have said, and asks the room
   * for something concrete. A poisoned seat is dead at dawn without a doctor,
   * so it says so almost always. Petrol is a warning rather than a request —
   * nothing cures it — so it is said often and not without fail.
   *
   * Said by whoever it happened to, town or not: a poisoned mafioso wants the
   * doctor's night exactly as much as anybody else, and spending the town's
   * only heal on itself is a bonus rather than a cost. Once per seat per game;
   * a seat that repeats it every afternoon is a seat nobody listens to.
   */
  /**
   * Once per *kind*, and never twice in a day.
   *
   * This used to be once per seat per game, which was right when the list held
   * two entries that could not both be true of the same night. It now holds
   * five, and they genuinely stack: a seat gagged on day two and poisoned on
   * day four has two different things to tell the room and only one of them is
   * yesterday's news. Repeating the *same* one is still the thing nobody
   * listens to, so that stays barred.
   */
  const saidBefore = (what: Claim['ailment']): boolean =>
    info.claims.some((claim) => claim.kind === 'ailing' && claim.claimerSlot === self.slot && claim.ailment === what);
  const saidToday = info.claims.some(
    (claim) => claim.kind === 'ailing' && claim.claimerSlot === self.slot && claim.day === info.day
  );
  /**
   * What is on this seat, in the order it is worth saying.
   *
   * Poison first because it is a countdown: nothing else on the list kills you
   * tomorrow. Then the petrol. Then last night's failed attack, which is not
   * about this seat at all — it is about who else is alive. "A doctor healed me
   * on night 3" tells the room a doctor exists, was on this house, and that the
   * family spent a knife here; the town can act on all three, and none of it
   * was sayable before, because the engine only ever put it in a notification.
   *
   * `survived` is last and said least. It reports armour rather than a saviour,
   * and armour is a short list of roles, so saying it is most of a role claim
   * with none of a role claim's usefulness.
   */
  const rescue: Claim['ailment'] | null =
    self.rescuedNight != null && self.rescuedNight >= info.day - 1
      ? self.rescuedBy === 'doctor'
        ? 'healed'
        : self.rescuedBy === 'bodyguard'
          ? 'guarded'
          : 'survived'
      : null;
  /**
   * "I was blackmailed yesterday."
   *
   * The gag itself is announced to nobody and cannot be reported while it is on
   * — `chatRules` refuses the message, which is the point of a gag — so the
   * only day this is sayable is the day after, and until now no seat ever said
   * it. That left a hole with a wagon in it: `why.silent` treats a seat that
   * has said nothing as a reason to vote, and a seat the blackmailer had shut
   * up was being hanged for obeying the rules of the game.
   *
   * Said early and readily, because it is an answer to an accusation that is
   * already forming.
   */
  /**
   * "I got roleblocked / witched / transported / jailed."
   *
   * Said before anything else by anybody it happened to, because each one is
   * the explanation for a result that is missing or wrong, and each puts a role
   * at the table: an Escort or Consort, a Witch, a Bus Driver, a Jailor. A
   * Sheriff with no page for last night is a Sheriff with something to explain,
   * and this is the explanation.
   *
   * The cell is said soonest and most readily of the four, because it is the
   * only one with a living witness — the jailor either confirms it or does not
   * — and for that same reason it is the one no liar below may reach for.
   */
  const disturbed: Claim['ailment'] | null =
    self.disturbedNight != null && self.disturbedNight === info.day - 1
      ? self.disturbedBy === 'block'
        ? 'blocked'
        : self.disturbedBy === 'control'
          ? 'controlled'
          : self.disturbedBy === 'jail'
            ? 'jailed'
            : 'bussed'
      : null;
  const gaggedYesterday = self.silencedDay === info.day - 1;
  const ailing: Claim['ailment'] | null =
    self.poisonedNight !== null
      ? 'poison'
      : gaggedYesterday && !saidBefore('silenced')
        ? 'silenced'
        : self.doused
          ? 'douse'
          : (rescue ?? disturbed);
  if (!gagged && !saidToday && ailing && !saidBefore(ailing)) {
    const eagerness =
      ailing === 'poison'
        ? 0.95
        : ailing === 'silenced'
          ? 0.85
          : ailing === 'guarded'
            ? 0.8
            : ailing === 'healed'
              ? 0.6
              : ailing === 'jailed'
                ? 0.9
                : ailing === 'douse'
                  ? 0.45
                  : ailing === 'blocked' || ailing === 'controlled'
                    ? 0.5
                    : ailing === 'bussed'
                      ? 0.4
                      : 0.2;
    if (rng() < eagerness) publish(self.slot, 'ailing', undefined, undefined, ailing);
  }

  /**
   * And the same sentence from somebody it did not happen to.
   *
   * It is the cheapest lie in the game — it accuses nobody, so nobody argues
   * with it, and it buys sympathy, a night of the doctor's attention, or a
   * reason to have been quiet. Only once the dawn report has actually named
   * that weapon, though: claiming the poison on a table where nobody has ever
   * been poisoned is not a bluff, it is an announcement that a poisoner exists,
   * and the room can read the same reports this does. Rare, and rarer still in
   * a seat with no taste for lying.
   */
  if (!gagged && !saidToday && !ailing && agenda !== 'town' && info.day > 2) {
    const weapons = new Set(info.deaths.map((death) => death.source));
    const tellable: Claim['ailment'][] = [];
    /**
     * Nothing goes on this list that the roster cannot support.
     *
     * A lie has to name something that could have happened. The room is looking
     * at the published role list and at a graveyard with names on it, so "a
     * poisoner got me" at a table whose only poisoner is lying dead in the
     * square is not a risk, it is a self-report. `couldStillAct` is the whole
     * of that check, and every entry below goes through it.
     */
    if (weapons.has('poison') && couldStillAct('poison', info)) tellable.push('poison');
    if (weapons.has('arsonist') && couldStillAct('douse', info)) tellable.push('douse');

    /**
     * "I was blackmailed yesterday, that is why I said nothing."
     *
     * The excuse a quiet liar wants most, because silence is one of the things
     * this model actually votes people for — see `why.silent`. It is available
     * only when it is plausible in both directions: somebody at this table can
     * still gag people, and this seat genuinely said nothing yesterday. A seat
     * that argued all afternoon and then claims it was mute is not bluffing,
     * it is handing the room a contradiction with its own name on it.
     */
    const spokeYesterday = info.claims.some((claim) => claim.claimerSlot === self.slot && claim.day === info.day - 1);
    if (info.day > 2 && !spokeYesterday && couldStillAct('silence', info)) tellable.push('silenced');

    /**
     * "A doctor healed me last night."
     *
     * The best lie on this list, and the reason it sits here rather than with
     * the two above: there is nothing to check. A real heal leaves no corpse
     * and files no report, so the only seat at the table who can flatly
     * contradict it is the doctor — and contradicting it means standing up and
     * claiming the badge, which is exactly the trade a liar is glad to force.
     * It buys the teller a night of the real doctor's attention, a reason the
     * family "tried" them, and a quiet place on the town's list.
     *
     * Two guards on it. It only goes out after a night that produced no body,
     * because a heal claimed on a morning with a corpse in it is a heal the
     * room can count against the knives it knows about. And never `guarded`,
     * which is the one rescue that leaves a dead bodyguard in the square, and
     * therefore the one version of this lie the town disproves before lunch.
     */
    if (info.lastNightDeathSlots.size === 0 && info.nightDeathsTotal > 0 && couldStillAct('heal', info)) {
      tellable.push('healed');
    }
    /**
     * "I was roleblocked last night."
     *
     * The fake investigator's oldest excuse, and a good one: it explains why a
     * claimed Sheriff has no result to read out, accuses nobody, and cannot be
     * checked by anyone but the blocker, who is very often on the other side.
     * Only where a blocking role could still be at the table.
     */
    if (couldStillAct('block', info)) tellable.push('blocked');

    // The dice come out only when there is something to lie about: a draw
    // taken on an empty list still moves the sequence, and a bench whose
    // numbers shift because a branch *considered* firing measures nothing.
    if (tellable.length > 0 && rng() < 0.08 * (0.5 + brain.personality.deceit)) {
      const pick = tellable[Math.floor(rng() * tellable.length)];
      if (pick) publish(self.slot, 'ailing', undefined, undefined, pick);
    }
  }

  if (info.day > 1 && !gagged) {
    /**
     * Self-preservation. Speaking outs you as an information role and paints
     * the target on your back, so findings are *hoarded*: nothing on day 2,
     * a trickle after, one finding at a time — unless the rope is already
     * looking at you (deathbed dump: say everything while you still can),
     * or your finding is *timely* (your suspect is being voted up right now).
     */
    const endangered = votesAgainst(self.slot, info) >= 2 || info.trialSlot === self.slot;
    /**
     * How ready this seat is to be the one who spoke, today.
     *
     * The curve is the hoarding rule — speaking outs an information role and
     * paints the target on its back, so findings come out slowly — and `haste`
     * is where one seat differs from another. At 0.6 it is roughly a day behind
     * the table: it has the hit, it is waiting for somebody else to draw fire
     * first. At 1.4 it is a day ahead and says it while it is still worth
     * something.
     *
     * Capped at 1 so a hasty seat is early, never certain, and never louder
     * than the room's own speech budget allows.
     */
    const patience = Math.min(
      1,
      (info.day <= 2 ? 0.15 : info.day === 3 ? 0.4 : info.day === 4 ? 0.7 : 1) * brain.personality.temperament.haste
    );
    const speakChance = brain.personality.claimRate * patience;

    if (role === 'sheriff' || role === 'investigator') {
      const suspects = self.intel.filter(
        (entry) =>
          entry.kind === 'sheriff' &&
          sheriffSuspects(entry.value) &&
          info.aliveSlots.includes(entry.targetSlot) &&
          !alreadyClaimed(info, self.slot, entry.targetSlot, 'accuse')
      );
      if (endangered) {
        // Nothing left to protect: claim the badge and empty the notebook.
        publish(self.slot, 'role-claim', role);
        for (const finding of suspects) publish(finding.targetSlot, 'accuse');
      } else {
        // Timely findings jump the queue: confirming a live wagon is worth
        // the exposure. Otherwise, one finding, sometimes, and having two in
        // the notebook loosens the tongue.
        const timely = suspects.find(
          (entry) => votesAgainst(entry.targetSlot, info) >= 1 || info.trialSlot === entry.targetSlot
        );
        const confident = suspects.length >= 2 ? 1.4 : 1;
        if (timely && rng() < Math.max(speakChance, 0.75)) publish(timely.targetSlot, 'accuse');
        else if (suspects.length > 0 && rng() < speakChance * confident * 0.7) {
          publish(suspects[suspects.length - 1].targetSlot, 'accuse');
        }
      }
      // Defend the wrongly accused: a clear is only worth saying when the
      // rope is near — always timely, always spoken.
      const rescue = self.intel.find(
        (entry) =>
          entry.kind === 'sheriff' &&
          entry.value === 'clear' &&
          info.aliveSlots.includes(entry.targetSlot) &&
          (votesAgainst(entry.targetSlot, info) >= 2 || info.trialSlot === entry.targetSlot)
      );
      if (rescue && rng() < brain.personality.claimRate) publish(rescue.targetSlot, 'clear');

      /**
       * The investigator's findings, graded rather than guessed at.
       *
       * This used to hunt for three French sentences inside `entry.value` —
       * "sent la poudre" and two others — and `entry.value` has been the trade's
       * *identifier* since the day the catalogues were split out, so it matched
       * nothing, ever. The Investigator has been silent for its whole existence:
       * every night it examined somebody, wrote the answer down, and never once
       * told the room. That is the single most useful town role in the setup
       * doing nothing at all.
       *
       * Graded by what the shortlist actually contains, against this table's
       * roster: a line that can only be an enemy is an accusation, a line that
       * can only be town is worth standing up for, and everything else is the
       * hint it always should have been.
       */
      if (role === 'investigator' && rng() < speakChance) {
        const found = self.intel.filter(
          (entry) => entry.kind === 'trade' && info.aliveSlots.includes(entry.targetSlot)
        );
        // The sharpest finding first: a conviction beats a shrug.
        const graded = found
          .map((entry) => ({
            entry,
            verdict: tradeVerdict(entry.value, info.rolesInPlay)
          }))
          .sort((left, right) => rank(right.verdict) - rank(left.verdict));
        const best = graded[0];
        if (best) {
          if (best.verdict === 'damning') publish(best.entry.targetSlot, 'accuse');
          else if (best.verdict === 'clean') publish(best.entry.targetSlot, 'clear');
          else publish(best.entry.targetSlot, 'hint');
        }
      }
    }

    // The lookout's deduction: my watch target died — I saw who visited.
    // Timely by nature; the corpse is on the square this very morning.
    if (role === 'lookout') {
      const watch = self.intel.find(
        (entry) =>
          entry.kind === 'visitors' && entry.night === info.day - 1 && info.lastNightDeathSlots.has(entry.targetSlot)
      );
      if (watch && rng() < brain.personality.claimRate) {
        for (const visitor of watch.slots ?? []) {
          if (!info.aliveSlots.includes(visitor)) continue;
          // Three things, and they do different work: the accusation points,
          // the sighting catches "I was home" in a lie, and the doorstep is
          // what makes it worth more than either. This watcher was standing
          // outside the house that died, so it knows exactly where they were.
          publish(visitor, 'accuse');
          publish(visitor, 'sighting', undefined, undefined, undefined, { at: watch.targetSlot });
        }
      }
    }

    // The detective's catch: I followed X, and X went to the house that died.
    if (role === 'detective') {
      const caught = self.intel.find(
        (entry) =>
          entry.kind === 'tracked' &&
          entry.night === info.day - 1 &&
          info.aliveSlots.includes(entry.targetSlot) &&
          (entry.slots ?? []).some((slot) => info.lastNightDeathSlots.has(slot))
      );
      if (caught && rng() < Math.max(speakChance, 0.6)) {
        publish(caught.targetSlot, 'accuse');
        // The tail ended on a doorstep, and the doorstep is the point: this is
        // the seat that walked to the house that died.
        const doorstep = (caught.slots ?? []).find((slot) => info.lastNightDeathSlots.has(slot));
        publish(
          caught.targetSlot,
          'sighting',
          undefined,
          undefined,
          undefined,
          doorstep === undefined ? undefined : { at: doorstep }
        );
      }
      // Even a tail that led nowhere interesting establishes that they moved.
      const seen = self.intel.find(
        (entry) =>
          entry.kind === 'tracked' &&
          entry.night === info.day - 1 &&
          info.aliveSlots.includes(entry.targetSlot) &&
          (entry.slots ?? []).length > 0
      );
      if (seen) {
        const where = (seen.slots ?? [])[0];
        if (rng() < speakChance) {
          publish(
            seen.targetSlot,
            'sighting',
            undefined,
            undefined,
            undefined,
            where === undefined ? undefined : { at: where }
          );
        }
      }
    }

    // The bus driver's deduction: I swapped A and B, and B died in A's bed —
    // whoever struck wanted A. A is somebody's target, so probably nobody's ally.
    if (role === 'bus-driver' && rng() < speakChance * 0.6) {
      const swap = self.intel.find((entry) => entry.kind === 'swapped' && entry.night === info.day - 1);
      const pair = swap?.slots ?? [];
      const deadHalf = pair.find((slot) => info.lastNightDeathSlots.has(slot));
      const intended = pair.find((slot) => slot !== deadHalf);
      if (deadHalf !== undefined && intended !== undefined && info.aliveSlots.includes(intended)) {
        publish(intended, 'clear');
      }
    }

    // The blocker's deduction: I held X all night and, for once, nobody died.
    if ((role === 'escort' || role === 'jailor') && info.day >= 3 && rng() < speakChance * 0.4) {
      const held = self.intel.find(
        (entry) =>
          entry.kind === 'blocked' && entry.night === info.day - 1 && info.aliveSlots.includes(entry.targetSlot)
      );
      const quietNight = info.lastNightDeathSlots.size === 0;
      if (held && quietNight && info.nightDeathsTotal > 0) publish(held.targetSlot, 'hint');
    }

    // The spy's deduction: the family aimed at X and X still breathes —
    // families don't hunt their own, so X is probably clean.
    if (role === 'spy' && rng() < speakChance * 0.5) {
      const spied = self.intel.find(
        (entry) => entry.kind === 'spied' && entry.night === info.day - 1 && info.aliveSlots.includes(entry.targetSlot)
      );
      if (spied) publish(spied.targetSlot, 'clear');
    }

    // The doctor vouches for a patient he pulled off the killer's table.
    if (role === 'doctor' && rng() < brain.personality.claimRate) {
      const saved = self.intel.find((entry) => entry.kind === 'saved' && info.aliveSlots.includes(entry.targetSlot));
      if (saved) publish(saved.targetSlot, 'clear');
    }

    /**
     * Somebody just claimed to be you.
     *
     * The most reliable moment in Mafia, and the policy did not model it at
     * all: a unique role hearing its own name from another mouth stands up,
     * because one of the two is lying and the room can only find out if both
     * are on the record. It is also what makes bluffing *cost* something —
     * without it a Serial Killer could claim Doctor on the stand and be
     * acquitted by a room with no way to check, which is exactly what the
     * bench measured once defences started counting.
     *
     * Near-automatic for a genuine holder, because the alternative is watching
     * an impostor wear your badge for the rest of the game. Not entirely, since
     * a seat that has been quiet all evening does not always find its voice.
     */
    /**
     * The badge this seat is wearing, which is not always the one it holds.
     *
     * Read off the seat's own claims rather than its card, because a liar has
     * exactly the same problem as a genuine holder the moment somebody else
     * says its role out loud: the room is now looking at two Sheriffs and will
     * hang one of them. A liar that stays quiet through that has conceded the
     * badge and kept the suspicion, which is the worst of both, and it is what
     * this did — the check only ever fired for a seat claiming its real card.
     */
    const face =
      [...info.claims]
        .reverse()
        .find((claim) => claim.kind === 'role-claim' && claim.claimerSlot === self.slot && claim.claimedRole)
        ?.claimedRole ?? role;

    const impostor = info.claims.find(
      (claim) =>
        claim.kind === 'role-claim' &&
        claim.claimedRole === face &&
        claim.claimerSlot !== self.slot &&
        info.aliveSlots.includes(claim.claimerSlot)
    );
    if (impostor && roleDef(face).unique && rng() < 0.85) {
      // The badge goes up first if it has not been said yet; either way the
      // seat wearing it now says, out loud, that the other one is not it.
      if (!alreadyClaimed(info, self.slot, self.slot, 'role-claim')) publish(self.slot, 'role-claim', face);
      if (!alreadyClaimed(info, self.slot, impostor.claimerSlot, 'accuse')) publish(impostor.claimerSlot, 'accuse');
    }

    /* ---------------- The afternoon: ask, answer, needle ---------------- */

    /**
     * "Where were you last night?"
     *
     * The one thing every seat can do regardless of role, and the thing that
     * turns a day phase from a voting queue into a conversation. Asked of the
     * seats nobody has pinned down yet — the quiet ones who have neither claimed
     * anything nor been asked — because an account is only worth extracting from
     * somebody who has not already given one.
     */
    if (info.day >= 2 && rng() < stance.seekInfo * 0.5) {
      const unaccounted = others.filter(
        (slot) =>
          !teammates.has(slot) &&
          !info.claims.some((claim) => claim.kind === 'account' && claim.claimerSlot === slot) &&
          !info.claims.some((claim) => claim.kind === 'question' && claim.targetSlot === slot)
      );
      const asked = unaccounted[Math.floor(rng() * unaccounted.length)];
      if (asked !== undefined) publish(asked, 'question');
      /**
       * Asking again, of somebody who let the first one go.
       *
       * The pool above deliberately skips anyone already asked, which is right
       * for finding the quiet ones and wrong for everything after: a seat that
       * was asked on Tuesday and never answered is the most interesting seat at
       * the table, and the square dropped the subject entirely. Pressing is a
       * habit, not a policy, so only a seat that has it does it.
       */
      else if (quirked(quirks.press, rng)) {
        const dodging = others.filter(
          (slot) =>
            !teammates.has(slot) &&
            info.claims.some((claim) => claim.kind === 'question' && claim.targetSlot === slot) &&
            !info.claims.some((claim) => claim.kind === 'account' && claim.claimerSlot === slot)
        );
        const again = dodging[Math.floor(rng() * dodging.length)];
        if (again !== undefined) publish(again, 'question');
      }
    }

    /**
     * And answering when asked, which is where the lying starts.
     *
     * An honest seat says where it actually went — which outs it as a visiting
     * role, so even the town does not always want to. A dishonest one says it
     * stayed home, and `contradicted` will hang it if a lookout ever says
     * otherwise. That is the whole trap: the safe answer is the checkable one.
     */
    /**
     * Asked *today*. A question from three days ago is not a question any more,
     * and answering one is how a seat ends up volunteering its night to a square
     * that had stopped caring — the day filter here is the same one the
     * `alreadyAnswered` check below already had, and its absence was the whole
     * of "they self-claim for nothing".
     */
    const beingAsked = info.claims.some(
      (claim) => claim.kind === 'question' && claim.targetSlot === self.slot && claim.day === info.day
    );
    const alreadyAnswered = info.claims.some(
      (claim) => claim.kind === 'account' && claim.claimerSlot === self.slot && claim.day === info.day
    );
    /**
     * Or not answering, which no bot has ever done and every person does.
     *
     * A policy asked a question answers it, so the square's one piece of
     * social leverage has never yet met a seat that simply does not reply.
     * Checked before the answer rather than after, so a stonewalling seat
     * leaves the question standing and the room can make something of it.
     */
    const stonewalls = beingAsked && !alreadyAnswered && quirked(quirks.stonewall, rng);

    if (beingAsked && !alreadyAnswered && !stonewalls) {
      const honest = rng() < stance.answerHonestly;
      if (honest && brain.wentTo !== null && brain.wentTo !== self.slot) {
        publish(brain.wentTo, 'account', undefined, 'visited');
      } else if (honest) {
        publish(self.slot, 'account', undefined, 'home');
      } else {
        // The comfortable lie, and the one the record can catch.
        publish(self.slot, 'account', undefined, 'home');
      }
    }

    /**
     * Changing the story, unprompted.
     *
     * "I was home. Well, I went to 4's first, then home." Nobody in this file
     * has ever done it, so `contradicted`'s newest-account-wins rule — written
     * precisely because people correct themselves — has never had a correction
     * to read in the bench. A seat that waffles gives the room a second account
     * that does not match the first, which is the raw material for both the
     * rule and the reads built on it.
     */
    if (!beingAsked && quirks.waffle > 0 && info.day >= 2) {
      const mine = info.claims.filter((claim) => claim.kind === 'account' && claim.claimerSlot === self.slot);
      const standing = mine[mine.length - 1];
      if (standing && standing.day < info.day && quirked(quirks.waffle, rng)) {
        if (standing.account === 'home') {
          const elsewhere = others[Math.floor(rng() * others.length)];
          if (elsewhere !== undefined) publish(elsewhere, 'account', undefined, 'visited');
        } else {
          publish(self.slot, 'account', undefined, 'home');
        }
      }
    }

    /**
     * Standing up for somebody the record says is worth standing up for.
     *
     * The lodge covers its own and a family weighs whether to cover a brother,
     * and past that nobody defended anybody: a seat the graveyard had proved
     * town, or a badge the room had believed all game, could draw a wagon out of
     * nowhere and every other town seat watched it happen in silence. That is
     * the endgame nobody enjoys, and it is how a revealed Marshall nearly
     * handed a game away.
     *
     * A town seat speaks for a proven or believed one under real pressure. Its
     * own vote goes elsewhere anyway — `suspicionParts` already subtracts for a
     * proven seat — so this is the *saying* of it, which is the part the room
     * can hear. Evil seats are deliberately not here: the same paragraph would
     * have a mafioso vouching for the town's Sheriff, which no mafioso does
     * unless it is buying something, and that is `buildTrust`'s business.
     */
    if (agenda === 'town' && !gagged && info.day > 1) {
      const worthIt = others.find((slot) => {
        if (teammates.has(slot)) return false;
        const heat = votesAgainst(slot, info);
        if (heat < 2 && info.trialSlot !== slot) return false;
        if (alreadyClaimed(info, self.slot, slot, 'clear')) return false;
        const proven = info.provenRoles.get(slot);
        const vouched = (proven && roleDef(proven).faction === 'town') || uncontestedBadge(slot, info) !== null;
        return vouched || trustOf(slot, info) >= 1.2;
      });
      if (worthIt !== undefined && rng() < 0.7) publish(worthIt, 'clear');
    }

    /**
     * Somebody said they were home and a credible voice put them on a doorstep.
     * Every agenda piles onto that — the town because it is real evidence, the
     * rest because a wagon that is already rolling is the cheapest place to
     * spend a vote.
     */
    const caught = others.find((slot) => !teammates.has(slot) && contradicted(slot, info));
    if (caught !== undefined && rng() < 0.7) publish(caught, 'accuse');

    /* ------------------- the five kinds that were types only ---------------- */
    /**
     * `urge`, `demand`, `counter-claim`, `promise` and `relay` went into
     * `ClaimKind` with readers and writers to follow, and neither followed: the
     * board could hold them, and nothing ever put one on it or took one off.
     * Each is one sentence a real table says constantly, and between them they
     * are most of what an afternoon consists of once the evidence has run out.
     *
     * Written here together because they are all the same kind of move — talk
     * about the room rather than about the night — and because keeping them
     * adjacent makes it obvious when one of them is doing nothing.
     */
    if (!gagged && info.day > 1) {
      /**
       * "We have to vote." / "There is nothing here today."
       *
       * The room pushing on the clock instead of on a person. It names nobody,
       * so it moves no suspicion, and it is still the most consequential thing
       * anybody says on a quiet day: `steadyVote` skips a board below
       * `NO_CASE_CEILING` on its own authority, which on a slow afternoon is
       * every board, so the day ended before the argument had started.
       *
       * Which way a seat pushes is simply whether it likes its own best
       * suspect, and for a family seat whether that suspect is a brother, which
       * is the whole of why an evil seat wants a quiet day.
       */
      const alreadyUrged = info.claims.some(
        (claim) => claim.kind === 'urge' && claim.claimerSlot === self.slot && claim.day === info.day
      );
      if (!alreadyUrged && rng() < 0.3 + stance.pushHard * 0.4) {
        const best = others
          .map((slot) => ({ slot, score: suspicionParts(slot, self, info, rng).evidence }))
          .sort((left, right) => right.score - left.score)[0];
        const coveringOne = best !== undefined && teammates.has(best.slot);
        const wants: 'vote' | 'skip' =
          coveringOne || best === undefined || best.score < NO_CASE_CEILING ? 'skip' : 'vote';
        // Nobody asks for a quiet day at the parity clock: a wasted afternoon
        // loses outright, and a seat asking for one there has told the room
        // something about itself.
        if (wants === 'vote' || parityPressure(info) < 0.6) {
          publish(self.slot, 'urge', undefined, undefined, undefined, { urge: wants });
        }
      }

      /**
       * "Why me? Who put my name up?"
       *
       * The reciprocal of `question`: not a seat asked to account for its
       * night, but a seat asking its accusers to account for theirs. Hold the
       * people who vote on nothing to the nothing they voted on. The reason is
       * already computed — `why()` builds one for every accusation a bot makes
       * — so the answer costs nothing, and the silence when there is no answer
       * is the informative part.
       *
       * Asked of the accuser who has offered the least, because that is the one
       * the answer is worth hearing from.
       */
      const onMe = info.claims.filter(
        (claim) =>
          claim.kind === 'accuse' && claim.targetSlot === self.slot && info.aliveSlots.includes(claim.claimerSlot)
      );
      const silentAccuser = onMe.find(
        (claim) =>
          !alreadyClaimed(info, self.slot, claim.claimerSlot, 'demand') && !backedUp(claim.claimerSlot, self.slot, info)
      );
      if (silentAccuser && votesAgainst(self.slot, info) >= 1 && rng() < 0.6 + stance.pushHard * 0.3) {
        publish(silentAccuser.claimerSlot, 'demand');
      }

      /**
       * "He cannot be the Doctor."
       *
       * Denying a badge, which is not the same as calling somebody mafia and
       * was being flattened into an accusation, losing the one thing that makes
       * it answerable: *which* badge is contested.
       *
       * Said by the seat whose own badge was taken, which is the honest case,
       * and by a liar clearing the way for a mask it wants to wear. Both are
       * the same sentence and the room cannot tell them apart, which is exactly
       * what makes it worth saying.
       */
      const myRole = self.role;
      const thief = info.claims.find(
        (claim) =>
          claim.kind === 'role-claim' &&
          claim.claimedRole === myRole &&
          claim.claimerSlot !== self.slot &&
          info.aliveSlots.includes(claim.claimerSlot) &&
          !alreadyClaimed(info, self.slot, claim.claimerSlot, 'counter-claim')
      );
      if (thief && myRole && roleDef(myRole).faction === 'town' && rng() < 0.75) {
        publish(thief.claimerSlot, 'counter-claim', undefined, undefined, undefined, { deniedRole: myRole });
      }

      /**
       * "Three of you have said Escort."
       *
       * The block above is the victim speaking, and it only ever fires for the
       * seat whose own badge was taken. Which leaves the commonest version of
       * this uncovered entirely: the real one is already dead, or was never
       * dealt, and two or three liars reach for the same convenient coat. Then
       * nobody in the room is the victim, so nobody says anything — and a real
       * game ran with **three** living Escort claims on the board, unremarked,
       * for the rest of the afternoon.
       *
       * Nobody needs a badge to notice that. The claims are public and counting
       * them is arithmetic anybody at the table can do, which is what makes this
       * the one accusation that costs the speaker nothing and cannot be turned
       * around on them: at least one of those seats is lying, and saying so out
       * loud forces the liars to argue with each other.
       *
       * Aimed at the weakest of them — the one the room already trusts least —
       * because "one of you is lying" is a shrug and naming which one is a
       * question somebody has to answer. `suspicionParts` has priced duplicate
       * claims since long before this; what was missing was anybody *saying* it.
       */
      const byRole = new Map<RoleId, number[]>();
      for (const claim of info.claims) {
        if (claim.kind !== 'role-claim' || !claim.claimedRole) continue;
        if (!info.aliveSlots.includes(claim.claimerSlot)) continue;
        const seats = byRole.get(claim.claimedRole) ?? [];
        if (!seats.includes(claim.claimerSlot)) seats.push(claim.claimerSlot);
        byRole.set(claim.claimedRole, seats);
      }
      for (const [role, seats] of byRole) {
        /**
         * Only a role the table cannot hold twice. Two Doctors is a preset (`nuit-noire-24` deals exactly that),
         * two Sheriffs is any pair of `town-investigative` slots, and two truthful Citizens is most games; the
         * pricing in `suspicionParts` has always checked `unique` and this has to as well or it calls honest seats
         * liars in front of the whole room.
         */
        if (!roleDef(role).unique) continue;
        if (seats.length < 2 || seats.includes(self.slot)) continue;
        /**
         * And said once per contested seat per day, by whoever gets there first — not once per seat *hearing* it.
         * Every bot at the table can count, so without this every one of them rolled its own dice and five or six
         * repeated the same accusation on the same afternoon, which reads as a chorus and not a room.
         */
        const saidToday = (slot: number): boolean =>
          info.claims.some(
            (claim) =>
              claim.kind === 'counter-claim' &&
              claim.day === info.day &&
              claim.targetSlot === slot &&
              claim.deniedRole === role
          );
        const weakest = seats
          .filter((slot) => !saidToday(slot))
          .sort((left, right) => trustOf(left, info) - trustOf(right, info))[0];
        // Three mouths on one badge is louder than two, and worth interrupting for.
        if (weakest !== undefined && rng() < (seats.length >= 3 ? 0.7 : 0.4)) {
          publish(weakest, 'counter-claim', undefined, undefined, undefined, { deniedRole: role });
          break;
        }
      }

      /**
       * "Spare me and I will prove it tonight."
       *
       * A bet the next dawn settles, which is rarer and worth more than a
       * bluff, and the thing a Town Crier in a real game needed and did not
       * have: it speaks anonymously in the dark and can give that up to name
       * itself, so a room about to hang it has a cheaper option than being
       * wrong. `deduce.ts` collects at dawn either way, which is what stops it
       * being a free day for a liar, and is exactly why a liar under a wagon
       * reaches for it anyway.
       */
      const underTheRope = info.trialSlot === self.slot || votesAgainst(self.slot, info) >= 2;
      const alreadyPromised = info.claims.some((claim) => claim.kind === 'promise' && claim.claimerSlot === self.slot);
      if (underTheRope && !alreadyPromised) {
        const canSettleIt = myRole != null && PROVABLE.has(myRole);
        const honest = canSettleIt && rng() < 0.8;
        const bluffing = !canSettleIt && rng() < stance.falseAccuse * 0.5;
        if (honest || bluffing) {
          const onTheSpot = myRole === 'mayor' || myRole === 'marshall';
          publish(self.slot, 'promise', undefined, undefined, undefined, { promise: onTheSpot ? 'now' : 'night' });
        }
      }

      /**
       * "The Sheriff checked 3 and got nothing."
       *
       * Somebody else's claim, repeated, which is what most of a real table's
       * talk is made of and which the board had no way to tell from a firsthand
       * report. That matters because it is the cheapest lie available: nobody
       * can fabricate a Sheriff's check, and anybody can fabricate having
       * *heard* it.
       *
       * A herd-ish seat repeats whoever the room is currently listening to. The
       * lie is not written here at all, because it is the same call with a
       * source who never said it, and the seat named can simply deny it, which
       * `deductions` then holds against the relayer.
       */
      const worthRepeating = info.claims.filter(
        (claim) =>
          (claim.kind === 'accuse' || claim.kind === 'clear') &&
          claim.claimerSlot !== self.slot &&
          claim.targetSlot !== self.slot &&
          !teammates.has(claim.targetSlot) &&
          claimerWeight(claim.claimerSlot, info) >= 1.3 &&
          !alreadyClaimed(info, self.slot, claim.targetSlot, 'relay')
      );
      const echo = worthRepeating[Math.floor(rng() * worthRepeating.length)];
      if (echo && rng() < brain.personality.herd * 0.35) {
        publish(echo.targetSlot, 'relay', undefined, undefined, undefined, { relayedFrom: echo.claimerSlot });
      }
    }

    /**
     * Noise, on purpose. A taunt carries no evidential weight anywhere in this
     * model — it exists so the record contains things that are not information,
     * because a square where every sentence is a data point is not a square.
     */
    if (rng() < stance.troll * 0.35) {
      const mark = others[Math.floor(rng() * others.length)];
      if (mark !== undefined) publish(mark, 'taunt');
    }

    /* --------------------------- masks and gambits --------------------------- */

    /**
     * The Jester's audition.
     *
     * He claims something big and checkable — Veteran, Jailor, Mayor — precisely
     * so the town calls it a lie and reaches for the rope, and he pairs it with
     * accusations that contradict what the room can see. Both are the product.
     */
    if (agenda === 'jester') {
      /**
       * One act a day, and the acts escalate.
       *
       * The stance hands a fresh Jester every appetite at once, and played
       * straight that produced a seat that claimed Veteran, accused the calmest
       * person in the room and needled a third in its first breath. That is not
       * a liar, it is a Jester, and the town read it as one and left him alone.
       * A real one builds: an odd accusation first, a big checkable claim once
       * that has not landed, and more odd accusations once the room has learned
       * to expect nothing from him. The ignored-meter picks the rung, so a
       * Jester the room is already eyeing stops escalating and lets the wagon
       * come.
       */
      const accusedBefore = info.claims.some((claim) => claim.kind === 'accuse' && claim.claimerSlot === self.slot);
      const claimedBefore = info.claims.some((claim) => claim.kind === 'role-claim' && claim.claimerSlot === self.slot);
      const oddAccusation = (): void => {
        // Deliberately the *least* suspected seat: contradicting the room is
        // how he gets called a liar.
        const calmest = others
          .filter((slot) => !contradicted(slot, info))
          .map((slot) => ({ slot, heat: suspicion(slot, self, info, rng) }))
          .sort((a, b) => a.heat - b.heat)[0];
        if (calmest) publish(calmest.slot, 'accuse');
      };
      /**
       * The `scum` Jester's accusation is the opposite shape: not the calmest
       * seat but the one already under the biggest wagon, provided the room has
       * nothing hard on them. Piling onto a townsperson with no reason is what a
       * mafioso in a hurry does, and it is read as one.
       */
      const pileOn = (): void => {
        const wagon = others
          .filter((slot) => votesAgainst(slot, info) > 0 && suspicionParts(slot, self, info, rng).hard < 1)
          .sort((left, right) => votesAgainst(right, info) - votesAgainst(left, info))[0];
        if (wagon !== undefined) publish(wagon, 'accuse');
        else oddAccusation();
      };
      const accuse = styleOf(self, brain, rng) === 'scum' ? pileOn : oddAccusation;
      if (!accusedBefore) {
        if (rng() < stance.falseAccuse) accuse();
      } else if (!claimedBefore && info.day >= 3 && brain.desperation >= 0.5) {
        const mask = pickMask('jester', stance, rng, burnedFaces(info));
        if (mask) publish(self.slot, 'role-claim', mask);
      } else if (claimedBefore && rng() < stance.falseAccuse * 0.5) {
        accuse();
      }
    }

    /**
     * And the mirror of it: a cornered villain claiming to *be* the Jester,
     * because hanging a jester hands him the game and the whole room knows it.
     * The best sentence available to a mafioso with three votes on his head.
     */
    if (agenda !== 'jester' && agenda !== 'town' && stance.jesterGambit > 0) {
      const mask = pickMask(agenda, stance, rng, burnedFaces(info));
      if (mask) publish(self.slot, 'role-claim', mask);
    }

    /**
     * Buying a seat at the table. Evils and parasites vote with the room on
     * things they actually agree about — a confirmed evil corpse's accuser, a
     * seat the record has already caught — because credibility is spent late and
     * has to be earned early.
     */
    if (rng() < stance.buildTrust * 0.3 && caught !== undefined && !teammates.has(caught)) {
      publish(caught, 'accuse');
    }

    // Neutral parasites fake investigations too: a scumbag or a witch
    // pointing a finger costs them nothing they weren't already losing.
    if ((role === 'scumbag' || role === 'witch') && rng() < brain.personality.deceit * 0.25) {
      const marks = others.filter((slot) => votesAgainst(slot, info) > 0);
      const mark = marks[0] ?? (rng() < 0.3 ? others[Math.floor(rng() * others.length)] : undefined);
      if (mark !== undefined) publish(mark, 'accuse');
    }

    // Family lies, priced. A fake accusation goes where suspicion already
    // lives — piling on is safe, inventing is how liars get caught.
    if (familyOf(role) !== null) {
      if (rng() < stance.falseAccuse * 0.4) {
        const marks = others
          .filter((slot) => !teammates.has(slot))
          .map((slot) => ({
            slot,
            heat:
              votesAgainst(slot, info) + info.claims.filter((c) => c.targetSlot === slot && c.kind === 'accuse').length
          }))
          .sort((a, b) => b.heat - a.heat);
        const mark = marks[0];
        if (mark && (mark.heat > 0 || rng() < 0.25)) publish(mark.slot, 'accuse');
      }
      // With the rope close, wear a face. Which face is `pickMask`'s business —
      // a boring one to get through the day, a frightening one to get through
      // the night, or the Jester's, which makes hanging you a mistake.
      if (rng() < stance.fakeClaim * 0.7) {
        const mask = pickMask(agenda, stance, rng, burnedFaces(info));
        if (mask) publish(self.slot, 'role-claim', mask);
      }
    }

    /**
     * The family's investigator buys trust with the truth.
     *
     * A Consigliere learns exact roles and used to say nothing about any of
     * them, which threw away the cheapest credibility in the game. A rival
     * killer, a Triad soldier when you are Mafia, a Witch: handing the town one
     * of those costs the family nothing, removes a competitor, and leaves the
     * seat wearing a badge the graveyard will shortly sign for, which is then
     * worth a vote nobody questions on the day it matters. Said the way an
     * investigator would say it, with the badge on when the face is free. Any
     * family seat with a `role` entry qualifies, so a Janitor who cleaned a
     * Serial Killer reports it the same way. Eagerly when a lone blade is
     * loose, since the family wants that one gone as much as anybody does.
     */
    if (familyOf(role) !== null) {
      const rivals = self.intel.filter(
        (entry) =>
          entry.kind === 'role' &&
          entry.value in ROLES &&
          isEvilRole(entry.value as RoleId) &&
          info.aliveSlots.includes(entry.targetSlot) &&
          !teammates.has(entry.targetSlot) &&
          !alreadyClaimed(info, self.slot, entry.targetSlot, 'accuse')
      );
      const rival = rivals[rivals.length - 1];
      const eagerness = Math.max(stance.buildTrust, info.rampage >= 1 ? 0.7 : 0);
      if (rival && rng() < eagerness * 0.6) {
        publish(rival.targetSlot, 'accuse');
        const face = (['sheriff', 'investigator'] as RoleId[]).find((badge) => !burnedFaces(info).has(badge));
        if (
          face &&
          !alreadyClaimed(info, self.slot, self.slot, 'role-claim') &&
          rng() < 0.4 + brain.personality.deceit * 0.5
        ) {
          publish(self.slot, 'role-claim', face);
        }
      }
    }

    /**
     * Covering a brother — or deciding not to.
     *
     * The lodge always vouches; the family weighs it. Once `sacrificeAlly`
     * outruns the instinct to protect, the smart play is silence: let the room
     * have him, keep the credit for having agreed with them, and be two votes
     * safer tomorrow. Past that, the family actively hands him over — which buys
     * more trust than any claim in this model can.
     */
    const brotherInDanger = [...teammates].find(
      (slot) => info.aliveSlots.includes(slot) && (votesAgainst(slot, info) >= 2 || info.trialSlot === slot)
    );
    if (brotherInDanger !== undefined) {
      const family = familyOf(role) !== null;
      const feedHim = family && rng() < stance.sacrificeAlly;
      if (feedHim) {
        // Not a word in his defence, and a vote to prove the point.
        if (rng() < stance.sacrificeAlly * 0.6) publish(brotherInDanger, 'accuse');
      } else if (rng() < (family ? stance.fakeClaim * 0.6 : 0.55)) {
        publish(brotherInDanger, 'clear');
      }
    }

    if (role === 'executioner' && self.obsessionId && rng() < brain.personality.deceit) {
      const obsession = self.obsessionSlotHint ?? null;
      if (obsession !== null && info.aliveSlots.includes(obsession)) publish(obsession, 'accuse');
    }
  }

  /* -------- Vote. -------- */
  if (info.day > 1) {
    decision.voteSlot = pickVote(self, brain, info, teammates, familyKnownEvil, rng);
  }

  /* -------- Jailor picks tonight's prisoner. -------- */
  if (role === 'jailor') {
    // Early game the cell is an interrogation room: safe-check the quiet,
    // unclaimed seats nobody knows anything about. Once parity looms, it's an
    // execution chamber for the top suspect.
    /**
     * A name the night has settled goes in the cell whatever the clock says.
     *
     * The rules below ask the room how suspicious somebody is, and early in a
     * game the room knows nothing, so the cell spent its nights interviewing
     * strangers while a seat the Jailor could have worked out for itself walked
     * around free. The cell is also the safest place in the game to be wrong:
     * an innocent prisoner loses one night's power and lives.
     */
    const sure = surestSuspect(self, info, 0.7, teammates);
    const pressure = parityPressure(info);
    if (sure && others.includes(sure.slot)) {
      decision.jailSlot = sure.slot;
    } else if (pressure >= 0.6) {
      const suspects = others
        .map((slot) => ({ slot, score: suspicion(slot, self, info, rng) }))
        .sort((a, b) => b.score - a.score);
      const top = suspects[0];
      if (top && top.score >= 1) decision.jailSlot = top.slot;
    } else {
      const quiet = others.filter(
        (slot) =>
          !info.claims.some((claim) => claim.claimerSlot === slot) &&
          Math.abs(trustOf(slot, info)) < 1.0 &&
          !self.intel.some((entry) => entry.targetSlot === slot && entry.kind === 'sheriff' && entry.value === 'clear')
      );
      const pick = quiet[Math.floor(rng() * quiet.length)];
      if (pick !== undefined && rng() < 0.8) decision.jailSlot = pick;
    }
  }

  /* --------------------- The mayor takes the sash off the shelf. -------------------- */

  /**
   * He used to come out only when the rope was already looking at him.
   *
   * Two conditions, both defensive: two votes on him, or standing on the
   * trapdoor. Which means the sash was never once used for the thing it does —
   * it was an escape hatch, pulled at the last possible moment, and a Mayor who
   * reveals *on the stand* has bought himself one afternoon and told the family
   * exactly whose door to use tonight. The town got the three votes for one day
   * and then lost him.
   *
   * The sash is worth three ballots every day he lives, and it is worth them
   * only on days where three ballots change something. So he now comes out when
   * that is true, and stays a normal seat when it is not:
   *
   *  - **There is a wagon he agrees with, and he can finish it.** Somebody he
   *    genuinely suspects is most of the way to a trial. Three votes closes a
   *    gap one vote cannot, and it closes it today, in front of everybody.
   *  - **The clock has run down.** At parity pressure the town does not get
   *    another quiet afternoon to be careful in, and a sash saved for a day
   *    that never comes is a sash wasted.
   *  - **He is holding something nobody will act on.** A seat that has accused
   *    the same person twice and been ignored is a seat with no weight, and the
   *    sash is exactly the weight it is missing.
   *
   * Never on day one, whatever happens: revealing before anybody has said
   * anything hands the family a free kill and buys three votes on a day with
   * nothing to vote about. And the defensive trigger stays, because an escape
   * hatch is still worth having when the rope is genuinely around his neck.
   */
  if ((role === 'mayor' || role === 'marshall') && !self.revealed) {
    const cornered = votesAgainst(self.slot, info) >= 2 || info.trialSlot === self.slot;
    if (cornered) decision.revealMayor = true;

    // The mayor only: this reasoning is about three ballots, and the marshall's reveal is not three ballots. He has
    // his own trigger below.
    if (role === 'mayor' && !cornered && info.day >= 2) {
      /** A wagon on somebody he actually believes is guilty, close enough that three ballots land it. */
      const wagons = [...new Set(info.votes.values())].filter((slot) => slot !== self.slot);
      const finishable = wagons.some(
        (slot) => wagonAlong(slot, info) >= 0.4 && suspicion(slot, self, info, rng) >= 2
      );
      /** Twice accused the same seat, and the room has not moved once. */
      const mine = info.claims.filter(
        (claim) => claim.kind === 'accuse' && claim.claimerSlot === self.slot && claim.day >= info.day - 2
      );
      const ignored = mine.length >= 2 && !mine.some((claim) => votesAgainst(claim.targetSlot, info) >= 2);

      /**
       * Two reasons and a nudge. A wagon he can finish and a case nobody will act on are reasons: each names the
       * day three ballots change. The late-game term is not a reason, it is the observation that a sash still on
       * the shelf on day eight is probably never coming off, and at fifteen points a day it was revealing Mayors
       * for nothing on quiet afternoons. Five is a nudge.
       */
      const chance =
        (finishable ? 0.55 : 0) + parityPressure(info) * 0.5 + (ignored ? 0.3 : 0) + (info.day >= 5 ? 0.05 : 0);
      if (rng() < chance) decision.revealMayor = true;
    }

    // The marshall also comes out when the town has real leads to burn through.
    if (
      role === 'marshall' &&
      info.day >= 4 &&
      info.claims.filter((claim) => claim.kind === 'accuse').length >= 3 &&
      rng() < 0.3
    ) {
      decision.revealMayor = true;
    }
  }

  /* The judge convenes his court when a wagon already carries real suspicion. */
  if (role === 'judge' && self.charges > 0 && info.day >= 3) {
    const wagons = [...new Set(info.votes.values())];
    const juicy = wagons.some((slot) => suspicion(slot, self, info, rng) >= 2);
    if (juicy && rng() < 0.35) decision.callCourt = true;
  }

  return decision;
}

/**
 * Roles it would be suicide to claim: already in the ground, or already worn by
 * somebody still breathing. Claiming a burned face is how a liar gets caught in
 * one sentence, so every mask draw filters through this.
 */
/**
 * Faces a liar cannot wear: taken, buried, or never dealt.
 *
 * The third was missing, and it made the whole table look stupid in opposite
 * directions at once. The roster is printed on every screen, so claiming a role
 * this game does not contain is not a bluff — it is a confession that the
 * speaker has not read the sheet everybody else is looking at. `pickMask` was
 * choosing from a static list regardless, so bots routinely claimed roles that
 * were never dealt, and once `deductions` learned to check the roster it caught
 * them at it every single afternoon. The bench read as a triumph of deduction
 * and was really a liar with its eyes shut.
 *
 * Both halves belong: a competent liar picks a face the roster allows, and a
 * room that hears an impossible one says so. Which is what makes the check
 * worth keeping even now that the bots rarely trip it — the seats that will
 * trip it are people and models, who genuinely do claim roles that are not in
 * the game.
 */
function burnedFaces(info: PublicInfo): Set<RoleId> {
  const burned = new Set<RoleId>();
  if (info.rolesInPlay) {
    for (const role of Object.keys(ROLES) as RoleId[]) {
      if (!info.rolesInPlay.has(role)) burned.add(role);
    }
  }
  for (const role of info.deadRoles.values()) burned.add(role);
  for (const claim of info.claims) {
    if (claim.kind === 'role-claim' && claim.claimedRole && info.aliveSlots.includes(claim.claimerSlot)) {
      burned.add(claim.claimedRole);
    }
  }
  return burned;
}

/**
 * Roles that can settle a doubt about themselves by acting, and be believed.
 *
 * The test is whether the *record* moves, not whether the seat is telling the
 * truth: a Crier who names itself in the dark, a Mayor who reveals, an
 * investigator who announces tomorrow's check in advance have all put something
 * on the board that the next dawn either shows or does not. A Doctor promising
 * to heal somebody has promised nothing anybody can check.
 */
const PROVABLE: ReadonlySet<RoleId> = new Set<RoleId>([
  'crier',
  'mayor',
  'marshall',
  'sheriff',
  'investigator',
  'lookout',
  'detective',
  'veteran',
  'jailor'
]);

/**
 * Has this accuser ever offered the room a reason for it?
 *
 * Anything checkable counts: a doorstep, a hunch with a shape to it, a night
 * this seat says it spent watching, somebody else's finding repeated. What does
 * not count is the accusation itself, which is the point — "he is mafia" said
 * twice is not twice as much of a reason as saying it once.
 */
function backedUp(claimerSlot: number, targetSlot: number, info: PublicInfo): boolean {
  return info.claims.some(
    (claim) =>
      claim.claimerSlot === claimerSlot &&
      claim.targetSlot === targetSlot &&
      (claim.kind === 'hint' || claim.kind === 'sighting' || claim.kind === 'relay' || claim.kind === 'counter-claim')
  );
}

/**
 * An accusation the room asked about and never got an answer to.
 *
 * The other half of `demand`. A seat that names somebody, is asked why, and
 * says nothing more has not made a case; it has made a noise, and the board was
 * counting it at full weight alongside a Sheriff's check. Discounting it is
 * what makes asking worth anything, and it is the mechanism behind holding
 * people who vote on nothing to the nothing they voted on.
 *
 * A day of grace on purpose: the demand and the answer generally land in the
 * same afternoon, and punishing an accuser in the same breath as the question
 * would mean the question was never really asked.
 */
function dodgedTheQuestion(claimerSlot: number, targetSlot: number, info: PublicInfo): boolean {
  const asked = info.claims.find(
    (claim) => claim.kind === 'demand' && claim.claimerSlot === targetSlot && claim.targetSlot === claimerSlot
  );
  if (!asked || info.day <= asked.day) return false;
  return !backedUp(claimerSlot, targetSlot, info);
}

function alreadyClaimed(info: PublicInfo, claimerSlot: number, targetSlot: number, kind: ClaimKind): boolean {
  return info.claims.some(
    (claim) => claim.claimerSlot === claimerSlot && claim.targetSlot === targetSlot && claim.kind === kind
  );
}

function pickVote(
  self: MafiaPlayer,
  brain: Brain,
  info: PublicInfo,
  teammates: Set<number>,
  familyKnownEvil: Set<number>,
  rng: () => number
): number | null {
  const role = self.role!;
  const candidates = info.aliveSlots.filter((slot) => slot !== self.slot);

  if (role === 'executioner') {
    const obsession = self.obsessionSlotHint ?? null;
    if (obsession !== null && info.aliveSlots.includes(obsession)) return obsession;
  }

  /** Every wagon running today that this seat could join. */
  const wagons = [...new Set(info.votes.values())].filter((slot) => slot !== self.slot && candidates.includes(slot));

  if (role === 'jester') {
    if (styleOf(self, brain, rng) === 'scum') {
      /**
       * The bus driver's ballot. On the wagon when it is on somebody the room has
       * nothing on, off it when it is on somebody the room has caught, and with
       * no wagon at all, half the time, a fresh one on the seat the room trusts
       * most. Every one of those is a thing `trustOf` remembers and prices.
       */
      const rides = wagons
        .map((slot) => ({ slot, caught: suspicionParts(slot, self, info, rng).hard, along: wagonAlong(slot, info) }))
        .filter((wagon) => wagon.caught < 1)
        .sort((left, right) => right.along - left.along)[0];
      if (rides) return rides.slot;
      if (wagons.length > 0) return null;
      const cleanest = candidates
        .map((slot) => ({ slot, warmth: trustOf(slot, info) }))
        .sort((left, right) => right.warmth - left.warmth)[0];
      return cleanest && rng() < 0.5 ? cleanest.slot : null;
    }
    // Chaos: vote someone random, often, to look erratic.
    if (rng() < 0.6) return candidates[Math.floor(rng() * candidates.length)] ?? null;
    return null;
  }

  if (role === 'survivor') {
    const loudest = wagons
      .map((slot) => ({ slot, along: wagonAlong(slot, info) }))
      .sort((left, right) => right.along - left.along)[0];
    // The town is losing, so the seats it suspects are the wrong wagon: ride the biggest one, whoever is under it.
    if (tide(info) === 'evil' && loudest) return loudest.slot;
    // In a hurry, any real wagon is a way to make the table smaller tonight.
    if (styleOf(self, brain, rng) === 'hurried' && info.day >= 4 && loudest && loudest.along >= 0.3) {
      return loudest.slot;
    }
    // Otherwise, and whenever the town is winning, he votes as the town does: fall through.
  }

  const isMafiaSeat = teammates.size > 0;

  /**
   * The bus, boarded on purpose.
   *
   * A brother one vote from the rope hangs whatever this seat does, and the
   * seat that is the only one at the table not on that wagon has told the room
   * as much as a confession would. Joining costs nothing he was not already
   * losing and buys the day of credit `trustOf` pays for a guilty vote on a
   * revealed evil. Cold seats do it as a matter of course; warmer ones once the
   * family is losing badly enough that `sacrificeAlly` says so.
   *
   * The first shape scored a doomed brother at half a point, which lost to any
   * real suspect on the board, so the bus was decided and then never boarded.
   */
  if (isMafiaSeat) {
    const needed = Math.floor(info.aliveSlots.length / 2) + 1;
    const doomed = [...familyKnownEvil].find(
      (slot) => slot !== self.slot && info.aliveSlots.includes(slot) && votesAgainst(slot, info) >= needed - 1
    );
    if (doomed !== undefined) {
      const stance = stanceOf(agendaOf(role), brain.desperation, brain.personality);
      const cold = brain.personality.deceit > 0.55;
      if (rng() < (cold ? 0.7 : 0.2) + stance.sacrificeAlly * 0.3) return doomed;
    }
  }

  const teammateWagons = new Set(
    [...info.votes.entries()].filter(([voter]) => teammates.has(voter)).map(([, target]) => target)
  );

  // The parity clock and the shortlist: as LyLo approaches, a town seat stops
  // guessing among everyone and starts counting among the possible.
  const pressure = isMafiaSeat ? 0 : parityPressure(info);
  const possible = pressure >= 0.6 && !isMafiaSeat ? possibilitySet(self, info) : null;
  const pool = possible && possible.size > 0 ? candidates.filter((slot) => possible.has(slot)) : candidates;

  const scored = pool
    .filter((slot) => !teammates.has(slot))
    .map((slot) => {
      const parts = suspicionParts(slot, self, info, rng);
      const evidence = parts.evidence;
      let score = parts.evidence + parts.wagon;
      // A short shortlist is itself evidence: it must be one of you.
      if (possible && possible.size <= 3 && possible.has(slot)) score += 1;

      /**
       * And the seat with its hand up against this one.
       *
       * Counter-voting, which is half of answering an accusation and the half
       * that costs the accuser something. A seat that opens a wagon on
       * nothing should be spending its own safety to do it; until now it
       * spent nothing at all, because the accused's ballot went wherever the
       * evidence pointed and the evidence never pointed at the person doing
       * the accusing.
       *
       * Deliberately small. This is a thumb on the scale and not a rule: a
       * seat that always votes its loudest accuser is a seat anybody can aim
       * by accusing it, which is a worse exploit than the one being fixed.
       * And never at somebody who gave a reason — answer the reason.
       */
      if (
        info.claims.some(
          (claim) =>
            claim.kind === 'accuse' &&
            claim.claimerSlot === slot &&
            claim.targetSlot === self.slot &&
            !backedUp(slot, self.slot, info)
        )
      ) {
        score += 0.8;
      }
      if (isMafiaSeat) {
        // Never your own brother. The bus, when it is boarded, is boarded on
        // purpose above, not by a brother outscoring a stranger here.
        if (familyKnownEvil.has(slot)) return { slot, score: -10, evidence: 0, hard: 0 };
        if (teammateWagons.has(slot)) score += 1.5;

        /**
         * A wagon one or two votes short of the stand, which is a free hanging.
         *
         * The cheapest thing a family ever does and the thing this one never
         * did. The town builds a case against one of its own all afternoon,
         * gets within a vote of a trial, and the family sits on its hands
         * scoring that seat on the same evidence everybody else is looking at —
         * as if it were trying to find the killer rather than trying to bury a
         * townie. A transcript from a real game has three separate afternoons
         * ending in "the town would rather hang nobody" with a wagon already
         * two thirds built.
         *
         * Scaled by how far along the wagon is, rather than switched on at one
         * or two votes short. That was the first shape and the bench said it
         * fires on 2.4% of the votes a family seat ever scores: a majority of
         * the living is a lot of names to gather, and the moment the last one
         * lands the trial opens, so "nearly there" is a doorway rather than a
         * room. A family that only acts in that doorway is a family that never
         * acts.
         *
         * So the whole slope counts. A wagon at six of seven is worth going out
         * of your way for; one at two of seven is worth a nudge; one at nothing
         * is worth nothing, which is what `votesAgainst` returns for it. What
         * the family is really doing is preferring *whoever the town has
         * already started on* over its own read, which is the cheapest day it
         * can have — the town does the work, the family only has to agree.
         *
         * Never a brother: the check above has already priced one at minus ten
         * and this is added to that.
         *
         * From day three, because an early wagon is mostly the town flailing at
         * random, and joining it costs a night of knives to hang somebody it was
         * going to hang anyway. By day three the town is building cases on
         * something, and a case on the wrong person is the family's best
         * afternoon of the week.
         */
        if (info.day >= 3) score += 2.4 * wagonAlong(slot, info);
        /**
         * To the people it is aimed at, the sash is a target and not a shield.
         *
         * `suspicionParts` subtracts for a proven town seat, which is what
         * keeps the square from hanging its own Mayor — and would also have
         * quietly talked the family out of the best day vote available to it.
         * A revealed Mayor votes three times and cannot be lied about; the
         * family wants that gone and does not mind who sees it try.
         */
        if (slot === info.revealedMayorSlot) score += 3;
        // A rampaging solo killer threatens the family too: for a while, the
        // mafia votes with the town against whoever the evidence points at.
        if (info.rampage >= 2 && info.claims.some((claim) => claim.kind === 'accuse' && claim.targetSlot === slot)) {
          score += 1.2;
        }
      }
      return { slot, score, evidence, hard: parts.hard };
    })
    .sort((a, b) => b.score - a.score);

  /**
   * A seat the room tried and let go today, on the same evidence.
   *
   * A trial is the room's answer to a question it asked, and asking it again an
   * instant later with nothing new is not persuasion, it is a loop: the same
   * ranking produces the same top name, the threshold falls again, and the
   * afternoon is spent putting one person on the stand until the trial cap runs
   * out. It is also the single most hostile thing this table does to a human,
   * because the human is usually the one holding the wrong end of it.
   *
   * Hard evidence lifts the bar: something the room can point to — a check, a
   * contradiction, a confession — is a new case rather than the old one said
   * louder, and it is allowed to try again. A seat with nothing new looks
   * elsewhere, and a seat with nowhere else to look says nothing at all, which
   * lets the day end on a skip instead of on a ninth acquittal.
   */
  const sparedToday = new Set(
    info.trials.filter((trial) => trial.day === info.day && !trial.lynched).map((trial) => trial.accusedSlot)
  );
  const open = sparedToday.size === 0 ? scored : scored.filter((seat) => !sparedToday.has(seat.slot) || seat.hard > 0);

  /**
   * A name this seat is sure of, which outranks the ranking.
   *
   * The ordinary scoring is a comparison between seats and has no notion of
   * being *certain*: a seat the reader has personally checked and a seat it
   * merely dislikes are numbers on the same scale, and the dislike sometimes
   * wins on jitter. Anything past this bar is knowledge rather than suspicion,
   * so it is voted directly.
   *
   * Never for a killer's own side: this arithmetic does not know who anybody's
   * friends are, and a mafioso reasoning its way to its own Godfather would
   * hand the game over out of sheer competence. The family already knows.
   */
  if (!isMafiaSeat && !isEvilRole(role)) {
    const sure = surestSuspect(self, info, 0.8, teammates);
    /**
     * And the acquittal that does not survive the parity bell.
     *
     * A seat tried and released today is normally off the list for the rest of
     * the afternoon: asking the same question twice with nothing new is the
     * loop this filter exists to stop. Being *sure* is not nothing new, but it
     * is also not new *today* — the reading was the same before the trial — so
     * it only overrides the filter where the alternative is losing the game.
     * At the bell the booth votes with the square (see `decideBallot`), so the
     * second trial is a different question with a different answer.
     */
    const reachable = pressure >= 1 ? scored : open;
    if (sure && reachable.some((seat) => seat.slot === sure.slot)) return sure.slot;
  }

  const top = open[0];
  if (!top) return null;

  // Desperation lowers the bar; at full LyLo the town must lynch someone.
  const threshold = (1.7 - brain.personality.aggression) * (1 - 0.6 * pressure);
  if (pressure >= 1) return top.slot;

  /**
   * A crowd is not a reason.
   *
   * The score that clears the threshold may be mostly other people's votes, and
   * letting that through is what turned "5, you're dead meat" into a lynching:
   * one seat guesses, two more read the guess as evidence, and the town spends
   * its afternoon and one of its own on nothing. So a vote wants *some* of its
   * case to come from the board — less as the clock runs down, because a town
   * at the parity clock cannot afford to be sure, and none at all once the
   * shortlist has done the work for it.
   *
   * Deliberately a floor and not a veto: past it the wagon still counts for
   * everything it counted for before, which is what lets a real case gather the
   * room quickly.
   */
  const evidenceFloor = 0.55 * (1 - pressure) * (possible && possible.size <= 3 ? 0 : 1);

  /**
   * Hearsay, and what it costs to hang somebody on it.
   *
   * The bench was asked why the rope kept finding town, and the answer was not
   * subtle: of the town seats that went to the gallows, **92%** went there on a
   * day when not one living juror held a single checkable thing against them —
   * no check, no fatal house, no claim the graveyard had broken. The average
   * best evidence anybody had was 0.16. Day two was the worst of it: the
   * largest pile of hangings in the game, 59% of them town, and the room was
   * not even frightened yet.
   *
   * The arithmetic said it would be. A bare accusation is worth 2.0 through
   * `chorus`, the bar to vote sits near 1.0, and the evidence floor at low
   * pressure is 0.38 — so *one* seat saying "5 is mafia", with nothing behind
   * it and no reason given, cleared every gate the town had. The average town
   * hanging was built by 1.3 accusers. One voice, one afternoon, one corpse.
   *
   * So a case nobody can check needs a room behind it rather than a voice. Set
   * where two independent unproven seats clear it and one never does, which is
   * the discount `chorus` already applies made into a threshold: the first
   * person to say it is an opinion, the second one agreeing is the beginning of
   * evidence.
   *
   * And it lifts as the clock runs out, to nothing at the parity bell. A town
   * that has run out of days must hang somebody on a hunch — that is the game
   * working. A town on day two with eleven people alive and an afternoon to
   * spend has no such excuse, and this is what the desperation meter was for:
   * not only lowering the bar when things are dire, but holding it up when they
   * are not.
   */
  /**
   * Swept on the bench from 1.2 to 2.6 at four table sizes. Accuracy rises all
   * the way up and hangings fall all the way up, so the number is a choice
   * about which mistake the table should make: 2.6 hangs the right seat two
   * times in three and hangs half as often, which starves every role whose win
   * needs a rope. This is the knee — ten points of accuracy for one hanging a
   * game, with the Jester and the Executioner still playable.
   */
  const HEARSAY_FLOOR = 2.2;
  const unchecked = top.hard > 0 ? 0 : HEARSAY_FLOOR * (1 - pressure);
  if (top.score >= threshold && top.evidence >= Math.max(evidenceFloor, unchecked)) return top.slot;

  /**
   * Aggressive seats sometimes start a wagon on a hunch.
   *
   * Rarer than it was: at eight per cent a table of fifteen opened one nearly
   * every afternoon. Still allowed, because a table where nobody ever pushes
   * without proof is a table that never finds anything — but it is a hunch, so
   * it is only ever a hunch about *somebody the room has already noticed*.
   * Unconditional, it walked straight through the hearsay floor above and put
   * back a good share of what that floor had just taken out.
   */
  if (top.evidence >= 0.8 && rng() < brain.personality.aggression * 0.04) return top.slot;
  return null;
}

/**
 * How much the accused helped themselves, standing there.
 *
 * The trial was theatre. A seat could give the best defence of the evening —
 * claim a role nothing contradicted, account for its night, name a proven liar
 * as the one pushing the wagon — and the ballot would not move by a thousandth,
 * because `decideBallot` read `suspicion`, and `suspicion` reads the claims
 * board, and nothing about *having answered* was on it. Bots defended
 * themselves well and were hanged anyway, every time, which is the single most
 * demoralising thing a table can watch.
 *
 * So this is the other half of the ledger: what the accused put up today, and
 * only today. A claim from three days ago is not a defence, it is a fact the
 * board already priced in.
 *
 * Only the *unrefuted* counts. A role claim that clashes with a living rival or
 * with the graveyard is already punished inside `suspicion`, and would be
 * double-counted here; what earns credit is a claim the room could check and
 * did not manage to break.
 */
export function defenceStrength(accusedSlot: number, info: PublicInfo): number {
  const today = info.claims.filter((claim) => claim.claimerSlot === accusedSlot && claim.day === info.day);
  if (today.length === 0) return 0; // said nothing; there is nothing to weigh

  let credit = 0;

  const roleClaim = today.find((claim) => claim.kind === 'role-claim');
  /**
   * A confession is not a defence, whatever else was said with it.
   *
   * The scoring here asks one question of a role claim — could the room break
   * it — and a killer's own badge passes that test perfectly: nobody else is
   * claiming Serial Killer and there is none in the graveyard, so an
   * unbreakable unique claim earned the *largest* credit this function gives.
   * A man admitting to the murders was scored as having defended himself well,
   * and it was the difference between a conviction and an acquittal at the
   * parity bell. See `suspicionParts`, which charges for it on the other side.
   */
  if (roleClaim?.claimedRole && isEvilRole(roleClaim.claimedRole)) return 0;
  if (roleClaim?.claimedRole) {
    const rivalClaim = info.claims.some(
      (claim) =>
        claim.kind === 'role-claim' &&
        claim.claimedRole === roleClaim.claimedRole &&
        claim.claimerSlot !== accusedSlot &&
        info.aliveSlots.includes(claim.claimerSlot)
    );
    const copies = copiesOf(info, roleClaim.claimedRole);
    const buried =
      copies > 0 &&
      [...info.deadRoles.entries()].filter(([slot, role]) => role === roleClaim.claimedRole && slot !== accusedSlot)
        .length >= copies;
    /**
     * Credit for a claim nobody could break — scaled by how breakable it was.
     *
     * A unique role is a real hostage to fortune: the true holder is sitting
     * there, and `decideDay` now makes them stand up. Surviving that is worth
     * something. "I am a citizen" survives everything and proves nothing, so it
     * earns almost nothing — otherwise the safest lie in the game would also be
     * the most rewarded, which is how a bench run ends with the solo killers
     * acquitted at every trial.
     */
    if (!rivalClaim && !buried) credit += copies === 1 ? 0.4 : 0.08;
  }

  /**
   * An account of the night that no sighting contradicts.
   *
   * Naming the house you went to is worth far more than saying you stayed in:
   * one is a fact anybody with a lookout's list can break by tomorrow morning,
   * the other cannot be checked and cannot be wrong. A defence should be paid
   * for the risk it takes, not for the words it uses.
   */
  if (!contradicted(accusedSlot, info)) {
    const account = today.find((claim) => claim.kind === 'account');
    if (account) credit += account.account === 'visited' ? 0.45 : 0.2;
  }

  /**
   * And a defence that hands the room something it did not have.
   *
   * The stand is the one moment a seat will spend everything it knows, and a
   * seat that empties a real notebook there — a check, a doorstep, somebody it
   * can clear — has just made itself far more useful alive than hanged. It is
   * also the most expensive lie in the game to tell, because every line of it
   * is checkable by tomorrow and `claimerWeight` drops a proven liar to zero.
   *
   * Two findings' worth at most: a wall of claims from the barre is a seat
   * throwing everything at the wall, and the room reads it that way too.
   */
  const findings = today.filter(
    (claim) => claim.kind === 'accuse' || claim.kind === 'clear' || claim.kind === 'sighting'
  ).length;
  credit += Math.min(findings, 2) * 0.25;

  /**
   * And a bet the room can collect on tomorrow.
   *
   * "Spare me and I will prove it tonight" is the one thing an accused seat can
   * say that costs the town almost nothing to accept: one night, against a
   * verdict that is final. It is worth more than any claim, because unlike a
   * claim it is *falsifiable on a deadline* — `deductions` charges a broken
   * promise at 2.5 the following afternoon, which is more than this buys — so a
   * liar who reaches for it has bought a day and sold the rest of the game.
   *
   * The Mayor's version settles on the spot rather than at dawn, so it is not a
   * reason to wait and earns nothing here; revealing is its own argument.
   */
  const bet = today.find((claim) => claim.kind === 'promise' && claim.promise === 'night');
  if (bet) credit += 0.8;

  // "They poisoned me last night" is checkable at the next dawn, which is more
  // than most of what gets said on a stand.
  if (today.some((claim) => claim.kind === 'ailing')) credit += 0.15;

  /**
   * And who is pushing this.
   *
   * A wagon whose loudest voice has already been caught lying is a wagon the
   * room should distrust, and pointing that out is a real defence rather than a
   * plea. Weighed once however many liars are on it: the argument is that the
   * case is tainted, not that it is tainted twice over.
   */
  const pushedByLiar = [...info.votes.entries()].some(
    ([voter, target]) => target === accusedSlot && claimerWeight(voter, info) === 0
  );
  if (pushedByLiar) credit += 0.45;

  return credit;
}

/* ------------------------------ judgement ------------------------------- */

export function decideBallot(
  self: MafiaPlayer,
  brain: Brain,
  info: PublicInfo,
  accusedSlot: number,
  teammates: Set<number>,
  rng: () => number
): 'guilty' | 'innocent' | 'abstain' {
  const role = self.role!;
  const agenda = agendaOf(role);
  const stance = stanceOf(agenda, brain.desperation, brain.personality);

  if (teammates.has(accusedSlot)) {
    /**
     * The brother at the barre. Voting innocent is the reflex and, once the
     * family is cornered, the wrong move: a public "guilty" on one of your own
     * is the single most trust-buying thing a mafioso can do, and it costs a man
     * the room was going to take anyway.
     *
     * How far gone he is decides it. A case the whole room can read hangs him
     * whatever the family does, and an innocent ballot on a seat about to be
     * revealed evil is the loudest tell in the game, priced at minus two and a
     * half by `trustOf`. So a brother is saved when saving is still possible
     * and, when it is not, the family votes with the room and keeps its face.
     * The first shape voted innocent on a doomed brother nine times in ten and
     * handed the town the family's whole roster over the next two trials.
     */
    const room = suspicionParts(accusedSlot, self, info, rng).evidence;
    const hopeless = room >= 2.2;
    if (hopeless) return rng() < 0.7 + stance.sacrificeAlly * 0.3 ? 'guilty' : 'innocent';
    return rng() < stance.sacrificeAlly ? 'guilty' : 'innocent';
  }
  if (role === 'executioner' && (self.obsessionSlotHint ?? null) === accusedSlot) return 'guilty';
  if (roleDef(role).faction === 'mafia') return 'guilty';
  if (role === 'jester') {
    if (styleOf(self, brain, rng) === 'scum') {
      /**
       * Innocent on the caught, guilty on the clean. The first is priced at
       * minus two and a half by `trustOf` the moment the corpse is revealed; the
       * second is remembered by every seat that trusted the one he hanged. He is
       * building the case against himself out of the town's own bookkeeping.
       */
      const parts = suspicionParts(accusedSlot, self, info, rng);
      const proven = info.provenRoles.get(accusedSlot);
      if (parts.hard >= 1.5 || (proven !== undefined && isEvilRole(proven))) return 'innocent';
      if (parts.evidence < 0.8) return 'guilty';
      return rng() < 0.5 ? 'guilty' : 'innocent';
    }
    // Any hanging is a good hanging: it keeps the rope in the room's hand and the
    // Jester in the running for it.
    return rng() < 0.35 + stance.pushHard * 0.5 ? 'guilty' : 'innocent';
  }

  if (role === 'survivor') {
    // Whoever is on the stand, a hanging tonight is one fewer night for a knife to find him.
    if (tide(info) === 'evil') return 'guilty';
    if (styleOf(self, brain, rng) === 'hurried' && info.day >= 4 && rng() < 0.8) return 'guilty';
    // Otherwise he judges as the town does: fall through.
  }

  const parts = suspicionParts(accusedSlot, self, info, rng);
  /**
   * In the booth the crowd counts for less than it does on the square.
   *
   * Joining a wagon during the day is a cheap, reversible act of agreement.
   * A verdict is neither — and a room where everyone's ballot is mostly a
   * readout of everyone else's ballot is a room that hangs whoever was
   * unlucky enough to be named first. Halved rather than dropped: knowing
   * the room is against you is information, just not much of it.
   */
  /**
   * The room already agreed to try you, and that is not nothing.
   *
   * `parts.wagon` is zero here and always was: opening a trial clears
   * `state.votes`, so by the time a ballot is cast the crowd that put the
   * accused on the stand has been erased from the board. The verdict was
   * therefore weighed against the evidence alone — and against a defence that
   * now subtracts from it — which is how better than half of all trials came
   * to end in acquittal, stretching games by a full day and handing those
   * extra nights to whoever was killing in them.
   *
   * A weighted majority of the living voted for this. It is weak evidence,
   * being mostly other people's opinion, but it is evidence, and it is the
   * thing the accused is there to answer.
   */
  /**
   * Reasonable doubt, which this room had none of.
   *
   * Every juror reads the same board, so every juror reached the same verdict:
   * trials ended twenty to one, sixteen to nothing, thirteen to nothing, on
   * afternoons where exactly one seat had said anything of its own and the rest
   * had repeated it. That is not a jury, it is a mirror.
   *
   * So a seat that has nothing of its *own* — no check, no contradiction, no
   * verdict from the graveyard, only the room's word for it — sometimes says
   * so with its ballot. How often depends on temperament (a follower doubts
   * less) and on the clock: at LyLo, when sparing the wrong person ends the
   * game, doubt is a luxury and mostly gets swallowed. A seat holding real
   * evidence never doubts, which is the point: it knows something.
   */
  /**
   * What this juror actually believes about the seat in front of it.
   *
   * Its own checks and last night's arithmetic, which the claims board cannot
   * hold: a Doctor who stopped a knife knows an attack happened and knows who
   * could not have made it, and at three seats alive that is not a suspicion,
   * it is the answer. Read before the ordinary weighing because it outranks it
   * — a juror who has worked out who the killer is does not then acquit them on
   * the strength of a good defence — and only in the two directions it is sure
   * about, so a seat it knows nothing special about falls through to the
   * arithmetic below exactly as before.
   */
  const believed = beliefs(self, info).get(accusedSlot);
  if (believed && believed.odds >= 0.85) return 'guilty';
  if (believed && believed.odds <= 0.12 && parityPressure(info) < 1) return 'innocent';

  /**
   * At the parity bell, the booth votes the way the square does.
   *
   * These two functions disagreed, and at the end of a game the disagreement
   * decided it. `pickVote` has always had "at full LyLo the town must lynch
   * someone" and returns its top suspect whatever the number behind it is; this
   * one kept its arithmetic, so the same seat nominated a man in the square and
   * acquitted him in the booth, three times an afternoon, for three afternoons.
   * The town cannot hang anybody that way, and it cannot skip either: it simply
   * spends the day.
   *
   * So at the bell a juror votes guilty on whoever is standing there unless it
   * is holding a better name — and a juror holding a better name is a juror who
   * will nominate that name the moment this trial is over, which is the town
   * playing rather than the town stalling. The margin is small on purpose: two
   * seats a hair apart are not a reason to let the rope go slack when letting
   * it go slack is how the game is lost.
   */
  if (parityPressure(info) >= 1) {
    const better = info.aliveSlots
      .filter((slot) => slot !== self.slot && slot !== accusedSlot)
      .map((slot) => suspicionParts(slot, self, info, rng).evidence)
      .sort((left, right) => right - left)[0];
    return better === undefined || parts.evidence >= better - 0.3 ? 'guilty' : 'innocent';
  }

  if (parts.hard < 1) {
    const doubt = (0.45 - 0.25 * parityPressure(info)) * (1 - brain.personality.herd * 0.5);
    if (rng() < doubt) return 'innocent';
  }

  const broughtToTrial = 0.6;
  const against = parts.evidence + parts.wagon * 0.5 + broughtToTrial;
  const defended = defenceStrength(accusedSlot, info);
  const score = against - defended;

  // At LyLo the town leans guilty: sparing the wrong person ends the game. A
  // seat that personally feels the clock leans harder still.
  const pressure = Math.max(parityPressure(info), stance.pushHard * 0.6);
  if (score >= 1.2 - 0.5 * pressure) return 'guilty';
  if (score <= 0.4 - 0.4 * pressure) return 'innocent';

  /**
   * Genuinely undecided, which is where the old code hanged people.
   *
   * It fell through to `rng() < herd`, and `herd` averages well over a half —
   * so a seat that had heard nothing either way voted guilty most of the time,
   * and a room full of them convicted on no evidence at all. A ballot with
   * nothing behind it is an acquittal while the town can still afford one;
   * only the parity clock turns "I don't know" into a hanging.
   */
  if (parts.evidence < 0.3 && pressure < 0.6) return 'innocent';
  return rng() < brain.personality.herd * 0.6 + 0.3 * pressure ? 'guilty' : 'innocent';
}

/* -------------------------------- night --------------------------------- */

/**
 * Does the Veteran sit on his porch with the rifle across his knees tonight?
 *
 * He used to, about every other night, from night one, on nothing but nerve.
 * That is the worst possible schedule and it is worth being exact about why.
 *
 * On night one nobody has said anything, so the family's knife goes wherever it
 * likes and the odds it picks this particular door are one in ten. What *does*
 * come to the door on night one is the town: a Sheriff doing his rounds, a
 * Lookout picking a house at random, a Doctor covering somebody quiet. Every
 * one of those is a visit, and an alert kills visitors without asking who they
 * were. So an early alert is a coin flip between nothing at all and shooting
 * one of his own — and he only has three of them.
 *
 * What the role is actually for is the night somebody is *coming*. That night
 * announces itself: he has been accused, there is a wagon on him, he has said
 * the word "veteran" out loud, the town is down to the seats that matter, or
 * the game is close enough to over that a charge saved is a charge wasted. So
 * the nerve is still there and still his — it is just no longer the whole of
 * the decision, and it can no longer fire on night one on its own.
 *
 * Note what is deliberately *not* here: making himself bait. Advertising the
 * porch to the killers without also advertising it to every Doctor and Lookout
 * in the game is not something a seat at this table can do, so he does not try.
 */
function alertTonight(
  self: MafiaPlayer,
  info: PublicInfo,
  brain: Brain,
  stance: Stance,
  rng: () => number
): boolean {
  /**
   * Reasons to think somebody is coming up the path tonight.
   *
   * Each is a thing the rest of the table can see, which is what makes it a
   * prediction rather than a mood: a seat under a wagon is a seat the family
   * would rather not lose tomorrow, and a seat that has claimed Veteran out
   * loud has told the family exactly which door not to use — or exactly which
   * door to send somebody expendable through.
   */
  /**
   * Yesterday's closing votes, not today's running ones — there are none. `beginNight` empties the ballot box and
   * the trial is over by the time anybody acts, so `votesAgainst` and `trialSlot` are structurally zero and null
   * at night and this read as "never hunted" for every Veteran in every game. The day's record is what says whether
   * the room was pointing at him when the sun went down.
   */
  const hunted =
    info.voteHistory.some((vote) => vote.day === info.day && vote.targetSlot === self.slot) ||
    info.trials.some((trial) => trial.day === info.day && trial.accusedSlot === self.slot && !trial.lynched);
  const accused = info.claims.some(
    (claim) => claim.kind === 'accuse' && claim.targetSlot === self.slot && claim.day >= info.day - 1
  );
  const outed = info.claims.some(
    (claim) => claim.kind === 'role-claim' && claim.claimerSlot === self.slot && claim.claimedRole === 'veteran'
  );
  /** Charges he will never get to spend: at four seats a hoarded alert is a wasted one. */
  const running = info.aliveSlots.length <= Math.max(4, self.charges + 2);

  const nerve = brain.personality.courage * 0.35 + stance.pushHard * 0.25;
  const reason = (hunted ? 0.45 : 0) + (accused ? 0.3 : 0) + (outed ? 0.35 : 0) + (running ? 0.4 : 0);

  /**
   * And the clock on top, because a quiet night five is not a quiet night one.
   *
   * By then the visitors are mostly dead, the seats still walking around at
   * night are the ones with something to do, and the knife has run out of
   * easier doors. Nothing before night three fires on nerve alone.
   */
  const late = info.day >= 5 ? 0.3 : info.day >= 3 ? 0.15 : 0;
  const chance = info.day <= 2 ? reason * 0.5 : Math.min(0.85, nerve + reason + late);
  return rng() < chance;
}

export function decideNightTarget(
  self: MafiaPlayer,
  brain: Brain,
  info: PublicInfo,
  legalTargets: number[],
  actionType: string,
  teammates: Set<number>,
  familyIntel: IntelEntry[],
  rng: () => number
): number | null {
  const role = self.role!;
  const stance = stanceOf(agendaOf(role), brain.desperation, brain.personality);
  /**
   * How far down the hit list tonight's knife slips.
   *
   * A comfortable killer can afford to be sloppy; a cornered one goes straight
   * for the biggest threat, because there may not be a tomorrow to correct it.
   * This is the whole of what desperation does at night, and it is enough.
   */
  const slip = Math.max(0.05, 0.25 - stance.pushHard * 0.2);

  /**
   * A proven Veteran's porch is off every list, whoever is walking.
   *
   * The dawn report said the Veteran shot the Sheriff, and the Sheriff's will
   * said where it went that night: the town knows the house, and so does the
   * family. A doctor who heals there dies, a mafioso who calls there dies, a
   * lookout who watches there dies. Nothing good comes of the visit for anybody,
   * so the house is simply not a target unless it is the only one left.
   */
  const porches = new Set(
    [...info.provenRoles.entries()].filter(([, role]) => role === 'veteran').map(([slot]) => slot)
  );
  if (porches.size > 0 && legalTargets.some((slot) => !porches.has(slot))) {
    legalTargets = legalTargets.filter((slot) => !porches.has(slot));
  }

  const random = () => legalTargets[Math.floor(rng() * legalTargets.length)] ?? null;
  if (legalTargets.length === 0) {
    // Self-targeted powers. Vests are free comfort; alerts are rationed nerve —
    // and a veteran who feels hunted spends one.
    if (actionType === 'alert') return alertTonight(self, info, brain, stance, rng) ? self.slot : null;
    return self.slot;
  }

  /**
   * The failed-kill deduction: my target from last night is still breathing —
   * somebody healed or guarded them. Half the time, drop them and go around
   * the protection; the other half, stubbornly try again.
   */
  const dodged = (candidates: number[]): number[] => {
    if (
      brain.lastKillTarget !== null &&
      info.aliveSlots.includes(brain.lastKillTarget) &&
      candidates.length > 1 &&
      rng() < 0.5
    ) {
      return candidates.filter((slot) => slot !== brain.lastKillTarget);
    }
    return candidates;
  };

  /**
   * The knife steps over the seats that have been doing our work for us.
   *
   * A preference, not a rule: if every house left belongs to a friend, somebody
   * still dies tonight, because a night the killers spend being sentimental is
   * a night the town gets for nothing. See `friendlySeats`.
   */
  const spare = (candidates: number[], allies: ReadonlySet<number>): number[] => {
    if (candidates.length <= 1) return candidates;
    const friends = friendlySeats(self, info, allies);
    if (friends.size === 0) return candidates;
    const rest = candidates.filter((slot) => !friends.has(slot));
    return rest.length > 0 ? rest : candidates;
  };

  /* ------------------------------ the killers ----------------------------- */

  if (actionType === 'kill' && familyOf(role) !== null) {
    const pool = spare(dodged(legalTargets), teammates);
    // The whole hit list, best head first — the clutch slip decides how far
    // down the list tonight's knife actually goes.
    const ranked: number[] = [];
    const provenSheriff = info.claims.find(
      (claim) => claim.kind === 'accuse' && teammates.has(claim.targetSlot) && pool.includes(claim.claimerSlot)
    );
    if (provenSheriff) ranked.push(provenSheriff.claimerSlot);
    if (info.revealedMayorSlot !== null && pool.includes(info.revealedMayorSlot)) ranked.push(info.revealedMayorSlot);
    const powerRoles: RoleId[] = ['jailor', 'sheriff', 'doctor', 'vigilante', 'bodyguard', 'escort', 'marshall'];
    for (const entry of familyIntel) {
      if (entry.kind === 'role' && powerRoles.includes(entry.value as RoleId) && pool.includes(entry.targetSlot)) {
        ranked.push(entry.targetSlot);
      }
    }
    for (const claimer of credibleClaimersRanked(info, teammates)) {
      if (pool.includes(claimer)) ranked.push(claimer);
    }
    // The protector hunt: the family's watchers saw who visits the loud
    // houses — those visitors are the doctors and bodyguards in the way.
    for (const entry of familyIntel) {
      if (entry.kind !== 'visitors') continue;
      if (!credibleClaimersRanked(info, teammates).includes(entry.targetSlot)) continue;
      for (const visitor of entry.slots ?? []) {
        if (pool.includes(visitor) && !teammates.has(visitor)) ranked.push(visitor);
      }
    }
    // Behaviorally confirmed town are tomorrow's guilty votes: thin them out.
    const trusted = pool
      .map((slot) => ({ slot, trust: trustOf(slot, info) }))
      .filter((entry) => entry.trust >= 1.5)
      .sort((a, b) => b.trust - a.trust)
      .map((entry) => entry.slot);
    ranked.push(...trusted);
    const list = [...new Set(ranked)];
    const choice = list.length > 0 ? pickRanked(list, rng, slip) : (pool[Math.floor(rng() * pool.length)] ?? null);
    brain.lastKillTarget = choice;
    return choice;
  }

  if (role === 'serial-killer' || actionType === 'poison' || actionType === 'rampage') {
    // A butcher has no family, so its friends are whoever spoke for *it*. Same
    // question, smaller side. See `friendlySeats`.
    const pool = spare(dodged(legalTargets), EMPTY_SIDE);
    // Prefer the loud voices — with the slip toward the second-loudest — but
    // half the nights, feed wherever hunger points.
    const loudList = credibleClaimersRanked(info, new Set([self.slot])).filter((slot) => pool.includes(slot));
    const choice =
      loudList.length > 0 && rng() < 0.5 ? pickRanked(loudList, rng) : (pool[Math.floor(rng() * pool.length)] ?? null);
    brain.lastKillTarget = choice;
    return choice;
  }

  if (actionType === 'douse' || actionType === 'charge') {
    // Strike the match / drop the lever once two houses are prepared.
    const marked = actionType === 'douse' ? 'doused' : 'charged';
    const readyCount = self.intel.filter(
      (entry) => entry.kind === 'doused' && entry.value === marked && info.aliveSlots.includes(entry.targetSlot)
    ).length;
    if ((readyCount >= 2 && rng() < 0.8) || (readyCount >= 1 && info.day >= 8)) return self.slot;
    const fresh = legalTargets.filter(
      (slot) => slot !== self.slot && !self.intel.some((entry) => entry.kind === 'doused' && entry.targetSlot === slot)
    );
    const loudList = credibleClaimersRanked(info, new Set([self.slot])).filter((slot) => fresh.includes(slot));
    return pickRanked([...new Set([...loudList, ...fresh])], rng, 0.35);
  }

  /* -------------------------- guns, keys and vests ------------------------ */

  if (role === 'vigilante') {
    /**
     * A name he is sure of, before anything the room thinks.
     *
     * The bar below is a suspicion threshold, and a suspicion threshold cannot
     * tell the difference between a seat nobody has mentioned and a seat the
     * night has narrowed down to. A real endgame had the Vigilante holding a
     * bullet, the killer sitting across the table, and a number that said the
     * killer was the most trustworthy person alive: the gun never came out,
     * because the only question it knew how to ask was whether the room was
     * suspicious enough, and the room was wrong.
     */
    const sure = surestSuspect(self, info, 0.85, teammates);
    if (sure && legalTargets.includes(sure.slot)) return sure.slot;

    // The vigilante's real job: finish what the town failed to. A player
    // spared at trial despite live suspicion — likely saved by evil ballots —
    // is his priority, so the bullet doesn't just duplicate tomorrow's lynch.
    const spared = info.trials
      .filter((trial) => !trial.lynched && legalTargets.includes(trial.accusedSlot))
      .map((trial) => trial.accusedSlot)
      .filter((slot) => suspicion(slot, self, info, rng) >= 1.8 - brain.personality.courage * 0.5);
    if (spared.length > 0) return pickRanked([...new Set(spared)], rng);

    /**
     * And not the seat the square was already going to hang.
     *
     * A bullet spent on somebody with a wagon parked on them buys a day the
     * town was getting for nothing, and it costs the one thing the Vigilante
     * cannot make more of. A real game has him shooting a Survivor on night
     * four and watching the room hang that same seat the next afternoon.
     *
     * A preference, not a veto: if that seat is also the one he is surest of,
     * the penalty is small enough that certainty still wins.
     */
    const wagonYesterday = (slot: number): number =>
      info.voteHistory.filter((vote) => vote.day === info.day && vote.targetSlot === slot).length;

    const scored = legalTargets
      .map((slot) => ({ slot, score: suspicion(slot, self, info, rng) - (wagonYesterday(slot) >= 2 ? 0.6 : 0) }))
      .sort((a, b) => b.score - a.score);
    const top = scored[0];

    /**
     * Discipline, priced against what the discipline was actually buying.
     *
     * The bar was `2.9 - courage`, and measured over three hundred fifteen-seat
     * games it produced a Vigilante who took 17% of the shots available to him
     * and hit an evil seat with **85%** of the ones he took. Those two numbers
     * together are not a portrait of a careful man. They say the bar was set
     * well above the point where his judgement stops being reliable, so most of
     * what it filtered out was good shots — and a bullet not fired by the end
     * is worth exactly nothing, which is the part a suspicion threshold alone
     * can never see.
     *
     * So the bar drops, and two things push it down further:
     *
     *  - **Bullets he will not get to fire.** Roughly one seat dies a night, so
     *    the nights left are about the seats left over two. Holding three
     *    bullets with four nights to go is not caution, it is hoarding.
     *  - **The parity clock**, for the ordinary reason: at LyLo a wrong shot and
     *    no shot lose the same game, so only the wrong shot can be worse.
     *
     * Cowards still mostly hold fire, which is what `courage` is for.
     */
    const nightsLeft = Math.max(1, Math.floor(info.aliveSlots.length / 2));
    const hoarding = Math.max(0, self.charges - nightsLeft) * 0.35;
    const bar = 2.2 - brain.personality.courage * 0.7 - hoarding - parityPressure(info) * 0.4;
    if (top && top.score >= Math.max(1.2, bar)) return top.slot;
    return null;
  }

  if (actionType === 'jail-execute') {
    // Execute when the prisoner carries real public suspicion.
    const prisoner = legalTargets[0];
    if (prisoner === undefined) return null;
    const score = suspicion(prisoner, self, info, rng);
    return score >= 2.4 - brain.personality.courage ? prisoner : null;
  }

  /* ------------------------------ protectors ------------------------------ */

  if (actionType === 'heal' || actionType === 'guard') {
    /**
     * Somebody has said out loud that they are dying, and a doctor can stop it.
     *
     * Poison kills at the next dawn and a heal cures it, so a seat that says "I
     * have been poisoned" is asking for the one thing a Doctor has and naming
     * the night it is needed. Answering is the most useful thing the role does
     * all game — and it is also a trap somebody may have set, because a liar
     * can say the same sentence for free and spend the town's only heal. That
     * is a fair trade for a fair game, and it is why this is a preference and
     * not an obligation: a doctor with a seat it trusts more still goes there.
     *
     * Guards are not doctors. A bodyguard trades its life for one attack and
     * cures nothing, so poison is none of its business.
     */
    if (actionType === 'heal') {
      const dying = info.claims
        .filter(
          (claim) =>
            claim.kind === 'ailing' &&
            claim.ailment === 'poison' &&
            claim.day >= info.day - 1 &&
            claim.claimerSlot !== self.slot &&
            legalTargets.includes(claim.claimerSlot) &&
            // Not from a mouth the record has already caught out: a proven liar
            // saying it is dying is a liar spending somebody else's night.
            claimerWeight(claim.claimerSlot, info) > 0
        )
        .map((claim) => claim.claimerSlot);
      if (dying.length > 0 && rng() < 0.55) return pickRanked([...new Set(dying)], rng, 0.2);
    }

    /**
     * And nobody spends a night protecting somebody they believe is the killer.
     *
     * Not a hypothetical. A real game ended with the Doctor healing the Serial
     * Killer on three of its last four nights, because the killer was the
     * loudest voice in the square and the ranking below reads loudness as "the
     * seat the knife is coming for". The town's most valuable night was being
     * spent keeping the knife alive.
     *
     * A preference rather than a rule, like everything else here: if every
     * house left looks like a killer, somebody is still worth covering.
     */
    const believed = beliefs(self, info);
    const notTheKnife = legalTargets.filter((slot) => (believed.get(slot)?.odds ?? 0) < 0.6);
    if (notTheKnife.length > 0) legalTargets = notTheKnife;

    // Stand where the knife is headed: the mayor, the claimers, and the
    // behaviorally confirmed town (the mafia hunts trusted seats too) — with
    // the 25% clutch slip. A doctor who saved the loud sheriff last night
    // knows the killer may rotate, so sometimes he rotates first.
    const ranked: number[] = [];
    if (info.revealedMayorSlot !== null && legalTargets.includes(info.revealedMayorSlot))
      ranked.push(info.revealedMayorSlot);
    for (const claimer of credibleClaimersRanked(info, new Set([self.slot]))) {
      if (legalTargets.includes(claimer)) ranked.push(claimer);
    }
    const trusted = legalTargets
      .map((slot) => ({ slot, trust: trustOf(slot, info) }))
      .filter((entry) => entry.trust >= 1.2)
      .sort((a, b) => b.trust - a.trust)
      .map((entry) => entry.slot);
    ranked.push(...trusted);
    const list = [...new Set(ranked)];
    if (list.length > 0) return pickRanked(list, rng);
    return random();
  }

  /* ----------------------------- interference ----------------------------- */

  if (actionType === 'block' || actionType === 'kidnap' || actionType === 'silence') {
    if (familyOf(role) !== null) {
      // Keep the sheriff busy, gagged, or in a cellar: a loud claimer.
      const loudList = credibleClaimersRanked(info, teammates).filter((slot) => legalTargets.includes(slot));
      if (loudList.length > 0) return pickRanked(loudList, rng);
      return random();
    }
    /**
     * The town's escort trips the likeliest killer — and, far more often, tripped one of her own.
     *
     * Measured over three hundred fifteen-seat games: 45% of her nights landed
     * on somebody with a knife, and **40% landed on a townsperson with a power**
     * — a Sheriff who then had no check to report, a Doctor whose save never
     * happened, a Lookout who saw nothing. That is not a near miss. A blocked
     * Doctor is a death the family did not have to work for, so on those nights
     * she was the best thing the mafia had.
     *
     * Almost all of it came from the last line: top suspect if anybody scored
     * above 1, otherwise **a seat drawn at random**, and on a quiet night two
     * nobody scores above 1. She was rolling dice against a board that is three
     * quarters town.
     *
     * So the seats she has reason to believe are town come out of the hat
     * first, and what is left is ranked rather than drawn. She can still be
     * wrong — a liar in a Sheriff's coat is exactly what this costs — but she is
     * no longer wrong by default on the nights nothing is happening.
     */
    const cleared = new Set<number>();
    for (const entry of self.intel) {
      if (entry.kind === 'sheriff' && entry.value === 'clear') cleared.add(entry.targetSlot);
    }
    for (const [slot, role] of info.provenRoles) {
      if (roleDef(role).faction === 'town') cleared.add(slot);
    }
    const worth = legalTargets.filter((slot) => !cleared.has(slot));
    const pool = worth.length > 0 ? worth : legalTargets;

    const scored = pool
      .map((slot) => ({ slot, score: suspicion(slot, self, info, rng) }))
      .sort((a, b) => b.score - a.score);
    const top = scored[0];
    if (top && top.score >= 1) return top.slot;

    /**
     * Nothing above the bar, so she goes where the room is quietest about.
     *
     * A seat nobody has vouched for and nobody has checked is worth a night far
     * more than one the record likes, and it is also the seat a family hides
     * its knife behind. Trust is the only signal left on a night like this, so
     * it is the one she uses, rather than none.
     */
    const coldest = scored
      .map((row) => ({ slot: row.slot, warmth: trustOf(row.slot, info) }))
      .sort((a, b) => a.warmth - b.warmth);
    return coldest[0]?.slot ?? random();
  }

  if (actionType === 'frame') {
    // Frame where the town is already looking: the sheriff will "confirm" it.
    const scored = legalTargets
      .map((slot) => ({ slot, score: votesAgainst(slot, info) }))
      .sort((a, b) => b.score - a.score);
    const top = scored[0];
    if (top && top.score > 0) return top.slot;
    return random();
  }

  if (actionType === 'clean') {
    // Clean where the family's knife is likeliest to land tonight.
    const loudList = credibleClaimersRanked(info, teammates).filter((slot) => legalTargets.includes(slot));
    if (loudList.length > 0) return pickRanked(loudList, rng);
    return random();
  }

  /* ---------------------------- the watchers ------------------------------ */

  if (role === 'lookout') {
    // Watch the likeliest kill target: mayor, then the claimers, same slip.
    const ranked: number[] = [];
    if (info.revealedMayorSlot !== null && legalTargets.includes(info.revealedMayorSlot))
      ranked.push(info.revealedMayorSlot);
    for (const claimer of credibleClaimersRanked(info, new Set([self.slot]))) {
      if (legalTargets.includes(claimer)) ranked.push(claimer);
    }
    const list = [...new Set(ranked)];
    if (list.length > 0) return pickRanked(list, rng);
    return random();
  }

  if (['investigate', 'examine', 'watch', 'track', 'shadow'].includes(actionType)) {
    const fresh = legalTargets.filter((slot) => !brain.checked.has(slot));
    const pool = fresh.length > 0 ? fresh : legalTargets;
    // Investigate where the smoke is: bias toward currently suspected seats.
    const scored = pool
      .map((slot) => ({ slot, score: suspicion(slot, self, info, rng) + rng() }))
      .sort((a, b) => b.score - a.score);
    const pick = scored[0]?.slot ?? null;
    if (pick !== null) brain.checked.add(pick);
    return pick;
  }

  if (actionType === 'autopsy') {
    // Nameless corpses first: the coroner is the janitor's natural enemy.
    const unnamed = legalTargets.filter((slot) => !info.deadRoles.has(slot) && !brain.checked.has(slot));
    const fresh = legalTargets.filter((slot) => !brain.checked.has(slot));
    const pick = unnamed[0] ?? fresh[Math.floor(rng() * fresh.length)] ?? null;
    if (pick !== null) brain.checked.add(pick);
    return pick;
  }

  if (actionType === 'remember') {
    // Remember somebody useful: a dead town power role, ideally.
    const powered = legalTargets.filter((slot) => {
      const dead = info.deadRoles.get(slot);
      return !!dead && roleDef(dead).faction === 'town' && roleDef(dead).nightAction !== null;
    });
    if (powered.length > 0 && rng() < 0.8) return powered[Math.floor(rng() * powered.length)] ?? null;
    // Waiting is fine too: a better corpse may come.
    return rng() < 0.5 ? random() : null;
  }

  if (actionType === 'audit') {
    const scored = legalTargets
      .map((slot) => ({ slot, score: suspicion(slot, self, info, rng) }))
      .sort((a, b) => b.score - a.score);
    const top = scored[0];
    if (top && top.score >= 1.5) return top.slot;
    return rng() < 0.4 ? random() : null;
  }

  /**
   * The Witch goes back to the hand she found a knife in.
   *
   * She used to pick her victim uniformly at random, every night, for the whole
   * game — the one role in this file with no idea what it was doing. But every
   * control is an experiment with a published result: she is told whether the
   * seat had an order to redirect, she chose where it went, and the morning
   * says who died. A seat whose redirected order was followed by a corpse at
   * the destination is a seat holding a killing power, and the right thing to
   * do with it is to take it again, and keep taking it.
   *
   * The inference is honest about being a guess. The destination may have been
   * killed by somebody else entirely that night, and she will never know which;
   * that is the price of the only experiment she can run, and it is still far
   * better than the dice. A seat caught twice is the one she stops doubting.
   *
   * Ranked: the hands that produced a corpse, most often first; then the seats
   * she has never tried, because an untried hand is the only way to learn
   * anything new; and last the ones that turned out to be holding nothing, who
   * are almost certainly powerless and worth a night only when there is nobody
   * else left.
   */
  if (actionType === 'control') {
    const kills = new Map<number, number>();
    const idle = new Set<number>();
    const tried = new Set<number>();
    for (const entry of self.intel) {
      if (entry.kind !== 'controlled') continue;
      tried.add(entry.targetSlot);
      if (entry.value === 'idle') {
        idle.add(entry.targetSlot);
        continue;
      }
      idle.delete(entry.targetSlot);
      const [destination] = entry.slots ?? [];
      if (destination === undefined) continue;
      const fell = info.deaths.some(
        (death) => death.slot === destination && death.phase === 'night' && death.day === entry.night
      );
      if (fell) kills.set(entry.targetSlot, (kills.get(entry.targetSlot) ?? 0) + 1);
    }

    const armed = legalTargets
      .filter((slot) => kills.has(slot))
      .sort((left, right) => (kills.get(right) ?? 0) - (kills.get(left) ?? 0));
    if (armed.length > 0 && rng() < 0.8) return pickRanked(armed, rng, 0.2);

    const fresh = legalTargets.filter((slot) => !tried.has(slot) && slot !== self.slot);
    if (fresh.length > 0) return fresh[Math.floor(rng() * fresh.length)] ?? null;

    const known = legalTargets.filter((slot) => !idle.has(slot) && slot !== self.slot);
    if (known.length > 0) return known[Math.floor(rng() * known.length)] ?? null;
    return random();
  }

  if (actionType === 'convert' || actionType === 'recruit') return random();

  if (actionType === 'bond') {
    // The heart wants what it wants, on night one, at random.
    return random();
  }

  // Everything else (swap, imitate, hide, charm, control): honest mischief.
  return random();
}

/**
 * The second house of a two-target order: the Witch's destination, the Bus
 * Driver's other stop.
 *
 * Its own function rather than a second return value from `decideNightTarget`,
 * because it is a different question asked of a different pool and it can only be
 * asked once the first half is settled. Two callers need it — the simulator and
 * the live bot runner — and both used to send nothing at all, which is how the
 * engine ended up rolling a random house and putting a quarter of these orders
 * through the actor's own head.
 *
 * Returns null only when there is genuinely nowhere to point, in which case the
 * caller drops the whole order: half of one of these is worse than none of it.
 */
export function decideSecondTarget(
  self: MafiaPlayer,
  info: PublicInfo,
  actionType: string,
  firstSlot: number,
  legalSecondTargets: number[],
  rng: () => number
): number | null {
  const pool = legalSecondTargets.filter((slot) => slot !== firstSlot && info.aliveSlots.includes(slot));
  if (pool.length === 0) return null;
  const elsewhere = pool.filter((slot) => slot !== self.slot);
  const random = (): number | null =>
    (elsewhere.length > 0 ? elsewhere : pool)[
      Math.floor(rng() * (elsewhere.length > 0 ? elsewhere.length : pool.length))
    ] ?? null;

  /**
   * The Witch guides the hand she has taken onto the loudest seat in the square.
   *
   * She wins when the Town does not, so the best use of somebody else's power is
   * to spend it on the person the Town is currently listening to: a Doctor who
   * heals the wrong house, a Vigilante whose bullet lands on an investigator. Her
   * own seat is excluded on purpose — it is legal, it is occasionally a brilliant
   * bluff, and it is not something a bot should stumble into.
   */
  if (actionType === 'control') {
    const loud = credibleClaimersRanked(info, new Set([self.slot, firstSlot])).filter((slot) =>
      elsewhere.includes(slot)
    );
    if (loud.length > 0) return pickRanked(loud, rng, 0.3);
    return random();
  }

  /**
   * The Bus Driver sends whatever was aimed at his first stop to the seat the
   * square already distrusts.
   *
   * He is swapping fates, so the second house is where tonight's knife actually
   * lands. Pointing it at the table's prime suspect is the play that is either
   * free (they were evil and the family does not kill its own) or at worst costs
   * the Town a seat it was about to hang anyway. Never himself: that was a quarter
   * of every swap under the old random fallback, and the driver dying on his own
   * bus is the single worst outcome this power has.
   */
  if (actionType === 'swap') {
    const scored = elsewhere
      .map((slot) => ({ slot, score: suspicion(slot, self, info, rng) }))
      .sort((a, b) => b.score - a.score);
    const top = scored[0];
    if (top && top.score >= 1.2) return top.slot;
    return random();
  }

  return random();
}

/* The simulator smuggles the executioner's obsession slot through the player
 * object without widening the core type for everyone. */
declare module '../state.js' {
  interface MafiaPlayer {
    /** Sim only: the obsession's seat, precomputed for the brains. */
    obsessionSlotHint?: number | null;
  }
}
