import { createChat, type ChannelRules, type ChatState } from 'chat-core';
import type { Locale, Msg } from 'i18n';
import { pickBotName } from 'lobby-core';
import { createPresence, type PresenceState, type Roster } from 'presence-core';

import type { DeathSource } from './messages.js';

import { familyOf, roleDef, rosterFor, type FamilyId, type NightActionType, type RoleId } from './roles.js';
import { censusSetup, chaosSetup, fitSetup, rollSetup, setupById, sortRoleList, type SlotToken } from './setups.js';

/**
 * One Mafia table: up to 24 numbered seats around the town square. The state is
 * a plain JSON-serialisable object, snapshotted to SQLite on every transition
 * like the quizzes and CoronaZ. All mutation goes through engine.ts; timers
 * live in the server's manager, never here.
 */

export type MafiaPhase = 'lobby' | 'day' | 'night' | 'ended';

/**
 * "Hang nobody today", as a vote target.
 *
 * A sentinel inside `state.votes` rather than a second record, because wanting
 * the day over and wanting somebody on the stand are the same decision and a
 * player holds exactly one of them at a time. Stored as an id that can never be
 * a player id — every seat's is a random token — so the projection and the tally
 * simply find no player under it and skip past, which is what they should do.
 */
export const SKIP_VOTE = '@skip';

/**
 * How long a last will may be, in characters.
 *
 * One number, exported, because three places used to hold their own copy of it:
 * the engine truncated at four hundred, the socket schema rejected past four
 * hundred, and the phone's textarea stopped accepting at four hundred. Agreeing
 * by coincidence is not agreeing.
 *
 * Eight hundred rather than four, because a will is a record and the record got
 * longer: a Lookout six nights into a game writes a line per night, and a seat
 * that has been keeping notes on who it thinks is lying writes those too. At
 * four hundred a long game's will was truncated mid-word, and truncation is the
 * worst possible editor — it keeps night one and throws away last night, which
 * is the one the town needs. Still a limit, because a will is read on a phone
 * by somebody with thirty seconds.
 */
/**
 * How long a last will may be.
 *
 * Eight hundred held a role line, a handful of nights and a closing line, which
 * was the whole of a will while a bot only ever wrote about tonight. A will that
 * records every night from the first one needs the room to do it: nine nights of
 * "N4: visiting Lucky Luke" is most of the old budget before the seat has said
 * anything it concluded. A corpse is the one witness that cannot be
 * cross-examined, so the useful thing is for it to have written more, not less.
 */
export const WILL_MAX_CHARS = 1400;

/**
 * The byline on a line whose author must not be named.
 *
 * The spy hearing the family, and the crier's voice carrying through the night:
 * both are cases where the *words* are public to somebody and the *mouth* is
 * not. One glyph for both, defined once, because the crier's was missing and a
 * night line in the square went out under the crier's own name, which is the
 * single thing that role exists to hide.
 */
export const ANONYMOUS = '· · ·';

/** Sub-state of a day: open discussion, or a trial in one of its two beats. */
export type DayStage = 'discussion' | 'defense' | 'judgement';

