import type { DeathSource } from '../messages.js';
import type { RoleId } from '../roles.js';
import { familyOf, isSoloKiller, roleDef, ROLES } from '../roles.js';
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
import type { IntelEntry, MafiaPlayer } from '../state.js';

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
}

export const DEFAULT_PROFILE: Personality = {
  aggression: 0.5,
  herd: 0.5,
  claimRate: 0.7,
  deceit: 0.4,
  courage: 0.5
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
  | 'ailing';

/** A public statement about a house. `truthful` is ground truth, sim-stamped. */
export interface Claim {
  day: number;
  claimerSlot: number;
  targetSlot: number;
  kind: ClaimKind;
  truthful: boolean;
  /** role-claim only: "je suis <rôle>" (targetSlot is the claimer). */
  claimedRole?: RoleId;
  /**
   * account only: what the claimer says they did last night. `home` means
   * "I went nowhere"; otherwise `targetSlot` is the house they admit visiting.
   */
  account?: 'home' | 'visited';
  /** ailing only: what the claimer says was done to them last night. */
  ailment?: 'poison' | 'douse';
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
}

/** A fresh brain, calm and with nothing to hide yet. */
export function makeBrain(slot: number, personality: Personality): Brain {
  return { slot, personality, checked: new Set<number>(), lastKillTarget: null, desperation: CALM, wentTo: null };
}

export function makePersonality(profile: Personality, rng: () => number): Personality {
  const jitter = (value: number) => Math.min(1, Math.max(0, value + (rng() - 0.5) * 0.4));
  return {
    aggression: jitter(profile.aggression),
    herd: jitter(profile.herd),
    claimRate: jitter(profile.claimRate),
    deceit: jitter(profile.deceit),
    courage: jitter(profile.courage)
  };
}

export function isEvilRole(role: RoleId): boolean {
  return familyOf(role) !== null || isSoloKiller(role);
}

/** Reads SUSPECT to a sheriff without being anyone's enemy (the scumbag). */
function harmlessSuspect(role: RoleId): boolean {
  return !!roleDef(role).suspicious && !isEvilRole(role);
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
export function trustOf(slot: number, info: PublicInfo): number {
  let trust = 0;
  for (const trial of info.trials) {
    const revealed = info.deadRoles.get(trial.accusedSlot);
    if (!revealed) continue; // fate still unknown (alive, or a cleaned corpse)
    const guilty = trial.guiltySlots.includes(slot);
    const innocent = trial.innocentSlots.includes(slot);
    if (!guilty && !innocent) continue;

    if (isEvilRole(revealed)) {
      if (guilty) trust += 1;
      if (innocent) trust -= 2.5; // tried to save the mafia, in public
    } else if (roleDef(revealed).faction === 'town') {
      if (guilty) trust -= 1.2;
      if (innocent) trust += 0.8;
    }
    // Jester and other harmless suspects: an honest mistake either way.
  }
  return trust;
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
  brain.desperation = advanceDesperation(brain.desperation, pressure);
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
  const stayedHome = info.claims.some(
    (claim) => claim.kind === 'account' && claim.claimerSlot === slot && claim.account === 'home'
  );
  if (!stayedHome) return false;
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
    if (trustOf(slot, info) >= 2.5) remaining.delete(slot);
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
    if (roleDef(role).unique && [...info.deadRoles.entries()].some(([dead, buried]) => dead !== slot && buried === role)) {
      continue;
    }
    badges.set(slot, role);
  }
  BADGES.set(info, badges);
  return badges;
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

  for (const claim of info.claims) {
    if (claim.claimerSlot !== claimerSlot) continue;
    const deadRole = info.deadRoles.get(claim.targetSlot);
    if (!deadRole) continue;
    const wasEvil = isEvilRole(deadRole);
    // Accusing a jester or a scumbag is an honest mistake — the sheriff's
    // needle genuinely points at them. Only a clean-town corpse proves a liar.
    if (claim.kind === 'accuse' && !wasEvil && deadRole !== 'jester' && !harmlessSuspect(deadRole)) return 0;
    if (claim.kind === 'clear' && wasEvil) return 0;
    if (claim.kind === 'accuse' && wasEvil) weight = Math.max(weight, 1.6);
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

  return weight;
}

/** Is this slot a proven liar in the public record? */
export function provenLiar(slot: number, info: PublicInfo): boolean {
  return (
    info.claims.some((claim) => claim.claimerSlot === slot) && claimerWeight(slot, info) === 0
  );
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
export function buddyScore(targetSlot: number, info: PublicInfo): number {
  const days = new Set(info.voteHistory.map((entry) => entry.day));
  if (days.size < 3) return 0;

  let best = 0;
  for (const other of info.aliveSlots) {
    if (other === targetSlot) continue;

    let together = 0;
    let against = 0;
    let bothVoted = 0;

    for (const day of days) {
      const mine = info.voteHistory.find((entry) => entry.day === day && entry.voterSlot === targetSlot);
      const theirs = info.voteHistory.find((entry) => entry.day === day && entry.voterSlot === other);
      if (!mine || !theirs) continue;
      bothVoted++;
      if (mine.targetSlot === theirs.targetSlot) together++;
      if (mine.targetSlot === other || theirs.targetSlot === targetSlot) against++;
    }

    if (bothVoted < 3 || against > 0 || together < 2) continue;
    // How much of their shared record was spent agreeing.
    best = Math.max(best, together / bothVoted);
  }

  return best * 1.2;
}

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
    const voices = info.claims
      .filter((claim) => claim.kind === kind && claim.targetSlot === targetSlot && claim.claimerSlot !== self.slot)
      .map((claim) => claimerWeight(claim.claimerSlot, info))
      .sort((left, right) => right - left);
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
    const weight = claimerWeight(claim.claimerSlot, info);
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

  // The trust meter: saving mafiosi at trials is remembered; hanging them too.
  score -= trustOf(targetSlot, info) * 0.6;

  // Tunnel vision smells like an obsession.
  score += monomaniacScore(targetSlot, info);

  // Role-claim cross-checks: two living claimants of one unique role means at
  // least one liar; claiming a role the graveyard already revealed is worse.
  const roleClaim = info.claims.find((claim) => claim.kind === 'role-claim' && claim.claimerSlot === targetSlot);
  if (roleClaim?.claimedRole) {
    const rivals = info.claims.filter(
      (claim) =>
        claim.kind === 'role-claim' &&
        claim.claimedRole === roleClaim.claimedRole &&
        claim.claimerSlot !== targetSlot &&
        info.aliveSlots.includes(claim.claimerSlot)
    );
    if (roleDef(roleClaim.claimedRole).unique && rivals.length > 0) {
      score += 1.5;
      hard += 1.5;
    }
    if ([...info.deadRoles.entries()].some(([slot, role]) => role === roleClaim.claimedRole && roleDef(role).unique && slot !== targetSlot)) {
      // Claiming a role that is already in the ground: the graveyard said it,
      // not the room.
      score += 3;
      hard += 3;
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
          claim.kind === 'role-claim' &&
          claim.claimerSlot === deadSlot &&
          claim.claimedRole === roleClaim.claimedRole
      );
      if (claimedTheSame && isEvilRole(deadRole)) score -= 2.5;
    }
  }

  // Own hard evidence outweighs the rumour mill, and is the model of what a
  // juror can point to: it saw it happen.
  for (const entry of self.intel) {
    if (entry.targetSlot !== targetSlot) continue;
    let own = 0;
    if (entry.kind === 'sheriff') own += entry.value === 'suspect' ? 3 : -4;
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

    // A board this empty has not found anybody. Say so, unless saying so
    // loses the game.
    if (!desperate && best < NO_CASE_CEILING) return { slot: null, skip: true };
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
  return scoreOf(proposed) - scoreOf(standing) >= SWITCH_MARGIN
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
export function bindPersonalities(brains: Brain[]): void {
  herdBySlot = new Map(brains.map((brain) => [brain.slot, brain.personality.herd]));
}
function brainHerd(self: MafiaPlayer): number {
  return herdBySlot.get(self.slot) ?? 0.5;
}

function votesAgainst(slot: number, info: PublicInfo): number {
  return [...info.votes.values()].filter((voted) => voted === slot).length;
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

  const publish = (
    targetSlot: number,
    kind: ClaimKind,
    claimedRole?: RoleId,
    account?: 'home' | 'visited',
    ailment?: Claim['ailment']
  ) => {
    if (!alreadyClaimed(info, self.slot, targetSlot, kind)) {
      decision.publishes.push({
        day: info.day,
        claimerSlot: self.slot,
        targetSlot,
        kind,
        truthful: false,
        claimedRole,
        account,
        ailment
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
  const already = info.claims.some((claim) => claim.kind === 'ailing' && claim.claimerSlot === self.slot);
  const ailing: Claim['ailment'] | null =
    self.poisonedNight !== null ? 'poison' : self.doused ? 'douse' : null;
  if (!gagged && !already && ailing) {
    if (rng() < (ailing === 'poison' ? 0.95 : 0.45)) publish(self.slot, 'ailing', undefined, undefined, ailing);
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
  if (!gagged && !already && !ailing && agenda !== 'town' && info.day > 2) {
    const weapons = new Set(info.deaths.map((death) => death.source));
    const tellable = ([['poison', 'poison'], ['arsonist', 'douse']] as const).filter(([source]) =>
      weapons.has(source)
    );
    // The dice come out only when there is something to lie about: a draw
    // taken on an empty list still moves the sequence, and a bench whose
    // numbers shift because a branch *considered* firing measures nothing.
    if (tellable.length > 0 && rng() < 0.08 * (0.5 + brain.personality.deceit)) {
      const pick = tellable[Math.floor(rng() * tellable.length)];
      if (pick) publish(self.slot, 'ailing', undefined, undefined, pick[1]);
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
    const patience = info.day <= 2 ? 0.15 : info.day === 3 ? 0.4 : info.day === 4 ? 0.7 : 1;
    const speakChance = brain.personality.claimRate * patience;

    if (role === 'sheriff' || role === 'investigator') {
      const suspects = self.intel.filter(
        (entry) =>
          entry.kind === 'sheriff' &&
          entry.value === 'suspect' &&
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

      // The investigator's trade lines are soft evidence, published as hints.
      if (role === 'investigator' && rng() < speakChance * 0.5) {
        const smells = ['sent la poudre', 'travaille la nuit', 'a les doigts tachés d’encre'];
        const hint = self.intel.find(
          (entry) =>
            entry.kind === 'trade' && smells.some((smell) => entry.value.includes(smell)) && info.aliveSlots.includes(entry.targetSlot)
        );
        if (hint) publish(hint.targetSlot, 'hint');
      }
    }

    // The lookout's deduction: my watch target died — I saw who visited.
    // Timely by nature; the corpse is on the square this very morning.
    if (role === 'lookout') {
      const watch = self.intel.find(
        (entry) => entry.kind === 'visitors' && entry.night === info.day - 1 && info.lastNightDeathSlots.has(entry.targetSlot)
      );
      if (watch && rng() < brain.personality.claimRate) {
        for (const visitor of watch.slots ?? []) {
          if (!info.aliveSlots.includes(visitor)) continue;
          // Both, and they do different work: the accusation points, the
          // sighting is what catches "I was home" in a lie.
          publish(visitor, 'accuse');
          publish(visitor, 'sighting');
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
        publish(caught.targetSlot, 'sighting');
      }
      // Even a tail that led nowhere interesting establishes that they moved.
      const seen = self.intel.find(
        (entry) =>
          entry.kind === 'tracked' &&
          entry.night === info.day - 1 &&
          info.aliveSlots.includes(entry.targetSlot) &&
          (entry.slots ?? []).length > 0
      );
      if (seen && rng() < speakChance) publish(seen.targetSlot, 'sighting');
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
        (entry) => entry.kind === 'blocked' && entry.night === info.day - 1 && info.aliveSlots.includes(entry.targetSlot)
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
    if (beingAsked && !alreadyAnswered) {
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
        return vouched || trustOf(slot, info) >= 2;
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
      const claimedBefore = info.claims.some(
        (claim) => claim.kind === 'role-claim' && claim.claimerSlot === self.slot
      );
      const oddAccusation = (): void => {
        // Deliberately the *least* suspected seat: contradicting the room is
        // how he gets called a liar.
        const calmest = others
          .filter((slot) => !contradicted(slot, info))
          .map((slot) => ({ slot, heat: suspicion(slot, self, info, rng) }))
          .sort((a, b) => a.heat - b.heat)[0];
        if (calmest) publish(calmest.slot, 'accuse');
      };
      if (!accusedBefore) {
        if (rng() < stance.falseAccuse) oddAccusation();
      } else if (!claimedBefore && info.day >= 3 && brain.desperation >= 0.5) {
        const mask = pickMask('jester', stance, rng, burnedFaces(info));
        if (mask) publish(self.slot, 'role-claim', mask);
      } else if (claimedBefore && rng() < stance.falseAccuse * 0.5) {
        oddAccusation();
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
          .map((slot) => ({ slot, heat: votesAgainst(slot, info) + info.claims.filter((c) => c.targetSlot === slot && c.kind === 'accuse').length }))
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
    const pressure = parityPressure(info);
    if (pressure >= 0.6) {
      const suspects = others
        .map((slot) => ({ slot, score: suspicion(slot, self, info, rng) }))
        .sort((a, b) => b.score - a.score);
      const top = suspects[0];
      if (top && top.score >= 1) decision.jailSlot = top.slot;
    } else {
      const quiet = others.filter(
        (slot) =>
          !info.claims.some((claim) => claim.claimerSlot === slot) &&
          Math.abs(trustOf(slot, info)) < 1.5 &&
          !self.intel.some((entry) => entry.targetSlot === slot && entry.kind === 'sheriff' && entry.value === 'clear')
      );
      const pick = quiet[Math.floor(rng() * quiet.length)];
      if (pick !== undefined && rng() < 0.8) decision.jailSlot = pick;
    }
  }

  /* -------- The mayor comes out when the rope is looking at him. -------- */
  if ((role === 'mayor' || role === 'marshall') && !self.revealed) {
    if (votesAgainst(self.slot, info) >= 2 || info.trialSlot === self.slot) decision.revealMayor = true;
    // The marshall also comes out when the town has real leads to burn through.
    if (role === 'marshall' && info.day >= 4 && info.claims.filter((claim) => claim.kind === 'accuse').length >= 3 && rng() < 0.3) {
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
function burnedFaces(info: PublicInfo): Set<RoleId> {
  const burned = new Set<RoleId>();
  for (const role of info.deadRoles.values()) burned.add(role);
  for (const claim of info.claims) {
    if (claim.kind === 'role-claim' && claim.claimedRole && info.aliveSlots.includes(claim.claimerSlot)) {
      burned.add(claim.claimedRole);
    }
  }
  return burned;
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

  if (role === 'jester') {
    // Chaos: vote someone random, often, to look erratic.
    if (rng() < 0.6) return candidates[Math.floor(rng() * candidates.length)] ?? null;
    return null;
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
  const pool =
    possible && possible.size > 0 ? candidates.filter((slot) => possible.has(slot)) : candidates;

  const scored = pool
    .filter((slot) => !teammates.has(slot))
    .map((slot) => {
      const parts = suspicionParts(slot, self, info, rng);
      const evidence = parts.evidence;
      let score = parts.evidence + parts.wagon;
      // A short shortlist is itself evidence: it must be one of you.
      if (possible && possible.size <= 3 && possible.has(slot)) score += 1;
      if (isMafiaSeat) {
        // Never your own brother. The bus, when it is boarded, is boarded on
        // purpose above, not by a brother outscoring a stranger here.
        if (familyKnownEvil.has(slot)) return { slot, score: -10 };
        if (teammateWagons.has(slot)) score += 1.5;
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
      return { slot, score, evidence };
    })
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
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
  if (top.score >= threshold && (top.evidence ?? 0) >= evidenceFloor) return top.slot;

  // Aggressive seats sometimes start a wagon on a hunch. Rarer than it was: at
  // eight per cent a table of fifteen opened one nearly every afternoon.
  if (rng() < brain.personality.aggression * 0.04) return top.slot;
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
  if (roleClaim?.claimedRole) {
    const rivalClaim = info.claims.some(
      (claim) =>
        claim.kind === 'role-claim' &&
        claim.claimedRole === roleClaim.claimedRole &&
        claim.claimerSlot !== accusedSlot &&
        info.aliveSlots.includes(claim.claimerSlot)
    );
    const buried = [...info.deadRoles.entries()].some(
      ([slot, role]) => role === roleClaim.claimedRole && slot !== accusedSlot
    );
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
    if (!rivalClaim && !buried) credit += roleDef(roleClaim.claimedRole).unique ? 0.4 : 0.08;
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
  // Any hanging is a good hanging: it keeps the rope in the room's hand and the
  // Jester in the running for it.
  if (role === 'jester') return rng() < 0.35 + stance.pushHard * 0.5 ? 'guilty' : 'innocent';

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
    if (actionType === 'alert') {
      return rng() < 0.25 + brain.personality.courage * 0.4 + stance.pushHard * 0.3 ? self.slot : null;
    }
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

  /* ------------------------------ the killers ----------------------------- */

  if (actionType === 'kill' && familyOf(role) !== null) {
    const pool = dodged(legalTargets);
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
      .filter((entry) => entry.trust >= 2.5)
      .sort((a, b) => b.trust - a.trust)
      .map((entry) => entry.slot);
    ranked.push(...trusted);
    const list = [...new Set(ranked)];
    const choice = list.length > 0 ? pickRanked(list, rng, slip) : (pool[Math.floor(rng() * pool.length)] ?? null);
    brain.lastKillTarget = choice;
    return choice;
  }

  if (role === 'serial-killer' || actionType === 'poison' || actionType === 'rampage') {
    const pool = dodged(legalTargets);
    // Prefer the loud voices — with the slip toward the second-loudest — but
    // half the nights, feed wherever hunger points.
    const loudList = credibleClaimersRanked(info, new Set([self.slot])).filter((slot) => pool.includes(slot));
    const choice =
      loudList.length > 0 && rng() < 0.5
        ? pickRanked(loudList, rng)
        : (pool[Math.floor(rng() * pool.length)] ?? null);
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
    // The vigilante's real job: finish what the town failed to. A player
    // spared at trial despite live suspicion — likely saved by evil ballots —
    // is his priority, so the bullet doesn't just duplicate tomorrow's lynch.
    const spared = info.trials
      .filter((trial) => !trial.lynched && legalTargets.includes(trial.accusedSlot))
      .map((trial) => trial.accusedSlot)
      .filter((slot) => suspicion(slot, self, info, rng) >= 1.8 - brain.personality.courage * 0.5);
    if (spared.length > 0) return pickRanked([...new Set(spared)], rng);

    const scored = legalTargets
      .map((slot) => ({ slot, score: suspicion(slot, self, info, rng) }))
      .sort((a, b) => b.score - a.score);
    const top = scored[0];
    // Discipline: only shoot with real conviction; cowards never shoot.
    if (top && top.score >= 2.9 - brain.personality.courage) return top.slot;
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

    // Stand where the knife is headed: the mayor, the claimers, and the
    // behaviorally confirmed town (the mafia hunts trusted seats too) — with
    // the 25% clutch slip. A doctor who saved the loud sheriff last night
    // knows the killer may rotate, so sometimes he rotates first.
    const ranked: number[] = [];
    if (info.revealedMayorSlot !== null && legalTargets.includes(info.revealedMayorSlot)) ranked.push(info.revealedMayorSlot);
    for (const claimer of credibleClaimersRanked(info, new Set([self.slot]))) {
      if (legalTargets.includes(claimer)) ranked.push(claimer);
    }
    const trusted = legalTargets
      .map((slot) => ({ slot, trust: trustOf(slot, info) }))
      .filter((entry) => entry.trust >= 2)
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
    // The town's escort trips the likeliest killer: the top public suspect.
    const scored = legalTargets
      .map((slot) => ({ slot, score: suspicion(slot, self, info, rng) }))
      .sort((a, b) => b.score - a.score);
    const top = scored[0];
    if (top && top.score >= 1) return top.slot;
    return random();
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
    if (info.revealedMayorSlot !== null && legalTargets.includes(info.revealedMayorSlot)) ranked.push(info.revealedMayorSlot);
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

  if (actionType === 'convert' || actionType === 'recruit') return random();

  if (actionType === 'bond') {
    // The heart wants what it wants, on night one, at random.
    return random();
  }

  // Everything else (swap, imitate, hide, charm, control): honest mischief.
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
