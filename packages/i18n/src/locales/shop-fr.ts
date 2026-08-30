import type { Catalogue } from '../index.js';

/**
 * Les trois porte-monnaie et les neuf choses qu’ils achètent, en français.
 * Rien ici ne change une partie : le catalogue est fait d’apparences, exprès.
 */
export const shopFr: Catalogue = {
  /* ------------------------------ les monnaies ------------------------------ */
  'shop.currency.quiz': 'jetons',
  'shop.currency.quiz.earned': 'Un jeton par point marqué, à la fin de chaque partie.',
  'shop.currency.coronaz': 'rations',
  'shop.currency.coronaz.earned': 'Ramassées à chaque raid, davantage si vous en revenez.',
  'shop.currency.mafia': 'points',
  'shop.currency.mafia.earned': 'Marqués en jouant votre rôle, gagnés ou perdus.',

  /* ------------------------------ la marchandise ---------------------------- */
  'shop.item.quiz-vinyle': 'Vinyle',
  'shop.item.quiz-vinyle.desc': 'Un 33 tours rayé en guise de portrait. Le classique.',
  'shop.item.quiz-neon': 'Néon',
  'shop.item.quiz-neon.desc': 'Votre nom au tube fluo, sur le tableau des scores.',
  'shop.item.quiz-couronne': 'Couronne',
  'shop.item.quiz-couronne.desc': 'Pour qui a déjà gagné assez souvent pour se le permettre.',

  'shop.item.cz-pompier': 'Tenue de pompier',
  'shop.item.cz-pompier.desc': 'Ignifugée, réfléchissante, et strictement décorative.',
  'shop.item.cz-hazmat': 'Combinaison NRBC',
  'shop.item.cz-hazmat.desc': 'Étanche à tout sauf aux morsures.',
  'shop.item.cz-milice': 'Milice',
  'shop.item.cz-milice.desc': 'Treillis dépareillé, brassard peint à la main.',

  'shop.item.mafia-fedora': 'Feutre et cravate',
  'shop.item.mafia-fedora.desc': 'On ne prouve rien avec un chapeau.',
  'shop.item.mafia-loup': 'Masque de loup',
  'shop.item.mafia-loup.desc': 'Porté par la ville comme par la meute. C’est l’idée.',
  'shop.item.mafia-veuve': 'Voile de deuil',
  'shop.item.mafia-veuve.desc': 'Pour qui compte les morts avant tout le monde.',

  /* --------------------------- la boutique et l’armoire --------------------- */
  'shop.title': 'Boutique',
  'locker.title': 'Équipement',
  'shop.headline':
    '{earned} Rien de ce qui est vendu ici ne change une partie : ce sont des apparences, et c’est délibéré.',
  'locker.headline':
    'Ce que vous portez, un article par emplacement. Retirez-le pour revenir à l’apparence par défaut.',
  'shop.empty': 'La boutique de ce jeu est vide pour l’instant.',
  'locker.empty': 'Vous ne possédez encore rien ici.',
  'shop.backToMenu': 'Retour au menu',
  'locker.seeShop': 'Voir la boutique',
  'shop.alreadyYours': 'Déjà à vous',
  'shop.buy': 'Acheter — {price} {emoji}',
  'locker.wear': 'Porter',
  'locker.takeOff': 'Retirer',
  'locker.worn': '— porté',
  'locker.slot.avatar': 'Apparence',
  'shop.failed': 'L’opération a échoué.',
  'shop.back': '← Retour au menu {game}'
};

export default shopFr;