export interface MafiaConfig {
  /** Seats on the map. Fixed positions, numbered 1..maxPlayers. */
  maxPlayers: number;
  minPlayers: number;
  /** Phase clocks, milliseconds. */
  dayMs: number;
  /**
   * The first day, which is a different thing from a day.
   *
   * Nothing has happened yet: no corpse, no claim, no vote — the town cannot
   * even hang anybody. A full-length day one is two minutes of "hi" followed by
   * silence, so it gets its own, much shorter clock rather than a fraction of
   * `dayMs`, which is what it used to be and still felt interminable.
   */
  firstDayMs: number;
  nightMs: number;
  defenseMs: number;
  judgementMs: number;
  /** Extra discussion granted after a spared trial. */
  aftermathMs: number;
  /**
   * How long a day must be *talked* before it can be ended.
   *
   * The bots reach their verdict in the first second, because the policy brain
   * has the whole board the moment the day opens and nothing about it changes
   * by waiting. On an empty board that verdict is "no case, skip", so day two
   * ended before anybody had read the dawn report — reported from a real table,
   * where the human had not finished typing hello.
   *
   * The cure is not to make the bots slower at thinking. It is to say that a
   * day has a minimum length: accusations and skips are refused until it has
   * passed, the talk happens in that window, and the vote is then taken against
   * a board that has something on it.
   */
  voteLockMs: number;
  /** Trials a single day may hold before night falls by exhaustion. */
  trialsPerDay: number;
  /**
   * Days before the clock is called, as a backstop rather than as the rule.
   *
   * Twenty was doing the whole job and doing it badly. A board where nothing is
   * happening is stuck at day eight as surely as at day twenty; all the extra
   * days bought was twelve more rounds of the same silence, and the thing that
   * actually ends those games is `quietDaysBeforeEnd` below.
   */
  maxDays: number;
  /**
   * How many consecutive days with nobody dying ends it, and from when.
   *
   * Taken from how Town of Salem calls a timeout, because it is a better test
   * than a day count: a game is over when it has *stopped moving*, and the
   * number of days that took is beside the point.
   *
   * Measured on the bench before adopting it. Of eleven games that reached day
   * twenty, ten had an Escort on them, blocking the last killer every night —
   * nobody dies, so no evidence arrives, so the suspicion the town votes on
   * never changes, so nobody hangs, so nobody dies. That loop is detectable the
   * moment it starts and was instead being sat through for a dozen more days.
   *
   * Late only, because a genuinely quiet couple of days early on is a doctor
   * doing its job rather than a stalled game.
   */
  quietDaysBeforeEnd: number;
  /**
   * The same rule, for a board that has merely gone quiet rather than seized.
   *
   * Two days of silence means two different things. On a frozen board — the
   * Escort and the last killer, neither able to reach the other — it is the
   * whole game, already decided, and the sooner it is said the better. On a
   * board where the losing side still holds the votes to hang the winning one,
   * it is a town that has skipped twice, and ending there handed a nine-against-
   * one afternoon to the one. Both are worth ending; they are not worth ending
   * on the same morning.
   *
   * So a board somebody can still move gets a longer leash, and past `maxDays`
   * the clock rules whatever it looks like.
   *
   * Five, off a sweep of six hundred benched games at twelve, fifteen, twenty
   * and twenty-four seats:
   *
   *     leash   town     longest game   reached maxDays
   *       2     48.8%        15                0        (the flat rule)
   *       3     51.2%        17                0
   *       5     52.3%        19                0
   *       8     53.0%        20                1
   *
   * The town gains three and a half points, and that is the bug being paid
   * back rather than a thumb on the scale: every one of those games is one it
   * held the votes to win and was ruled against on its second quiet morning.
   * Five is the longest leash that still never reaches the `maxDays` backstop,
   * which is the property worth having — past it the curve is flat and all the
   * extra days buy is a longer game.
   */
  quietDaysIfMoveable: number;
  /** The day this rule may first fire. Before it, quiet is just a good night. */
  quietFrom: number;
  /**
   * What a corpse gives away.
   *
   * `role` is the classic reading: the body is identified and the town learns
   * exactly what it just hanged. `faction` names the camp and nothing more, which
   * keeps the shape of the game while making a Coroner's autopsy worth having.
   * `none` reveals nothing until the end, which turns every death into an
   * argument rather than a fact.
   *
   * Three things are deliberately *outside* this setting, because they are
   * mechanics rather than presentation. A cleaned corpse (Janitor, Incense
   * Master) stays nameless whatever the policy — that is what the power buys. A
   * borrowed face (Disguiser, Actress, Diva) never reaches the slab: the reveal
   * always reads the true `role`, because `disguiseRole` exists to fool
   * *examiners* and nothing else. And a role that has been *changed* — audited,
   * converted, remembered, initiated, or a widowed Executioner gone mad — reveals
   * what its owner had become, which is the whole point of those powers.
   */
  revealOnDeath: 'role' | 'faction' | 'none';
  /**
   * The language this table is *spoken* in.
   *
   * Not the same thing as a reader's language, and the distinction is the whole
   * localisation design. Announcements are keys, so every phone renders them in
   * its owner's language and a mixed table works. But a bot's chat line is free
   * text in a shared channel — it cannot be one thing to you and another to the
   * person arguing with you — so it picks this, once, for the table.
   */
  locale: Locale;
  /**
   * How the roles are dealt: the balanced automatic roster, a proposed
   * template, a player-saved slot list, or pure chaos.
   */
  setup: MafiaSetupChoice;
  /**
   * Whether the table is listed on the public board.
   *
   * A private table is reachable only by its code, which is how every table
   * worked before there was a board at all — so that stays the default. Making
   * one public is an invitation to strangers, and an invitation is something you
   * send rather than something that happens to you.
   */
  public: boolean;
}

export type MafiaSetupChoice =
  | { mode: 'auto' }
  | { mode: 'chaos' }
  | { mode: 'census' }
  | { mode: 'preset'; presetId: string }
  | { mode: 'custom'; slots: SlotToken[] };

export const DEFAULT_CONFIG: MafiaConfig = {
  maxPlayers: 24,
  minPlayers: 4,
  dayMs: 120_000,
  firstDayMs: 35_000,
  voteLockMs: 15_000,
  nightMs: 40_000,
  /**
   * The trial, at a length somebody can actually use.
   *
   * Half again as long as it was, both halves. Twenty-five seconds is enough
   * to type one sentence, and a defence is not one sentence: it is a role
   * claim, an account of the nights, and a reason to doubt whoever is pushing
   * — the accused has to say all of it and the room has to read it. Judgement
   * grew with it for the same reason: the ballot is the one moment the words
   * are supposed to change something, which they now do (see
   * `defenceStrength`), and a room voting before it has read them is a room
   * where the defence may as well not have happened.
   */
  defenseMs: 38_000,
  judgementMs: 30_000,
  aftermathMs: 45_000,
  trialsPerDay: 3,
  maxDays: 20,
  quietDaysBeforeEnd: 2,
  quietDaysIfMoveable: 5,
  quietFrom: 7,
  revealOnDeath: 'role',
  locale: 'en',
  setup: { mode: 'auto' },
  public: false
};

/**
 * A structured night result, private to its owner. The notifications carry the
 * same information as sentences for humans; bots and future UI read this, which
 * needs no rendering at all.
 */
/**
 * What a sheriff's needle came back saying.
 *
 * `clear`, or the camp it pointed at. It used to be a boolean, which threw away
 * the one thing that makes the role worth playing: "suspicious" is a shrug the
 * town argues about, while "a Serial Killer" is a name, a threat level and an
 * instruction. A framed seat reads as its framer's family, because that is what
 * the frame is for; `suspect` is the catch-all for a seat that reads badly
 * without belonging to anybody, which is the Scumbag's whole job.
 */
export type SheriffVerdict =
  | 'clear'
  | 'suspect'
  | 'mafia'
  | 'triad'
  | 'cult'
  | 'serial-killer'
  | 'mass-murderer'
  | 'arsonist'
  | 'poisoner'
  | 'electromaniac';

/** Every verdict except `clear` is the needle moving. */
export function sheriffSuspects(value: string): boolean {
  return value !== 'clear';
}

