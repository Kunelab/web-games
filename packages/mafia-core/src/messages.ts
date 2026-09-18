import { msg, type Msg } from 'i18n';

import { ROLES, type Faction, type NightActionType, type RoleId } from './roles.js';
import type { SlotToken } from './setups.js';

/**
 * Every sentence this game says, as a typed factory.
 *
 * The engine builds one of these instead of a French string, and the key it
 * carries is resolved by whoever is reading — see `i18n`'s header for why the
 * decision runs that way. Gathered in one file so a translator can see the whole
 * script and a reviewer can see, at a glance, that nothing untranslatable
 * escaped: if a call site does not go through `M`, it does not get said.
 *
 * One thing is deliberately *not* a key: player names, because they are proper
 * nouns and belong to their owner in every language.
 *
 * A **role name** used to be passed through as a resolved French string, on the
 * argument that nesting would make a catalogue entry "know it contains a key".
 * It does not: `render` walks the parameters and resolves any `Msg` it finds
 * before interpolating, so `mafia.body.role` reads `{role}` and never learns what
 * produced it. Passing the string instead had one consequence and it was the
 * wrong one — an English reader was told, in English, that the body "was the
 * Parrain". So roles, camps and night verbs travel as nested fragments now; see
 * `ROLE`, `FACTION` and `ACTION` below.
 */

/**
 * The cast, as fragments.
 *
 * A role has three names in this codebase and only one of them is a word: the
 * `RoleId` (stable, machine), the French `name` on its `RoleDef` (for the bot
 * prompts and the headless transcript, neither of which is a person), and this —
 * the key a reader's own catalogue resolves. Anything that reaches a screen goes
 * through here, nested into a sentence or rendered on its own.
 */
export const ROLE = {
  name: (role: RoleId): Msg => msg(`mafia.role.${role}.name`),
  description: (role: RoleId): Msg => msg(`mafia.role.${role}.desc`)
};

export const FACTION = (faction: Faction): Msg => msg(`mafia.faction.${faction}`);

/**
 * The verb the night power puts on a button.
 *
 * `self` is not decoration: pointing the match at your own house is a different
 * sentence from pointing it at somebody else's, and only two powers have one.
 */
export const ACTION = (action: NightActionType, self = false): Msg =>
  msg(self ? `mafia.action.${action}.self` : `mafia.action.${action}`);

/**
 * One line of the published role list.
 *
 * A slot is either an exact role — which reads as that role's name — or a
 * category that will roll one of a pool at the start, which reads as the
 * category. Both are `SlotToken`s, so the caller never has to know which it holds.
 */
export const SLOT = (token: SlotToken): Msg =>
  token in ROLES ? ROLE.name(token as RoleId) : msg(`mafia.slot.${token}`);

/**
 * What the table says when it says no.
 *
 * Every refusal an action can return, in one place, keyed rather than written —
 * these used to be French string literals scattered through the engine and shown
 * verbatim to whoever pressed the button, in whatever language they were reading
 * the rest of the screen in.
 */
