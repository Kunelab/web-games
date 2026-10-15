import { msg, msgOf, type Msg } from 'i18n';

import { hasKey } from './hasKey';

/**
 * Colour per media kind, read from the tokens so the two shells can disagree.
 *
 * A kind's colour is the only thing genuinely read at a glance in a long list, so it
 * lives here rather than being chosen per screen.
 */
const KIND_COLORS = {
  blindtest: 'var(--kind-blindtest)',
  quiz: 'var(--kind-quiz)',
  estimation: 'var(--kind-estimation)',
  'image-reveal': 'var(--kind-image-reveal)',
  'image-memory': 'var(--kind-image-memory)'
} satisfies Record<string, string>;

/**
 * A kind this build knows, which is every kind game-core registers.
 *
 * A media's kind comes off the wire and out of the database as a plain string,
 * so this is what turns it back into one of the five the catalogue names.
 */
export type KnownKind = keyof typeof KIND_COLORS;

export function kindColor(kind: string): string {
  return hasKey(KIND_COLORS, kind) ? KIND_COLORS[kind] : 'var(--ink-faint)';
}

/**
 * The name of a kind, for chips and table cells.
 *
 * A key rather than a word: five labels appear on eight different screens, and
 * one of those screens is a phone whose owner may not read French. Checked for
 * every kind this build knows; a kind it does not renders its raw key, through
 * `msgOf`, exactly as it did before the keys were typed.
 */
export function kindName(kind: string): Msg {
  return hasKey(KIND_COLORS, kind) ? msg(`quiz.kind.${kind}`) : msgOf(`quiz.kind.${kind}`);
}