export interface IntelEntry {
  night: number;
  /**
   * `went` is the one entry every visitor gets, result or no result.
   *
   * The others are what a power *found out*. This is merely where its holder
   * was, and it exists because a corpse's last night is evidence the town used
   * to lose: a doctor who healed nobody and died on a veteran's porch left a will
   * with no nights in it, and the porch stayed anonymous. With the journey on
   * record the board can join the two, and so can a person reading the will.
   */
  kind:
    | 'sheriff'
    | 'trade'
    | 'role'
    | 'visitors'
    | 'tracked'
    | 'saved'
    | 'doused'
    | 'spied'
    | 'blocked'
    | 'swapped'
    /**
     * The jailor's own night: who was in the cell, and whether they tried
     * anything from inside it.
     *
     * The one working role in this game that kept no record at all. Jailing is
     * a day action that writes `state.jailedId` and nothing else, so a real
     * Jailor reached its own last will with not one night to put in it — while
     * an Escort's `blocked` entries render as "Night 3: I held X at home",
     * which reads exactly like a jailor's line. The honest Jailor was mute and
     * the liars were circumstantial. Reported from a real table, where three
     * seats claimed the badge and the one telling the truth had the thinnest
     * will of the three.
     *
     * `value` is `'quiet'` or `'tried'`: a prisoner who submitted an action is
     * a prisoner the jailor watched reach for something, which is exactly the
     * evidence an execution is supposed to rest on.
     */
    | 'jailed'
    /**
     * The Witch's own night: whose hand she took, where she sent it, and
     * whether there was anything in it.
     *
     * She had no memory at all, and picked her victim uniformly at random every
     * night of the game — "honest mischief" was the whole of her strategy. But
     * taking a hand is an *experiment*: a seat that had something to redirect
     * holds a night power, and if the house she sent it to is a corpse in the
     * morning, the hand she is holding is holding a knife. That is worth
     * knowing, and worth going back to.
     *
     * `value` is `'sent'` when there was an order to redirect and `'idle'` when
     * the seat was doing nothing; `slots` carries the destination, so the
     * morning's dead can be checked against it.
     */
    | 'controlled'
    | 'went';
  targetSlot: number;
  /** sheriff: 'suspect' | 'clear'; trade: the trade line; role: a RoleId; saved/doused: constants. */
  value: string;
  /** visitors only: who called on the watched house. */
  slots?: number[];
}

export interface MafiaPlayer {
  playerId: string;
  /** Credential the phone stores; proves the seat on reconnection. */
  token: string;
  name: string;
  /** Seat number, 1-based, doubles as the house position on the map. */
  slot: number;
  /**
   * The language this person reads in, from their browser.
   *
   * Only used to decide what the *bots* speak: see `spokenLocale`. A player's own
   * screen is localised client-side and needs no help from the server.
   */
  locale?: Locale;
  /** Kune login when the browser was signed in; points bank here. */
  account?: string;
  isBot: boolean;
  connected: boolean;
  alive: boolean;
  role: RoleId | null;
  /** Remaining uses of a limited power (bullets, alerts, executes, vests). */
  charges: number;
  /** Executioner only: the head this player wants on a pike. */
  obsessionId: string | null;
  /** Mayor only: whether the sash is out. Triples the vote. */
  revealed: boolean;
  /** Soaked in the arsonist's gasoline. Burns when the match drops. */
  doused: boolean;
  /** Wired by the electromaniac. Zapped when the lever drops. */
  charged: boolean;
  /** Night the poisoner struck; death comes the following night unless cured. */
  poisonedNight: number | null;
  /**
   * The badge this seat was dealt, when something has since replaced it.
   *
   * The Auditor rewrites `role` in place and nothing kept the old one, so
   * everything downstream read the new badge as though it had always been
   * there. Three things fell out of that, and the will was the worst: it is
   * signed from the current role, so an audited Sheriff rewrote itself next
   * dawn as "I am the Citizen" over five nights of real checks, and the whole
   * room read a will that contradicted its own contents as a fabrication.
   *
   * The `honest` flag reads the current role too, so a Survivor audited into a
   * Scumbag flipped from passenger to parasite and had its truthful notebook
   * thrown away and replaced with a liar's. That is the one case where the will
   * genuinely lost its content rather than merely mis-signing it.
   *
   * Absent on every seat that was never audited, which is almost all of them,
   * and absent on persisted tables from before this existed — both read as "the
   * badge on `role` is the one it was dealt", which is exactly right.
   */
  roleBefore?: RoleId | null;
  /**
   * The night somebody came for this seat and it lived, and what held.
   *
   * The single most valuable thing a town seat can say out loud, and until now
   * it could only say it as prose: the engine told the victim "you were healed"
   * in a notification, which a person reads and a bot cannot reason from. On
   * the record it is evidence — "a doctor is alive and was on me on night 3"
   * narrows the board for everybody, and "a bodyguard died for me" is checkable
   * against the corpse in the square the same morning.
   *
   * `doctor` and `bodyguard` are what the victim genuinely learns; `self` is
   * armour of its own (night immunity, a vest, a veteran's alert) and says far
   * less, because it points at the seat's own role rather than at a saviour.
   * Absent on a table persisted before this existed, and read as "never".
   */
  rescuedNight?: number | null;
  rescuedBy?: 'doctor' | 'bodyguard' | 'self' | null;
  /**
   * The night somebody interfered with this seat, and how.
   *
   * The four things a person says the next morning before anything else —
   * "I got roleblocked", "I was witched", "I was transported", "I was in the
   * cell" — because each one explains a missing or wrong result and proves a
   * role is at the table. The engine has always told the seat in a
   * notification; a bot could not reason from prose, so it never said it.
   * Latest wins, as with `rescuedNight`.
   *
   * `jail` is the one of the four the room can settle without trusting
   * anybody: the man with the keys is sitting right there and either confirms
   * it or does not, so two seats claiming the same cell is one of them caught.
   * It is kept apart from `block` for that reason alone — both take the night
   * away, only one leaves a witness.
   */
  disturbedNight?: number | null;
  disturbedBy?: 'block' | 'control' | 'swap' | 'jail' | null;
  /** Day number this player may not speak on (the blackmailer's gag). */
  silencedDay: number | null;
  /** What examiners see instead of the real role (imposteur, actrice, diva). */
  disguiseRole: RoleId | null;
  /** Bound heart: lover pairs and the heartbreaker's victims. */
  bondPartnerId: string | null;
  bondKind: 'lover' | 'charm' | null;
  /** Next day this player's cooldown power may fire again (cult conversion). */
  cooldownUntilDay: number | null;
  lastWill: string;
  /**
   * Private feed: night results, warnings. Only ever sent to this player.
   *
   * Keys, not prose. They are persisted with the table and replayed on every
   * reconnect, so a sentence stored here would be a sentence in one language for
   * the life of the game — which is exactly what it was.
   */
  notifications: Msg[];
  /** The same night results, structured. Same privacy as the notifications. */
  intel: IntelEntry[];
  /**
   * How many of `notifications` have already been echoed into this seat's
   * private chat channel. Absent on a table persisted before the channel
   * existed, and read as zero.
   */
  notifiedUpTo?: number;
  /**
   * What wrote this seat's last line, when this seat is a bot.
   *
   * A model name, or `'scripted'` for the phrasebook. Absent until the seat has
   * spoken, and meaningless for a person.
   *
   * Public on purpose. The whole design of the bot driver is that a model and
   * the phrasebook are hard to tell apart from the outside, which is what makes
   * the fallback invisible when it works, and also what makes a silently benched
   * API indistinguishable from a working one. The only way to know a table is
   * running on the phrasebook used to be to recognise its sentences. It gives
   * nothing away about the *game*: what a bot knows is in `intel` and `role`,
   * and neither of those is here.
   */
  botBrain?: string;
  /** Filled at death; role goes public with it. */
  death: { day: number; phase: 'day' | 'night'; cause: Msg } | null;
}

