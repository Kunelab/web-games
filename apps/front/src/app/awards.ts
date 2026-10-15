import { msg, msgOf, type Msg } from 'i18n';

import { hasKey } from './hasKey';

/**
 * The face of each award key the server can hand out.
 *
 * An emoji and a catalogue key. Unknown keys still render — a new server-side
 * award degrades to a generic medal with its own id for a name, not a crash,
 * and `render` shows the raw key rather than an empty span. That fallback is the
 * one place the key goes through `msgOf`; an award listed here is checked.
 */
export const AWARD_EMOJI = {
  fastest: '⚡',
  workhorse: '🧱',
  sniper: '🎯',
  scattergun: '🌪️',
  streak: '🔥',

  /* CoronaZ: same shape, same ceremony, so the history page needs no branch. */
  butcher: '🪓',
  locksmith: '🔑',
  looter: '🎒',
  untouchable: '🛡️',
  magnet: '🧲'
} satisfies Record<string, string>;

export function awardMeta(key: string): { emoji: string; title: Msg } {
  if (hasKey(AWARD_EMOJI, key)) return { emoji: AWARD_EMOJI[key], title: msg(`award.${key}`) };
  return { emoji: '🏅', title: msgOf(`award.${key}`) };
}
