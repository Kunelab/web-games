import { RARITY_META, type Rarity } from 'coronaz-core';

/**
 * The two numbers every rarity effect is built from: the rarity's colour, and how
 * hard it should shine (0 for a common, 1 for a legendary).
 *
 * Keeping them in custom properties rather than in five hand-written variants
 * means the escalation is written once, in CSS — a glow that grows, a wash of the
 * rarity's hue over the artwork itself, and at the top two a sheen that travels
 * across it. See the "rarity, worn" block in coronaz.css.
 */
export function rarityVars(rarity: Rarity): React.CSSProperties {
  return {
    '--rarity': RARITY_META[rarity].color,
    '--rarity-force': (rarity - 1) / 4
  } as React.CSSProperties;
}