/**
 * A fresh seat, with every flag at rest.
 *
 * One factory for both entry points — a person joining and a bot being seated —
 * because the two used to spell out the same twenty fields side by side, and a
 * new field on `MafiaPlayer` had to be remembered twice or it silently arrived
 * as `undefined` on half the table.
 */
export function seatPlayer(input: {
  playerId: string;
  token: string;
  name: string;
  slot: number;
  isBot: boolean;
  account?: string;
}): MafiaPlayer {
  return {
    playerId: input.playerId,
    token: input.token,
    name: input.name,
    slot: input.slot,
    account: input.account,
    isBot: input.isBot,
    connected: true,
    alive: true,
    role: null,
    charges: 0,
    obsessionId: null,
    revealed: false,
    doused: false,
    charged: false,
    poisonedNight: null,
    rescuedNight: null,
    rescuedBy: null,
    disturbedNight: null,
    disturbedBy: null,
    silencedDay: null,
    disguiseRole: null,
    bondPartnerId: null,
    bondKind: null,
    cooldownUntilDay: null,
    lastWill: '',
    notifications: [],
    intel: [],
    death: null
  };
}

export interface TrialState {
  accusedId: string;
  /** Guilty/innocent ballots, by voter id. Abstention = absent key. */
  ballots: Record<string, 'guilty' | 'innocent'>;
  /** The judge's exceptional court: no defense, and his ballot counts triple. */
  court?: boolean;
}

/** One attack and what became of it. See `MafiaState.nightLog`. */
export interface NightOutcome {
  attackerSlot: number | null;
  targetSlot: number;
  source: DeathSource;
  outcome: 'killed' | 'healed' | 'guarded' | 'immune' | 'vested' | 'jailed' | 'sheltered' | 'too-late';
}

export interface NightAction {
  type: NightActionType;
  targetId: string | null;
  /** Witch only: where the controlled player is sent. Absent = fate decides. */
  secondTargetId?: string | null;
}

export interface PointEntry {
  playerId: string;
  reason:
    | 'win'
    | 'solo-win'
    | 'survive'
    | 'kill'
    | 'save'
    | 'lynch-evil'
    | 'execute-evil'
    /**
     * Won by getting yourself killed, which is the Jester's whole job.
     *
     * He cannot collect `survive`, because surviving is losing for him: his win
     * paid `solo-win` and nothing else, so the hardest, most deliberate result
     * in the game scored the same five as a corpse on the winning side, and
     * less than a townie who simply lived through it. This is the difference,
     * and it exists because the alternative — raising `solo-win` — would also
     * pay the Survivor, who is already collecting `survive` alongside it.
     */
    | 'martyr'
    | 'participation';
  amount: number;
}

/**
 * Which way somebody won, as a value rather than a sentence.
 *
 * `WinEntry.reason` is prose for the podium and always will be. Everything that
 * *counts* wins reads this instead: the balance bench's outcome column, its
 * per-role win rates, and anything added later. Those all used to match French
 * substrings — `reason.includes('survécu')` was true for the lovers' line as
 * well as the survivor's, so a table with a Lover pair and no Survivor in it
 * scored a survivor win, and the bench could print a rate above 100%.
 */
export type WinKind =
  | 'town'
  /** A killing family took the board: which one is the FamilyId. */
  | FamilyId
  /** Last blade, flame, vial or current standing. */
  | 'solo-killer'
  | 'jester'
  | 'executioner'
  | 'survivor'
  /** Fed on the town's failure: witch, scumbag, judge, auditor. */
  | 'parasite'
  /** Both hearts still beating at the end, whoever else won. */
  | 'lovers';

