import { isOutdoorProgram, type FloorKind, type RoomProgram } from 'coronaz-core';

import { diamond, project, TILE_H, TILE_W, WALL_H, type Vec2 } from './geometry';

/**
 * Paint. Palettes, isometric primitives, floors, walls — and the door through
 * which real artwork replaces any of it.
 *
 * Everything here can draw itself with nothing but a 2D context, because a raid
 * has to be playable before an artist has delivered anything. What ships is a
 * *slot*: ask for `desk` and you get the raster if one has been dropped into
 * `public/coronaz/iso/` and listed in its manifest, and a painted one if not. No
 * asset is ever a hole in the floor, and no code changes when the art lands.
 *
 * See docs/coronaz-art.md for the sizes and anchors a raster must respect.
 */

/* ------------------------------- raster slots ------------------------------ */

interface ArtManifest {
  /** Prop kind → file path, relative to /coronaz/iso/. */
  props?: Record<string, string>;
  /** Floor kind → seamless tile, drawn clipped to the cell diamond. */
  floors?: Record<string, string>;
  /** Wallpaper name → tile, drawn clipped to the wall quad. */
  walls?: Record<string, string>;
}

type SlotState = 'idle' | 'loading' | 'ready' | 'missing';

const images = new Map<string, { image: HTMLImageElement; state: SlotState }>();
let manifest: ArtManifest | null = null;
let manifestState: SlotState = 'idle';
const listeners = new Set<() => void>();

