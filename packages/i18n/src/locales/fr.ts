import type { Catalogue } from '../index.js';
import { rolesFr } from './roles-fr.js';
import { atelierFr } from './atelier-fr.js';
import { coronazFr } from './coronaz-fr.js';
import { lobbyFr } from './lobby-fr.js';
import { notesFr } from './notes-fr.js';
import { playFr } from './play-fr.js';
import { quizFr } from './quiz-fr.js';
import { screenFr } from './screen-fr.js';
import { shopFr } from './shop-fr.js';
import { siteFr } from './site-fr.js';

/**
 * French. The language the game was written in, so these are the originals
 * rather than translations — which is why a few of them are better than their
 * English counterparts and not the other way round.
 *
 * Kept key-for-key with `en`; the catalogue test fails on any drift.
 */
export const fr: Catalogue = {
  ...rolesFr,
  ...atelierFr,
  ...coronazFr,
  ...lobbyFr,
  ...notesFr,
  ...playFr,
  ...quizFr,
  ...screenFr,
  ...shopFr,
  ...siteFr,

  /* ------------------------------- the clock ------------------------------- */
  'mafia.day.header': '— Jour {day} —',
  'mafia.game.start': 'La partie commence. Bienvenue en ville — apprenez à vous connaître, la nuit tombe vite.',
  'mafia.night.fall': 'La nuit {day} tombe sur la ville. Fermez vos portes.',
  'mafia.night.quiet': 'Personne n’est mort cette nuit. La ville respire — pour l’instant.',

  /* -------------------------------- the day ------------------------------- */
  'mafia.mayor.reveal': '{name} sort son écharpe : c’est le Maire ! Son vote compte triple.',
  'mafia.marshall.reveal':
    '{name} sort son insigne : c’est le Prévôt ! Aujourd’hui, la ville juge sans défense — et à la chaîne.',
  'mafia.whisper.seen': '{from} murmure à l’oreille de {to}…',

  /* ------------------------------- the trial ------------------------------ */
  'mafia.trial.dragged': 'La ville traîne {name} à la barre. Défendez-vous !',
  'mafia.trial.muted': '{name} : « Je suis muet. »',
  'mafia.trial.noDefence': '{name} est traîné à la barre. Le Prévôt refuse la défense : votez !',
  'mafia.trial.judging': 'La ville juge {name} : coupable ou innocent ?',
  'mafia.trial.court': 'Une voix tonne : « TRIBUNAL D’EXCEPTION ! » {name} est jugé séance tenante, sans défense.',
  'mafia.trial.verdict': 'Verdict : {guilty} coupable, {innocent} innocent.',
  'mafia.trial.ballots': 'Ont voté coupable : {guilty}. Ont voté innocent : {innocent}. N’ont pas voté : {abstained}.',
  'mafia.trial.secret': 'Le tribunal d’exception a voté à bulletin secret : aucun nom ne sortira de cette salle.',
  'mafia.trial.spared': '{name} est épargné.',
  'mafia.trial.nobody': 'personne',
  'mafia.vote.skipped': 'La ville préfère ne pendre personne aujourd’hui. La nuit tombe.',

  'mafia.pause.begun': 'Le temps s’arrête : la table attend {names}.',
  'mafia.pause.resumed': 'Tout le monde est revenu. La partie reprend.',
  'mafia.kick.proposed': 'Un vote est ouvert pour continuer sans {name}.',
  'mafia.kick.carried': 'La table vote pour continuer sans {name}.',
  'mafia.kick.failed': 'La table laisse encore du temps à {name}.',

  /* -------------------------------- deaths -------------------------------- */
  'mafia.death.hanged': '{name} se balance au bout de la corde. {body}',
  'mafia.death.found': '{name} a été retrouvé mort — {cause}. {body}',
  'mafia.death.grief': '{name} s’est éteint de chagrin. {body}',
  'mafia.seat.left': '{name} a quitté la table. Personne ne l’a tué. {body}',
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

  'mafia.roster.diedAtNight': '{cause}, nuit {day}',
  'mafia.roster.diedOn': '{cause}, jour {day}',

  /* ---------------------- how somebody died, and by whose hand --------------- */
  'mafia.cause.lynched': 'pendu par la ville',
  'mafia.cause.grief': 'mort de chagrin',
  /** Le dernier rire du Bouffon : une des mains qui ont tiré la corde. */
  'mafia.cause.remorse': 'mort de remords',
  'mafia.cause.guard': 'mort en protégeant {name}',
  'mafia.cause.bodyguard': 'abattu par un garde du corps',
  'mafia.cause.killedBy': 'tué par {source}',
  'mafia.list.pair': '{a} et {b}',
  'mafia.list.more': '{a}, {b}',
  'mafia.cause.left': 'a quitté la table',
  'mafia.cause.unknown': 'sans explication',
  'mafia.source.poison': 'le poison',
  'mafia.source.arsonist': 'l’Incendiaire',
  'mafia.source.electromaniac': 'l’Électromane',
  'mafia.source.vigilante': 'le Justicier',
  'mafia.source.serialKiller': 'le Tueur en série',
  'mafia.source.massMurderer': 'le Tueur de masse',
  /* Meme texte que la cellule : voir la note cote anglais. La cave du Ravisseur
     et la cellule du Geolier sont le meme acte, et le carre ne doit pas pouvoir
     les distinguer d un coup d oeil au rapport du matin. */
  'mafia.source.jailor': 'celui qui tenait les clés',
  'mafia.source.kidnapper': 'celui qui tenait les clés',
  'mafia.source.veteran': 'le Vétéran',
  'mafia.source.lodge': 'la loge',
  'mafia.source.mafia': 'la Mafia',
  'mafia.source.triad': 'la Triade',
  'mafia.source.cult': 'la Secte',
  'mafia.source.remorse': 'sa propre conscience',

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
  'mafia.win.lastQuietDay':
    'Personne n’est mort depuis des jours. Trouvez quelqu’un aujourd’hui, ou la ville perd la main.',
  'mafia.win.witch': 'Chaque main à cette table était tenue par quelqu’un d’autre. La Sorcière l’emporte.',
  'mafia.win.draw': 'La ville, épuisée, déclare un match nul.',
  'mafia.win.hollow':
    'Les tueurs ont emporté la ville avec eux. Il ne reste personne à sauver, et personne pour la sauver.',
  'mafia.end.unmasked': 'Les masques tombent :',
  'mafia.end.unmaskedRow': '{slot}. {name} — {role}'
};

export default fr;