export interface WinEntry {
  playerId: string;
  /** For the podium, as a key. Never branch on it; branch on `kind`. */
  reason: Msg;
  kind: WinKind;
}

/**
 * One accusation, as it happened.
 *
 * `targetSlot` null is a withdrawal, which matters: a seat that put three votes
 * on somebody and then took them all back is a story, and a log that only
 * recorded the votes still standing at dusk would not contain it.
 */
export interface VoteNote {
  day: number;
  voterSlot: number;
  targetSlot: number | null;
  /** True for "hang nobody today", which has no target and is not a withdrawal. */
  skip: boolean;
}

export interface MafiaState {
  code: string;
  hostToken: string;
  hostUserId: number | null;
  config: MafiaConfig;
  phase: MafiaPhase;
  /** Day counter; day 1 is the greeting day (no votes). */
  day: number;
  stage: DayStage | null;
  /** Server deadline of the running phase; clients render the countdown. */
  phaseEndsAt: number | null;
  /**
   * When the running day or night began. Optional because tables saved before the field exist; absent, the view
   * falls back to arithmetic on the deadline, which is what it always did and is wrong in exactly the ways below.
   *
   * A day is one phase from the bots' point of view even when a trial is running inside it, and the deadline
   * cannot say when it started: a trial resets it to "now plus forty seconds", so deadline-minus-length is the
   * trial's start and not the morning's, and every accusation made earlier that afternoon was stamped as
   * yesterday's news at the one moment the accused had to answer it. Stored instead, once, where the phase opens.
   */
  phaseStartedAt?: number | null;
  players: Record<string, MafiaPlayer>;
  /**
   * When this day's ballot opens. Null outside a day, and on tables that
   * predate the field — an absent lock is no lock, so old saves keep working.
   */
  voteOpensAt?: number | null;
  /** Day accusations: voter id -> accused id, or `SKIP_VOTE`. */
  votes: Record<string, string>;
  /**
   * Every accusation of the game, in the order it was cast.
   *
   * Deliberately not the chat. An accusation used to post a system line, and a
   * table of twenty-four revising their minds twice apiece wrote seventy lines
   * an afternoon into a fixed-size ring — which meant the day phase quietly
   * deleted its own record of who had died and what they turned out to be. So
   * the trace lives here instead: its own list, its own budget, and no way for
   * an afternoon of dithering to erase a death.
   *
   * Public information in full. Who is voting for whom is the one thing every
   * player can already see on the roster; this is only the history of it.
   */
  voteLog: VoteNote[];
  /**
   * Why the game ended, when the answer is not "somebody won".
   *
   * Only the endings that are nobody's victory set this, and it exists because
   * they were indistinguishable from the outside: a draw is a draw in the
   * result row whether the last two seats could not touch each other, or the
   * board ran out of days with a real game still on it, or every side died at
   * once. Those want three different fixes and looked like one problem.
   *
   *   `hollow`   every enemy dead and no townsperson left to carry it. The one
   *               ending that is genuinely nobody's.
   *   `clock`    `maxDays` reached with the board still moving.
   *   `frozen`   nothing alive could remove anything else alive.
   */
  drawReason?: 'hollow' | 'clock' | 'frozen';

  trial: TrialState | null;
  trialsToday: number;
  /** Night submissions, by actor id. */
  nightActions: Record<string, NightAction>;
  /**
   * What last night's attacks actually did, one line each.
   *
   * Diagnostics, not game state: nothing reads it back and it is rewritten
   * every night. It exists because "the vigilante fired and nothing happened"
   * had four possible explanations, all of them invisible — armour, a doctor, a
   * cell, or a body somebody else had already made — and telling them apart
   * meant guessing from a chat log.
   */
  nightLog?: NightOutcome[];
  /** Who the jailor locked up for tonight (chosen during the day). */
  jailedId: string | null;
  /**
   * The hands that pulled the rope on a Jester, waiting for the night.
   *
   * The Jester wins by being hanged and then, in the morning, one of the seats
   * that voted him guilty is found dead of remorse. Held here between the
   * verdict and the dawn because the two happen in different phases, and
   * cleared as soon as it is spent. Absent on a table with no Jester in the
   * ground, and on one persisted before this existed.
   */
  jesterHaunt?: string[];
  chat: ChatState;
  /**
   * Public record of every completed trial: after the verdict, the town sees
   * who voted to hang and who voted to save. Reads are made of this.
   */
  trialLog: {
    day: number;
    accusedId: string;
    lynched: boolean;
    guiltyIds: string[];
    innocentIds: string[];
  }[];
  /** The public graveyard, in order of death. `hidden` = cleaned by a janitor. */
  deaths: {
    playerId: string;
    day: number;
    phase: 'day' | 'night';
    cause: Msg;
    /**
     * Every knife that reached this body on the same night, first one first.
     *
     * Absent on the ordinary death with one killer, where `source` says it all.
     * Present when several converged, which is the most informative night the
     * game produces and the one the morning used to describe as though only one
     * person had been out.
     */
    sources?: DeathSource[];
    /**
     * Who struck, when a killer did. Absent for a lynching or a broken heart.
     *
     * Stored alongside the sentence because two things count these: the lone-blade
     * tally that briefly puts the families on the town's side, and the bench. Both
     * used to do it by searching the French cause text for 'Tueur', which worked
     * until the day the text stopped being French.
     */
    source?: DeathSource;
    role: RoleId;
    hidden?: boolean;
  }[];
  /** Personal and faction wins, filled as they happen and at the end. */
  winners: WinEntry[];
  points: PointEntry[];
  /**
   * Who is still at the table: heartbeats, the pause, and any vote to remove
   * somebody. Optional so a table persisted by an older build still parses —
   * `tablePresence` fills it in on first touch.
   */
  presence?: PresenceState;
  createdAt: number;
  lastActivityAt: number;
}

