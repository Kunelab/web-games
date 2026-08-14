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

/** Short French label, for chips and table cells. */
const KIND_LABELS: Record<string, string> = {
  blindtest: 'Blind test',
  quiz: 'Question',
  estimation: 'Estimation',
  'image-reveal': 'Image',
  'image-memory': 'Panel'
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}
