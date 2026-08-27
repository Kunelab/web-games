import { msg, type Msg } from 'i18n';

import { FACTION_LABELS, roleDef, type Faction, type RoleId } from './roles.js';

/**
 * Every sentence this game says, as a typed factory.
 *
 * The engine builds one of these instead of a French string, and the key it
 * carries is resolved by whoever is reading — see `i18n`'s header for why the
 * decision runs that way. Gathered in one file so a translator can see the whole
 * script and a reviewer can see, at a glance, that nothing untranslatable
 * escaped: if a call site does not go through `M`, it does not get said.
 *
 * Two things are deliberately *not* keys.
 *
 * Player names go through as parameters, because they are proper nouns. And a
 * **role name** is passed as a parameter too rather than as a nested key — which
 * looks like a mistake and is not. Nesting would mean a client resolving
 * `mafia.body.role` then resolving `role.godfather` inside it, so a catalogue
 * entry would need to know it contains a key. Roles are content with their own
 * localisation table (`roles.ts`), and the engine already holds a resolved name
 * by the time it announces anything; passing the string keeps the catalogue flat
 * and the interpolation dumb, which is worth more than the purity.
 */
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
  /** 'nobody' — a word, so it travels as a fragment rather than a literal. */
  nobody: (): Msg => msg('mafia.trial.nobody'),

  /* --------------------------------- deaths -------------------------------- */
  hanged: (name: string, body: Msg): Msg => msg('mafia.death.hanged', { name, body }),
  found: (name: string, cause: Msg, body: Msg): Msg => msg('mafia.death.found', { name, cause, body }),
  grief: (name: string, body: Msg): Msg => msg('mafia.death.grief', { name, body }),
  lastWill: (name: string, will: string): Msg => msg('mafia.death.will', { name, will }),

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
  unmasked: (roster: string): Msg => msg('mafia.end.unmasked', { roster })
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
  role: (role: RoleId): Msg => msg('mafia.body.role', { role: roleDef(role).name }),
  faction: (faction: Faction): Msg =>
    faction === 'neutral' ? msg('mafia.body.selfish') : msg('mafia.body.faction', { faction: FACTION_LABELS[faction] }),
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
  unknown: (): Msg => msg('mafia.cause.unknown')
};
