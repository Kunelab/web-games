import type { Catalogue } from '../index.js';

/**
 * A quiz being played: the phone in a hand, the screen facing the room, and the
 * ceremony at the end.
 *
 * Numbers are a special case worth noting. `toLocaleString` used to be called
 * with a hard-coded `'fr-FR'`, so an English reader was shown `1 234,5` — the
 * screens pass the reader's own locale now, which is the one piece of
 * localisation the catalogue cannot do for them.
 */
export const playEn: Catalogue = {
  /* -------------------------------- the phone ------------------------------- */
  'play.connecting': 'Connecting…',
  'play.waitingForGame': 'Waiting for the game…',
  'play.game': 'Game {code}',
  'play.yourNickname': 'Your nickname',
  'play.join': 'Join',
  'play.joinFailed': 'Could not join.',
  'play.serverQuiet': 'The server is not answering.',
  'play.defaultName': 'Player',
  'play.waitingForStart': 'Waiting for the start.',
  'play.playerCount': '{count} player(s)',
  'play.finished': 'Finished',

  'play.answer': 'Answer',
  'play.pointsThisRound': '+{points} pts this round',
  'play.combo': 'combo ×{factor}',
  'play.comeback': 'catch-up ×{factor}',
  'play.streak': '{count} rounds won in a row',
  'play.memorise': 'Memorise',
  'play.allPlayed': 'Everything is played. Waiting for the next round.',
  'play.found': 'Got it',
  'play.notFound': 'No',
  'play.notFoundLeft': 'No, {count} tries left',
  'play.gotIt': 'got it',
  'play.noTriesLeft': 'No tries left',
  'play.noTriesThisRound': 'No tries left this round.',
  'play.yourAnswer': 'Your answer',
  'play.send': 'Send',
  'play.seeChoices': 'See the choices (fewer points)',
  'play.blindBonus': ' (+{bonus} blind)',
  'play.points': '{points} pts',

  'play.answerInAnyOrder': 'Answer in any order you like',
  'play.recallWhatYouSaw': 'List what you remember',
  'play.oneItemThenEnter': 'One item, then Enter',
  'play.confirm': 'Confirm',
  'play.allFound': 'All found.',

  'play.yourEstimate': 'Your estimate',
  'play.fixEstimate': 'Change your estimate',
  'play.fix': 'Change',
  'play.estimateRefused': 'That number could not be sent.',
  'play.estimateCommitted': 'Your estimate: ',
  'play.estimateEditable': ' · you can change it until the clock runs out',
  'play.exact': 'spot on!',

  /* ------------------------- the screen facing the room --------------------- */
  'host.noToken': 'This screen does not know this game’s token. Launch the playlist again to open a new one.',
  'host.myPlaylists': 'My playlists',
  'host.openFailed': 'Could not open this game.',
  'host.connectingToGame': 'Connecting to the game…',
  'host.end': 'End',
  'host.oral': 'Out loud',
  'host.oralPrompt': 'Nobody needs a phone.',
  'host.oralNote': 'Answers are said out loud. You decide when to show them and when to move on.',
  'host.start': 'Start',
  'host.joinWithCode': 'Join with this code',
  'host.remove': 'Remove {name}',
  'host.answersToFind': '{count} answers to find',
  'host.memorising': 'Memorising',
  'host.yourTurn': 'Over to you. Show the answer once the room has said theirs.',
  'host.closeAnswers': 'Close the answers',
  'host.showAnswer': 'Show the answer',
  'host.next': 'Next',
  'host.skip': 'Skip',
  'host.playlistDone': 'Playlist finished.',
  'host.backToPlaylists': 'Back to the playlists',
  'host.finalStandings': 'Final standings',

  /* ------------------------ what a good evening earns you ------------------- */
  'award.fastest': 'The lightning',
  'award.workhorse': 'The workhorse',
  'award.sniper': 'The sniper',
  'award.scattergun': 'The scattergun',
  'award.streak': 'The streak',
  'award.butcher': 'The butcher',
  'award.locksmith': 'The locksmith',
  'award.looter': 'The looter',
  'award.untouchable': 'The untouchable',
  'award.magnet': 'The bite magnet',

  'badge.first-game': 'Novice',
  'badge.first-game.hint': 'Played their first game',
  'badge.regular': 'Regular',
  'badge.regular.hint': '10 games played',
  'badge.pillar': 'Sofa fixture',
  'badge.pillar.hint': '50 games played',
  'badge.first-win': 'Winner',
  'badge.first-win.hint': 'First win',
  'badge.lightning': 'Fierce reflexes',
  'badge.lightning.hint': 'A right answer in under 1.5 s',
  'badge.streak-3': 'On a roll',
  'badge.streak-3.hint': '3 rounds won in a row',
  'badge.hundred-right': 'Centurion',
  'badge.hundred-right.hint': '100 right answers',
  'badge.decorated': 'Decorated',
  'badge.decorated.hint': '10 end-of-game honours',
  'badge.five-wins': 'King of the room',
  'badge.five-wins.hint': '5 wins',
  'badge.encyclopedia': 'Encyclopedia',
  'badge.encyclopedia.hint': '500 right answers',
  'badge.living-room-king': 'Legend',
  'badge.living-room-king.hint': '20 wins'
};

export default playEn;
