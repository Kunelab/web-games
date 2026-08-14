import type { CzRoomView, CzView } from 'coronaz-core';

import {
  fillPolygon,
  paintFloor,
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
import { drawProp, paintGlow } from './props';

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
  /** World coordinates of the canvas's top-left pixel. */
  origin: Vec2;
  /** What this scene was drawn from; a different signature needs a redraw. */
  signature: string;
}

/**
 * Everything the painting depends on, as a short string. Room contents, fog and
 * geometry are in; anything that moves (creatures, heroes, clocks) is not, which
 * is why the scene survives most state broadcasts untouched.
 */
export function sceneSignature(view: CzView): string {
  const rooms = view.rooms
    .map((room) => `${room.id}:${room.seen[0]}:${room.kind[0]}:${room.hasKey ? 1 : 0}:${room.decor}`)
    .join(',');
  return `${view.width}x${view.height}|${view.edgeRight}|${view.edgeDown}|${rooms}`;
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
  if (!ctx) return { canvas, origin, signature: sceneSignature(view) };

  ctx.scale(devicePixelRatio, devicePixelRatio);
  ctx.translate(-origin.x, -origin.y);

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
      if (!room) continue;

      if (room.seen === 'hidden') {
        paintVoid(ctx, cx, cy);
        continue;
      }

      const colors = paletteOf(room);
      const decor = decorByRoom.get(room.id);

      paintFloor(ctx, cx, cy, colors, room.floor, room.decor + cell);

      if (room.kind === 'fungus') {
        const creep = sprite('/coronaz/terrain/creep.png');
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
        } else if (code === 'A') paintThreshold(ctx, cx, cy, side, colors, 'seam');
      }

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
      }

      paintMarkers(ctx, cx, cy, room, colors, cell);

      // Explored but out of sight: the room is remembered, not seen.
      if (room.seen === 'explored') {
        fillPolygon(ctx, diamond(cx, cy), 'rgb(4 5 9 / 0.5)');
        for (const side of ['north', 'west'] as const) {
          const code = edge(cx, cy, side);
          if (code === '#' || code === 'D') dimWall(ctx, cx, cy, side);
        }
      }
    }
  }

  return { canvas, origin, signature: sceneSignature(view) };
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
    const mark = sprite('/coronaz/terrain/spawn.png');
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
    const key = sprite('/coronaz/terrain/key.png');
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
