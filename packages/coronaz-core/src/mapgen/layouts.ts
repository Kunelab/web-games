import { chance, pick, randInt, shuffled, type RngState } from '../rng.js';
import { rectArea, type LayoutDef, type Plot, type Rect } from './builder.js';
import { LANDMARK_PROGRAMS } from './programs.js';

/**
 * The five shapes a raid's world can take.
 *
 * A layout only decides *where the streets are and where the buildings stand* — it
 * never places a room. That division is the whole point: the interior pass, the
 * programmes, the furnishing and the biome all work the same whatever the layout,
 * so a new one is a single function.
 *
 * They exist because the first generator had exactly one idea (carve the whole grid
 * into small rooms) and it made every raid feel like the same corridor. `ville` came
 * later still, for the opposite complaint: the other four were varied but *illegible*
 * from above, because nothing outdoors had a kind and no building had a name.
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
 * Trims a footprint away from its neighbours and the street, but not away from the
 * edge of the board: a side that lies on the border is left alone, because the
 * border is where the town is cut off rather than where it ends.
 */
function setback(rng: RngState, lot: Rect, width: number, height: number): Rect | null {
  const cut = (span: number) => Math.min(1, Math.max(0, span - 2));
  const left = lot.x > 0 ? cut(lot.w) : 0;
  const top = lot.y > 0 ? cut(lot.h) : 0;
  const right = lot.x + lot.w < width ? cut(lot.w - left) : 0;
  const bottom = lot.y + lot.h < height ? cut(lot.h - top) : 0;
  const rect: Rect = {
    x: lot.x + left,
    y: lot.y + top,
    w: lot.w - left - right,
    h: lot.h - top - bottom
  };
  // A little variety in how deep the plot sits, on the street side only.
  if (rect.h > 3 && chance(rng, 0.4) && lot.y > 0) {
    rect.y += 1;
    rect.h -= 1;
  }
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
 * One big installation: a lab, a bunker, a vault. Almost entirely interior, and the
 * layout to pick when you want a raid with no sky in it.
 *
 * Built as **wings joined by spine corridors**, not as one building, and that is the
 * whole lesson of this layout. It used to be a single plot covering the board, and a
 * single building has one programme, one set of cluster budgets and one hue. At 484
 * cells that produced a facility with fifty laboratories in it, and once the cluster
 * budgets were in it produced a facility that was seventy per cent corridor instead,
 * because every space past the programme's budget had nowhere to go. No amount of
 * budget arithmetic fixes that, because the premise is wrong: a 484-cell building is
 * not a building, it is a complex.
 *
 * So the board is cut into three or four wings, each an ordinary-sized building with
 * its own programme (a laboratory wing, a workshop wing, an infirmary), separated by
 * corridors one cell wide that run the full length. Each wing's budgets now apply to
 * a building they were written for, the spine is the hallway that keeps the different
 * kinds of room apart, and the whole thing still has no outdoors except the dock.
 */
const complexe: LayoutDef = {
  id: 'complexe',
  name: 'Complexe',
  blurb: 'Des ailes reliées par des couloirs : laboratoire, bunker, abri. Presque tout en intérieur.',
  plan: (rng, width, height) => {
    const plots: Plot[] = [];

    // A loading dock: somewhere to be extracted from, and the only sky in the raid.
    const dockSide = pick(rng, ['top', 'bottom', 'left', 'right'] as const);
    const dockDepth = 2;
    const dock: Rect =
      dockSide === 'top'
        ? { x: 0, y: 0, w: width, h: dockDepth }
        : dockSide === 'bottom'
          ? { x: 0, y: height - dockDepth, w: width, h: dockDepth }
          : dockSide === 'left'
            ? { x: 0, y: 0, w: dockDepth, h: height }
            : { x: width - dockDepth, y: 0, w: dockDepth, h: height };
    plots.push({ kind: 'outdoor', rect: dock, program: 'dock' });

    /** What is left for the installation itself. */
    const body: Rect = {
      x: dockSide === 'left' ? dockDepth : 0,
      y: dockSide === 'top' ? dockDepth : 0,
      w: width - (dockSide === 'left' || dockSide === 'right' ? dockDepth : 0),
      h: height - (dockSide === 'top' || dockSide === 'bottom' ? dockDepth : 0)
    };

    /**
     * Wings across the long axis, so a spine runs the way the building is longest.
     * Three or four, which at 22 cells is wings of five or six cells deep: enough for
     * a room either side of the corridor, which is what a corridor is for.
     */
    const across = body.w >= body.h;
    const span = across ? body.h : body.w;
    const wings = span >= 18 ? 4 : span >= 12 ? 3 : 2;
    const spine = 1;
    const wingDepth = Math.floor((span - spine * (wings - 1)) / wings);
    if (wingDepth < 3) {
      // Too cramped for wings: one building, as before.
      return { plots: [...plots, { kind: 'building', rect: body, building: 'facility' }], filler: 'yard' };
    }

    /**
     * One programme per wing, drawn without replacement: a laboratory wing, a
     * workshop wing, quarters, an infirmary. Without replacement is the part that
     * matters, since the rare rooms are per building and four laboratory wings means
     * four of everything the loot table pays for.
     */
    const programmes = shuffled(rng, ['facility', 'workshop', 'quarters', 'hospital', 'offices']);

    let at = across ? body.y : body.x;
    for (let i = 0; i < wings; i++) {
      const depth = i === wings - 1 ? (across ? body.y + body.h : body.x + body.w) - at : wingDepth;
      if (depth < 3) break;

      plots.push({
        kind: 'building',
        rect: across ? { x: body.x, y: at, w: body.w, h: depth } : { x: at, y: body.y, w: depth, h: body.h },
        building: programmes[i] ?? 'quarters'
      });
      at += depth;

      // The spine between this wing and the next, full length so it reads as one
      // corridor rather than as a gap the repair pass happened to door together.
      if (i < wings - 1 && at + spine <= (across ? body.y + body.h : body.x + body.w)) {
        plots.push({
          kind: 'building',
          rect: across ? { x: body.x, y: at, w: body.w, h: spine } : { x: at, y: body.y, w: spine, h: body.h },
          building: 'spine'
        });
        at += spine;
      }
    }

    return { plots, filler: 'yard' };
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


/**
 * A piece of a real town: one road, its pavements, a public square, and named
 * buildings along it.
 *
 * This exists because the other layouts, seen from above, all read as one enormous
 * hangar. Two reasons, both fixed here rather than patched downstream.
 *
 * The first is that the outdoors had no *kinds*. Everything outside a wall was
 * "street", so a car park, a garden and a boulevard were the same grey ground with
 * the same bins on it, and there was nothing for the eye to use to work out where it
 * was. A town is legible because a road is not a pavement and a pavement is not a
 * park, so those are now three programmes with three floors and three completely
 * different prop budgets.
 *
 * The second is that the layouts placed *anonymous* buildings. A block of flats and
 * an office look the same from the street, so the map was a field of grey boxes. A
 * town has landmarks: this one always plants a police station and a hospital, which
 * are also the two buildings the loot table pays for, so the skyline and the reason
 * to walk towards it are the same thing.
 *
 * The road runs the full span, straight, with no turns: streets that bend produced
 * L-shaped outdoor rooms that read as damage, and a grid of them was the labyrinth
 * that made the old town feel like a maze rather than a place.
 */
const ville: LayoutDef = {
  id: 'ville',
  name: 'Ville',
  blurb: 'Une avenue, ses trottoirs, une place, un commissariat et un hôpital.',
  plan: (rng, width, height) => {
    const plots: Plot[] = [];
    /** Along x when the board is wider than tall, so the road is always the long axis. */
    const horizontal = width >= height ? true : false;
    const span = horizontal ? height : width;
    const along = horizontal ? width : span;
    void along;

    // The carriageway: two cells, so a 2×2 block of road fits and the avenue is one
    // room wide rather than a chain of single tiles.
    const roadDepth = 2;
    // Pavements either side. This is the whole trick of the thing: the kerb is what
    // makes a road look like a road from above.
    const walk = 1;
    const bandDepth = roadDepth + walk * 2;
    if (span < bandDepth + 6) {
      // Too shallow for a town: fall back to something that fits.
      return residence.plan(rng, width, height);
    }

    /** Where the whole road-and-pavement band starts, roughly centred. */
    const bandAt = Math.max(
      3,
      Math.min(span - bandDepth - 3, Math.floor((span - bandDepth) / 2) + randInt(rng, 3) - 1)
    );

    const strip = (at: number, depth: number, program: 'street' | 'sidewalk'): Plot => ({
      kind: 'outdoor',
      rect: horizontal ? { x: 0, y: at, w: width, h: depth } : { x: at, y: 0, w: depth, h: height },
      program
    });

    plots.push(strip(bandAt, walk, 'sidewalk'));
    plots.push(strip(bandAt + walk, roadDepth, 'street'));
    plots.push(strip(bandAt + walk + roadDepth, walk, 'sidewalk'));

    /* ------------------------ the two sides of the street ------------------- */

    const sides = [
      { at: 0, depth: bandAt },
      { at: bandAt + bandDepth, depth: span - bandAt - bandDepth }
    ].filter((side) => side.depth >= 3);

    /**
     * Landmarks go down first, biggest lot each, drawn from the pool rather than
     * fixed: a town that is always a police station and a hospital is a town you have
     * already played. Two or three per raid out of six, so most of the list is
     * missing from any given map, which is what makes finding a chemist worth
     * something.
     *
     * At least one is guaranteed, because a raid that rolled no landmark at all would
     * be the field of anonymous grey boxes this layout exists to replace.
     */
    const landmarks = shuffled(rng, [...LANDMARK_PROGRAMS]).slice(0, 2 + (chance(rng, 0.45) ? 1 : 0));
    const ordinary = ['flats', 'house', 'shop', 'offices', 'workshop'];
    let landmarkIndex = 0;

    for (const side of sides) {
      /** Lots along the street. Four on a long board, three on a short one. */
      const lots = Math.max(2, Math.min(4, Math.floor((horizontal ? width : height) / 6)));
      const lotSpan = Math.floor((horizontal ? width : height) / lots);
      /** One lot per side is public ground rather than a building. */
      const openLot = randInt(rng, lots);

      for (let i = 0; i < lots; i++) {
        const start = i * lotSpan;
        const size = i === lots - 1 ? (horizontal ? width : height) - start : lotSpan;
        const lot: Rect = horizontal
          ? { x: start, y: side.at, w: size, h: side.depth }
          : { x: side.at, y: start, w: side.depth, h: size };

        if (i === openLot && rectArea(lot) >= 12) {
          /**
           * The square, or the park. A "place du Capitole": open ground with a
           * paved or planted floor, benches and planters and nothing else, which
           * is what gives a town somewhere to breathe and the players somewhere
           * they can see the horde coming across.
           */
          plots.push({ kind: 'outdoor', rect: lot, program: chance(rng, 0.5) ? 'square' : 'park' });
          continue;
        }

        /**
         * A setback from the street and from the neighbours, but never from the
         * edge of the board.
         *
         * A uniform inset put a one-cell ring of yard around the entire map, which
         * from above read as a moat: the town looked like a model on a tray rather
         * than a piece cut out of somewhere bigger. A town's outer edge is where the
         * buildings simply stop being drawn, so the footprint runs to the border on
         * any side that *is* the border.
         */
        const footprint = setback(rng, lot, width, height);
        if (!footprint || rectArea(footprint) < 6) continue;

        const landmark = landmarkIndex < landmarks.length && rectArea(footprint) >= 12;
        plots.push({
          kind: 'building',
          rect: footprint,
          building: landmark ? landmarks[landmarkIndex++] : pick(rng, ordinary)
        });
      }
    }

    /**
     * If neither side had a lot big enough for a landmark, put one on the biggest
     * building we did place. A town with no police station and no hospital is the
     * anonymous grey field this layout was written to replace.
     */
    if (landmarkIndex === 0) {
      const biggest = plots
        .filter((plot) => plot.kind === 'building')
        .sort((a, b) => rectArea(b.rect) - rectArea(a.rect))[0];
      if (biggest) biggest.building = landmarks[0];
    }

    return { plots, filler: 'yard' };
  }
};

export const LAYOUTS: readonly LayoutDef[] = [ville, quartier, residence, complexe, etablissement];

export const LAYOUT_IDS = LAYOUTS.map((layout) => layout.id);

export function layoutDef(id: string): LayoutDef {
  const found = LAYOUTS.find((layout) => layout.id === id);
  if (!found) throw new Error(`Unknown layout: ${id}`);
  return found;
}

export function rollLayout(rng: RngState): LayoutDef {
  return pick(rng, LAYOUTS);
}
