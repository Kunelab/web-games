import { gameEntry } from '../../app/games';
import GameMenu, { type MenuTile } from './GameMenu';

const TILES: MenuTile[] = [
  {
    to: '/partie-rapide/mafia',
    label: 'site.tile.quick',
    hint: 'site.tile.quick.mafia',
    emoji: '⚡',
    primary: true
  },
  {
    to: '/mafia/nouveau',
    label: 'site.tile.createTable',
    hint: 'site.tile.createTable.hint',
    emoji: '🎭',
    requiresAccount: true
  },
  {
    to: '/rejoindre?jeu=mafia',
    label: 'site.tile.joinTable',
    hint: 'site.tile.joinTable.hint',
    emoji: '🔑'
  },
  {
    to: '/mafia/boutique',
    label: 'site.tile.shop',
    hint: 'site.tile.shop.mafia',
    emoji: '🎩',
    requiresAccount: true
  },
  {
    to: '/mafia/equipement',
    label: 'site.tile.locker',
    hint: 'site.tile.locker.mafia',
    emoji: '🎽',
    requiresAccount: true
  },
  {
    to: '/historique',
    label: 'site.tile.history',
    hint: 'site.tile.history.mafia',
    emoji: '🏆',
    requiresAccount: true
  },
  {
    to: '/mafia/guide',
    label: 'site.tile.guide.mafia',
    hint: 'site.tile.guide.mafia.hint',
    emoji: '📖'
  }
];

export default function MafiaMenu() {
  return (
    <GameMenu
      game={gameEntry('mafia')}
      lede="site.menu.mafia.lede"
      tiles={TILES}
    />
  );
}
