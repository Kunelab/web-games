/**
 * A stable colour for a name, shared by everything that prints one.
 *
 * Lives in its own module because three surfaces have to agree: the chat, where
 * a colour is how you follow one voice through a scrolling log; the Mafia
 * roster, where it is how you tie that voice to a seat; and the hill, where the
 * mark under a villager's feet is the only thing saying which of two dozen
 * identical silhouettes you are looking at. A hue computed separately in each
 * place is a hue that matches by accident.
 *
 * Keyed on the display name rather than the player id, which is the change that
 * made agreement possible at all — the roster never carries ids, deliberately
 * (see `MafiaPublicPlayer`), so the name is the only thing all three hold. Names
 * are unique at a table; the join refuses a duplicate.
 */

/**
 * The palette, and why it is a list rather than a formula.
 *
 * This used to be `hash % 360` fed straight into `hsl(h, 65%, 62%)`, which
 * sounds like it gives every name its own colour and does not. Three things go
 * wrong with a continuous wheel, and all three are worse on a roster than in a
 * chat log:
 *
 *  - **Neighbouring hues are indistinguishable.** Twenty names on a wheel of
 *    360 puts pairs within a few degrees of each other constantly, and two
 *    seats the same shade of green is precisely the confusion a seat colour
 *    exists to prevent.
 *  - **Perceived brightness is not hue.** At a fixed 62% lightness, yellow and
 *    cyan come out glaring and blue and violet come out muddy against this
 *    theme's dark panels. Some names were simply harder to read than others.
 *  - **The wheel has dead zones.** Everything around 60° reads as the warning
 *    yellow this interface already uses for the vote timer, and everything
 *    around 0° reads as the danger red.
 *
 * So: twenty colours, picked to sit apart from each other and to hold up on a
 * dark panel, with lightness tuned per hue rather than fixed. Twenty rather
 * than sixteen because a Mafia table seats twenty-four and a palette that
 * starts repeating before the table is full is a palette with a bug in it; at
 * twenty the repeat is late, visible only on the largest tables, and always
 * between two names far apart in the list.
 */
const PALETTE = [
  '#e4674f', // vermilion
  '#f0913c', // amber
  '#d7b13a', // ochre
  '#a8bf46', // olive
  '#6fbf59', // leaf
  '#45bd86', // jade
  '#3fbcb4', // teal
  '#48b0d6', // sky
  '#5a93e6', // cornflower
  '#7c84ea', // periwinkle
  '#9b78e0', // violet
  '#c273d9', // orchid
  '#dc6fae', // rose
  '#e2687f', // raspberry
  '#c98d6a', // clay
  '#8fae8a', // sage
  '#7fa9c4', // slate blue
  '#b59ad4', // lilac
  '#d9a06f', // sand
  '#6ec2a4' // seafoam
] as const;

/** The stable index into `PALETTE` for a name. */
function slotOf(name: string): number {
  let hash = 0;
  for (let index = 0; index < name.length; index++) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }
  return hash % PALETTE.length;
}

/**
 * The colour itself, so callers do not each pick their own saturation.
 *
 * Returns a hex string rather than an `hsl()` because the palette is hand-tuned
 * per entry: reconstituting it from a hue would throw away the per-colour
 * lightness that makes the violets readable next to the yellows.
 */
export function authorColour(name: string): string {
  return PALETTE[slotOf(name)] ?? PALETTE[0];
}

/**
 * The same colour, kept as a hue for the few callers that need a number.
 *
 * The hill draws a seat's mark as a flat ellipse and wants the colour; anything
 * that genuinely needs to derive a *related* shade (a lighter head, a darker
 * contact patch) is better served by `color-mix` in CSS than by rebuilding an
 * `hsl()` here, which is why this is deliberately the only numeric export.
 */
export function authorHue(name: string): number {
  const hex = authorColour(name);
  const red = parseInt(hex.slice(1, 3), 16) / 255;
  const green = parseInt(hex.slice(3, 5), 16) / 255;
  const blue = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  if (max === min) return 0;
  const span = max - min;
  const hue =
    max === red
      ? ((green - blue) / span + (green < blue ? 6 : 0)) * 60
      : max === green
        ? ((blue - red) / span + 2) * 60
        : ((red - green) / span + 4) * 60;
  return Math.round(hue);
}

/** How many distinct colours a table can show before any two repeat. */
export const AUTHOR_COLOURS = PALETTE.length;
