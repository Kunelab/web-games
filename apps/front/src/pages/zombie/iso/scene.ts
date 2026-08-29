import { SHINY_LOOT, type CzRoomView, type CzView } from 'coronaz-core';

import { czTerrain } from '../../../app/assets';

import {
  fillPolygon,
  paintFloor,
  paintGlint,
  paintLip,
  paintThreshold,
  paintWall,
  palette,
  shade,
  sprite,
  type Palette
} from './art';
import { furnishZone, type CellWalls, type PlacedProp, type RoomDecor } from './decor';
import { boardBounds, diamond, project, TILE_H, TILE_W, WALL_H, type Vec2 } from './geometry';
import { drawProp, paintGlow, propDef } from './props';

/**
 * The board, painted once.
 *
 * Nothing in a room moves between turns: the floors, the walls, the furniture and
 * the fog are the same until the state changes. So the scene is drawn into an
 * offscreen canvas and the live canvas only ever blits it under the camera's
 * transform — panning and zooming a 768-cell building costs one `drawImage`
 * rather than thirty thousand path operations, which is what makes dragging the
 * map feel like an RTS instead of a slideshow.
 *
 * Depth is the classic painter's order: cells back to front by `cx + cy`, and
 * within a cell floor → far walls → furniture. Only the far (north and west)
 * walls stand full height, so the building is cut away towards the camera and
 * you always look *into* a room.
 */

export interface Scene {
  canvas: HTMLCanvasElement;
  /**
   * The same scene painted as flat cell identifiers instead of art: one canvas
   * where every pixel says which cell drew it. Clicking uses this rather than
   * inverting the projection.
   *
   * The inverse projection answers "which tile is under this point *on the floor*",
   * and that is the wrong question, because everything is drawn standing *up* from
   * its tile. The top of a lamppost, the top half of a wall, the corner of a
   * wardrobe all occupy screen space that belongs geometrically to the tile behind
   * — so aiming at a room across a table put you one tile too far, exactly as
   * reported. Painting the same geometry again in identifier colours, in the same
   * painter's order, makes the answer whatever you can actually see.
   */
  pick: HTMLCanvasElement;
  /** World coordinates of the canvas's top-left pixel. */
  origin: Vec2;
  /** Device pixels per world pixel in both canvases. */
  scale: number;
  /** What this scene was drawn from; a different signature needs a redraw. */
  signature: string;
}

/** Cell index encoded as an opaque colour; alpha 0 means "no cell here". */
function pickColor(cell: number): string {
  return `rgb(${cell & 255} ${(cell >> 8) & 255} ${(cell >> 16) & 255})`;
}

/**
 * Which cell was drawn at a world point, or null off the board. Reads one pixel of
 * the pick canvas, so it costs nothing and is exact by construction.
 */
export function pickCellAt(scene: Scene, world: Vec2): number | null {
  const ctx = scene.pick.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const x = Math.round((world.x - scene.origin.x) * scene.scale);
  const y = Math.round((world.y - scene.origin.y) * scene.scale);
  if (x < 0 || y < 0 || x >= scene.pick.width || y >= scene.pick.height) return null;

  /**
   * The majority of a three-by-three, not the single pixel underneath.
   *
   * Canvas antialiases the edges of every polygon, and a blend of two identifiers
   * decodes to a *third* one — cell 255 fading into cell 256 reads as cell 127,
   * which is somewhere else entirely on the board. One pixel of fringe cannot
   * outvote eight, and on an exact boundary either answer was fine anyway.
   */
  const left = Math.max(0, x - 1);
  const top = Math.max(0, y - 1);
  const data = ctx.getImageData(
    left,
    top,
    Math.min(3, scene.pick.width - left),
    Math.min(3, scene.pick.height - top)
  ).data;

  const votes = new Map<number, number>();
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    const cell = (data[i] ?? 0) | ((data[i + 1] ?? 0) << 8) | ((data[i + 2] ?? 0) << 16);
    votes.set(cell, (votes.get(cell) ?? 0) + 1);
  }

  let best: number | null = null;
  let most = 0;
  for (const [cell, count] of votes) {
    if (count > most) {
      most = count;
      best = cell;
    }
  }
  return best;
}

/**
 * Everything the painting depends on, as a short string. Room contents, fog and
 * geometry are in; anything that moves (creatures, heroes, clocks) is not, which
 * is why the scene survives most state broadcasts untouched.
 */
