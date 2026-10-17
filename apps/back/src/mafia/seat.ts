import {
  testimonyOf,
  claimerWeight,
  contradicted,
  ownsUpTo,
  deductions,
  strongest,
  wearableMask,
  twinMasks,
  maskRank,
  caseFor,
  defenceFor,
  type Deduction,
  type Reason,
  couldStillAct,
  decideNightTarget,
  judgeRequest,
  type RequestRefusal,
  type RequestVerdict,
  cellProves,
  chatLineFor,
  jailChannel,
  isKeeper,
  captiveOf,
  legalNightAction,
  playerFamily,
  wagonOpener,
  FACTION,
  isEvilRole,
  ROLE,
  ROLES,
  staysHome,
  tradeSuspects,
  QUIET_TRADE,
  sheriffSuspects,
  tradeVerdict,
  slotPool,
  spokenLocale,
  suspicion,
  buddyRead,
  suspicionParts,
  stolenBadge,
  tableRoleList,
  toMafiaView,
  trustOf,
  uncontestedBadge,
  WILL_MAX_CHARS,
  type Claim,
  type DeathSource,
  type ClaimKind,
  type MafiaPlayer,
  type MafiaState,
  isMason,
  knockIsTest,
  isLodgeMate,
  type IntelEntry,
  type MafiaView,
  type NightAim,
  type PublicInfo,
  type RoleId
} from 'mafia-core';
import type { ChatMessage } from 'chat-core';

import type { Locale } from 'i18n';

import { msg, msgOf, variant, type Msg, type VariantPrefix } from 'i18n';

import { readRoom, seatHits, selfClaim, type RoomAsks } from './asks.js';
import { say } from './say.js';
import type { BotMinds } from './bot-mind.js';
import { willHeed, type BotMind } from './bot-mind.js';
import { type Square } from './ear.js';
import { type JuryLean } from './jury.js';
import { screen } from './guard.js';
import { asksSomething, SAY_CHARS, type Intent } from './mouth.js';
import { asksRole, type SquareClaim } from './square.js';

/**
 * The phrasebook seat: one bot's turn played without a model, and everything a
 * seat keeps writing down while it plays (its will, its masks, its account of
 * the night).
 *
 * Every turn goes through here, model or no model: it is the floor the chain
 * falls back to and the record a model's line is checked against. It reads the
 * table through the bots' shared memory and decides through the table's
 * `BotTable`; the few things it needs from the driver around it (the trial's
 * leanings, what a family room asked for, the clue window, the will hook) are
 * handed in, and so is its randomness, so a test can play a seat on seeded dice
 * without reaching into the driver.
 */

/**
 * `revote` is a second look at the ballot, late in the day, and nothing else.
 *
 * A bot used to reach its verdict on the afternoon exactly once, in the first
 * half of it, and then sit on it however the argument went. The guaranteed day
 * turn lands between 5% and 45% of the phase and the ear reads the square at
 * 25% and 65%, so the ordinary case was a seat voting *before a single human
 * sentence had been turned into a claim*, and never looking again: the second
 * day turn was a 40% coin flip, so three seats in five never reconsidered at
 * all.
 *
 * Nothing about the decision was sticky. `pickVote` holds no state and does not
 * even consult the seat's own standing vote, so it would happily change its
 * mind. It was simply never asked.
 */
/**
 * `react` is a day turn taken because a person just said something the board
 * took note of: the seat whose ballot moved explains itself, citing what moved
 * it. A `day` turn in every other respect.
 */
export type BotTask = 'greet' | 'day' | 'judgement' | 'night' | 'defense' | 'revote' | 'react';

export interface Decision {
  say: string | null;
  /**
   * This line is not small talk and does not queue behind it.
   *
   * Exactly two things earn it: a seat explaining the vote it is casting, and a
   * seat answering a wagon that has formed against it. Both are moments where a
   * silent table is the bug — a square where four people vote you out and
   * nobody, including you, says a word is not a game of Mafia.
   */
  urgent?: boolean;
  targetSlot: number | null;
  /**
   * The second house of a two-target power: the Witch's destination, the Bus
   * Driver's other stop.
   *
   * Only ever set on a night turn for those two roles. Every other seat leaves it
   * null, and the engine refuses a control or a swap that arrives without one.
   */
  secondTargetSlot?: number | null;
  /**
   * Vote to hang nobody today.
   *
   * Distinct from `targetSlot: null`, which means "this turn has no opinion
   * about the ballot" and leaves whatever is standing alone. This is an opinion:
   * there is nothing on the board worth a rope.
   */
  skipVote?: boolean;
  verdict: 'guilty' | 'innocent' | 'abstain' | null;
  /** What this turn asserts publicly, for the claims board. Null = small talk. */
  claim: {
    kind: ClaimKind;
    slot: number | null;
    role: string | null;
    account?: 'home' | 'visited';
    ailment?: Claim['ailment'];
    /** Built from a night this seat actually worked. See `Claim.worked`. */
    worked?: boolean;
    /** And which power produced it, which is what corroborates. See `Claim.from`. */
    from?: Claim['from'];
    /** A sighting's house: where the seat in `slot` was seen going. See `Claim.at`. */
    at?: number;
    /** The night this is about, when it is not last night. See `Claim.night` and `claimFor`. */
    night?: number;
    /**
     * The fields the room-talk kinds are made of. See `saidFields`: a
     * counter-claim without the badge it denies, or an urge without its
     * direction, reaches the board hollow and nothing downstream can read it.
     */
    deniedRole?: RoleId;
    urge?: 'vote' | 'skip';
    promise?: 'night' | 'now';
    relayedFrom?: number;
  } | null;
  /**
   * What this turn means, for the mouth to phrase.
   *
   * The phrasebook line in `say` is the fallback and the floor; this is the same
   * move described so a model can put it in its own words without being told
   * anything it could get wrong.
   */
  intent?: Intent;
  /** Jailor only: tonight's cell, chosen during the day. */
  jailSlot?: number | null;
  /** Mayor only: put the sash on today. */
  revealMayor?: boolean;
  /** A word for one seat rather than the room. See `worthWhispering`. */
  whisper?: { toSlot: number; role: RoleId } | null;
  /**
   * The seat a private line is about, when the turn talks and does not act.
   *
   * A family turn leaves `targetSlot` null so nothing is submitted by mistake,
   * which also left the flight recorder unable to say whose name was in the
   * sentence. A live game showed five family lines in seven naming a house the
   * knife then did not visit, and the recorder could only show it by reading
   * the prose. Diagnostics only: nothing acts on it.
   */
  about?: number | null;
}

/**
 * How much a claim is worth saying out loud.
 *
 * A day phase produces several claims per seat and only one of them gets a
 * sentence, so the choice of which is the choice of what the square sounds
 * like. It used to be "the first one that is not a hint", which on a quiet day
 * two is almost always the question — twenty seats each asking a different
 * house where it was last night, and not one of them carrying information.
 *
 * Evidence outranks noise. A sighting contradicts an account, a role claim is
 * checkable, an accusation moves a wagon; a question is only worth asking when
 * a seat has nothing better, and a taunt is worth saying almost never.
 */
const CLAIM_VALUE: Record<ClaimKind, number> = {
  /**
   * The five the board learned to hold before the bots learned to say them.
   *
   * Read off human lines today and produced by nobody, which is why `sentence`
   * returns null for each: a value here is what it will be worth when a bot has
   * a phrasing for it, and leaving them out of this table would rank them below
   * a taunt the moment one appears.
   */
  /**
   * Above everything, because it is the one claim the graveyard settles itself.
   *
   * A promise is a bet on tomorrow and a role claim is a word; a corroborated
   * killing is a fact the room can check on the screens it is already looking
   * at. It is also only ever said on the one morning it can be checked, so
   * ranking it first costs no other line a turn on any other day.
   */
  'kill-claim': 9,
  promise: 8,
  'counter-claim': 6,
  demand: 5,
  relay: 4,
  urge: 2,
  ailing: 7,
  sighting: 6,
  'role-claim': 5,
  accuse: 4,
  clear: 3,
  account: 2,
  question: 1,
  taunt: 0,
  hint: -1
};

/**
 * Claims that carry evidence, as opposed to claims that fill the air.
 *
 * The split is what the two speech budgets are measured against: a table can
 * take a great deal of the first and very little of the second.
 */
/**
 * What a claim is worth saying *this turn*, which is not quite its kind.
 *
 * Only the ailments need this, and they need it because they are six different
 * errands wearing one word.
 *
 * "I have been poisoned" has a deadline — say it today or be a dawn report
 * tomorrow — so it outranks everything, including a Sheriff's finding, which
 * will keep until the seat's next turn. "A bodyguard died for me" comes next,
 * because the corpse is already in the square and the room is about to wonder
 * whose it was. "I was blackmailed" is an answer to a wagon that is forming
 * right now. A heal says a doctor is alive and points at tonight's protection.
 * "I have been doused" is a warning about a killer the town cannot do anything
 * about tonight, so it waits behind every claim that moves a rope, and a doused
 * Sheriff reports its check first. "Somebody tried and failed" is last: it
 * names no saviour and mostly advertises the speaker's own armour.
 *
 * Measured: ranking poison and petrol both at the top cost the bench three
 * points of hanging accuracy, because the useful half of the square spent its
 * turns describing its own night.
 */
const AILMENT_VALUE: Record<string, number> = {
  // The only one with a living witness: the jailor confirms it, or catches a liar.
  jailed: 4.8,
  guarded: 4.5,
  silenced: 4,
  healed: 3.5,
  // Explains a missing result; a Sheriff says it before its check would have come.
  blocked: 3.2,
  controlled: 3,
  bussed: 2.8,
  douse: 2.5,
  survived: 2
};

function claimValue(claim: { kind: ClaimKind; ailment?: Claim['ailment'] }): number {
  if (claim.kind !== 'ailing') return CLAIM_VALUE[claim.kind];
  return claim.ailment ? (AILMENT_VALUE[claim.ailment] ?? CLAIM_VALUE.ailing) : CLAIM_VALUE.ailing;
}

/**
 * The town badge a night's record can only have come from.
 *
 * Read by `maskOf` for a seat that was converted: its intel still holds the
 * nights of the badge it had, and that badge is the face it should keep.
 */
const FORMER_BADGE: Partial<Record<IntelEntry['kind'], RoleId>> = {
  sheriff: 'sheriff',
  trade: 'investigator',
  visitors: 'lookout',
  tracked: 'detective',
  saved: 'doctor',
  blocked: 'escort',
  jailed: 'jailor'
};

/**
 * The weapon a killing badge signs its work with, as the dawn report names it.
 *
 * Only the town's killers are in here, because a bluff is always a town role.
 * It is what lets a liar wearing one of these badges claim a night without
 * inventing anything: the town already knows a Vigilante fired on night 3, so
 * saying "that was me" is a claim about *whose* finger, which nothing in the
 * public record can settle. Claiming a night the report credits to somebody
 * else, or to nobody, is not a bluff — it is a sentence the square can check
 * while it is still being said.
 */
/**
 * Why a teammate's house was turned down, in the words handed to the mouth.
 * The phrasebook carries the same reasons in `mafia.bot.family.refuse.<reason>`.
 */
const REFUSAL_WHY: Record<RequestRefusal, string> = {
  pris: 'that house is out of the knife’s reach tonight: one of us is already holding or silencing it',
  blinde: 'our knife already bounced off that door',
  veteran: 'the record says a Veteran lives there, and that door is not worth the risk',
  ami: 'that seat has been doing our work for us in the square',
  rate: 'we went there last night and they survived',
  pendu: 'the town is about to hang them anyway, so the knife is worth more elsewhere',
  desavoue: 'their last tips in here cost us'
};

const MASK_WEAPON: Partial<Record<RoleId, DeathSource>> = {
  vigilante: 'vigilante',
  veteran: 'veteran',
  jailor: 'jailor'
};

/**
 * Every role a claim at this table could plausibly be.
 *
 * A model asked to bluff bluffs whatever role it has heard of, and at a table
 * of nine that produced a confident Veteran claim in a game with no Veteran in
 * it — a lie the whole square can dismiss by reading its own role list, which
 * is the one kind of lie that is worse than telling the truth. The deal is
 * public (it is the list in the top right of every screen), so the honest fix
 * is to hand the model the same list and refuse anything outside it.
 *
 * Category slots widen the set rather than closing it: "random town" means any
 * town role could be in the deal, so any town role is a claim the table cannot
 * immediately disprove — which is exactly the test a bluff has to pass.
 */
export function claimableRoles(state: MafiaState): Set<string> {
  const seats = Object.keys(state.players).length;
  const pool = new Set<string>();
  for (const token of tableRoleList(state, seats)) {
    for (const role of slotPool(token)) pool.add(role);
  }
  // A setup nobody pinned down ('chaos', 'census') expands to everything, which
  // is the truth about that table: anything really could be in it.
  return pool.size > 0 ? pool : new Set(Object.keys(ROLES));
}

/**
 * A seat's temperament, in the words the mouth is given.
 *
 * Drawn from the same `Personality` the policy plays with, so how a bot *sounds*
 * and how it *behaves* come from one place: a seat that accuses on thin evidence
 * reads as impulsive because it is impulsive.
 */
function moodOf(personality: {
  aggression: number;
  herd: number;
  claimRate: number;
  deceit: number;
  voice?: { mood: string };
}): string {
  // The character it was cast as, which is the voice its numbers were rolled for. See `CHARACTERS`.
  if (personality.voice) return personality.voice.mood;
  if (personality.claimRate < 0.3) return 'taciturn: you barely speak, and never more than a few words';
  if (personality.aggression > 0.7) return 'impulsive and combative, quick to accuse';
  if (personality.deceit > 0.6) return 'smooth and plausible, never quite pinned down';
  if (personality.herd > 0.7) return 'agreeable, happier following the room than leading it';
  if (personality.aggression < 0.3) return 'calm and careful, you argue rather than shout';
  if (Math.random() < 0.16) return 'quiet and polite, you do not like to be the centre of attention';
  if (Math.random() < 0.21) return 'friendly and helpful, you are happy to explain yourself';
  if (Math.random() < 0.31) return 'suspicious and cautious, you are slow to trust';
  if (Math.random() < 0.51) return 'witty and clever, you enjoy a good joke';
  return 'dry, a little sarcastic';
}

/** A turn where the bot does and says nothing. */
/**
 * Whether anybody could have an ear to the family's wall tonight.
 *
 * The Spy hears the mafia and the triad talk and never sees a face, which makes
 * the family room the one place in the game where a careless sentence is worth
 * more to the town than any investigation. The bots talked in it exactly as
 * they would in an empty room: houses by number, roles by name, targets a day
 * in advance.
 *
 * Read off the published roster and the graveyard, both of which every player
 * can already see. The family does not know whether a Spy was dealt — it knows
 * one *could* have been, which is the only thing a careful conspirator needs,
 * and it knows when the graveyard has produced the body.
 */
export function spyMayListen(view: MafiaView, board: PublicInfo): boolean {
  if (!board.rolesInPlay?.has('spy')) return false;
  // A spy in the ground is a wall with nobody behind it.
  if (view.players.some((player) => !player.alive && player.roleName?.k === 'mafia.role.spy.name')) return false;

  /**
   * And "could there be one" is not the question. "Is there one" is.
   *
   * `rolesInPlay` expands every category slot to everything it might roll, so a
   * single Town Investigative slot puts the Spy in that set — which is nearly
   * every roster ever dealt, and chaos and census always. The families
   * therefore hushed in every game, and on the half of tables whose discipline
   * is silence the mafia, triad and cult rooms held **no lines at all** for the
   * whole game. Verified on a real table: five nights, eighty-three chat
   * events, not one of them in a family room, with a person sitting in the Spy
   * seat waiting for something to overhear.
   *
   * A counter-measure that fires on a possibility that is always true costs the
   * family nothing and deletes a town role, an entire private channel, and the
   * only reason to sit in it. So the test is now evidence rather than paranoia:
   * the roster names a Spy outright, or somebody has stood up and claimed the
   * badge. A category slot that *might* be one is a risk a family runs, which
   * is what makes the room worth listening to.
   */
  if (view.roleList.includes('spy')) return true;
  return board.claims.some(
    (claim) =>
      claim.kind === 'role-claim' && claim.claimedRole === 'spy' && board.aliveSlots.includes(claim.claimerSlot)
  );
}

/**
 * Which of the two disciplines this table keeps. See `familyLine`.
 *
 * Half of tables go silent and half say it once out loud, decided by the join
 * code so a family is consistent with itself for the whole game rather than
 * flipping its policy every night. Both are real behaviours at a real table and
 * neither is obviously better: silence gives the Spy nothing at all, and the
 * warning costs one harmless sentence and keeps the family able to talk about
 * everything except the things that matter.
 */
function familyDiscipline(code: string): 'quiet' | 'warn' {
  return hashCode(code + ':spy') % 2 === 0 ? 'quiet' : 'warn';
}

/** The one sentence a careful family says in front of a possible Spy. */
const HUSH = 'mafia.bot.family.hush';

export const EMPTY: Decision = { say: null, targetSlot: null, verdict: null, claim: null };

/**
 * How much room a *case* gets, which is not how much room a chat line gets.
 *
 * These were one number for a while, and the reason they were merged is sound:
 * two different limits on the same sentence meant `clip` cutting a composed
 * line mid-word and putting an ellipsis on it, which is how "Tu as déjà voté…"
 * reached a real table. Composing against the figure that is actually applied
 * is the right fix.
 *
 * Merging them at 140 was the wrong half of it. `SAY_CHARS` is the mouth's
 * number and it exists to keep a *model* terse — one line, often under ten
 * words, somebody typing on a phone. A case is not that. It is the evidence
 * this seat is asking the room to hang somebody on, it is assembled from named
 * findings rather than written, and at 140 the second finding almost never fit:
 * "someone saw you visiting 5 on night 3, and 5 was killed that night" is 66
 * characters before the frame and the name, so two of them plus "It is Nami:"
 * overruns immediately and `caseLine` drops one. Which is exactly the reported
 * symptom — a square full of seats asserting things and not saying why.
 *
 * So the case keeps its own budget, larger, and the clamp below takes the wider
 * of the two so a composed line is never cut. The mouth is unaffected:
 * `readLine` still refuses a model past `SAY_CHARS`, because the thing that
 * number is protecting is the model's habit of writing prose, not the table's
 * right to hear a reason.
 */
export const CASE_CHARS = 210;

/**
 * How much of a will a bot may read out in one breath.
 *
 * Short, because the quote has to fit inside a sentence that also names who
 * wrote it and still land under `CASE_CHARS`. A will entry is one night and one
 * house, so this is generous for the lines worth quoting and cuts only the
 * rambling ones, which are the ones nobody reads anyway.
 */
const WILL_QUOTE_CHARS = 90;

/**
 * The hard ceiling on anything that reaches the square, scripted or written.
 *
 * The wider of the two on purpose: a model line has already been refused past
 * `SAY_CHARS` before it gets here, and a phrasebook line has already been
 * measured against `CASE_CHARS`. This is the backstop for neither of them
 * having happened, and a backstop that is tighter than the thing it is backing
 * is just the mid-word cut again.
 */
export const CLAMP_CHARS = Math.max(SAY_CHARS, CASE_CHARS);

/**
 * Several reasons, joined the way somebody speaking would join them.
 *
 * Full stops rather than a conjunction, and that is not a style preference.
 * Every fragment already contains its own "and" — "someone saw you visiting 5
 * on night 3, and 5 was killed that night" — so joining two of them with
 * another one produced a sentence with four in it, which is where a reader
 * gives up. Rendering them was the only way to find that out; both halves read
 * perfectly well on their own.
 *
 * Capitalised for the same reason: the frames put these after a full stop, so
 * a lowercase start gave "Not 3. nobody has ever reported them visiting
 * anyone." A catalogue cannot capitalise its own entries, because the same
 * entry is used mid-sentence elsewhere.
 */
function joinReasons(parts: readonly string[], locale: Locale): string {
  const kept: string[] = [];
  let spent = 0;
  for (const part of parts) {
    if (kept.length > 0 && spent + part.length > CASE_CHARS) break;
    kept.push(part.charAt(0).toLocaleUpperCase(locale) + part.slice(1));
    spent += part.length;
  }
  return kept.join('. ');
}

/**
 * How long the room waits after somebody asks for something.
 *
 * A skip is the town spending a day and a night on nothing, and until now the
 * question and the decision arrived together: the first bot to shrug asked "has
 * anybody got anything?" and voted to hang nobody in the same breath, and the
 * rest joined it within seconds. Nobody can answer a question that has already
 * been answered.
 *
 * Measured against the afternoon it has to fit inside: on a real table the
 * first ballots land about a quarter of the way into the day and the room's
 * reading of itself is scheduled two thirds of the way in, so fifteen seconds
 * of held ballots is the difference between a day that dies before anybody has
 * read the wills and one that does not. Long enough for a person to type a
 * sentence, and far short of the clock.
 */
export const CLUE_WINDOW_MS = 15_000;

/**
 * How soon after a seat's own line an unnamed line still reads as the answer to it.
 *
 * "why?" ten seconds after a bot accused somebody is said to that bot; the same
 * word a minute later, after three other people have spoken, is said to the
 * room. Only the line immediately after counts, so this is a ceiling, not a
 * window anything can hide in.
 */
const REPLY_GAP_MS = 20_000;

/**
 * Which sentence a will opens with when its author's badge changed hands, and from what.
 *
 * Read off `MafiaPlayer.roleHistory`, because the reason is what the sentence is
 * made of: a seat the lodge took in says so, a seat the lodge then made its
 * Master says that (it used to sign "An Auditor made me the Mason Leader",
 * `9RVWV`), an audited seat names the Auditor, and an Amnesiac says what it
 * remembered, where it used to sign as the borrowed badge with no word of how.
 * Null for a badge that never changed, and for one only a promotion inside a
 * family touched, which is the same badge with a bigger job.
 */
function willStory(
  self: MafiaPlayer
): { key: 'raised' | 'initiated' | 'audited' | 'remembered'; was: RoleId | null } | null {
  const path = self.roleHistory ?? [];
  const first = path[0];
  if (!first) return null;
  const by = (why: string) => path.some((step) => step.why === why);
  if (by('remembered')) return { key: 'remembered', was: path.find((step) => step.why === 'remembered')!.from };
  if (by('initiated')) return { key: self.role === 'mason-leader' ? 'raised' : 'initiated', was: first.from };
  if (by('audited')) return { key: 'audited', was: first.from };
  return null;
}

/**
 * How readily a seat names its badge when somebody asks outside the stand. See `roleAnswer`.
 *
 * 15% in the square, 15 more with at least two votes on the seat, 30% in a
 * whisper; then halved for somebody voting or accusing it, half again for
 * somebody who vouched for it, and moved by up to two fifths either way by how
 * far it trusts the asker. Never past 60%.
 */
const ROLE_ANSWER = {
  square: 0.15,
  pressed: 0.15,
  pressedAt: 2,
  whisper: 0.3,
  hostile: 0.5,
  friendly: 1.5,
  perRegard: 0.15,
  regardFloor: 0.6,
  regardCeiling: 1.4,
  cap: 0.6
} as const;

/** A roll in [0, 1) that is the same every time it is asked about the same thing. */
function seededRoll(salt: string): number {
  return (hashCode(salt) % 1000) / 1000;
}

/** What the Master says about a brother's request it is not granting, by why. See `knockLine`. */
const ASK_ANSWER = {
  shut: 'mafia.bot.lodge.askShut',
  reach: 'mafia.bot.lodge.askReach',
  declined: 'mafia.bot.lodge.askDeclined'
} as const;

/** The name on a door, or the number when nobody sits behind it. */
function nameAt(state: MafiaState, slot: number): string {
  return Object.values(state.players).find((player) => player.slot === slot)?.name ?? String(slot);
}

/** How many unprompted "what did I actually do?" a table hears in one day. See `BotMind.pushedBack`. */
const PUSH_BACKS_PER_DAY = 3;

/**
 * Where the current day or night began, which is where "today" begins.
 *
 * `phaseStartedAt` is stamped at `beginDay` and `beginNight` and deliberately
 * not at a stage change, so a trial and the argument that led to it are one
 * window. Falls back to the phase clock for tables persisted before the field
 * existed. Shared by everything that hands a model "what was just said": a
 * line from yesterday is not just said, and on the live tables it was the
 * commonest thing in those prompts (`59P6Z` still had "Montcul: Hi" from day
 * one in a bot's context on day nine).
 */
export function phaseWindow(state: MafiaState): number {
  const span = state.phase === 'night' ? state.config.nightMs : state.config.dayMs;
  return state.phaseStartedAt ?? (state.phaseEndsAt ?? 0) - span;
}

/**
 * A will assembled to fit the one hard limit there is, editing rather than
 * truncating.
 *
 * `setLastWill` cuts at `WILL_MAX_CHARS`, mid-word and in silence, and a
 * verbose seat writes past it: a Lookout six nights in, with a journal, ran
 * over and lost the tail. Truncation is the worst possible editor, because it
 * keeps night one and throws away last night, which is the one the town needs.
 *
 * So the seat edits its own will. The signature and tonight's journey are never
 * dropped — the first says whose word this is, the second is the line a corpse
 * cannot write afterwards. Then the nights, newest first, because a will is
 * read for what its author learned most recently; then the journal; and the
 * flavour line last, since it says nothing at all. What survives is printed in
 * reading order, which is not the order it was chosen in.
 */
function fitWill(parts: {
  role: string | null;
  nights: string[];
  /** One line per night this seat left the house, oldest first. See `BotMind.went`. */
  going: string[];
  notes: string[];
  flavour: string;
}): string {
  let left = WILL_MAX_CHARS;
  /** Room for the line and the newline that will join it. */
  const afford = (line: string): boolean => {
    if (line.length + 1 > left) return false;
    left -= line.length + 1;
    return true;
  };
  const take = (lines: string[]): string[] => {
    const kept: string[] = [];
    // Newest first, then put back into the order a reader expects.
    for (const line of [...lines].reverse()) if (afford(line)) kept.unshift(line);
    return kept;
  };

  const role = parts.role !== null && afford(parts.role) ? parts.role : null;
  /**
   * The nights first, and all of them if they fit.
   *
   * `going` used to be one line, and the caller handed it the first of however
   * many there were, so a seat that walked out on six nights willed one of them.
   * They are the cheapest and most checkable thing a corpse can leave: one line,
   * one night, a house the room can hold against somebody else's account.
   */
  const nights = take(parts.nights);
  const going = take(parts.going);
  const notes = take(parts.notes);
  const flavour = afford(parts.flavour) ? parts.flavour : null;

  return [role, ...nights, ...going, ...notes, flavour].filter((line): line is string => line !== null).join('\n');
}

/**
 * Trims a line to length without cutting a word in half.
 *
 * Falls back to a hard cut only if the first `limit` characters contain no space
 * at all, which in practice means somebody's model emitted one enormous token
 * salad and deserves to look like it.
 */
export function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

/**
 * Everything a line was read as carrying, not the three fields that came first.
 *
 * `readSquare` produces `urge`, `deniedRole` and `promise` as well, and for the
 * kinds that carry them the field *is* the claim: an `urge` with nothing on it
 * is read by `steadyVote` as `claim.urge === 'vote' ? 1 : -1`, so a person
 * typing "we need to vote" was counted, at their own credibility, as asking the
 * room for the day off. A `promise` with no `promise` never reaches the
 * broken-promise deduction, and a `counter-claim` with no `deniedRole` never
 * reaches the weight in `suspicionParts` written to read it.
 *
 * Worse than an ordinary missing field, because it could not be repaired
 * later: `record` keys a claim by claimer, target, kind, day and room, so the
 * stripped version filed here is exactly what the ear's own correct reading is
 * then swallowed as a duplicate of. The instant reader poisoned the entry and
 * held the door shut behind it.
 *
 * One function, used by both readers, so the next kind to grow a field cannot
 * arrive on the board hollow in one path and whole in the other. The ear does
 * the same thing inline in `listen`; that list is the shape this copies.
 */
export function saidFields(claim: SquareClaim): Partial<Claim> {
  return {
    ...(claim.claimedRole ? { claimedRole: claim.claimedRole } : {}),
    ...(claim.account ? { account: claim.account } : {}),
    ...(claim.ailment ? { ailment: claim.ailment } : {}),
    ...(claim.urge ? { urge: claim.urge } : {}),
    ...(claim.deniedRole ? { deniedRole: claim.deniedRole } : {}),
    ...(claim.promise ? { promise: claim.promise } : {})
  };
}

/**
 * One of a line's variants, fixed per speaker and subject.
 *
 * The catalogue holds several phrasings of everything a bot says — nine ways to
 * cast a vote, three ways to read out a night — and this is what chooses
 * between them. Deterministically, on a salt the caller picks: a seat that
 * calls you by your number keeps calling you by your number, the same reason
 * given twice reads the same twice, and a table still does not sound like one
 * voice repeated twenty times.
 *
 * `count` is a literal at every call, and `variant` holds it to the catalogue:
 * each of `key.1` to `key.count` must exist, or the call does not build.
 */
export function vary<P extends string, N extends number>(
  key: VariantPrefix<P, N>,
  count: N,
  salt: string,
  params?: Record<string, string | number | Msg>
): Msg {
  return variant(key, count, hashCode(salt), params);
}

/**
 * An examiner's finding, read back out of a seat's notes as the line it smelt.
 *
 * The one key in this file the compiler cannot check, and it is not new ground:
 * the engine files a finding as `IntelEntry.value`, a plain string shared with
 * every other kind of note, and that is all this gets to see. What it holds is a
 * trade id, and the catalogue line for every trade id is already checked where
 * the engine writes it (`NOTE.tradeLine`), so this unwraps something that was
 * vouched for on the way in.
 */
function tradeLine(trade: string): Msg {
  return msgOf(`mafia.trade.${trade}`);
}

/**
 * A sheriff's verdict as a word the reader's own catalogue renders.
 *
 * A family reads as its camp, a lone blade as its role, and the bare `suspect`
 * as nothing at all — there is no name to give, which is exactly what that
 * verdict means and why the caller falls back to the old shrug for it.
 */
function verdictName(verdict: string): Msg | null {
  if (verdict === 'mafia' || verdict === 'triad' || verdict === 'cult') return FACTION(verdict);
  return verdict in ROLES ? ROLE.name(verdict as RoleId) : null;
}

