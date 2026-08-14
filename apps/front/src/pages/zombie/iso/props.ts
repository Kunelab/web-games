import type { RoomProgram } from 'coronaz-core';

import { fillPolygon, hsl, isoBillboard, isoBox, isoCylinder, isoPlate, raster, shade, type Palette } from './art';
import { project, TILE_H, TILE_W } from './geometry';

/**
 * The furniture catalogue.
 *
 * Every prop is a handful of isometric boxes, drums and plates, because that is
 * what a room is made of when you look at it from up here: a desk is a slab on
 * four legs, a bin is a drum, a bed is two boxes. Painting them from primitives
 * rather than shipping sprites means a prop tints to its room, scales to any zoom,
 * and costs nothing to add — and any of them can still be replaced by a raster the
 * moment one exists (see `raster` and docs/coronaz-art.md).
 *
 * `where` is the only placement rule the layout engine reads:
 * - `wall` wants its back against a boundary and is turned to face the room;
 * - `corner` wants two walls;
 * - `centre` wants the middle of a room with space to spare;
 * - `floor` goes anywhere, and is what makes a room look lived in.
 *
 * The quotas next to it are the rest of the sense: `maxPerRoom` stops five tables
 * appearing in one office, `maxPerZone` stops a building holding four fridges, and
 * `companions` is why a table arrives with chairs. Without those three the
 * furnishing is a bag of objects rather than a room.
 */

export type Placement = 'wall' | 'corner' | 'centre' | 'floor';

export interface PropContext {
  colors: Palette;
  /** Which grid axis the prop's long side runs along. */
  long: 'x' | 'y';
  /** 0–999, stable per prop instance: small deterministic variations. */
  variant: number;
}

export interface PropDef {
  kind: string;
  where: Placement;
  /** Rough radius in cells, for keeping props out of each other. */
  radius: number;
  /** Which rooms it belongs in, and how eagerly (roughly 1–14). */
  programs: Partial<Record<RoomProgram, number>>;
  /** At most this many in one room. One for anything big or unique. */
  maxPerRoom: number;
  /** At most this many in one building. Absent means no building-wide limit. */
  maxPerZone?: number;
  /** What comes with it, placed around it if there is room. */
  companions?: { kind: string; count: [number, number] }[];
  /** Clutter: allowed past the room's budget of distinct furniture families. */
  clutter?: boolean;
  draw: (ctx: CanvasRenderingContext2D, cx: number, cy: number, context: PropContext) => void;
}

/** Long/short helper: a prop's box, oriented along the axis it was placed on. */
function oriented(long: 'x' | 'y', size: { long: number; short: number; h: number }) {
  return long === 'x' ? { w: size.long, d: size.short, h: size.h } : { w: size.short, d: size.long, h: size.h };
}

const WOOD = hsl(28, 32, 34);
const DARK_WOOD = hsl(24, 30, 24);
const METAL = hsl(210, 8, 42);
const DARK_METAL = hsl(210, 10, 28);
const FABRIC = hsl(348, 22, 34);
const PORCELAIN = hsl(200, 12, 72);
const PLASTIC = hsl(120, 10, 38);
const RUST = hsl(18, 40, 30);

/** A desk, a table, a workbench: a slab, four legs, and whatever is on it. */
function slab(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  context: PropContext,
  size: { long: number; short: number; h: number },
  color: string
): void {
  const box = oriented(context.long, size);
  const legInset = 0.06;
  for (const [dx, dy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1]
  ] as const) {
    isoBox(
      ctx,
      cx + dx * (box.w / 2 - legInset),
      cy + dy * (box.d / 2 - legInset),
      { w: 0.06, d: 0.06, h: size.h * 0.9 },
      shade(color, -18),
      { shadow: false }
    );
  }
  isoBox(ctx, cx, cy, { w: box.w, d: box.d, h: 0.1 }, color);
  ctx.save();
  ctx.translate(0, -size.h * 0.9 * TILE_H);
  isoBox(ctx, cx, cy, { w: box.w, d: box.d, h: 0.08 }, shade(color, 4), { shadow: false });
  ctx.restore();
}

/** Deterministic noise for a prop's own details. */
function scatter(seed: number, count: number, spread: number): { u: number; v: number }[] {
  let noise = seed | 1;
  const out: { u: number; v: number }[] = [];
  for (let i = 0; i < count; i++) {
    noise = (noise * 1103515245 + 12345) & 0x7fffffff;
    const u = (((noise >> 8) % 1000) / 1000 - 0.5) * spread;
    noise = (noise * 1103515245 + 12345) & 0x7fffffff;
    const v = (((noise >> 8) % 1000) / 1000 - 0.5) * spread;
    out.push({ u, v });
  }
  return out;
}