export function sceneSignature(view: CzView): string {
  // Rubble never moves, but it does belong to the picture.
  const rooms = view.rooms
    .map((room) => `${room.id}:${room.seen[0]}:${room.kind[0]}:${room.hasKey ? 1 : 0}:${room.decor}`)
    .join(',');
  return `${view.width}x${view.height}|${view.edgeRight}|${view.edgeDown}|${view.rubble.length}|${rooms}`;
}

const decorCache = new Map<string, Map<string, RoomDecor>>();

/**
 * The furniture for a whole building, cached.
 *
 * Furnishing is per *building* rather than per room, because the quotas that keep a
 * building sane ("one fridge, not four") cannot be enforced one room at a time. The
 * cache key is therefore the building's whole set of rooms, and the outdoors — one
 * zone, zone 0 — is furnished as one job too.
 */
function zoneDecor(view: CzView, zone: number, wallsOf: (cell: number) => CellWalls): Map<string, RoomDecor> {
  const rooms = view.rooms.filter((room) => room.zone === zone && room.seen !== 'hidden');
  const key = `${view.width}:${zone}:${rooms.map((room) => `${room.id}.${room.decor}.${room.program}`).join(',')}`;
  const found = decorCache.get(key);
  if (found) return found;

  const built = furnishZone(rooms, view.width, wallsOf);
  // A new raid brings a whole new set of keys; a few dozen entries is the ceiling
  // per session and each one is small.
  if (decorCache.size > 400) decorCache.clear();
  decorCache.set(key, built);
  return built;
}

