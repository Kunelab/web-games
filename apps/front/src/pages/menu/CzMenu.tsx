import { gameEntry } from '../../app/games';
import GameMenu, { type MenuTile } from './GameMenu';

const TILES: MenuTile[] = [
  {
    to: '/partie-rapide/coronaz',
    label: 'site.tile.quick',
    hint: 'site.tile.quick.coronaz',
    emoji: '⚡',
    primary: true
  },
  {
    to: '/coronaz/nouveau',
    label: 'site.tile.createRaid',
    hint: 'site.tile.createRaid.hint',
    emoji: '🗺️',
    requiresAccount: true
  },
  {
    to: '/rejoindre?jeu=coronaz',
    label: 'site.tile.joinRaid',
    hint: 'site.tile.joinRaid.hint',
    emoji: '🔑'
  },
  {
    to: '/coronaz/boutique',
    label: 'site.tile.shop',
    hint: 'site.tile.shop.coronaz',
    emoji: '🥫',
    requiresAccount: true
  },
  {
    to: '/coronaz/equipement',
    label: 'site.tile.locker',
    hint: 'site.tile.locker.coronaz',
    emoji: '🎽',
    requiresAccount: true
  },
  {
    to: '/historique',
    label: 'site.tile.history',
    hint: 'site.tile.history.coronaz',
    emoji: '🏆',
    requiresAccount: true
  },
  {
    to: '/coronaz/guide',
    label: 'site.tile.guide.coronaz',
    hint: 'site.tile.guide.coronaz.hint',
    emoji: '📖'
  }
];

export default function CzMenu() {
  return (
    <GameMenu
      game={gameEntry('coronaz')}
      lede="site.menu.coronaz.lede"
      tiles={TILES}
    />
  );
}
