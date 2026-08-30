import type { Catalogue } from '../index.js';

/**
 * The three wallets and the nine things they buy, in English.
 *
 * Nothing here changes a game — the catalogue is skins, deliberately — so these
 * strings are pure flavour, which is exactly the sort that reads worst left in a
 * language the reader does not have.
 */
export const shopEn: Catalogue = {
  /* -------------------------------- the wallets ----------------------------- */
  'shop.currency.quiz': 'tokens',
  'shop.currency.quiz.earned': 'One token per point scored, at the end of every game.',
  'shop.currency.coronaz': 'rations',
  'shop.currency.coronaz.earned': 'Picked up on every raid, more of them if you come back.',
  'shop.currency.mafia': 'points',
  'shop.currency.mafia.earned': 'Scored by playing your role, won or lost.',

  /* --------------------------------- the goods ------------------------------ */
  'shop.item.quiz-vinyle': 'Vinyl',
  'shop.item.quiz-vinyle.desc': 'A scratched LP for a portrait. The classic.',
  'shop.item.quiz-neon': 'Neon',
  'shop.item.quiz-neon.desc': 'Your name in strip lighting, on the scoreboard.',
  'shop.item.quiz-couronne': 'Crown',
  'shop.item.quiz-couronne.desc': 'For anyone who has won often enough to get away with it.',

  'shop.item.cz-pompier': 'Fire kit',
  'shop.item.cz-pompier.desc': 'Fireproof, reflective, and strictly decorative.',
  'shop.item.cz-hazmat': 'Hazmat suit',
  'shop.item.cz-hazmat.desc': 'Sealed against everything but teeth.',
  'shop.item.cz-milice': 'Militia',
  'shop.item.cz-milice.desc': 'Mismatched fatigues, a hand-painted armband.',

  'shop.item.mafia-fedora': 'Fedora and tie',
  'shop.item.mafia-fedora.desc': 'A hat proves nothing.',
  'shop.item.mafia-loup': 'Wolf mask',
  'shop.item.mafia-loup.desc': 'Worn by the town as much as by the pack. That is the idea.',
  'shop.item.mafia-veuve': 'Mourning veil',
  'shop.item.mafia-veuve.desc': 'For whoever counts the dead before anybody else.',

  /* --------------------------- the shop and the wardrobe -------------------- */
  'shop.title': 'Shop',
  'locker.title': 'Wardrobe',
  'shop.headline': '{earned} Nothing sold here changes a game: these are appearances, and that is deliberate.',
  'locker.headline': 'What you wear, one item per slot. Take it off to go back to the default look.',
  'shop.empty': 'This game’s shop is empty for now.',
  'locker.empty': 'You own nothing here yet.',
  'shop.backToMenu': 'Back to the menu',
  'locker.seeShop': 'See the shop',
  'shop.alreadyYours': 'Already yours',
  'shop.buy': 'Buy — {price} {emoji}',
  'locker.wear': 'Wear',
  'locker.takeOff': 'Take off',
  'locker.worn': '— worn',
  'locker.slot.avatar': 'Look',
  'shop.failed': 'That did not work.',
  'shop.back': '← Back to the {game} menu'
};

export default shopEn;