export function renderScene(view: CzView, devicePixelRatio = 1): Scene {
  const bounds = boardBounds(view.width, view.height);
  const pad = 8;
  const width = Math.ceil((bounds.maxX - bounds.minX + pad * 2) * devicePixelRatio);
  const height = Math.ceil((bounds.maxY - bounds.minY + pad * 2) * devicePixelRatio);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const origin = { x: bounds.minX - pad, y: bounds.minY - pad };

  /**
   * The pick canvas, at the same size and transform. Half resolution would be
   * cheaper and one pixel of slop on a tile boundary is exactly the kind of "I
   * clicked the wrong square" this exists to remove, so it stays at full scale.
   */
  const pick = document.createElement('canvas');
  pick.width = width;
  pick.height = height;
  const ink = pick.getContext('2d', { willReadFrequently: true });

  const scene: Scene = { canvas, pick, origin, scale: devicePixelRatio, signature: sceneSignature(view) };
  if (!ctx || !ink) return scene;

  for (const context of [ctx, ink]) {
    context.scale(devicePixelRatio, devicePixelRatio);
    context.translate(-origin.x, -origin.y);
  }
  ink.imageSmoothingEnabled = false;

  /** Stamps a shape into the pick map as "this cell". */
  const stamp = (cell: number, points: Vec2[]) => fillPolygon(ink, points, pickColor(cell));

  const blocked = new Set(view.rubble);
  const roomOf = new Map<number, CzRoomView>();
  for (const room of view.rooms) {
    for (const cell of room.cells) roomOf.set(cell, room);
  }

  const index = (x: number, y: number) =>
    x < 0 || y < 0 || x >= view.width || y >= view.height ? -1 : y * view.width + x;

  /** The boundary code on a cell's side; `#` outside the board. */
  const edge = (x: number, y: number, side: 'north' | 'east' | 'south' | 'west'): string => {
    const here = index(x, y);
    if (here === -1) return '#';
    if (side === 'east') return view.edgeRight[here] ?? '#';
    if (side === 'south') return view.edgeDown[here] ?? '#';
    if (side === 'west') {
      const left = index(x - 1, y);
      return left === -1 ? '#' : (view.edgeRight[left] ?? '#');
    }
    const up = index(x, y - 1);
    return up === -1 ? '#' : (view.edgeDown[up] ?? '#');
  };

  /**
   * Is this boundary part of a building's outer shell, or a partition inside it?
   *
   * The shell is drawn solid — it is what tells you where a building stops and the
   * street begins — and every partition inside it is drawn see-through, so a floor
   * plan reads as a whole from above. That is the fix for "I cannot tell where I
   * can go": the walls that matter stay opaque and the ones that only divide get
   * out of the way.
   *
   * A boundary is shell when it faces the outdoors, another building, the edge of
   * the board, or the unexplored dark.
   */
  const isShell = (cx: number, cy: number, side: 'north' | 'west'): boolean => {
    const here = roomOf.get(index(cx, cy));
    const nx = side === 'west' ? cx - 1 : cx;
    const ny = side === 'north' ? cy - 1 : cy;
    const beyond = index(nx, ny);
    if (beyond === -1) return true;
    const other = roomOf.get(beyond);
    if (!other || other.seen === 'hidden') return true;
    if (!here) return true;
    // Outdoors has no walls of its own: any wall it meets belongs to a building,
    // and a building's front is the most solid thing on the board.
    return here.zone !== other.zone;
  };

  /**
   * Which sides of a cell furniture may back onto.
   *
   * A window is deliberately **not** one of them, even though it is a solid wall.
   * Backing a wardrobe onto a window is a small cosmetic gain and it cost a measured
   * functional regression: a prop against a shell wall on the south or east side has
   * the top of its pick-map stamp painted over by the tile in front of it, so the
   * click that should hit the wardrobe hits the street behind. Counting windows as
   * anchors took tall props from 99 % clickable to 68 %.
   *
   * The underlying weakness is the stamping order, not the windows, and it is worth
   * fixing one day; until then the cheap answer is not to put furniture there. Nobody
   * has ever complained about a bare windowsill.
   */
  const wallsOf = (cell: number): CellWalls => {
    const x = cell % view.width;
    const y = Math.floor(cell / view.width);
    const solid = (side: 'north' | 'east' | 'south' | 'west') => {
      const code = edge(x, y, side);
      return code === '#' || code === '?';
    };
    return { north: solid('north'), east: solid('east'), south: solid('south'), west: solid('west') };
  };

  const palettes = new Map<string, Palette>();
  const paletteOf = (room: CzRoomView): Palette => {
    const found = palettes.get(room.id);
    if (found) return found;
    const built = palette(room.hue, room.floor, room.program);
    palettes.set(room.id, built);
    return built;
  };

  /** Furniture, per building, and then bucketed by cell so it draws in depth order. */
  const decorByRoom = new Map<string, RoomDecor>();
  for (const zone of new Set(view.rooms.map((room) => room.zone))) {
    for (const [id, decor] of zoneDecor(view, zone, wallsOf)) decorByRoom.set(id, decor);
  }

  const propsByCell = new Map<number, PlacedProp[]>();
  for (const room of view.rooms) {
    if (room.seen === 'hidden') continue;
    for (const prop of decorByRoom.get(room.id)?.props ?? []) {
      const cell = index(Math.round(prop.cx), Math.round(prop.cy));
      if (cell === -1) continue;
      const bucket = propsByCell.get(cell) ?? [];
      bucket.push(prop);
      propsByCell.set(cell, bucket);
    }
  }

  // Back to front. One pass over the diagonals is all the depth sorting a
  // regular grid needs.
  for (let diagonal = 0; diagonal <= view.width + view.height - 2; diagonal++) {
    for (let cx = 0; cx < view.width; cx++) {
      const cy = diagonal - cx;
      if (cy < 0 || cy >= view.height) continue;

      const cell = cx + cy * view.width;
      const room = roomOf.get(cell);
      if (!room) {
        // Rubble: a cell no room owns. Drawn, and deliberately not stamped into
        // the pick map — there is nothing there to aim at.
        if (blocked.has(cell)) paintRubble(ctx, cx, cy);
        continue;
      }

      // The floor is clickable everywhere, dark included: walking into the unknown
      // is the game, so the pick map covers the void too.
      stamp(cell, diamond(cx, cy));

      if (room.seen === 'hidden') {
        paintVoid(ctx, cx, cy);
        continue;
      }

      const colors = paletteOf(room);
      const decor = decorByRoom.get(room.id);

      paintFloor(ctx, cx, cy, colors, room.floor, room.decor + cell);

      /**
       * The glitter on a room worth robbing.
       *
       * The loot bonus is a number on the room and the player cannot read numbers
       * off a map, so a pharmacy paying 80 % more than a corridor would have been
       * invisible: the game would be asking for a decision it never showed you. A
       * warm haze on the floor and a few specks is enough — it says "there is
       * something in here" from across the street, and the room's own name says what.
       */
      if (room.loot >= SHINY_LOOT) {
        paintGlint(ctx, cx, cy, room.loot, room.decor + cell);
      }

      if (room.kind === 'fungus') {
        const creep = sprite(czTerrain('creep.png'));
        const shape = diamond(cx, cy);
        if (creep) {
          ctx.save();
          ctx.globalAlpha = 0.55;
          const centre = project(cx, cy);
          ctx.beginPath();
          ctx.moveTo(shape[0].x, shape[0].y);
          for (const point of shape.slice(1)) ctx.lineTo(point.x, point.y);
          ctx.closePath();
          ctx.clip();
          ctx.drawImage(creep, centre.x - TILE_W / 2, centre.y - TILE_H, TILE_W, TILE_H * 2);
          ctx.restore();
        } else {
          fillPolygon(ctx, shape, 'rgb(84 128 44 / 0.4)');
        }
      }

      /**
       * The far walls. A door is a gap with a frame and a lit threshold; an arch
       * is no wall at all, just a seam on the floor so the two rooms still read
       * apart. Interior partitions are drawn see-through — see `isShell`.
       *
       * A withheld boundary (`?`) cannot appear here: the projection only hides
       * one when both its cells are unseen, and those were skipped above.
       */
      for (const side of ['north', 'west'] as const) {
        const code = edge(cx, cy, side);
        const translucent = !isShell(cx, cy, side);
        const paper = decor?.wallpaper ?? 'plain';
        if (code === '#') {
          paintWall(ctx, cx, cy, side, colors, { paper, translucent });
        } else if (code === 'D') {
          paintWall(ctx, cx, cy, side, colors, { paper, door: true, translucent });
          paintThreshold(ctx, cx, cy, side, colors, 'door');
        } else if (code === 'W') {
          // Glass. Never translucent as a *wall*, because the whole point is that the
          // pane is the see-through part and the wall around it is not.
          paintWall(ctx, cx, cy, side, colors, { paper, window: true });
        } else if (code === 'A') paintThreshold(ctx, cx, cy, side, colors, 'seam');
      }

      /*
       * Walls deliberately do not claim their pixels.
       *
       * A wall rises over the floor of the room *behind* it, and interior ones are
       * see-through now — so the tile you can see through a partition is the tile a
       * click there should give you. Claiming them for the near room measured worse
       * on both counts: it stole half of every tile behind a wall, and it stole the
       * tops of the very props this map exists to make clickable.
       */

      // The near walls, as a skirting: enough to read an edge, too short to stand
      // between the camera and the room. This is the cutaway, and it is also what
      // draws the frontier with the dark when the dark owns the boundary.
      for (const side of ['south', 'east'] as const) {
        if (edge(cx, cy, side) === '#') paintLip(ctx, cx, cy, side, colors);
      }

      for (const prop of propsByCell.get(cell) ?? []) {
        drawProp(ctx, prop.kind, prop.cx, prop.cy, {
          colors,
          long: prop.long,
          variant: prop.variant
        });
        // And the same prop as a claim on the screen it covers, so aiming at the
        // room across a wardrobe stops landing on the wardrobe's neighbour.
        stamp(cell, propQuad(prop));
      }

      paintMarkers(ctx, cx, cy, room, colors, cell);

      // Explored but out of sight: the room is remembered, not seen.
      if (room.seen === 'explored') {
        fillPolygon(ctx, diamond(cx, cy), 'rgb(4 5 9 / 0.5)');
        for (const side of ['north', 'west'] as const) {
          const code = edge(cx, cy, side);
          if (code === '#' || code === 'D' || code === 'W') dimWall(ctx, cx, cy, side);
        }
      }
    }
  }

  return scene;
}

