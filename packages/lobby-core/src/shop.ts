import { LOBBY_GAMES, type LobbyGame } from './state.js';

/**
 * The catalogue, and the currency each game pays in.
 *
 * Three games had already grown a wallet apiece and spent it on nothing: CoronaZ
 * banks rations, Mafia banks points, and both were accumulating against a store
 * that did not exist. This is that store's contents — declared once, read by the
 * shop screen for its prices and by the server for the price it actually charges,
 * so a client that edits the number in the payload buys nothing.
 *
 * Only skins for now. Loadouts are named in the slot model because the model
 * costs nothing to get right early and a great deal to retrofit, but nothing here
 * grants an ability, and nothing here can be bought that changes a game.
 */

export type ShopKind = 'skin';

export interface ShopItem {
  /** Globally unique across games, so an id alone identifies a purchase. */
  id: string;
  game: LobbyGame;
  kind: ShopKind;
  name: string;
  description: string;
  /** In that game's own currency. Charged server-side; the client only displays it. */
  price: number;
  /**
   * The locker slot this fills. One item worn per slot.
   *
   * Every skin sits in `avatar` today, which is the whole wardrobe there is. The
   * field exists so the day a hat and a weapon finish are two different things,
   * they are two slots rather than a rewrite.
   */
  slot: string;
  emoji: string;
}

export interface Currency {
  /** Plural, lowercase: it is read inside a sentence. */
  name: string;
  emoji: string;
  /** How it is earned, for the shop's one line of explanation. */
  earnedBy: string;
}

export const CURRENCIES: Record<LobbyGame, Currency> = {
  quiz: {
    name: 'jetons',
    emoji: '🎟️',
    earnedBy: 'Un jeton par point marqué, à la fin de chaque partie.'
  },
  coronaz: {
    name: 'rations',
    emoji: '🥫',
    earnedBy: 'Ramassées à chaque raid, davantage si vous en revenez.'
  },
  mafia: {
    name: 'points',
    emoji: '🎭',
    earnedBy: 'Marqués en jouant votre rôle, gagnés ou perdus.'
  }
};

const ITEMS: ShopItem[] = [
  /* --------------------------------------------------------------- quiz */
  {
    id: 'quiz-vinyle',
    game: 'quiz',
    kind: 'skin',
    name: 'Vinyle',
    description: 'Un 33 tours rayé en guise de portrait. Le classique.',
    price: 300,
    slot: 'avatar',
    emoji: '💿'
  },
  {
    id: 'quiz-neon',
    game: 'quiz',
    kind: 'skin',
    name: 'Néon',
    description: 'Votre nom au tube fluo, sur le tableau des scores.',
    price: 700,
    slot: 'avatar',
    emoji: '🌈'
  },
  {
    id: 'quiz-couronne',
    game: 'quiz',
    kind: 'skin',
    name: 'Couronne',
    description: 'Pour qui a déjà gagné assez souvent pour se le permettre.',
    price: 1200,
    slot: 'avatar',
    emoji: '👑'
  },

  /* ------------------------------------------------------------ coronaz */
  {
    id: 'cz-pompier',
    game: 'coronaz',
    kind: 'skin',
    name: 'Tenue de pompier',
    description: 'Ignifugée, réfléchissante, et strictement décorative.',
    price: 150,
    slot: 'avatar',
    emoji: '🧯'
  },
  {
    id: 'cz-hazmat',
    game: 'coronaz',
    kind: 'skin',
    name: 'Combinaison NRBC',
    description: 'Étanche à tout sauf aux morsures.',
    price: 300,
    slot: 'avatar',
    emoji: '☣️'
  },
  {
    id: 'cz-milice',
    game: 'coronaz',
    kind: 'skin',
    name: 'Milice',
    description: 'Treillis dépareillé, brassard peint à la main.',
    price: 450,
    slot: 'avatar',
    emoji: '🎖️'
  },

  /* -------------------------------------------------------------- mafia */
  {
    id: 'mafia-fedora',
    game: 'mafia',
    kind: 'skin',
    name: 'Feutre et cravate',
    description: 'On ne prouve rien avec un chapeau.',
    price: 200,
    slot: 'avatar',
    emoji: '🎩'
  },
  {
    id: 'mafia-loup',
    game: 'mafia',
    kind: 'skin',
    name: 'Masque de loup',
    description: 'Porté par la ville comme par la meute. C’est l’idée.',
    price: 500,
    slot: 'avatar',
    emoji: '🐺'
  },
  {
    id: 'mafia-veuve',
    game: 'mafia',
    kind: 'skin',
    name: 'Voile de deuil',
    description: 'Pour qui compte les morts avant tout le monde.',
    price: 800,
    slot: 'avatar',
    emoji: '🕯️'
  }
];

export const SHOP: readonly ShopItem[] = ITEMS;

export function shopFor(game: LobbyGame): ShopItem[] {
  return ITEMS.filter((item) => item.game === game);
}

export function shopItem(id: string): ShopItem | undefined {
  return ITEMS.find((item) => item.id === id);
}

/** The slots a game's locker has, in display order. */
export function shopSlots(game: LobbyGame): string[] {
  return [...new Set(shopFor(game).map((item) => item.slot))];
}

/** What one account owns and wears in one game, as both sides of the wire see it. */
export interface LockerView {
  game: LobbyGame;
  /** Spendable balance in that game's currency. */
  balance: number;
  /** Ids of everything owned. */
  owned: string[];
  /** Slot → the item id worn there, for slots that have one. */
  worn: Record<string, string>;
}

export function emptyLocker(game: LobbyGame): LockerView {
  return { game, balance: 0, owned: [], worn: {} };
}

export function isLockerGame(value: string): value is LobbyGame {
  return (LOBBY_GAMES as readonly string[]).includes(value);
}
