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
  badTarget: (): Msg => msg('mafia.refuse.badTarget'),
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
  survived: (): Msg => msg('mafia.note.survived'),
  guarded: (): Msg => msg('mafia.note.guarded'),
  bodyguardRepelled: (): Msg => msg('mafia.note.bodyguardRepelled'),
  purged: (): Msg => msg('mafia.note.purged'),
  healed: (): Msg => msg('mafia.note.healed'),
  healSaved: (): Msg => msg('mafia.note.healSaved'),

  familyAimed: (family: Faction, slot: number): Msg =>
    msg('mafia.note.familyAimed', { family: FACTION(family), slot }),
  sheriff: (name: string, suspect: boolean): Msg =>
    msg(suspect ? 'mafia.note.sheriffSuspect' : 'mafia.note.sheriffClear', { name }),
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
  winDraw: (): Msg => msg('mafia.win.draw'),
  unmasked: (roster: string): Msg => msg('mafia.end.unmasked', { roster }),

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
  | 'cult';

const SOURCE = (source: DeathSource): Msg => msg(`mafia.source.${source}`);

export const CAUSE = {
  lynched: (): Msg => msg('mafia.cause.lynched'),
  grief: (): Msg => msg('mafia.cause.grief'),
  guard: (name: string): Msg => msg('mafia.cause.guard', { name }),
  bodyguard: (): Msg => msg('mafia.cause.bodyguard'),
  killedBy: (source: DeathSource): Msg => msg('mafia.cause.killedBy', { source: SOURCE(source) }),
  /** Left the table: not a death, and the record must not pretend otherwise. */
  left: (): Msg => msg('mafia.cause.left'),
  unknown: (): Msg => msg('mafia.cause.unknown')
};