export interface CreateMafiaInput {
  code: string;
  hostToken: string;
  hostUserId: number | null;
  config?: Partial<MafiaConfig>;
  now: number;
}

/**
 * What this game keeps, channel by channel.
 *
 * The square is the record — every death, every verdict, every role that came to
 * light — and a table of twenty-four argues in it for twenty days, so it gets an
 * allowance an order of magnitude past a whisper thread. Announcements are
 * counted separately from talk inside every channel (see `Retention`), so 250
 * here means the last 250 things *said* in the square and the last 250 things the
 * game *announced* there, and no amount of shouting can push out a dawn report.
 *
 * `total` is the ceiling that keeps the state serialisable: 276 possible whisper
 * threads at a table of 24 is more channels than any per-channel budget should be
 * trusted to bound on its own.
 */
export const MAFIA_RETENTION = { perChannel: 50, channels: { day: 250 }, total: 900 };

export function createMafiaGame(input: CreateMafiaInput): MafiaState {
  return {
    code: input.code,
    hostToken: input.hostToken,
    hostUserId: input.hostUserId,
    config: { ...DEFAULT_CONFIG, ...input.config },
    phase: 'lobby',
    day: 0,
    stage: null,
    phaseEndsAt: null,
    phaseStartedAt: null,
    players: {},
    votes: {},
    voteLog: [],
    trial: null,
    trialsToday: 0,
    nightActions: {},
    jailedId: null,
    chat: createChat(MAFIA_RETENTION),
    presence: createPresence(),
    trialLog: [],
    deaths: [],
    winners: [],
    points: [],
    createdAt: input.now,
    lastActivityAt: input.now
  };
}

/**
 * The presence block, created on demand.
 *
 * Tables snapshotted before this feature existed have no `presence`, and the
 * honest way to read one is to give it a fresh empty one rather than to litter
 * every call site with a null check.
 */
export function tablePresence(state: MafiaState): PresenceState {
  state.presence ??= createPresence();
  return state.presence;
}

/**
 * The seats the table actually waits for.
 *
 * Living humans only, and that is the whole rule. A bot is always present, and a
 * dead player has nothing left to do but watch the graveyard chat — so neither
 * can stop the clock, and a wolf who has been hanged cannot hold the town
 * hostage by closing their laptop.
 */
export function waitedOnSeats(state: MafiaState): Roster {
  return Object.values(state.players)
    .filter((player) => !player.isBot && player.alive)
    .map((player) => player.playerId);
}

export function alivePlayers(state: MafiaState): MafiaPlayer[] {
  return Object.values(state.players).filter((player) => player.alive);
}

export function playerBySlot(state: MafiaState, slot: number): MafiaPlayer | undefined {
  return Object.values(state.players).find((player) => player.slot === slot);
}

/** The killing-or-converting family this player belongs to, if any. */
export function playerFamily(player: MafiaPlayer): FamilyId | null {
  return player.role !== null ? familyOf(player.role) : null;
}

/** Kept for readability at call sites that specifically mean the mafia. */
export function isMafia(player: MafiaPlayer): boolean {
  return playerFamily(player) === 'mafia';
}

/** Either half of the lodge. Asked in three places, so it is named once. */
export function isMason(player: MafiaPlayer): boolean {
  return player.role === 'mason' || player.role === 'mason-leader';
}

/** Family members plus masons: the people who share a private channel. */
export function isLodgeMate(a: MafiaPlayer, b: MafiaPlayer): boolean {
  const familyA = playerFamily(a);
  if (familyA !== null) return familyA === playerFamily(b);
  return isMason(a) && isMason(b);
}

/**
 * What one accusation or ballot is worth. A revealed mayor speaks for three.
 *
 * Exported because the engine's lynching threshold and the tally shown beside
 * each name on every phone have to be the same arithmetic. They were two copies
 * of this ternary, so raising the mayor's weight would have moved the threshold
 * while the phones went on counting the old way.
 */
export function voteWeight(player: MafiaPlayer): number {
  return player.role === 'mayor' && player.revealed ? 3 : 1;
}

/** Everything this player has banked: live during the game, and on the podium. */
export function pointsFor(state: MafiaState, playerId: string): number {
  return state.points.filter((entry) => entry.playerId === playerId).reduce((sum, entry) => sum + entry.amount, 0);
}

/** The jail channel is per night, so yesterday's interrogation stays sealed. */
export function jailChannel(day: number): string {
  return `jail:${day}`;
}

/** The whisper channel between two players, whoever sends first. */
export function pmChannel(a: string, b: string): string {
  return `pm:${[a, b].sort().join(':')}`;
}

/** The two participant ids of a pm channel, or null for any other channel. */
export function pmParticipants(channel: string): [string, string] | null {
  if (!channel.startsWith('pm:')) return null;
  const parts = channel.slice(3).split(':');
  return parts.length === 2 ? [parts[0], parts[1]] : null;
}

/**
 * Who may read and write each channel. This is the whole anti-leak story for
 * the chat: the server evaluates these rules per recipient, the client never
 * receives a message it may not read.
 *
 *  - `day`    — the town square. Everyone reads; the living write in daylight.
 *  - `dead`   — the graveyard. Only the dead read and write, until game end.
 *  - `mafia`  — the family. Mafia members read always, write at night.
 *  - `jail:N` — night N's cell. The jailor and that night's prisoner.
 *  - `self:ID` — one seat's own night results, readable by that seat alone.
 *                 Nobody writes here; the engine echoes the private feed into it.
 */
