/**
 * French face of each award key the server can hand out. Unknown keys still
 * render — a new server-side award degrades to a generic medal, not a crash.
 */
export const AWARD_META: Record<string, { emoji: string; title: string }> = {
  fastest: { emoji: '⚡', title: 'L’éclair' },
  workhorse: { emoji: '🧱', title: 'Le stakhanoviste' },
  sniper: { emoji: '🎯', title: 'Le sniper' },
  scattergun: { emoji: '🌪️', title: 'La mitraillette' },
  streak: { emoji: '🔥', title: 'La série' },

  /* CoronaZ: same shape, same ceremony, so the history page needs no branch. */
  butcher: { emoji: '🪓', title: 'Le boucher' },
  locksmith: { emoji: '🔑', title: 'Le serrurier' },
  looter: { emoji: '🎒', title: 'Le pillard' },
  untouchable: { emoji: '🛡️', title: 'L’increvable' },
  magnet: { emoji: '🧲', title: 'L’aimant à morsures' }
};

export function awardMeta(key: string): { emoji: string; title: string } {
  return AWARD_META[key] ?? { emoji: '🏅', title: key };
}