/** Called whenever a new asset lands, so a cached scene can be repainted. */
export function onArtLoaded(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce(): void {
  for (const listener of listeners) listener();
}

/**
 * Reads the manifest once. Absent (the normal case until art exists) means
 * everything paints itself, at the cost of exactly one failed request.
 */
export function loadArtManifest(): void {
  if (manifestState !== 'idle') return;
  manifestState = 'loading';
  fetch('/coronaz/iso/manifest.json')
    .then((response) => (response.ok ? (response.json() as Promise<ArtManifest>) : null))
    .then((parsed) => {
      manifest = parsed;
      manifestState = parsed ? 'ready' : 'missing';
      if (parsed) announce();
    })
    .catch(() => {
      manifestState = 'missing';
    });
}

/**
 * Any image by path, or null until it has arrived. Never throws and never
 * blocks: a caller draws its own version while this is null, and is called back
 * through `onArtLoaded` once the real thing is decoded.
 */
export function sprite(path: string): HTMLImageElement | null {
  const found = images.get(path);
  if (found) return found.state === 'ready' ? found.image : null;

  const image = new Image();
  const entry = { image, state: 'loading' as SlotState };
  images.set(path, entry);
  image.onload = () => {
    entry.state = 'ready';
    announce();
  };
  image.onerror = () => {
    entry.state = 'missing';
  };
  image.src = path;
  return null;
}

/** The raster for a manifest slot, if the artwork for it has been shipped. */
export function raster(group: keyof ArtManifest, key: string): HTMLImageElement | null {
  const file = manifest?.[group]?.[key];
  return file ? sprite(`/coronaz/iso/${file}`) : null;
}

/* --------------------------------- colour ---------------------------------- */

/** A room's colour scheme, derived from its zone tint and what it was for. */
export interface Palette {
  floor: string;
  floorAlt: string;
  floorLine: string;
  wall: string;
  wallTop: string;
  wallShade: string;
  wallpaper: string;
  accent: string;
}

export function hsl(h: number, s: number, l: number, a = 1): string {
  return a === 1 ? `hsl(${h} ${s}% ${l}%)` : `hsl(${h} ${s}% ${l}% / ${a})`;
}

/**
 * Floors carry the room's own character, walls carry the zone's.
 *
 * The saturation stays low across the board — it is night in an abandoned
 * building, and a fully saturated hue per room would turn the map into a
 * colour-blind test rather than a place. The zone tint is a *lean*, not a paint.
 */
const FLOOR_TONE: Record<FloorKind, { s: number; l: number; alt: number; line: number }> = {
  parquet: { s: 26, l: 24, alt: 4, line: -8 },
  carpet: { s: 18, l: 20, alt: 3, line: -4 },
  tile: { s: 10, l: 30, alt: 5, line: -14 },
  lino: { s: 12, l: 26, alt: 3, line: -6 },
  concrete: { s: 6, l: 23, alt: 3, line: -5 },
  grate: { s: 8, l: 18, alt: 6, line: -10 },
  /* Outside, at night. Cooler and darker than any room, so a doorway reads. */
  asphalt: { s: 4, l: 14, alt: 2, line: -4 },
  pavement: { s: 5, l: 20, alt: 3, line: -7 },
  gravel: { s: 8, l: 17, alt: 4, line: -5 },
  grass: { s: 22, l: 15, alt: 4, line: -4 },
  cobble: { s: 8, l: 18, alt: 4, line: -8 }
};

/**
 * Outdoors ignores the building tint and uses its own cold hue: a street at night
 * is not a coloured room, and having every exterior share one palette is what
 * makes the buildings read as separate places sitting in it.
 */
const NIGHT_HUE = 212;

export function palette(hue: number, floor: FloorKind, program: RoomProgram): Palette {
  const outside = isOutdoorProgram(program);
  const base = outside ? NIGHT_HUE : hue;
  const tone = FLOOR_TONE[floor];
  const wallHue = (base + 6) % 360;
  return {
    floor: hsl(base, tone.s, tone.l),
    floorAlt: hsl(base, tone.s, tone.l + tone.alt),
    floorLine: hsl(base, tone.s, Math.max(6, tone.l + tone.line)),
    wall: hsl(wallHue, 14, 31),
    wallTop: hsl(wallHue, 12, 40),
    wallShade: hsl(wallHue, 16, 22),
    wallpaper: hsl(wallHue, 20, 37),
    accent: hsl((base + 180) % 360, 45, 55),
    ...PROGRAM_TWEAK[program]
  };
}

/**
 * What a room is painted, by what it is for.
 *
 * Nearly every programme gets an entry now. With only a handful of them tweaked
 * the rest fell back to one neutral grey off the building's hue, and a corridor,
 * a bedroom and a storeroom came out identically — which is most of what made an
 * interior read as a hangar rather than as a building with rooms in it.
 */
const PROGRAM_TWEAK: Partial<Record<RoomProgram, Partial<Palette>>> = {
  /* Homes: warm. */
  living: { wall: hsl(28, 18, 32), wallTop: hsl(28, 15, 41), wallpaper: hsl(28, 22, 38) },
  bedroom: { wall: hsl(345, 14, 30), wallTop: hsl(345, 12, 39), wallpaper: hsl(345, 18, 36) },
  kitchen: { wall: hsl(40, 14, 36), wallTop: hsl(40, 12, 44), wallpaper: hsl(40, 16, 42) },
  bath: { wall: hsl(190, 12, 40), wallTop: hsl(190, 10, 48), wallpaper: hsl(190, 14, 46) },

  /* Work: cool and institutional. */
  office: { wall: hsl(210, 10, 33), wallTop: hsl(210, 9, 42), wallpaper: hsl(210, 12, 39) },
  archive: { wall: hsl(45, 10, 28), wallTop: hsl(45, 9, 36), wallpaper: hsl(45, 12, 33) },
  lab: { wall: hsl(170, 10, 36), wallTop: hsl(170, 9, 44), wallpaper: hsl(170, 12, 42) },
  server: { wall: hsl(200, 12, 26), wallTop: hsl(200, 10, 34), wallpaper: hsl(200, 14, 30) },
  workshop: { wall: hsl(30, 12, 26), wallTop: hsl(30, 10, 33), wallpaper: hsl(30, 12, 30) },
  storage: { wall: hsl(35, 8, 24), wallTop: hsl(35, 7, 32), wallpaper: hsl(35, 10, 28) },

  /* Public: louder. */
  lobby: { wall: hsl(200, 14, 34), wallTop: hsl(200, 12, 43), wallpaper: hsl(200, 16, 40) },
  corridor: { wall: hsl(220, 8, 29), wallTop: hsl(220, 7, 38), wallpaper: hsl(220, 10, 34) },
  hall: { wall: hsl(280, 14, 24), wallTop: hsl(280, 12, 32), wallpaper: hsl(280, 16, 28) },
  bar: { wall: hsl(330, 16, 26), wallTop: hsl(330, 14, 34), wallpaper: hsl(330, 18, 30) },
  restroom: { wall: hsl(190, 10, 36), wallTop: hsl(190, 9, 44), wallpaper: hsl(190, 12, 42) },
  backstage: { wall: hsl(300, 10, 22), wallTop: hsl(300, 9, 30), wallpaper: hsl(300, 12, 26) },
  dorm: { wall: hsl(215, 10, 30), wallTop: hsl(215, 9, 38), wallpaper: hsl(215, 12, 35) },
  canteen: { wall: hsl(55, 12, 32), wallTop: hsl(55, 10, 40), wallpaper: hsl(55, 14, 37) }
};

/** Lighten (positive) or darken (negative) any CSS colour the canvas accepts. */
export function shade(color: string, amount: number): string {
  // Works on the hsl() strings above without a parser: adjust the lightness.
  const match = /^hsl\((\d+(?:\.\d+)?) (\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%(?: \/ ([\d.]+))?\)$/.exec(color);
  if (!match) return color;
  const [, h, s, l, a] = match;
  const lightness = Math.min(100, Math.max(0, Number(l) + amount));
  return a === undefined ? `hsl(${h} ${s}% ${lightness}%)` : `hsl(${h} ${s}% ${lightness}% / ${a})`;
}

/* ----------------------------- iso primitives ------------------------------ */

function moveThrough(ctx: CanvasRenderingContext2D, points: Vec2[]): void {
  ctx.beginPath();
  const [first, ...rest] = points;
  if (!first) return;
  ctx.moveTo(first.x, first.y);
  for (const point of rest) ctx.lineTo(point.x, point.y);
  ctx.closePath();
}

export function fillPolygon(ctx: CanvasRenderingContext2D, points: Vec2[], color: string | CanvasGradient): void {
  moveThrough(ctx, points);
  ctx.fillStyle = color;
  ctx.fill();
}

export function clipPolygon(ctx: CanvasRenderingContext2D, points: Vec2[]): void {
  moveThrough(ctx, points);
  ctx.clip();
}

/**
 * A box standing on the floor, in cell units: `w` along +x, `d` along +y, `h`
 * straight up. Three faces, three shades of one colour — which is the whole
 * trick that makes a flat canvas read as three dimensions.
 */
export function isoBox(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: { w: number; d: number; h: number },
  color: string,
  options: { shadow?: boolean } = {}
): void {
  const half = { w: size.w / 2, d: size.d / 2 };
  const height = size.h * TILE_H;

  const corners = {
    n: project(cx - half.w, cy - half.d),
    e: project(cx + half.w, cy - half.d),
    s: project(cx + half.w, cy + half.d),
    w: project(cx - half.w, cy + half.d)
  };

  if (options.shadow !== false) {
    fillPolygon(
      ctx,
      [corners.n, corners.e, corners.s, corners.w].map((point) => ({
        x: point.x + 2,
        y: point.y + 3
      })),
      'rgb(0 0 0 / 0.28)'
    );
  }

  const lift = (point: Vec2): Vec2 => ({ x: point.x, y: point.y - height });

  // Right face (towards +x, catching the light), then the left face, then the top.
  fillPolygon(ctx, [corners.e, corners.s, lift(corners.s), lift(corners.e)], shade(color, -10));
  fillPolygon(ctx, [corners.s, corners.w, lift(corners.w), lift(corners.s)], shade(color, -20));
  fillPolygon(ctx, [lift(corners.n), lift(corners.e), lift(corners.s), lift(corners.w)], shade(color, 8));
}

/** A drum: bins, barrels, buckets. Two ellipses and a body. */
export function isoCylinder(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: { r: number; h: number },
  color: string
): void {
  const base = project(cx, cy);
  const rx = size.r * (TILE_W / 2);
  const ry = size.r * (TILE_H / 2);
  const height = size.h * TILE_H;

  ctx.fillStyle = 'rgb(0 0 0 / 0.26)';
  ctx.beginPath();
  ctx.ellipse(base.x + 2, base.y + 2, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = shade(color, -14);
  ctx.beginPath();
  ctx.moveTo(base.x - rx, base.y);
  ctx.lineTo(base.x - rx, base.y - height);
  ctx.ellipse(base.x, base.y - height, rx, ry, 0, Math.PI, 0, true);
  ctx.lineTo(base.x + rx, base.y);
  ctx.ellipse(base.x, base.y, rx, ry, 0, 0, Math.PI);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = shade(color, 10);
  ctx.beginPath();
  ctx.ellipse(base.x, base.y - height, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** Something flat on the floor: a rug, a stain, a hatch. */
export function isoPlate(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: { w: number; d: number },
  color: string
): void {
  const half = { w: size.w / 2, d: size.d / 2 };
  fillPolygon(
    ctx,
    [
      project(cx - half.w, cy - half.d),
      project(cx + half.w, cy - half.d),
      project(cx + half.w, cy + half.d),
      project(cx - half.w, cy + half.d)
    ],
    color
  );
}

/** A flat thing standing up and facing the camera: plants, signs, lamps. */
export function isoBillboard(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: { w: number; h: number },
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void
): void {
  const base = project(cx, cy);
  const w = size.w * TILE_W;
  const h = size.h * TILE_H;

  ctx.fillStyle = 'rgb(0 0 0 / 0.24)';
  ctx.beginPath();
  ctx.ellipse(base.x, base.y, w * 0.4, w * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.translate(base.x - w / 2, base.y - h);
  draw(ctx, w, h);
  ctx.restore();
}

/* ---------------------------------- floors --------------------------------- */

/**
 * One cell of floor: the diamond, then a pattern clipped inside it. The pattern
 * is what tells parquet from tiles at a glance, and it is why the floor kind
 * travels in the protocol rather than being rolled per client.
 */
export function paintFloor(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  colors: Palette,
  floor: FloorKind,
  seed: number
): void {
  const shape = diamond(cx, cy);
  const centre = project(cx, cy);
  const tile = raster('floors', floor);

  fillPolygon(ctx, shape, colors.floor);

  ctx.save();
  clipPolygon(ctx, shape);

  if (tile) {
    // A supplied tile is drawn to cover the cell's bounding box; the clip does
    // the rest, so a plain square texture is all an artist has to provide.
    ctx.drawImage(tile, centre.x - TILE_W / 2, centre.y - TILE_H / 2, TILE_W, TILE_H);
    ctx.restore();
    return;
  }

  ctx.lineWidth = 1;
  ctx.strokeStyle = colors.floorLine;

  if (floor === 'parquet') {
    // Planks run along one grid axis, alternating per cell like real parquet.
    const along = (cx + cy + seed) % 2 === 0;
    for (let i = -2; i <= 2; i++) {
      const a = along ? project(cx - 0.5, cy + i * 0.22) : project(cx + i * 0.22, cy - 0.5);
      const b = along ? project(cx + 0.5, cy + i * 0.22) : project(cx + i * 0.22, cy + 0.5);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  } else if (floor === 'tile') {
    for (let i = -1; i <= 1; i++) {
      for (const axis of [0, 1]) {
        const offset = i * 0.34;
        const a = axis === 0 ? project(cx + offset, cy - 0.5) : project(cx - 0.5, cy + offset);
        const b = axis === 0 ? project(cx + offset, cy + 0.5) : project(cx + 0.5, cy + offset);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
  } else if (floor === 'grate') {
    ctx.strokeStyle = shade(colors.floorLine, -4);
    for (let i = -3; i <= 3; i++) {
      const a = project(cx + i * 0.16, cy - 0.5);
      const b = project(cx + i * 0.16, cy + 0.5);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  } else if (floor === 'cobble') {
    // Setts, in staggered rows: the one outdoor surface with real geometry.
    ctx.fillStyle = colors.floorAlt;
    for (let row = -1; row <= 1; row++) {
      for (let i = -1; i <= 1; i++) {
        const u = i * 0.3 + (row % 2 === 0 ? 0.15 : 0);
        const point = project(cx + u, cy + row * 0.3);
        ctx.fillRect(point.x - 4, point.y - 2, 8, 4);
      }
    }
  } else if (floor === 'grass') {
    // Tufts, not a lawn: nobody has mown anything in a while.
    let noise = seed | 1;
    ctx.strokeStyle = shade(colors.floorAlt, 6);
    ctx.lineWidth = 1;
    for (let i = 0; i < 18; i++) {
      noise = (noise * 1103515245 + 12345) & 0x7fffffff;
      const u = ((noise >> 8) % 1000) / 1000 - 0.5;
      noise = (noise * 1103515245 + 12345) & 0x7fffffff;
      const v = ((noise >> 8) % 1000) / 1000 - 0.5;
      if (Math.abs(u) + Math.abs(v) > 0.44) continue;
      const point = project(cx + u, cy + v);
      ctx.beginPath();
      ctx.moveTo(point.x, point.y);
      ctx.lineTo(point.x + 1, point.y - 3);
      ctx.stroke();
    }
  } else if (floor === 'asphalt' || floor === 'pavement') {
    // Kerbs and cracks. The centre line is what makes a street read as a street,
    // and it only makes sense along the length of the road, so it follows the
    // room's own long axis.
    let noise = seed | 1;
    ctx.strokeStyle = colors.floorLine;
    ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      noise = (noise * 1103515245 + 12345) & 0x7fffffff;
      const u = ((noise >> 8) % 1000) / 1000 - 0.5;
      noise = (noise * 1103515245 + 12345) & 0x7fffffff;
      const v = ((noise >> 8) % 1000) / 1000 - 0.5;
      const a = project(cx + u * 0.7, cy + v * 0.7);
      const b = project(cx + u * 0.7 + 0.18, cy + v * 0.7 + 0.1);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    if (floor === 'pavement') {
      ctx.strokeStyle = shade(colors.floorLine, 5);
      for (const axis of [0, 1]) {
        const a = axis === 0 ? project(cx, cy - 0.5) : project(cx - 0.5, cy);
        const b = axis === 0 ? project(cx, cy + 0.5) : project(cx + 0.5, cy);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
  } else {
    // Carpet, lino, concrete, gravel: no geometry, just wear. Deterministic speckle.
    let noise = seed | 1;
    const dots = floor === 'carpet' ? 26 : floor === 'lino' ? 10 : floor === 'gravel' ? 30 : 14;
    ctx.fillStyle = floor === 'carpet' || floor === 'gravel' ? colors.floorAlt : colors.floorLine;
    for (let i = 0; i < dots; i++) {
      noise = (noise * 1103515245 + 12345) & 0x7fffffff;
      const u = ((noise >> 8) % 1000) / 1000 - 0.5;
      noise = (noise * 1103515245 + 12345) & 0x7fffffff;
      const v = ((noise >> 8) % 1000) / 1000 - 0.5;
      // Reject the corners so the speckle does not pile up along the clip.
      if (Math.abs(u) + Math.abs(v) > 0.46) continue;
      const point = project(cx + u, cy + v);
      const size = floor === 'concrete' ? 2.4 : 1.4;
      ctx.fillRect(point.x, point.y, size, size);
    }
  }

  ctx.restore();
}

/* ---------------------------------- walls ---------------------------------- */

export type Wallpaper = 'plain' | 'stripes' | 'panel' | 'tiles' | 'grime';

export const WALLPAPERS: readonly Wallpaper[] = ['plain', 'stripes', 'panel', 'tiles', 'grime'];

/**
 * Which two corners a boundary runs between, in world pixels.
 *
 * Worth stating carefully, because isometric axes are not screen axes: `+x` runs
 * down-right and `+y` runs down-left, so the `-y` neighbour is up-*right* and the
 * boundary with it is the diamond's top-RIGHT edge. Getting this pair backwards
 * draws every wall on the wrong side of its room, and looks plausible enough in a
 * screenshot to survive a glance.
 */
function wallEdge(cx: number, cy: number, side: 'north' | 'east' | 'south' | 'west'): [Vec2, Vec2] {
  const [n, e, s, w] = diamond(cx, cy);
  if (side === 'north') return [n, e]; // towards -y: up-right
  if (side === 'east') return [e, s]; // towards +x: down-right
  if (side === 'south') return [s, w]; // towards +y: down-left
  return [w, n]; // towards -x: up-left
}

/**
 * A wall standing on one edge of a cell.
 *
 * `side` is which boundary: `north` is the one shared with the cell at `y - 1`,
 * `west` with the cell at `x - 1`. Only those two are ever drawn full height —
 * the near walls would stand between the camera and the room, so the building is
 * cut away on the south and east and you always look *into* a room. It is the
 * oldest trick in isometric level art and the reason the map is readable at all.
 */
export function paintWall(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  side: 'north' | 'west',
  colors: Palette,
  options: { door?: boolean; window?: boolean; paper?: Wallpaper; height?: number; translucent?: boolean } = {}
): void {
  const height = (options.height ?? WALL_H) / TILE_H;
  const [from, to] = wallEdge(cx, cy, side);

  const lift = (point: Vec2, by: number): Vec2 => ({ x: point.x, y: point.y - by * TILE_H });

  /**
   * A partition you can see through.
   *
   * Interior walls are drawn at half opacity so a floor plan reads as a whole
   * from above — the complaint that started this was not being able to tell where
   * one could go. The skirting stays fully opaque underneath, because a wall you
   * can see through must still be unmistakably a wall: the eye needs one hard
   * line per boundary, and that line is the one on the floor.
   */
  if (options.translucent) {
    ctx.save();
    ctx.globalAlpha = 0.5;
    paintWall(ctx, cx, cy, side, colors, { ...options, translucent: false });
    ctx.restore();
    paintSkirting(ctx, from, to, colors, options.door ?? false);
    return;
  }

  const drawSlab = (a: Vec2, b: Vec2) => {
    const face = [a, b, lift(b, height), lift(a, height)];
    // The face away from the light is the north one: two shades, one wall.
    fillPolygon(ctx, face, side === 'north' ? colors.wallShade : colors.wall);

    ctx.save();
    clipPolygon(ctx, face);
    paintWallpaper(ctx, a, b, height, colors, options.paper ?? 'plain', side);
    ctx.restore();

    // The coping along the top: what actually sells the height.
    const cap = 3.5;
    fillPolygon(
      ctx,
      [
        lift(a, height),
        lift(b, height),
        { x: lift(b, height).x, y: lift(b, height).y - cap },
        { x: lift(a, height).x, y: lift(a, height).y - cap }
      ],
      colors.wallTop
    );
  };

  const lerp = (t: number): Vec2 => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });

  /**
   * A window: full wall, with a pane punched through the upper half.
   *
   * Drawn differently from a doorway on purpose, and the difference has to be legible
   * at a glance, because the two boundaries answer opposite questions. A door is a
   * gap you walk through, so it is drawn as an absence down to the floor. A window is
   * a wall you *cannot* walk through that you can nonetheless see and shoot through,
   * so the wall stays whole to the floor and the pane sits in it: glass, a frame, and
   * a bar across the middle.
   */
  if (options.window) {
    drawSlab(from, to);
    paintSkirting(ctx, from, to, colors, false);

    const sill = height * 0.34;
    const head = height * 0.84;
    const pane = [lift(lerp(0.22), sill), lift(lerp(0.78), sill), lift(lerp(0.78), head), lift(lerp(0.22), head)];
    // The glass: dark, because what is behind it is unlit, with a cold sheen on top.
    fillPolygon(ctx, pane, 'rgb(14 20 28 / 0.72)');
    fillPolygon(
      ctx,
      [pane[0], pane[1], lift(lerp(0.78), sill + (head - sill) * 0.4), lift(lerp(0.22), sill + (head - sill) * 0.4)],
      'rgb(150 190 215 / 0.22)'
    );

    ctx.strokeStyle = shade(colors.wallTop, 10);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(pane[0].x, pane[0].y);
    for (const point of pane.slice(1)) ctx.lineTo(point.x, point.y);
    ctx.closePath();
    ctx.stroke();

    // The mullion, which is what stops it reading as a dark rectangle.
    const midLow = lift(lerp(0.5), sill);
    const midHigh = lift(lerp(0.5), head);
    ctx.beginPath();
    ctx.moveTo(midLow.x, midLow.y);
    ctx.lineTo(midHigh.x, midHigh.y);
    ctx.stroke();
    return;
  }

  if (!options.door) {
    drawSlab(from, to);
    // A skirting under every wall, not only the see-through ones: it is the line
    // that makes a wall meet a floor instead of hovering over it.
    paintSkirting(ctx, from, to, colors, false);
    return;
  }

  // A doorway: wall, gap, wall, with a frame around the gap and a threshold on
  // the floor so the opening reads even when the far room is dark.
  drawSlab(from, lerp(0.3));
  drawSlab(lerp(0.7), to);

  const doorHeight = height * 0.78;
  fillPolygon(
    ctx,
    [lerp(0.3), lerp(0.7), lift(lerp(0.7), doorHeight), lift(lerp(0.3), doorHeight)],
    'rgb(6 6 8 / 0.55)'
  );
  ctx.strokeStyle = shade(colors.wallTop, 6);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(lerp(0.3).x, lerp(0.3).y);
  ctx.lineTo(lift(lerp(0.3), doorHeight).x, lift(lerp(0.3), doorHeight).y);
  ctx.lineTo(lift(lerp(0.7), doorHeight).x, lift(lerp(0.7), doorHeight).y);
  ctx.lineTo(lerp(0.7).x, lerp(0.7).y);
  ctx.stroke();
}

/**
 * The hard line at the foot of a see-through wall, gapped at the doorway. Four
 * pixels of opaque skirting is all it takes for a translucent partition to still
 * read as a boundary rather than as a smudge.
 */
function paintSkirting(ctx: CanvasRenderingContext2D, from: Vec2, to: Vec2, colors: Palette, door: boolean): void {
  const lerp = (t: number): Vec2 => ({
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t
  });
  const lift = (point: Vec2): Vec2 => ({ x: point.x, y: point.y - 4 });

  const spans: [number, number][] = door
    ? [
        [0, 0.3],
        [0.7, 1]
      ]
    : [[0, 1]];

  for (const [start, end] of spans) {
    const a = lerp(start);
    const b = lerp(end);
    fillPolygon(ctx, [a, b, lift(b), lift(a)], shade(colors.wallTop, -6));
  }
}

function paintWallpaper(
  ctx: CanvasRenderingContext2D,
  a: Vec2,
  b: Vec2,
  height: number,
  colors: Palette,
  paper: Wallpaper,
  side: 'north' | 'west'
): void {
  const tile = raster('walls', paper);
  if (tile) {
    const top = Math.min(a.y, b.y) - height * TILE_H;
    ctx.drawImage(tile, Math.min(a.x, b.x), top, Math.abs(b.x - a.x), height * TILE_H + TILE_H);
    return;
  }

  const lift = (point: Vec2, by: number): Vec2 => ({ x: point.x, y: point.y - by * TILE_H });
  const tint = side === 'north' ? shade(colors.wallpaper, -8) : colors.wallpaper;

  if (paper === 'stripes') {
    ctx.strokeStyle = shade(tint, 6);
    ctx.lineWidth = 2;
    for (let t = 0.1; t < 1; t += 0.2) {
      const foot = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      ctx.beginPath();
      ctx.moveTo(foot.x, foot.y);
      ctx.lineTo(lift(foot, height).x, lift(foot, height).y);
      ctx.stroke();
    }
  } else if (paper === 'panel') {
    // Wainscoting: a darker band at knee height, a lighter wall above it.
    const split = height * 0.42;
    fillPolygon(ctx, [a, b, lift(b, split), lift(a, split)], shade(tint, -7));
    ctx.strokeStyle = shade(tint, 10);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(lift(a, split).x, lift(a, split).y);
    ctx.lineTo(lift(b, split).x, lift(b, split).y);
    ctx.stroke();
  } else if (paper === 'tiles') {
    ctx.strokeStyle = shade(tint, -12);
    ctx.lineWidth = 1;
    for (let t = 0.15; t < 1; t += 0.22) {
      const foot = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      ctx.beginPath();
      ctx.moveTo(foot.x, foot.y);
      ctx.lineTo(lift(foot, height).x, lift(foot, height).y);
      ctx.stroke();
    }
    for (let level = 0.25; level < 1; level += 0.3) {
      const p = lift(a, height * level);
      const q = lift(b, height * level);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
    }
  } else if (paper === 'grime') {
    // Water damage: dark at the skirting, gone by the ceiling.
    const gradient = ctx.createLinearGradient(a.x, a.y, a.x, a.y - height * TILE_H);
    gradient.addColorStop(0, 'rgb(12 10 8 / 0.5)');
    gradient.addColorStop(1, 'rgb(12 10 8 / 0)');
    fillPolygon(ctx, [a, b, lift(b, height), lift(a, height)], gradient);
  }
}

/** The stub of wall on a near edge: enough to read a boundary, too short to hide anything. */
export function paintLip(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  side: 'south' | 'east',
  colors: Palette
): void {
  const [from, to] = wallEdge(cx, cy, side);
  const height = 6 / TILE_H;
  const lift = (point: Vec2): Vec2 => ({ x: point.x, y: point.y - height * TILE_H });
  fillPolygon(ctx, [from, to, lift(to), lift(from)], shade(colors.wall, -6));
  fillPolygon(
    ctx,
    [lift(from), lift(to), { x: lift(to).x, y: lift(to).y - 2 }, { x: lift(from).x, y: lift(from).y - 2 }],
    colors.wallTop
  );
}

/**
 * A mark on the floor where one space gives onto another.
 *
 * `seam` is an arch: two rooms, one volume, and a faint line is all that should
 * separate them. `door` is the loud one, and it is loud on purpose — a doorway is
 * the answer to "where can I go", so it is painted on the floor whether or not
 * the room happens to be playable this turn. Before this, an opening was only
 * visible as a gap in a wall, which from above is nearly nothing.
 */
export function paintThreshold(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  side: 'north' | 'west',
  colors: Palette,
  tone: 'seam' | 'door' = 'seam'
): void {
  const [from, to] = wallEdge(cx, cy, side);
  const lerp = (t: number): Vec2 => ({
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t
  });

  if (tone === 'seam') {
    /**
     * Where one room ends and the next begins with no wall between them.
     *
     * This used to be a whisper — three points of lightness on the floor — and it
     * was the single most confusing thing on the board: a move costs one action
     * point per *room*, so a player who cannot see where a room ends cannot tell
     * which tiles are one step away. Two tiles of the same open hall look exactly
     * like two tiles of different rooms. So the seam is now a threshold you can
     * actually see, and the room outlines on top of it do the rest.
     */
    const inward = TILE_H * 0.05;
    const band = (offset: number, colour: string) =>
      fillPolygon(
        ctx,
        [
          { x: from.x, y: from.y + offset },
          { x: to.x, y: to.y + offset },
          { x: to.x, y: to.y + offset + inward },
          { x: from.x, y: from.y + offset + inward }
        ],
        colour
      );
    band(-inward, shade(colors.floorLine, -6));
    band(0, shade(colors.wallTop, 4));
    return;
  }

  // Only under the gap itself, and reaching a little into both rooms: it should
  // look like light falling through the opening.
  const a = lerp(0.3);
  const b = lerp(0.7);
  const inward = TILE_H * 0.2;
  fillPolygon(
    ctx,
    [
      { x: a.x, y: a.y - inward * 0.5 },
      { x: b.x, y: b.y - inward * 0.5 },
      { x: b.x, y: b.y + inward },
      { x: a.x, y: a.y + inward }
    ],
    shade(colors.wallTop, 14)
  );
}

/**
 * A warm haze and a few specks, for a room that pays better than its neighbours.
 *
 * Deliberately painted on the *floor* rather than as an outline or a badge: an
 * outline reads as "this room is selected" and the map already uses outlines for
 * that, while a sheen on the ground reads as light coming off something worth
 * having. Strength tracks the bonus, so an armoury glows visibly harder than a
 * storage cupboard and the two are still telling the truth about their odds.
 */
export function paintGlint(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  bonus: number,
  seed: number
): void {
  const centre = project(cx, cy);
  const strength = Math.min(1, Math.max(0, (bonus - 0.25) / 0.75));

  const haze = ctx.createRadialGradient(centre.x, centre.y - TILE_H * 0.2, 0, centre.x, centre.y, TILE_W * 0.62);
  haze.addColorStop(0, `rgb(255 216 130 / ${(0.1 + strength * 0.16).toFixed(3)})`);
  haze.addColorStop(1, 'rgb(255 216 130 / 0)');
  ctx.save();
  ctx.beginPath();
  const shape = diamond(cx, cy);
  ctx.moveTo(shape[0].x, shape[0].y);
  for (const point of shape.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.closePath();
  ctx.clip();
  ctx.fillStyle = haze;
  ctx.fillRect(centre.x - TILE_W, centre.y - TILE_H, TILE_W * 2, TILE_H * 2);

  // Specks, positioned from the room's own seed so they do not crawl between
  // repaints: the scene is cached and re-blitted, and a glint that moved every
  // frame would read as a rendering fault rather than as treasure.
  const count = 2 + Math.round(strength * 3);
  for (let i = 0; i < count; i++) {
    const noise = (seed * 2654435761 + i * 40503) >>> 0;
    const u = ((noise % 1000) / 1000 - 0.5) * 0.7;
    const v = (((noise >>> 10) % 1000) / 1000 - 0.5) * 0.7;
    const at = project(cx + u, cy + v);
    ctx.fillStyle = `rgb(255 238 190 / ${(0.35 + strength * 0.4).toFixed(2)})`;
    const size = 1 + ((noise >>> 20) % 2);
    ctx.fillRect(at.x, at.y - 2, size, size);
  }
  ctx.restore();
}
