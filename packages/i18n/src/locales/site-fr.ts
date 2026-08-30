import type { Catalogue } from '../index.js';

/**
 * Le site autour des jeux, en français : la page d’accueil, la barre, les trois
 * menus de jeu et les écrans de compte. Les originaux.
 *
 * Le *nom* d’un jeu n’est volontairement pas ici : « Mafia », « CoronaZ » et
 * « Quiz » sont des noms propres, identiques dans tous les catalogues, et
 * restent donc dans `games.ts` avec la couleur et l’emoji.
 */
export const siteFr: Catalogue = {
  /* -------------------------------- la barre -------------------------------- */
  'site.nav.main': 'Navigation principale',
  'site.nav.games': 'Jeux',
  'site.nav.signIn': 'Connexion',
  'site.nav.join': 'Rejoindre une partie',
  'site.nav.joinHint': 'Un code, ou la liste des salons ouverts.',

  'site.account.theme': 'Thème',
  'site.account.theme.dark': 'Sombre',
  'site.account.theme.light': 'Clair',
  'site.account.theme.system': 'Système',
  'site.account.language': 'Langue',
  'site.account.settings': '⚙️ Réglages',
  'site.account.signOut': '🚪 Déconnexion',

  /* ------------------------------- l’accueil -------------------------------- */
  'site.home.title': 'Trois jeux, un salon, des téléphones.',
  'site.home.lede':
    'Un quiz à faire deviner, un quartier à évacuer, une ville qui cherche ses tueurs. Chacun sur son téléphone, la partie sur la télé quand il y en a une.',
  'site.home.join': 'Rejoindre une partie',
  'site.home.library': 'Bibliothèque',
  'site.home.signIn': 'Se connecter',
  'site.home.open': 'Ouvrir le menu →',

  /* ------------------------------ ce qu’est un jeu -------------------------- */
  'site.game.quiz.tagline': 'Blind test, questions, estimations, panels — à faire deviner entre amis.',
  'site.game.coronaz.tagline': 'Survie coopérative contre la horde, façon jeu de plateau.',
  'site.game.mafia.tagline': 'Une ville, des loups, et personne qui dit la vérité.',

  /* ------------------------------ le menu d’un jeu -------------------------- */
  'site.menu.aria': 'Menu {game}',
  'site.menu.needsAccount': 'Il faut un compte — se connecter',
  'site.menu.back': '← Retour au menu principal',

  'site.menu.quiz.lede':
    'Un extrait, une image, une question — sur la télé ou sur votre téléphone. Le score récompense celui qui répond le premier, pas celui qui a la meilleure connexion.',
  'site.menu.coronaz.lede':
    'Survie coopérative façon jeu de plateau : la carte sur la télé, votre survivant en main. Trois à cinq joueurs, une heure, et rarement tout le monde à la sortie.',
  'site.menu.mafia.lede':
    'Une ville, des loups cachés parmi elle, et personne qui dit toute la vérité. Cinq à quinze joueurs, chacun sur son téléphone, une télé en option.',

  /* -------------------------------- les tuiles ------------------------------ */
  'site.tile.quick': 'Partie rapide',
  'site.tile.quick.quiz': 'Un quiz tiré au sort, des inconnus, aucun organisateur.',
  'site.tile.quick.coronaz': 'Un quartier tiré au sort, une équipe formée sur place.',
  'site.tile.quick.mafia': 'Une table qui se remplit toute seule, complétée par des bots au besoin.',

  'site.tile.createRoom': 'Créer un salon',
  'site.tile.createRoom.hint': 'Choisissez un quiz — le vôtre ou un quiz public — et ouvrez la partie.',
  'site.tile.createRaid': 'Créer un raid',
  'site.tile.createRaid.hint': 'Scénario, carte, difficulté, et la horde tenue par la machine ou par vous.',
  'site.tile.createTable': 'Ouvrir une table',
  'site.tile.createTable.hint': 'Distribution des rôles, durée du jour, ce qu’un cadavre révèle.',

  'site.tile.joinRoom': 'Rejoindre un salon',
  'site.tile.joinRoom.hint': 'Un code, ou la liste des salons publics ouverts.',
  'site.tile.joinRaid': 'Rejoindre un raid',
  'site.tile.joinRaid.hint': 'Un code, ou la liste des raids publics ouverts.',
  'site.tile.joinTable': 'Rejoindre une table',
  'site.tile.joinTable.hint': 'Un code, ou la liste des tables publiques ouvertes.',

  'site.tile.newQuestion': 'Créer une question',
  'site.tile.newQuestion.hint': 'Blind test, question, estimation, image à révéler, panel à mémoriser.',
  'site.tile.newQuiz': 'Créer un quiz',
  'site.tile.newQuiz.hint': 'Un groupe de questions, jouable en une soirée. Publiable.',
  'site.tile.library': 'Ma bibliothèque',
  'site.tile.library.hint': 'Retrouver et modifier les questions déjà écrites.',

  'site.tile.history': 'Historique et carrières',
  'site.tile.history.quiz': 'Les parties terminées et ce qu’elles ont laissé, tous jeux confondus.',
  'site.tile.history.coronaz': 'Les raids terminés, les records par scénario et les trophées.',
  'site.tile.history.mafia': 'Les parties terminées, et ce que chacun a fini par devenir.',

  'site.tile.shop': 'Boutique',
  'site.tile.shop.quiz': 'Dépenser vos jetons en skins.',
  'site.tile.shop.coronaz': 'Dépenser vos rations en tenues.',
  'site.tile.shop.mafia': 'Dépenser vos points en masques et costumes.',

  'site.tile.locker': 'Équipement',
  'site.tile.locker.quiz': 'Choisir ce que vous portez sur le tableau des scores.',
  'site.tile.locker.coronaz': 'Choisir la tenue que porte votre survivant.',
  'site.tile.locker.mafia': 'Choisir ce que la ville voit de vous.',

  'site.tile.guide.quiz': 'Règles et types de questions',
  'site.tile.guide.quiz.hint': 'Comment se calcule le score, et ce que chaque type demande.',
  'site.tile.guide.coronaz': 'Lore, bestiaire et règles',
  'site.tile.guide.coronaz.hint': 'Ce qui est arrivé au quartier, ce qui y vit, et comment on en sort.',
  'site.tile.guide.mafia': 'Rôles et règles',
  'site.tile.guide.mafia.hint': 'Les camps, les rôles, le déroulé d’un jour et d’une nuit.',

  /* --------------------------------- nulle part ----------------------------- */
  'site.notFound.title': 'Page introuvable',
  'site.notFound.lede': 'Ce lien ne mène à rien. Le menu en haut ramène en terrain connu.'
};

export default siteFr;
