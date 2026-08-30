import { gameEntry } from '../../app/games';
import GameMenu, { type MenuTile } from './GameMenu';

/**
 * The quizzes had the most doors and the fewest signs.
 *
 * Making a question, grouping questions into a quiz, opening a room and joining
 * one were four different pages reached from three different places, one of them
 * called "Playlists" for historical reasons. They are the same four things here,
 * named after what they do.
 */
const TILES: MenuTile[] = [
  {
    to: '/partie-rapide/quiz',
    label: 'site.tile.quick',
    hint: 'site.tile.quick.quiz',
    emoji: '⚡',
    primary: true
  },
  {
    to: '/quiz/creer',
    label: 'site.tile.createRoom',
    hint: 'site.tile.createRoom.hint',
    emoji: '🎬',
    requiresAccount: true
  },
  {
    to: '/rejoindre?jeu=quiz',
    label: 'site.tile.joinRoom',
    hint: 'site.tile.joinRoom.hint',
    emoji: '🔑'
  },
  {
    to: '/bibliotheque/nouveau',
    label: 'site.tile.newQuestion',
    hint: 'site.tile.newQuestion.hint',
    emoji: '✍️',
    requiresAccount: true
  },
  {
    to: '/playlists',
    label: 'site.tile.newQuiz',
    hint: 'site.tile.newQuiz.hint',
    emoji: '📚',
    requiresAccount: true
  },
  {
    to: '/bibliotheque',
    label: 'site.tile.library',
    hint: 'site.tile.library.hint',
    emoji: '🗂️',
    requiresAccount: true
  },
  {
    to: '/historique',
    label: 'site.tile.history',
    hint: 'site.tile.history.quiz',
    emoji: '🏆',
    requiresAccount: true
  },
  {
    to: '/quiz/boutique',
    label: 'site.tile.shop',
    hint: 'site.tile.shop.quiz',
    emoji: '🎟️',
    requiresAccount: true
  },
  {
    to: '/quiz/equipement',
    label: 'site.tile.locker',
    hint: 'site.tile.locker.quiz',
    emoji: '🎽',
    requiresAccount: true
  },
  {
    to: '/quiz/regles',
    label: 'site.tile.guide.quiz',
    hint: 'site.tile.guide.quiz.hint',
    emoji: '📖'
  }
];

export default function QuizMenu() {
  return (
    <GameMenu
      game={gameEntry('quiz')}
      lede="site.menu.quiz.lede"
      tiles={TILES}
    />
  );
}
