import type { RoleId } from '../roles.js';
import { familyOf, isSoloKiller, roleDef } from '../roles.js';
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
export type ClaimKind = 'accuse' | 'clear' | 'hint' | 'role-claim' | 'question' | 'account' | 'taunt' | 'sighting';

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
  trialSlot: number | null;
  claims: Claim[];
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
  const pressure: Pressure = {
    day: info.day,
    aliveCount: info.aliveSlots.length,
    votesAgainstMe: votesAgainst(self.slot, info),
    onTrial: info.trialSlot === self.slot,
    roleOuted: outed,
    targetedLastNight: self.intel.some((entry) => entry.night === info.day - 1 && entry.kind === 'saved'),
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
      claimerWeight(claim.claimerSlot, info) >= 1
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
  }
  return remaining;
}

/* ------------------------------ credibility ------------------------------ */

/**
 * The price of lying, and the reward for being right. An accusation that died
 * town — or a clear that died evil — zeroes the claimer's voice forever; an
 * accusation that died evil makes them a proven sheriff whose word doubles.
 */
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

/** Public suspicion of a slot, as a town-aligned seat computes it. */
export function suspicion(targetSlot: number, self: MafiaPlayer, info: PublicInfo, rng: () => number): number {
  let score = 0;

  for (const claim of info.claims) {
    if (claim.targetSlot !== targetSlot) continue;
    if (claim.claimerSlot === self.slot) continue; // own claims counted via intel below
    const weight = claimerWeight(claim.claimerSlot, info);
    if (claim.kind === 'accuse') score += 2.0 * weight;
    if (claim.kind === 'hint') score += 0.8 * weight;
    // Being out at night is not a crime — half the town is out at night.
    if (claim.kind === 'sighting') score += 0.5 * weight;
    if (claim.kind === 'clear') score -= 2.2 * weight;
  }

  // Being out at night *after saying you were home* is a different matter.
  if (contradicted(targetSlot, info)) score += 3;

  // A proven liar is himself a prime candidate.
  if (provenLiar(targetSlot, info)) score += 2.5;

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
    if (roleDef(roleClaim.claimedRole).unique && rivals.length > 0) score += 1.5;
    if ([...info.deadRoles.entries()].some(([slot, role]) => role === roleClaim.claimedRole && roleDef(role).unique && slot !== targetSlot)) {
      score += 3; // claiming a role that is already in the ground
    }
  }

  // Own hard evidence outweighs the rumour mill.
  for (const entry of self.intel) {
    if (entry.targetSlot !== targetSlot) continue;
    if (entry.kind === 'sheriff') score += entry.value === 'suspect' ? 3 : -4;
    if (entry.kind === 'role') score += isEvilRole(entry.value as RoleId) ? 4 : -4;
    if (entry.kind === 'saved') score -= 2; // an attacked patient is rarely the killer
  }

  // Never once voted for each other, and often together. See `buddyScore`.
  score += buddyScore(targetSlot, info);

  // The wagon: herd instinct, weighted by personality.
  const wagon = [...info.votes.values()].filter((voted) => voted === targetSlot).length;
  score += wagon * 0.5 * brainHerd(self);

  return score + rng() * 0.3;
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

  const publish = (targetSlot: number, kind: ClaimKind, claimedRole?: RoleId, account?: 'home' | 'visited') => {
    if (!alreadyClaimed(info, self.slot, targetSlot, kind)) {
      decision.publishes.push({
        day: info.day,
        claimerSlot: self.slot,
        targetSlot,
        kind,
        truthful: false,
        claimedRole,
        account
      });
    }
  };

  /* -------- Claims: talk to the town (or poison it). -------- */
  // A gagged mouth publishes nothing today; the vote still counts.
  const gagged = self.silencedDay === info.day;
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
      const burned = burnedFaces(info);
      const mask = pickMask('jester', stance, rng, burned);
      if (mask) publish(self.slot, 'role-claim', mask);
      if (rng() < stance.falseAccuse) {
        // Deliberately the *least* suspected seat: contradicting the room is
        // how he gets called a liar.
        const calmest = others
          .filter((slot) => !contradicted(slot, info))
          .map((slot) => ({ slot, heat: suspicion(slot, self, info, rng) }))
          .sort((a, b) => a.heat - b.heat)[0];
        if (calmest) publish(calmest.slot, 'accuse');
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
      let score = suspicion(slot, self, info, rng);
      // A short shortlist is itself evidence: it must be one of you.
      if (possible && possible.size <= 3 && possible.has(slot)) score += 1;
      if (isMafiaSeat) {
        /**
         * Never your own brother — unless he is already gone.
         *
         * A wagon that has reached the threshold is going to hang whoever it is
         * standing on, and a mafioso who is the *only* seat at the table not
         * voting for the obvious lynch has told the room exactly as much as a
         * confession would. Bussing is the standard answer: join the wagon on a
         * brother you cannot save, spend nothing, and buy a day of credit.
         *
         * Gated on temperament, because it is a cold thing to do and not every
         * seat is cold. An ally who could still be saved is never sold.
         */
        if (familyKnownEvil.has(slot)) {
          const doomed = votesAgainst(slot, info) >= Math.floor(info.aliveSlots.length / 2) + 1 - 1;
          const coldEnough = brain.personality.deceit > 0.55;
          return { slot, score: doomed && coldEnough ? 0.5 : -10 };
        }
        if (teammateWagons.has(slot)) score += 1.5;
        // A rampaging solo killer threatens the family too: for a while, the
        // mafia votes with the town against whoever the evidence points at.
        if (info.rampage >= 2 && info.claims.some((claim) => claim.kind === 'accuse' && claim.targetSlot === slot)) {
          score += 1.2;
        }
      }
      return { slot, score };
    })
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top) return null;

  // Desperation lowers the bar; at full LyLo the town must lynch someone.
  const threshold = (1.7 - brain.personality.aggression) * (1 - 0.6 * pressure);
  if (pressure >= 1) return top.slot;
  if (top.score >= threshold) return top.slot;

  // Aggressive seats sometimes start a wagon on a hunch.
  if (rng() < brain.personality.aggression * 0.08) return top.slot;
  return null;
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
     */
    return rng() < stance.sacrificeAlly ? 'guilty' : 'innocent';
  }
  if (role === 'executioner' && (self.obsessionSlotHint ?? null) === accusedSlot) return 'guilty';
  if (roleDef(role).faction === 'mafia') return 'guilty';
  // Any hanging is a good hanging: it keeps the rope in the room's hand and the
  // Jester in the running for it.
  if (role === 'jester') return rng() < 0.35 + stance.pushHard * 0.5 ? 'guilty' : 'innocent';

  const score = suspicion(accusedSlot, self, info, rng);
  // At LyLo the town leans guilty: sparing the wrong person ends the game. A
  // seat that personally feels the clock leans harder still.
  const pressure = Math.max(parityPressure(info), stance.pushHard * 0.6);
  if (score >= 1.2 - 0.5 * pressure) return 'guilty';
  if (score <= 0.4 - 0.4 * pressure) return 'innocent';
  return rng() < brain.personality.herd + 0.25 * pressure ? 'guilty' : 'innocent';
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