export const NO = {
  notAtTable: (): Msg => msg('mafia.refuse.notAtTable'),
  paused: (): Msg => msg('mafia.refuse.paused'),
  deadNoVote: (): Msg => msg('mafia.refuse.deadNoVote'),
  notNow: (): Msg => msg('mafia.refuse.notNow'),
  firstDay: (): Msg => msg('mafia.refuse.firstDay'),
  stillTalking: (): Msg => msg('mafia.refuse.stillTalking'),
  badTarget: (): Msg => msg('mafia.refuse.badTarget'),
  /** A Witch or a Bus Driver named one house where the power wants two. */
  needsSecondTarget: (): Msg => msg('mafia.refuse.needsSecondTarget'),
  /** Both halves of a two-house order landed on the same doorstep. */
  sameTwice: (): Msg => msg('mafia.refuse.sameTwice'),
  notYourself: (): Msg => msg('mafia.refuse.notYourself'),
  accusedSilent: (): Msg => msg('mafia.refuse.accusedSilent'),
  waitForDay: (): Msg => msg('mafia.refuse.waitForDay'),
  noAction: (): Msg => msg('mafia.refuse.noAction'),
  dayOnly: (): Msg => msg('mafia.refuse.dayOnly'),
  noRecipient: (): Msg => msg('mafia.refuse.noRecipient'),
  alreadyRevealed: (): Msg => msg('mafia.refuse.alreadyRevealed'),
  whisperNotNow: (): Msg => msg('mafia.refuse.whisperNotNow'),
  impossible: (): Msg => msg('mafia.refuse.impossible'),
  courtSpent: (): Msg => msg('mafia.refuse.courtSpent'),
  nobodyAccused: (): Msg => msg('mafia.refuse.nobodyAccused'),
  /** Two houses level at the top: the room has not named anybody. */
  courtSplit: (): Msg => msg('mafia.refuse.courtSplit'),
  whisperSelf: (): Msg => msg('mafia.refuse.whisperSelf'),
  tooLate: (): Msg => msg('mafia.refuse.tooLate'),
  cannotSpeakHere: (): Msg => msg('mafia.refuse.cannotSpeakHere'),
  noTable: (): Msg => msg('mafia.refuse.noTable'),
  notSeated: (): Msg => msg('mafia.refuse.notSeated'),
  badRequest: (): Msg => msg('mafia.refuse.badRequest'),
  emptyMessage: (): Msg => msg('mafia.refuse.emptyMessage'),
  messageTooLong: (): Msg => msg('mafia.refuse.messageTooLong'),
  slowDown: (): Msg => msg('mafia.refuse.slowDown'),
  tableMovedOn: (): Msg => msg('mafia.refuse.tableMovedOn'),
  alreadyStarted: (): Msg => msg('mafia.refuse.alreadyStarted'),
  nameRequired: (): Msg => msg('mafia.refuse.nameRequired'),
  nameTaken: (): Msg => msg('mafia.refuse.nameTaken'),
  tableFull: (): Msg => msg('mafia.refuse.tableFull'),
  alreadyRunning: (): Msg => msg('mafia.refuse.alreadyRunning'),
  needPlayers: (count: number): Msg => msg('mafia.refuse.needPlayers', { count }),
  hostOnly: (): Msg => msg('mafia.refuse.hostOnly'),
  startFailed: (): Msg => msg('mafia.refuse.startFailed'),
  joinFailed: (): Msg => msg('mafia.refuse.joinFailed')
};

/**
 * A refusal that has to travel as an exception.
 *
 * A handful of entry points — joining, seating a bot, starting the game — answer
 * by throwing rather than by returning an `ActionOutcome`, because there is no
 * table to return anything about. The socket layer put `error.message` straight
 * into the ack, so those were the last French sentences on an English screen.
 * Carrying the key on the error keeps the throw and localises the landing.
 */
export class MafiaError extends Error {
  readonly msg: Msg;

  constructor(message: Msg, fallback: string) {
    super(fallback);
    this.name = 'MafiaError';
    this.msg = message;
  }
}

/** Reads the key off a thrown value, or falls back to a caller's own. */
export function refusalOf(error: unknown, fallback: Msg): Msg {
  return error instanceof MafiaError ? error.msg : fallback;
}

/**
 * The private feed: what the night told one player and nobody else.
 *
 * Kept apart from `M` because the audience is different in kind. `M` is the
 * square — one record, replayed, shown on a television. These land in one seat's
 * own `notifications`, and the only other reader is the briefing a bot is given.
 */
