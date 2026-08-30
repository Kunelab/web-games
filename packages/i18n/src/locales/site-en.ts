import type { Catalogue } from '../index.js';

/**
 * The site around the games, in English: the front page, the bar, the three game
 * menus and the account screens.
 *
 * This is the shell every visitor meets before they meet a game, which is why it
 * matters more than its word count suggests — a French-only front page tells an
 * English reader they are in the wrong place, whatever the games behind it do.
 *
 * A game's *name* is deliberately not in here. "Mafia", "CoronaZ" and "Quiz" are
 * proper nouns: the same word in every catalogue, so they stay in `games.ts`
 * where the accent colour and the emoji already live.
 */
export const siteEn: Catalogue = {
  /* -------------------------------- the bar --------------------------------- */
  'site.nav.main': 'Main navigation',
  'nav.backHome': '← Home',
  'site.nav.games': 'Games',
  'site.nav.signIn': 'Sign in',
  'site.nav.join': 'Join a game',
  'site.nav.joinHint': 'A code, or the list of open rooms.',

  'site.account.theme': 'Theme',
  'site.account.theme.dark': 'Dark',
  'site.account.theme.light': 'Light',
  'site.account.theme.system': 'System',
  'site.account.language': 'Language',
  'site.account.settings': '⚙️ Settings',
  'site.account.signOut': '🚪 Sign out',

  /* ------------------------------ the front page ---------------------------- */
  'site.home.title': 'Three games, one room, everybody’s phone.',
  'site.home.lede':
    'A quiz to guess your way through, a neighbourhood to evacuate, a town hunting its killers. Everyone on their own phone, the game on the TV when there is one.',
  'site.home.join': 'Join a game',
  'site.home.library': 'Library',
  'site.home.signIn': 'Sign in',
  'site.home.open': 'Open the menu →',

  /* ------------------------------- what a game is --------------------------- */
  'site.game.quiz.tagline': 'Blind test, questions, estimates, panels — for guessing at, among friends.',
  'site.game.coronaz.tagline': 'Co-operative survival against the horde, board-game style.',
  'site.game.mafia.tagline': 'One town, some wolves, and nobody telling the truth.',

  /* ------------------------------- a game's menu ---------------------------- */
  'site.menu.aria': '{game} menu',
  'site.menu.needsAccount': 'An account is needed — sign in',
  'site.menu.back': '← Back to the main menu',

  'site.menu.quiz.lede':
    'A clip, a picture, a question — on the TV or on your phone. The score rewards whoever answers first, not whoever has the best connection.',
  'site.menu.coronaz.lede':
    'Co-operative survival, board-game style: the map on the TV, your survivor in your hand. Three to five players, an hour, and rarely everybody at the exit.',
  'site.menu.mafia.lede':
    'One town, wolves hidden inside it, and nobody telling the whole truth. Five to fifteen players, each on their own phone, a TV optional.',

  /* -------------------------------- the tiles ------------------------------- */
  'site.tile.quick': 'Quick match',
  'site.tile.quick.quiz': 'A quiz drawn at random, strangers, no organiser.',
  'site.tile.quick.coronaz': 'A neighbourhood drawn at random, a team formed on the spot.',
  'site.tile.quick.mafia': 'A table that fills itself, topped up with bots as needed.',

  'site.tile.createRoom': 'Open a room',
  'site.tile.createRoom.hint': 'Pick a quiz — yours or a public one — and open the game.',
  'site.tile.createRaid': 'Start a raid',
  'site.tile.createRaid.hint': 'Scenario, map, difficulty, and the horde run by the machine or by you.',
  'site.tile.createTable': 'Open a table',
  'site.tile.createTable.hint': 'How the roles are dealt, how long a day lasts, what a body gives away.',

  'site.tile.joinRoom': 'Join a room',
  'site.tile.joinRoom.hint': 'A code, or the list of open public rooms.',
  'site.tile.joinRaid': 'Join a raid',
  'site.tile.joinRaid.hint': 'A code, or the list of open public raids.',
  'site.tile.joinTable': 'Join a table',
  'site.tile.joinTable.hint': 'A code, or the list of open public tables.',

  'site.tile.newQuestion': 'Write a question',
  'site.tile.newQuestion.hint': 'Blind test, question, estimate, picture to reveal, panel to memorise.',
  'site.tile.newQuiz': 'Build a quiz',
  'site.tile.newQuiz.hint': 'A group of questions, playable in one evening. Publishable.',
  'site.tile.library': 'My library',
  'site.tile.library.hint': 'Find and edit the questions you have already written.',

  'site.tile.history': 'History and careers',
  'site.tile.history.quiz': 'Finished games and what they left behind, across every game.',
  'site.tile.history.coronaz': 'Finished raids, the per-scenario records and the trophies.',
  'site.tile.history.mafia': 'Finished games, and what everybody turned out to be.',

  'site.tile.shop': 'Shop',
  'site.tile.shop.quiz': 'Spend your tokens on skins.',
  'site.tile.shop.coronaz': 'Spend your rations on outfits.',
  'site.tile.shop.mafia': 'Spend your points on masks and costumes.',

  'site.tile.locker': 'Wardrobe',
  'site.tile.locker.quiz': 'Choose what you wear on the scoreboard.',
  'site.tile.locker.coronaz': 'Choose the outfit your survivor wears.',
  'site.tile.locker.mafia': 'Choose what the town sees of you.',

  'site.tile.guide.quiz': 'Rules and question types',
  'site.tile.guide.quiz.hint': 'How the score is worked out, and what each type asks of you.',
  'site.tile.guide.coronaz': 'Lore, bestiary and rules',
  'site.tile.guide.coronaz.hint': 'What happened to the neighbourhood, what lives there, and how anyone gets out.',
  'site.tile.guide.mafia': 'Roles and rules',
  'site.tile.guide.mafia.hint': 'The camps, the roles, how a day and a night play out.',

  /* ------------------------------- nowhere at all --------------------------- */
  'site.notFound.title': 'Page not found',
  'site.notFound.lede': 'This link leads nowhere. The menu at the top gets you back to familiar ground.'
};

export default siteEn;