/**
 * Roughly the screen a prop covers: its footprint, raised by its height. A box
 * rather than the prop's silhouette, which would need every painter to draw twice
 * for a precision nobody clicking a bin will ever notice.
 */
function propQuad(prop: PlacedProp): Vec2[] {
  const definition = propDef(prop.kind);
  const radius = definition?.radius ?? 0.2;
  const height = (definition?.height ?? 0.5) * TILE_H;
  const [n, e, s, w] = [
    project(prop.cx, prop.cy - radius),
    project(prop.cx + radius, prop.cy),
    project(prop.cx, prop.cy + radius),
    project(prop.cx - radius, prop.cy)
  ];
  return [s, e, { x: e.x, y: e.y - height }, { x: n.x, y: n.y - height }, { x: w.x, y: w.y - height }, w];
}

/**
 * Collapsed: masonry, a flooded lot, a crater. Nothing enters it and nothing sees
 * through it, so it is drawn as mass rather than as floor — a raised heap with a
 * hard edge, which is what tells a player at a glance that this is not a dark room
 * they have yet to visit but a place there is no point walking towards.
 */
function paintRubble(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  const shape = diamond(cx, cy);
  fillPolygon(ctx, shape, 'rgb(26 24 26)');

  // A low mound, so it reads as solid from the side.
  const lift = (point: Vec2, by: number): Vec2 => ({ x: point.x, y: point.y - by });
  const [n, e, s, w] = shape;
  fillPolygon(ctx, [w, s, lift(s, 7), lift(w, 7)], 'rgb(34 31 33)');
  fillPolygon(ctx, [s, e, lift(e, 7), lift(s, 7)], 'rgb(41 38 40)');
  fillPolygon(ctx, [lift(n, 7), lift(e, 7), lift(s, 7), lift(w, 7)], 'rgb(48 44 46)');

  // Broken slabs on top: deterministic from the cell, so it never shimmers.
  let noise = (cx * 73856093) ^ (cy * 19349663);
  const centre = project(cx, cy);
  for (let i = 0; i < 5; i++) {
    noise = (noise * 1103515245 + 12345) & 0x7fffffff;
    const u = (((noise >> 8) % 100) / 100 - 0.5) * TILE_W * 0.5;
    noise = (noise * 1103515245 + 12345) & 0x7fffffff;
    const v = (((noise >> 8) % 100) / 100 - 0.5) * TILE_H * 0.4;
    ctx.fillStyle = i % 2 === 0 ? 'rgb(58 54 56)' : 'rgb(38 35 37)';
    ctx.fillRect(centre.x + u, centre.y + v - 7, 5, 3);
  }
}