export const NOTE = {
  roleDealt: (role: RoleId): Msg =>
    msg('mafia.note.roleDealt', { role: ROLE.name(role), description: ROLE.description(role) }),
  obsession: (name: string, slot: number): Msg => msg('mafia.note.obsession', { name, slot }),
  jailedNight: (): Msg => msg('mafia.note.jailedNight'),
  jesterWon: (): Msg => msg('mafia.note.jesterWon'),
  execWon: (): Msg => msg('mafia.note.execWon'),
  griefMad: (): Msg => msg('mafia.note.griefMad'),
  remembered: (role: RoleId): Msg => msg('mafia.note.remembered', { role: ROLE.name(role) }),
  /** The family had nobody left who could kill, and now this seat can. */
  promoted: (role: RoleId): Msg => msg('mafia.note.promoted', { role: ROLE.name(role) }),
  audited: (role: RoleId): Msg => msg('mafia.note.audited', { role: ROLE.name(role) }),

  onAlert: (): Msg => msg('mafia.note.onAlert'),
  vestOn: (): Msg => msg('mafia.note.vestOn'),
  controlDone: (name: string, other: string): Msg => msg('mafia.note.controlDone', { name, other }),
  controlIdle: (name: string): Msg => msg('mafia.note.controlIdle', { name }),
  busDone: (first: string, second: string): Msg => msg('mafia.note.busDone', { first, second }),
  silenceDone: (name: string): Msg => msg('mafia.note.silenceDone', { name }),
  douseDone: (name: string): Msg => msg('mafia.note.douseDone', { name }),
  chargeDone: (name: string): Msg => msg('mafia.note.chargeDone', { name }),
  poisonDone: (name: string): Msg => msg('mafia.note.poisonDone', { name }),
  disguised: (role: RoleId): Msg => msg('mafia.note.disguised', { role: ROLE.name(role) }),
  hiding: (name: string): Msg => msg('mafia.note.hiding', { name }),
  charmDone: (name: string): Msg => msg('mafia.note.charmDone', { name }),
  bondDone: (name: string): Msg => msg('mafia.note.bondDone', { name }),
  cleaned: (name: string, role: RoleId): Msg => msg('mafia.note.cleaned', { name, role: ROLE.name(role) }),
  initiateDone: (name: string): Msg => msg('mafia.note.initiateDone', { name }),
  initiateRefused: (name: string): Msg => msg('mafia.note.initiateRefused', { name }),
  convertDone: (name: string): Msg => msg('mafia.note.convertDone', { name }),
  convertRefused: (name: string): Msg => msg('mafia.note.convertRefused', { name }),
  auditDone: (name: string): Msg => msg('mafia.note.auditDone', { name }),
  auditFailed: (name: string): Msg => msg('mafia.note.auditFailed', { name }),
  executedInnocent: (): Msg => msg('mafia.note.executedInnocent'),

  controlled: (): Msg => msg('mafia.note.controlled'),
  bussed: (): Msg => msg('mafia.note.bussed'),
  kidnapped: (): Msg => msg('mafia.note.kidnapped'),
  /** To the kidnapper, who used to be told nothing whatsoever. */
  kidnapDone: (name: string): Msg => msg('mafia.note.kidnapDone', { name }),
  blocked: (): Msg => msg('mafia.note.blocked'),
  silenced: (): Msg => msg('mafia.note.silenced'),
  doused: (): Msg => msg('mafia.note.doused'),
  poisoned: (): Msg => msg('mafia.note.poisoned'),
  charmed: (): Msg => msg('mafia.note.charmed'),
  bonded: (name: string): Msg => msg('mafia.note.bonded', { name }),
  initiated: (): Msg => msg('mafia.note.initiated'),
  converted: (): Msg => msg('mafia.note.converted'),

  targetMissing: (): Msg => msg('mafia.note.targetMissing'),
  attackFailed: (): Msg => msg('mafia.note.attackFailed'),
  /**
   * Why it failed, which the attacker was never told.
   *
   * One sentence covered a knife that hit armour, a knife a doctor undid and a
   * knife that arrived at a body somebody else had already made — three
   * different facts about the night, each worth knowing and each worth a
   * different decision tomorrow. "It did not work" is the one reading that
   * teaches nothing.
   */
  attackImmune: (): Msg => msg('mafia.note.attackImmune'),
  attackVested: (): Msg => msg('mafia.note.attackVested'),
  attackHealed: (): Msg => msg('mafia.note.attackHealed'),
  attackTooLate: (): Msg => msg('mafia.note.attackTooLate'),
  /** And the other end of the same silence: a night's work that did land. */
  blockDone: (name: string): Msg => msg('mafia.note.blockDone', { name }),
  blockFailed: (name: string): Msg => msg('mafia.note.blockFailed', { name }),
  /** A charge role with nothing left to spend, told before it wastes the night deciding. */
  powerSpent: (): Msg => msg('mafia.note.powerSpent'),
  survived: (): Msg => msg('mafia.note.survived'),
  guarded: (): Msg => msg('mafia.note.guarded'),
  bodyguardRepelled: (): Msg => msg('mafia.note.bodyguardRepelled'),
  purged: (): Msg => msg('mafia.note.purged'),
  healed: (): Msg => msg('mafia.note.healed'),
  healSaved: (): Msg => msg('mafia.note.healSaved'),

  familyAimed: (family: Faction, slot: number): Msg => msg('mafia.note.familyAimed', { family: FACTION(family), slot }),
  /**
   * The needle, and what it pointed at.
   *
   * One key per verdict rather than a boolean, so the private feed says "is a
   * SERIAL KILLER" where it used to say "is SUSPICIOUS" — the difference
   * between a lead and a fact.
   */
  sheriff: (name: string, verdict: string): Msg =>
    msg(verdict === 'clear' ? 'mafia.note.sheriffClear' : `mafia.note.sheriff.${verdict}`, { name }),
  exactRole: (name: string, role: RoleId): Msg => msg('mafia.note.exactRole', { name, role: ROLE.name(role) }),
  /** `trade` is a trade id from `RoleDef.investigated`, not a sentence. */
  tradeLine: (name: string, trade: string): Msg =>
    msg('mafia.note.tradeLine', { name, line: msg(`mafia.trade.${trade}`) }),
  visitors: (name: string, names: string[]): Msg =>
    names.length > 0
      ? msg('mafia.note.visitorsSeen', { name, names: names.join(', ') })
      : msg('mafia.note.visitorsNone', { name }),
  tracked: (name: string, names: string[]): Msg =>
    names.length > 0
      ? msg('mafia.note.trackedTo', { name, names: names.join(', ') })
      : msg('mafia.note.trackedHome', { name }),
  autopsy: (name: string, role: RoleId): Msg => msg('mafia.note.autopsy', { name, role: ROLE.name(role) })
};

