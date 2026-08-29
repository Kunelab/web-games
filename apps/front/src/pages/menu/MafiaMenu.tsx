import { gameEntry } from '../../app/games';
import GameMenu, { type MenuTile } from './GameMenu';

const TILES: MenuTile[] = [
  {
    to: '/partie-rapide/mafia',
    label: 'Partie rapide',
    hint: 'Une table qui se remplit toute seule, complétée par des bots au besoin.',
    emoji: '⚡',
    primary: true
  },
  {
    to: '/mafia/nouveau',
    label: 'Ouvrir une table',
    hint: 'Distribution des rôles, durée du jour, ce qu’un cadavre révèle.',
    emoji: '🎭',
    requiresAccount: true
  },
  {
    to: '/rejoindre?jeu=mafia',
    label: 'Rejoindre une table',
    hint: 'Un code, ou la liste des tables publiques ouvertes.',
    emoji: '🔑'
  },
  {
    to: '/mafia/boutique',
    label: 'Boutique',
    hint: 'Dépenser vos points en masques et costumes.',
    emoji: '🎩',
    requiresAccount: true
  },
  {
    to: '/mafia/equipement',
    label: 'Équipement',
    hint: 'Choisir ce que la ville voit de vous.',
    emoji: '🎽',
    requiresAccount: true
  },
  {
    to: '/historique',
    label: 'Historique et carrières',
    hint: 'Les parties terminées, et ce que chacun a fini par devenir.',
    emoji: '🏆',
    requiresAccount: true
  },
  {
    to: '/mafia/guide',
    label: 'Rôles et règles',
    hint: 'Les camps, les rôles, le déroulé d’un jour et d’une nuit.',
    emoji: '📖'
  }
];

export default function MafiaMenu() {
  return (
    <GameMenu
      game={gameEntry('mafia')}
      lede="Une ville, des loups cachés parmi elle, et personne qui dit toute la vérité. Cinq à quinze joueurs, chacun sur son téléphone, une télé en option."
      tiles={TILES}
    />
  );
}
