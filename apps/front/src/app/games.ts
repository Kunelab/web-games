import type { LobbyGame } from 'lobby-core';

/**
 * The three games, in one place.
 *
 * They arrived one at a time and each grew its own front door: a nav link for
 * CoronaZ, a bare URL for Mafia, and the quizzes hiding behind "Playlists"
 * because that is where they had always been. The result was a site whose menu
 * described its history rather than what you could play.
 *
 * This is the list the header dropdown, the join board and every "back to the
 * menu" link read from. Adding a fourth game means adding an entry here and its
 * two pages — the navigation itself never has to be edited again.
 */

export interface GameEntry {
  id: LobbyGame;
  name: string;
  /** One line, for the dropdown and the menu header. */
  tagline: string;
  /** The game's own menu: create, join, learn, leave. */
  path: string;
  /** Where "Créer une partie" goes. */
  createPath: string;
  /** The lore, the rules, the bestiary — whatever this game has of them. */
  guidePath: string;
  /** CSS colour token, so a game's screens are recognisable before you read them. */
  accent: string;
  emoji: string;
}

export const GAMES: GameEntry[] = [
  {
    id: 'quiz',
    name: 'Quiz',
    tagline: 'Blind test, questions, estimations, panels — à faire deviner entre amis.',
    path: '/quiz',
    createPath: '/quiz/creer',
    guidePath: '/quiz/regles',
    accent: 'var(--kind-quiz)',
    emoji: '🎧'
  },
  {
    id: 'coronaz',
    name: 'CoronaZ',
    tagline: 'Survie coopérative contre la horde, façon jeu de plateau.',
    path: '/coronaz',
    createPath: '/coronaz/nouveau',
    guidePath: '/coronaz/guide',
    accent: 'var(--kind-coronaz)',
    emoji: '🧟'
  },
  {
    id: 'mafia',
    name: 'Mafia',
    tagline: 'Une ville, des loups, et personne qui dit la vérité.',
    path: '/mafia',
    createPath: '/mafia/nouveau',
    guidePath: '/mafia/guide',
    accent: 'var(--kind-mafia)',
    emoji: '🕵️'
  }
];

export function gameEntry(id: LobbyGame): GameEntry {
  const found = GAMES.find((game) => game.id === id);
  if (!found) throw new Error(`Unknown game: ${id}`);
  return found;
}

/** Where a player of `game` goes once a quick room has started something. */
export function gameName(id: LobbyGame): string {
  return GAMES.find((game) => game.id === id)?.name ?? id;
}