export const M = {
  /* -------------------------------- the clock ------------------------------- */
  dayHeader: (day: number): Msg => msg('mafia.day.header', { day }),
  gameStart: (): Msg => msg('mafia.game.start'),
  nightFall: (day: number): Msg => msg('mafia.night.fall', { day }),
  nightQuiet: (): Msg => msg('mafia.night.quiet'),

  /* --------------------------------- the day ------------------------------- */
  mayorReveal: (name: string): Msg => msg('mafia.mayor.reveal', { name }),
  marshallReveal: (name: string): Msg => msg('mafia.marshall.reveal', { name }),
  whisperSeen: (from: string, to: string): Msg => msg('mafia.whisper.seen', { from, to }),

  /* -------------------------------- the trial ------------------------------ */
  trialDragged: (name: string): Msg => msg('mafia.trial.dragged', { name }),
  /**
   * The gagged accused, spoken for.
   *
   * A blackmailed seat cannot type, and a trial is the one moment the whole room
   * is waiting for exactly that seat to type. Left alone it reads as contempt,
   * and the room hangs it for the silence. So the game says the one thing the
   * seat is allowed to have said — which is also, deliberately, a sentence any
   * seat that *can* speak may choose to say and then fall silent behind.
   */
  trialMuted: (name: string): Msg => msg('mafia.trial.muted', { name }),
  trialNoDefence: (name: string): Msg => msg('mafia.trial.noDefence', { name }),
  trialJudging: (name: string): Msg => msg('mafia.trial.judging', { name }),
  trialCourt: (name: string): Msg => msg('mafia.trial.court', { name }),
  trialVerdict: (guilty: number, innocent: number): Msg => msg('mafia.trial.verdict', { guilty, innocent }),
  trialBallots: (guilty: string | Msg, innocent: string | Msg): Msg => msg('mafia.trial.ballots', { guilty, innocent }),
  trialSecret: (): Msg => msg('mafia.trial.secret'),
  trialSpared: (name: string): Msg => msg('mafia.trial.spared', { name }),
  /** The town used its day to decide it would rather not hang anybody. */
  voteSkipped: (): Msg => msg('mafia.vote.skipped'),
  /** 'nobody' — a word, so it travels as a fragment rather than a literal. */
  nobody: (): Msg => msg('mafia.trial.nobody'),

  /* --------------------------------- deaths -------------------------------- */
  hanged: (name: string, body: Msg): Msg => msg('mafia.death.hanged', { name, body }),
  found: (name: string, cause: Msg, body: Msg): Msg => msg('mafia.death.found', { name, cause, body }),
  grief: (name: string, body: Msg): Msg => msg('mafia.death.grief', { name, body }),
  lastWill: (name: string, will: string): Msg => msg('mafia.death.will', { name, will }),
  /**
   * A seat that left the table, by its own hand or the room's vote.
   *
   * Its own line rather than one of the death notices, because it is not a
   * death and reading it as one would poison every deduction that follows: the
   * town needs to know that nobody killed this person.
   */
  seatLeft: (name: string, body: Msg): Msg => msg('mafia.seat.left', { name, body }),
  /** The clock stopped: the room is waiting for somebody to come back. */
  paused: (names: string): Msg => msg('mafia.pause.begun', { names }),
  /** Everybody is back; play continues. */
  resumed: (): Msg => msg('mafia.pause.resumed'),
  /** The room is being asked whether to carry on without an absentee. */
  kickProposed: (name: string): Msg => msg('mafia.kick.proposed', { name }),
  kickCarried: (name: string): Msg => msg('mafia.kick.carried', { name }),
  kickFailed: (name: string): Msg => msg('mafia.kick.failed', { name }),

  /* -------------------------------- the night ------------------------------ */
  jailLocked: (name: string): Msg => msg('mafia.jail.locked', { name }),
  cultChant: (): Msg => msg('mafia.cult.chant'),
  amnesiacRemembered: (role: string, name: string): Msg => msg('mafia.amnesiac.remembered', { role, name }),

  /* --------------------------------- endings ------------------------------- */
  winTown: (): Msg => msg('mafia.win.town'),
  winFamily: (family: 'mafia' | 'triad' | 'cult'): Msg =>
    msg(family === 'mafia' ? 'mafia.win.mafia' : family === 'triad' ? 'mafia.win.triad' : 'mafia.win.cult'),
  winJester: (): Msg => msg('mafia.win.jester'),
  winSolo: (role: RoleId): Msg => msg(SOLO_WIN_KEY[role] ?? 'mafia.win.serialKiller'),
  /**
   * Said on the last quiet day, before the standing order takes the game.
   *
   * A game that simply stops reads as broken however correct the rule is. This
   * gives the room the one thing it can still act on: one more day to find
   * somebody, and after that it is decided for them.
   */
  lastQuietDay: (): Msg => msg('mafia.win.lastQuietDay'),
  /** The last two seats were her and somebody she could steer. See `witchDuel`. */
  winWitch: (): Msg => msg('mafia.win.witch'),
  winDraw: (): Msg => msg('mafia.win.draw'),
  /** Every enemy dead, and every townsman with them: nobody carried it. */
  winHollow: (): Msg => msg('mafia.win.hollow'),
  /**
   * The header over the reveal, and then one row per seat.
   *
   * It used to be a single line with the whole roster interpolated into it as a
   * string — which meant the roles had to be rendered *here*, in the engine,
   * before anybody knew who was reading. `roleDef().name` is the French
   * constant on the role table, so an English table watched its own game end
   * with "Max — Consigliere · Nemo — Guetteur · Mario — Limier". Every other
   * announcement in this game travels as a key for exactly this reason.
   *
   * A row at a time, so the role can travel as a nested `Msg` and each phone
   * renders it in its owner's language. It reads better in a transcript too:
   * one greppable line per seat instead of a paragraph of middle dots.
   */
  unmasked: (): Msg => msg('mafia.end.unmasked'),
  unmaskedRow: (slot: number, name: string, role: Msg): Msg => msg('mafia.end.unmaskedRow', { slot, name, role }),

  /**
   * The line under a winner's name on the podium.
   *
   * Keyed by the same identifier the ledger branches on, so the words and the
   * accounting cannot disagree — they used to be French prose that other code
   * matched substrings against, which is how a Lover pair once scored a
   * survivor win.
   */
  winReason: (kind: string): Msg => msg(`mafia.win.reason.${kind}`)
};

