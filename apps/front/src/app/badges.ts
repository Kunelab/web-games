/**
 * The face of each career badge the server can hand out, in the server's own
 * prestige order.
 *
 * An emoji and two catalogue keys. Unknown keys degrade to a generic medal
 * rather than crashing, so adding a badge is a server change plus one line here
 * and two in the catalogues.
 */
export const BADGE_EMOJI: Record<string, string> = {
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
};

export function badgeMeta(key: string): { emoji: string; titleKey: string; hintKey: string } {
  return { emoji: BADGE_EMOJI[key] ?? '🏅', titleKey: `badge.${key}`, hintKey: `badge.${key}.hint` };
}
