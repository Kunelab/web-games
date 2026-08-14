/**
 * French face of each career badge the server can hand out, in the server's own
 * prestige order. Unknown keys degrade to a generic medal rather than crashing,
 * so adding a badge is a server change plus one line here.
 */
export const BADGE_META: Record<string, { emoji: string; title: string; hint: string }> = {
  'first-game': { emoji: '🎲', title: 'Novice', hint: 'A joué sa première partie' },
  regular: { emoji: '🎮', title: 'Habitué', hint: '10 parties jouées' },
  pillar: { emoji: '🛋️', title: 'Pilier de canapé', hint: '50 parties jouées' },
  'first-win': { emoji: '🥇', title: 'Vainqueur', hint: 'Première victoire' },
  lightning: { emoji: '⚡', title: 'Réflexes féroces', hint: 'Bonne réponse en moins d’1,5 s' },
  'streak-3': { emoji: '🔥', title: 'Enchaîneur', hint: '3 manches gagnées d’affilée' },
  'hundred-right': { emoji: '✅', title: 'Centurion', hint: '100 bonnes réponses' },
  decorated: { emoji: '🎖️', title: 'Décoré', hint: '10 distinctions de fin de partie' },
  'five-wins': { emoji: '👑', title: 'Roi du salon', hint: '5 victoires' },
  encyclopedia: { emoji: '📚', title: 'Encyclopédie', hint: '500 bonnes réponses' },
  'living-room-king': { emoji: '🏆', title: 'Légende', hint: '20 victoires' }
};

export function badgeMeta(key: string): { emoji: string; title: string; hint: string } {
  return BADGE_META[key] ?? { emoji: '🏅', title: key, hint: '' };
}
