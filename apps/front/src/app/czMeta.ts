import { msg, msgOf, type Msg } from 'i18n';

import { hasKey } from './hasKey';

/**
 * The faces of the CoronaZ roguelite keys: an emoji, and the catalogue keys that
 * name and explain each one.
 *
 * Unknown keys degrade to a generic medal whose name is its own id — the
 * renderer prints a missing key rather than an empty span — so a new
 * server-side trophy never crashes a page. Those are the only keys here built
 * with `msgOf`; a trophy or perk listed below has its keys checked.
 */

export const CZ_TROPHY_EMOJI = {
  'first-raid': '🩸',
  'first-escape': '🚪',
  packrat: '🎒',
  'left-for-dead': '💀',
  blitz: '⚡',
  veteran: '🎖️',
  'boss-hunter': '🏹',
  hoarder: '📦',
  'centurion-z': '🪓',
  'dark-dabbler': '😈',
  hordemaster: '👑',
  breeder: '🧫',
  tyrant: '🏴'
} satisfies Record<string, string>;

export function czTrophyMeta(key: string): { emoji: string; title: Msg; hint: Msg } {
  if (hasKey(CZ_TROPHY_EMOJI, key)) {
    return {
      emoji: CZ_TROPHY_EMOJI[key],
      title: msg(`coronaz.trophy.${key}`),
      hint: msg(`coronaz.trophy.${key}.hint`)
    };
  }
  return { emoji: '🏅', title: msgOf(`coronaz.trophy.${key}`), hint: msgOf(`coronaz.trophy.${key}.hint`) };
}

export const CZ_PERK_EMOJI = {
  'tough-skin': '❤️',
  'deep-pockets': '🎒',
  'second-wind': '🫁',
  sprinter: '👟',
  'boss-slayer': '🗡️',
  'lucky-find': '🍀',
  'dark-pact': '😈',
  overlord: '👑',
  breeder: '🧫',
  'iron-horde': '🛡️'
} satisfies Record<string, string>;

export function czPerkMeta(key: string): { emoji: string; label: Msg } {
  if (hasKey(CZ_PERK_EMOJI, key)) return { emoji: CZ_PERK_EMOJI[key], label: msg(`coronaz.perk.${key}`) };
  return { emoji: '✨', label: msgOf(`coronaz.perk.${key}`) };
}