export function hashCode(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** What the seat needs from the driver around it. */
export interface SeatDeps {
  minds: BotMinds;
  /** This trial's leanings, per table, as the jury reader last read them. */
  jury(code: string): { key: string; leans: JuryLean[] } | undefined;
  /** What a private room asked for, as the room reader last read it, by `code|room`. */
  roomHeard(key: string): { upTo: number; day: number; phase: string; asks: RoomAsks } | undefined;
  /**
   * Once per afternoon, the first seat that would skip asks the room for clues
   * instead of skipping in silence. True when this seat is that one: the driver
   * opens the window and schedules the second look.
   */
  callForClues(code: string, day: number, botId: string): boolean;
  /** Writes a seat's last will. */
  will(code: string, botId: string, text: string): void;
  rng: () => number;
}

export class Seat {
  private readonly minds: BotMinds;
  private readonly rng: () => number;
  /** Dead bots whose invented will has been put on the board, per table. */
  private readonly testamentsFiled = new Map<string, Set<string>>();

  constructor(private readonly deps: SeatDeps) {
    this.minds = deps.minds;
    this.rng = deps.rng;
  }

  /** Lets go of everything kept about a table that has ended. */
  forget(code: string): void {
    this.testamentsFiled.delete(code);
  }

  /**
   * Whether this seat holds, or has already claimed, the badge in question.
   *
   * The two counter-claims are different sentences: the holder says "I am the
   * Jailor, not him", a bystander counting claims says "two of you said it".
   */
  wearsBadge(state: MafiaState, botId: string, role: RoleId): boolean {
    const self = state.players[botId];
    if (!self) return false;
    if (self.role === role) return true;
    const face = [...this.minds.ledger(state.code)]
      .reverse()
      .find((claim) => claim.kind === 'role-claim' && claim.claimerSlot === self.slot && claim.claimedRole);
    return face?.claimedRole === role;
  }

  /**
   * The badge `slot` has claimed, when it is this seat's own and the table holds one.
   *
   * The lie a seat sees through with no help from the record, the same test
   * `suspicionParts` prices. Town seats only: a family seat whose cover was
   * taken has no business contesting it in the booth.
   */
  private badgeThief(state: MafiaState, botId: string, board: PublicInfo, slot: number): RoleId | null {
    const self = state.players[botId];
    return self ? stolenBadge(slot, self, board) : null;
  }

  /**
   * The finding a relay repeats, when its source really said it.
   *
   * A relay of something nobody said is the lie `deductions` catches, and the
   * phrasebook has no business voicing it for a claim whose source is missing.
   */
  private relayed(state: MafiaState, claim: Claim): 'accuse' | 'clear' | null {
    if (claim.relayedFrom === undefined) return null;
    const source = [...this.minds.ledger(state.code)]
      .reverse()
      .find(
        (said) =>
          said.claimerSlot === claim.relayedFrom &&
          said.targetSlot === claim.targetSlot &&
          (said.kind === 'accuse' || said.kind === 'clear')
      );
    return source ? (source.kind as 'accuse' | 'clear') : null;
  }

  /* ---------------------------- the played brain --------------------------- */

  /**
   * The bench's own player, seated at a live table.
   *
   * This used to be three lines of `this.rng()` under a comment that called
   * itself "legal, silent, random", and it was the brain almost every live table
   * actually got: the LLM path needs a model to answer, so a mini PC with no
   * Ollama on it fell through to this on every single decision. The result was a
   * table of bots that voted for strangers at random, never spoke, never claimed
   * anything, never sealed a will, and — because each one rolled its own target —
   * never voted together, mafia included.
   *
   * Meanwhile `sim/policies.ts` had a real one: trust, suspicion, desperation,
   * masks, family coordination, the lot, measured over thousands of benched
   * games. `mafia-core` even says out loud that the live driver and the bench
   * "must reach for the same one" — and then the live driver reached for a coin
   * flip. It reaches for the real one now.
   *
   * The model, when there is one, still plays on top of this: an LLM turn is
   * about *how* a seat argues, and this is about what it actually knows.
   */
  play(state: MafiaState, botId: string, task: BotTask, channel = 'day', round = 1): Decision {
    const self = state.players[botId];
    const mind = this.minds.mind(state, botId);
    const view = toMafiaView(state, { kind: 'player', playerId: botId });
    const me = view.me;
    if (!self?.role || !mind || !me) return EMPTY;

    // The bots' shared brain: the same object the bench drives. See `BotTable`.
    const table = this.minds.table(state);
    const board = table.board(botId);
    const rng = this.rng;
    // Everyone this seat cannot afford to lose: its bloc, and a lover's partner. See `BotTable.allies`.
    const allies = table.allies(botId);

    /**
     * The will, brought up to date before anything else happens.
     *
     * Here rather than in the day-one greeting, which is where it used to be and
     * is why it never said anything worth reading: a seat's will was written
     * before it had learned a single thing. Every turn instead, which is safe
     * because `updateWill` compares the text it builds against the text already
     * stored and does nothing when they match, so this is a string compare on
     * all but the handful of turns where the seat actually learned something.
     */
    this.updateWill(state, botId);

    if (task === 'night' && channel === 'day' && self.role === 'crier') {
      /**
       * What the crier says into the dark.
       *
       * Its strongest suspicion, when it has one worth the breath, otherwise a
       * word to keep the town awake. No claim is filed: the voice is anonymous
       * by rule, and a claim on the board would carry the crier's own house
       * number, which is the one thing the role exists to hide.
       */
      const t = say(spokenLocale(state));
      /**
       * News first, a joke when there is none, and never a name.
       *
       * What this used to do was rank every living seat by ordinary public
       * suspicion and read out the top one, anonymously, as though it had come
       * by it at night. The role has no night action: that name was the same
       * board every other seat reads, said in a voice that promised a source.
       * An anonymous accusation is also the one kind nobody can answer, so it
       * landed unchallenged on whoever the room already disliked.
       *
       * See `crierNews`, whose every line is a fact a player can scroll up and
       * check, and which is what a town crier is actually for.
       */
      const news = this.crierNews(state, board);
      const line = news ? t(news) : t(vary('mafia.bot.crier.joke', 9, botId + ':crier:' + state.day));

      return {
        ...EMPTY,
        say: line,
        intent: {
          act: `as the anonymous night crier, whisper one rumour to the sleeping town. Say this and only this: "${line}"`,
          mood: moodOf(mind.brain.personality),
          fallback: line
        }
      };
    }

    if (task === 'night') {
      const action = me.action;

      /**
       * The cell, answered before anything asks whether this seat has a power.
       *
       * This branch used to sit below the guard on the next line, and the guard
       * is the reason a prisoner never once replied to anybody. A seat in a cell
       * is roleblocked by definition, so `me.action` is null and `me.jailed` is
       * true, and the turn returned `EMPTY` before it could reach the one thing
       * that turn was scheduled to do. A person typed "who are you?" into the
       * cell three times on a real night and got silence, because the bot on the
       * other side was structurally incapable of speaking: it was being asked to
       * talk and being told it had no move to make, and those were the same
       * question.
       *
       * The same ordering fixes the keeper's half. A turn held *in* a room is a
       * conversation and never a decision — the seat's own night turn submits
       * its power, which is what the comment on the family room already says —
       * and the execution block below had no guard saying so. Once every keeper
       * shared `jail-execute`, a Ravisseur asked to answer its captor in the
       * *Jailor's* cell fell into the block that decides its own execution,
       * returned a target with nothing to say, and was silent too.
       */
      if (channel.startsWith('jail:')) {
        const line = this.cellLine(state, botId, view, channel);
        if (!line) return EMPTY;
        const heard = this.answering(state, botId, channel);
        return {
          ...EMPTY,
          say: line,
          intent: {
            act:
              heard.length > 0
                ? 'answer the other voice in the cell, where only the two of you can hear'
                : `speak privately in the cell, where only the two of you can hear. Say this and only this: "${line}"`,
            mood: moodOf(mind.brain.personality),
            fallback: line,
            ...(heard.length > 0 ? { answering: heard } : {})
          }
        };
      }

      /**
       * A whisper, answered by the one seat it was whispered to.
       *
       * Held as a private turn like the cell, though it happens by day: the
       * rules only open a whisper thread in daylight, and the seat's own night
       * turn is scheduled on the square, so nothing here can be mistaken for
       * the night's power. Only when somebody is actually waiting on a reply;
       * the phrasebook line is the floor, and the mouth is told to answer what
       * was said.
       */
      if (channel.startsWith('pm:')) {
        const heard = this.answering(state, botId, channel);
        if (heard.length === 0) return EMPTY;
        const t = say(spokenLocale(state));
        // Asked its badge in private, which is where a seat is likeliest to give it. See `roleAnswer`.
        const confided = this.roleAnswer(state, botId, mind, board, this.saidTo(state, botId, channel), {
          privately: true,
          votesOnMe: 0
        });
        if (confided) {
          const told = t(
            vary('mafia.bot.whisper.confide', 3, botId + ':confide:' + state.day, { role: ROLE.name(confided) })
          );
          return {
            ...EMPTY,
            say: told,
            intent: {
              act: `answer the person who just whispered to you, privately: tell them you are the ${say('en')(ROLE.name(confided))}`,
              mood: moodOf(mind.brain.personality),
              fallback: told,
              answering: heard
            }
          };
        }
        const line = t(vary('mafia.bot.whisper.heard', 4, botId + ':heard:' + heard[heard.length - 1].text));
        return {
          ...EMPTY,
          say: line,
          intent: {
            act: 'answer the person who just whispered to you, privately, where only the two of you can hear',
            mood: moodOf(mind.brain.personality),
            fallback: line,
            answering: heard
          }
        };
      }

      if (!action || me.jailed) return EMPTY;
      /**
       * The order is the table's: the family's own clashes taken out first, the
       * policy's pick, a power used at home still decided by the policy, and a
       * two-house power submitted whole. What a live seat adds is the room, and
       * it is steered in below: a teammate's request and the houses it was asked
       * to spare. See `BotTable.night`.
       */
      const request: { ask: RoomAsks['ask']; verdict: RequestVerdict | null; heeded: boolean; spared: number[] } = {
        ask: null,
        verdict: null,
        heeded: false,
        spared: []
      };
      const order = table.night(botId, rng, (aim) => {
        // The lodge has its own conversation about its own door. See `steerKnock`.
        if (action.type === 'recruit') return this.steerKnock(state, botId, view, mind, aim, rng);
        const { aimable: targets, chosen: decided } = aim;
        /**
         * And what the person in the family actually asked for.
         *
         * The one room in the game where a human plays *with* the bots rather than
         * against them, and their words landed nowhere: the ear reads the square
         * only (deliberately, see `unheard`), and the night target comes from a
         * policy that has never read a line of chat. So a human triad member could
         * say "not 13, take 10" and watch the knife go into 13 with nobody
         * answering — which reads exactly like software that is not listening,
         * because it was not.
         *
         * A living teammate who names a house gets it, unless this seat is one of
         * the stubborn ones: a family where every request is granted is a remote
         * control, and one where none are is what was just reported. Whichever it
         * is, `familyLine` says so out loud in the same room, so the answer arrives
         * whether or not a model is up.
         *
         * Only killing hands take the override: a Consigliere is not the one
         * holding the knife, and pointing its investigation at whoever the family
         * fancies would waste it.
         */
        const room = action.type === 'kill' ? this.teamAsk(state, botId, view, playerFamily(self)) : null;
        const ask = room?.ask ?? null;
        /**
         * Whether the request is granted, which used to be a coin the family
         * always won.
         *
         * It was `hashCode(...) % 4 !== 0`: three times in four, for anybody, for
         * ever, on the strength of having asked. That is not a table listening to
         * somebody — it is a remote control, and a person could pick it up by
         * messaging every bot at once and move most of the knives on the table
         * without ever having been right about anything.
         *
         * Now it costs something to be listened to and something to have lied.
         * `willHeed` reads what this seat's private word has actually been worth
         * to this listener, settled by the graveyard at dawn, alongside how
         * biddable this listener is by temperament. A voice that has misled it in
         * the dark can be refused outright. The roll is still stable per day and
         * per request, so a granted request does not flicker between turns.
         */
        /**
         * And now it is judged on the house, not on a roll.
         *
         * A person in the family room is certainly family: the engine said so. So
         * the only question is whether the house they named is a worse night than
         * this seat's own pick, and `judgeRequest` answers it with a reason that
         * can be said back to them. The bench measured the old roll refusing a
         * third of requests that were, on average, exactly as good as the knife's
         * own choice. A request repeated after a refusal, with a new line since, is
         * granted unless the house is certain waste: they heard the reason and
         * still want it.
         *
         * Another bot's request still goes through the temperament roll as well,
         * or a family of bots locks onto whatever the first of them said.
         */
        const verdict =
          ask === null
            ? null
            : judgeRequest(self, mind.brain, board, ask.slot, targets, allies, {
                repeated: this.askedAgain(state, mind, playerFamily(self), ask.slot),
                credit: mind.privateTrust.get(ask.fromSlot) ?? 0
              });
        const granted =
          ask !== null &&
          !!verdict?.grant &&
          (ask.human ||
            willHeed(
              mind,
              ask.fromSlot,
              (hashCode(botId + ':ask:' + state.day + ':' + ask.slot) % 1000) / 1000,
              false
            ));

        /**
         * And the other half of a request, which is the houses not to touch.
         *
         * "Not 13, take 10" is two instructions, and the second one is the one
         * that used to get read: a family told to leave a brother's cover alone
         * would knife it anyway if the policy happened to land there. A spared
         * house is dropped whenever there is anywhere else to go.
         */
        const spared = new Set((room?.spared ?? []).map((entry) => entry.slot));
        request.spared = [...spared];
        const elsewhere = targets.filter((target) => !spared.has(target));
        const own =
          spared.has(decided ?? -1) && elsewhere.length > 0
            ? decideNightTarget(self, mind.brain, board, elsewhere, action.type, allies, self.intel, rng)
            : decided;
        // A house already named to this seat's room tonight is the house it takes. See `BotMind.named`.
        /**
         * Unless a teammate has since asked for that very house to be left alone.
         * The promise used to win over the refusal: on `J6D7G` the Godfather had
         * named Max, a person in the family said "Don't kill max", and the knife
         * stayed on Max because the house had been named first.
         */
        const promised =
          mind.named?.night === state.day && targets.includes(mind.named.slot) && !spared.has(mind.named.slot)
            ? mind.named.slot
            : null;
        /**
         * Asked for the house this seat was taking anyway, which is not a request to refuse.
         *
         * The willingness roll ran on every ask, so a real Soldato answered "they want
         * 11 dead tonight" with a refusal and a reason, and then knifed 11.
         */
        const heeded = granted || (ask !== null && ask.slot === (promised ?? own));
        if (ask !== null && verdict !== null && !verdict.grant && !heeded) {
          this.noteRefusal(state, mind, playerFamily(self), ask.slot);
        }
        request.ask = ask;
        request.verdict = verdict;
        request.heeded = heeded;
        return heeded && ask ? ask.slot : (promised ?? own);
      });
      // A power used at home names no house and no room: nothing to say about it.
      if (action.targets.length === 0) return { ...EMPTY, targetSlot: order?.targetSlot ?? null };
      const slot = order?.targetSlot ?? null;
      const { ask, verdict, heeded, spared } = request;

      /**
       * The jailor listens before pulling the lever.
       *
       * The cell is the one room in the game where a direct question gets a
       * checkable answer, and the execution used to ignore it entirely —
       * `decideNightTarget` reads the public board, which knows nothing about
       * what was said behind a locked door. So a prisoner could claim a role,
       * name a night's work and offer tomorrow's, and be emptied anyway.
       *
       * Answering is not proof and is not treated as any: a lie is cheap and
       * every guilty prisoner will tell one. It is *engagement*, weighed against
       * what the square already thinks. A seat nobody suspects that pleaded its
       * case mostly lives; a seat under real suspicion is not saved by talking;
       * and silence — which is what a bot with nothing to lose used to give —
       * remains the surest way to die in that cell.
       */
      const heldId = captiveOf(state, self.playerId);
      if (action.type === 'jail-execute' && slot !== null && heldId) {
        const cell = jailChannel(state.day, self.playerId);
        const pleaded = state.chat.messages.some((message) => message.channel === cell && message.authorId === heldId);
        const prisoner = state.players[heldId];
        const suspected = prisoner ? suspicion(prisoner.slot, self, board, rng) : 0;

        /**
         * And what the plea actually was.
         *
         * This weighed engagement alone: a prisoner that talked mostly lived
         * and one that did not mostly died, whatever either of them said. A
         * badge is the one thing said in that cell that can be checked, and
         * the jailor can check it — the claim is filed scoped to the cell, so
         * this board holds it and no other board does. A badge nobody else is
         * wearing buys a night; a badge that is already on somebody else's
         * chest, or in the ground, is the shortest confession in the game.
         */
        const told = readRoom(state, cell, 0).claimed;
        const disputed =
          told !== null &&
          (board.claims.some(
            (claim) =>
              claim.kind === 'role-claim' &&
              claim.claimedRole === told.role &&
              claim.claimerSlot !== prisoner?.slot &&
              board.aliveSlots.includes(claim.claimerSlot)
          ) ||
            [...board.deadRoles.values()].includes(told.role) ||
            [...board.provenRoles.entries()].some(([seat, role]) => role === told.role && seat !== prisoner?.slot));

        /**
         * Decisive in both directions, which it was in neither.
         *
         * The reprieves were so wide that the lever effectively did not exist:
         * any badge nobody else was wearing bought a night 85% of the time, any
         * plea at all bought one 75% of the time, and silence — the single most
         * damning thing a prisoner can offer — only killed 35% of the time. A
         * Jailor holding three charges therefore held them to the end of the
         * game, which is what "the jailor never kills" describes.
         *
         * Silence is now the answer it actually is. A prisoner given a locked
         * room, a private channel and one night to say anything at all, who
         * says nothing, has told the Jailor the only thing it needed: every
         * townsperson in that cell begs, and the seats that do not are the ones
         * with nothing safe to say. So that goes to 0.8.
         *
         * And a badge still buys a night, because it should — but 0.6, and only
         * from a seat the square is not already doubting. `cellProves` is added
         * on top because it is the one fact in this room that cannot be
         * rehearsed: a night this seat was held and the killing stopped outranks
         * anything it says now.
         */
        const proven = prisoner ? cellProves(mind.brain, prisoner.slot) : 0;
        const weight = suspected + proven;

        /**
         * "I am the Jailor", said to the Jailor.
         *
         * The one plea in this room that is a confession with certainty, and
         * `disputed` could not see it: it looks for a *rival* claim on the
         * board, and the rival here is the hand on the lever, which has not
         * claimed anything out loud. A real table heard a mafioso tell its real
         * Jailor exactly this on two nights running and walk out both mornings.
         * The same holds when the prisoner has worn this badge in the square.
         */
        const mine = self.role;
        const wearsMine =
          !!prisoner &&
          !!mine &&
          ROLES[mine].unique === true &&
          ((told !== null && told.fromSlot === prisoner.slot && told.role === mine) ||
            stolenBadge(prisoner.slot, self, board) !== null);
        if (wearsMine) return { ...EMPTY, targetSlot: slot };

        if (told && disputed && rng() < 0.9) return { ...EMPTY, targetSlot: slot };
        if (proven >= 1.8 && rng() < 0.85) return { ...EMPTY, targetSlot: slot };
        if (told && !disputed && weight < 1.4 && rng() < 0.6) return { ...EMPTY, targetSlot: null };
        if (pleaded && weight < 1.0 && rng() < 0.55) return { ...EMPTY, targetSlot: null };
        if (!pleaded && rng() < 0.8) return { ...EMPTY, targetSlot: slot };
      }

      /**
       * A family that never says a word to itself.
       *
       * The private channel was scheduled, a bot was picked to speak in it, and
       * the played brain returned a target with `say: null` — so the one room in
       * the game where the bots have something genuinely worth reading, and a
       * human teammate sitting in it, was silent every night. What goes in it is
       * not chat: it is a proposal and its reasoning, which is the only way the
       * human in the family can disagree before the knife lands.
       *
       * The channel turn only ever *talks*; the seat's actual submission happens
       * on its own turn, which is why no target is returned here.
       */
      /**
       * The cell. Two very different jobs behind one channel.
       *
       * The jailor is interrogating and gives nothing away. The prisoner is
       * bargaining for its life against somebody it cannot identify — the cell
       * looks the same whether the hand on the key is a Jailor or something
       * wearing one — so it offers what it has and hopes.
       */
      /**
       * Both private rooms, and the one thing they have in common.
       *
       * The intent used to end "say this and only this", which is right when
       * nobody is waiting on an answer and exactly wrong when somebody is: a
       * person typing into the family channel or pleading from a cell got a
       * phrasebook line back, verbatim, because the mouth had been forbidden
       * from writing anything else. When there are words to answer, the act
       * describes the move and the model is allowed to actually reply.
       */
      /**
       * The lodge, where the only thing worth saying is what you know.
       *
       * A family room is a planning room: there is a knife and somebody has to
       * point it. The lodge has no knife and no plan — what it has is two or
       * three seats who are certain of each other, which makes it the one place
       * in the game where a suspicion can be passed on without being weighed
       * first. So a brother reports: who it is watching and why, or who the
       * Master is bringing in tonight.
       */
      if (channel === 'mason') {
        /**
         * The name the Master is actually taking tonight, not a fresh draw.
         *
         * The family room learned this the hard way and the lodge was left
         * with the bug: `slot` comes out of a policy full of deliberate
         * randomness and this turn only *talks*, so the brothers were told one
         * house and the initiation went to another. On a real table the lodge
         * heard "Tonight I initiate Pinhead" while the submitted target was
         * Sonic, and then Blade — three nights, three names, none of them the
         * one that was knocked on.
         *
         * Read off the submission like `familyKnife` does, and nothing is said
         * about a recruit until there is one, which is an honest answer early
         * in the night rather than a promise the dawn contradicts.
         */
        const committed = state.nightActions[botId]?.targetId;
        const recruit = committed ? (state.players[committed]?.slot ?? null) : null;
        const line = this.lodgeLine(state, botId, view, board, recruit);
        if (!line) return EMPTY;
        if (recruit !== null) mind.named = { night: state.day, slot: recruit };
        const heard = this.answering(state, botId, channel);
        return {
          ...EMPTY,
          say: line,
          // The house the line is actually about: the recruit when there is one.
          about: recruit ?? slot,
          intent: {
            /**
             * Answering a brother still says what the line says. The act used to be
             * a generic "answer your brother" whenever a person had spoken, so with
             * a model up the Master's actual answer (as you asked, that door is
             * shut, I am testing X) lived only in the fallback and was never said.
             */
            act:
              heard.length > 0
                ? `answer your brother in the lodge, where only the masons can hear, and tell them this: "${line}"`
                : `tell your brothers in the lodge what you know, where only the masons can hear. Say this and only this: "${line}"`,
            mood: moodOf(mind.brain.personality),
            fallback: line,
            ...(heard.length > 0 ? { answering: heard, heardIn: 'room' as const } : {})
          }
        };
      }

      if (channel === 'mafia' || channel === 'triad' || channel === 'cult') {
        /**
         * The house the family is actually going to visit, not a fresh guess.
         *
         * This turn only talks — the seat's own submission happens on a turn of
         * its own — and it used to describe `slot`, which is a *new* draw from
         * a policy full of deliberate randomness. So the room was told one name
         * and the knife went somewhere else: measured on a real table, five of
         * seven family lines named a house nobody visited that night.
         *
         * Worse for everybody who is not holding the knife. A Consort's slot is
         * the house it means to keep busy and a Janitor's is the body it means
         * to clean, and both came out of the mouth as "the one I want dead" —
         * so the family's own room was full of confident plans that were not
         * anybody's plan. Now a seat reads the committed action off the state,
         * and a seat with no knife and nothing committed to talk about says
         * nothing about targets at all.
         */
        const knife = this.familyKnife(state, botId);
        const holdsKnife = legalNightAction(state, botId)?.type === 'kill';
        const aim = knife ?? (holdsKnife ? slot : null);
        /**
         * And what this seat is doing with its own night, when it is not the one
         * killing.
         *
         * A Consort, a Janitor, a Framer or a Cultist has a target every night
         * and none of them is a kill, so describing it as one was a lie the room
         * then planned around. Saying it plainly is worth more than silence:
         * it is how the family knows the Sheriff will be busy tonight, and it is
         * the answer a person sitting in that room is waiting for.
         */
        const own = state.nightActions[botId]?.targetId;
        const ownSlot = own ? (state.players[own]?.slot ?? null) : slot;
        const job = holdsKnife ? null : ownSlot;
        const shop = this.familyLine(state, botId, view, board, aim, ask, heeded, job, verdict?.reason ?? null);
        if (!shop) return EMPTY;
        // The knife-holder's own named house, and the job of a seat that has none.
        const mine = holdsKnife ? knife : own ? ownSlot : null;
        if (mine !== null) mind.named = { night: state.day, slot: mine };
        const heard = this.answering(state, botId, channel);
        // Under a possible Spy the mouth is not handed a house number to avoid saying; it is handed nothing at all.
        const hushed = spyMayListen(view, board);
        /**
         * Names, never bare numbers. "you want 1 dead" was read by the model as
         * a count, and a human mafioso who had just typed "Don't kill max" was
         * told "Max will get the single death tonight, thanks" while the knife
         * was moving off Max (`J6D7G`).
         */
        const called = (house: number): string => nameAt(state, house);
        const leftAlone = spared.filter((house) => house !== aim).map(called);
        const sparing = leftAlone.length > 0 ? `, and tell them you are leaving ${leftAlone.join(' and ')} alone` : '';
        return {
          ...EMPTY,
          say: shop,
          about: aim,
          intent: {
            ...(hushed ? { hushed: true } : {}),
            act: hushed
              ? `answer your own family privately, but a SPY MAY BE LISTENING to this room: use NO name, NO house number and NO role, whatever you were asked, ${ask ? (heeded ? 'agree to what they asked' : 'turn down what they asked') : 'acknowledge them and say nothing specific'}`
              : ask
                ? heeded
                  ? `agree to what your own family just asked for, privately: they want ${called(ask.slot)} dead tonight, and that is where the knife goes`
                  : `turn down what your own family just asked for, privately: they want ${called(ask.slot)} dead tonight and you want ${aim === null ? 'to hear more first' : `${called(aim)} instead`}${verdict?.reason ? `, because ${REFUSAL_WHY[verdict.reason]}` : ''}. Say the reason.`
                : heard.length > 0
                  ? `answer your own family, privately, about tonight: you want ${aim === null ? 'to hear what they think' : `${called(aim)} dead`}${sparing}`
                  : `tell your own family, privately, what you want done tonight. Say this and only this: "${shop}"`,
            mood: moodOf(mind.brain.personality),
            fallback: shop,
            ...(heard.length > 0 ? { answering: heard, heardIn: 'room' as const } : {})
          }
        };
      }
      /**
       * The Witch and the Bus Driver name a second house before they name any.
       *
       * Submitted together or not at all: the engine refuses half of one of these
       * orders, and half of one is what every bot in the game used to send. The
       * fallback that covered for it picked the second house at random, which put
       * a quarter of all controls and swaps through the actor's own seat.
       */
      return { ...EMPTY, targetSlot: slot, secondTargetSlot: order?.secondTargetSlot ?? null };
    }

    if (task === 'judgement') {
      const accused = view.trial?.slot;
      if (accused === undefined) return EMPTY;
      const verdict = table.ballot(botId, rng);
      if (verdict === null) return EMPTY;

      /**
       * What the trial did to this juror, if anybody read it.
       *
       * Applied last and applied gently: it only moves a seat whose own
       * reasoning did not already point somewhere firmly, and it never moves
       * one whose loyalties settle the matter — a mafioso does not hang a
       * brother because an argument was good, and the family's own verdicts
       * are decided several branches above this one.
       *
       * The point is the seat in the middle: the juror with no strong read,
       * who used to fall through to a coin flip weighted by temperament and
       * now falls through to what was actually said in the room.
       */
      const read = this.deps.jury(state.code);
      const lean = read?.leans.find((entry) => entry.slot === me.slot);
      let cast = verdict;
      if (lean && !allies.has(accused) && ROLES[self.role].faction === 'town') {
        /**
         * The argument may outrank the arithmetic, but never an eyewitness.
         *
         * The gate here used to be "unless the brain is already sure", where
         * sure meant a *suspicion score* past a threshold — so a seat whose
         * certainty was built entirely out of other people repeating each other
         * was immune to having the trial explained to it. That is backwards.
         * The score is a summary of the board, and the whole reason a trial
         * exists is that the board does not hold how well anything was argued:
         * a seat gave the defence of the evening and was hanged by numbers that
         * had not moved, which is what the jury reader was written for.
         *
         * So the reading now wins by default, and yields to exactly one thing:
         * this juror holding hard evidence of its own. A check it ran, a
         * doorstep it stood on, a contradiction the record proves. An argument,
         * however good, does not talk a Sheriff out of what the Sheriff saw —
         * and that is also the safety rail, because a model that hallucinates a
         * juror or a verdict can now move a ballot, and the seats it must never
         * move are precisely the ones that know something.
         */
        /**
         * "Something of its own" means its own notebook, not the room's.
         *
         * This was `suspicionParts(...).hard < 1`, which reads as the right
         * test and is not: `hard` also collects every credible `worked`
         * accusation *other* seats have published. So a juror holding nothing
         * whatsoever, sitting at a table with two loud investigators, scored
         * well past the bar and became immune to having the trial explained to
         * it — which is precisely the seat the jury reader exists for.
         *
         * The honest question is whether this juror spent a night on the seat
         * in front of it. A check it ran, a doorstep it stood on, a house it
         * watched. That is the thing an argument cannot talk anybody out of,
         * and it is the only thing that should hold the reading off.
         */
        const sawItMyself = self.intel.some(
          (entry) => entry.targetSlot === accused || (entry.slots?.includes(accused) ?? false)
        );
        if (!sawItMyself) cast = lean.lean;
      }

      /**
       * And the juror says which way, and why.
       *
       * Every ballot in this game was cast in silence: forty-three verdicts
       * across one table and not one sentence attached to any of them, so a
       * person on the stand watched a number appear and never learned what any
       * of it was about. The stand is also the one moment where the room has
       * genuinely made up its mind, which makes it the cheapest place in the
       * game to show the reasoning — and the place where a wrong verdict is
       * most worth arguing with.
       *
       * The reason comes from `why` and `standUpFor`, which read the board, so
       * a juror can only say things the record contains. The floor caps how
       * many of them speak, as it does everywhere else: a jury is two or three
       * voices and a nod, not twelve people each reading out the same fact.
       */
      /**
       * The accused is wearing this juror's own badge.
       *
       * The one thing in the booth this seat knows for certain, and the booth is
       * the first moment it can say it: a claim made on the stand arrives while
       * only the accused may speak. A real table had its Jailor vote guilty on a
       * fake Jailor "because Jon Snow is pushing them", the line was dropped by
       * the floor, and the town spared the liar 8 to 4. So the ballot is guilty
       * whatever the jury reader thinks, and the sentence is the counter-claim,
       * filed as one, which also takes it out of the filler budget.
       */
      const stolen = this.badgeThief(state, botId, board, accused);
      if (stolen) {
        const denial: Claim = {
          kind: 'counter-claim',
          claimerSlot: me.slot,
          targetSlot: accused,
          deniedRole: stolen,
          day: state.day,
          truthful: true
        };
        const spokenDenial = this.sentence(state, botId, denial);
        if (spokenDenial) {
          return {
            ...EMPTY,
            verdict: 'guilty',
            say: spokenDenial,
            urgent: true,
            claim: { kind: 'counter-claim', slot: accused, role: null, deniedRole: stolen },
            intent: {
              act: this.actOf(state, denial) + `, and that you are voting GUILTY`,
              mood: moodOf(mind.brain.personality),
              fallback: spokenDenial,
              vote: { slot: accused, label: Object.values(state.players).find((p) => p.slot === accused)?.name ?? '' }
            }
          };
        }
      }

      const line = this.verdictLine(state, view, board, botId, accused, cast);
      if (!line) return { ...EMPTY, verdict: cast };

      const accusedName = Object.values(state.players).find((player) => player.slot === accused)?.name ?? '';
      return {
        ...EMPTY,
        verdict: cast,
        say: line,
        intent: {
          act:
            cast === 'guilty'
              ? `say out loud that you are voting GUILTY on ${accusedName}, and why`
              : `say out loud that you are voting INNOCENT on ${accusedName}, and why`,
          mood: moodOf(mind.brain.personality),
          fallback: line,
          // Only a guilty ballot is a vote against somebody; the mouth checks it is not denied.
          ...(cast === 'guilty' ? { vote: { slot: accused, label: accusedName } } : {})
        }
      };
    }

    if (task === 'greet') {
      /**
       * Day one has nothing to deduce and everything to establish.
       *
       * A table where nobody says hello is a table where the first real
       * sentence, on day two, arrives with no voice behind it — so the seats
       * that are going to talk at all introduce themselves, and the quiet ones
       * stay quiet, which is a personality rather than an absence.
       */
      if (mind.brain.personality.claimRate < 0.3) return EMPTY;
      const hello = this.greeting(state, botId);
      return {
        ...EMPTY,
        say: hello,
        intent: {
          act: 'say hello to the table on the first day, when nobody knows anything yet',
          mood: moodOf(mind.brain.personality),
          fallback: hello
        }
      };
    }

    if (task === 'defense') {
      // On the stand, or watching one: the accused empties its pockets, the
      // room mutters. Only the first mutter from the benches; the stand gets
      // every round it was given.
      const onTrial = view.trial?.slot === me.slot;
      if (!onTrial && (round > 1 || mind.brain.personality.claimRate < 0.45)) return EMPTY;

      /**
       * The sash, on the stand, which is the one place it was never reached for.
       *
       * `decideDay` has always known to reveal when the room turns on a Mayor —
       * two votes, or a trial already open — but `decideDay` is only ever called
       * on a *day* turn, and once the threshold is reached the stage is no
       * longer discussion. So the only path that reached the condition was the
       * one the condition could no longer be checked on: a bot Mayor voted
       * straight to the stand died with the sash in its pocket, which is what
       * was reported, and revealing would have saved it and tripled its vote
       * for the rest of the game.
       *
       * Reaching for it here, where it costs a seat nothing it has not already
       * lost: the room is about to hang it either way.
       */
      const sash = onTrial && !self.revealed && (self.role === 'mayor' || self.role === 'marshall');

      const plea = this.defenceLine(state, botId, onTrial, round);
      if (!plea) return sash ? { ...EMPTY, revealMayor: true } : EMPTY;

      /**
       * The stand, which is the last place in this file that should have been a
       * phrasebook and was the only one still locked to one.
       *
       * Every other room had already been freed: the cell and the family
       * channel describe the move and let the model reply, because somebody is
       * waiting on an answer there. Nobody is waiting on an answer harder than a
       * room that has just voted to try you, and this path still ended with "say
       * this and only this", so a seat with a genuine case to make recited a
       * stock line instead of making it. A bot that defends itself badly is
       * demoralising to play against; a bot that cannot defend itself *at all*
       * because the wording was nailed shut is worse, because the room can tell.
       *
       * What changes is only the wording, as everywhere else. The claim this
       * turn files, the reveal, the vote: all settled above and none of them
       * reachable from here. What the model is given is the case against the
       * seat and the material the seat actually holds, and what it is asked for
       * is an answer to that case rather than a paraphrase of a stock line.
       */
      const against = onTrial ? this.caseAgainst(state, view, board, me.slot, botId) : null;
      const heard = onTrial ? this.answering(state, botId, 'day') : [];

      /**
       * The will, handed to the mouth as the thing to defend from.
       *
       * A seat rewrites this every dawn out of the record it is actually
       * holding — real for the town, invented once and kept for a liar — so by
       * the time the room drags it to the stand it is carrying the most
       * complete and most consistent account of itself it will ever have. It
       * was not being used. The model was told to "be specific: name nights and
       * houses" with none of it in front of it, and did exactly that: it made
       * specifics up, one fresh contradiction per round, in front of a room
       * already voting.
       *
       * Only on the stand. Everywhere else a seat is chatting, and a paragraph
       * of its own nights in the prompt would have it reciting its diary at
       * people who asked it nothing.
       */
      const willed = onTrial ? state.players[botId]?.lastWill : null;

      /**
       * A recited record goes out as written.
       *
       * No `intent` means no model, which is the whole point: these sentences
       * were built from structured entries and already agree with each other.
       * Handing them to a mouth told to put things "in your own voice" is how a
       * consistent record becomes four stories.
       */
      if (plea.verbatim) {
        return { ...EMPTY, revealMayor: sash, say: plea.text, claim: plea.claim };
      }

      return {
        ...EMPTY,
        revealMayor: sash,
        say: plea.text,
        claim: plea.claim,
        intent: {
          act: onTrial
            ? 'you are on the stand and the room is about to vote on hanging you. Answer the case against you in your own words, in one or two sentences. Be concrete, but only from your own record below: name the night and the house exactly as you already wrote them. Do not repeat yourself and do not beg.'
            : 'mutter something from the benches while somebody else is on trial',
          ...(against ? { because: against } : {}),
          mood: moodOf(mind.brain.personality),
          fallback: plea.text,
          ...(willed ? { record: [willed] } : {}),
          ...(heard.length > 0 ? { answering: heard } : {})
        }
      };
    }

    /* ------------------------------- daylight ------------------------------- */

    /**
     * The turn itself is the table's: `decideDay` with the seat's own family as
     * the faces it knows are guilty, then the ballot this turn actually casts,
     * which is not always what it proposes. The proposal carries jitter, so on
     * any turn after the first it is weighed against the vote already standing
     * rather than simply replacing it. Both day turns and the late second look
     * go through here, so what a seat says and what its ballot does cannot
     * disagree. See `BotTable.day`.
     */
    const move = table.day(botId, rng);
    if (!move) return EMPTY;
    const { decision: day, ballot, standing } = move;
    /**
     * The vote this turn is *about*: the ballot when it moves, the standing
     * vote when it does not and this is a reaction.
     *
     * A reaction turn exists to explain a ballot that has just been cast, and
     * by the time it runs `steadyVote` sees the same proposal it saw a second
     * ago and answers "leave it". Explaining nothing is not a reaction, so the
     * sentence is built around the vote actually standing.
     */
    const voting = ballot.slot ?? (task === 'react' ? standing : null);

    if (task === 'revote') {
      /**
       * Late in the day, silently, the ballot and nothing else.
       *
       * No line and no claim: the roster already shows an accusation moving, and
       * a guaranteed second sentence per seat per day turns the square into a
       * wall of near-identical accusations, which is why the chatty second turn
       * is a coin flip in the first place. This is the *vote* being reconsidered,
       * which is the part that was missing.
       */
      /**
       * Silent, but not empty-handed: an aside `decideDay` chose on this turn
       * still goes out. It is written onto the brain the moment it is chosen,
       * and this branch used to drop it, so the re-vote waves that follow every
       * line a person types spent the one whisper each seat would ever send. Ten
       * live games, three revealed sashes alive for a day or more, and not one
       * whisper.
       */
      const aside = day.whisper ? { whisper: day.whisper } : {};
      if (ballot.skip) return { ...EMPTY, skipVote: true, ...aside };
      return { ...EMPTY, targetSlot: ballot.slot, ...aside };
    }

    /**
     * One claim becomes one sentence, and the sentence is the vote.
     *
     * `decideDay` already produces the whole social move — an accusation, a
     * cover for an ally, a role claim, a lie about last night — as structured
     * `Claim`s. All that was missing was somebody to say them out loud, which is
     * why a table of these bots was silent while quietly playing a real game.
     */
    /**
     * A vote nobody explains.
     *
     * `decideDay` reaches a `voteSlot` from the board — from a contradiction,
     * from a wagon already rolling, from an investigator's report three days
     * old — and none of those paths necessarily produce an `accuse` claim. So
     * the tally moved and the square stayed silent, which is exactly what a
     * table sees as broken: four accusations on the roster and nothing in the
     * chat to argue with.
     *
     * A vote is a public act. If this seat is casting one and has not already
     * said why, saying why *is* the line.
     */
    const publishes = [...day.publishes];

    /**
     * The shot, owned, on the one morning the record will back it.
     *
     * A Vigilante, Jailor or Veteran that killed last night wakes to a dawn
     * report naming its weapon, and until now had no sentence for it. What it
     * could say was "I went to 7's house" — an admission priced at +0.8 against
     * it by `visits`, identical to a mafioso caught on the same step — so the
     * town's own killers were structurally the most suspicious seats at the
     * table for having done their jobs. The honest play was to shut up, which
     * is the opposite of what the role is for.
     *
     * Claimed only when the report agrees. This seat knows where it went, the
     * graveyard says who died there and what killed them, and `provenRoles` will
     * confirm the badge outright if the corpse also came up evil. A claim the
     * room can check is worth making; a claim about a night that produced no
     * matching body is a lie the graveyard has already caught, so it is not
     * made. That asymmetry is the whole point of the kind.
     *
     * First in the queue, ahead of the ordinary accusation: it is the heaviest
     * true thing this seat can say, and the day it can say it is the day the
     * report is fresh.
     */
    const weapon: Partial<Record<string, DeathSource>> = {
      vigilante: 'vigilante',
      jailor: 'jailor',
      veteran: 'veteran'
    };
    const mine = me.role ? weapon[me.role.id] : undefined;
    const struck = mind.brain.wentTo;
    if (mine !== undefined && struck !== null && struck !== undefined && struck !== me.slot) {
      const lastNight = Math.max(1, state.day - 1);
      const body = board.deaths.find(
        (death) => death.slot === struck && death.phase === 'night' && death.day === lastNight && death.source === mine
      );
      const already = board.claims.some(
        (claim) => claim.kind === 'kill-claim' && claim.claimerSlot === me.slot && claim.targetSlot === struck
      );
      /**
       * And the knife that arrived second does not get to claim the body.
       *
       * The report above only says a corpse of the right weapon is lying where
       * this seat went, which is a different sentence from "I killed it". Two
       * Vigilantes who pick the same house on the same night both pass that test
       * and both stand up the next morning claiming the same kill: seen on the
       * bench, two amnesiacs who had each remembered Justicier, and the board
       * filed both as `truthful`. One of them was lying without knowing it.
       *
       * Read off `nightLog` rather than the notification feed. The feed is a
       * rolling sixty entries that nothing clears between nights, so a fixed
       * tail of it failed in both directions: an `attackTooLate` from night 3
       * was still sitting in the last four notes on night 5 and gagged a real
       * kill-claim, and a seat that picked up four notes after its attack lost
       * tonight's one and made the double-claim anyway. `nightLog` is rewritten
       * whole every night and carries the attacker, so it answers the question
       * that was actually being asked: did *this* blade arrive second, *last
       * night*, at *that* house.
       */
      const tooLate = (state.nightLog ?? []).some(
        (outcome) => outcome.attackerSlot === me.slot && outcome.targetSlot === struck && outcome.outcome === 'too-late'
      );
      if (body && !already && !tooLate) {
        publishes.unshift({
          kind: 'kill-claim',
          claimerSlot: me.slot,
          targetSlot: struck,
          claimedRole: me.role?.id,
          night: lastNight,
          day: state.day,
          // True by construction here: the report is what let this be said.
          truthful: true
        });
      }
    }
    if (voting !== null && !publishes.some((claim) => claim.kind === 'accuse')) {
      const mark = Object.values(state.players).find((player) => player.slot === voting);
      /**
       * A vote this seat's own night stands behind is a night's work, and says so.
       *
       * The vote's accusation was always filed bare, so a Sheriff saying "Voting
       * 13, because my night 1 check on them came back Arsonist" put a hunch on
       * the board: the room weighed it as an opinion, and hanged the Sheriff
       * instead of the Arsonist.
       */
      const grounded = (state.players[botId]?.intel ?? []).find(
        (entry) =>
          entry.targetSlot === voting &&
          ((entry.kind === 'sheriff' && sheriffSuspects(entry.value)) ||
            (entry.kind === 'role' && entry.value in ROLES && isEvilRole(entry.value as RoleId)) ||
            (entry.kind === 'trade' && tradeVerdict(entry.value, board.rolesInPlay) === 'damning') ||
            (entry.kind === 'tracked' &&
              (entry.slots ?? []).some((house) =>
                board.deaths.some(
                  (death) => death.slot === house && death.phase === 'night' && death.day === entry.night
                )
              )))
      );
      publishes.push({
        kind: 'accuse',
        claimerSlot: me.slot,
        targetSlot: voting,
        day: state.day,
        ...(grounded ? { worked: true, from: grounded.kind, night: grounded.night } : {}),
        // Ground truth, for the bench's honesty statistics. A live table never
        // reads it; the headless one scores every claim against the deal.
        truthful: !!mark?.role && ROLES[mark.role].faction !== 'town'
      });
    }

    /**
     * Only a claim that can be said competes for the turn.
     *
     * The ranking below puts a promise and a counter-claim above everything, so
     * one of them missing the field its sentence is made of used to win the
     * turn and then produce no line, and the seat's role claim and accusation
     * behind it were never heard either. And the clock is one sentence per
     * afternoon, not one per seat: the second "we have to vote" is a chorus.
     */
    const sayable = publishes.filter((claim) => {
      if (claim.kind === 'counter-claim') return claim.deniedRole !== undefined;
      if (claim.kind === 'promise') return claim.promise !== undefined;
      if (claim.kind === 'relay') return this.relayed(state, claim) !== null;
      if (claim.kind === 'urge') {
        return (
          claim.urge !== undefined &&
          !board.claims.some((said) => said.kind === 'urge' && said.day === state.day && said.claimerSlot !== me.slot)
        );
      }
      return true;
    });

    // A reaction explains the vote before anything else it might have to say.
    const spoken =
      (task === 'react'
        ? sayable.find((claim) => claim.kind === 'accuse' && claim.targetSlot === voting)
        : undefined) ??
      sayable.sort((left, right) => claimValue(right) - claimValue(left))[0] ??
      null;

    /**
     * And the other half of the same silence: the seat being voted for.
     *
     * A player with the room aiming at them says something, always — that is
     * the single most reliable behaviour in the game, and these bots did it
     * only once the trial had formally opened, by which point the argument is
     * over. Under real pressure the defence comes first and whatever else this
     * turn had to say waits for the next one.
     *
     * **The first vote, not the fourth.** This was half the vote threshold,
     * which at a full table is four accusations: by then the wagon is built,
     * three other seats have committed to it in public, and the one sentence
     * that would have stopped it — "why me?" — arrives too late to cost the
     * pusher anything. A person under one vote answers it immediately, and
     * answering early is also what makes the rest of the afternoon readable:
     * the room hears the objection while it is still deciding. So any vote at
     * all is enough, and `onVote` wakes the seat rather than making it wait for
     * a turn it may not get.
     */
    const heatRow = view.players.find((player) => player.slot === me.slot);
    /**
     * Unless this turn holds something better than "why me".
     *
     * The push-back used to replace everything else the seat had to say, so a
     * Sheriff with one vote on it and a check on the seat the room was voting
     * sat on the check and asked who put its name up. A badge, a promise, a shot
     * owned or a night's result read out *is* the answer to the wagon, and it
     * goes out instead; the push-back is for a seat with nothing to show.
     */
    const bestCard = publishes.some(
      (claim) =>
        claim.kind === 'role-claim' ||
        claim.kind === 'promise' ||
        claim.kind === 'kill-claim' ||
        (claim.worked === true && (claim.kind === 'accuse' || claim.kind === 'clear' || claim.kind === 'sighting'))
    );
    const votesOnMe = heatRow?.votesAgainst ?? 0;

    /**
     * Asked what it is, and this time it says. See `roleAnswer`.
     *
     * Ahead of the wagon, because a person asking the seat a direct question is
     * the thing most worth answering, and a badge is also the best answer a
     * wagon can get. Filed like any role claim, so the board can hold the seat
     * to it.
     */
    if (task === 'react' && view.trial === null) {
      const toldMe = this.saidTo(state, botId, 'day');
      const askedMe = toldMe.map((message) => this.quoted(state, botId, message));
      const answer = this.roleAnswer(state, botId, mind, board, toldMe, { privately: false, votesOnMe });
      if (answer) {
        const said = say(spokenLocale(state))(
          vary('mafia.bot.askedRole', 3, botId + ':asked:' + state.day, { role: ROLE.name(answer) })
        );
        return {
          say: said,
          intent: {
            act: `answer the question: say you are the ${say('en')(ROLE.name(answer))}`,
            mood: moodOf(mind.brain.personality),
            fallback: said,
            answering: askedMe
          },
          urgent: true,
          targetSlot: ballot.slot,
          skipVote: ballot.skip,
          verdict: null,
          claim: { kind: 'role-claim', slot: null, role: answer },
          jailSlot: day.jailSlot,
          revealMayor: day.revealMayor,
          whisper: day.whisper
        };
      }
    }
    // Whoever put the rope round this seat's neck, in their own words.
    const toldOnWagon = votesOnMe >= 1 && view.trial === null && !bestCard ? this.saidTo(state, botId, 'day') : [];
    const today = mind.pushedBack?.day === state.day ? mind.pushedBack : null;
    const pushedAt = today?.votes ?? 0;
    // Only a sentence it has not already answered earns another push-back; the same words stay said all day.
    const newest = toldOnWagon.at(-1)?.id ?? 0;
    const heardOnWagon =
      newest > (today?.heard ?? 0) ? toldOnWagon.map((message) => this.quoted(state, botId, message)) : [];
    /**
     * Once per wagon, not once per turn. See `BotMind.pushedBack`: a seat that
     * has already objected to these voters has something else to say, or
     * nothing, until the wagon grows or a person speaks to it.
     */
    /**
     * And only a few seats a day across the whole table, unless a person is the
     * one asking: twenty seats each objecting once is still twenty objections.
     */
    const roomForIt = heardOnWagon.length > 0 || this.minds.countToday(state, 'push-back') < PUSH_BACKS_PER_DAY;
    if (
      votesOnMe >= 1 &&
      view.trial === null &&
      !bestCard &&
      roomForIt &&
      (votesOnMe > pushedAt || heardOnWagon.length > 0)
    ) {
      this.minds.countToday(state, 'push-back', true);
      mind.pushedBack = {
        day: state.day,
        votes: Math.max(votesOnMe, pushedAt),
        heard: Math.max(newest, today?.heard ?? 0)
      };
      const wagonLine = this.answerWagon(state, botId, view, board, votesOnMe);
      const asked = heardOnWagon.find((line) => asksSomething(line.text));

      /**
       * The wagon, by name.
       *
       * "push back at the people voting for you" is a move with no subject, and
       * the only house number anywhere on the mouth's sheet is the seat's own,
       * so the model borrowed it: house 23 opened with "23, you voted? Explain
       * what you actually did", to itself, in front of the whole square.
       *
       * Who is on the wagon is public and already on this projection, so the
       * intent carries the names and the model no longer has to invent one.
       * Three at most: a longer list is a crowd, and the sentence is one line.
       */
      const wagon = view.players
        .filter((player) => player.alive && player.slot !== me.slot && player.votedSlot === me.slot)
        .map((player) => player.name)
        .slice(0, 3);
      const named =
        wagon.length > 1 ? `${wagon.slice(0, -1).join(', ')} and ${wagon[wagon.length - 1]}` : (wagon[0] ?? null);

      const pushBack = named
        ? `push back at ${named}, ${wagon.length > 1 ? 'who are' : 'who is'} voting for you, and demand they say what you actually did`
        : 'push back at the room';
      // A question first gets its answer, and the record is what the answer is made of.
      const record = asked ? this.publicRecord(state, board, me.slot) : [];
      return {
        say: wagonLine,
        intent: {
          act: asked ? `answer ${asked.who}'s question, then ${pushBack}` : pushBack,
          mood: moodOf(mind.brain.personality),
          fallback: wagonLine,
          ...(heardOnWagon.length > 0 ? { answering: heardOnWagon } : {}),
          ...(record.length > 0 ? { record } : {})
        },
        urgent: true,
        targetSlot: ballot.slot,
        skipVote: ballot.skip,
        verdict: null,
        claim: null,
        jailSlot: day.jailSlot,
        revealMayor: day.revealMayor,
        whisper: day.whisper
      };
    }

    /**
     * The reason is computed for the claim that is actually going to be said,
     * not for all of them: `why` walks the whole board, and doing it eight
     * times a turn for sentences nobody will read is work for nothing.
     */
    /**
     * A seat does not stand up for the person it is hanging.
     *
     * The vote and the spoken claim are decided separately, which is right:
     * what you say and where your vote goes are different moves, and a bot
     * asking a question about 4 while voting 7 is a bot playing the game. But
     * "${who} is not the one, take the heat off them" said about the very seat
     * this ballot is against is not a different move, it is a contradiction,
     * and it is the shape the table actually noticed.
     *
     * Dropped rather than reconciled: the vote is the commitment and the
     * sentence is decoration, so the sentence is what gives way.
     */
    const consistent = spoken && spoken.kind === 'clear' && spoken.targetSlot === voting ? null : spoken;

    /**
     * A defence needs a different shelf from an accusation.
     *
     * Both kinds used to be handed `why`, which is entirely a suspicion
     * builder: every rung of it is a reason to distrust somebody. Dropped into
     * "leave {who} alone: {why}" that produces a seat arguing against itself —
     * "Leave 14 alone: the votes are already on them and they have answered
     * none of them" was said at a real table. A reader takes that as a clear
     * with a reason behind it, and the reason is an accusation.
     *
     * So clearing somebody reaches for `whyClear`, which cites the things that
     * actually exonerate: this seat's own clean check, a badge that has already
     * vouched for them, an account nobody has managed to contradict.
     */
    /**
     * The whole case, when there is a whole case, and one reason when there is
     * only one.
     *
     * `why` returns the single strongest thing on the board, which is the right
     * answer for a passing remark and a thin one for the moment a seat commits
     * to a wagon. A room hears "you were on 4's doorstep the night 4 died, and
     * you said you never left, and your badge has gone unchallenged all game"
     * as a case; it hears any one of those three as a hunch. The ranking has
     * known all three all along and nothing could say them together.
     *
     * `caseLine` returns null below two reasons, so this falls back to `why`
     * exactly when there is genuinely only one thing to say — which keeps the
     * thin accusations thin rather than padding them, and padding them is the
     * one failure mode that would make every seat sound like a prosecutor.
     */
    /**
     * A finished sentence, kept separate from a reason that still needs a frame.
     *
     * `caseLine` and `standUpFor` both return a *whole line* — `case.open` is
     * "{who}. {reasons}." and `for.open` is "Leave {who} out of it. {reasons}."
     * — and both were being handed to `sentence` as the `{why}` of a frame that
     * names the seat all over again. What the square actually received was
     *
     *   It is Nami: Nami. Someone saw you visiting 5 on night 3..
     *   Not Nami, Leave Nami out of it. nobody has ever seen them out..
     *
     * the name twice, a capital in the middle, and two full stops. It also blew
     * the line past `SAY_CHARS`, so `clip` then cut it mid-word and added an
     * ellipsis, which is the "Tu as déjà voté…" seen on a real table. One bug
     * wearing three costumes.
     *
     * So the two kinds are two variables. A whole line is said as written; a
     * bare reason goes through the frame that needs one. `why` and `whyClear`
     * are only asked for when there is no whole line, which is also the rule
     * the comment above describes.
     */
    const whole = !consistent
      ? null
      : consistent.kind === 'accuse'
        ? this.caseLine(state, board, consistent.targetSlot, botId)
        : consistent.kind === 'clear'
          ? /**
             * `whyClear` cites this seat's own reasons to trust somebody — a
             * clean check it ran, a badge it believes. `standUpFor` cites the
             * *room's*: nobody has ever put them outside, a voice the room
             * trusts has already cleared them, the record has caught them in
             * nothing. Both are facts; the second set is the one a bystander can
             * offer for a seat it knows nothing about, which is exactly the seat
             * that gets hanged in silence.
             */
            this.standUpFor(state, board, consistent.targetSlot, botId)
          : null;

    const reason =
      whole !== null || !consistent
        ? null
        : consistent.kind === 'accuse'
          ? this.why(state, view, board, consistent.targetSlot, botId)
          : consistent.kind === 'clear'
            ? this.whyClear(view, board, consistent.targetSlot, botId, state)
            : null;

    const drafted = consistent ? this.sentence(state, botId, consistent, reason, whole) : null;

    /**
     * A vote does not need a chorus behind it.
     *
     * Six seats saying "X already called them out, so I am voting X" is six
     * seats saying nothing, one after another, and it was most of what a day
     * phase sounded like. The vote itself is public and lands either way; what
     * the square loses is a wall of agreement that reads as software.
     *
     * One voice starts it and two may second it; after that the square has
     * heard the argument and the rest simply vote. The first seat to name a
     * house is opening a case, which is worth saying however thin its reasons
     * are, and tomorrow the case is new again. It is the fifth repetition of
     * this afternoon that is worth nothing.
     *
     * The other test is whether this seat has anything of its *own* on the target —
     * a check, a contradiction, a verdict from the graveyard — which is the
     * same `hard` half of the case that buys reasonable doubt in the booth.
     * A seat holding a check, a contradiction or a verdict from the graveyard
     * always speaks, however many have spoken before it: that is new evidence
     * rather than another vote said out loud.
     *
     * Silence here also keeps the claim off the board (see `apply`), which is
     * the other half of the same idea: a seat that added nothing to the
     * argument should not be counted as another voice in it.
     */
    const seconds =
      voting === null
        ? 0
        : board.claims.filter(
            (claim) =>
              claim.kind === 'accuse' &&
              claim.targetSlot === voting &&
              claim.claimerSlot !== me.slot &&
              claim.day === state.day
          ).length;
    /**
     * How many voices this particular wagon gets, which is not always the same
     * number. An afternoon where one seat names a house and the room simply
     * votes is as real as one where two others say so too, and a square that
     * always produces exactly three lines per hanging is a square with a
     * quota. Fixed per house per day, so a seat that keeps quiet about it
     * keeps quiet all afternoon.
     *
     * One to three, never nought. `% 3` gave nought a third of the time, and
     * nought voices is not one of the afternoons described above: `seconds` is
     * nought as well when nobody has spoken yet, so the test caught the *first*
     * seat to name the house and the wagon then formed in complete silence.
     * Which is the single thing this file works hardest to prevent everywhere
     * else, and it was happening to a third of the hangings in the game: the
     * tally moved, nobody said why, and the claim never reached the board
     * either, because a line refused here files nothing. See `apply`.
     */
    const allowed = voting === null ? 0 : 1 + (hashCode(state.code + ':echo:' + state.day + ':' + voting) % 3);
    const following =
      seconds >= allowed &&
      consistent?.kind === 'accuse' &&
      consistent.targetSlot === voting &&
      suspicionParts(consistent.targetSlot, self, board, rng).hard < 1;
    const line = following ? null : drafted;
    /**
     * Nothing to claim, so say something the room already knows.
     *
     * A turn with no line is a seat that read the dawn report and had no
     * reaction to it, which is the least human thing at the table. The remark
     * is a public fact with one join — a claim and a corpse, a ballot and a
     * role — and it files no claim, so it costs only a filler slot.
     */
    const remark = line === null && task === 'day' ? this.remark(state, botId, board) : null;

    /** The ballot, named, so the mouth can be told and its line checked. */
    const votedName =
      voting === null ? null : (Object.values(state.players).find((player) => player.slot === voting)?.name ?? null);
    // By name, for the same reason `actOf` names houses that way.
    const votedLabel = voting === null ? null : (votedName ?? String(voting));

    /**
     * Somebody asks the room for something before the day is thrown away.
     *
     * A skip is the town spending an afternoon and a night on nothing, and it
     * used to happen in near silence: the tally slid across to "hang nobody"
     * and the first anyone knew of it was the dawn report. A person at a real
     * table does not do that quietly — they ask. Any badge that has been out at
     * night has something, and the ones with nothing lose nothing by saying so.
     *
     * Once per afternoon, by the first seat that gets there, and it does not
     * change the vote: this seat still skips. It is a question with a ballot
     * behind it rather than a delay, and if somebody answers it, the ear files
     * what they said and the room re-reads the board before the day ends.
     */
    const lastCall = ballot.skip && this.deps.callForClues(state.code, state.day, botId);

    // Into the journal, so the will says tomorrow what the seat said today.
    if (voting !== null && !mind.notes.some((note) => note.day === state.day && note.slot === voting)) {
      mind.notes.push({ day: state.day, slot: voting, kind: contradicted(voting, board) ? 'liar' : 'evil' });
    }

    if (lastCall) {
      const plea = say(spokenLocale(state))(vary('mafia.bot.skip.lastCall', 4, botId + ':skip:' + state.day));
      return {
        say: plea,
        intent: {
          act: 'ask the room, one last time, whether anybody has anything at all before the day is thrown away',
          mood: moodOf(mind.brain.personality),
          fallback: plea,
          ...(task === 'react' ? { answering: this.answering(state, botId, 'day') } : {})
        },
        urgent: true,
        targetSlot: ballot.slot,
        skipVote: ballot.skip,
        verdict: null,
        claim: null,
        jailSlot: day.jailSlot,
        revealMayor: day.revealMayor,
        whisper: day.whisper
      };
    }

    // A reaction exists because a person said something; this is it, and a question in it is answered from the record.
    const reacting = task === 'react' ? this.answering(state, botId, 'day') : [];
    const askedMe = reacting.some((heard) => asksSomething(heard.text));
    return {
      say: line ?? remark,
      intent:
        consistent && line
          ? {
              act: this.actOf(state, consistent),
              ...(reason ? { because: say('en')(reason) } : {}),
              mood: moodOf(mind.brain.personality),
              fallback: line,
              ...(reacting.length > 0 ? { answering: reacting } : {}),
              ...(askedMe ? { record: this.publicRecord(state, board, me.slot) } : {}),
              ...(votedLabel && voting !== null ? { vote: { slot: voting, label: votedLabel } } : {})
            }
          : undefined,
      // A dying seat asking for a doctor is the one line that cannot wait for
      // the floor: tomorrow it is a dawn report.
      urgent: consistent?.kind === 'ailing' || (consistent?.kind === 'accuse' && voting !== null),
      targetSlot: ballot.slot,
      skipVote: ballot.skip,
      verdict: null,
      claim:
        consistent && line
          ? {
              kind: consistent.kind,
              slot: consistent.targetSlot,
              role: consistent.claimedRole ?? null,
              ...(consistent.account ? { account: consistent.account } : {}),
              ...(consistent.ailment ? { ailment: consistent.ailment } : {}),
              // A night's work stays one on the board, house and all.
              ...(consistent.worked ? { worked: true } : {}),
              ...(consistent.from ? { from: consistent.from } : {}),
              ...(consistent.at !== undefined ? { at: consistent.at } : {}),
              ...(consistent.night !== undefined ? { night: consistent.night } : {}),
              ...(consistent.deniedRole ? { deniedRole: consistent.deniedRole } : {}),
              ...(consistent.urge ? { urge: consistent.urge } : {}),
              ...(consistent.promise ? { promise: consistent.promise } : {}),
              ...(consistent.relayedFrom !== undefined ? { relayedFrom: consistent.relayedFrom } : {})
            }
          : null,
      jailSlot: day.jailSlot,
      revealMayor: day.revealMayor,
      whisper: day.whisper
    };
  }

  /**
   * Whose words this turn is answering, if anybody's.
   *
   * People only, and recent ones: a bot's line is a phrasebook entry or a
   * paraphrase of a claim the board already holds, so answering one is
   * answering ourselves in a circle. Lines that named this seat come first,
   * because being addressed is the thing most worth replying to; failing that,
   * the last thing anybody said in the room, which is what a person joining a
   * conversation would respond to.
   *
   * Clipped, because this goes into a prompt and a person can paste anything.
   */
  /**
   * Who a line sounds like to this seat, which is not always who said it.
   *
   * The model is handed the raw log, and the raw log carries every byline. The
   * phone projects each line through `chatLineFor` first, so a prisoner sees a
   * voice with no face; the bot in the same cell was being handed the keeper's
   * name at the top of its prompt and read it straight back into the room. On
   * a real table a Ravisseur said "Hello" and the captive answered "La B1te?",
   * which is the keeper's nickname and the one thing that room exists to hide.
   *
   * Faceless comes back as a description rather than `ANONYMOUS`: a row of dots
   * is a name the model will try to pronounce.
   */
  heardAs(state: MafiaState, botId: string, message: ChatMessage): { name: string; slot: number } {
    const seen = chatLineFor(state, botId, message);
    if (!seen.authorId) {
      return { name: message.channel.startsWith('jail:') ? 'The voice in the cell' : 'Someone', slot: 0 };
    }
    return { name: seen.authorName, slot: state.players[seen.authorId]?.slot ?? 0 };
  }

  answering(state: MafiaState, botId: string, room: string): { who: string; text: string }[] {
    return this.saidTo(state, botId, room).map((message) => this.quoted(state, botId, message));
  }

  /** The lines `answering` quotes, as the chat holds them. */
  private saidTo(state: MafiaState, botId: string, room: string): ChatMessage[] {
    const self = state.players[botId];
    if (!self) return [];

    /**
     * Only what was said today, which nothing here was checking.
     *
     * This scanned the whole game's chat and then *preferred* the lines that
     * named this seat, so the older a mention was the longer it survived: a
     * seat nobody had spoken to since day one was still being handed day one's
     * sentence on day six. The intent built from it says "answer THEM", and
     * `MOUTH_RULES` says to answer the words given and not an easier version of
     * them, so the model did exactly as it was told and replied, in earnest, to
     * a question five days dead. To the room that is a bot talking to itself
     * about something nobody remembers.
     *
     * The window is the day or night this turn belongs to. `phaseStartedAt` is
     * stamped at `beginDay` and `beginNight` and deliberately not at a stage
     * change, so a trial and the argument that led to it are one window, which
     * is what "answering somebody" means. Falls back to the phase clock for
     * tables persisted before the field existed, the same way `hearPrivately`
     * does.
     *
     * This is the same rule `readRoom` already states: yesterday's argument was
     * settled by yesterday's corpse.
     */
    const since = phaseWindow(state);

    const lines = state.chat.messages.filter(
      (message) =>
        message.channel === room &&
        message.at >= since &&
        !!message.authorId &&
        message.authorId !== botId &&
        state.players[message.authorId]?.isBot === false &&
        message.text.trim().length > 0
    );
    if (lines.length === 0) return [];

    /**
     * Only the lines that were said *to* this seat, which is not every line.
     *
     * This used to fall back to the last two things any person said whenever
     * nothing had named this seat, and the mouth was then told they had been
     * said "to you or about you". So every seat that spoke after a person
     * replied to that person: on `9RVWV` a player wrote "I got converted to
     * citizen" and the Mason Leader, busy arguing with somebody else, answered
     * "Citizenship's a nice start, Max"; a question put to the seat on the
     * stand was answered forty seconds later by the next seat on it, "Max, I
     * didn't jail anyone", to which the only possible reply was "I never asked
     * you anything". Ten lines like that in one game, in seven games of ten.
     *
     * A room with two people in it is the exception, and the team rooms with
     * it: a cell, a whisper, a lodge or a family is a room where everything said
     * is said to whoever is listening. In the square a line is this seat's when
     * it names the seat (fuzzily, so "Aragon" still reaches Aragorn), when it
     * was typed at this seat's own trial and names nobody, or when it names
     * nobody and comes straight after this seat's own line, which is what a
     * reply is. Everything else is the room's, and the room's lines are context.
     */
    if (room === 'day') {
      const seats = Object.values(state.players).map((player) => ({ slot: player.slot, name: player.name }));
      const trial = state.trial?.accusedId === botId ? state.trial : null;
      const square = state.chat.messages.filter((message) => message.channel === room && !!message.authorId);
      const addressed = (message: ChatMessage): boolean => {
        const hits = seatHits(message.text, seats).filter(
          (hit) => hit.slot !== state.players[message.authorId ?? '']?.slot
        );
        if (hits.some((hit) => hit.slot === self.slot)) return true;
        if (hits.length > 0) return false;
        if (trial && message.at >= (trial.openedAt ?? since)) return true;
        const before = square.filter((other) => other.id < message.id && other.authorId !== message.authorId);
        const previous = before[before.length - 1];
        return previous?.authorId === botId && message.at - previous.at <= REPLY_GAP_MS;
      };
      return lines.filter(addressed).slice(-2);
    }
    return lines.slice(-2);
  }

  /**
   * What this seat has already said about itself in front of the whole room.
   *
   * The material a question to it can be answered from without inventing
   * anything: its badge, if it has named one, and the nights it has accounted
   * for. All of it public, so handing it to the mouth leaks nothing, and all of
   * it already said, so repeating it cannot contradict the seat.
   */
  publicRecord(state: MafiaState, board: PublicInfo, slot: number): string[] {
    const nameOf = (house: number): string => nameAt(state, house);
    const mine = board.claims.filter((claim) => claim.claimerSlot === slot);
    const lines: string[] = [];
    const badge = [...mine].reverse().find((claim) => claim.kind === 'role-claim' && claim.claimedRole)?.claimedRole;
    lines.push(
      badge
        ? `You have said in public that you are the ${say('en')(ROLE.name(badge))}.`
        : 'You have not said what your role is.'
    );
    for (const claim of mine) {
      if (claim.kind !== 'account') continue;
      const night = claim.night ?? Math.max(1, claim.day - 1);
      lines.push(
        claim.account === 'home'
          ? `Night ${night}: you said you stayed home.`
          : `Night ${night}: you said you went to ${nameOf(claim.targetSlot)}.`
      );
    }
    return lines.slice(0, 5);
  }

  /**
   * Whether a seat asked its role outside the stand says it, and what it says.
   *
   * The stand was the only place a bot ever named its badge, so "what's your
   * role?" asked in the square or in a whisper got a shrug every single time,
   * which is not how a table plays: people do answer, now and then, and some of
   * them lie. The odds are `ROLE_ANSWER`'s, and then who is asking moves them:
   * a seat keeps its badge from somebody voting it or accusing it, tells it more
   * readily to somebody who vouched for it, and leans on how far it trusts the
   * asker, publicly (`trustOf`) and from what that voice has been worth in
   * private (`BotMind.privateTrust`).
   *
   * Town tells the truth (its dealt badge, the one its record is made of);
   * everybody else answers with the mask it would wear on the stand, pinned the
   * same way, so the story it tells here is the story it tells there. Stable per
   * question: the same line asked again, on the same day, is the same roll.
   */
  private roleAnswer(
    state: MafiaState,
    botId: string,
    mind: BotMind,
    board: PublicInfo,
    told: ChatMessage[],
    where: { privately: boolean; votesOnMe: number }
  ): RoleId | null {
    const self = state.players[botId];
    const asked = [...told].reverse().find((message) => asksRole(message.text));
    const asker = asked?.authorId ? state.players[asked.authorId] : null;
    if (!self?.role || !asked || !asker) return null;
    // Said already in the square: the record answers it (see `publicRecord`).
    if (
      !where.privately &&
      board.claims.some((claim) => claim.kind === 'role-claim' && claim.claimerSlot === self.slot)
    ) {
      return null;
    }

    const said = (kind: ClaimKind): boolean =>
      board.claims.some(
        (claim) =>
          claim.kind === kind &&
          claim.claimerSlot === asker.slot &&
          claim.targetSlot === self.slot &&
          claim.day >= state.day - 1
      );
    const hostile = state.votes[asker.playerId] === botId || said('accuse');
    const regard = trustOf(asker.slot, board) + (mind.privateTrust.get(asker.slot) ?? 0);
    const trust =
      (hostile ? ROLE_ANSWER.hostile : 1) *
      (said('clear') ? ROLE_ANSWER.friendly : 1) *
      Math.min(ROLE_ANSWER.regardCeiling, Math.max(ROLE_ANSWER.regardFloor, 1 + ROLE_ANSWER.perRegard * regard));
    const base = where.privately
      ? ROLE_ANSWER.whisper
      : ROLE_ANSWER.square + (where.votesOnMe >= ROLE_ANSWER.pressedAt ? ROLE_ANSWER.pressed : 0);
    const odds = Math.min(ROLE_ANSWER.cap, base * trust);
    if (seededRoll(botId + ':asked:' + state.day + ':' + asked.text) >= odds) return null;

    const town = ROLES[self.role].faction === 'town';
    const initiated = self.role === 'mason' && self.roleBefore ? self.roleBefore : null;
    return town ? (initiated ?? self.role) : this.maskOf(state, botId, mind);
  }

  /** A person's line as a model is shown it: through the seat's own eyes, screened and clipped. */
  private quoted(state: MafiaState, botId: string, message: ChatMessage): { who: string; text: string } {
    return {
      who: this.heardAs(state, botId, message).name,
      // Quoted back to a model, so screened; the room still sees the original.
      text: clip(screen(message.text).text.replace(/\s+/g, ' ').trim(), 160)
    };
  }

  /**
   * The one thing a crier can honestly shout into the dark: the record.
   *
   * The role has no night action, so it has no finding — but a town crier
   * announces public news, and this table generates public news nobody is
   * keeping track of. Three seats claiming the same badge, a seat that has not
   * opened its mouth since day one, a run of quiet nights, the running tally of
   * what the rope has actually caught: all of it is on the screens already and
   * all of it is routinely lost in a chat sixty lines long.
   *
   * Every line here is checkable by anybody who scrolls up, which is the whole
   * difference between this and the suspect it used to name. It asserts nothing
   * the board does not hold, it claims no source, and a player who disagrees
   * can go and count. That is a real service and an honest one, and it is the
   * role doing its own job rather than borrowing an investigator's.
   *
   * Returns null when there is genuinely no news, and the caller tells a joke.
   */
  private crierNews(state: MafiaState, board: PublicInfo): Msg | null {
    const salt = state.code + ':crier:' + state.day;
    const nameOf = (slot: number): string =>
      Object.values(state.players).find((player) => player.slot === slot)?.name ?? String(slot);

    /**
     * A badge two living seats are both wearing, which is a liar in the room.
     *
     * Living only, and for the reason the spoken reasons had to learn: a rival
     * the graveyard already settled is not a contest, it is a closed question.
     */
    const byRole = new Map<RoleId, Set<number>>();
    for (const claim of board.claims) {
      if (claim.kind !== 'role-claim' || !claim.claimedRole) continue;
      if (!board.aliveSlots.includes(claim.claimerSlot)) continue;
      const seats = byRole.get(claim.claimedRole) ?? new Set<number>();
      seats.add(claim.claimerSlot);
      byRole.set(claim.claimedRole, seats);
    }
    for (const [role, seats] of byRole) {
      if (seats.size >= 2) {
        return vary('mafia.bot.crier.news.contested', 2, salt, { role: ROLE.name(role), count: seats.size });
      }
    }

    /**
     * What the rope has actually been catching, which is the number that
     * decides whether a town should keep pulling it and the number nobody adds
     * up. Straight off the revealed graveyard.
     *
     * On the cause, not on the phase. A day death is not the same thing as a
     * hanging: a seat dropped mid-day and a lover dying of grief at the foot of
     * the gallows are both filed under `day`, so counting the phase made one
     * rope worth two and handed the crier a number a listener can check and
     * find wrong, which is worse than not saying it.
     */
    const hanged = state.deaths.filter((death) => death.phase === 'day' && death.cause.k === 'mafia.cause.lynched');
    /**
     * Off the public graveyard, never off the seat's own role.
     *
     * `deadRoles` is what the table was *told*, and it is deliberately empty for
     * a corpse the game agreed to say nothing about: a janitor-cleaned body on
     * any table, and every body on one set to `revealOnDeath: 'none'`. Read off
     * `state.players` instead, the crier announced how many of the hanged had
     * been town on a table that had been told nothing about any of them — which
     * is not a tally, it is the one thing this role is built not to do.
     *
     * So the line is said only when every rope is accounted for publicly.
     * "{count} hanged, {town} of them ours" asserts the other {count}-{town}
     * were not, and a single unknown corpse makes that a lie rather than a
     * gap.
     */
    const camps = hanged.map((death) => {
      const slot = state.players[death.playerId]?.slot;
      const shown = slot === undefined ? undefined : board.deadRoles.get(slot);
      return shown === undefined ? null : ROLES[shown].faction;
    });
    if (hanged.length >= 2 && camps.every((camp) => camp !== null)) {
      const town = camps.filter((camp) => camp === 'town').length;
      return vary('mafia.bot.crier.news.toll', 2, salt, { count: hanged.length, town });
    }

    // A run of nights with nobody in the morning cart, which changes what the
    // room should believe about how many blades are still out there.
    if (board.day >= 3 && board.lastNightDeathSlots.size === 0 && board.nightDeathsTotal < board.day - 1) {
      return vary('mafia.bot.crier.news.quiet', 2, salt, {});
    }

    // And a seat that has not said one word, which `why.silent` already checks
    // the same way and which the room stops noticing after day three.
    if (board.day >= 3) {
      const mute = board.aliveSlots.filter((slot) => !board.claims.some((claim) => claim.claimerSlot === slot));
      const one = mute[Math.floor(hashCode(salt) % Math.max(1, mute.length))];
      if (one !== undefined) return vary('mafia.bot.crier.news.silent', 2, salt, { who: nameOf(one) });
    }

    return null;
  }

  /**
   * A claim, said out loud in the table's own language.
   *
   * Keys rather than sentences, and the key is chosen by the *kind* of claim, so
   * a bot arguing at an English table argues in English while the same seat at a
   * French one does not.
   *
   * Two things that used to be wrong here. Every kind had exactly one phrasing,
   * so eleven seats asking about the night produced eleven identical sentences —
   * a wall of copy-paste that reads as broken software rather than as a room.
   * And every one of them addressed a *house*: "House 16, where were you?", when
   * the roster and now the chat both put the number right beside the name, so
   * the prefix was pure ceremony. A seat says "16" or it says "Hylith"; which of
   * the two is fixed per speaker per target, because somebody who calls you by
   * your number does it every time.
   */
  private sentence(
    state: MafiaState,
    botId: string,
    claim: Claim,
    reason: Msg | null = null,
    /** A line that already frames and names itself; see the note at the call site. */
    whole: Msg | null = null
  ): string | null {
    const t = say(spokenLocale(state));

    /** How this seat addresses that one: by name, or by number. Consistently. */
    const who = (slot: number): string => {
      const name = Object.values(state.players).find((player) => player.slot === slot)?.name;
      return name && hashCode(botId + '>' + slot) % 2 === 0 ? name : String(slot);
    };
    /**
     * Which phrasing, out of `variants`. Stable per seat, day and subject.
     *
     * Takes the whole key so `vary` can check it; the salt is still made of the
     * short kind, as it always was, so every seat keeps the phrasing it had.
     */
    const line = <P extends string, N extends number>(
      key: VariantPrefix<P, N>,
      variants: N,
      params?: Record<string, string | number | Msg>
    ) => {
      const kind = key.slice('mafia.bot.'.length);
      return t(vary(key, variants, botId + ':' + kind + ':' + state.day + ':' + claim.targetSlot, params));
    };

    // A finished line is said as written: framing it again is what produced
    // "It is Nami: Nami. …". See `whole`.
    if (whole) return t(whole);

    switch (claim.kind) {
      case 'accuse': {
        // The bet before the argument: a finding that names a role or a camp
        // outright is worth the speaker's neck, and sometimes it is staked.
        const staked = this.stake(state, botId, claim.targetSlot, who(claim.targetSlot));
        if (staked) return t(staked);
        /**
         * With a reason it is an argument. Without one it is a read, and it
         * now says so.
         *
         * `accuse` holds nine ways of naming a house and only one of them
         * ("Nothing hard, just a read") admits there is nothing behind it, so
         * eight times in nine a vote cast on a hunch was posted in the same
         * flat voice as a vote cast on a corpse's will. A player cannot tell
         * those apart, and being unable to tell them apart is exactly the
         * complaint: the room looks like it knows something it is not saying.
         *
         * So the two cases are two different sentences. Everything the board
         * can name goes through `why` and comes out as an argument somebody
         * can answer; what the board cannot name is admitted as a read, which
         * is the honest thing to call it and is itself information.
         */
        return reason
          ? line('mafia.bot.accuseWhy', 9, { who: who(claim.targetSlot), why: reason })
          : line('mafia.bot.accuseRead', 6, { who: who(claim.targetSlot) });
      }
      case 'clear':
        return reason
          ? line('mafia.bot.clearWhy', 6, { who: who(claim.targetSlot), why: reason })
          : line('mafia.bot.clear', 9, { who: who(claim.targetSlot) });
      case 'kill-claim':
        /**
         * Naming the night as well as the house, because the night is the half
         * the room checks. "I shot 7" is a boast; "I shot 7 on night 3" is a
         * line the dawn report either backs or buries them for.
         */
        return line('mafia.bot.killClaim', 6, {
          who: who(claim.targetSlot),
          night: claim.night ?? Math.max(1, claim.day - 1)
        });
      case 'role-claim':
        return claim.claimedRole ? line('mafia.bot.roleClaim', 6, { role: ROLE.name(claim.claimedRole) }) : null;
      case 'account':
        return claim.account === 'home'
          ? line('mafia.bot.stayedHome', 9)
          : line('mafia.bot.visited', 9, { who: who(claim.targetSlot) });
      case 'question':
        return line('mafia.bot.question', 9, { who: who(claim.targetSlot) });
      /**
       * The seat that was seen going out, and where it went when that is known.
       *
       * `targetSlot` is the visitor everywhere a sighting is filed, and the
       * phrasebook read it as the house: "Somebody visited 14" was a Detective
       * reporting that 14, the Godfather, had walked into the house that died.
       */
      case 'sighting':
        return claim.at !== undefined && claim.at !== claim.targetSlot
          ? line('mafia.bot.sightingAt', 6, { who: who(claim.targetSlot), where: who(claim.at) })
          : line('mafia.bot.sighting', 9, { who: who(claim.targetSlot) });
      case 'taunt':
        return line('mafia.bot.taunt', 9, { who: who(claim.targetSlot) });
      case 'hint':
        return line('mafia.bot.hint', 6, { who: who(claim.targetSlot) });
      /**
       * The five kinds that talk about the room rather than the night.
       *
       * These returned null for as long as the policy did not produce them, and
       * kept returning null once it did. That was worse than silence about one
       * claim: the pick in `decide` ranks a counter-claim above a role claim and
       * a promise above everything, so a seat holding "I am the Jailor, not him"
       * picked the counter-claim, got no sentence, and said nothing at all. A
       * real table watched a fake Jailor go uncontested for two days that way,
       * with the real one drafting the answer every turn.
       *
       * Null now only means the claim is missing the one field it is made of.
       */
      case 'counter-claim': {
        if (!claim.deniedRole) return null;
        const role = ROLE.name(claim.deniedRole);
        return this.wearsBadge(state, botId, claim.deniedRole)
          ? line('mafia.bot.counterClaim', 4, { who: who(claim.targetSlot), role })
          : line('mafia.bot.counterClaimSeen', 3, { who: who(claim.targetSlot), role });
      }
      case 'demand':
        return line('mafia.bot.demand', 3, { who: who(claim.targetSlot) });
      case 'urge':
        if (claim.urge === 'vote') return line('mafia.bot.urgeVote', 3);
        if (claim.urge === 'skip') return line('mafia.bot.urgeSkip', 3);
        return null;
      case 'promise':
        if (claim.promise === 'night') return line('mafia.bot.promiseNight', 3);
        if (claim.promise === 'now') return line('mafia.bot.promiseNow', 2);
        return null;
      case 'relay': {
        const was = this.relayed(state, claim);
        if (was === null || claim.relayedFrom === undefined) return null;
        const params = { who: who(claim.targetSlot), from: who(claim.relayedFrom) };
        return was === 'accuse' ? line('mafia.bot.relayAccuse', 3, params) : line('mafia.bot.relayClear', 2, params);
      }
      case 'ailing':
        /**
         * Five different reports with five different jobs: one asks for a
         * doctor, one warns the room that somebody is walking around with a
         * match, two say a killer picked this house and failed, and one
         * explains a silence the room was about to hang somebody for.
         */
        switch (claim.ailment) {
          case 'douse':
            return line('mafia.bot.doused', 6);
          case 'healed':
            return line('mafia.bot.healed', 6);
          case 'guarded':
            return line('mafia.bot.guarded', 6);
          case 'survived':
            return line('mafia.bot.survived', 6);
          case 'silenced':
            return line('mafia.bot.silenced', 6);
          case 'blocked':
            return line('mafia.bot.blocked', 6);
          case 'controlled':
            return line('mafia.bot.controlled', 6);
          case 'bussed':
            return line('mafia.bot.bussed', 6);
          case 'jailed':
            return line('mafia.bot.jailed', 6);
          default:
            return line('mafia.bot.poisoned', 6);
        }
    }
  }

  /**
   * One claim, described rather than phrased.
   *
   * The mouth is given this instead of a sentence, so it writes its own — and it
   * names the house *and* the name, because a model handed only a number
   * sometimes decides the number is a quantity.
   *
   * **Nothing here refers to the room it is said in.** Every branch used to open
   * "tell the square you were …", and a small model copies the shape it is
   * handed — which is documented two comments down for house numbers and was
   * happening here too, one layer up. A real game produced "my square got
   * roleblocked", which is not a sentence anybody can act on, and the seat that
   * said it had in fact been roleblocked and never managed to say so.
   *
   * So these are purposes, not speech acts: what this seat wants the others to
   * know, phrased so that a model which copies it word for word still emits
   * something a player could have typed.
   */
  private actOf(state: MafiaState, claim: Claim): string {
    /**
     * How a house is named to the mouth: by the name on its door.
     *
     * This used to render "house 11 (Magneto)", and a small model copies the
     * shape it is handed, so the square filled up with "House 11 is lying" —
     * a label nobody at a table says out loud, printed in front of a number the
     * chat already puts beside every line. The name alone, and the bare number
     * only for a seat that somehow has none.
     */
    const who = (slot: number): string =>
      Object.values(state.players).find((player) => player.slot === slot)?.name ?? String(slot);
    /**
     * What a night's work is called out loud, so the mouth cannot lose it.
     *
     * "accuse Arceus and vote for them, because my night 8 check came back
     * Mafia" came back as "Arceus, your night 8 was a lie": the model kept the
     * night, dropped the check, and the town heard a hunch where a Sheriff had
     * a result. The act now says it is a report, and of what.
     */
    const INSTRUMENT: Partial<Record<string, string>> = {
      sheriff: 'Sheriff check',
      role: 'check of their role',
      trade: 'investigation',
      tracked: 'tail',
      visitors: 'watch',
      spied: 'night of listening',
      blocked: 'block'
    };
    const instrument = claim.worked && claim.from ? INSTRUMENT[claim.from] : undefined;
    switch (claim.kind) {
      case 'accuse':
        return instrument
          ? `report the result of your own ${instrument} on ${who(claim.targetSlot)} plainly, naming the night and what it found, and vote for them`
          : `accuse ${who(claim.targetSlot)} and vote for them`;
      case 'clear':
        return instrument
          ? `report the result of your own ${instrument} on ${who(claim.targetSlot)} plainly, naming the night and what it found, and take the heat off them`
          : `say ${who(claim.targetSlot)} is not the one, and take the heat off them`;
      case 'kill-claim':
        // The night is not decoration: it is the half the dawn report settles.
        return `tell the town you killed ${who(claim.targetSlot)} on night ${claim.night ?? Math.max(1, claim.day - 1)}, as the ${claim.claimedRole ?? 'role you hold'}, and that the morning report backs you`;
      case 'role-claim':
        return `claim the ${claim.claimedRole ?? 'role you claimed'} out loud, as your own role`;
      case 'account':
        return claim.account === 'home'
          ? 'say you never left your house last night'
          : `admit you went to ${who(claim.targetSlot)} last night`;
      case 'question':
        return `ask ${who(claim.targetSlot)} where they were last night`;
      case 'sighting': {
        /**
         * The seat on the claim is the one who was out, and `at` is where.
         *
         * This read the other way round, "somebody go into X's house", so a
         * Detective whose phrasebook line said "Donald Duck was on 11's doorstep"
         * was asked by its own intent to say that somebody had visited Donald
         * Duck, which is a different accusation about a different house.
         */
        const night = claim.night ?? Math.max(1, claim.day - 1);
        return claim.at !== undefined
          ? `say you saw ${who(claim.targetSlot)} at ${who(claim.at)}'s house on night ${night}`
          : `say you saw ${who(claim.targetSlot)} out of their house on night ${night}`;
      }
      case 'taunt':
        return `needle ${who(claim.targetSlot)} about how quiet they have been`;
      case 'hint':
        return `say you are not sure about ${who(claim.targetSlot)} yet`;
      case 'counter-claim': {
        const role = claim.deniedRole ? say('en')(ROLE.name(claim.deniedRole)) : 'that role';
        const speaker = Object.values(state.players).find((player) => player.slot === claim.claimerSlot)?.playerId;
        return claim.deniedRole && speaker && this.wearsBadge(state, speaker, claim.deniedRole)
          ? `say ${who(claim.targetSlot)} is not the ${role}, because you are the ${role}, and one of you is lying`
          : `say ${who(claim.targetSlot)} is not the ${role}: somebody else already claimed it and there is only one`;
      }
      case 'demand':
        return `ask ${who(claim.targetSlot)}, who is voting for you, what they actually have on you`;
      case 'urge':
        return claim.urge === 'skip'
          ? 'tell the room nothing on the board today is worth hanging somebody for'
          : 'tell the room it has to hang somebody today rather than skip';
      case 'promise':
        return claim.promise === 'now'
          ? 'ask the room not to hang you, because you can prove what you are right now'
          : 'ask the room to leave you alive tonight, because tomorrow morning will prove you';
      case 'relay': {
        const was = this.relayed(state, claim);
        const from = claim.relayedFrom !== undefined ? who(claim.relayedFrom) : 'somebody';
        return was === 'clear'
          ? `remind the room that ${from} vouched for ${who(claim.targetSlot)}`
          : `remind the room that ${from} named ${who(claim.targetSlot)} as a suspect`;
      }
      case 'ailing':
        switch (claim.ailment) {
          case 'douse':
            return 'warn everyone the arsonist doused your house last night and is still walking around with a match';
          case 'healed':
            return 'report that a doctor healed you last night, which means somebody came to kill you and a doctor is alive';
          case 'guarded':
            return 'report that a bodyguard died in your doorway last night, taking the knife meant for you';
          case 'survived':
            return 'report that somebody came for you last night and you are still here';
          case 'silenced':
            return 'explain that you were blackmailed and could not say a word yesterday, which is why you were quiet';
          case 'blocked':
            return 'explain that you were roleblocked last night, so you have no result to give';
          case 'controlled':
            return 'report that a witch controlled you last night and sent you somewhere you did not choose';
          case 'bussed':
            return 'explain that you were transported last night, so anything aimed at you landed somewhere else';
          case 'jailed':
            return 'explain that the jailor had you in the cell last night, so you did nothing and he can confirm it';
          default:
            return 'say you were poisoned last night and ask the doctor to heal you tonight, or you die at dawn';
        }
    }
  }

  /**
   * Why this seat thinks what it thinks about that one, as half a sentence.
   *
   * The point of the whole exercise. A square where eleven bots say "17. That
   * is my vote." is not a game with talking in it — it is a tally read aloud.
   * What makes a day phase worth reading is that an accusation *cites* something
   * the room can check, argue with, confirm or deny: an account that does not
   * survive a sighting, a check somebody made on night two, a role two people
   * are both claiming.
   *
   * Everything here comes from the public board or this seat's own night work,
   * in that order of strength, so the reason a bot gives is a reason it actually
   * has — and a reason another seat can contradict, because it names a night and
   * a house rather than a feeling. A liar reaches for exactly the same shelf,
   * which is what makes lying worth anything.
   *
   * Null when there is genuinely nothing: better a bare accusation than an
   * invented justification, which is the one thing the board can never recover
   * from.
   */
  /**
   * One deduction, said the way a player would say it.
   *
   * Every line here names the night and the thing that does not add up, so the
   * seat it is aimed at can answer it and the room can check it. That is the
   * difference between an accusation and an insult, and it is the reason this
   * rung sits above the ones built on somebody's word.
   */
  private caughtOut(found: Deduction, nameOf: (slot: number) => string, botId: string, targetSlot: number): Msg | null {
    const seed = botId + ':d:' + targetSlot;
    switch (found.kind) {
      case 'poison-survived':
        return vary('mafia.bot.why.poisonSurvived', 3, seed, { night: found.night });
      case 'visited-a-corpse':
        return vary('mafia.bot.why.visitedCorpse', 3, seed, { night: found.night, who: nameOf(found.otherSlot) });
      case 'sighted-at-a-corpse':
        return vary('mafia.bot.why.sawCorpseVisited', 3, seed, {
          night: found.night,
          who: nameOf(found.otherSlot),
          seen: nameOf(found.seenSlot)
        });
      // The badge is half the sentence here: the visit is only damning because
      // of what they said they were when they made it.
      case 'visited-the-living':
        return vary('mafia.bot.why.visitedTheLiving', 3, seed, {
          night: found.night,
          who: nameOf(found.otherSlot),
          role: ROLE.name(found.role)
        });
      case 'guarded-nobody-died':
        return vary('mafia.bot.why.guardedNoDeath', 3, seed, { night: found.night });
      case 'two-in-one-cell':
        return vary('mafia.bot.why.twoInCell', 3, seed, { night: found.night, who: nameOf(found.otherSlot) });
      case 'acted-from-the-cell':
        return vary('mafia.bot.why.actedFromCell', 3, seed, { night: found.night });
      case 'impossible-ailment':
        /**
         * Naming what they claimed, which the line used to leave out.
         *
         * "nobody alive has the role that could have done that to them" makes
         * the reader hold a pronoun with nothing behind it while they try to
         * remember which claim is being answered. The deduction has carried the
         * ailment since the day it was written.
         */
        return vary('mafia.bot.why.impossibleAilment', 3, seed, { what: msg(`mafia.ailment.${found.ailment}`) });
      case 'role-not-in-play':
        return vary('mafia.bot.why.roleNotInPlay', 3, seed, { role: ROLE.name(found.role) });
      case 'no-slot-left':
        return vary('mafia.bot.why.noSlotLeft', 3, seed, { role: ROLE.name(found.role) });
      case 'no-room-for-all':
        /**
         * The group finding, said as a group.
         *
         * Naming the other claimants is the whole sentence: "one of you is
         * lying" without saying who is a bot thinking out loud, and "you and 7
         * both claim Doctor and the list has room for one" is an argument the
         * room can finish by itself.
         */
        return vary('mafia.bot.why.noRoomForAll', 3, seed, {
          role: ROLE.name(found.role),
          who: found.others.map(nameOf).join(', ')
        });
      case 'relay-denied':
        return vary('mafia.bot.why.relayDenied', 3, seed, { who: nameOf(found.otherSlot) });
      case 'broken-promise':
        return vary('mafia.bot.why.brokenPromise', 3, seed, {});
      default:
        return null;
    }
  }

  /**
   * The case against this seat, and the material it has to answer it with.
   *
   * Written for the seat *on the stand*, which is the one reader that needs
   * both halves. `why()` answers "why do I think that about them" and is aimed
   * outward; this is aimed inward, and the difference matters because a defence
   * that does not know what it is accused of is not a defence, it is a
   * protestation.
   *
   * Everything in it is already on the board or in this seat's own notebook,
   * which is the rule the whole mouth is built on: the model is handed facts it
   * could have been handed by a phrasebook and asked to arrange them, never
   * asked to supply any. A seat with nothing to say still has nothing to say,
   * and the fallback line covers that.
   */
  private caseAgainst(
    state: MafiaState,
    view: MafiaView,
    board: PublicInfo,
    slot: number,
    botId: string
  ): string | null {
    const me = view.me;
    if (!me) return null;
    const nameOf = (target: number): string =>
      Object.values(state.players).find((player) => player.slot === target)?.name ?? String(target);

    const parts: string[] = [];

    /**
     * The strongest single thing the record holds, said the way the room would
     * say it. Reusing `why` on this seat is exactly right: it is the sentence
     * an accuser would use, which is the sentence that has to be answered.
     */
    const worst = this.why(state, view, board, slot, botId);
    if (worst) parts.push(`what the room is saying about you: ${say('en')(worst)}`);

    const accusers = board.claims
      .filter(
        (claim) => claim.kind === 'accuse' && claim.targetSlot === slot && board.aliveSlots.includes(claim.claimerSlot)
      )
      .map((claim) => claim.claimerSlot);
    if (accusers.length > 0) {
      /**
       * By name, never "17 (Lucario)".
       *
       * A number in the prompt is a number the model will copy into its line,
       * the rule `mouthPrompt` states for the room's chatter. A Mafioso on the
       * stand read "pushing this: 17 (Lucario), 9 (Rafiki)" and said "On night
       * 1, I visited house 17", a visit to the first number in the list.
       */
      parts.push(`pushing this: ${[...new Set(accusers)].map(nameOf).join(', ')}`);
    }

    /** What this seat can actually offer back, in the order it is worth saying. */
    const mine: string[] = [];
    /**
     * The face it is wearing, which for a killer is not the one it has.
     *
     * This said `you really are the ${me.role.id}` to everybody, and for a
     * townsperson that is the best line it owns: an honest Doctor on the stand
     * should say so. For anybody else it is a confession, handed to the model
     * by the one part of this system that is supposed never to hold a decision.
     *
     * It reached a real table. Ganondorf, a Poisoner, opened his defence with
     * "I am the Vigilante" out of the phrasebook, and the mouth's very next
     * sentence was "I was the poisoner, as I claimed on Night 3 in house 14" —
     * because the sheet handed to it said, in as many words, *what you have:
     * you really are the poisoner*. The room hanged him twenty to nothing, and
     * it was right to. Trace `mafia-2026-09-20T18-07-56-6QFZK`.
     *
     * So the truth goes to the seats whose interest it serves, and everybody
     * else is reminded of the story they have already told the room instead.
     * `maskOf` is the same face round one claimed and the same one the will is
     * written from, which is the whole point of pinning it.
     */
    const self = state.players[botId];
    const mind = this.minds.mind(state, botId);
    const honest = self?.role ? ROLES[self.role].faction === 'town' : false;
    const face = honest ? (self?.role ?? null) : mind ? this.maskOf(state, botId, mind) : null;
    if (face) {
      mine.push(
        honest
          ? `you really are the ${face}`
          : `you have told this room you are the ${face}: keep to that and never name your real role`
      );
    }
    const went = board.claims.find(
      (claim) => claim.kind === 'account' && claim.claimerSlot === slot && claim.account === 'visited'
    );
    if (went) mine.push(`you already told the room you went to ${went.targetSlot} that night`);
    for (const entry of me.intel.slice(-3)) {
      if (entry.kind === 'sheriff') mine.push(`your night ${entry.night} check on ${entry.targetSlot}: ${entry.value}`);
      if (entry.kind === 'visitors' && (entry.slots ?? []).length > 0) {
        mine.push(`night ${entry.night} you watched ${entry.targetSlot} and saw ${(entry.slots ?? []).join(', ')}`);
      }
    }
    if (mine.length > 0) parts.push(`what you have: ${mine.join('; ')}`);

    return parts.length > 0 ? parts.join('. ') : null;
  }

  /**
   * One reason from the ranking, as a fragment of a sentence.
   *
   * Fragments rather than sentences because the whole point of the ranking is
   * that a case has *several* reasons, and three sentences in a row is a
   * prosecutor's closing statement rather than something somebody says at a
   * table. Joined by the caller into one line.
   *
   * Null for the codes that are real evidence and unsayable. `out-that-night`
   * is worth 0.04 log-odds, which is to say nothing, and a bot that says "you
   * were out on night 3" about a table where everybody was out has said nothing
   * and sounds like it. `proven-town` measured at zero and is not a reason at
   * all — see the note on `SAID`.
   */
  private fragment(
    reason: Reason,
    nameOf: (slot: number) => string,
    seed: string,
    /** The board, so the one fragment that asserts a silence can check for one. */
    board: PublicInfo,
    targetSlot: number
  ): Msg | null {
    const other = reason.slot === undefined ? null : nameOf(reason.slot);
    switch (reason.code) {
      case 'doorstep':
        /**
         * No witness name passed in, and that is not laziness.
         *
         * The first version handed the literal English word "somebody" in as a
         * parameter, which the French catalogue then rendered inside a French
         * sentence: "somebody t'a vu devant chez Kirby". Parameters carry names
         * and numbers. Words belong in the catalogue, in the catalogue's own
         * language, every time.
         */
        return other === null
          ? null
          : vary('mafia.bot.case.doorstep', 2, seed, { at: other, night: reason.night ?? 0 });
      case 'admitted-doorstep':
        return other === null
          ? null
          : vary('mafia.bot.case.admitted', 2, seed, { at: other, night: reason.night ?? 0 });
      case 'caught-lying':
        return vary('mafia.bot.case.caughtLying', 2, seed, {});
      case 'badge-unchallenged':
        return reason.role === undefined
          ? null
          : vary('mafia.bot.case.badge', 2, seed, { role: ROLE.name(reason.role) });
      case 'confessed':
        /**
         * The strongest thing on the board, and the only one a seat can say
         * without citing anybody: they said it themselves, in the square, and
         * everybody heard it. The badge is named because "he confessed" without
         * saying to what is a rumour rather than a quotation.
         */
        return reason.role === undefined
          ? vary('mafia.bot.case.confessedPlain', 2, seed, {})
          : vary('mafia.bot.case.confessed', 2, seed, { role: ROLE.name(reason.role) });
      case 'saved-killers':
        return vary('mafia.bot.case.savedKillers', 2, seed, {});
      case 'accused-by': {
        if (other === null || reason.slot === undefined) return null;
        /**
         * The second-person twin of `why.accused`, and it needed the same look.
         *
         * "{other} accused you and you have not answered" is two facts and only
         * the first was ever checked, so it was said to seats that had answered
         * in the same phase. The accusation is real either way; only the jab
         * comes off. See `spokeSince` in `why`.
         */
        const pushed = board.claims.find(
          (claim) => claim.kind === 'accuse' && claim.claimerSlot === reason.slot && claim.targetSlot === targetSlot
        );
        const answered =
          pushed !== undefined &&
          board.claims.some((claim) => claim.claimerSlot === targetSlot && claim.day >= pushed.day);
        return answered
          ? vary('mafia.bot.case.pushedByPlain', 2, seed, { other })
          : vary('mafia.bot.case.pushedBy', 2, seed, { other });
      }
      case 'named-in-a-will':
        /** The heaviest thing a corpse can say, and it comes with a quotation. */
        return other === null ? null : vary('mafia.bot.case.namedInAWill', 2, seed, { other });
      case 'accuser-silenced':
        /** The oldest read at any table, and the board could not make it until now. */
        return other === null ? null : vary('mafia.bot.case.accuserSilenced', 2, seed, { other });
      case 'led-town-wagon':
        /**
         * The one thing in a case that the accused cannot answer with a story.
         *
         * Every other fragment here reports something somebody said, and a seat
         * on the stand can call any of it a lie. This is a vote, the engine
         * timestamped it, and the graveyard settled what the wagon was pointed
         * at. See `tempo.ts`.
         */
        return other === null
          ? null
          : vary('mafia.bot.case.ledTownWagon', 2, seed, { at: other, day: reason.day ?? 0 });
      case 'record-broken':
        // The graveyard's catch already has twenty-seven ways of being said.
        return reason.deduction ? this.caughtOut(reason.deduction, nameOf, seed, 0) : null;
      default:
        return null;
    }
  }

  /**
   * The same rows, said about somebody rather than to them.
   *
   * `fragment` addresses the accused directly — "you said yourself you visited
   * 4" — because it is assembled inside `case.open`, which has just named them
   * and is now talking to them. `why` is the other register: it fills the
   * `{why}` of "Voting 4: …", a sentence aimed at the room about a third
   * party, and a second-person fragment dropped into it comes out as "Voting
   * 4: you voted innocent on people who turned out to be killers", which reads
   * as though the speaker has lost track of who it is arguing with.
   *
   * Only the codes `why` has no rung of its own for. The confession keys are
   * shared with `fragment` because that pair was already written in the third
   * person in both catalogues; the other two needed saying a different way,
   * which is the whole reason this exists.
   */
  private aloud(reason: Reason, botId: string, targetSlot: number, nameOf: (slot: number) => string): Msg | null {
    const seed = botId + ':w:' + targetSlot;
    switch (reason.code) {
      case 'confessed':
        return reason.role === undefined
          ? vary('mafia.bot.case.confessedPlain', 2, seed, {})
          : vary('mafia.bot.case.confessed', 2, seed, { role: ROLE.name(reason.role) });
      case 'badge-unchallenged':
        return reason.role === undefined
          ? null
          : vary('mafia.bot.why.ownBadge', 3, seed, { role: ROLE.name(reason.role) });
      case 'saved-killers':
        return vary('mafia.bot.why.savedKillers', 3, seed, {});
      case 'led-town-wagon':
        /** A vote is an act; this is the third-person half of `case.ledTownWagon`. */
        return reason.slot === undefined
          ? null
          : vary('mafia.bot.why.ledTownWagon', 3, seed, { at: nameOf(reason.slot), day: reason.day ?? 0 });
      case 'accuser-silenced':
        return reason.slot === undefined
          ? null
          : vary('mafia.bot.why.accuserSilenced', 3, seed, { other: nameOf(reason.slot) });
      default:
        return null;
    }
  }

  /** The same, for the half of the ranking that speaks in somebody's favour. */
  /**
   * These say "them" rather than naming the seat, because the frame around them
   * has already named it once. Naming it in every fragment as well produced
   * "Not 3. Nobody has ever seen 3 out, not once, 7 already cleared 3" — one
   * seat number three times in a breath, which reads like a form being filled
   * in rather than somebody speaking up for a neighbour.
   */
  private forFragment(reason: Reason, nameOf: (slot: number) => string, seed: string): Msg | null {
    switch (reason.code) {
      case 'never-out':
        return vary('mafia.bot.for.neverOut', 2, seed, {});
      case 'vouched-for':
        return reason.slot === undefined
          ? null
          : vary('mafia.bot.for.vouched', 2, seed, { other: nameOf(reason.slot) });
      case 'hanged-killers':
        return vary('mafia.bot.for.hangedKillers', 2, seed, {});
      case 'led-killer-wagon':
        /** And the same act read the other way: they opened the case, and the case was right. */
        return reason.slot === undefined
          ? null
          : vary('mafia.bot.for.ledKillerWagon', 2, seed, { at: nameOf(reason.slot), day: reason.day ?? 0 });
      default:
        return null;
    }
  }

  /**
   * The whole case against one seat, in one sentence, with its reasons named.
   *
   * The thing an accusation was always missing. `why` hands back the single
   * strongest reason, which is right for a passing remark and wrong for the
   * moment a seat actually commits to a wagon: a case that cites one thing is a
   * hunch, and the ranking knows perfectly well that there are three. Nothing
   * here is invented — every fragment is a row from `caseFor`, which is built
   * from the board — so the worst it can do is be unpersuasive.
   */
  private caseLine(state: MafiaState, board: PublicInfo, targetSlot: number, botId: string): Msg | null {
    const nameOf = (slot: number): string =>
      Object.values(state.players).find((player) => player.slot === slot)?.name ?? String(slot);
    const seed = botId + ':case:' + String(targetSlot);
    /**
     * Two reasons, and the third is for the briefing rather than the square.
     *
     * The rulebook every bot is handed says a line is short and never two
     * sentences where one will do, and three of these joined together is two
     * sentences however it is punctuated. Two is where an accusation stops
     * sounding like a hunch and has not yet started sounding like a closing
     * argument. `caseFor` still returns three for anything reading the board
     * rather than speaking to it.
     */
    const speaker = state.players[botId]?.slot;
    const parts = caseFor(targetSlot, board, 3)
      // Its own accusation is not a second voice: "Bowser has you at the top of their list", said by Bowser.
      .filter((reason) => !(reason.code === 'accused-by' && reason.slot === speaker))
      .map((reason) => this.fragment(reason, nameOf, seed, board, targetSlot))
      .filter((part): part is Msg => part !== null)
      .slice(0, 2);
    if (parts.length < 2) return null; // one reason is `why`'s job, not this one

    const locale = spokenLocale(state);
    const t = say(locale);
    /**
     * Two reasons if two fit, one if they do not, and never a cut sentence.
     *
     * The frame and the name are part of the finished line and were counted
     * against nothing, so the only place the overflow showed up was `clip`,
     * which cuts mid-word and adds an ellipsis. Measured here instead: a whole
     * reason dropped reads as a seat making one point; half a reason reads as
     * broken software. Below two reasons this returns null on purpose and
     * `why` takes the turn, which is the rule stated at the call site.
     */
    const frame = (chosen: Msg[]): Msg =>
      vary('mafia.bot.case.open', 3, seed, {
        who: nameOf(targetSlot),
        reasons: joinReasons(
          chosen.map((part) => t(part)),
          locale
        )
      });
    const both = frame(parts);
    return t(both).length <= CASE_CHARS ? both : null;
  }

  /**
   * And the case *for* somebody the room is about to hang.
   *
   * The half that did not exist. A seat under a wagon with three things on the
   * board in its favour — never once put outside by anybody, cleared by a voice
   * the room believes, a record the graveyard has caught nothing in — had all
   * three sitting there and no seat at the table able to say them out loud.
   * That is how a town hangs its own Doctor while eleven people who could have
   * spoken for it watch.
   *
   * Deliberately built from *named* reasons only, never from a low score. The
   * calibration run is clear that a quiet seat is not a cleared one: seats the
   * ranking put under 0.1 were killers 40% of the time. A fact about the record
   * is worth saying; a hole in the record is not.
   */
  private standUpFor(state: MafiaState, board: PublicInfo, targetSlot: number, botId: string): Msg | null {
    const nameOf = (slot: number): string =>
      Object.values(state.players).find((player) => player.slot === slot)?.name ?? String(slot);
    const who = nameOf(targetSlot);
    const seed = botId + ':for:' + String(targetSlot);
    const speaker = state.players[botId]?.slot;
    /**
     * A brother, which is the one defence this seat knows is true.
     *
     * The lodge knows its own for certain and was defending them with whatever
     * the board happened to hold: a real table heard the Mason Leader acquit a
     * human Mason with "Sardine says they are innocent", while the room hanged
     * him three minutes later for want of anybody saying he was a brother.
     */
    const self = state.players[botId];
    const target = Object.values(state.players).find((player) => player.slot === targetSlot);
    const brother =
      self && target && playerFamily(self) === null && isLodgeMate(self, target)
        ? vary('mafia.bot.for.lodge', 2, seed)
        : null;
    const parts = [
      ...(brother ? [brother] : []),
      ...defenceFor(targetSlot, board, 3)
        // Its own clear is not a second voice: "Zorro has already cleared them", said by Zorro.
        .filter((reason) => !(reason.code === 'vouched-for' && reason.slot === speaker))
        .map((reason) => this.forFragment(reason, nameOf, seed))
        .filter((part): part is Msg => part !== null)
    ].slice(0, 2);
    if (parts.length === 0) return null;

    const locale = spokenLocale(state);
    const t = say(locale);
    return vary('mafia.bot.for.open', 3, seed, {
      who,
      reasons: joinReasons(
        parts.map((part) => t(part)),
        locale
      )
    });
  }

  /**
   * A juror's sentence, which is its verdict plus the one thing behind it.
   *
   * Deliberately not a claim: the ballot is already public and the trial is the
   * room's own business, so this goes in the square as talk and nothing is
   * filed. Everything it can say comes off the board through `why` and
   * `standUpFor`, so a juror cannot invent evidence in the booth any more than
   * it can invent it in the square.
   */
  private verdictLine(
    state: MafiaState,
    view: MafiaView,
    board: PublicInfo,
    botId: string,
    accusedSlot: number,
    verdict: 'guilty' | 'innocent' | 'abstain'
  ): string | null {
    if (verdict === 'abstain') return null;
    const t = say(spokenLocale(state));
    const who = Object.values(state.players).find((player) => player.slot === accusedSlot)?.name ?? String(accusedSlot);
    const salt = botId + ':verdict:' + state.day + ':' + accusedSlot;

    if (verdict === 'guilty') {
      const why = this.why(state, view, board, accusedSlot, botId);
      return t(
        why
          ? vary('mafia.bot.verdict.guilty.why', 3, salt, { who, why })
          : vary('mafia.bot.verdict.guilty.plain', 3, salt, { who })
      );
    }

    // An acquittal with a reason is already a whole sentence; see `standUpFor`.
    const stand = this.standUpFor(state, board, accusedSlot, botId);

    /**
     * A seat that put this name up and is now voting to let it go.
     *
     * Reported from a table: the bot opened the case against Gollum, the room
     * followed it onto the wagon, and then it voted innocent without a word.
     * From the floor that is indistinguishable from a seat protecting somebody,
     * and it is the single most suspicious thing a player can do silently.
     *
     * Changing your mind is allowed and often right: the defence is *for*
     * something. Doing it without saying so is not. So the reversal is named
     * out loud, with the reason when there is one and an admission when there
     * is not.
     */
    const mySlot = view.me?.slot ?? null;
    const mine =
      mySlot !== null &&
      board.voteHistory.some(
        (vote) => vote.day === state.day && vote.voterSlot === mySlot && vote.targetSlot === accusedSlot
      );
    if (mine) {
      /**
       * The bare reason rather than `standUpFor`'s whole sentence, because this
       * frame already names the seat and says the verdict. Composing one line
       * inside another is how the square got "It is Nami: Nami. Someone saw you
       * visiting 5 on night 3.." See the note on `sentence`.
       */
      const nameOf = (slot: number): string =>
        Object.values(state.players).find((player) => player.slot === slot)?.name ?? String(slot);
      const seed = botId + ':for:' + String(accusedSlot);
      const reason = defenceFor(accusedSlot, board, 3)
        .map((entry) => this.forFragment(entry, nameOf, seed))
        .find((part): part is Msg => part !== null);
      const why = reason ? t(reason) : null;
      return t(
        why
          ? vary('mafia.bot.verdict.turned.why', 3, salt, { who, why })
          : vary('mafia.bot.verdict.turned.plain', 3, salt, { who })
      );
    }

    return t(stand ?? vary('mafia.bot.verdict.innocent.plain', 3, salt, { who }));
  }

  private why(state: MafiaState, view: MafiaView, board: PublicInfo, targetSlot: number, botId = ''): Msg | null {
    const me = view.me;
    if (!me) return null;
    const nameOf = (slot: number): string =>
      Object.values(state.players).find((player) => player.slot === slot)?.name ?? String(slot);

    /**
     * 0. Caught by the record itself, which outranks every witness.
     *
     * The strongest thing a seat can cite, and the only rung on this ladder
     * that needs nobody to be believed: a bodyguard who took a knife is a
     * corpse in the morning report, poison kills at the second dawn, the cell
     * holds one. The room can check every one of these on the screens it is
     * already looking at, so an accusation built on one is an accusation that
     * survives the accuser being distrusted. See `deduce.ts`.
     */
    const caught = strongest(deductions(targetSlot, board));
    if (caught) {
      const reason = this.caughtOut(caught, nameOf, botId, targetSlot);
      if (reason) return reason;
    }

    /**
     * 0b. The two heaviest rules in the model, neither of which had a sentence.
     *
     * `confessed` is priced at 3.0 and `badge-unchallenged` at 2.77, the top of
     * the whole table, and this ladder had no rung for either — so the two
     * strongest things the board can hold were the two a seat could not say. A
     * bot would read a confession, move its vote, and post "Voting 7.": the
     * room watched a wagon form on nothing and had to take it on faith, which
     * is the one thing a square must never ask of the people sitting in it.
     *
     * Read off `caseFor` rather than re-derived here, so the sentence cites
     * exactly the row the ranking scored — same reason, same badge, same
     * weight. A reason nobody can name is a reason nobody can answer, and a
     * seat that cannot answer the case against it has been hanged by a machine
     * rather than beaten by one.
     */
    const unsaid = caseFor(targetSlot, board, 8).find(
      (reason) => reason.code === 'confessed' || reason.code === 'badge-unchallenged' || reason.code === 'saved-killers'
    );
    if (unsaid) {
      const spoken = this.aloud(unsaid, botId, targetSlot, nameOf);
      if (spoken) return spoken;
    }

    /**
     * 0c. A name written down by somebody who did not live to be questioned.
     *
     * High on this ladder because the bench put it there: fitted at +1.311, the
     * third heaviest rule in the model and five times the weight of a living
     * seat's accusation. It also happens to be the single most *persuasive*
     * thing a bot can say, because it is the only rung that comes with a
     * quotation the whole room already read this morning.
     */
    const willed = caseFor(targetSlot, board, 8).find((reason) => reason.code === 'named-in-a-will');
    if (willed?.slot !== undefined) {
      const quoted = this.willLine(state, willed.slot, targetSlot);
      const seed = botId + ':w:' + targetSlot;
      return quoted
        ? vary('mafia.bot.why.willQuote', 3, seed, { who: nameOf(willed.slot), line: quoted })
        : vary('mafia.bot.why.willNames', 3, seed, { who: nameOf(willed.slot) });
    }

    // 1. Caught out: they said they were home and somebody put them outside.
    if (contradicted(targetSlot, board)) {
      const witness = board.claims.find((claim) => claim.kind === 'sighting' && claim.targetSlot === targetSlot);
      if (witness)
        return vary('mafia.bot.why.contradiction', 3, botId + ':w:' + targetSlot, { who: nameOf(witness.claimerSlot) });
    }

    // 2. My own nights. The strongest thing a seat can own, and the one it pays
    //    for by outing itself as something worth killing.
    const check = me.intel.find(
      (entry) => entry.targetSlot === targetSlot && entry.kind === 'sheriff' && sheriffSuspects(entry.value)
    );
    if (check) {
      // Same reasoning as the read-out: cite the camp when the needle named one.
      const named = verdictName(check.value);
      return named
        ? vary('mafia.bot.why.checkNamed', 3, botId + ':w:' + targetSlot, { night: check.night, what: named })
        : vary('mafia.bot.why.check', 3, botId + ':w:' + targetSlot, { night: check.night });
    }
    // 2b. The Investigator's version of the same thing: a smell that, on this
    //     roster, can only belong to an enemy.
    const smelt = me.intel.find(
      (entry) =>
        entry.targetSlot === targetSlot &&
        entry.kind === 'trade' &&
        tradeVerdict(entry.value, board.rolesInPlay) === 'damning'
    );
    if (smelt) {
      return vary('mafia.bot.why.trade', 3, botId + ':w:' + targetSlot, {
        night: smelt.night,
        line: tradeLine(smelt.value)
      });
    }

    /**
     * Has this seat said anything since the thing it is accused of ignoring?
     *
     * Four reasons in this file assert that somebody never answered, and not
     * one of them looked. The rung just below checks the board properly for
     * "they have never claimed anything", which shows the check was always
     * cheap — it simply was not applied to the others.
     *
     * Measured on a real table. Guts said "Nowhere last night" and in the same
     * phase was voted by one seat for never having said where it was, and by
     * two more because somebody "accused him and he never answered". Three
     * seats stating, out loud and in the same minute, a fact the transcript
     * above them contradicted.
     *
     * Any claim counts, because answering is not a kind of claim: a seat that
     * meets an accusation with an alibi, a counter-accusation, a role or a
     * plain denial has answered it. Only a seat that said nothing at all has
     * not.
     */
    const spokeSince = (slot: number, since: number): boolean =>
      board.claims.some((claim) => claim.claimerSlot === slot && claim.day >= since);

    // 3. Somebody credible has already named them. A badge the room has not
    //    disputed, or a person, comes before a doorstep report; any other voice
    //    the room still listens to comes after. Accusations are the largest
    //    term in `suspicion` and were the one thing a bot never cited, so a
    //    seat moved by a human Sheriff could not say so. Now it can, and does.
    const humans = new Set(
      Object.values(state.players)
        .filter((player) => !player.isBot)
        .map((player) => player.slot)
    );
    const accusers = board.claims
      .filter(
        (claim) =>
          claim.kind === 'accuse' &&
          claim.targetSlot === targetSlot &&
          claim.claimerSlot !== me.slot &&
          board.aliveSlots.includes(claim.claimerSlot)
      )
      .map((claim) => ({
        slot: claim.claimerSlot,
        weight: claimerWeight(claim.claimerSlot, board),
        badge: uncontestedBadge(claim.claimerSlot, board),
        human: humans.has(claim.claimerSlot)
      }))
      .filter((entry) => entry.weight >= 1)
      .sort((left, right) => Number(right.human) - Number(left.human) || right.weight - left.weight);
    const badged = accusers.find((entry) => entry.badge !== null);
    if (badged?.badge) {
      return vary('mafia.bot.why.badge', 3, botId + ':w:' + targetSlot, {
        who: nameOf(badged.slot),
        role: ROLE.name(badged.badge)
      });
    }

    /**
     * Borrowed conviction, in this seat's own words.
     *
     * Half a dozen seats reaching this rung on the same afternoon said the same
     * sentence about the same house, one after another: "X already called you
     * out, so I am voting X", six times. Each one is a fair thing to think and
     * a terrible thing to read, and together they are the wall of copy-paste
     * that makes a table look like software. Same reason, three ways to admit
     * it, fixed per speaker and target so a seat that borrows an opinion
     * borrows it the same way every time.
     */
    const borrowed = (slot: number): Msg => {
      /**
       * The same borrowed conviction, with and without the jab.
       *
       * "X accused them and they never answered" is two facts, and this seat
       * only ever checked the first. When the second is false the sentence is
       * still mostly true, which is what makes it worth keeping rather than
       * dropping: the accusation is real and citing it is honest. So the jab
       * comes off and the citation stands.
       */
      const since = board.claims.find(
        (claim) => claim.kind === 'accuse' && claim.claimerSlot === slot && claim.targetSlot === targetSlot
      );
      return since && !spokeSince(targetSlot, since.day)
        ? vary('mafia.bot.why.accused', 6, botId + ':borrow:' + slot, { who: nameOf(slot) })
        : vary('mafia.bot.why.pushedBy', 6, botId + ':borrow:' + slot, { who: nameOf(slot) });
    };

    if (accusers[0]?.human) return borrowed(accusers[0].slot);

    /**
     * 4. Somebody else's doorstep report, and only while it is news.
     *
     * A sighting the accused has already owned up to is not a reason to hang
     * them, and saying it out loud is worse than merely thinking it: eight
     * seats in one afternoon gave "Bugs Bunny saw them visiting a house on
     * night 1" as their whole case against a Doctor whose published round said
     * he had been at that house, on that night, for two days. The room read a
     * confirmation aloud as an accusation, and the man it confirmed hanged.
     *
     * `ownsUpTo` is the same test the score now applies, asked here so the
     * sentence and the vote cannot disagree: if the doorstep agrees with the
     * account, this rung is skipped and the reason falls through to whatever
     * the seat actually holds against them.
     */
    const seen = board.claims.find(
      (claim) =>
        claim.kind === 'sighting' &&
        claim.targetSlot === targetSlot &&
        // Somebody *else's*: a Lookout said "Rambo saw them visiting a house", and it was Rambo.
        claim.claimerSlot !== me.slot &&
        ownsUpTo(targetSlot, claim, board) === null
    );
    if (seen) {
      return vary('mafia.bot.why.seen', 3, botId + ':w:' + targetSlot, {
        who: nameOf(seen.claimerSlot),
        night: seen.night ?? Math.max(1, seen.day - 1)
      });
    }

    // 5. Any other voice the room still listens to.
    if (accusers[0]) return borrowed(accusers[0].slot);

    /**
     * 6. Two people cannot both be the Sheriff.
     *
     * And when the other one is this seat, it says so itself. The rival was
     * picked without looking at who was speaking, so a bot whose own badge had
     * just been claimed by somebody else reported the collision in the third
     * person — "they and Nami both say they are the Sheriff", said by Nami,
     * which sounds like a bystander reading out a fact rather than the man
     * whose name is on it. One of the two is lying and the room can only find
     * out if both stand up.
     */
    const theirs = board.claims.find((claim) => claim.kind === 'role-claim' && claim.claimerSlot === targetSlot);
    if (theirs?.claimedRole) {
      /**
       * A contest needs two people still in the room to have it.
       *
       * This counted every role claim ever filed, so a badge whose rival was
       * hanged on day two and revealed as something else entirely was still
       * being read out as a live contradiction on day four. Measured on a real
       * table: the town spent two afternoons hanging seats because "he and
       * Pac-Man both claim to be the Lookout", with Pac-Man in the ground since
       * day two and publicly revealed as the Framer.
       *
       * The scoring side has always had this right — `badgesOf` counts living
       * wearers only — so this was the spoken reason alone disagreeing with the
       * arithmetic behind it, which is the worst of the two ways to be wrong:
       * the bots voted for a decent reason and stated a stupid one.
       */
      const rivals = board.claims.filter(
        (claim) =>
          claim.kind === 'role-claim' &&
          claim.claimedRole === theirs.claimedRole &&
          claim.claimerSlot !== targetSlot &&
          board.aliveSlots.includes(claim.claimerSlot) &&
          // And a grave that already answered the question is not a rival either.
          board.deadRoles.get(claim.claimerSlot) === undefined
      );
      if (rivals.some((claim) => claim.claimerSlot === me.slot)) {
        return vary('mafia.bot.why.myBadge', 3, botId + ':w:' + targetSlot, { role: ROLE.name(theirs.claimedRole) });
      }
      const rival = rivals[0];
      if (rival) {
        return vary('mafia.bot.why.doubleClaim', 3, botId + ':w:' + targetSlot, {
          who: nameOf(rival.claimerSlot),
          role: ROLE.name(theirs.claimedRole)
        });
      }
    }

    /**
     * 6b. The two rules that scored and could not be said.
     *
     * `led-town-wagon` and `accuser-silenced` were fitted, wired into the
     * ranking, and given second-person sentences for a *case* — which needs two
     * reasons before it says anything. A seat whose whole read was one of them
     * therefore reached the bottom of this ladder with nothing, and posted "8.
     * Une intuition, pas un dossier" over evidence it was actually holding. Ten
     * of those across a chaos run, every one of them a vote the room could not
     * argue with because nobody said what it was for.
     *
     * Low on the ladder, where their weights put them: a third of a doorstep
     * and a fifth of a badge. Above the bare read, which is the point.
     */
    const tempo = caseFor(targetSlot, board, 8).find(
      (reason) => reason.code === 'led-town-wagon' || reason.code === 'accuser-silenced'
    );
    if (tempo) {
      const spoken = this.aloud(tempo, botId, targetSlot, nameOf);
      if (spoken) return spoken;
    }

    /**
     * 7. Their own words, quoted back at them — where the words are damning.
     *
     * This rung took *any* account of a night out and read it aloud as a
     * reason, which it is not: "I was at Littlefinger's on night two" is an
     * alibi, and Littlefinger was alive, well, and entirely beside the point.
     * A real table watched three seats convict a man with it in a row — "I am
     * voting guilty, because they told us themselves they visited Littlefinger
     * on night two" — and the human in the room asked the obvious question,
     * which nobody at the table could answer, because there was no answer. The
     * vote came from the ranking; only the sentence was nonsense, and the
     * sentence is the whole of what a player hears.
     *
     * A night out is evidence when the house it names produced a body that
     * morning. Standing on a doorstep somebody died behind is a thing a room
     * can argue about. Anything else falls through to the rungs below, which
     * are at least honest about holding nothing.
     */
    const visit = board.claims.find(
      (claim) =>
        claim.kind === 'account' &&
        claim.claimerSlot === targetSlot &&
        claim.account === 'visited' &&
        board.deaths.some(
          (death) =>
            death.slot === claim.targetSlot &&
            death.phase === 'night' &&
            death.day === (claim.night ?? Math.max(1, claim.day - 1))
        )
    );
    if (visit) {
      return vary('mafia.bot.why.admitted', 3, botId + ':w:' + targetSlot, {
        who: nameOf(visit.targetSlot),
        night: visit.night ?? Math.max(1, visit.day - 1)
      });
    }

    /**
     * 8. Being quiet, which is not a reason and was the commonest one given.
     *
     * Silence is worth exactly nothing in the arithmetic: it appears in no
     * weight in `suspicionParts`, in no rule in `rank`, and in no deduction. It
     * had this rung anyway, near the bottom, which is precisely where a vote
     * decided by noise lands — so whenever the board held nothing, the sentence
     * that came out of the square was "they have not made a single claim all
     * game", and the room heard the town hanging people for not talking.
     *
     * From a real table, day five: two seats a twentieth of a point apart, the
     * wagon opened on the quieter one with this line, and four seats followed
     * it within the minute. Nobody at that table had a single checkable fact
     * about the man they hanged.
     *
     * So it is gone as a reason to pull a rope. What silence justifies is a
     * *question* — `decideDay` already asks one, and a seat that then refuses
     * to answer is caught by the rung below, which is a different sentence
     * about a different thing.
     */

    /**
     * Two names that have never crossed on a ballot.
     *
     * Below the silence rung because it is worth far less than it sounds: see
     * `BUDDY_WEIGHT` for what the read actually measured. It is here at all
     * because it used to be worth a fifth of a lynch with no sentence anywhere
     * behind it, so a table that moved on it moved for a reason none of its
     * seats could give — which is how a square hangs somebody nobody has said
     * anything about.
     */
    const buddy = buddyRead(targetSlot, board);
    if (buddy.partner !== null) {
      return vary('mafia.bot.why.buddy', 3, botId + ':w:' + targetSlot, { who: nameOf(buddy.partner) });
    }

    // 9. The wagon itself, which is a reason people really do give.
    const against = [...board.votes.values()].filter((slot) => slot === targetSlot).length;
    if (against >= 2) {
      // The wagon is on the board either way; only the "and said nothing back"
      // half needed looking up. See `spokeSince`.
      return spokeSince(targetSlot, board.day)
        ? vary('mafia.bot.why.wagonPlain', 3, botId + ':w:' + targetSlot)
        : vary('mafia.bot.why.wagon', 3, botId + ':w:' + targetSlot);
    }

    /**
     * The last rung, and it has to check the thing it says.
     *
     * "They have never told us where they were on any night" was returned on
     * day three or later with nothing looked at, so it was said about seats who
     * had given an account every single day. The catalogue's own rule, written
     * at the top of it, is that a variant asserts only what the call site has
     * checked — this was the call site that checked nothing, and it read as
     * flavour while playing as evidence.
     *
     * Reported from a real table. A Sheriff claimed its badge, named a mafioso
     * and read out both its nights; a juror voted guilty because it "had never
     * told us where it was on any night", in the same minute and in the same
     * room. Whatever else was wrong with that afternoon, one seat at it was
     * stating a fact that the transcript directly contradicted.
     *
     * Failing to null is the right failure: `sentence` turns a missing reason
     * into a line that admits it is only a read, which is true, and true is the
     * whole bar here.
     */
    const silentOnNights = !board.claims.some(
      (claim) =>
        claim.claimerSlot === targetSlot &&
        // "I was doused", "I was roleblocked" is an account of a night as much
        // as "I was home" is, and the seat that said it has told us where it was.
        //
        // And so is every check, watch and track a seat reads out: a power is
        // spent at a house, so naming what it found there names where its owner
        // spent the night. Those arrive as ordinary verdicts — a `clear` about
        // house 9 looks the same whether it was investigated or merely guessed
        // at — which is why the ones that come from a night's record carry
        // `worked`. Without it an investigator's whole evening was invisible
        // here, and this sentence was said about the most talkative seat at the
        // table.
        (claim.kind === 'account' || claim.kind === 'sighting' || claim.kind === 'ailing' || claim.worked === true)
    );
    /**
     * And only once the room has actually asked.
     *
     * Volunteering your nights is a habit, not a duty: plenty of honest seats
     * never think to, and hanging them for it is the same mistake the rung
     * above was deleted for, wearing a longer sentence. What is a real tell is
     * being *asked* and not answering, which is a choice the whole room watched
     * somebody make — and which the arithmetic already prices, at half an
     * accuser's weight, through `dodgedTheQuestion`.
     *
     * So this sentence now says what it has always looked like it was saying.
     */
    const asked = board.claims.some((claim) => claim.kind === 'question' && claim.targetSlot === targetSlot);
    return board.day >= 3 && silentOnNights && asked
      ? vary('mafia.bot.why.nowhere', 3, botId + ':w:' + targetSlot)
      : null;
  }

  /**
   * The accusation with the speaker's neck on it, when the evidence earns it.
   *
   * Two findings name a camp outright: an examiner's exact role, and a smell
   * whose whole shortlist on this roster belongs to one faction. Everything
   * else is a reason, and reasons go through `why`. The stake converts a claim
   * nobody can check into a bet the room settles tomorrow — a liar who makes it
   * has bought one day — so it is rare, and rarer in a timid seat.
   */
  private stake(state: MafiaState, botId: string, targetSlot: number, who: string): Msg | null {
    const self = state.players[botId];
    const mind = this.minds.mind(state, botId);
    if (!self || !mind) return null;
    if (hashCode(botId + ':stake:' + state.day + ':' + targetSlot) % 3 !== 0) return null;
    if (mind.brain.personality.courage < 0.5 && mind.brain.desperation < 0.5) return null;

    const board = this.minds.board(state, botId);
    const salt = botId + ':stake:' + targetSlot;
    const exact = self.intel.find(
      (entry) =>
        entry.targetSlot === targetSlot &&
        entry.kind === 'role' &&
        entry.value in ROLES &&
        ROLES[entry.value as RoleId].faction !== 'town'
    );
    if (exact) return vary('mafia.bot.stake.role', 6, salt, { who, role: ROLE.name(exact.value as RoleId) });

    const smelt = self.intel.find(
      (entry) =>
        entry.targetSlot === targetSlot &&
        entry.kind === 'trade' &&
        tradeVerdict(entry.value, board.rolesInPlay) === 'damning'
    );
    if (smelt) {
      const camps = new Set(tradeSuspects(smelt.value, board.rolesInPlay).map((role) => ROLES[role].faction));
      const [camp] = [...camps];
      if (camps.size === 1 && camp) return vary('mafia.bot.stake.faction', 6, salt, { who, faction: FACTION(camp) });
    }
    return null;
  }

  /**
   * Something the grey text already said, with one join.
   *
   * Everything here is on the public board: last night's report, yesterday's
   * trial with its ballots and the role the rope revealed, the claims and the
   * corpses. A seat that says it is a seat that read it, which is most of what
   * a person does with an afternoon. Nothing is inferred out loud, and nothing
   * is filed. Fires on a minority of empty turns so it stays a remark rather
   * than a tic.
   */
  private remark(state: MafiaState, botId: string, board: PublicInfo): string | null {
    if (hashCode(botId + ':remark:' + state.day) % 3 !== 0) return null;
    const t = say(spokenLocale(state));
    const nameOf = (slot: number): string =>
      Object.values(state.players).find((player) => player.slot === slot)?.name ?? String(slot);
    const salt = botId + ':remark:' + state.day;
    const options: Msg[] = [];

    if (board.day > 1 && board.lastNightDeathSlots.size === 0 && board.nightDeathsTotal > 0) {
      options.push(vary('mafia.bot.fact.quiet', 3, salt));
    }

    const hanged = board.trials.find((trial) => trial.day === board.day - 1 && trial.lynched);
    const rope = hanged ? board.deadRoles.get(hanged.accusedSlot) : undefined;
    if (hanged && rope) {
      /**
       * A verdict on yesterday's rope only where the roster gives one.
       *
       * Town hanged is a mistake and an enemy hanged is a good day; a hanged
       * Jester is the Jester's win and a hanged Survivor is nobody's, so those
       * get no sentence at all rather than a wrong one. "Naruto was the Jester.
       * Good rope." was said at a real table.
       */
      const town = ROLES[rope].faction === 'town';
      const enemy = isEvilRole(rope);
      if (town || enemy) {
        options.push(
          vary(town ? 'mafia.bot.fact.hangedTown' : 'mafia.bot.fact.hangedEvil', 3, salt, {
            who: nameOf(hanged.accusedSlot),
            role: ROLE.name(rope)
          })
        );
      }
      /**
       * Who pulled it, said by somebody who was not holding the rope.
       *
       * This named the first three guilty ballots and never checked whether the
       * speaker's own was among them. On a real table a Caporegime opened the
       * afternoon with "Xavier, Meliodas, Lisa Simpson voted guilty on Gaston,
       * who was town" — a verdict of eleven to nothing that she had voted for
       * herself. Two separate lies in one sentence: three names for a room that
       * was unanimous, and an accusation from one of the accused.
       *
       * So a seat that voted guilty says so instead. It is the better line
       * anyway: admitting a bad rope you helped pull is the thing that buys a
       * town back its credibility, and it is the one version of this remark
       * nobody can throw back at the speaker.
       */
      const mySlot = state.players[botId]?.slot ?? null;
      const others = hanged.guiltySlots.filter((slot) => slot !== mySlot);
      if (town && mySlot !== null && hanged.guiltySlots.includes(mySlot)) {
        options.push(vary('mafia.bot.fact.votersWrongMine', 3, salt, { who: nameOf(hanged.accusedSlot) }));
      } else if (town && others.length > 3) {
        // Naming three of nine reads as an accusation of three. It was the room.
        options.push(
          vary('mafia.bot.fact.votersWrongMany', 3, salt, {
            who: nameOf(hanged.accusedSlot),
            count: String(others.length)
          })
        );
      } else if (town && others.length > 0) {
        options.push(
          vary('mafia.bot.fact.votersWrong', 3, salt, {
            who: nameOf(hanged.accusedSlot),
            names: others.map(nameOf).join(', ')
          })
        );
      }
    }

    // A claim on day D is followed by night D; a corpse from that night is the join.
    // Last night's only: it is news the morning after, and on days 6 and 8 of a
    // real game two seats announced a day 4 death as if it had just happened.
    const silencedClaim = board.claims.find(
      (claim) =>
        claim.kind === 'role-claim' &&
        claim.claimedRole &&
        claim.day === board.day - 1 &&
        board.deaths.some(
          (death) => death.slot === claim.claimerSlot && death.phase === 'night' && death.day === claim.day
        )
    );
    if (silencedClaim?.claimedRole) {
      options.push(
        vary('mafia.bot.fact.claimerDied', 3, salt, {
          who: nameOf(silencedClaim.claimerSlot),
          role: ROLE.name(silencedClaim.claimedRole)
        })
      );
    }

    const chosen = options[hashCode(salt + ':pick') % Math.max(1, options.length)];
    return chosen ? t(chosen) : null;
  }

  /**
   * Why this seat thinks that one is *not* the problem, as half a sentence.
   *
   * The mirror of `why`, and it has to exist separately rather than share it:
   * exoneration and suspicion are not the same evidence read two ways. "Nobody
   * has put them anywhere" is a reason to be uneasy about somebody and no
   * reason at all to defend them, and a defence that cites it is a seat
   * arguing against its own sentence.
   *
   * Three rungs, strongest first, all of them things another seat could go and
   * check. Null when none of them holds, and then the bare `clear` does the
   * work — which is honest: "not my vote today" is a real position and it does
   * not pretend to be evidence.
   */
  private whyClear(
    view: MafiaView,
    board: PublicInfo,
    targetSlot: number,
    botId: string,
    state: MafiaState
  ): Msg | null {
    const me = view.me;
    if (!me) return null;
    const salt = botId + ':wc:' + targetSlot;
    const nameOf = (slot: number): string =>
      Object.values(state.players).find((player) => player.slot === slot)?.name ?? String(slot);

    /* 1. My own night's work came back clean. The one thing this seat owns. */
    const checked = me.intel.find(
      (entry) =>
        entry.targetSlot === targetSlot &&
        ((entry.kind === 'sheriff' && entry.value === 'clear') || (entry.kind === 'role' && entry.value === 'citizen'))
    );
    if (checked) return vary('mafia.bot.whyClear.mine', 3, salt, { night: checked.night });
    const smelt = me.intel.find(
      (entry) =>
        entry.targetSlot === targetSlot &&
        entry.kind === 'trade' &&
        tradeVerdict(entry.value, board.rolesInPlay) === 'clean'
    );
    if (smelt) {
      return vary('mafia.bot.whyClear.trade', 3, salt, { night: smelt.night, line: tradeLine(smelt.value) });
    }

    /* 2. A badge the room has not disputed has already vouched for them. */
    const vouched = board.claims.find(
      (claim) =>
        claim.kind === 'clear' &&
        claim.targetSlot === targetSlot &&
        claim.claimerSlot !== me.slot &&
        board.aliveSlots.includes(claim.claimerSlot) &&
        uncontestedBadge(claim.claimerSlot, board) !== null
    );
    if (vouched) {
      const badge = uncontestedBadge(vouched.claimerSlot, board);
      if (badge) {
        return vary('mafia.bot.whyClear.vouched', 3, salt, {
          who: nameOf(vouched.claimerSlot),
          role: ROLE.name(badge)
        });
      }
    }

    /* 3. They answered for a night, and nobody has caught them on it. */
    const accounted = board.claims.some((claim) => claim.kind === 'account' && claim.claimerSlot === targetSlot);
    return accounted && !contradicted(targetSlot, board) ? vary('mafia.bot.whyClear.accounted', 3, salt) : null;
  }

  /**
   * A night in the cell, from whichever end of it this seat is on.
   *
   * The jailor asks a question and offers nothing. The prisoner answers with
   * the most checkable thing it holds — a role and a night's work beats a role
   * alone, and a role alone beats "I did nothing" — because a claim the jailor
   * can verify tomorrow is the only currency in the room.
   *
   * An evil prisoner reaches for the same shelf and finds a role it is not,
   * through `bluffRole`, so the lie is at least a role this table could contain.
   * A very quiet temperament says nothing at all, which is a personality and
   * also, in this room, a decision: silence is what gets people executed.
   */
  private cellLine(state: MafiaState, botId: string, view: MafiaView, room: string): string | null {
    const t = say(spokenLocale(state));
    const self = state.players[botId];
    const me = view.me;
    if (!self?.role || !me) return null;

    /**
     * The cell, from the keeper's end, and only in the room it keeps.
     *
     * Gated on the Jailor alone once, so the two keepers rebuilt to play exactly
     * like one sat in their cellars all night saying nothing. The questions, the
     * threat and the vouch are the same three moves for all three of them, which
     * is the point: a captive must not be able to tell from the conversation
     * whose room it is in.
     *
     * But "is a keeper" is not "is *this* room's keeper", and the difference is
     * a whole role. A Ravisseur holding somebody in its own cellar can itself be
     * sitting in the Jailor's cell that same night, and asked to speak there it
     * would have interrogated its own captor: the wrong half of the script, in
     * the wrong room, about a prisoner the other seat cannot see. It is the
     * captive in that room and it pleads like one.
     */
    if (isKeeper(self) && room === jailChannel(state.day, botId)) {
      /**
       * The one thing a Jailor has that nobody else does: a room that cannot leak.
       *
       * The cell is the only channel in the game where two seats can talk with
       * no third party and no record the square ever sees, and the Jailor spent
       * every night of it asking questions and giving nothing — which is correct
       * against a prisoner it suspects and a waste against one it does not. A
       * Doctor who has proved itself in that room walks out at dawn knowing
       * nothing about who held it, so the two seats that just established mutual
       * trust go back to the square as strangers, and the Jailor dies later that
       * week unvouched-for by the one person who could have vouched.
       *
       * So: when this seat has decided the prisoner is genuinely town, it says
       * who it is. That is a real cost — the prisoner might be lying, and a
       * Jailor's name in the wrong hands is a dead Jailor — which is exactly why
       * it is gated on the same evidence the execution is gated on, read the
       * other way round. It needs a badge that nobody is contesting, a square
       * that is not already doubting them, and no cell history suggesting the
       * killing stops when this one is locked up.
       *
       * Once per prisoner, and never while there is an execution pending on
       * them: a seat does not introduce itself to somebody it is about to empty.
       */
      const heldId = captiveOf(state, botId);
      const held = heldId ? state.players[heldId] : null;
      const mine = this.minds.mind(state, botId);
      if (held && mine && !mine.namedSelfTo?.includes(held.playerId)) {
        const board = this.minds.board(state, botId);
        const cellNow = jailChannel(state.day, botId);
        const told = readRoom(state, cellNow, 0).claimed;
        const contested =
          told !== null &&
          (board.claims.some(
            (claim) =>
              claim.kind === 'role-claim' &&
              claim.claimedRole === told.role &&
              claim.claimerSlot !== held.slot &&
              board.aliveSlots.includes(claim.claimerSlot)
          ) ||
            [...board.deadRoles.values()].includes(told.role));
        const doubted = suspicion(held.slot, self, board, () => 0.5) + cellProves(mine.brain, held.slot);

        /**
         * Standing the record handed this seat, not standing it asked for.
         *
         * The gate above this one was written as four refusals — a role was
         * named, nobody else claims it, nobody is shouting about them, and the
         * role is a town one — and every single one of them is satisfied by a
         * stranger who has just said a word. That is the whole failure: on the
         * third night of a real game a Jailor asked "what are you", heard "I am
         * Bus Driver" two seconds later, and answered with his own name and
         * badge. The seat he handed them to was the Witch. His trust meter read
         * exactly zero for that seat at the moment he spoke, because on night
         * three no trial had resolved yet and the meter reads nothing else.
         *
         * An absence of evidence passed a test that should need evidence. So
         * the claim now has to be backed by something the prisoner could not
         * simply say: either a voting record that has earned it, on the same
         * meter and at the same bar the rest of the policy treats as real trust,
         * or a role the graveyard and the dawn reports have already settled on
         * them. Both are things the table produced, and neither can be produced
         * in the cell on demand.
         *
         * This deliberately makes the reveal a mid-game move rather than an
         * opening one, which is what it always should have been: before the
         * first trial resolves there is nothing at this table that can vouch
         * for anybody, so there is nothing for a Jailor to read and no safe
         * moment to spend his name. What it keeps is the case it exists for, a
         * Doctor that has stood up in the square and been right about somebody,
         * walking out of the cell finally knowing who to defend.
         */
        const proven = board.provenRoles.get(held.slot) ?? null;
        const earned = trustOf(held.slot, board) >= 1 || (proven !== null && ROLES[proven].faction === 'town');

        /**
         * And nothing the deduction pass can already see through.
         *
         * `deductions` is the same reader that catches a badge the deal cannot
         * contain, a visit to a house whose owner was alive, or two seats in
         * one cell. The cell never asked it anything, so a prisoner could hand
         * the Jailor a story the rest of the board had already refuted.
         */
        const seenThrough = deductions(held.slot, board).length > 0;

        const trusted =
          told !== null && !contested && earned && !seenThrough && doubted < 0.6 && ROLES[told.role].faction === 'town';
        if (trusted) {
          (mine.namedSelfTo ??= []).push(held.playerId);
          return t(
            vary('mafia.bot.jail.trust', 3, botId + ':trust:' + state.day, {
              who: self.name,
              role: ROLE.name(told.role)
            })
          );
        }
      }

      /**
       * The threat, only while there is one.
       *
       * "I can kill you from here" and "I have one execution" were two of the twelve questions and came up whatever
       * was left in the jailor's hand — so a Jailor who had spent all three went on promising a lever he could not
       * pull, and a prisoner who called the bluff by waking up alive had caught the phrasebook rather than the player.
       */
      if (self.charges > 0 && hashCode(botId + ':threat:' + state.day) % 4 === 0) {
        return t(vary('mafia.bot.jail.threat', 3, botId + ':threat:' + state.day));
      }
      return t(vary('mafia.bot.jail.ask', 12, botId + ':ask:' + state.day));
    }

    const mind = this.minds.mind(state, botId);
    if ((mind?.brain.personality.claimRate ?? 0) < 0.2) {
      return t(vary('mafia.bot.jail.silent', 3, botId + ':cell:' + state.day));
    }

    const town = ROLES[self.role].faction === 'town';
    const claimed = town ? self.role : mind ? this.maskOf(state, botId, mind) : this.bluffRole(state, botId);
    if (!claimed) return t(vary('mafia.bot.jail.plead.home', 3, botId + ':cell:' + state.day));

    const nameOf = (slot: number): string =>
      Object.values(state.players).find((player) => player.slot === slot)?.name ?? String(slot);

    // A night's work, named, is the strongest thing a prisoner has.
    const work = town ? me.intel.find((entry) => entry.kind === 'sheriff' || entry.kind === 'visitors') : undefined;
    if (work) {
      return t(
        vary('mafia.bot.jail.plead.work', 3, botId + ':cell:' + state.day, {
          role: ROLE.name(claimed),
          night: work.night,
          who: nameOf(work.targetSlot)
        })
      );
    }

    // Otherwise: the claim, and a reason to be let out rather than emptied.
    const useful = town && ROLES[claimed].nightAction !== undefined;
    return t(
      vary(useful ? 'mafia.bot.jail.plead.offer' : 'mafia.bot.jail.plead.role', 3, botId + ':cell:' + state.day, {
        role: ROLE.name(claimed)
      })
    );
  }

  /**
   * What one of the family says to the rest, in the dark.
   *
   * Two things, because those are the two things a real player types in that
   * channel: the house they want and the reason they want it, and — when the
   * square spent the afternoon looking at one of their own — a warning about
   * tomorrow. The reasoning is the point. A family chat reading "Tonight: 14."
   * three nights running tells the human in it nothing it could disagree with,
   * and disagreeing is the whole reason the channel exists.
   */
  /**
   * The house this family's knife is pointed at, as submitted.
   *
   * Read off `nightActions` rather than recomputed, because the submitted
   * target is the only one that is true: everything else is a draw from a
   * policy that deliberately varies. The seat's own knife is read first when it
   * has one, since that is the one this turn could still change its mind about;
   * otherwise it is whichever brother is holding it tonight.
   *
   * Null means nothing has been committed yet, which is an honest answer early
   * in the night and the reason a seat with no knife sometimes has nothing to
   * propose.
   */
  /**
   * One brother's contribution to the lodge, which is intel rather than orders.
   *
   * Three things in order of worth: the Master naming tonight's initiate, which
   * the others need to know so they do not accuse a seat that is about to be one
   * of them; the strongest read this seat has with the reason attached, which is
   * the whole point of a room whose members trust each other; and, failing both,
   * silence, because a lodge repeating "nothing to report" every night is worse
   * than a quiet one.
   */
  private lodgeLine(
    state: MafiaState,
    botId: string,
    view: MafiaView,
    board: PublicInfo,
    recruit: number | null
  ): string | null {
    const self = state.players[botId];
    const me = view.me;
    if (!self || !me) return null;
    const t = say(spokenLocale(state));
    const nameOf = (slot: number): string =>
      Object.values(state.players).find((player) => player.slot === slot)?.name ?? String(slot);
    const salt = botId + ':lodge:' + state.day;

    if (self.role === 'mason-leader') {
      const said = this.knockLine(state, botId, board, recruit, nameOf, salt);
      if (said) return said;
    }

    /**
     * The seat this brother would hang tomorrow, and what it has against them.
     *
     * Read through `why`, so a brother can only pass on something the board
     * actually holds — the lodge is a room where nothing is doubted, which
     * makes an invented reason cost more here than anywhere else in the game.
     */
    const rng = this.rng;
    const worst = board.aliveSlots
      .filter((slot) => slot !== me.slot)
      .filter((slot) => {
        const seat = Object.values(state.players).find((player) => player.slot === slot);
        return !!seat && !isMason(seat);
      })
      .map((slot) => ({ slot, score: suspicion(slot, self, board, rng) }))
      .sort((left, right) => right.score - left.score)[0];

    if (worst && worst.score >= 1) {
      const why = this.why(state, view, board, worst.slot, botId);
      return t(
        why
          ? vary('mafia.bot.lodge.watch', 3, salt, { who: nameOf(worst.slot), why })
          : vary('mafia.bot.lodge.plain', 3, salt, { who: nameOf(worst.slot) })
      );
    }
    return null;
  }

  /**
   * What the Master tells the lodge about its door: last night's, the brothers' request, tonight's.
   *
   * Three things the lodge used to be told one way or not at all:
   *
   *  - **What last night's knock found.** Nothing was ever said about it, so a
   *    door that stayed shut (a killer, a neutral, a town power) was a finding
   *    only the Master held, and it died with him. Said once, at the first word
   *    of the next night, and filed in the lodge as a doubt about that house.
   *  - **What became of a brother's request.** See `steerKnock`.
   *  - **What tonight's knock is for.** Every knock went out as "X joins us
   *    tonight. Do not put them on the stand", including the ones the policy
   *    aims at its top suspect to see whether the door opens, so the lodge was
   *    told to shield the seat its Master doubted most (`9RVWV`, a Mass
   *    Murderer). A test is now said as a test.
   */
  private knockLine(
    state: MafiaState,
    botId: string,
    board: PublicInfo,
    recruit: number | null,
    nameOf: (slot: number) => string,
    salt: string
  ): string | null {
    const self = state.players[botId];
    const mind = this.minds.mind(state, botId);
    if (!self || !mind) return null;
    const t = say(spokenLocale(state));
    const parts: string[] = [];

    const last = mind.named?.night === state.day - 1 ? mind.named.slot : null;
    if (last !== null && mind.reportedKnock !== state.day - 1) {
      const seat = Object.values(state.players).find((player) => player.slot === last);
      if (seat?.alive && isMason(seat)) {
        parts.push(t(vary('mafia.bot.lodge.joined', 3, salt, { who: nameOf(last) })));
      } else if (seat?.alive && (self.refused ?? []).includes(last)) {
        parts.push(t(vary('mafia.bot.lodge.shut', 3, salt, { who: nameOf(last) })));
        this.minds.record(state, botId, 'hint', last, { room: 'mason' });
      }
      mind.reportedKnock = state.day - 1;
    }

    const asked = mind.knockAsk?.night === state.day ? mind.knockAsk : null;
    if (asked && !(asked.kind === 'ask' && asked.granted && asked.slot === recruit)) {
      const key = asked.kind === 'spare' ? 'mafia.bot.lodge.spared' : ASK_ANSWER[asked.why ?? 'declined'];
      parts.push(t(vary(key, 3, salt, { who: nameOf(asked.slot) })));
    }

    if (recruit !== null && recruit !== self.slot) {
      const granted = asked?.kind === 'ask' && asked.granted && asked.slot === recruit;
      // The policy's own rule, so the lodge is told what the knock really is. See `knockIsTest`.
      const brothers = new Set(
        Object.values(state.players)
          .filter((player) => player.alive && player.playerId !== botId && isMason(player))
          .map((player) => player.slot)
      );
      const testing = !granted && knockIsTest(self, board, recruit, brothers);
      parts.push(
        t(
          vary(
            granted ? 'mafia.bot.lodge.asked' : testing ? 'mafia.bot.lodge.test' : 'mafia.bot.lodge.recruit',
            3,
            salt,
            { who: nameOf(recruit) }
          )
        )
      );
    }
    return parts.length > 0 ? parts.join(' ') : null;
  }

  private familyKnife(state: MafiaState, botId: string): number | null {
    const self = state.players[botId];
    const family = self ? playerFamily(self) : null;
    if (!self || !family) return null;

    const holders = Object.values(state.players).filter(
      (player) =>
        player.alive && playerFamily(player) === family && legalNightAction(state, player.playerId)?.type === 'kill'
    );
    const ordered = holders.sort((left, right) => (left.playerId === botId ? -1 : right.playerId === botId ? 1 : 0));

    for (const holder of ordered) {
      const committed = state.nightActions[holder.playerId]?.targetId;
      const target = committed ? state.players[committed] : null;
      if (target?.alive) return target.slot;
    }
    return null;
  }

  private familyLine(
    state: MafiaState,
    botId: string,
    view: MafiaView,
    board: PublicInfo,
    aim: number | null,
    ask: { slot: number; who: string } | null = null,
    heeded = false,
    /** This seat's own errand tonight, when it is not the one holding the knife. */
    job: number | null = null,
    /** Why the request was turned down, when it was. See `judgeRequest`. */
    refusal: RequestRefusal | null = null
  ): string | null {
    const t = say(spokenLocale(state));
    const me = view.me;
    if (!me) return null;

    /**
     * Somebody may be listening, so the family stops naming things.
     *
     * The knife is unaffected — the target is chosen by the brain and submitted
     * to the engine, and none of that goes through the chat — so this costs the
     * family nothing except the habit of announcing its plans in a room a
     * town role can hear. Which is the habit that was losing them games: a
     * transcript from a real table has the family naming its target, its
     * reasons and a teammate's house number, over and over, on a board where
     * the Spy role was in play.
     *
     * The warning is said once per table by whoever gets there first, and then
     * this room is quiet for the rest of the game.
     */
    if (spyMayListen(view, board)) {
      const room = me.channels.find((channel) => channel.id !== 'day' && channel.id !== 'dead')?.id;

      /**
       * A teammate talking to this seat is answered whatever the discipline —
       * with nothing in the answer worth overhearing.
       *
       * The silence was written for the unsolicited target line, and it
       * swallowed the human's question with it: this returned null, the caller
       * returned an empty decision before ever looking at what had been said,
       * and a person sitting in the family room got nothing back for the whole
       * game. On a chaos or census table every role is listed, so the Spy is
       * always possible there and that was every such game. Answering people is
       * the first thing these bots are for; the discipline is about *what* goes
       * in the answer, and these lines have no name, number or role in them.
       */
      if (ask) {
        const key = heeded ? 'mafia.bot.family.hush.agree' : 'mafia.bot.family.hush.refuse';
        return t(vary(key, 3, botId + ':hush:' + state.day));
      }
      const since = view.phaseStartedAt ?? 0;
      const fresh =
        room !== undefined &&
        state.chat.messages.some(
          (message) =>
            message.channel === room &&
            message.at >= since &&
            !!message.authorId &&
            message.authorId !== botId &&
            state.players[message.authorId]?.isBot === false
        );
      if (fresh) return t(vary('mafia.bot.family.hush.reply', 3, botId + ':hush:' + state.day));

      // Nobody asked anything, so this would be the target line: the one thing the discipline exists to stop.
      if (familyDiscipline(state.code) === 'quiet') return null;
      const already = state.chat.messages.some((message) => message.channel === room && message.msg?.k === HUSH);
      return already ? null : t(msg(HUSH));
    }
    const nameOf = (slot: number): string =>
      Object.values(state.players).find((player) => player.slot === slot)?.name ?? String(slot);

    /**
     * Somebody in the room asked for a house, so the answer comes first.
     *
     * Before anything this seat had planned to say: a proposal that ignores the
     * question it was asked is the whole complaint. Yes or no, in the same
     * breath as the reason, and the knife has already been pointed to match.
     */
    if (ask) {
      const mates = new Set([me.slot, ...(me.teammates ?? []).map((mate) => mate.slot)]);
      if (heeded) {
        return t(vary('mafia.bot.family.agree', 6, botId + ':yes:' + ask.slot, { who: ask.who }));
      }
      // A refusal with a reason about that house says the reason, not this seat's own preference.
      if (refusal) {
        return t(vary(`mafia.bot.family.refuse.${refusal}`, 3, botId + ':fam:' + state.day, { who: ask.who }));
      }
      const why = aim === null ? null : this.whyKill(state, view, board, aim, mates, botId);
      return aim === null
        ? t(vary('mafia.bot.family.refuse.plain', 3, botId + ':fam:' + state.day, { who: ask.who }))
        : t(
            why
              ? vary('mafia.bot.family.refuse.why', 3, botId + ':fam:' + state.day, {
                  who: ask.who,
                  mine: nameOf(aim),
                  why
                })
              : vary('mafia.bot.family.refuse.mine', 3, botId + ':fam:' + state.day, {
                  who: ask.who,
                  mine: nameOf(aim)
                })
          );
    }

    /**
     * A wagon that formed on one of ours today.
     *
     * Said in preference to the night's proposal roughly a third of the time,
     * because a family that only ever discusses killing and never once mentions
     * that a brother is about to be hanged is not paying attention.
     */
    const mates = new Set([me.slot, ...(me.teammates ?? []).map((mate) => mate.slot)]);
    const heat = [...mates]
      .map((slot) => ({ slot, votes: view.players.find((player) => player.slot === slot)?.votesAgainst ?? 0 }))
      .sort((left, right) => right.votes - left.votes)[0];
    if (heat && heat.votes >= 2 && hashCode(botId + ':warn:' + state.day) % 3 === 0) {
      return t(
        vary('mafia.bot.family.warn', 3, botId + ':warn:' + state.day, { count: heat.votes, who: nameOf(heat.slot) })
      );
    }

    /**
     * Nothing to propose, but something to report.
     *
     * The family's knife is not this seat's to point, and saying nothing at all
     * is how a room of four ends up with one voice in it. What it *has* is its
     * own night, which is real, checkable by tomorrow and nobody else's to
     * announce.
     */
    /**
     * The cellar is on the roster, not in the room's one line.
     *
     * A keeper used to announce its captive here, which was right about the
     * fact and wrong about the place: the family reads the roster while it
     * plans, the captive holds all night whether or not anybody was listening
     * when it was said, and a line spent on it is a line not spent on the
     * knife. It rides on the ally row instead — see `allyIntent` in the view,
     * which now reports the cell rather than an empty night.
     */

    if (aim === null) {
      if (job === null || job === me.slot) return null;
      return t(vary('mafia.bot.family.mine', 3, botId + ':job:' + state.day, { who: nameOf(job) }));
    }
    const why = this.whyKill(state, view, board, aim, mates, botId);
    const who = nameOf(aim);
    const salt = botId + ':aim:' + state.day + ':' + aim;
    return why
      ? t(vary('mafia.bot.family.aim', 9, salt, { who, why }))
      : t(vary('mafia.bot.family.plain', 6, salt, { who }));
  }

  /**
   * The house a person in this family asked for tonight, if anybody did.
   *
   * Deliberately not the ear: that reads the square with a model, files claims
   * on a public board, and would leak a family's private words into every bot's
   * reasoning. This reads one room, for one thing, with no model at all — a
   * request in a family channel is nearly always a number or a name, and the
   * cost of being wrong is one night's knife rather than a rewritten board.
   *
   * Newest line first, and only tonight's: yesterday's argument was settled by
   * yesterday's corpse. Family members are not candidates, so "not 13, take 10"
   * cannot be turned into a request to knife a brother, and neither can a slip
   * of the fingers.
   */
  /**
   * A teammate naming the same house again after this seat said no to it.
   *
   * Only a new line from a person counts, since this seat's own turns run more
   * than once a night and must not read their own refusal as an insistence.
   */
  private askedAgain(state: MafiaState, mind: BotMind, room: string | null, slot: number): boolean {
    if (!room) return false;
    const refused = mind.refusals?.find((entry) => entry.day === state.day && entry.slot === slot);
    if (!refused) return false;
    return state.chat.messages.some(
      (message) =>
        message.channel === room &&
        message.id > refused.upTo &&
        !!message.authorId &&
        state.players[message.authorId]?.isBot === false
    );
  }

  /** Remembers a refusal, and what the family room had said by then. See `askedAgain`. */
  private noteRefusal(state: MafiaState, mind: BotMind, room: string | null, slot: number): void {
    if (!room) return;
    const refusals = (mind.refusals ??= []);
    if (refusals.some((entry) => entry.day === state.day && entry.slot === slot)) return;
    const upTo = state.chat.messages.reduce(
      (last, message) => (message.channel === room ? Math.max(last, message.id) : last),
      0
    );
    refusals.push({ day: state.day, slot, upTo });
  }

  /**
   * The Mason Leader's knock, steered by the lodge.
   *
   * A brother's house becomes the knock when the door can still open: not a
   * brother already, not a door that has stayed shut to this lodge, and a
   * house the power can reach tonight. A person's request is granted on those
   * terms alone; another bot's goes through the same willingness as a family's
   * (see `willHeed`). A house a brother refused is left alone whenever there is
   * anywhere else to knock. Whatever happened to the request is kept on the
   * mind, so the line in the lodge can say it.
   */
  private steerKnock(
    state: MafiaState,
    botId: string,
    view: MafiaView,
    mind: BotMind,
    aim: NightAim,
    rng: () => number
  ): number | null {
    const { aimable: targets, chosen: decided, board, brain, allies } = aim;
    const self = state.players[botId];
    if (!self) return decided;
    const room = this.teamAsk(state, botId, view, 'mason');
    const shut = new Set(self.refused ?? []);
    const spared = new Set((room?.spared ?? []).map((entry) => entry.slot));
    const elsewhere = targets.filter((target) => !spared.has(target) && !allies.has(target));
    const own =
      decided !== null && spared.has(decided) && elsewhere.length > 0
        ? decideNightTarget(self, brain, board, elsewhere, 'recruit', new Set(allies), self.intel, rng)
        : decided;

    const ask = room?.ask ?? null;
    if (ask) {
      const why = !targets.includes(ask.slot) || allies.has(ask.slot) ? 'reach' : shut.has(ask.slot) ? 'shut' : null;
      const granted =
        why === null &&
        (ask.human || willHeed(mind, ask.fromSlot, seededRoll(botId + ':knock:' + state.day + ':' + ask.slot), false));
      mind.knockAsk = { night: state.day, slot: ask.slot, kind: 'ask', granted, why };
      if (granted) return ask.slot;
    } else if (decided !== null && spared.has(decided) && own !== decided) {
      mind.knockAsk = { night: state.day, slot: decided, kind: 'spare', granted: true, why: null };
    }
    const promised =
      mind.named?.night === state.day && targets.includes(mind.named.slot) && !spared.has(mind.named.slot)
        ? mind.named.slot
        : null;
    return promised ?? own;
  }

  /**
   * What a living teammate asked for tonight, in a family's room or in the lodge.
   *
   * The lodge was never read: only a killing hand took the override, so the one
   * room where a person sits *with* the Mason Leader was a room the Leader could
   * not hear. On `9RVWV` a brother answered the night's pick with "no", "not
   * him" and "go for hulk", and the knock went to the seat he had refused, a
   * Mass Murderer, announced as a brother to protect.
   */
  private teamAsk(state: MafiaState, botId: string, view: MafiaView, family: string | null): RoomAsks | null {
    const self = state.players[botId];
    if (!self || !family || state.phase !== 'night') return null;

    // Only what a living brother said, and only tonight. A dead teammate's
    // last request is not an order, and the room's own reasoning is not news.
    const since = phaseWindow(state);
    const mates = new Set([self.slot, ...(view.me?.teammates ?? []).map((mate) => mate.slot)]);
    const read = readRoom(state, family, since, mates, self.slot);

    /**
     * The model's reading of the same room, when it has one and it is current.
     *
     * Current means two things: taken this phase, and covering the last line
     * anybody typed. A pass from before the newest sentence is a reading of a
     * conversation that has moved on, and the regex has already read the whole
     * of it. Family seats are filtered out of it here rather than in the pass,
     * because who counts as a brother is the reader's question and not the
     * room's.
     */
    const latest = state.chat.messages.reduce(
      (last, message) =>
        message.channel === family && message.at >= since && message.authorId && !state.players[message.authorId]?.isBot
          ? Math.max(last, message.id)
          : last,
      0
    );
    const heard = this.deps.roomHeard(`${state.code}|${family}`);
    const fresher =
      heard && heard.day === state.day && heard.phase === state.phase && heard.upTo >= latest ? heard.asks : null;
    const modelled: RoomAsks | null = fresher
      ? {
          ask: fresher.ask && !mates.has(fresher.ask.slot) ? fresher.ask : null,
          spared: fresher.spared.filter((entry) => !mates.has(entry.slot)),
          claimed: fresher.claimed
        }
      : null;

    const best = modelled && (modelled.ask || modelled.spared.length > 0) ? modelled : read;
    return best.ask || best.spared.length > 0 ? best : null;
  }

  /**
   * Why that house and not another, in the family's own terms.
   *
   * A different axis entirely from `why`: the square asks who is guilty, and
   * the family asks who is dangerous. A loud, believed, role-claiming seat is
   * the answer to the second question whether or not it is the answer to the
   * first — which is also why a mafioso arguing this out loud in the square
   * would be confessing.
   */
  private whyKill(
    state: MafiaState,
    view: MafiaView,
    board: PublicInfo,
    targetSlot: number,
    mates: ReadonlySet<number>,
    botId = ''
  ): Msg | null {
    const nameOf = (slot: number): string =>
      Object.values(state.players).find((player) => player.slot === slot)?.name ?? String(slot);
    /** Same reason, this seat's words for it. */
    const salt = botId + ':why-kill:' + targetSlot;

    // 1. They put a name to themselves, which is the same as putting a price on it.
    const claimed = board.claims.find((claim) => claim.kind === 'role-claim' && claim.claimerSlot === targetSlot);
    if (claimed?.claimedRole) {
      return vary('mafia.bot.family.why.claimed', 3, salt, { role: ROLE.name(claimed.claimedRole) });
    }

    // 2. They are doing the town's actual work: clearing people and reporting.
    const working = board.claims.some(
      (claim) => claim.claimerSlot === targetSlot && (claim.kind === 'clear' || claim.kind === 'sighting')
    );
    if (working) return vary('mafia.bot.family.why.talker', 3, salt);

    // 3. The square believes them, which is worse than what they know.
    if (claimerWeight(targetSlot, board) >= 1.5) return vary('mafia.bot.family.why.trusted', 3, salt);

    // 4. They spent the day hunting one of us.
    const hunted = [...board.votes.entries()].find(([voter, target]) => voter === targetSlot && mates.has(target));
    if (hunted) return vary('mafia.bot.family.why.pushing', 3, salt, { who: nameOf(hunted[1]) });

    return view.day >= 2 ? vary('mafia.bot.family.why.quiet', 3, salt) : null;
  }

  /**
   * The seat under a wagon, answering it.
   *
   * Two different sentences, and which one it gets depends on whether the room
   * has actually said anything about it. A specific accusation gets a specific
   * denial — naming the accuser, which drags them into saying what they have —
   * and a wagon that formed in silence gets a demand to be told why, because
   * that is the only move available to somebody accused of nothing.
   */
  private answerWagon(state: MafiaState, botId: string, view: MafiaView, board: PublicInfo, against: number): string {
    const t = say(spokenLocale(state));
    const me = view.me;
    const nameOf = (slot: number): string =>
      Object.values(state.players).find((player) => player.slot === slot)?.name ?? String(slot);

    const about = me
      ? board.claims.find(
          (claim) =>
            claim.day === state.day &&
            (claim.kind === 'sighting' || claim.kind === 'accuse') &&
            claim.targetSlot === me.slot
        )
      : undefined;

    /**
     * The wagon's own size is in the salt, so answering it twice says two
     * different things.
     *
     * A seat now speaks up on the first vote and may speak again as the pile
     * grows, and both lines used to come out of the same hash of id and day —
     * the identical sentence, which the room's no-repeats rule then swallowed,
     * so the second answer was simply never heard. Keyed on the count as well,
     * a seat under three votes phrases it differently from the same seat under
     * one, which is also how a person sounds as the afternoon turns on them.
     */
    const salt = botId + ':deny:' + state.day + ':' + against;
    if (about && me) {
      const who = nameOf(about.claimerSlot);
      const reason = this.denyWhy(state, me.slot, about, board, botId, against);
      return t(
        reason
          ? vary('mafia.bot.deny.why', 6, salt, { who, why: reason })
          : vary('mafia.bot.deny.plain', 6, salt, { who })
      );
    }
    return t(vary('mafia.bot.pressure', 12, salt));
  }

  /**
   * Why the thing said about this seat is wrong — from the board, or not at all.
   *
   * The denial used to be six fixed sentences and one of the six was "I never
   * left my house", picked by a hash of the bot's id. A seat that had spent the
   * night on somebody's doorstep, and had *said so* an hour earlier, denied a
   * sighting by contradicting its own filed account: the board then caught it
   * out for a lie it had never decided to tell, and every seat reading the
   * board reasoned from it. An accidental lie is worse than a deliberate one,
   * because nobody chose it and nobody can be rewarded for catching it.
   *
   * So a denial cites something or it cites nothing. In order of what a room
   * actually finds convincing: this seat's own standing account (which is the
   * only alibi it is entitled to repeat, because it already gave it), then the
   * accuser's own record — caught out once, silent about their own nights, or
   * simply alone in saying it. Null when none of those hold, and then the plain
   * form does the work: it denies, and it demands a night and a house.
   */
  private denyWhy(
    state: MafiaState,
    mySlot: number,
    about: Claim,
    board: PublicInfo,
    botId: string,
    against = 1
  ): Msg | null {
    const nameOf = (slot: number): string =>
      Object.values(state.players).find((player) => player.slot === slot)?.name ?? String(slot);
    // The wagon's size is in here too, so a second answer to the same accuser
    // is the same fact in different words rather than the same sentence twice.
    const salt = botId + ':dw:' + state.day + ':' + about.claimerSlot + ':' + against;

    /* 1. What I have already told the square, quoted back by me. Only the
          account actually on the board: inventing one here is the whole bug. */
    const mine = this.lastAccount(board, mySlot);
    if (mine?.account === 'home') return vary('mafia.bot.denyWhy.toldHome', 3, salt);
    if (mine?.account === 'visited') {
      return vary('mafia.bot.denyWhy.toldVisited', 3, salt, { house: nameOf(mine.targetSlot) });
    }

    /* 2. The accuser, caught in their own story. */
    if (contradicted(about.claimerSlot, board)) return vary('mafia.bot.denyWhy.theirCaught', 3, salt);

    /* 3. The accuser, who has never said where they were. */
    const theirs = board.claims.some((claim) => claim.kind === 'account' && claim.claimerSlot === about.claimerSlot);
    if (!theirs) return vary('mafia.bot.denyWhy.theirSilence', 3, salt);

    /* 4. One voice and no second one. Weakest of the four, and true often
          enough on the first accusation of a day to be worth saying. */
    const echoes = board.claims.filter(
      (claim) =>
        claim.targetSlot === mySlot &&
        claim.claimerSlot !== about.claimerSlot &&
        (claim.kind === 'sighting' || claim.kind === 'accuse')
    );
    return echoes.length === 0 ? vary('mafia.bot.denyWhy.alone', 3, salt) : null;
  }

  /**
   * Rewrites this seat's will, every dawn, with everything it has learned.
   *
   * A corpse's will is how the town learns what a dead investigator knew, and it
   * was written once on the first day and never touched again: a Sheriff who
   * spent five nights checking people died with a will that said nothing but
   * "I told you what I knew while I could". The one night that mattered was the
   * last one, and the last one was never in there.
   *
   * So it is rebuilt rather than appended to, which comes to the same thing on
   * screen and is far safer: appending needs to know what is already in the text
   * and would duplicate a line on any retry, while the intel list *is* the
   * record and rendering all of it is idempotent. A player editing a bot's will
   * is not a thing that can happen, so there is nothing of anybody else's to
   * preserve.
   *
   * Rendered from `IntelEntry`, which is the same structured feed the private
   * notifications spell out for a human, so a bot's will cannot assert anything
   * the engine did not actually give it.
   */
  updateWill(state: MafiaState, botId: string, tonight: number | null = null): void {
    const self = state.players[botId];
    const mind = this.minds.mind(state, botId);
    if (!self?.role || !mind) return;

    const t = say(spokenLocale(state));
    const nameOf = (slot: number): string =>
      Object.values(state.players).find((player) => player.slot === slot)?.name ?? String(slot);
    /**
     * The line at the bottom, chosen against what is above it.
     *
     * Three of the nine point upwards — "Everything I had is above", "I told you what I knew", "I was wrong about
     * plenty" — and a Citizen with no power, no findings and nothing written down dies with a will that is that
     * sentence and nothing else, pointing at a blank page. The other six stand on their own, so they are what a bare
     * will gets. Picked below, once there is something to weigh it against.
     *
     * Literal tuples, here and on the shelf below, so `mafia.bot.will.${n}` is a
     * key the compiler checks rather than a number it has to take on trust.
     */
    const STANDS_ALONE = [2, 4, 5, 6, 8, 9] as const;

    /**
     * Whose will this is, and whose nights it lists.
     *
     * An honest seat, town or passenger, signs with its real role and writes
     * every night it worked: a will is the one place where hoarding buys
     * nothing, and the most useful corpse is the most verbose one. A liar with
     * any appetite for it writes the will of the role it is pretending to be,
     * nights included, from the same invented notebook it quotes on the stand
     * and in the cell; see `fakeIntel` and `maskOf`. A liar without the stomach
     * leaves the flavour line alone, which is what every evil seat used to
     * leave regardless, and what made a bot's will worthless as evidence of
     * anything: a clean will was a town will, every time.
     */
    /**
     * Honesty is a fact about the seat that wrote the notes, not about the
     * badge it is wearing now.
     *
     * An audit rewrites `role` in place, so this flipped a Survivor into a
     * Scumbag — passenger to parasite — and the truthful notebook it had been
     * keeping all game was thrown away and replaced with a liar's. The nights
     * in it were real. What changed was the seat's powers and the side it wins
     * with, and neither of those makes yesterday's record a lie.
     *
     * Read off the dealt badge, so a seat that was town when it wrote its
     * record still signs a true one. See `MafiaPlayer.roleBefore`.
     */
    const dealt = self.roleBefore ?? self.role;
    const honest = ROLES[dealt].faction === 'town' || mind.agenda === 'passenger';
    const mask = honest ? null : this.maskOf(state, botId, mind);
    const signed: RoleId | null = honest ? dealt : mask && mind.brain.personality.deceit > 0.35 ? mask : null;
    const record: readonly IntelEntry[] = honest
      ? self.intel
      : signed
        ? this.fakeIntel(state, botId, signed, state.day)
        : [];

    /**
     * The nights, oldest first, because a will is read as a record.
     *
     * `realNight` reads newest first for the opposite reason: said out loud, the
     * freshest check is the one that moves a room.
     */
    /**
     * One line per night, not two.
     *
     * The engine files a `went` entry for every journey and, separately, the
     * result the power came back with, so an investigator's will read "Night 1:
     * I went to Chucky." and then "Night 1: nobody went near Chucky." — the same
     * night twice, out of a budget that has room for about a dozen lines. The
     * journey line is kept only for nights that produced nothing else, which is
     * what it was added for: a Doctor who healed nobody still says where it
     * stood, and a corpse still names the porch it died on.
     */
    const written = record
      .map((entry) => ({ entry, line: this.nightLine(state, entry, botId) }))
      .filter((row): row is { entry: IntelEntry; line: string } => row.line !== null);
    /**
     * Only a night that actually says something counts as already reported.
     *
     * Measured against a real game: an Escort's night filed a `blocked` entry
     * and a `went` entry, the first had no sentence, so the second was dropped
     * as redundant against a line that was never written, and its will came out
     * empty. A night is covered when a *rendered* line covers it.
     */
    const reported = new Set(written.filter((row) => row.entry.kind !== 'went').map((row) => row.entry.night));
    const kept = written.filter((row) => row.entry.kind !== 'went' || !reported.has(row.entry.night));

    /**
     * And the nights somebody else spent for this seat: a cell, or a blocker.
     *
     * Copied off `disturbedNight` while it still says so, because the engine
     * overwrites it the next time. An honest seat writes it down, since it is
     * the one fact that explains a night with no result, and a record missing it
     * is how a jailed seat ended up quoted as having visited somebody that night.
     */
    if (self.disturbedNight && (self.disturbedBy === 'jail' || self.disturbedBy === 'block')) {
      const held = (mind.heldIn ??= []);
      if (!held.some((entry) => entry.night === self.disturbedNight)) {
        held.push({ night: self.disturbedNight, by: self.disturbedBy });
      }
    }
    const heldRows = !honest
      ? []
      : (mind.heldIn ?? [])
          .filter((entry) => !reported.has(entry.night))
          .map((entry) => ({
            night: entry.night,
            line: t(
              vary(
                entry.by === 'jail' ? 'mafia.bot.dump.inCell' : 'mafia.bot.dump.keptHome',
                3,
                botId + ':held:' + entry.night,
                {
                  night: entry.night
                }
              )
            )
          }));
    const nights = [...kept.map((row) => ({ night: row.entry.night, line: row.line })), ...heldRows]
      .sort((left, right) => left.night - right.night)
      .map((row) => row.line)
      // One night can file the same result twice (a poison purged and a knife stopped on one door), and it is one line.
      .filter((line, index, all) => all.indexOf(line) === index);

    /**
     * Which nights the record has now answered for, so the plan can stop.
     *
     * The intent lines below exist for one night only — the one currently being
     * spent, which the seat will not survive to write up if it dies in it. They
     * were rendered for *every* night the seat had ever left the house, and
     * nothing ever took one back down once the morning turned it into a real
     * record. So every night ended up in the will twice, in two different
     * voices, and the second half read as a separate itinerary:
     *
     *   Night 2: I was at Mikasa.          <- the record
     *   ...
     *   Tonight I am going to Mikasa.      <- the plan, eight days stale
     *
     * A real Doctor's will came out of a game with eight nights written twice
     * over, nine lines of record followed by nine lines of plan, and the second
     * block still saying "tonight" about night two. It reads as a bot that
     * cannot remember what it has already said, and it spends the will's budget
     * twice over on the same nights, pushing the notes off the bottom.
     */
    // A night in a cell or held at home answers for itself: the plan never happened.
    const recorded = new Set([...kept.map((row) => row.entry.night), ...heldRows.map((row) => row.night)]);

    /**
     * Where this seat is about to go, written down before it goes.
     *
     * The record of a journey is made by the engine when the night resolves,
     * and a seat that does not survive the night never takes another turn to
     * copy it into its will. So the one night a will most needs to mention,
     * the last one, was structurally the one it could never contain: the
     * Sheriff that walked onto the Veteran's porch died with a will that said
     * nothing about the porch. A person writes "N3: visiting 4" before leaving
     * the house, and so does this. Honest seats only: a liar's destination is
     * the family's business.
     */
    /**
     * Every night this seat left the house, not just tonight.
     *
     * Read off `mind.went`, which keeps them, rather than off the `tonight`
     * argument, which only exists on the turn that chose a target. Built from the
     * argument, the line appeared on that turn and vanished on the next one, so a
     * seat's will gained and lost the same night repeatedly and the town read
     * whichever version happened to be current when it died.
     *
     * Oldest first, like the rest of the record. A will is read from night one.
     */
    /**
     * A night at home is not a journey, and must not be written as one.
     *
     * The Veteran's alert and the Survivor's vest visit nobody: the only slot
     * the engine has to hand for either is the seat's own, so filed as a trip
     * they produced a will that named its own author as the house it was going
     * to. What the town wants from those two roles is which *night* the power
     * was spent, which is what the record below says instead.
     */
    const homebound = staysHome(dealt);

    if (honest && tonight !== null && state.phase === 'night') {
      if (homebound) {
        if (!mind.stayedIn.includes(state.day)) mind.stayedIn.push(state.day);
      } else if (tonight !== self.slot && !mind.went.some((trip) => trip.night === state.day)) {
        mind.went.push({ night: state.day, slot: tonight });
      }
    }

    /**
     * The Veteran's porch for the Veteran only. Every other seat whose power keeps it home (a Jailor, a
     * Coroner, an Amnesiac) wrote "Night 11: alert, and I stayed in" (`9RVWV`), which is the one badge it
     * does not hold, read out from its own will.
     */
    const powerAction = ROLES[dealt].nightAction;
    const powerKey = powerAction === 'vest' ? 'onVest' : powerAction === 'alert' ? 'onAlert' : 'atHome';

    const going = !honest
      ? []
      : homebound
        ? [...mind.stayedIn]
            .filter((night) => !recorded.has(night))
            .sort((left, right) => left - right)
            .map((night) => t(vary(`mafia.bot.dump.${powerKey}`, 3, botId + ':home:' + night, { night })))
        : [...mind.went]
            .filter((trip) => !recorded.has(trip.night))
            .sort((left, right) => left.night - right.night)
            .map((trip) =>
              t(
                /**
                 * "Tonight" only while it is that night.
                 *
                 * A night with no record of its own (a blocked Detective, a
                 * Mason Leader whose knock came to nothing) kept its plan line
                 * for the rest of the game: "Tonight I am going to Gollum" was
                 * still in a will six nights later, and a Mason Leader on trial
                 * on day 4 read "Tonight, Doc Brown" off his, about night 2,
                 * which the room took as a visit on the night he was in a cell.
                 */
                vary(
                  trip.night === state.day && state.phase === 'night' ? 'mafia.bot.dump.going' : 'mafia.bot.dump.meant',
                  3,
                  botId + ':going:' + trip.night,
                  { night: trip.night, who: nameOf(trip.slot) }
                )
              )
            );

    /**
     * The journal: who this seat thought was lying, day by day, and where it
     * turned out to be wrong. Appended to and never rewritten, which is how a
     * person keeps one: "Day 5: I was wrong about 4" under "Day 3: 4 is lying"
     * is worth more to whoever reads it than a will that quietly forgot.
     */
    /**
     * The whole journal, not the last six entries.
     *
     * A will is the one place hoarding buys nothing, and a seat that dies on day
     * nine should leave nine days of it. `fitWill` still decides what fits in the
     * space available; deciding it twice, once here with an arbitrary six and
     * again there with a real budget, only ever threw away the oldest entries —
     * which are the ones nobody else can still remember.
     */
    const notes = mind.notes.map((note) =>
      t(
        vary(`mafia.bot.will.note.${note.kind}`, 3, botId + ':note:' + note.slot, {
          day: note.day,
          who: nameOf(note.slot)
        })
      )
    );

    const bare = !signed && nights.length === 0 && notes.length === 0 && going.length === 0;

    /**
     * Two seats never file the same will word for word.
     *
     * A will that says nothing else is a role line and a closing line, drawn
     * from three phrasings and nine phrasings — twenty-seven possible wills, and
     * a table with four liars on it holds six pairs. The birthday arithmetic
     * says a game produces an exact duplicate about one time in five, and a real
     * game did: two seats died claiming the same role in the same sentence,
     * with the same line under it. Nobody reading that thinks "coincidence",
     * they think "these two are the same thing", and they are right for entirely
     * the wrong reason.
     *
     * It is not something the seats can be asked to avoid — a will is private
     * until its author is dead, so no bot can legitimately know what another one
     * wrote. It is the *writer's* problem, so it is solved here: the closing
     * line is drawn, and if that exact text is already sitting in somebody
     * else's drawer, the next phrasing is drawn instead. Invisible to the table,
     * and the only thing it costs is that two seats occasionally get each
     * other's second choice of closing line.
     */
    const filed = new Set(
      Object.values(state.players)
        .filter((player) => player.playerId !== botId && player.lastWill)
        .map((player) => player.lastWill)
    );
    const shelf = bare ? STANDS_ALONE : ([1, 2, 3, 4, 5, 6, 7, 8, 9] as const);
    /**
     * And a signature that tells the room what happened to it.
     *
     * "I am the Citizen", written above five nights of a Sheriff's checks, reads
     * to the whole table as a fabricated will — which is how an audited seat
     * gets its real record thrown out. The honest sentence is the one the seat
     * would actually write: this is what I was, this is what I am now, and
     * somebody did it to me. It costs the Auditor nothing it was promised — the
     * powers are gone and the reveal still shows the new badge — and it stops
     * the audit silently destroying evidence the town had already paid for.
     */
    /**
     * How the badge changed, read off the seat's own history of rewrites rather
     * than guessed from the badge. See `willStory`.
     */
    const story = honest ? willStory(self) : null;
    const roleLine = !signed
      ? null
      : story
        ? t(
            vary(`mafia.bot.will.${story.key}`, 3, botId + ':will', {
              was: ROLE.name(story.was ?? signed),
              now: ROLE.name(self.role)
            })
          )
        : t(vary('mafia.bot.will.role', 3, botId + ':will', { role: ROLE.name(signed) }));
    /**
     * Kept for the stand, which is the one place this record is worth more
     * alive than dead. See `BotMind.willNights`.
     */
    mind.willNights = [...nights, ...going];

    const draft = (offset: number): string =>
      fitWill({
        role: roleLine,
        nights,
        going,
        notes,
        flavour: t(msg(`mafia.bot.will.${shelf[(hashCode(botId) + offset) % shelf.length]}`))
      });

    let text = draft(0);
    for (let offset = 1; offset < shelf.length && filed.has(text); offset++) text = draft(offset);
    // Nothing new to say: a will that has not changed is not rewritten, which is
    // what makes calling this once a turn free.
    if (self.lastWill === text) return;
    this.deps.will(state.code, botId, text);
  }

  /**
   * Hello, from a seat that intends to be heard later.
   *
   * No house number in it any more: the chat puts the number beside the name on
   * every line now, so "House 5. Morning, everyone." was announcing something
   * the reader could already see, twice.
   */
  private greeting(state: MafiaState, botId: string): string {
    const t = say(spokenLocale(state));
    return t(vary('mafia.bot.hello', 12, botId));
  }

  /**
   * Two seconds at the stand, or from the bench beside it.
   *
   * From the bench it is a mutter and always was. On the stand it used to be a
   * mutter too — "Look at who wants me gone, and ask yourselves why" is a fine
   * line to have in reserve and a terrible one to have *only*, because it is
   * the same sentence whether the seat is an innocent Doctor with two saves
   * behind it or a Mafioso with nothing.
   *
   * A defence is now built out of what this seat actually holds, strongest
   * first: a liar in the crowd pushing the wagon, a night's work it can name, a
   * role worth claiming, the account it already gave. A guilty seat reaches for
   * the same shelf and finds a role it is not — which is the bluff, and which
   * the town can call, because the role list is public and somebody else may
   * hold that card.
   */
  private defenceLine(
    state: MafiaState,
    botId: string,
    onTrial: boolean,
    round = 1
  ): { text: string; claim: Decision['claim']; verbatim?: boolean } | null {
    const t = say(spokenLocale(state));
    if (!onTrial) return { text: t(vary('mafia.bot.watch', 9, botId)), claim: null };

    const view = toMafiaView(state, { kind: 'player', playerId: botId });
    const board = this.minds.board(state, botId);
    const mind = this.minds.mind(state, botId);
    const me = view.me;
    const self = state.players[botId];
    const plead = (): { text: string; claim: Decision['claim']; verbatim?: boolean } => ({
      text: t(vary('mafia.bot.plead', 9, botId)),
      claim: null
    });
    if (!me || !self?.role || !mind) return plead();

    const nameOf = (slot: number): string =>
      Object.values(state.players).find((player) => player.slot === slot)?.name ?? String(slot);
    const town = ROLES[self.role].faction === 'town';

    /**
     * "I am muted." — and then nothing.
     *
     * A seat that has said nothing all day, dragged to the stand, may claim the
     * gag and stop there: a muted person does not say a second thing, so rounds
     * two and three are silence, which is the whole performance. The engine
     * says the same sentence for a seat that really is gagged, so the room
     * cannot tell the two apart by the words. Only a liar reaches for it, only
     * when a role that gags people could still be at the table, and only
     * sometimes — a defence made of one sentence is a defence that forgoes the
     * role claim and the night, which is a real price.
     */
    if (mind.mutedBluffDay === state.day) return null;
    if (round === 1 && !town) {
      const spokeToday = board.claims.some((claim) => claim.claimerSlot === me.slot && claim.day === state.day);
      if (
        !spokeToday &&
        couldStillAct('silence', board) &&
        hashCode(botId + ':mute:' + state.day) % 4 === 0 &&
        mind.brain.personality.deceit > 0.4
      ) {
        mind.mutedBluffDay = state.day;
        return { text: t(vary('mafia.bot.muted', 3, botId + ':mute:' + state.day)), claim: null };
      }
    }

    /* -------- round one: what you are. Truthfully, or the best lie going. ---- */
    if (round === 1) {
      /**
       * The badge its record is made of.
       *
       * A Sheriff initiated into the lodge read out two days of checks and then
       * told the stand "The Mason. I know it proves nothing": two badges in one
       * trial, and the room hanged it for the contradiction.
       */
      const initiated = self.role === 'mason' && self.roleBefore ? self.roleBefore : null;
      const claimed = town ? (initiated ?? self.role) : this.maskOf(state, botId, mind);
      /**
       * The claim goes on the board, which is the entire point of saying it.
       *
       * Round one of a defence used to produce a sentence and nothing else — no
       * claim filed — so `defenceStrength` looked at the accused's record, found
       * they had asserted nothing today, and gave them no credit. Every bot
       * defended itself out loud and was judged as though it had stayed silent.
       *
       * Filing it also makes the bluff *cost* something: a role claim can be
       * contradicted by a living rival or by the graveyard, and `suspicion`
       * punishes both. An evil seat lying on the stand now takes a real risk,
       * and an honest one gets a real reward.
       */
      if (claimed) {
        return {
          /**
           * Two of the three phrasings threaten the room with what it is about
           * to lose, and a role with no power is no loss. A Citizen saying "hang
           * me and the town loses its Citizen" is the tell, not the defence. See
           * `bluffRole`, which now prefers a badge that has something to lose.
           */
          text: t(
            vary(
              ROLES[claimed].nightAction === null ? 'mafia.bot.defend.rolePlain' : 'mafia.bot.defend.role',
              3,
              botId + ':stand:' + state.day,
              { role: ROLE.name(claimed) }
            )
          ),
          claim: { kind: 'role-claim', slot: null, role: claimed }
        };
      }
      return plead();
    }

    /* -------- round two: the nights. Real ones, or a manufactured one. ------- */
    if (round === 2) {
      // An account of the night is a claim like any other, and the one thing a
      // sighting can catch out later. It names the house actually visited, so
      // the porch and a lookout's list have something to check it against.
      // Real for the town, from the record; invented for a liar, from the same
      // notebook its will is written from, so the stand and the will agree.
      const entry = town ? this.realNight(state, me.intel, botId) : this.inventedNight(state, botId, view);
      const dump = entry ? this.nightLine(state, entry, botId) : null;
      if (entry && dump) return { text: dump, claim: this.claimFor(entry, me.slot, board.rolesInPlay) };
      /**
       * Nothing to read out, so the seat falls back on where it was.
       *
       * On the account it has already given, if it has given one: filing a
       * fresh "I stayed home" over this afternoon's "I was at 4" is a seat
       * arguing with itself on the stand, which is the one thing no innocent
       * and no competent liar ever does.
       */
      const told = this.lastAccount(board, me.slot);
      if (told?.account === 'visited') {
        /**
         * Naming the night, because the account may not be about last night.
         *
         * `lastAccount` is the latest one on the board and nothing says it was
         * given today: a seat that admitted a visit on day two and has been
         * quiet since stood up on day five and said "I was at 4 last night" —
         * an alibi for a night it had never spoken about, contradicting its own
         * record in the same breath it cited it. A claim filed on day D is an
         * account of night D − 1, so that is the night it says.
         */
        return {
          text: t(
            vary('mafia.bot.defend.visited', 3, botId + ':stand:' + state.day, {
              who: nameOf(told.targetSlot),
              night: told.night ?? Math.max(1, told.day - 1)
            })
          ),
          claim: null
        };
      }
      /**
       * The claim filed here is "I stayed home", so the sentence says that.
       *
       * It used to read out `dump.nothing` — "no findings, nothing to report" —
       * while quietly filing an alibi the seat had never spoken. The board then
       * held an account nobody at the table had heard, and a lookout could
       * "catch" this seat contradicting a story it never told. Whatever goes on
       * the board is said out loud, in the words the board will be checked
       * against.
       */
      return {
        text: t(vary('mafia.bot.stayedHome', 9, botId + ':stand:' + state.day)),
        claim: { kind: 'account', slot: null, role: null, account: 'home' }
      };
    }

    /* ---- round three: the record itself, in the seat's own written words. --- */
    /**
     * The will, read out while it can still do the seat some good.
     *
     * A bot rewrites its will every dawn out of everything it holds, and by the
     * time the room drags it to the stand that is the most complete and most
     * consistent account of itself it will ever have — and it was going
     * unspoken, because a will is private until its author is dead. So the
     * closing round reads it out. It is what a person does on a stand: they
     * paste their will.
     *
     * Deliberately `verbatim`, which takes the model out of the loop entirely.
     * These sentences were written by the phrasebook out of structured entries,
     * they already agree with each other, and every one of them has a night and
     * a house in it. There is nothing a model can add to that and one thing it
     * can do to it, which is exactly what it did: asked to "be specific" with
     * none of this in front of it, it invented specifics instead.
     *
     * Trimmed to the chat's own limit rather than the will's: a will may run to
     * 1400 characters and a line in the square may not. Oldest first, because a
     * record is read from night one, and the cut falls at the end — a room that
     * wants the rest can ask.
     */
    const recital = mind.willNights;
    if (recital.length > 0) {
      /**
       * Composed against the limit that is actually applied, which was 380
       * against a clamp of 210.
       *
       * The recital packs whole nights up to its own ceiling and `apply` then
       * clips whatever arrives to `CLAMP_CHARS` — so every will longer than a
       * couple of nights reached the square cut mid-word with an ellipsis on
       * it. From a chaos run: "Nuit 4, Amaterasu : aucune visite. Nuit 1 : c'est
       * chez…", which is a seat on the stand reading out its own record and
       * being cut off by its own software in front of the room about to hang
       * it.
       *
       * This is the same mistake `CASE_CHARS` was written to fix one screen
       * away, with the reasoning spelled out there: two different limits on one
       * sentence means the composer fills a space the speaker does not have.
       * A whole night dropped reads as a short record; half a night reads as a
       * crash.
       */
      const said: string[] = [];
      let spent = 0;
      for (const line of recital) {
        if (spent + line.length + 1 > CLAMP_CHARS) break;
        said.push(line);
        spent += line.length + 1;
      }
      // One night that does not fit is a line worth truncating; none at all is
      // not worth saying.
      if (said.length === 0) said.push(clip(recital[0], CLAMP_CHARS));
      return { text: said.join(' '), claim: null, verbatim: true };
    }

    /**
     * "{who} started this" — said, at last, about the seat that actually did.
     *
     * The sentence was already in both catalogues and it was pointed at the
     * wrong person: whichever voter on the wagon the room had written off. That
     * is a different complaint ("nobody should be listening to them") wearing
     * the words of this one, and on an afternoon where the discredited seat had
     * joined a wagon somebody else built, it was simply false.
     *
     * A wagon looks identical from the inside however it was built — eight
     * votes, and no way to tell the seat that made the case from the seven who
     * agreed with it. The engine recorded the order all along and nothing read
     * it. Now the accused can name the first name on the wagon and hand the
     * room a question, which is what a person in that chair does and the only
     * move that changes an afternoon.
     *
     * The old reading stays as the fallback, because a discredited voice
     * pushing a rope is still worth pointing at, and only worth pointing at
     * once the wagon is a wagon: with one vote on the board "the votes followed
     * them" is a seat arguing with one person and calling it a mob.
     */
    const riding = [...board.votes.values()].filter((target) => target === me.slot).length;
    const opener = riding >= 2 ? wagonOpener(me.slot, board) : null;
    const discredited = [...board.votes.entries()].find(
      ([voter, target]) => target === me.slot && claimerWeight(voter, board) === 0
    );
    const blame = opener !== null && opener !== me.slot ? opener : riding >= 2 ? (discredited?.[0] ?? null) : null;
    if (blame !== null) {
      return {
        text: t(vary('mafia.bot.defend.accuser', 3, botId + ':stand:' + state.day, { who: nameOf(blame) })),
        claim: null
      };
    }

    /**
     * The latest account, not the first one.
     *
     * This read the earliest thing the seat had ever said about a night, so a
     * defence that had just read out "Night 5: I went to Baloo" closed with "I
     * never left my house" — the afternoon's answer, three rounds stale, and a
     * flat contradiction of the sentence before it. Reported from a real table.
     */
    const account = this.lastAccount(board, me.slot);
    if (account?.account === 'visited') {
      return {
        text: t(
          vary('mafia.bot.defend.visited', 3, botId + ':stand:' + state.day, {
            who: nameOf(account.targetSlot),
            night: account.night ?? Math.max(1, account.day - 1)
          })
        ),
        claim: null
      };
    }
    /**
     * "I stayed home" is not worth saying twice.
     *
     * Round two has just said it, in those words, and a defence whose last
     * sentence restates its previous one sounds like a seat with one card and
     * no idea what to do with it. Naming the house you admit visiting is
     * different: it is a fact the room can go and check. A closing line beats a
     * repetition.
     */

    return {
      text: t(
        vary(
          hashCode(botId) % 2 === 0 ? 'mafia.bot.dump.closing' : 'mafia.bot.defend.nothing',
          3,
          botId + ':stand:' + state.day
        )
      ),
      claim: null
    };
  }

  /**
   * What the room is looking at, so a vague line has a referent.
   *
   * People do not talk in house numbers. They say "the sheriff", or ask "what
   * did you do last night" of nobody in particular and mean whoever everybody
   * is already staring at. Handed only a list of names, the reader resolves
   * neither and files nothing — which is how a player asking the Town Crier
   * what it had said on night two got no answer at all: the line was read, no
   * house was found in it, and the crier never learned it had been asked.
   */
  squareOf(state: MafiaState): Square {
    const board = this.minds.board(state);
    const claimed = new Map<number, string>();
    for (const claim of board.claims) {
      if (claim.kind === 'role-claim' && claim.claimedRole) {
        claimed.set(claim.claimerSlot, ROLES[claim.claimedRole].name);
      }
    }
    const tally = new Map<number, number>();
    for (const target of board.votes.values()) tally.set(target, (tally.get(target) ?? 0) + 1);
    let mostVoted: number | null = null;
    let best = 0;
    for (const [slot, count] of tally) {
      if (count > best) {
        best = count;
        mostVoted = slot;
      }
    }
    const accused = state.trial ? state.players[state.trial.accusedId] : null;
    return {
      claimed: [...claimed].map(([slot, role]) => ({ slot, role })),
      onTrial: accused?.slot ?? null,
      mostVoted
    };
  }

  /**
   * The line of a dead player's will that names one particular house.
   *
   * A bot citing a will should be able to read it out, the way a person does:
   * not "the sheriff's will accuses you" but the sentence itself, the one the
   * whole square scrolled past at dawn. It is the most checkable thing anybody
   * can say in this game, because every seat can scroll back up and see whether
   * the quote is honest.
   *
   * Three guards, and the middle one is the load-bearing one:
   *
   *  - the author has to be dead, because a living seat's will is private;
   *  - the corpse must not have been **cleaned**. A janitor takes the will with
   *    the face, the room never saw it, and a bot quoting one would be reading
   *    out a document that does not publicly exist. The engine applies exactly
   *    this test before announcing it (see `record.hidden`), and so does this;
   *  - the line has to name the house, found with the same reader the square
   *    uses, so a will that mentions somebody by nickname still matches.
   *
   * Returns the line trimmed to something sayable, or null, in which case the
   * caller says the shorter sentence that names no quote.
   */
  private willLine(state: MafiaState, deadSlot: number, targetSlot: number): string | null {
    const author = Object.values(state.players).find((player) => player.slot === deadSlot);
    if (!author || author.alive || !author.lastWill) return null;
    const grave = state.deaths.find((death) => death.playerId === author.playerId);
    if (!grave || grave.hidden) return null;

    const seats = Object.values(state.players).map((player) => ({ slot: player.slot, name: player.name }));
    for (const line of author.lastWill.split(/[\n\r]+/).slice(0, 12)) {
      const said = line.trim();
      if (said.length < 4) continue;
      if (!seatHits(said, seats).some((hit) => hit.slot === targetSlot)) continue;
      return clip(said, WILL_QUOTE_CHARS);
    }
    return null;
  }

  /**
   * The last thing this seat told the square about one of its nights.
   *
   * Ordered, because an account is a running story: what a seat said this
   * afternoon is what it is held to now, and the first thing it ever said is
   * only of interest to whoever is trying to catch it out.
   */
  private lastAccount(board: PublicInfo, slot: number): Claim | undefined {
    return [...board.claims].reverse().find((claim) => claim.kind === 'account' && claim.claimerSlot === slot);
  }

  /**
   * One night's work, said out loud, from the record the engine actually kept.
   *
   * `IntelEntry` is the structured half of the private feed — the same facts the
   * notifications spell out for a human — so a bot reading it out is not
   * inventing anything, and everything it says can be checked against what the
   * rest of the table saw. Most recent first: a check from last night moves a
   * room that a check from day one does not.
   */
  private realNight(state: MafiaState, intel: readonly IntelEntry[], botId = ''): IntelEntry | null {
    return [...intel].reverse().find((entry) => this.nightLine(state, entry, botId) !== null) ?? null;
  }

  /**
   * One night's work as one sentence, or null when that kind of intel has no
   * sentence to be said in.
   *
   * Split out of `realNight` so the will can render every entry while a spoken
   * dump still renders only the freshest. Same keys, so a seat's will and its
   * testimony cannot disagree about what it saw.
   */
  private nightLine(state: MafiaState, entry: IntelEntry, botId = ''): string | null {
    const t = say(spokenLocale(state));
    const nameOf = (slot: number): string =>
      Object.values(state.players).find((player) => player.slot === slot)?.name ?? String(slot);

    const who = nameOf(entry.targetSlot);
    /** Same night, same words, whenever this seat reads it out. */
    const salt = botId + ':night:' + entry.night + ':' + entry.kind + ':' + entry.targetSlot;
    /**
     * Who the dawn after that night buried.
     *
     * Read off the state rather than the board because this renders wills as
     * well as testimony, and a will has no viewer. The set is public either
     * way: every night death is announced with its night.
     */
    const buried = new Set(
      state.deaths
        .filter((death) => death.phase === 'night' && death.day === entry.night)
        .map((death) => state.players[death.playerId]?.slot)
        .filter((slot): slot is number => slot !== undefined)
    );
    const fell = (slot: number): boolean => buried.has(slot);
    switch (entry.kind) {
      case 'sheriff': {
        if (!sheriffSuspects(entry.value)) {
          return t(vary('mafia.bot.dump.clear', 3, salt, { night: entry.night, who }));
        }
        /**
         * What the needle said, not merely that it moved.
         *
         * "Bad" is a shrug the room argues about for a day; "a member of the
         * Mafia" is a name, a threat level and an instruction. The verdict is
         * already in the notebook — see `SheriffVerdict` — and reading it out
         * as a shrug threw away the whole point of finding it.
         */
        const named = verdictName(entry.value);
        return t(
          named
            ? vary('mafia.bot.dump.named', 3, salt, { night: entry.night, who, what: named })
            : vary('mafia.bot.dump.suspect', 3, salt, { night: entry.night, who })
        );
      }
      case 'role': {
        if (!(entry.value in ROLES)) return null;
        // A role read off a body that was already in the ground when the night
        // fell is an autopsy, and it says so: the Coroner does not "find out"
        // what a corpse is the way a Consigliere finds out what a neighbour is.
        const corpse = state.deaths.some(
          (death) =>
            state.players[death.playerId]?.slot === entry.targetSlot &&
            (death.day < entry.night || (death.day === entry.night && death.phase === 'day'))
        );
        return t(
          vary(corpse ? 'mafia.bot.dump.autopsy' : 'mafia.bot.dump.role', 3, salt, {
            night: entry.night,
            who,
            role: ROLE.name(entry.value as RoleId)
          })
        );
      }
      /**
       * The Investigator's smell, with the shortlist it narrows to.
       *
       * `entry.value` is the trade's identifier, so it renders in whatever
       * language the table speaks — the reason this used to be left out no
       * longer holds. The shortlist is cut to the roles this table can contain,
       * because that is the list the room will cross-reference against.
       */
      case 'trade': {
        const board = botId ? this.minds.board(state, botId) : null;
        const pool = board?.rolesInPlay;
        const shortlist = tradeSuspects(entry.value, pool);
        /**
         * Nothing found is its own sentence.
         *
         * `tradeSuspects` returns nothing for the quiet line, because a quiet
         * line narrows nothing: every seat that stayed in produces it. It used
         * to be read out with the three harmless badges that wear it, which
         * turned "I found nothing" into "they are a Citizen, a Survivor or an
         * Amnesiac" and handed the room an exoneration the power had refused
         * to give. See `tradeVerdict`, which has always refused it too.
         */
        if (shortlist.length === 0) {
          return entry.value === QUIET_TRADE
            ? t(vary('mafia.bot.dump.quiet', 3, salt, { night: entry.night, who }))
            : null;
        }
        return t(
          vary('mafia.bot.dump.trade', 3, salt, {
            night: entry.night,
            who,
            line: tradeLine(entry.value),
            roles: shortlist.map((role) => t(ROLE.name(role))).join(', ')
          })
        );
      }
      /**
       * A night's page, crossed with the morning after it.
       *
       * A Lookout's list on a house that died is a shortlist of killers; a tail
       * that ended at the corpse's door is a finger pointing. The join is public
       * arithmetic — the record says who called, the report says who died — and
       * the sentence says both and infers nothing out loud.
       */
      case 'visitors': {
        const callers = entry.slots ?? [];
        const key =
          callers.length > 0
            ? fell(entry.targetSlot)
              ? 'mafia.bot.dump.visitorsDead'
              : 'mafia.bot.dump.visitors'
            : fell(entry.targetSlot)
              ? 'mafia.bot.dump.nobodyDead'
              : 'mafia.bot.dump.nobody';
        return t(vary(key, 3, salt, { night: entry.night, who, slots: callers.map(nameOf).join(', ') }));
      }
      case 'tracked': {
        /**
         * Where the tail ended, which is the finding.
         *
         * Every tail that did not end at a corpse said "went out, I followed" and
         * nothing else, including the ones that never went out at all, so a
         * Detective's will was a list of seats that "left" and the square hanged
         * an Escort and a Doctor for having left.
         */
        const houses = entry.slots ?? [];
        const house = houses.find(fell);
        if (house !== undefined) {
          return t(vary('mafia.bot.dump.trackedDead', 3, salt, { night: entry.night, who, house: nameOf(house) }));
        }
        return houses.length === 0
          ? t(vary('mafia.bot.dump.trackedHome', 3, salt, { night: entry.night, who }))
          : t(vary('mafia.bot.dump.tracked', 3, salt, { night: entry.night, who, house: nameOf(houses[0]) }));
      }
      case 'saved':
        return t(vary('mafia.bot.dump.saved', 3, salt, { night: entry.night, who }));
      case 'went':
        return t(
          vary(fell(entry.targetSlot) ? 'mafia.bot.dump.wentDead' : 'mafia.bot.dump.went', 3, salt, {
            night: entry.night,
            who
          })
        );
      /**
       * The three nights that produced no verdict but did produce a fact.
       *
       * A quiet night explained by an Escort who held somebody, a Bus Driver's
       * pair, a Spy's overheard target: all of it is checkable against the dawn
       * report, and none of it had a sentence, so an Escort's will said it had
       * done nothing for five nights. The Arsonist's marks and the
       * Investigator's trade line stay out — the first belongs to a seat that
       * never signs a will, and the second is prose in one language.
       */
      case 'blocked': {
        const [corpse] = [...buried];
        return corpse !== undefined
          ? t(vary('mafia.bot.dump.blockedDead', 3, salt, { night: entry.night, who, house: nameOf(corpse) }))
          : t(vary('mafia.bot.dump.blocked', 3, salt, { night: entry.night, who }));
      }
      /**
       * The cell, which is the one night's work in this game with a witness.
       *
       * The jailor kept no record until now and so had nothing to sign, which
       * left the only badge the room can corroborate with the thinnest will at
       * the table. A prisoner that reached for something is the evidence an
       * execution is meant to rest on, so it is said apart.
       */
      case 'jailed': {
        /**
         * And what the prisoner said, which is the half the town can use.
         *
         * `quiet` means only that no power was used, and it was written "He sat
         * quiet" about a Godfather who had answered "The Vigilante" on the very
         * night the real Vigilante died. The claim was the evidence, and the will
         * dropped it. A badge named in the cell comes first; then silence; then
         * whether a power was reached for.
         */
        const prisoner = Object.values(state.players).find((player) => player.slot === entry.targetSlot);
        const cell = jailChannel(entry.night, botId);
        const said = prisoner
          ? state.chat.messages.filter((message) => message.channel === cell && message.authorId === prisoner.playerId)
          : [];
        const badge = said.map((message) => selfClaim(message.text)).find((role) => role !== null) ?? null;
        if (badge) {
          return t(vary('mafia.bot.dump.jailedClaimed', 3, salt, { night: entry.night, who, role: ROLE.name(badge) }));
        }
        if (prisoner && said.length === 0) {
          return t(vary('mafia.bot.dump.jailedSilent', 3, salt, { night: entry.night, who }));
        }
        return t(
          vary(entry.value === 'tried' ? 'mafia.bot.dump.jailedTried' : 'mafia.bot.dump.jailedQuiet', 3, salt, {
            night: entry.night,
            who
          })
        );
      }
      /**
       * The Witch's experiment, and its result.
       *
       * The only role that learns by doing rather than by looking, so its will
       * is the only one that can say "I know that seat has a knife because I
       * put it in somebody's back myself". Said only when the destination
       * actually fell, because an empty hand is barely worth the line and a
       * redirection with nobody dead proves nothing at all.
       */
      case 'controlled': {
        const [destination] = entry.slots ?? [];
        if (entry.value === 'idle') {
          return t(vary('mafia.bot.dump.controlledIdle', 3, salt, { night: entry.night, who }));
        }
        if (destination === undefined || !fell(destination)) return null;
        return t(
          vary('mafia.bot.dump.controlledKill', 3, salt, {
            night: entry.night,
            who,
            house: nameOf(destination)
          })
        );
      }
      case 'swapped': {
        // Everything aimed at one house arrived at the other, so a death at one
        // names the other as the intended target. See the bus in the engine.
        const [first, second] = entry.slots ?? [entry.targetSlot];
        if (first !== undefined && second !== undefined) {
          const dead = fell(first) ? first : fell(second) ? second : undefined;
          if (dead !== undefined) {
            const other = dead === first ? second : first;
            return t(
              vary('mafia.bot.dump.swappedDead', 3, salt, {
                night: entry.night,
                who: nameOf(dead),
                house: nameOf(other)
              })
            );
          }
        }
        return t(
          vary('mafia.bot.dump.swapped', 3, salt, {
            night: entry.night,
            slots: (entry.slots ?? [entry.targetSlot]).map(nameOf).join(' & ')
          })
        );
      }
      case 'spied':
        return t(
          vary(fell(entry.targetSlot) ? 'mafia.bot.dump.spiedDead' : 'mafia.bot.dump.spiedLived', 3, salt, {
            night: entry.night,
            who
          })
        );
      default:
        return null;
    }
  }

  /**
   * The same thing, made up, which is what an evil seat on a stand actually does.
   *
   * Two constraints make it a lie worth telling rather than noise. It clears
   * somebody instead of accusing them — a fabricated accusation invites the
   * target to answer, and a fabricated clearing invites them to agree — and it
   * clears one of the family by preference, which buys a second seat a day of
   * cover out of the same sentence. The night named is a real night, so the
   * arithmetic holds up.
   */
  private inventedNight(state: MafiaState, botId: string, view: MafiaView): IntelEntry | null {
    const me = view.me;
    const mind = this.minds.mind(state, botId);
    if (!me || !mind || view.day < 2) return null;
    const mask = this.maskOf(state, botId, mind);
    if (!mask) return null;

    const board = this.minds.board(state, botId);
    /**
     * Nights this seat has already sworn it spent at home.
     *
     * An account filed on day D is about night D-1, and a seat that told the
     * square "I never left my house" and then reads out "Night 5: I went to
     * Baloo" has been caught by nobody but itself. The room does not need a
     * lookout for that one: it was both halves of the same afternoon.
     */
    const athome = new Set(
      board.claims
        .filter((claim) => claim.kind === 'account' && claim.claimerSlot === me.slot && claim.account === 'home')
        .map((claim) => claim.day - 1)
    );
    const notebook = this.fakeIntel(state, botId, mask, state.day).filter((entry) => !athome.has(entry.night));

    // The page about somebody this seat is actually accusing, if there is one;
    // the freshest page otherwise.
    const accused = new Set(
      board.claims
        .filter((claim) => claim.kind === 'accuse' && claim.claimerSlot === me.slot)
        .map((claim) => claim.targetSlot)
    );
    return [...notebook].reverse().find((entry) => accused.has(entry.targetSlot)) ?? notebook.at(-1) ?? null;
  }

  /**
   * A role this seat is not, that this table could plausibly contain.
   *
   * Drawn from the deal — the same list every player can read in the top right
   * corner — minus anything already claimed by somebody else and minus the
   * roles a dead body has already accounted for. A bluff has to be a role that
   * could still be sitting here; anything else is a confession with extra steps.
   */
  private bluffRole(state: MafiaState, botId: string): RoleId | null {
    const self = state.players[botId];
    if (!self) return null;
    const board = this.minds.board(state, botId);

    const spoken = new Set(
      board.claims.filter((claim) => claim.kind === 'role-claim').map((claim) => claim.claimedRole)
    );
    const buried = new Set(board.deadRoles.values());
    /**
     * And badges the living record has already signed for.
     *
     * `provenRoles` is not what anybody *claims*: it is what the graveyard and
     * the dawn reports have settled — the seat whose accusation hanged a
     * mafioso, the porch the Veteran shot somebody on. Wearing one of those is
     * a bluff with a witness, and the witness is the whole table.
     */
    const worn = new Set(board.provenRoles.values());

    const candidates = [...claimableRoles(state)].filter(
      (role): role is RoleId =>
        role in ROLES &&
        role !== self.role &&
        wearableMask(role as RoleId) &&
        !spoken.has(role as RoleId) &&
        !buried.has(role as RoleId) &&
        !worn.has(role as RoleId)
    );
    /**
     * The badge that does what this seat already does, first of all.
     *
     * A Consort spends its nights holding somebody at home, which is an
     * Escort's night exactly; a Kidnapper takes a seat out of the evening and
     * talks to it in a cell, which is the Jailor's night exactly. Wearing the
     * twin means the liar has no second life to keep straight: every true thing
     * it did is a true thing the mask does, so the cell, the stand and the will
     * agree without anybody having to invent anything, and the record has
     * nothing to catch it on.
     *
     * Subject to every filter above, which is the whole of "if it is still
     * possible and nobody has taken it": the roster has to allow it, the
     * graveyard must not hold it, and no living seat may already be wearing it.
     * `twinMasks` can name more than one, so the best-ranked free one wins.
     */
    const twin = (self.role === null ? [] : twinMasks(self.role))
      .filter((role) => candidates.includes(role))
      .sort((left, right) => maskRank(right) - maskRank(left))[0];
    if (twin) return twin;

    /**
     * And, now and then, a badge that is not the town's at all.
     *
     * "I am just trying to see the end of this" is the Survivor's claim, and it
     * is the one non-town sentence that still buys mercy: it explains being
     * quiet, explains being useless, and asks the room for the one thing it
     * costs nothing to give. It is deliberately occasional — a table where
     * every cornered killer is a Survivor has learned the tell in one evening —
     * and it is drawn on the same fixed hash as the rest, so a seat that
     * reaches for it reaches for it consistently all game.
     */
    if (
      claimableRoles(state).has('survivor') &&
      !spoken.has('survivor') &&
      !buried.has('survivor') &&
      !worn.has('survivor') &&
      self.role !== 'survivor' &&
      hashCode(botId + ':survivor') % 6 === 0
    ) {
      return 'survivor';
    }

    if (candidates.length === 0) return null;

    /**
     * Otherwise the best-ranked face still free, and the rank is the argument.
     *
     * This used to ask only whether a role was town and unclaimed, so the
     * Citizen was as good a lie as the Doctor — and it is the worst one
     * available. `defenceStrength` prices it at 0.08 against 0.4 precisely
     * because "I am a citizen" survives every check and proves nothing, so the
     * safest lie in the game bought its teller almost nothing. Worse on the
     * stand, where it produced "Hang me and the town loses its Citizen", which
     * is a sentence with no threat in it at all.
     *
     * `maskRank` puts a powered badge above a bare one and the four cheaply
     * checkable ones — Coroner, Crier, Mayor, Marshall — below both. They are
     * still reachable, because a seat with nothing else left should say
     * something rather than stand there, and because any of them is the right
     * lie on some afternoon.
     */
    const ranked = candidates.map((role) => maskRank(role));
    const best = Math.max(...ranked);
    const pool = candidates.filter((role) => maskRank(role) === best);
    return pool[hashCode(botId + ':bluff') % pool.length];
  }

  /**
   * The face this seat wears when it is not wearing its own.
   *
   * The role it has claimed in public, when it has: a liar is held to what it
   * said. Otherwise a bluff chosen once and pinned on the mind, so the story
   * told in the cell, on the stand and in the will is the same story. It used
   * to be drawn afresh at each of those places and could differ between them,
   * which is the one mistake a real liar never makes.
   */
  private maskOf(state: MafiaState, botId: string, mind: BotMind): RoleId | null {
    const self = state.players[botId];
    if (!self) return null;
    const board = this.minds.board(state, botId);
    let spoken: RoleId | null = null;
    for (const claim of board.claims) {
      if (claim.kind === 'role-claim' && claim.claimerSlot === self.slot && claim.claimedRole)
        spoken = claim.claimedRole;
    }
    if (spoken) {
      mind.mask = spoken;
      return spoken;
    }

    /**
     * A face picked on day one can be taken off you on day three.
     *
     * The mask was pinned with `??=` and then never looked at again, which is
     * right for the thing it was guarding against — a liar whose story changes
     * between the cell, the stand and the will is a liar everybody catches —
     * and wrong for everything else. `bluffRole` checks the claims board, the
     * graveyard and the proven badges *at the moment it is called*, and that
     * moment is usually the first afternoon, when nobody has claimed anything.
     *
     * Then a real Bus Driver says so out loud on day three, and this seat is
     * still carrying "bus-driver" from before he spoke. Its will, filed on the
     * night it dies, signs a role a living townsperson has been claiming for
     * two days. Which is what happened: a corpse arguing with a live claim it
     * never heard.
     *
     * Nothing has been said out loud yet — that is the branch above — so the
     * face costs nothing to put down. It is redrawn whenever somebody else has
     * taken it, been buried in it, or been credited with it by the record.
     */
    if (mind.mask && this.faceTaken(board, self, mind.mask)) mind.mask = null;
    /**
     * A converted seat already has a face: the badge it held before.
     *
     * Its record is full of that badge's nights, and the room may have heard
     * about them. A Sheriff the cult took had told the square "I checked Casper
     * and he came back Cult", and then signed its will "The Citizen", which is
     * the one signature every line it had said already contradicted.
     */
    if (!mind.mask) {
      const before = self.intel.map((entry) => FORMER_BADGE[entry.kind]).find((role) => role !== undefined);
      if (before && !this.faceTaken(board, self, before)) mind.mask = before;
    }
    mind.mask ??= this.bluffRole(state, botId);
    return mind.mask;
  }

  /**
   * Has somebody else's claim, corpse or record already spoken for this face?
   *
   * The same three shelves `bluffRole` draws against, asked about one role
   * instead of filtering all of them: what living seats are claiming, what the
   * graveyard has named, and what the dawn reports have settled onto a seat.
   */
  private faceTaken(board: PublicInfo, self: MafiaPlayer, face: RoleId): boolean {
    for (const claim of board.claims) {
      if (claim.kind === 'role-claim' && claim.claimedRole === face && claim.claimerSlot !== self.slot) return true;
    }
    for (const [slot, role] of board.deadRoles) {
      if (role === face && slot !== self.slot) return true;
    }
    for (const [slot, role] of board.provenRoles) {
      if (role === face && slot !== self.slot) return true;
    }
    return false;
  }

  /**
   * The nights a liar says it worked, in the record's own shape.
   *
   * Built deterministically from the seat, the mask and the public record, so
   * the will, the stand and the cell all quote the same invented notebook, and
   * so the version filed when the seat dies matches the text the town read.
   * Every page does a job. An accusation the seat actually made comes back
   * "suspicious", so the will corroborates the seat's public case. A brother,
   * or a townie already in the ground, comes back "clean": a second seat
   * covered, or a line nothing can ever contradict. A night that took a life
   * gets a lookout's list with the accused at the door. The nights named are
   * real nights, so the arithmetic holds up against the dawn reports.
   */
  private fakeIntel(state: MafiaState, botId: string, mask: RoleId, upToNight: number): IntelEntry[] {
    const self = state.players[botId];
    if (!self) return [];

    /**
     * A lie has to be one the claimed role could actually have told.
     *
     * The notebook used to fall through to a `went` entry for any mask it did
     * not recognise, so a seat claiming Citizen wrote "Night 1: I went to 4" in
     * its will — a power that role does not have, at a table where the role
     * list is printed in the corner of every screen. That is a confession with
     * extra steps, not a bluff. A mask with no night action at all, or one that
     * fires at home like the Veteran's alert, has no journeys to report and
     * therefore says nothing whatever about its nights.
     */
    const def = ROLES[mask];
    if (def.nightAction === null || def.selfTarget === true) return [];

    const board = this.minds.board(state, botId);

    /**
     * A badge that kills leaves its nights in the dawn report.
     *
     * Every body is announced with the weapon that made it, so a Vigilante's
     * work is public the morning after: the only night this mask can claim is
     * one the town already credits to that weapon, and what it adds is the
     * finger on the trigger, which no record settles. If the report never named
     * that weapon, the notebook is empty and the seat says so — an unspent
     * Vigilante is the most ordinary thing at the table, and far better than a
     * bullet nobody heard.
     */
    if (def.nightAction === 'kill') {
      const weapon = MASK_WEAPON[mask];
      if (!weapon) return [];
      return board.deaths
        .filter((death) => death.phase === 'night' && death.day < upToNight && death.source === weapon)
        .map((death) => ({ night: death.day, kind: 'went' as const, targetSlot: death.slot, value: 'went' }));
    }

    /**
     * And it has to be told in that role's own voice.
     *
     * Each power leaves a different kind of trace, so the mask decides the
     * shape of every page: a Sheriff's verdict, a Lookout's list of callers, a
     * Detective's tail, an Escort's "I held them at home", a Bus Driver's two
     * houses, and a plain journey for the roles whose night is simply a visit,
     * a Doctor or a Bodyguard. A Doctor claiming a Lookout's list would be
     * caught by the first person who read it.
     *
     * The Bus Driver was on the plain-journey list, so an Executioner wearing
     * its badge on a real table told the stand "Night 1: I was at Yennefer.
     * Night 2: I was at Killua", one house a night, for a role whose every
     * night is a pair of houses swapped. The real one writes `swapped`.
     */
    const traces: Partial<Record<string, IntelEntry['kind']>> = {
      investigate: 'sheriff',
      // A town examiner gets a smell, never a name: only the families' examiners
      // read exact roles, and a mask is always a town role.
      examine: 'trade',
      watch: 'visitors',
      track: 'tracked',
      shadow: 'tracked',
      block: 'blocked',
      kidnap: 'blocked',
      'jail-execute': 'blocked',
      /**
       * The Coroner reads bodies, and his page has to be one.
       *
       * Missing, so `autopsy` fell through to the `went` default below and a
       * seat wearing the Coroner published an ordinary evening of house calls
       * on living people. That is the badge refuting itself inside its own
       * will, and `visited-the-living` is built to catch exactly it: a Mafioso
       * wore the Coroner on day three of a real game, filed three visits to
       * seats sitting in the room, and the room read it straight back to her.
       *
       * A corpse-only badge gets a corpse-only notebook. See the `role` case.
       */
      autopsy: 'role',
      swap: 'swapped'
    };
    const kind = traces[def.nightAction] ?? 'went';

    const family = playerFamily(self);
    const others = Object.values(state.players)
      .filter((player) => player.playerId !== botId)
      .sort((left, right) => left.slot - right.slot);
    const mates = others
      .filter((player) => family !== null && playerFamily(player) === family)
      .map((player) => player.slot);
    const strangers = others.filter((player) => !mates.includes(player.slot)).map((player) => player.slot);
    const accused = [
      ...new Set(
        board.claims
          .filter((claim) => claim.kind === 'accuse' && claim.claimerSlot === self.slot)
          .map((claim) => claim.targetSlot)
      )
    ];
    const pick = (list: number[], salt: string): number | undefined =>
      list.length > 0 ? list[hashCode(botId + ':fake:' + salt) % list.length] : undefined;

    /**
     * Who was still breathing when that night fell.
     *
     * The lie that started this: a seat wearing the Vigilante's badge wrote
     * "Night 5: I went to Baloo" about a man the dawn report had buried on
     * night 2. Every death is announced with its night, so a notebook that
     * calls on a corpse is not a bluff at all — it is a confession anybody can
     * check by scrolling up. Read off the public board rather than the state,
     * because the public board is what the room will hold it to.
     *
     * Stable once the night is over: it asks only about deaths *before* that
     * night, and those never change again. A page written on day three still
     * reads the same on day seven, which is what keeps the will, the stand and
     * the cell telling one story.
     */
    const aliveOn = (night: number, slot: number): boolean =>
      !board.deaths.some(
        (death) => death.slot === slot && (death.day < night || (death.day === night && death.phase === 'day'))
      );

    const entries: IntelEntry[] = [];
    for (let night = 1; night < upToNight; night++) {
      const living = (slots: number[]): number[] => slots.filter((slot) => aliveOn(night, slot));
      const died = board.deaths
        .filter((death) => death.phase === 'night' && death.day === night)
        .map((death) => death.slot);
      /**
       * Every page does a job.
       *
       * A seat this bot has actually accused in the square comes back guilty,
       * so the notebook corroborates the case it has been making all game. A
       * brother, or anybody already in the ground, comes back clean: a second
       * seat covered, or a line nothing can ever contradict. The nights named
       * are real nights, so the arithmetic holds against the dawn reports.
       */
      /**
       * The house this seat already named for that night, when it has said one.
       *
       * "Where were you?" is answered in the square before the will is written,
       * and the answer comes from the mask (see `coverStory` in the policy). A
       * page that picked a different house for the same night would have the
       * will and the square telling two stories, which is the one mistake a liar
       * must not make, so the spoken house is the page's house.
       */
      const told = [...board.claims]
        .reverse()
        .find(
          (claim) =>
            claim.kind === 'account' &&
            claim.account === 'visited' &&
            claim.claimerSlot === self.slot &&
            (claim.night ?? Math.max(1, claim.day - 1)) === night &&
            aliveOn(night, claim.targetSlot)
        )?.targetSlot;
      if (told !== undefined && kind !== 'role') {
        const guilty = accused.includes(told);
        if (kind === 'sheriff') {
          const families = (['mafia', 'triad', 'cult'] as const).filter(
            (family) => !board.rolesInPlay || [...board.rolesInPlay].some((role) => ROLES[role].faction === family)
          );
          const named = families[hashCode(botId + ':camp:' + night) % Math.max(1, families.length)];
          entries.push({ night, kind: 'sheriff', targetSlot: told, value: guilty ? (named ?? 'suspect') : 'clear' });
        } else if (kind === 'trade') {
          const pool = board.rolesInPlay;
          const fitting = [...new Set(Object.values(ROLES).map((role) => role.investigated))].filter(
            (trade) =>
              tradeSuspects(trade, pool).length > 0 && tradeVerdict(trade, pool) === (guilty ? 'damning' : 'clean')
          );
          const smell = fitting[hashCode(botId + ':smell:' + night) % Math.max(1, fitting.length)];
          if (smell) entries.push({ night, kind: 'trade', targetSlot: told, value: smell });
        } else if (kind === 'visitors') {
          const callers = died.includes(told)
            ? living(accused)
                .filter((slot) => slot !== told)
                .slice(0, 1)
            : [];
          entries.push({ night, kind: 'visitors', targetSlot: told, value: 'visitors', slots: callers });
        } else if (kind === 'tracked') {
          entries.push({ night, kind: 'tracked', targetSlot: told, value: 'tracked', slots: died });
        } else if (kind === 'swapped') {
          // The house it named, and a second one to have swapped it with.
          const partner = pick(
            living([...mates, ...strangers]).filter((slot) => slot !== told && !died.includes(slot)),
            'pair:' + night
          );
          if (partner !== undefined) {
            entries.push({
              night,
              kind: 'swapped',
              targetSlot: told,
              value: `${told},${partner}`,
              slots: [told, partner]
            });
          }
        } else {
          entries.push({ night, kind, targetSlot: told, value: kind });
        }
        continue;
      }

      const suspect = living(accused).find((slot) => !entries.some((entry) => entry.targetSlot === slot));
      const innocent = pick(living([...mates, ...strangers]), String(night));

      switch (kind) {
        case 'sheriff': {
          if (suspect !== undefined && hashCode(botId + ':confirm:' + night) % 3 !== 0) {
            /**
             * A fake hit names a camp, because a real one does.
             *
             * The needle has not said a bare "suspicious" since it learned to
             * name what it found, so a liar's notebook that still did would be
             * a liar caught by its own vocabulary. It names a family the
             * roster can actually contain — the room is looking at the same
             * list — and prefers the Mafia, which is the one every table has.
             */
            const families = (['mafia', 'triad', 'cult'] as const).filter(
              (family) => !board.rolesInPlay || [...board.rolesInPlay].some((role) => ROLES[role].faction === family)
            );
            const named = families[hashCode(botId + ':camp:' + night) % Math.max(1, families.length)];
            entries.push({ night, kind: 'sheriff', targetSlot: suspect, value: named ?? 'suspect' });
          } else if (innocent !== undefined) {
            entries.push({ night, kind: 'sheriff', targetSlot: innocent, value: 'clear' });
          }
          break;
        }
        case 'trade': {
          /**
           * A liar's Investigator picks the smell that does the job: on a seat
           * it is pushing, one this roster can only read as an enemy; on a
           * brother or a corpse, one it can only read as town. Chosen from the
           * trades whose shortlist is non-empty here, so the lie survives the
           * room checking it against the roster.
           */
          const pool = board.rolesInPlay;
          const trades = [...new Set(Object.values(ROLES).map((role) => role.investigated))].filter(
            (trade) => tradeSuspects(trade, pool).length > 0
          );
          const smelling = (verdict: 'damning' | 'clean'): string | undefined => {
            const fitting = trades.filter((trade) => tradeVerdict(trade, pool) === verdict);
            return fitting[hashCode(botId + ':smell:' + night) % Math.max(1, fitting.length)];
          };
          const guilty = suspect !== undefined ? smelling('damning') : undefined;
          if (suspect !== undefined && guilty) {
            entries.push({ night, kind: 'trade', targetSlot: suspect, value: guilty });
          } else if (innocent !== undefined) {
            const clean = smelling('clean');
            if (clean) entries.push({ night, kind: 'trade', targetSlot: innocent, value: clean });
          }
          break;
        }
        case 'visitors': {
          const watched = died[0] ?? pick(living(strangers), String(night));
          if (watched === undefined) break;
          // A house that died with callers at the door is the useful version.
          const callers = died.length > 0 && suspect !== undefined ? [suspect] : [];
          entries.push({ night, kind: 'visitors', targetSlot: watched, value: 'visitors', slots: callers });
          break;
        }
        case 'tracked': {
          const tailed = suspect ?? pick(living(strangers), String(night));
          if (tailed !== undefined) {
            entries.push({ night, kind: 'tracked', targetSlot: tailed, value: 'tracked', slots: died });
          }
          break;
        }
        case 'blocked': {
          const held = innocent;
          if (held !== undefined) entries.push({ night, kind: 'blocked', targetSlot: held, value: 'blocked' });
          break;
        }
        case 'role': {
          /**
           * An autopsy, which means a body that was already in the ground.
           *
           * `nightLine` decides between "I examined X's body" and "X is the Y"
           * by asking whether that seat was dead when the night fell, so the
           * page only reads as a Coroner's if the corpse predates the night.
           * A body that fell *on* that night was still upright while it was
           * being examined, which is the same contradiction one step smaller.
           *
           * What it says about the body is whatever the square already
           * settled, when the square settled it. That is a weak claim and
           * deliberately so — an autopsy mostly repeats the dawn report, which
           * is why the Coroner is a thin badge to wear and ranks last in
           * `maskRank` — but it is a claim nothing can contradict. Only a body
           * the report never identified is worth inventing a role for, and
           * that is exactly the case a real Coroner exists to cover.
           */
          const buriedBefore = board.deaths
            .filter((death) => death.day < night || (death.day === night && death.phase === 'day'))
            .map((death) => death.slot)
            .filter((slot) => !entries.some((entry) => entry.targetSlot === slot));
          const body = buriedBefore[hashCode(botId + ':slab:' + night) % Math.max(1, buriedBefore.length)];
          if (body === undefined) break;
          const settled = board.deadRoles.get(body);
          if (settled) {
            entries.push({ night, kind: 'role', targetSlot: body, value: settled });
            break;
          }
          /**
           * A cleaned corpse, which is the one body worth reading. The role
           * named has to be one the roster could still contain, or the room
           * checks it against the list in the corner of its own screen.
           */
          const open = [...(board.rolesInPlay ?? [])].filter(
            (role) => isEvilRole(role) && ![...board.deadRoles.values()].includes(role)
          );
          const named = open[hashCode(botId + ':slab-role:' + night) % Math.max(1, open.length)];
          if (named) entries.push({ night, kind: 'role', targetSlot: body, value: named });
          break;
        }
        case 'swapped': {
          // Two living houses, neither of them this seat's: a swap nobody can check against a corpse.
          const pair = living([...mates, ...strangers]).filter((slot) => !died.includes(slot));
          const first = pick(pair, 'swap:' + night);
          const second = pick(
            pair.filter((slot) => slot !== first),
            'swap-with:' + night
          );
          if (first !== undefined && second !== undefined) {
            entries.push({
              night,
              kind: 'swapped',
              targetSlot: first,
              value: `${first},${second}`,
              slots: [first, second]
            });
          }
          break;
        }
        default: {
          if (innocent !== undefined) entries.push({ night, kind: 'went', targetSlot: innocent, value: 'went' });
        }
      }
    }
    return entries;
  }

  /**
   * The claim a night's record makes when it is read out loud.
   *
   * Every one of these is marked `worked`, and that is the whole reason the
   * flag exists: an `IntelEntry` is a night this seat actually spent, so any
   * sentence built from one says where the speaker was as surely as "I was at
   * 4" does. Read as bare verdicts they did not — a Sheriff's four checks
   * looked exactly like four opinions — and the seat was hanged for having
   * "never given an account of a single night" by jurors who had just heard
   * four of them.
   */
  private claimFor(entry: IntelEntry, speakerSlot: number, rolesInPlay?: ReadonlySet<RoleId>): Decision['claim'] {
    /**
     * The first thing the record says, by the one rule every reader of a record
     * uses (`testimonyOf`); a line on the stand names one house.
     *
     * Stamped with the night it is about, which is not always last night. A
     * record read out on the stand names an old night, and filed without one it
     * became a claim about the night before the trial. A real Jailor said "I
     * locked Gizmo on night 3" on day 8 and was hanged for claiming a visit to
     * Gizmo on night 7, when Gizmo had been dead for four nights.
     */
    const [first] = testimonyOf(entry, speakerSlot, rolesInPlay);
    if (!first) return null;
    return {
      kind: first.kind,
      slot: first.targetSlot,
      role: null,
      worked: true,
      from: entry.kind,
      night: entry.night,
      ...(first.account ? { account: first.account } : {}),
      ...(first.at !== undefined ? { at: first.at } : {})
    };
  }

  dawnWills(state: MafiaState): void {
    // The graveyard, which is common property; the notebooks below are read
    // seat by seat.
    const board = this.minds.board(state);
    for (const player of Object.values(state.players)) {
      if (!player.isBot || !player.role) continue;
      const mind = this.minds.mind(state, player.playerId);
      if (!mind) continue;

      if (player.alive) {
        for (const note of [...mind.notes]) {
          if (note.kind === 'wrong') continue;
          const buried = board.deadRoles.get(note.slot);
          if (!buried || ROLES[buried].faction !== 'town') continue;
          if (mind.notes.some((other) => other.kind === 'wrong' && other.slot === note.slot)) continue;
          mind.notes.push({ day: state.day, slot: note.slot, kind: 'wrong' });
        }
        continue;
      }

      const filed = this.testamentsFiled.get(state.code) ?? new Set<string>();
      if (filed.has(player.playerId)) continue;
      filed.add(player.playerId);
      this.testamentsFiled.set(state.code, filed);

      // The badge it was dealt, for the same reason the will signs it. See `roleBefore`.
      const honest = ROLES[player.roleBefore ?? player.role].faction === 'town' || mind.agenda === 'passenger';
      if (honest || !mind.mask || mind.brain.personality.deceit <= 0.35 || !player.lastWill) continue;
      const death = state.deaths.find((entry) => entry.playerId === player.playerId);
      if (!death || death.hidden) continue;

      // Read the way the board reads any will: see `testimonyOf`.
      for (const entry of this.fakeIntel(state, player.playerId, mind.mask, death.day)) {
        for (const { kind, targetSlot, ...rest } of testimonyOf(entry, player.slot, board.rolesInPlay)) {
          /**
           * The night the page is about, said in both fields rather than one.
           *
           * `day` carries the night here, which is the convention a testament has
           * always used and what `record` deduplicates on. `night` was left to
           * `record`'s fallback, which stamps the night before *today*, so the two
           * fields on the same claim named two different nights: a liar's
           * notebook page about night 2, filed on day 6, was read out by `why`
           * and `sentence` as night 5. A record that contradicts itself is worse
           * than a lie, because it convicts the seat that quoted it.
           */
          this.minds.record(state, player.playerId, kind, targetSlot, rest);
        }
      }
    }
  }
}