export function chatRules(): ChannelRules<MafiaState> {
  return {
    canRead(channel, memberId, state) {
      if (state.phase === 'ended') return true;
      const member = state.players[memberId];
      if (!member) return false;
      if (channel === 'day') return true;
      if (channel === 'dead') return !member.alive;
      // Family rooms — and the spy's ear pressed to the killing families' walls.
      if (channel === 'mafia' || channel === 'triad' || channel === 'cult') {
        if (playerFamily(member) === channel) return true;
        // A corpse eavesdrops on nobody: the night intel half of the same ear
        // already required a living spy, the wall half did not.
        return member.alive && member.role === 'spy' && channel !== 'cult';
      }
      if (channel === 'mason') return isMason(member);
      if (channel.startsWith('jail:')) {
        return member.role === 'jailor' || (channel === jailChannel(state.day) && state.jailedId === memberId);
      }
      // Your own results, and nobody else's.
      if (channel.startsWith('self:')) return channel === `self:${memberId}`;
      const pm = pmParticipants(channel);
      if (pm) return pm.includes(memberId);
      return false;
    },
    canWrite(channel, memberId, state) {
      const member = state.players[memberId];
      if (!member || state.phase === 'ended' || state.phase === 'lobby') {
        // The lobby small talk happens in `day` before roles exist.
        return state.phase === 'lobby' && channel === 'day' && !!member;
      }
      if (channel === 'dead') return !member.alive;
      if (!member.alive) return false;
      // A stump has opinions and a vote, but no mouth.
      if (member.role === 'stump') return false;
      if (channel === 'day') {
        // The crier's anonymous voice carries through the night.
        if (state.phase === 'night') return member.role === 'crier';
        if (state.phase !== 'day') return false;
        // The blackmailer's gag: present, voting, silent.
        if (member.silencedDay === state.day) return false;
        // During a trial only the accused speaks; the town murmurs after.
        if (state.stage === 'defense') return state.trial?.accusedId === memberId;
        return true;
      }
      if (channel === 'mafia' || channel === 'triad' || channel === 'cult') {
        return state.phase === 'night' && playerFamily(member) === channel;
      }
      if (channel === 'mason') return state.phase === 'night' && isMason(member);
      if (channel === jailChannel(state.day)) {
        if (state.phase !== 'night') return false;
        /**
         * A gag does not stop at the cell door.
         *
         * The blackmailer's letter says "one word tomorrow" and the night in
         * the cell is part of that tomorrow: a prisoner silenced the night
         * before sits in front of the jailor and cannot answer, which is the
         * cruellest and most useful thing the role does. It also closes a hole
         * the town could walk through — a gagged seat had one room left where
         * it could still say "I am the Doctor, check me", and the whole point
         * of the gag is that it cannot.
         *
         * The jailor's own gag is its own business: it is the one asking.
         */
        if (state.jailedId === memberId) return member.silencedDay !== state.day;
        return member.role === 'jailor' && state.jailedId !== null;
      }
      // Whispers: daylight only, between two living players, and a gagged
      // mouth whispers no better than it talks.
      const pm = pmParticipants(channel);
      if (pm) {
        const other = state.players[pm[0] === memberId ? pm[1] : pm[0]];
        return state.phase === 'day' && pm.includes(memberId) && member.silencedDay !== state.day && !!other?.alive;
      }
      return false;
    }
  };
}

/**
 * What language the bots speak at this table.
 *
 * English by default, because a table is usually strangers and English is the
 * common floor. The one exception is a table with exactly **one** human on it: a
 * solo player against a house of bots is not a shared room, it is their room, so
 * the bots meet them in their language.
 *
 * Two or more people and it goes back to English — a bot cannot say one thing to
 * a French speaker and another to a German one in the same channel, and picking
 * one of their languages would leave the other out of the conversation entirely.
 *
 * `config.locale` is the explicit override for a host who knows better than this
 * heuristic; it wins whenever it is set to something other than the default.
 */
export function spokenLocale(state: MafiaState): Locale {
  const humans = Object.values(state.players).filter((player) => !player.isBot);
  if (humans.length === 1) {
    const only = humans[0]?.locale;
    if (only) return only;
  }
  return state.config.locale;
}

/**
 * The cast moved to `lobby-core`, and the draw became a draw.
 *
 * The list used to live here and be walked from the top, so every table opened
 * with Dracula and the names past the fifth were never seen. Both games seat bots
 * from the same lobby now, so they share the pool and pick out of it at random.
 */
export function nextBotName(state: MafiaState, randomInt: (maxExclusive: number) => number): string {
  return pickBotName(
    Object.values(state.players).map((player) => player.name),
    randomInt
  );
}

export function nextFreeSlot(state: MafiaState): number | null {
  const taken = new Set(Object.values(state.players).map((player) => player.slot));
  for (let slot = 1; slot <= state.config.maxPlayers; slot++) {
    if (!taken.has(slot)) return slot;
  }
  return null;
}

/**
 * The published role list: what the table promised, not what it dealt.
 *
 * A preset or a custom list is shown as its *slots* — "Sheriff, Doctor, Random
 * Town ×4, Mafioso ×2, Serial Killer" — because that is public information the
 * moment the host picks it, while the roles those categories actually rolled are
 * exactly the secret the game is about. The automatic roster is deterministic in
 * the seat count, so it can be shown role for role and every player could have
 * worked it out anyway. Chaos and the census promise nothing, so they say so.
 */
