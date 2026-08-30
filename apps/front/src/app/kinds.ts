/**
 * Colour per media kind, read from the tokens so the two shells can disagree.
 *
 * A kind's colour is the only thing genuinely read at a glance in a long list, so it
 * lives here rather than being chosen per screen.
 */
const KIND_COLORS: Record<string, string> = {
  blindtest: 'var(--kind-blindtest)',
  quiz: 'var(--kind-quiz)',
  estimation: 'var(--kind-estimation)',
  'image-reveal': 'var(--kind-image-reveal)',
  'image-memory': 'var(--kind-image-memory)'
};

export function kindColor(kind: string): string {
  return KIND_COLORS[kind] ?? 'var(--ink-faint)';
}

/**
 * The catalogue key that names a kind, for chips and table cells.
 *
 * A key rather than a word: five labels appear on eight different screens, and
 * one of those screens is a phone whose owner may not read French.
 */
export function kindKey(kind: string): string {
  return `quiz.kind.${kind}`;
}