const SOLO_WIN_KEY: Partial<Record<RoleId, string>> = {
  'serial-killer': 'mafia.win.serialKiller',
  arsonist: 'mafia.win.arsonist',
  'mass-murderer': 'mafia.win.massMurderer',
  poisoner: 'mafia.win.poisoner',
  electromaniac: 'mafia.win.electromaniac'
};

/**
 * What a corpse says, as a nested fragment.
 *
 * Composed into a death line rather than flattened into it, so the reveal policy
 * and the manner of death stay independent. One flat key per combination would be
 * a dozen near-identical sentences, and near-identical sentences are precisely
 * what drifts apart between languages.
 */
export const BODY = {
  role: (role: RoleId): Msg => msg('mafia.body.role', { role: ROLE.name(role) }),
  faction: (faction: Faction): Msg =>
    faction === 'neutral' ? msg('mafia.body.selfish') : msg('mafia.body.faction', { faction: FACTION(faction) }),
  none: (): Msg => msg('mafia.body.none'),
  cleaned: (): Msg => msg('mafia.body.cleaned'),
  unknown: (): Msg => msg('mafia.body.unknown')
};

/**
 * Who or what killed somebody.
 *
 * These used to be French display strings living on the `Attack` record — and,
 * worse, the resolver branched on them: `attack.label === 'le Geôlier'` decided
 * whether a doctor could save the victim. A rule keyed on a sentence is a rule
 * that breaks the moment somebody improves the sentence, so the source is now a
 * stable identifier and the words hang off it here.
 */