export function tableRoleList(state: MafiaState, n: number): SlotToken[] {
  const choice = state.config.setup ?? { mode: 'auto' as const };
  if (choice.mode === 'chaos' || choice.mode === 'census') return Array<SlotToken>(n).fill('any');
  if (choice.mode === 'preset') {
    const preset = setupById(choice.presetId);
    if (preset) return sortRoleList(fitSetup(preset.slots, n));
  }
  if (choice.mode === 'custom' && choice.slots.length > 0) return sortRoleList(fitSetup(choice.slots, n));
  return sortRoleList(rosterFor(n));
}

/** The role list this table's setup deals for `n` seats. */
export function rosterForSetup(state: MafiaState, n: number, rng: () => number): RoleId[] {
  // Older persisted tables predate the field; they deal the automatic roster.
  const choice = state.config.setup ?? { mode: 'auto' as const };
  if (choice.mode === 'chaos') return chaosSetup(n, rng);
  if (choice.mode === 'census') return censusSetup(n, rng);
  if (choice.mode === 'preset') {
    const preset = setupById(choice.presetId);
    if (preset) return rollSetup(fitSetup(preset.slots, n), rng);
  }
  if (choice.mode === 'custom' && choice.slots.length > 0) {
    return rollSetup(fitSetup(choice.slots, n), rng);
  }
  return rosterFor(n);
}

/**
 * Arms one killing family, if the deal forgot to.
 *
 * `familyRank` is what `resolveNight` reads to find a carrier, so "can this
 * family kill" means "does it hold a leader or an executor". A family that
 * holds neither gets its last member handed the standard knife.
 */
function ensureCarrier(players: MafiaPlayer[], faction: 'mafia' | 'triad', knife: RoleId): void {
  const members = players.filter((player) => player.role !== null && roleDef(player.role).faction === faction);
  if (members.length === 0) return;
  const armed = members.some((member) => {
    const rank = roleDef(member.role!).familyRank;
    return rank === 'leader' || rank === 'executor';
  });
  if (armed) return;

  const heir = members[members.length - 1];
  heir.role = knife;
  heir.charges = roleDef(knife).charges ?? 0;
}

/**
 * A Coroner is only a Coroner when somebody is hiding bodies.
 *
 * His whole power is "the true role, cleaned or not", and the second half is
 * the half worth a seat. With nobody on the table who can clean, the autopsy
 * tells him what the dawn report already announced to the entire square — so
 * the town spent one of its slots on a seat that spends every night confirming
 * public information, and the player holding it spends the game explaining why
 * their result is not news.
 *
 * So the Coroner needs a cleaner behind him, and "cleaner" is the action rather
 * than the role name: the Janitor is the mafia's and the Incense Master is the
 * Triad's, they do the same thing, and a rule written against `janitor` alone
 * would deal an idle Coroner onto every Triad table.
 *
 * Repaired after the deal rather than inside each generator, for the reason
 * `ensureCarrier` gives: this is the one place the automatic roster, the
 * presets, the custom lists, chaos and census all pass through.
 *
 * The stand-ins are the rest of the investigative pool. A Coroner that cannot
 * work is still a town investigative *slot* — the table was promised one and
 * should get one — so he becomes the nearest thing nobody else is already
 * wearing, and a Citizen only when the whole pool is taken.
 */
const CORONER_STAND_INS: readonly RoleId[] = ['investigator', 'detective', 'lookout', 'sheriff', 'spy'];

function retireIdleCoroner(players: MafiaPlayer[]): void {
  const coroners = players.filter((player) => player.role === 'coroner');
  if (coroners.length === 0) return;

  const cleaners = players.some(
    (player) => player.role !== null && roleDef(player.role).nightAction === 'clean'
  );
  if (cleaners) return;

  const taken = new Set<RoleId>(players.map((player) => player.role).filter((role): role is RoleId => role !== null));
  for (const coroner of coroners) {
    const role = CORONER_STAND_INS.find((candidate) => !taken.has(candidate)) ?? 'citizen';
    coroner.role = role;
    coroner.charges = roleDef(role).charges ?? 0;
    taken.add(role);
  }
}

/**
 * Deals the roles. `rng` is injectable so tests replay the same deal; the
 * server passes a crypto-backed one.
 */
export function assignRoles(state: MafiaState, rng: () => number): void {
  const players = Object.values(state.players);
  const roster = rosterForSetup(state, players.length, rng);

  // Fisher–Yates on the roster; seats keep their numbers.
  for (let i = roster.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [roster[i], roster[j]] = [roster[j], roster[i]];
  }

  players.forEach((player, index) => {
    const role = roster[index] ?? 'citizen';
    player.role = role;
    player.charges = roleDef(role).charges ?? 0;
  });

  /**
   * Every killing family leaves the deal with a hand that can hold the knife.
   *
   * The roster generators do not promise this and the engine does not check it:
   * `resolveNight` looks for a leader or an executor to carry the family's
   * attack and, finding neither, silently never kills again. A chaos or census
   * table could therefore deal a mafia of pure support — reported from a real
   * game — and the town then had to lynch three harmless Framers one at a time
   * before it was allowed to win.
   *
   * Repaired here rather than in each generator, because this is the one place
   * every mode passes through. The Cult is deliberately absent: it converts and
   * never attacks, so a cult with no knife is a cult working as designed.
   */
  ensureCarrier(players, 'mafia', 'mafioso');
  ensureCarrier(players, 'triad', 'enforcer');

  // A body reader needs somebody hiding bodies. See `retireIdleCoroner`.
  retireIdleCoroner(players);

  // The executioner needs someone to destroy: a town player, never himself.
  for (const player of players) {
    if (player.role === 'executioner') {
      const marks = players.filter((other) => other.role !== null && roleDef(other.role).faction === 'town');
      if (marks.length === 0) {
        player.role = 'jester';
      } else {
        player.obsessionId = marks[Math.floor(rng() * marks.length)]?.playerId ?? null;
      }
    }
  }
}
