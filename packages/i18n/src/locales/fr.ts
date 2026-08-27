import type { Catalogue } from '../index.js';

/**
 * French. The language the game was written in, so these are the originals
 * rather than translations — which is why a few of them are better than their
 * English counterparts and not the other way round.
 *
 * Kept key-for-key with `en`; the catalogue test fails on any drift.
 */
export const fr: Catalogue = {
  /* ------------------------------- the clock ------------------------------- */
  'mafia.day.header': '— Jour {day} —',
  'mafia.game.start':
    'La partie commence. Bienvenue en ville — apprenez à vous connaître, la nuit tombe vite.',
  'mafia.night.fall': 'La nuit {day} tombe sur la ville. Fermez vos portes.',
  'mafia.night.quiet': 'Personne n’est mort cette nuit. La ville respire — pour l’instant.',

  /* -------------------------------- the day ------------------------------- */
  'mafia.mayor.reveal': '{name} sort son écharpe : c’est le Maire ! Son vote compte triple.',
  'mafia.marshall.reveal':
    '{name} sort son insigne : c’est le Prévôt ! Aujourd’hui, la ville juge sans défense — et à la chaîne.',
  'mafia.whisper.seen': '{from} murmure à l’oreille de {to}…',

  /* ------------------------------- the trial ------------------------------ */
  'mafia.trial.dragged': 'La ville traîne {name} à la barre. Défendez-vous !',
  'mafia.trial.noDefence': '{name} est traîné à la barre. Le Prévôt refuse la défense : votez !',
  'mafia.trial.judging': 'La ville juge {name} : coupable ou innocent ?',
  'mafia.trial.court':
    'Une voix tonne : « TRIBUNAL D’EXCEPTION ! » {name} est jugé séance tenante, sans défense.',
  'mafia.trial.verdict': 'Verdict : {guilty} coupable, {innocent} innocent.',
  'mafia.trial.ballots': 'Ont voté coupable : {guilty}. Ont voté innocent : {innocent}.',
  'mafia.trial.secret':
    'Le tribunal d’exception a voté à bulletin secret : aucun nom ne sortira de cette salle.',
  'mafia.trial.spared': '{name} est épargné.',
  'mafia.trial.nobody': 'personne',

  /* -------------------------------- deaths -------------------------------- */
  'mafia.death.hanged': '{name} se balance au bout de la corde. {body}',
  'mafia.death.found': '{name} a été retrouvé mort — {cause}. {body}',
  'mafia.death.grief': '{name} s’est éteint de chagrin. {body}',
  'mafia.death.will': 'Dernières volontés de {name} : « {will} »',

  'mafia.body.role': 'C’était {role}.',
  'mafia.body.faction': 'Il était de la {faction}.',
  'mafia.body.selfish': 'Il ne servait que lui-même.',
  'mafia.body.none': 'Son secret est mort avec lui.',
  'mafia.body.cleaned': 'Le corps est méconnaissable.',
  'mafia.body.unknown': 'On ne saura jamais qui il était.',

  /* -------------------------------- the night ----------------------------- */
  'mafia.jail.locked': '{name} est en cellule. La conversation est privée.',
  'mafia.cult.chant': 'Des cantiques étranges ont résonné cette nuit. La Secte grandit…',
  'mafia.amnesiac.remembered': 'L’Amnésique s’est souvenu : il était {role}, comme {name}.',

  'mafia.roster.diedOn': '{cause}, jour {day}',

  /* ---------------------- how somebody died, and by whose hand --------------- */
  'mafia.cause.lynched': 'pendu par la ville',
  'mafia.cause.grief': 'mort de chagrin',
  'mafia.cause.guard': 'mort en protégeant {name}',
  'mafia.cause.bodyguard': 'abattu par un garde du corps',
  'mafia.cause.killedBy': 'tué par {source}',
  'mafia.cause.unknown': 'sans explication',
  'mafia.source.poison': 'le poison',
  'mafia.source.arsonist': 'l’Incendiaire',
  'mafia.source.electromaniac': 'l’Électromane',
  'mafia.source.vigilante': 'le Justicier',
  'mafia.source.serialKiller': 'le Tueur en série',
  'mafia.source.massMurderer': 'le Tueur de masse',
  'mafia.source.jailor': 'le Geôlier',
  'mafia.source.veteran': 'le Vétéran',
  'mafia.source.mafia': 'la Mafia',
  'mafia.source.triad': 'la Triade',
  'mafia.source.cult': 'la Secte',

  /* -------------------------------- endings ------------------------------- */
  'mafia.win.town': 'La ville est purgée. La Ville l’emporte !',
  'mafia.win.mafia': 'La famille contrôle la ville. La Mafia l’emporte !',
  'mafia.win.triad': 'Le Dragon déploie ses anneaux. La Triade l’emporte !',
  'mafia.win.cult': 'Les cantiques couvrent tout. La Secte l’emporte !',
  'mafia.win.jester': 'Un rire monte du gibet… le Bouffon voulait cette corde. Il gagne.',
  'mafia.win.serialKiller': 'Plus personne ne répond à l’appel… sauf un. Le Tueur en série l’emporte.',
  'mafia.win.arsonist': 'La ville n’est plus que cendres. L’Incendiaire l’emporte.',
  'mafia.win.massMurderer': 'Le silence est total. Le Tueur de masse l’emporte.',
  'mafia.win.poisoner': 'Tout le monde avait bu quelque chose, un jour. L’Empoisonneur l’emporte.',
  'mafia.win.electromaniac': 'La ville grésille encore. L’Électromane l’emporte.',
  'mafia.win.draw': 'La ville, épuisée, déclare un match nul.',
  'mafia.end.unmasked': 'Les masques tombent : {roster}'
};

export default fr;
