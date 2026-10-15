import { msg, msgOf, type Msg } from 'i18n';

import { hasKey } from './hasKey';

/**
 * The face of each Mafia career badge, in the server's own prestige order.
 *
 * An emoji and two catalogue keys, exactly as `badges.ts` does for the quiz. The
 * two ladders are deliberately separate: they measure different games, they share
 * no key, and merging them into one map would mean a Mafia badge could silently
 * inherit a quiz badge's face the day somebody reused a name.
 *
 * Unknown keys degrade to a generic medal rather than crashing, so adding a badge
 * is a server change plus one line here and two in the catalogues. A badge listed
 * here has both keys checked by the compiler; only an id this build has never
 * heard of goes through `msgOf`, and renders its raw key as it always has.
 */
export const MAFIA_BADGE_EMOJI = {
  'first-table': '🪑',
  'first-blood': '🩸',
  regular: '🎭',
  survivor: '🕯️',
  'lone-wolf': '🐺',
  blooded: '🔪',
  veteran: '🎩',
  executioner: '⚖️',
  kingmaker: '👑',
  legend: '🏛️'
} satisfies Record<string, string>;

export function mafiaBadgeMeta(key: string): { emoji: string; title: Msg; hint: Msg } {
  if (hasKey(MAFIA_BADGE_EMOJI, key)) {
    return {
      emoji: MAFIA_BADGE_EMOJI[key],
      title: msg(`mafia.badge.${key}`),
      hint: msg(`mafia.badge.${key}.hint`)
    };
  }
  return { emoji: '🏅', title: msgOf(`mafia.badge.${key}`), hint: msgOf(`mafia.badge.${key}.hint`) };
}
