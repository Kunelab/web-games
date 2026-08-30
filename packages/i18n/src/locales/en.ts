import type { Catalogue } from '../index.js';
import { rolesEn } from './roles-en.js';
import { atelierEn } from './atelier-en.js';
import { coronazEn } from './coronaz-en.js';
import { lobbyEn } from './lobby-en.js';
import { notesEn } from './notes-en.js';
import { playEn } from './play-en.js';
import { quizEn } from './quiz-en.js';
import { screenEn } from './screen-en.js';
import { shopEn } from './shop-en.js';
import { siteEn } from './site-en.js';

/**
 * English: the reference catalogue and the fallback for every other language.
 *
 * A key must exist here before it may be used anywhere, and `catalogue.test.ts`
 * fails the build if another locale drifts from this list in either direction —
 * a key only `fr` has means a rename left the English fallback showing raw
 * dotted text.
 *
 * Ordering follows the game, not the alphabet: lobby, day, trial, night, ending.
 * A translator reads it top to bottom and sees an evening happen.
 */
export const en: Catalogue = {
  ...rolesEn,
  ...atelierEn,
  ...coronazEn,
  ...lobbyEn,
  ...notesEn,
  ...playEn,
  ...quizEn,
  ...screenEn,
  ...shopEn,
  ...siteEn,

  /* ------------------------------- the clock ------------------------------- */
  'mafia.day.header': '— Day {day} —',
  'mafia.game.start': 'The game begins. Welcome to town — get to know each other, night falls quickly.',
  'mafia.night.fall': 'Night {day} falls on the town. Lock your doors.',
  'mafia.night.quiet': 'Nobody died last night. The town breathes — for now.',

  /* -------------------------------- the day ------------------------------- */
  'mafia.mayor.reveal': '{name} produces a sash: the Mayor! Their vote counts triple.',
  'mafia.marshall.reveal':
    '{name} produces a badge: the Marshall! Today the town judges without a defence — and in bulk.',
  'mafia.whisper.seen': '{from} leans in and whispers to {to}…',

  /* ------------------------------- the trial ------------------------------ */
  'mafia.trial.dragged': 'The town drags {name} to the stand. Defend yourself!',
  'mafia.trial.noDefence': '{name} is dragged to the stand. The Marshall refuses a defence: vote!',
  'mafia.trial.judging': 'The town judges {name}: guilty or innocent?',
  'mafia.trial.court': 'A voice booms: “EXCEPTIONAL COURT!” {name} is judged on the spot, without a defence.',
  'mafia.trial.verdict': 'Verdict: {guilty} guilty, {innocent} innocent.',
  'mafia.trial.ballots': 'Voted guilty: {guilty}. Voted innocent: {innocent}.',
  'mafia.trial.secret': 'The exceptional court voted by secret ballot: no name leaves this room.',
  'mafia.trial.spared': '{name} is spared.',
  'mafia.trial.nobody': 'nobody',
  'mafia.vote.skipped': 'The town would rather hang nobody today. Night falls.',

  'mafia.pause.begun': 'The clock stops: the table is waiting for {names}.',
  'mafia.pause.resumed': 'Everybody is back. Play continues.',
  'mafia.kick.proposed': 'A vote has opened on carrying on without {name}.',
  'mafia.kick.carried': 'The table votes to carry on without {name}.',
  'mafia.kick.failed': 'The table gives {name} more time.',

  /* -------------------------------- deaths -------------------------------- */
  'mafia.death.hanged': '{name} swings from the rope. {body}',
  'mafia.death.found': '{name} was found dead — {cause}. {body}',
  'mafia.death.grief': '{name} died of a broken heart. {body}',
  'mafia.death.will': 'Last will of {name}: “{will}”',
  'mafia.seat.left': '{name} has left the table. Nobody killed them. {body}',

  /** What a corpse says, per the table's reveal policy. */
  'mafia.body.role': 'They were the {role}.',
  'mafia.body.faction': 'They belonged to the {faction}.',
  'mafia.body.selfish': 'They served only themselves.',
  'mafia.body.none': 'Their secret died with them.',
  'mafia.body.cleaned': 'The body is unrecognisable.',
  'mafia.body.unknown': 'Nobody will ever know who they were.',

  /* -------------------------------- the night ----------------------------- */
  'mafia.jail.locked': '{name} is in the cell. The conversation is private.',
  'mafia.cult.chant': 'Strange hymns echoed in the night. The Cult grows…',
  'mafia.amnesiac.remembered': 'The Amnesiac remembered: they were the {role}, like {name}.',

  'mafia.roster.diedOn': '{cause}, day {day}',

  /* ---------------------- how somebody died, and by whose hand --------------- */
  'mafia.cause.lynched': 'hanged by the town',
  'mafia.cause.grief': 'died of grief',
  'mafia.cause.guard': 'died protecting {name}',
  'mafia.cause.bodyguard': 'cut down by a bodyguard',
  'mafia.cause.killedBy': 'killed by {source}',
  'mafia.cause.left': 'left the table',
  'mafia.cause.unknown': 'no explanation',
  'mafia.source.poison': 'the poison',
  'mafia.source.arsonist': 'the Arsonist',
  'mafia.source.electromaniac': 'the Electromaniac',
  'mafia.source.vigilante': 'the Vigilante',
  'mafia.source.serialKiller': 'the Serial Killer',
  'mafia.source.massMurderer': 'the Mass Murderer',
  'mafia.source.jailor': 'the Jailor',
  'mafia.source.veteran': 'the Veteran',
  'mafia.source.mafia': 'the Mafia',
  'mafia.source.triad': 'the Triad',
  'mafia.source.cult': 'the Cult',

  /* -------------------------------- endings ------------------------------- */
  'mafia.win.town': 'The town is purged. The Town wins!',
  'mafia.win.mafia': 'The family controls the town. The Mafia wins!',
  'mafia.win.triad': 'The Dragon uncoils. The Triad wins!',
  'mafia.win.cult': 'The hymns drown everything out. The Cult wins!',
  'mafia.win.jester': 'Laughter rises from the gallows… the Jester wanted that rope. He wins.',
  'mafia.win.serialKiller': 'Nobody answers roll call… except one. The Serial Killer wins.',
  'mafia.win.arsonist': 'The town is nothing but ashes. The Arsonist wins.',
  'mafia.win.massMurderer': 'The silence is total. The Mass Murderer wins.',
  'mafia.win.poisoner': 'Everybody had drunk something, once. The Poisoner wins.',
  'mafia.win.electromaniac': 'The town is still crackling. The Electromaniac wins.',
  'mafia.win.draw': 'The town, exhausted, declares a draw.',
  'mafia.end.unmasked': 'The masks come off: {roster}'
};

export default en;
