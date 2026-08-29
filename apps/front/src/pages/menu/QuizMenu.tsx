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
    label: 'Partie rapide',
    hint: 'Un quiz tiré au sort, des inconnus, aucun organisateur.',
    emoji: '⚡',
    primary: true
  },
  {
    to: '/quiz/creer',
    label: 'Créer un salon',
    hint: 'Choisissez un quiz — le vôtre ou un quiz public — et ouvrez la partie.',
    emoji: '🎬',
    requiresAccount: true
  },
  {
    to: '/rejoindre?jeu=quiz',
    label: 'Rejoindre un salon',
    hint: 'Un code, ou la liste des salons publics ouverts.',
    emoji: '🔑'
  },
  {
    to: '/bibliotheque/nouveau',
    label: 'Créer une question',
    hint: 'Blind test, question, estimation, image à révéler, panel à mémoriser.',
    emoji: '✍️',
    requiresAccount: true
  },
  {
    to: '/playlists',
    label: 'Créer un quiz',
    hint: 'Un groupe de questions, jouable en une soirée. Publiable.',
    emoji: '📚',
    requiresAccount: true
  },
  {
    to: '/bibliotheque',
    label: 'Ma bibliothèque',
    hint: 'Retrouver et modifier les questions déjà écrites.',
    emoji: '🗂️',
    requiresAccount: true
  },
  {
    to: '/historique',
    label: 'Historique et carrières',
    hint: 'Les parties terminées et ce qu’elles ont laissé, tous jeux confondus.',
    emoji: '🏆',
    requiresAccount: true
  },
  {
    to: '/quiz/boutique',
    label: 'Boutique',
    hint: 'Dépenser vos jetons en skins.',
    emoji: '🎟️',
    requiresAccount: true
  },
  {
    to: '/quiz/equipement',
    label: 'Équipement',
    hint: 'Choisir ce que vous portez sur le tableau des scores.',
    emoji: '🎽',
    requiresAccount: true
  },
  {
    to: '/quiz/regles',
    label: 'Règles et types de questions',
    hint: 'Comment se calcule le score, et ce que chaque type demande.',
    emoji: '📖'
  }
];

export default function QuizMenu() {
  return (
    <GameMenu
      game={gameEntry('quiz')}
      lede="Un extrait, une image, une question — sur la télé ou sur votre téléphone. Le score récompense celui qui répond le premier, pas celui qui a la meilleure connexion."
      tiles={TILES}
    />
  );
}
