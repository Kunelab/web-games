import { msg, msgOf, type Msg } from 'i18n';

import { hasKey } from './hasKey';

/**
 * The face of each career badge the server can hand out, in the server's own
 * prestige order.
 *
 * An emoji and two catalogue keys. Unknown keys degrade to a generic medal
 * rather than crashing, so adding a badge is a server change plus one line here
 * and two in the catalogues.
 *
 * The id arrives from the server as a plain string, so it is checked against
 * this table first: a badge listed here has its two keys checked by the
 * compiler, and only one this build has never heard of falls back to `msgOf`,
 * which renders its raw key exactly as it always has.
 */
export const BADGE_EMOJI = {
  'first-game': '🎲',
  regular: '🎮',
  pillar: '🛋️',
  'first-win': '🥇',
  lightning: '⚡',
  'streak-3': '🔥',
  'hundred-right': '✅',
  decorated: '🎖️',
  'five-wins': '👑',
  encyclopedia: '📚',
  'living-room-king': '🏆'
} satisfies Record<string, string>;

export function badgeMeta(key: string): { emoji: string; title: Msg; hint: Msg } {
  if (hasKey(BADGE_EMOJI, key)) {
    return { emoji: BADGE_EMOJI[key], title: msg(`badge.${key}`), hint: msg(`badge.${key}.hint`) };
  }
  return { emoji: '🏅', title: msgOf(`badge.${key}`), hint: msgOf(`badge.${key}.hint`) };
}
