/**
 * The face of each Mafia career badge, in the server's own prestige order.
 *
 * An emoji and two catalogue keys, exactly as `badges.ts` does for the quiz. The
 * two ladders are deliberately separate: they measure different games, they share
 * no key, and merging them into one map would mean a Mafia badge could silently
 * inherit a quiz badge's face the day somebody reused a name.
 *
 * Unknown keys degrade to a generic medal rather than crashing, so adding a badge
 * is a server change plus one line here and two in the catalogues.
 */
export const MAFIA_BADGE_EMOJI: Record<string, string> = {
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
};

export function mafiaBadgeMeta(key: string): { emoji: string; titleKey: string; hintKey: string } {
  return {
    emoji: MAFIA_BADGE_EMOJI[key] ?? '🏅',
    titleKey: `mafia.badge.${key}`,
    hintKey: `mafia.badge.${key}.hint`
  };
}
