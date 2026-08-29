import { gameEntry } from '../../app/games';
import GameMenu, { type MenuTile } from './GameMenu';

const TILES: MenuTile[] = [
  {
    to: '/partie-rapide/coronaz',
    label: 'Partie rapide',
    hint: 'Un quartier tiré au sort, une équipe formée sur place.',
    emoji: '⚡',
    primary: true
  },
  {
    to: '/coronaz/nouveau',
    label: 'Créer un raid',
    hint: 'Scénario, carte, difficulté, et la horde tenue par la machine ou par vous.',
    emoji: '🗺️',
    requiresAccount: true
  },
  {
    to: '/rejoindre?jeu=coronaz',
    label: 'Rejoindre un raid',
    hint: 'Un code, ou la liste des raids publics ouverts.',
    emoji: '🔑'
  },
  {
    to: '/coronaz/boutique',
    label: 'Boutique',
    hint: 'Dépenser vos rations en tenues.',
    emoji: '🥫',
    requiresAccount: true
  },
  {
    to: '/coronaz/equipement',
    label: 'Équipement',
    hint: 'Choisir la tenue que porte votre survivant.',
    emoji: '🎽',
    requiresAccount: true
  },
  {
    to: '/historique',
    label: 'Historique et carrières',
    hint: 'Les raids terminés, les records par scénario et les trophées.',
    emoji: '🏆',
    requiresAccount: true
  },
  {
    to: '/coronaz/guide',
    label: 'Lore, bestiaire et règles',
    hint: 'Ce qui est arrivé au quartier, ce qui y vit, et comment on en sort.',
    emoji: '📖'
  }
];

export default function CzMenu() {
  return (
    <GameMenu
      game={gameEntry('coronaz')}
      lede="Survie coopérative façon jeu de plateau : la carte sur la télé, votre survivant en main. Trois à cinq joueurs, une heure, et rarement tout le monde à la sortie."
      tiles={TILES}
    />
  );
}