export const PROPS: readonly PropDef[] = [
  /* ------------------------------- work rooms ------------------------------ */
  {
    kind: 'desk',
    where: 'wall',
    radius: 0.42,
    maxPerRoom: 2,
    programs: { office: 10, archive: 5, lab: 4, backstage: 4, server: 2, dorm: 2, living: 2 },
    companions: [{ kind: 'chair', count: [1, 1] }],
    draw: (ctx, cx, cy, context) => {
      slab(ctx, cx, cy, context, { long: 0.68, short: 0.34, h: 0.42 }, WOOD);
      ctx.save();
      ctx.translate(0, -0.42 * 0.9 * TILE_H);
      isoBox(ctx, cx, cy, { w: 0.22, d: 0.06, h: 0.22 }, DARK_METAL, { shadow: false });
      ctx.restore();
    }
  },
  {
    kind: 'workbench',
    where: 'wall',
    radius: 0.45,
    maxPerRoom: 2,
    programs: { workshop: 12, lab: 6, storage: 3, dock: 3 },
    draw: (ctx, cx, cy, context) => {
      slab(ctx, cx, cy, context, { long: 0.78, short: 0.36, h: 0.44 }, DARK_WOOD);
      ctx.save();
      ctx.translate(0, -0.44 * 0.9 * TILE_H);
      isoBox(ctx, cx + 0.2, cy, { w: 0.1, d: 0.1, h: 0.12 }, METAL, { shadow: false });
      isoBox(ctx, cx - 0.15, cy + 0.05, { w: 0.18, d: 0.04, h: 0.03 }, shade(METAL, 12), { shadow: false });
      ctx.restore();
    }
  },
  {
    kind: 'filecabinet',
    where: 'wall',
    radius: 0.3,
    maxPerRoom: 3,
    programs: { office: 9, archive: 9, lab: 3, backstage: 2 },
    draw: (ctx, cx, cy) => {
      isoBox(ctx, cx, cy, { w: 0.3, d: 0.26, h: 0.62 }, shade(METAL, -6));
      const front = project(cx + 0.15, cy);
      ctx.fillStyle = shade(METAL, 14);
      for (let i = 0; i < 3; i++) ctx.fillRect(front.x - 8, front.y - 12 - i * 6, 6, 2);
    }
  },
  {
    kind: 'printer',
    where: 'wall',
    radius: 0.24,
    maxPerRoom: 1,
    maxPerZone: 2,
    programs: { office: 7, archive: 5 },
    draw: (ctx, cx, cy) => {
      isoBox(ctx, cx, cy, { w: 0.3, d: 0.26, h: 0.3 }, hsl(210, 6, 56));
      ctx.save();
      ctx.translate(0, -0.3 * TILE_H);
      isoPlate(ctx, cx, cy, { w: 0.2, d: 0.16 }, hsl(45, 20, 88));
      ctx.restore();
    }
  },
  {
    kind: 'whiteboard',
    where: 'wall',
    radius: 0.34,
    maxPerRoom: 1,
    programs: { office: 7, lab: 8, workshop: 4, server: 3 },
    draw: (ctx, cx, cy, context) => {
      const box = oriented(context.long, { long: 0.6, short: 0.06, h: 0.5 });
      ctx.save();
      ctx.translate(0, -0.3 * TILE_H);
      isoBox(ctx, cx, cy, box, hsl(210, 8, 82), { shadow: false });
      ctx.restore();
    }
  },
  {
    kind: 'rack',
    where: 'wall',
    radius: 0.32,
    maxPerRoom: 3,
    programs: { server: 14, lab: 4, workshop: 3 },
    draw: (ctx, cx, cy, context) => {
      const box = oriented(context.long, { long: 0.34, short: 0.28, h: 0.94 });
      isoBox(ctx, cx, cy, box, hsl(210, 8, 18));
      // Dead status lights, and one that is somehow still blinking.
      const front = project(cx + 0.17, cy);
      for (let i = 0; i < 7; i++) {
        ctx.fillStyle = i === context.variant % 7 ? hsl(120, 60, 55) : hsl(210, 10, 30);
        ctx.fillRect(front.x - 9, front.y - 30 + i * 4, 5, 2);
      }
    }
  },

  /* ------------------------------ storage rooms ---------------------------- */
  {
    kind: 'shelf',
    where: 'wall',
    radius: 0.4,
    maxPerRoom: 3,
    programs: { archive: 12, storage: 10, office: 4, workshop: 4, lab: 4, bar: 4, kitchen: 4, server: 3 },
    draw: (ctx, cx, cy, context) => {
      const box = oriented(context.long, { long: 0.72, short: 0.22, h: 0.78 });
      isoBox(ctx, cx, cy, box, DARK_WOOD);
      ctx.save();
      for (const level of [0.28, 0.52]) {
        ctx.translate(0, -level * TILE_H);
        isoBox(ctx, cx, cy, { w: box.w * 0.94, d: box.d * 0.9, h: 0.04 }, shade(DARK_WOOD, 8), { shadow: false });
        ctx.translate(0, level * TILE_H);
      }
      ctx.restore();
    }
  },
  {
    kind: 'bookcase',
    where: 'wall',
    radius: 0.4,
    maxPerRoom: 2,
    programs: { archive: 10, living: 7, office: 5, bedroom: 4, lobby: 2 },
    draw: (ctx, cx, cy, context) => {
      const box = oriented(context.long, { long: 0.66, short: 0.2, h: 0.86 });
      isoBox(ctx, cx, cy, box, shade(DARK_WOOD, -4));
      let noise = context.variant | 1;
      ctx.save();
      for (const level of [0.24, 0.46, 0.68]) {
        const start = project(cx - box.w / 2 + 0.04, cy - box.d / 2);
        for (let i = 0; i < 8; i++) {
          noise = (noise * 1103515245 + 12345) & 0x7fffffff;
          ctx.fillStyle = hsl((noise >> 9) % 360, 30, 40);
          ctx.fillRect(start.x + i * 3.4, start.y - level * TILE_H - 8, 3, 8);
        }
      }
      ctx.restore();
    }
  },
  {
    kind: 'locker',
    where: 'wall',
    radius: 0.32,
    maxPerRoom: 3,
    programs: { storage: 8, workshop: 7, dorm: 8, restroom: 6, backstage: 6, corridor: 4, lab: 4 },
    draw: (ctx, cx, cy, context) => {
      const box = oriented(context.long, { long: 0.5, short: 0.24, h: 0.92 });
      isoBox(ctx, cx, cy, box, hsl(205, 16, 34));
      ctx.strokeStyle = 'rgb(0 0 0 / 0.35)';
      ctx.lineWidth = 1;
      const seam = project(cx, cy - box.d / 2);
      ctx.beginPath();
      ctx.moveTo(seam.x, seam.y);
      ctx.lineTo(seam.x, seam.y - box.h * TILE_H);
      ctx.stroke();
    }
  },
  {
    kind: 'crate',
    where: 'floor',
    radius: 0.24,
    maxPerRoom: 3,
    clutter: true,
    programs: { storage: 12, dock: 10, workshop: 8, alley: 6, backstage: 4, parking: 3, hall: 2 },
    draw: (ctx, cx, cy, context) => {
      isoBox(ctx, cx, cy, { w: 0.36, d: 0.36, h: 0.3 }, shade(WOOD, -8));
      if (context.variant % 3 !== 0) {
        ctx.save();
        ctx.translate(0, -0.3 * TILE_H);
        isoBox(ctx, cx + 0.04, cy - 0.03, { w: 0.28, d: 0.28, h: 0.24 }, shade(WOOD, -2), { shadow: false });
        ctx.restore();
      }
    }
  },
  {
    kind: 'boxpile',
    where: 'corner',
    radius: 0.3,
    maxPerRoom: 2,
    programs: { storage: 10, dock: 8, archive: 6, workshop: 5, alley: 4, corridor: 3 },
    draw: (ctx, cx, cy, context) => {
      isoBox(ctx, cx, cy, { w: 0.4, d: 0.4, h: 0.28 }, hsl(35, 26, 40));
      ctx.save();
      ctx.translate(0, -0.28 * TILE_H);
      isoBox(ctx, cx - 0.03, cy + 0.02, { w: 0.34, d: 0.34, h: 0.24 }, hsl(35, 24, 44), { shadow: false });
      ctx.translate(0, -0.24 * TILE_H);
      if (context.variant % 2 === 0) {
        isoBox(ctx, cx + 0.04, cy - 0.02, { w: 0.26, d: 0.26, h: 0.2 }, hsl(35, 22, 38), { shadow: false });
      }
      ctx.restore();
    }
  },
  {
    kind: 'pallet',
    where: 'floor',
    radius: 0.3,
    maxPerRoom: 2,
    clutter: true,
    programs: { storage: 8, dock: 10, workshop: 6 },
    draw: (ctx, cx, cy, context) => {
      const box = oriented(context.long, { long: 0.5, short: 0.4, h: 0.06 });
      isoBox(ctx, cx, cy, box, shade(WOOD, -14));
    }
  },
  {
    kind: 'barrel',
    where: 'floor',
    radius: 0.22,
    maxPerRoom: 3,
    clutter: true,
    programs: { workshop: 8, storage: 7, dock: 6, alley: 5, lab: 4 },
    draw: (ctx, cx, cy, context) =>
      isoCylinder(ctx, cx, cy, { r: 0.32, h: 0.5 }, context.variant % 2 === 0 ? RUST : hsl(95, 20, 30))
  },
  {
    kind: 'safe',
    where: 'corner',
    radius: 0.26,
    maxPerRoom: 1,
    maxPerZone: 1,
    programs: { office: 4, archive: 4, storage: 4, bar: 3 },
    draw: (ctx, cx, cy) => {
      isoBox(ctx, cx, cy, { w: 0.3, d: 0.3, h: 0.36 }, hsl(210, 6, 22));
      const front = project(cx + 0.15, cy);
      ctx.strokeStyle = hsl(45, 30, 55);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(front.x - 7, front.y - 12, 3.5, 4.5, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  },

  /* --------------------------------- homes --------------------------------- */
  {
    kind: 'bed',
    where: 'corner',
    radius: 0.5,
    maxPerRoom: 1,
    programs: { bedroom: 14, dorm: 10 },
    companions: [{ kind: 'nightstand', count: [1, 1] }],
    draw: (ctx, cx, cy, context) => {
      const frame = oriented(context.long, { long: 0.8, short: 0.5, h: 0.2 });
      isoBox(ctx, cx, cy, frame, DARK_WOOD);
      ctx.save();
      ctx.translate(0, -0.2 * TILE_H);
      isoBox(ctx, cx, cy, { w: frame.w * 0.94, d: frame.d * 0.9, h: 0.12 }, hsl(210, 12, 62), { shadow: false });
      isoBox(
        ctx,
        cx + (context.long === 'x' ? -frame.w / 2 + 0.14 : 0),
        cy + (context.long === 'x' ? 0 : -frame.d / 2 + 0.14),
        { w: 0.18, d: 0.18, h: 0.08 },
        hsl(200, 10, 78),
        { shadow: false }
      );
      ctx.restore();
    }
  },
  {
    kind: 'nightstand',
    where: 'floor',
    radius: 0.16,
    maxPerRoom: 2,
    programs: { bedroom: 4, dorm: 3 },
    draw: (ctx, cx, cy) => {
      isoBox(ctx, cx, cy, { w: 0.2, d: 0.2, h: 0.28 }, shade(WOOD, -6));
      ctx.save();
      ctx.translate(0, -0.28 * TILE_H);
      // A lamp nobody will switch on again.
      isoCylinder(ctx, cx, cy, { r: 0.1, h: 0.14 }, hsl(45, 25, 55));
      ctx.restore();
    }
  },
  {
    kind: 'wardrobe',
    where: 'wall',
    radius: 0.34,
    maxPerRoom: 1,
    programs: { bedroom: 10, dorm: 6, living: 3 },
    draw: (ctx, cx, cy, context) => {
      const box = oriented(context.long, { long: 0.5, short: 0.28, h: 1 });
      isoBox(ctx, cx, cy, box, shade(DARK_WOOD, 4));
      const front = project(cx, cy - box.d / 2);
      ctx.strokeStyle = 'rgb(0 0 0 / 0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(front.x, front.y);
      ctx.lineTo(front.x, front.y - box.h * TILE_H);
      ctx.stroke();
    }
  },
  {
    kind: 'sofa',
    where: 'wall',
    radius: 0.45,
    maxPerRoom: 1,
    programs: { living: 12, lobby: 10, backstage: 6, bar: 4, dorm: 3 },
    draw: (ctx, cx, cy, context) => {
      const seat = oriented(context.long, { long: 0.74, short: 0.36, h: 0.24 });
      isoBox(ctx, cx, cy, seat, FABRIC);
      const back = oriented(context.long, { long: 0.74, short: 0.1, h: 0.24 });
      ctx.save();
      ctx.translate(0, -0.24 * TILE_H);
      isoBox(
        ctx,
        cx + (context.long === 'x' ? 0 : -seat.w / 2 + 0.05),
        cy + (context.long === 'x' ? -seat.d / 2 + 0.05 : 0),
        back,
        shade(FABRIC, -8),
        { shadow: false }
      );
      ctx.restore();
    }
  },
  {
    kind: 'table',
    where: 'centre',
    radius: 0.5,
    maxPerRoom: 1,
    programs: { kitchen: 10, canteen: 12, living: 7, hall: 4, bar: 4, dorm: 3 },
    companions: [{ kind: 'chair', count: [2, 4] }],
    draw: (ctx, cx, cy, context) => slab(ctx, cx, cy, context, { long: 0.72, short: 0.5, h: 0.4 }, shade(WOOD, -4))
  },
  {
    kind: 'chair',
    where: 'floor',
    radius: 0.2,
    maxPerRoom: 4,
    programs: { office: 4, canteen: 4, kitchen: 3, living: 2, bar: 2, backstage: 2 },
    draw: (ctx, cx, cy, context) => {
      isoBox(ctx, cx, cy, { w: 0.26, d: 0.26, h: 0.26 }, shade(WOOD, -6));
      const back = oriented(context.long, { long: 0.26, short: 0.06, h: 0.3 });
      ctx.save();
      ctx.translate(0, -0.26 * TILE_H);
      isoBox(
        ctx,
        cx + (context.long === 'x' ? 0 : -0.1),
        cy + (context.long === 'x' ? -0.1 : 0),
        back,
        shade(WOOD, -12),
        { shadow: false }
      );
      ctx.restore();
    }
  },
  {
    kind: 'rug',
    where: 'centre',
    radius: 0.5,
    maxPerRoom: 1,
    programs: { living: 10, lobby: 8, bedroom: 8, office: 4, archive: 3 },
    draw: (ctx, cx, cy, context) => {
      const hue = (context.variant * 7) % 360;
      isoPlate(ctx, cx, cy, { w: 0.8, d: 0.6 }, hsl(hue, 22, 26));
      isoPlate(ctx, cx, cy, { w: 0.62, d: 0.44 }, hsl(hue, 26, 32));
    }
  },

  /* -------------------------------- kitchens ------------------------------- */
  {
    kind: 'counter',
    where: 'wall',
    radius: 0.45,
    maxPerRoom: 2,
    programs: { bar: 14, kitchen: 12, canteen: 8, lobby: 6, lab: 4 },
    draw: (ctx, cx, cy, context) => {
      const box = oriented(context.long, { long: 0.8, short: 0.32, h: 0.46 });
      isoBox(ctx, cx, cy, box, shade(WOOD, -10));
      ctx.save();
      ctx.translate(0, -0.46 * TILE_H);
      isoBox(ctx, cx, cy, { w: box.w, d: box.d, h: 0.05 }, PORCELAIN, { shadow: false });
      ctx.restore();
    }
  },
  {
    kind: 'stove',
    where: 'wall',
    radius: 0.3,
    maxPerRoom: 1,
    maxPerZone: 2,
    programs: { kitchen: 10, canteen: 8 },
    draw: (ctx, cx, cy) => {
      isoBox(ctx, cx, cy, { w: 0.36, d: 0.32, h: 0.44 }, shade(METAL, -4));
      ctx.save();
      ctx.translate(0, -0.44 * TILE_H);
      isoBox(ctx, cx, cy, { w: 0.36, d: 0.32, h: 0.04 }, DARK_METAL, { shadow: false });
      ctx.fillStyle = 'rgb(0 0 0 / 0.5)';
      for (const [dx, dy] of [
        [-0.08, -0.06],
        [0.08, -0.06],
        [-0.08, 0.06],
        [0.08, 0.06]
      ] as const) {
        const ring = project(cx + dx, cy + dy);
        ctx.beginPath();
        ctx.ellipse(ring.x, ring.y - 2, 4, 2, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  },
  {
    kind: 'fridge',
    where: 'corner',
    radius: 0.32,
    maxPerRoom: 1,
    maxPerZone: 2,
    programs: { kitchen: 9, canteen: 6, bar: 5, lab: 3 },
    draw: (ctx, cx, cy) => {
      isoBox(ctx, cx, cy, { w: 0.34, d: 0.32, h: 0.96 }, hsl(190, 6, 68));
      const front = project(cx + 0.17, cy);
      ctx.fillStyle = 'rgb(0 0 0 / 0.3)';
      ctx.fillRect(front.x - 9, front.y - 26, 2, 9);
    }
  },

  /* ---------------------------------- water -------------------------------- */
  {
    kind: 'sink',
    where: 'wall',
    radius: 0.24,
    maxPerRoom: 2,
    programs: { bath: 12, restroom: 10, kitchen: 6, lab: 5 },
    draw: (ctx, cx, cy) => {
      isoBox(ctx, cx, cy, { w: 0.28, d: 0.22, h: 0.4 }, PORCELAIN);
      ctx.save();
      ctx.translate(0, -0.4 * TILE_H);
      isoPlate(ctx, cx, cy, { w: 0.18, d: 0.14 }, shade(PORCELAIN, -22));
      ctx.restore();
    }
  },
  {
    kind: 'toilet',
    where: 'corner',
    radius: 0.22,
    maxPerRoom: 2,
    programs: { bath: 14, restroom: 12 },
    draw: (ctx, cx, cy) => {
      isoBox(ctx, cx, cy, { w: 0.22, d: 0.26, h: 0.24 }, PORCELAIN);
      ctx.save();
      ctx.translate(0, -0.24 * TILE_H);
      isoCylinder(ctx, cx, cy, { r: 0.16, h: 0.1 }, shade(PORCELAIN, -6));
      ctx.restore();
      isoBox(ctx, cx - 0.14, cy, { w: 0.08, d: 0.2, h: 0.46 }, shade(PORCELAIN, -4), { shadow: false });
    }
  },
  {
    kind: 'urinal',
    where: 'wall',
    radius: 0.18,
    maxPerRoom: 3,
    programs: { restroom: 10 },
    draw: (ctx, cx, cy) => {
      ctx.save();
      ctx.translate(0, -0.24 * TILE_H);
      isoBox(ctx, cx, cy, { w: 0.16, d: 0.14, h: 0.3 }, PORCELAIN, { shadow: false });
      ctx.restore();
    }
  },
  {
    kind: 'bathtub',
    where: 'wall',
    radius: 0.45,
    maxPerRoom: 1,
    maxPerZone: 2,
    programs: { bath: 9 },
    draw: (ctx, cx, cy, context) => {
      const box = oriented(context.long, { long: 0.72, short: 0.38, h: 0.3 });
      isoBox(ctx, cx, cy, box, PORCELAIN);
      ctx.save();
      ctx.translate(0, -0.3 * TILE_H);
      isoPlate(ctx, cx, cy, { w: box.w * 0.8, d: box.d * 0.7 }, shade(PORCELAIN, -26));
      ctx.restore();
    }
  },

  /* --------------------------------- public -------------------------------- */
  {
    kind: 'decks',
    where: 'wall',
    radius: 0.3,
    maxPerRoom: 1,
    maxPerZone: 1,
    programs: { hall: 12, backstage: 4 },
    draw: (ctx, cx, cy, context) => {
      const box = oriented(context.long, { long: 0.5, short: 0.3, h: 0.4 });
      isoBox(ctx, cx, cy, box, hsl(210, 8, 20));
      ctx.save();
      ctx.translate(0, -0.4 * TILE_H);
      isoBox(ctx, cx, cy, { w: box.w, d: box.d, h: 0.05 }, hsl(210, 6, 30), { shadow: false });
      for (const dx of [-0.1, 0.1]) {
        const platter = project(cx + dx, cy);
        ctx.fillStyle = hsl(0, 0, 12);
        ctx.beginPath();
        ctx.ellipse(platter.x, platter.y - 2, 6, 3, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  },
  {
    kind: 'vending',
    where: 'wall',
    radius: 0.3,
    maxPerRoom: 1,
    maxPerZone: 2,
    programs: { corridor: 7, lobby: 8, canteen: 8, hall: 4, parking: 3, dock: 3 },
    draw: (ctx, cx, cy) => {
      isoBox(ctx, cx, cy, { w: 0.34, d: 0.28, h: 0.9 }, hsl(0, 40, 32));
      const front = project(cx + 0.17, cy);
      ctx.fillStyle = 'rgb(120 190 220 / 0.35)';
      ctx.fillRect(front.x - 11, front.y - 26, 9, 17);
    }
  },
  {
    kind: 'radiator',
    where: 'wall',
    radius: 0.26,
    maxPerRoom: 2,
    clutter: true,
    programs: { corridor: 8, office: 6, bath: 6, bedroom: 6, living: 5, dorm: 5, archive: 4, lobby: 4, restroom: 4 },
    draw: (ctx, cx, cy, context) => {
      const box = oriented(context.long, { long: 0.44, short: 0.1, h: 0.28 });
      isoBox(ctx, cx, cy, box, shade(PORCELAIN, -14));
    }
  },
  {
    kind: 'plant',
    where: 'floor',
    radius: 0.2,
    maxPerRoom: 2,
    clutter: true,
    programs: { lobby: 10, yard: 9, office: 7, corridor: 6, living: 6, hall: 4, bedroom: 4, archive: 3 },
    draw: (ctx, cx, cy, context) => {
      isoCylinder(ctx, cx, cy, { r: 0.2, h: 0.16 }, hsl(20, 30, 34));
      const alive = context.variant % 3 !== 0;
      isoBillboard(ctx, cx, cy, { w: 0.42, h: 0.9 }, (paint, w, h) => {
        paint.fillStyle = alive ? hsl(120, 24, 30) : hsl(35, 18, 28);
        for (let i = 0; i < 6; i++) {
          const angle = (i / 6) * Math.PI - Math.PI / 2;
          paint.beginPath();
          paint.moveTo(w / 2, h);
          paint.quadraticCurveTo(
            w / 2 + Math.cos(angle) * w * 0.5,
            h * 0.35,
            w / 2 + Math.cos(angle) * w * 0.42,
            h * 0.08 + (i % 2) * h * 0.12
          );
          paint.lineWidth = 2.5;
          paint.strokeStyle = paint.fillStyle;
          paint.stroke();
        }
      });
    }
  },
  {
    kind: 'trolley',
    where: 'floor',
    radius: 0.24,
    maxPerRoom: 1,
    clutter: true,
    programs: { lab: 7, dock: 6, canteen: 5, kitchen: 5, storage: 5, corridor: 4 },
    draw: (ctx, cx, cy, context) => {
      const box = oriented(context.long, { long: 0.4, short: 0.28, h: 0.06 });
      isoBox(ctx, cx, cy, { w: 0.04, d: 0.04, h: 0.3 }, DARK_METAL, { shadow: false });
      ctx.save();
      ctx.translate(0, -0.3 * TILE_H);
      isoBox(ctx, cx, cy, box, METAL, { shadow: false });
      ctx.restore();
      ctx.save();
      ctx.translate(0, -0.14 * TILE_H);
      isoBox(ctx, cx, cy, box, shade(METAL, -8), { shadow: false });
      ctx.restore();
    }
  },
  {
    kind: 'cot',
    where: 'wall',
    radius: 0.4,
    maxPerRoom: 2,
    programs: { dorm: 10, backstage: 4, storage: 3, lab: 3 },
    draw: (ctx, cx, cy, context) => {
      const frame = oriented(context.long, { long: 0.66, short: 0.34, h: 0.26 });
      isoBox(ctx, cx, cy, frame, shade(METAL, -10));
      ctx.save();
      ctx.translate(0, -0.26 * TILE_H);
      isoBox(ctx, cx, cy, { w: frame.w * 0.9, d: frame.d * 0.85, h: 0.06 }, hsl(35, 14, 52), { shadow: false });
      ctx.restore();
    }
  },
  {
    kind: 'pipes',
    where: 'wall',
    radius: 0.2,
    maxPerRoom: 2,
    clutter: true,
    programs: { server: 6, workshop: 6, storage: 4, dock: 4, restroom: 3 },
    draw: (ctx, cx, cy, context) => {
      const along = context.long === 'x';
      ctx.save();
      ctx.translate(0, -0.5 * TILE_H);
      isoBox(ctx, cx, cy, along ? { w: 0.7, d: 0.08, h: 0.08 } : { w: 0.08, d: 0.7, h: 0.08 }, shade(RUST, 6), {
        shadow: false
      });
      ctx.restore();
    }
  },

  /* -------------------------------- outdoors ------------------------------- */
  {
    kind: 'car',
    where: 'floor',
    radius: 0.45,
    maxPerRoom: 1,
    programs: { street: 9, parking: 14, alley: 4, yard: 3 },
    draw: (ctx, cx, cy, context) => {
      const hue = [0, 30, 210, 0, 120, 45][context.variant % 6] ?? 0;
      const body = oriented(context.long, { long: 0.86, short: 0.44, h: 0.26 });
      const paint = context.variant % 5 === 0 ? hsl(0, 0, 28) : hsl(hue, 32, 34);
      isoBox(ctx, cx, cy, body, paint);
      // Cabin, set back a little so the thing reads as a car and not a skip.
      ctx.save();
      ctx.translate(0, -0.26 * TILE_H);
      isoBox(
        ctx,
        cx + (context.long === 'x' ? -0.06 : 0),
        cy + (context.long === 'x' ? 0 : -0.06),
        oriented(context.long, { long: 0.42, short: 0.4, h: 0.2 }),
        shade(paint, -6),
        { shadow: false }
      );
      ctx.restore();
      // Windscreen glint.
      const glass = project(cx, cy);
      ctx.fillStyle = 'rgb(150 200 230 / 0.35)';
      ctx.fillRect(glass.x - 6, glass.y - 22, 12, 4);
    }
  },
  {
    kind: 'dumpster',
    where: 'wall',
    radius: 0.34,
    maxPerRoom: 1,
    programs: { alley: 12, parking: 6, street: 4, dock: 6, yard: 4 },
    draw: (ctx, cx, cy, context) => {
      const box = oriented(context.long, { long: 0.6, short: 0.36, h: 0.42 });
      isoBox(ctx, cx, cy, box, hsl(140, 22, 26));
      ctx.save();
      ctx.translate(0, -0.42 * TILE_H);
      // Lid, half open, because of course it is.
      isoPlate(ctx, cx, cy, { w: box.w * 0.9, d: box.d * 0.8 }, hsl(140, 18, 20));
      ctx.restore();
    }
  },
  {
    kind: 'lamppost',
    where: 'floor',
    radius: 0.16,
    maxPerRoom: 1,
    programs: { street: 12, crossing: 10, parking: 6, yard: 4, alley: 3 },
    draw: (ctx, cx, cy) => {
      isoBox(ctx, cx, cy, { w: 0.1, d: 0.1, h: 1.5 }, shade(DARK_METAL, -4));
      ctx.save();
      ctx.translate(0, -1.5 * TILE_H);
      isoBox(ctx, cx, cy, { w: 0.26, d: 0.14, h: 0.08 }, shade(METAL, 8), { shadow: false });
      // The one light still working on this street.
      const head = project(cx, cy);
      const glow = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, 26);
      glow.addColorStop(0, 'rgb(255 226 150 / 0.28)');
      glow.addColorStop(1, 'rgb(255 226 150 / 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(head.x - 26, head.y - 26, 52, 52);
      ctx.restore();
    }
  },
  {
    kind: 'bench',
    where: 'wall',
    radius: 0.3,
    maxPerRoom: 1,
    programs: { yard: 10, street: 6, parking: 3 },
    draw: (ctx, cx, cy, context) => {
      const seat = oriented(context.long, { long: 0.6, short: 0.2, h: 0.22 });
      isoBox(ctx, cx, cy, seat, shade(WOOD, -12));
    }
  },
  {
    kind: 'planter',
    where: 'floor',
    radius: 0.24,
    maxPerRoom: 2,
    clutter: true,
    programs: { yard: 9, street: 6, crossing: 5, parking: 3 },
    draw: (ctx, cx, cy, context) => {
      isoBox(ctx, cx, cy, { w: 0.42, d: 0.32, h: 0.2 }, hsl(25, 18, 34));
      ctx.save();
      ctx.translate(0, -0.2 * TILE_H);
      isoPlate(ctx, cx, cy, { w: 0.34, d: 0.24 }, hsl(110, 20, 22));
      for (const spot of scatter(context.variant, 5, 0.3)) {
        const at = project(cx + spot.u, cy + spot.v);
        ctx.strokeStyle = hsl(110, 26, 30);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(at.x, at.y);
        ctx.lineTo(at.x + 1, at.y - 6);
        ctx.stroke();
      }
      ctx.restore();
    }
  },
  {
    kind: 'fence',
    where: 'wall',
    radius: 0.3,
    maxPerRoom: 2,
    programs: { yard: 12, parking: 8, dock: 6, alley: 4 },
    draw: (ctx, cx, cy, context) => {
      const along = context.long === 'x';
      // Posts and rails, the width of the cell: what tells a garden from a street.
      for (const t of [-0.35, 0, 0.35]) {
        isoBox(ctx, cx + (along ? t : 0), cy + (along ? 0 : t), { w: 0.06, d: 0.06, h: 0.5 }, shade(METAL, -14), {
          shadow: false
        });
      }
      ctx.save();
      ctx.translate(0, -0.42 * TILE_H);
      isoBox(ctx, cx, cy, along ? { w: 0.8, d: 0.04, h: 0.04 } : { w: 0.04, d: 0.8, h: 0.04 }, shade(METAL, -8), {
        shadow: false
      });
      ctx.restore();
    }
  },
  {
    kind: 'barricade',
    where: 'floor',
    radius: 0.28,
    maxPerRoom: 1,
    programs: { street: 8, crossing: 8, alley: 6, dock: 4 },
    draw: (ctx, cx, cy, context) => {
      const along = context.long === 'x';
      ctx.save();
      ctx.translate(0, -0.18 * TILE_H);
      isoBox(ctx, cx, cy, along ? { w: 0.66, d: 0.08, h: 0.1 } : { w: 0.08, d: 0.66, h: 0.1 }, hsl(40, 60, 45), {
        shadow: false
      });
      ctx.restore();
      for (const t of [-0.25, 0.25]) {
        isoBox(ctx, cx + (along ? t : 0), cy + (along ? 0 : t), { w: 0.05, d: 0.05, h: 0.2 }, hsl(0, 0, 30), {
          shadow: false
        });
      }
    }
  },
  {
    kind: 'bollard',
    where: 'floor',
    radius: 0.12,
    maxPerRoom: 3,
    clutter: true,
    programs: { street: 6, crossing: 6, parking: 5, dock: 4 },
    draw: (ctx, cx, cy) => isoCylinder(ctx, cx, cy, { r: 0.12, h: 0.3 }, hsl(0, 0, 34))
  },
  {
    kind: 'hydrant',
    where: 'floor',
    radius: 0.14,
    maxPerRoom: 1,
    clutter: true,
    programs: { street: 7, crossing: 5, alley: 4 },
    draw: (ctx, cx, cy) => {
      isoCylinder(ctx, cx, cy, { r: 0.14, h: 0.3 }, hsl(0, 45, 40));
      ctx.save();
      ctx.translate(0, -0.3 * TILE_H);
      isoCylinder(ctx, cx, cy, { r: 0.09, h: 0.08 }, hsl(0, 40, 32));
      ctx.restore();
    }
  },
  {
    kind: 'streetsign',
    where: 'floor',
    radius: 0.14,
    maxPerRoom: 1,
    programs: { crossing: 12, street: 5 },
    draw: (ctx, cx, cy, context) => {
      isoBox(ctx, cx, cy, { w: 0.06, d: 0.06, h: 0.9 }, shade(METAL, -10));
      ctx.save();
      ctx.translate(0, -0.9 * TILE_H);
      isoBox(
        ctx,
        cx,
        cy,
        context.long === 'x' ? { w: 0.34, d: 0.04, h: 0.12 } : { w: 0.04, d: 0.34, h: 0.12 },
        hsl(205, 30, 42),
        { shadow: false }
      );
      ctx.restore();
    }
  },

  /* -------------------------------- the mess ------------------------------- */
  {
    kind: 'bin',
    where: 'floor',
    radius: 0.18,
    maxPerRoom: 2,
    clutter: true,
    programs: {
      office: 9,
      kitchen: 8,
      corridor: 8,
      restroom: 7,
      lobby: 6,
      bath: 6,
      street: 6,
      alley: 6,
      lab: 5,
      workshop: 5,
      canteen: 5,
      bar: 5,
      archive: 4,
      storage: 4,
      bedroom: 3,
      dorm: 3,
      hall: 3,
      backstage: 3,
      yard: 3,
      parking: 3
    },
    draw: (ctx, cx, cy, context) => {
      isoCylinder(ctx, cx, cy, { r: 0.26, h: 0.34 }, context.variant % 3 === 0 ? PLASTIC : DARK_METAL);
      if (context.variant % 2 === 0) {
        ctx.save();
        ctx.translate(0, -0.34 * TILE_H);
        isoPlate(ctx, cx, cy, { w: 0.18, d: 0.14 }, hsl(45, 18, 62));
        ctx.restore();
      }
    }
  },
  {
    kind: 'papers',
    where: 'floor',
    radius: 0.12,
    maxPerRoom: 3,
    clutter: true,
    programs: {
      archive: 12,
      office: 10,
      lab: 6,
      corridor: 6,
      street: 5,
      lobby: 4,
      storage: 4,
      workshop: 4,
      alley: 4,
      hall: 4,
      backstage: 4,
      bedroom: 3,
      kitchen: 3,
      canteen: 3,
      dorm: 3,
      bar: 3,
      bath: 2,
      restroom: 2,
      yard: 2,
      parking: 2,
      dock: 3,
      server: 3,
      crossing: 2
    },
    draw: (ctx, cx, cy, context) => {
      scatter(context.variant, 5, 0.3).forEach((spot, i) => {
        isoPlate(ctx, cx + spot.u, cy + spot.v, { w: 0.12, d: 0.1 }, hsl(45, 16, 74 - i * 3));
      });
    }
  },
  {
    kind: 'blood',
    where: 'floor',
    radius: 0.16,
    maxPerRoom: 2,
    clutter: true,
    programs: {
      corridor: 8,
      bath: 6,
      lab: 6,
      restroom: 5,
      kitchen: 5,
      lobby: 5,
      hall: 5,
      street: 5,
      alley: 5,
      office: 4,
      storage: 4,
      workshop: 4,
      bedroom: 4,
      dorm: 4,
      bar: 4,
      backstage: 4,
      archive: 3,
      canteen: 3,
      yard: 3,
      parking: 3,
      dock: 3,
      crossing: 3,
      server: 2,
      living: 4
    },
    draw: (ctx, cx, cy, context) => {
      const centre = project(cx, cy);
      ctx.fillStyle = 'rgb(96 14 16 / 0.55)';
      let noise = context.variant | 1;
      for (let i = 0; i < 4; i++) {
        noise = (noise * 1103515245 + 12345) & 0x7fffffff;
        const dx = (((noise >> 8) % 100) / 100 - 0.5) * 22;
        noise = (noise * 1103515245 + 12345) & 0x7fffffff;
        const dy = (((noise >> 8) % 100) / 100 - 0.5) * 11;
        noise = (noise * 1103515245 + 12345) & 0x7fffffff;
        const r = 3 + ((noise >> 8) % 60) / 10;
        ctx.beginPath();
        ctx.ellipse(centre.x + dx, centre.y + dy, r, r / 2, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
];

const byKind = new Map(PROPS.map((prop) => [prop.kind, prop]));

export function propDef(kind: string): PropDef | undefined {
  return byKind.get(kind);
}

/**
 * Draws one prop, raster first. A supplied image is anchored at the *bottom
 * centre* of the cell position, which is where a prop's feet are; anything else
 * would need per-prop metadata for no gain.
 */
export function drawProp(
  ctx: CanvasRenderingContext2D,
  kind: string,
  cx: number,
  cy: number,
  context: PropContext
): void {
  const image = raster('props', kind);
  if (image) {
    const at = project(cx, cy);
    const scale = TILE_W / image.width;
    const w = image.width * scale;
    const h = image.height * scale;
    ctx.drawImage(image, at.x - w / 2, at.y + TILE_H / 4 - h, w, h);
    return;
  }
  byKind.get(kind)?.draw(ctx, cx, cy, context);
}

/** A hatch of light under a doorway or on a spawn room: cheap atmosphere. */
export function paintGlow(ctx: CanvasRenderingContext2D, cx: number, cy: number, color: string, radius = 0.7): void {
  const at = project(cx, cy);
  const gradient = ctx.createRadialGradient(at.x, at.y, 0, at.x, at.y, radius * TILE_W);
  gradient.addColorStop(0, color);
  gradient.addColorStop(1, 'rgb(0 0 0 / 0)');
  fillPolygon(
    ctx,
    [
      { x: at.x - radius * TILE_W, y: at.y - radius * TILE_W },
      { x: at.x + radius * TILE_W, y: at.y - radius * TILE_W },
      { x: at.x + radius * TILE_W, y: at.y + radius * TILE_W },
      { x: at.x - radius * TILE_W, y: at.y + radius * TILE_W }
    ],
    gradient
  );
}
