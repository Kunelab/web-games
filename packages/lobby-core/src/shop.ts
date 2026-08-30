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
  /**
   * Globally unique across games, so an id alone identifies a purchase — and,
   * since the catalogue keys are derived from it, so is the item's name.
   */
  id: string;
  game: LobbyGame;
  kind: ShopKind;
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

/**
 * A game's wallet: an emoji, and the keys that name it and say how it fills.
 *
 * Keys rather than words for the same reason the quick lobby's options are:
 * this package is imported by a browser that renders three games' shops and
 * knows none of their engines, so the phone resolves the words.
 */
export interface Currency {
  /** Catalogue key. Plural, lowercase: it is read inside a sentence. */
  name: string;
  emoji: string;
  /** Catalogue key: how it is earned, for the shop's one line of explanation. */
  earnedBy: string;
}

export const CURRENCIES: Record<LobbyGame, Currency> = {
  quiz: { name: 'shop.currency.quiz', emoji: '🎟️', earnedBy: 'shop.currency.quiz.earned' },
  coronaz: { name: 'shop.currency.coronaz', emoji: '🥫', earnedBy: 'shop.currency.coronaz.earned' },
  mafia: { name: 'shop.currency.mafia', emoji: '🎭', earnedBy: 'shop.currency.mafia.earned' }
};

const ITEMS: ShopItem[] = [
  /* --------------------------------------------------------------- quiz */
  {
    id: 'quiz-vinyle',
    game: 'quiz',
    kind: 'skin',
    price: 300,
    slot: 'avatar',
    emoji: '💿'
  },
  {
    id: 'quiz-neon',
    game: 'quiz',
    kind: 'skin',
    price: 700,
    slot: 'avatar',
    emoji: '🌈'
  },
  {
    id: 'quiz-couronne',
    game: 'quiz',
    kind: 'skin',
    price: 1200,
    slot: 'avatar',
    emoji: '👑'
  },

  /* ------------------------------------------------------------ coronaz */
  {
    id: 'cz-pompier',
    game: 'coronaz',
    kind: 'skin',
    price: 150,
    slot: 'avatar',
    emoji: '🧯'
  },
  {
    id: 'cz-hazmat',
    game: 'coronaz',
    kind: 'skin',
    price: 300,
    slot: 'avatar',
    emoji: '☣️'
  },
  {
    id: 'cz-milice',
    game: 'coronaz',
    kind: 'skin',
    price: 450,
    slot: 'avatar',
    emoji: '🎖️'
  },

  /* -------------------------------------------------------------- mafia */
  {
    id: 'mafia-fedora',
    game: 'mafia',
    kind: 'skin',
    price: 200,
    slot: 'avatar',
    emoji: '🎩'
  },
  {
    id: 'mafia-loup',
    game: 'mafia',
    kind: 'skin',
    price: 500,
    slot: 'avatar',
    emoji: '🐺'
  },
  {
    id: 'mafia-veuve',
    game: 'mafia',
    kind: 'skin',
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
