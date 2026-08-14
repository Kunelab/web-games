import { chance, randInt, type RngState } from '../rng.js';
import { rectArea, type Rect } from './builder.js';

/**
 * Binary space partition: a rectangle cut recursively into rooms.
 *
 * This is the standard way to make a floor plan look drawn rather than grown, and
 * the reason it is worth having over the old random footprints: the pieces tile
 * the building exactly, they vary in size the way real rooms do, and they are
 * rectangles, so a bedroom looks like a bedroom.
 *
 * `target` is how many spaces the building's programme wants. Splitting stops when
 * it has enough, or when no piece can be halved without producing a cupboard.
 */
export function partition(
  rng: RngState,
  rect: Rect,
  options: { target: number; minSide?: number; minArea?: number }
): Rect[] {
  const minSide = options.minSide ?? 1;
  const minArea = options.minArea ?? 2;
  const spaces: Rect[] = [rect];

  /** Splitting the largest piece first keeps the sizes from drifting apart. */
  const largest = (): number => {
    let index = 0;
    let best = -1;
    for (let i = 0; i < spaces.length; i++) {
      const space = spaces[i];
      const area = space ? rectArea(space) : -1;
      if (area > best) {
        best = area;
        index = i;
      }
    }
    return index;
  };

  let guard = 0;
  while (spaces.length < options.target && guard++ < 200) {
    const index = largest();
    const space = spaces[index];
    if (!space) break;

    const split = splitOnce(rng, space, minSide, minArea);
    if (!split) break; // Nothing left worth cutting.
    spaces.splice(index, 1, split[0], split[1]);
  }

  return spaces;
}

function splitOnce(rng: RngState, rect: Rect, minSide: number, minArea: number): [Rect, Rect] | null {
  const canVertical = rect.w >= minSide * 2 + 1 || rect.w >= 2 * minSide;
  const canHorizontal = rect.h >= minSide * 2 + 1 || rect.h >= 2 * minSide;
  if (!canVertical && !canHorizontal) return null;
  if (rectArea(rect) < minArea * 2) return null;

  // Cut across the long side, so rooms stay squarish; a coin flip when it is square.
  const vertical = canVertical && (!canHorizontal || (rect.w === rect.h ? chance(rng, 0.5) : rect.w > rect.h));

  if (vertical) {
    const room = rect.w - minSide * 2;
    if (room < 0) return null;
    const at = minSide + randInt(rng, room + 1);
    const left: Rect = { x: rect.x, y: rect.y, w: at, h: rect.h };
    const right: Rect = { x: rect.x + at, y: rect.y, w: rect.w - at, h: rect.h };
    if (rectArea(left) < minArea || rectArea(right) < minArea) return null;
    return [left, right];
  }

  const room = rect.h - minSide * 2;
  if (room < 0) return null;
  const at = minSide + randInt(rng, room + 1);
  const top: Rect = { x: rect.x, y: rect.y, w: rect.w, h: at };
  const bottom: Rect = { x: rect.x, y: rect.y + at, w: rect.w, h: rect.h - at };
  if (rectArea(top) < minArea || rectArea(bottom) < minArea) return null;
  return [top, bottom];
}