export type DeathSource =
  | 'poison'
  | 'arsonist'
  | 'electromaniac'
  | 'vigilante'
  | 'serialKiller'
  | 'massMurderer'
  | 'jailor'
  | 'veteran'
  | 'mafia'
  | 'triad'
  | 'cult'
  /** The Jester's last laugh: a hand that pulled the rope, and could not live with it. */
  | 'remorse';

const SOURCE = (source: DeathSource): Msg => msg(`mafia.source.${source}`);

/**
 * A list of things, in a sentence, in whichever language is reading it.
 *
 * Built out of a pair and a comma rather than out of `join`, because the word
 * between the last two items is not the same in every language and is not a
 * comma in any of them. Two keys, and any length of list.
 */
const JOIN = (parts: readonly Msg[]): Msg =>
  parts.length <= 1
    ? (parts[0] ?? msg('mafia.cause.unknown'))
    : parts.length === 2
      ? msg('mafia.list.pair', { a: parts[0], b: parts[1] })
      : msg('mafia.list.more', { a: parts[0], b: JOIN(parts.slice(1)) });

export const CAUSE = {
  lynched: (): Msg => msg('mafia.cause.lynched'),
  grief: (): Msg => msg('mafia.cause.grief'),
  remorse: (): Msg => msg('mafia.cause.remorse'),
  guard: (name: string): Msg => msg('mafia.cause.guard', { name }),
  bodyguard: (): Msg => msg('mafia.cause.bodyguard'),
  killedBy: (source: DeathSource): Msg => msg('mafia.cause.killedBy', { source: SOURCE(source) }),
  /**
   * Everybody whose knife reached the same body on the same night.
   *
   * The report named one of them, always the first to resolve, and the others
   * vanished: a seat the Mafia and the Serial Killer both visited read exactly
   * like a seat only the Mafia visited, and a Vigilante who fired into a house
   * the family had already emptied lost a bullet, learned nothing, and watched
   * the town credit somebody else. Three killers converging on one house is the
   * most informative thing a night can produce, and it was the one thing the
   * morning did not say.
   */
  killedByAll: (sources: readonly DeathSource[]): Msg =>
    msg('mafia.cause.killedBy', { source: JOIN(sources.map((source) => SOURCE(source))) }),
  /** Left the table: not a death, and the record must not pretend otherwise. */
  left: (): Msg => msg('mafia.cause.left'),
  unknown: (): Msg => msg('mafia.cause.unknown')
};
