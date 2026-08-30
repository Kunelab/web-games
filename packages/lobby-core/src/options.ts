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
 *
 * Every `label` below is a catalogue key for the same reason. A package that
 * deliberately knows nothing about three engines should not be the place three
 * games' settings are written out in one language.
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
    label: 'lobby.opt.playlist',
    hint: 'lobby.opt.playlist.hint',
    choices: [],
    roll: true,
    fallback: ''
  },
  {
    key: 'length',
    label: 'lobby.opt.length',
    choices: [
      { value: 'court', label: 'lobby.choice.length.court' },
      { value: 'normal', label: 'lobby.choice.length.normal' },
      { value: 'long', label: 'lobby.choice.length.long' }
    ],
    roll: false,
    fallback: 'normal'
  },
  {
    key: 'combo',
    label: 'lobby.opt.combo',
    hint: 'lobby.opt.combo.hint',
    choices: [
      { value: 'on', label: 'lobby.choice.combo.on' },
      { value: 'off', label: 'lobby.choice.combo.off' }
    ],
    roll: false,
    fallback: 'on'
  }
];

const CORONAZ_SPECS: QuickOptionSpec[] = [
  {
    key: 'scenario',
    label: 'lobby.opt.scenario',
    choices: [
      { value: 'escape', label: 'lobby.choice.scenario.escape' },
      { value: 'purge', label: 'lobby.choice.scenario.purge' },
      { value: 'survival', label: 'lobby.choice.scenario.survival' }
    ],
    roll: true,
    fallback: 'escape'
  },
  {
    key: 'difficulty',
    label: 'lobby.opt.difficulty',
    choices: [
      { value: 'facile', label: 'lobby.choice.difficulty.facile' },
      { value: 'normal', label: 'lobby.choice.difficulty.normal' },
      { value: 'difficile', label: 'lobby.choice.difficulty.difficile' },
      { value: 'cauchemar', label: 'lobby.choice.difficulty.cauchemar' }
    ],
    roll: false,
    fallback: 'normal'
  },
  {
    key: 'biome',
    label: 'lobby.opt.biome',
    hint: 'lobby.opt.biome.hint',
    choices: [
      { value: 'random', label: 'lobby.choice.biome.random' },
      { value: 'modern', label: 'lobby.choice.biome.modern' },
      { value: 'cyber', label: 'lobby.choice.biome.cyber' }
    ],
    roll: true,
    fallback: 'random'
  }
];

const MAFIA_SPECS: QuickOptionSpec[] = [
  {
    key: 'setup',
    label: 'lobby.opt.setup',
    choices: [
      { value: 'auto', label: 'lobby.choice.setup.auto' },
      { value: 'chaos', label: 'lobby.choice.setup.chaos' }
    ],
    roll: false,
    fallback: 'auto'
  },
  {
    key: 'reveal',
    label: 'lobby.opt.reveal',
    choices: [
      { value: 'role', label: 'lobby.choice.reveal.role' },
      { value: 'faction', label: 'lobby.choice.reveal.faction' },
      { value: 'none', label: 'lobby.choice.reveal.none' }
    ],
    roll: false,
    fallback: 'faction'
  },
  {
    key: 'pace',
    label: 'lobby.opt.pace',
    choices: [
      { value: 'rapide', label: 'lobby.choice.pace.rapide' },
      { value: 'normal', label: 'lobby.choice.pace.normal' },
      { value: 'posé', label: 'lobby.choice.pace.posed' }
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