/** Unexplored: a hole in the floor plan you can still walk into. */
function paintVoid(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  const shape = diamond(cx, cy);
  fillPolygon(ctx, shape, 'rgb(9 10 14 / 0.92)');
  ctx.strokeStyle = 'rgb(120 130 150 / 0.1)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(shape[0].x, shape[0].y);
  for (const point of shape.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
}

/**
 * The same veil as the floor, over the wall that cell owns. `north` is the
 * boundary with `y - 1`, which is the diamond's top-right edge — see `wallEdge`
 * in art.ts, and do not trust intuition about which way "north" points here.
 */
function dimWall(ctx: CanvasRenderingContext2D, cx: number, cy: number, side: 'north' | 'west'): void {
  const [n, e, , w] = diamond(cx, cy);
  const [from, to] = side === 'north' ? [n, e] : [w, n];
  fillPolygon(
    ctx,
    [from, to, { x: to.x, y: to.y - WALL_H - 4 }, { x: from.x, y: from.y - WALL_H - 4 }],
    'rgb(4 5 9 / 0.5)'
  );
}

/**
 * What the room is *for*, drawn on its floor: the key still lying there, the
 * hole the horde climbs out of, the way out. These are rules, not decoration, so
 * they are loud on purpose.
 */
function paintMarkers(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  room: CzRoomView,
  colors: Palette,
  cell: number
): void {
  // Only on the room's anchor cell, or a 2×2 room would sprout four keys.
  if (cell !== room.cells[0]) return;

  if (room.kind === 'spawn') {
    paintGlow(ctx, cx, cy, 'rgb(229 72 77 / 0.3)', 0.9);
    const mark = sprite(czTerrain('spawn.png'));
    if (mark) drawFlat(ctx, mark, cx, cy, 0.7);
  }

  if (room.kind === 'exit') {
    paintGlow(ctx, cx, cy, 'rgb(63 185 80 / 0.32)', 1);
    ctx.fillStyle = 'rgb(63 185 80 / 0.85)';
    const at = project(cx, cy);
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('SORTIE', at.x, at.y + 4);
  }

  if (room.kind === 'start') {
    ctx.fillStyle = shade(colors.accent, -6);
    const at = project(cx, cy);
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('🏁', at.x, at.y + 4);
  }

  if (room.hasKey) {
    paintGlow(ctx, cx, cy, 'rgb(232 163 61 / 0.35)', 0.7);
    const key = sprite(czTerrain('key.png'));
    if (key) drawFlat(ctx, key, cx, cy, 0.5);
    else {
      const at = project(cx, cy);
      ctx.font = '14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('🔑', at.x, at.y + 5);
    }
  }
}

/** A sprite laid on the floor, sized in cells. */
function drawFlat(ctx: CanvasRenderingContext2D, image: HTMLImageElement, cx: number, cy: number, size: number): void {
  const at = project(cx, cy);
  const w = size * TILE_W;
  const h = (image.height / image.width) * w * 0.6;
  ctx.drawImage(image, at.x - w / 2, at.y - h / 2, w, h);
}
