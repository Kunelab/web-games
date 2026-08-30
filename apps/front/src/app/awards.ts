/**
 * The face of each award key the server can hand out.
 *
 * An emoji and a catalogue key. Unknown keys still render — a new server-side
 * award degrades to a generic medal with its own id for a name, not a crash,
 * and `render` shows the raw key rather than an empty span.
 */
export const AWARD_EMOJI: Record<string, string> = {
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
};

export function awardMeta(key: string): { emoji: string; titleKey: string } {
  return { emoji: AWARD_EMOJI[key] ?? '🏅', titleKey: `award.${key}` };
}
