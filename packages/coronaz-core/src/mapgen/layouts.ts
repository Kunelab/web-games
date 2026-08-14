import { chance, pick, randInt, type RngState } from '../rng.js';
import { rectArea, type LayoutDef, type Plot, type Rect } from './builder.js';

/**
 * The four shapes a raid's world can take.
 *
 * A layout only decides *where the streets are and where the buildings stand* — it
 * never places a room. That division is the whole point: the interior pass, the
 * programmes, the furnishing and the biome all work the same whatever the layout,
 * so a new one is a single function.
 *
 * All four exist because the previous generator had exactly one idea (carve the
 * whole grid into small rooms) and it made every raid feel like the same corridor.
 */

/** Splits a span into bands, given the wanted band width and gap. */
function bands(rng: RngState, span: number, count: number, width: number): number[] {
  // Evenly spread, then jittered, so a grid of streets is not a chessboard.
  const positions: number[] = [];
  const step = span / (count + 1);
  for (let i = 1; i <= count; i++) {
    const centre = Math.round(step * i);
    const jitter = randInt(rng, 3) - 1;
    positions.push(Math.min(span - width, Math.max(1, centre + jitter)));
  }
  return positions;
}

/** Rectangles left when a set of bands is cut out of a rectangle. */
function blocksBetween(
  outer: Rect,
  vertical: { at: number; w: number }[],
  horizontal: { at: number; h: number }[]
): Rect[] {
  const xs: [number, number][] = [];
  let cursor = outer.x;
  for (const band of [...vertical].sort((a, b) => a.at - b.at)) {
    if (band.at > cursor) xs.push([cursor, band.at]);
    cursor = band.at + band.w;
  }
  if (cursor < outer.x + outer.w) xs.push([cursor, outer.x + outer.w]);

  const ys: [number, number][] = [];
  cursor = outer.y;
  for (const band of [...horizontal].sort((a, b) => a.at - b.at)) {
    if (band.at > cursor) ys.push([cursor, band.at]);
    cursor = band.at + band.h;
  }
  if (cursor < outer.y + outer.h) ys.push([cursor, outer.y + outer.h]);

  const blocks: Rect[] = [];
  for (const [x0, x1] of xs) {
    for (const [y0, y1] of ys) {
      if (x1 - x0 >= 2 && y1 - y0 >= 2) blocks.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
  }
  return blocks;
}

/** Trims a building footprint so it does not swallow its whole block. */
function inset(rng: RngState, block: Rect, most: number): Rect | null {
  const cut = (span: number) => Math.min(most, randInt(rng, most + 1), Math.max(0, span - 2));
  const left = cut(block.w);
  const top = cut(block.h);
  const right = cut(block.w - left);
  const bottom = cut(block.h - top);
  const rect: Rect = {
    x: block.x + left,
    y: block.y + top,
    w: block.w - left - right,
    h: block.h - top - bottom
  };
  return rect.w >= 2 && rect.h >= 2 ? rect : null;
}

/**
 * A city block. Cross streets, buildings between them, and the alleys and yards
 * that are left over. This is the "labyrinth of streets with flats on it".
 */
const quartier: LayoutDef = {
  id: 'quartier',
  name: 'Quartier',
  blurb: 'Rues qui se croisent, immeubles et commerces entre elles.',
  plan: (rng, width, height) => {
    const outer: Rect = { x: 0, y: 0, w: width, h: height };
    const verticalCount = width >= 22 ? 2 : 1;
    const horizontalCount = height >= 14 ? 2 : 1;

    const vertical = bands(rng, width, verticalCount, 2).map((at) => ({ at, w: chance(rng, 0.4) ? 2 : 1 }));
    const horizontal = bands(rng, height, horizontalCount, 2).map((at) => ({ at, h: chance(rng, 0.4) ? 2 : 1 }));

    const plots: Plot[] = [];
    for (const band of vertical) {
      plots.push({ kind: 'outdoor', rect: { x: band.at, y: 0, w: band.w, h: height }, program: 'street' });
    }
    for (const band of horizontal) {
      plots.push({ kind: 'outdoor', rect: { x: 0, y: band.at, w: width, h: band.h }, program: 'street' });
    }

    for (const block of blocksBetween(outer, vertical, horizontal)) {
      // A big block holds two buildings and a yard between them; a small one, one.
      const halves =
        rectArea(block) >= 30 && block.w >= 5
          ? [
              { ...block, w: Math.floor(block.w / 2) },
              { x: block.x + Math.floor(block.w / 2), y: block.y, w: Math.ceil(block.w / 2), h: block.h }
            ]
          : [block];

      for (const half of halves) {
        const footprint = inset(rng, half, 1);
        if (!footprint) continue;
        plots.push({
          kind: 'building',
          rect: footprint,
          building: pick(rng, rectArea(footprint) >= 20 ? ['flats', 'offices', 'club'] : ['house', 'shop', 'workshop'])
        });
      }
    }

    return { plots, filler: 'alley' };
  }
};

/**
 * Suburbia. One road, detached houses, and a great deal of outdoors — the
 * counterweight to the claustrophobia, and the layout where the horde is visible
 * long before it arrives.
 */
const residence: LayoutDef = {
  id: 'residence',
  name: 'Lotissement',
  blurb: 'Une route, des pavillons détachés, beaucoup d’extérieur.',
  plan: (rng, width, height) => {
    const plots: Plot[] = [];
    const horizontalRoad = height >= width * 0.6 ? chance(rng, 0.5) : true;

    if (horizontalRoad) {
      const at = Math.max(1, Math.min(height - 3, Math.floor(height / 2) + randInt(rng, 3) - 1));
      plots.push({ kind: 'outdoor', rect: { x: 0, y: at, w: width, h: 2 }, program: 'street' });

      // Houses in a row either side, with gardens between them.
      for (const side of [
        { y: 0, h: at },
        { y: at + 2, h: height - at - 2 }
      ]) {
        if (side.h < 3) continue;
        let x = randInt(rng, 2);
        while (x < width - 3) {
          const w = 3 + randInt(rng, 3);
          const h = Math.min(side.h, 3 + randInt(rng, 3));
          if (x + w > width) break;
          plots.push({
            kind: 'building',
            rect: { x, y: side.y + (side.h - h > 0 ? randInt(rng, side.h - h) : 0), w, h },
            building: pick(rng, ['house', 'house', 'house', 'shop'])
          });
          x += w + 1 + randInt(rng, 1);
        }
      }
    } else {
      const at = Math.max(1, Math.min(width - 3, Math.floor(width / 2) + randInt(rng, 3) - 1));
      plots.push({ kind: 'outdoor', rect: { x: at, y: 0, w: 2, h: height }, program: 'street' });
      for (const side of [
        { x: 0, w: at },
        { x: at + 2, w: width - at - 2 }
      ]) {
        if (side.w < 3) continue;
        let y = 1 + randInt(rng, 2);
        while (y < height - 3) {
          const h = 3 + randInt(rng, 2);
          const w = Math.min(side.w - 1, 3 + randInt(rng, 2));
          if (y + h > height - 1) break;
          plots.push({
            kind: 'building',
            rect: { x: side.x + (side.w - w > 0 ? randInt(rng, side.w - w) : 0), y, w, h },
            building: pick(rng, ['house', 'house', 'house', 'workshop'])
          });
          y += h + 1 + randInt(rng, 2);
        }
      }
    }

    return { plots, filler: 'yard' };
  }
};

/**
 * One big installation: a lab, a bunker, a vault. Almost entirely interior, with a
 * loading yard so there is somewhere to be extracted from.
 */
const complexe: LayoutDef = {
  id: 'complexe',
  name: 'Complexe',
  blurb: 'Un seul bâtiment : laboratoire, bunker, abri. Presque tout en intérieur.',
  plan: (rng, width, height) => {
    // The installation fills the board: a bunker is not a shed in a field, and a
    // ring of yard around it would put nearly half the raid outdoors.
    const dockSide = pick(rng, ['top', 'bottom', 'left', 'right'] as const);
    const dockDepth = 2;

    const rect: Rect = {
      x: dockSide === 'left' ? dockDepth : 0,
      y: dockSide === 'top' ? dockDepth : 0,
      w: width - (dockSide === 'left' || dockSide === 'right' ? dockDepth : 0),
      h: height - (dockSide === 'top' || dockSide === 'bottom' ? dockDepth : 0)
    };

    const dock: Rect =
      dockSide === 'top'
        ? { x: 0, y: 0, w: width, h: dockDepth }
        : dockSide === 'bottom'
          ? { x: 0, y: height - dockDepth, w: width, h: dockDepth }
          : dockSide === 'left'
            ? { x: 0, y: 0, w: dockDepth, h: height }
            : { x: width - dockDepth, y: 0, w: dockDepth, h: height };

    return {
      plots: [
        { kind: 'outdoor', rect: dock, program: 'dock' },
        { kind: 'building', rect, building: 'facility' }
      ],
      filler: 'yard'
    };
  }
};

/**
 * A venue on a street: the front, the halls, the back rooms. Street plus big rooms
 * plus toilets, which was the specific thing asked for.
 */
const etablissement: LayoutDef = {
  id: 'etablissement',
  name: 'Établissement',
  blurb: 'Une rue, une grande salle, des sanitaires et l’arrière-boutique.',
  plan: (rng, width, height) => {
    const streetDepth = chance(rng, 0.5) ? 2 : 3;
    const frontAtTop = chance(rng, 0.5);
    const plots: Plot[] = [];

    plots.push({
      kind: 'outdoor',
      rect: frontAtTop
        ? { x: 0, y: 0, w: width, h: streetDepth }
        : { x: 0, y: height - streetDepth, w: width, h: streetDepth },
      program: 'street'
    });

    const bodyY = frontAtTop ? streetDepth : 0;
    const bodyH = height - streetDepth;
    if (bodyH < 3) return { plots, filler: 'yard' };

    // The venue takes most of the frontage; a service yard takes the rest.
    const venueW = Math.max(4, Math.round(width * (0.6 + randInt(rng, 3) / 10)));
    const venueX = chance(rng, 0.5) ? 0 : width - venueW;

    plots.push({
      kind: 'building',
      rect: { x: venueX, y: bodyY, w: Math.min(venueW, width), h: bodyH },
      building: 'club'
    });

    const restW = width - venueW;
    if (restW >= 3) {
      const restX = venueX === 0 ? venueW : 0;
      // Something small next door: a shop, or just a car park.
      if (chance(rng, 0.6) && bodyH >= 3) {
        plots.push({
          kind: 'building',
          rect: { x: restX + 1, y: bodyY + 1, w: Math.max(2, restW - 2), h: Math.max(2, bodyH - 2) },
          building: pick(rng, ['shop', 'house', 'workshop'])
        });
      } else {
        plots.push({
          kind: 'outdoor',
          rect: { x: restX, y: bodyY, w: restW, h: bodyH },
          program: 'parking'
        });
      }
    }

    return { plots, filler: 'alley' };
  }
};

export const LAYOUTS: readonly LayoutDef[] = [quartier, residence, complexe, etablissement];

export const LAYOUT_IDS = LAYOUTS.map((layout) => layout.id);

export function layoutDef(id: string): LayoutDef {
  const found = LAYOUTS.find((layout) => layout.id === id);
  if (!found) throw new Error(`Unknown layout: ${id}`);
  return found;
}

export function rollLayout(rng: RngState): LayoutDef {
  return pick(rng, LAYOUTS);
}
