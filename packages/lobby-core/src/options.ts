import type { LobbyGame, QuickOptionSpec } from './state.js';

/**
 * What a quick room is allowed to argue about.
 *
 * Three dials per game, never more. The whole promise of a quick match is that it
 * starts — a setup screen with twenty switches is the thing it exists instead of,
 * and every extra option is another way for five strangers to fail to agree. What
 * survived the cut is the same triple everywhere: what we play, how hard, and how
 * long it takes.
 *
 * The values are opaque strings on purpose. Turning `"cauchemar"` into a config is
 * the server's job, and keeping that mapping out of here is what lets the browser
 * render a lobby for a game whose engine it does not import.
 */

/**
 * The quiz's playlist option is built by the server from the public library, so
 * the choices are empty here and filled in before the lobby is created. The key
 * is named once and read from both sides.
 */
export const QUICK_PLAYLIST_KEY = 'playlist';

const QUIZ_SPECS: QuickOptionSpec[] = [
  {
    key: QUICK_PLAYLIST_KEY,
    label: 'Quiz',
    hint: 'Parmi les quiz publiés par la maison.',
    choices: [],
    roll: true,
    fallback: ''
  },
  {
    key: 'length',
    label: 'Longueur',
    choices: [
      { value: 'court', label: 'Court — 8 manches' },
      { value: 'normal', label: 'Normal — 15 manches' },
      { value: 'long', label: 'Long — tout le quiz' }
    ],
    roll: false,
    fallback: 'normal'
  },
  {
    key: 'combo',
    label: 'Points de combo',
    hint: 'Enchaîner des manches gagnées multiplie les points.',
    choices: [
      { value: 'on', label: 'Activés' },
      { value: 'off', label: 'Désactivés' }
    ],
    roll: false,
    fallback: 'on'
  }
];

const CORONAZ_SPECS: QuickOptionSpec[] = [
  {
    key: 'scenario',
    label: 'Scénario',
    choices: [
      { value: 'escape', label: 'Évasion — trouver les clés et sortir' },
      { value: 'purge', label: 'Purge — nettoyer le quartier' },
      { value: 'survival', label: 'Survie — tenir le siège' }
    ],
    roll: true,
    fallback: 'escape'
  },
  {
    key: 'difficulty',
    label: 'Difficulté',
    choices: [
      { value: 'facile', label: 'Facile' },
      { value: 'normal', label: 'Normal' },
      { value: 'difficile', label: 'Difficile' },
      { value: 'cauchemar', label: 'Cauchemar' }
    ],
    roll: false,
    fallback: 'normal'
  },
  {
    key: 'biome',
    label: 'Décor',
    hint: 'Le biome décide aussi de l’arsenal et du bestiaire.',
    choices: [
      { value: 'random', label: 'Au hasard' },
      { value: 'modern', label: 'Moderne' },
      { value: 'cyber', label: 'Cyber' }
    ],
    roll: true,
    fallback: 'random'
  }
];

const MAFIA_SPECS: QuickOptionSpec[] = [
  {
    key: 'setup',
    label: 'Distribution',
    choices: [
      { value: 'auto', label: 'Automatique — équilibrée' },
      { value: 'chaos', label: 'Chaos — rôles tirés au sort' }
    ],
    roll: false,
    fallback: 'auto'
  },
  {
    key: 'reveal',
    label: 'À la mort',
    choices: [
      { value: 'role', label: 'Rôle complet' },
      { value: 'faction', label: 'Camp seulement' },
      { value: 'none', label: 'Rien du tout' }
    ],
    roll: false,
    fallback: 'faction'
  },
  {
    key: 'pace',
    label: 'Rythme',
    choices: [
      { value: 'rapide', label: 'Rapide — jour de 1 min 30' },
      { value: 'normal', label: 'Normal — jour de 2 min' },
      { value: 'posé', label: 'Posé — jour de 3 min' }
    ],
    roll: false,
    fallback: 'normal'
  }
];

/** A fresh copy each call: the lobby writes nothing here, but nothing should be able to. */
export function quickSpecs(game: LobbyGame): QuickOptionSpec[] {
  const source = game === 'quiz' ? QUIZ_SPECS : game === 'coronaz' ? CORONAZ_SPECS : MAFIA_SPECS;
  return source.map((spec) => ({ ...spec, choices: spec.choices.map((choice) => ({ ...choice })) }));
}

/**
 * How many phones a quick room wants before it will start, and how many it takes.
 *
 * The minimum is the smallest number at which the game is still the game: a Mafia
 * with three players is a coin toss, a quiz alone is a rehearsal. The maximum is
 * the engine's own cap, mirrored here so the room can fill and start without
 * asking it.
 */
export function quickSize(game: LobbyGame): { min: number; max: number } {
  switch (game) {
    case 'quiz':
      return { min: 2, max: 12 };
    case 'coronaz':
      return { min: 1, max: 5 };
    case 'mafia':
      return { min: 5, max: 15 };
  }
}
