/**
 * A stable colour for a name, shared by everything that prints one.
 *
 * Lives in its own module because two surfaces have to agree: the chat, where a
 * colour is how you follow one voice through a scrolling log, and the Mafia
 * roster, where it is how you tie that voice to a seat. A hue computed
 * separately in each place is a hue that matches by accident.
 *
 * Keyed on the display name rather than the player id, which is the change that
 * made agreement possible at all — the roster never carries ids, deliberately
 * (see `MafiaPublicPlayer`), so the name is the only thing both sides hold. Names
 * are unique at a table; the join refuses a duplicate.
 */
export function authorHue(name: string): number {
  let hash = 0;
  for (let index = 0; index < name.length; index++) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }
  return hash % 360;
}

/** The colour itself, so callers do not each pick their own saturation. */
export function authorColour(name: string): string {
  return `hsl(${authorHue(name)}, 65%, 62%)`;
}
