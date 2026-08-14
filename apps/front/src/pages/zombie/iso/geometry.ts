/**
 * The projection, and the camera that looks through it.
 *
 * A high-angle isometric grid: one cell is a 64×44 diamond, walls stand 22 tall.
 * Three coordinate spaces, and every conversion between them lives here so
 * nothing else has to hold the trigonometry in its head:
 *
 * - **cell** — fractional grid coordinates. A prop half a cell to the left of a
 *   desk is at `cx - 0.5`, which is the whole reason these are floats.
 * - **world** — pixels in the flattened scene, origin at the centre of cell 0,0.
 *   The scene is drawn once in this space and never redrawn for a camera move.
 * - **screen** — pixels in the canvas, after the camera's pan and zoom.
 *
 * The ratio is the readability dial, and it was 2:1 (a 26° elevation) until a
 * playtest said the obvious thing: at that angle you see more wall than floor and
 * you cannot tell where you may walk. 64×44 is ~35°, which shows most of the
 * floor while a box still reads as a box — Fallout's angle, roughly. Everything
 * else in the renderer is expressed in these units, so this is the only place
 * that knows the number.
 */

export const TILE_W = 64;
export const TILE_H = 44;
/**
 * How tall a wall stands. Deliberately short: a wall's job here is to say where
 * a room ends, and every pixel above that is a pixel of floor it hides.
 */
export const WALL_H = 22;

export interface Vec2 {
  x: number;
  y: number;
}

export interface Camera {
  /** The world point held at the centre of the viewport. */
  x: number;
  y: number;
  zoom: number;
}

/** Cell (fractional) to world pixels: the centre of that spot on the floor. */
export function project(cx: number, cy: number): Vec2 {
  return { x: (cx - cy) * (TILE_W / 2), y: (cx + cy) * (TILE_H / 2) };
}

/** World pixels back to fractional cell coordinates. Ignores wall height. */
export function unproject(wx: number, wy: number): Vec2 {
  const a = wx / (TILE_W / 2);
  const b = wy / (TILE_H / 2);
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

/** The four corners of a cell's diamond, in world pixels, clockwise from north. */
export function diamond(cx: number, cy: number): [Vec2, Vec2, Vec2, Vec2] {
  const c = project(cx, cy);
  return [
    { x: c.x, y: c.y - TILE_H / 2 },
    { x: c.x + TILE_W / 2, y: c.y },
    { x: c.x, y: c.y + TILE_H / 2 },
    { x: c.x - TILE_W / 2, y: c.y }
  ];
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Everything the scene occupies in world pixels, wall tops included. */
export function boardBounds(width: number, height: number): Bounds {
  return {
    minX: -(height - 1) * (TILE_W / 2) - TILE_W / 2,
    maxX: (width - 1) * (TILE_W / 2) + TILE_W / 2,
    minY: -TILE_H / 2 - WALL_H,
    maxY: (width - 1 + height - 1) * (TILE_H / 2) + TILE_H / 2
  };
}

export function boundsSize(bounds: Bounds): Vec2 {
  return { x: bounds.maxX - bounds.minX, y: bounds.maxY - bounds.minY };
}

export function worldToScreen(world: Vec2, camera: Camera, viewport: Vec2): Vec2 {
  return {
    x: (world.x - camera.x) * camera.zoom + viewport.x / 2,
    y: (world.y - camera.y) * camera.zoom + viewport.y / 2
  };
}

export function screenToWorld(screen: Vec2, camera: Camera, viewport: Vec2): Vec2 {
  return {
    x: (screen.x - viewport.x / 2) / camera.zoom + camera.x,
    y: (screen.y - viewport.y / 2) / camera.zoom + camera.y
  };
}

/** The cell under a screen point, or null when the pointer is off the board. */
export function cellAtScreen(
  screen: Vec2,
  camera: Camera,
  viewport: Vec2,
  width: number,
  height: number
): { cx: number; cy: number; index: number } | null {
  const world = screenToWorld(screen, camera, viewport);
  const cell = unproject(world.x, world.y);
  const cx = Math.round(cell.x);
  const cy = Math.round(cell.y);
  if (cx < 0 || cy < 0 || cx >= width || cy >= height) return null;
  return { cx, cy, index: cy * width + cx };
}

export const ZOOM_MIN = 0.35;
export const ZOOM_MAX = 2.4;

export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/** The zoom at which the whole board fits the viewport, with a little air. */
export function fitZoom(viewport: Vec2, width: number, height: number, padding = 24): number {
  const size = boundsSize(boardBounds(width, height));
  if (size.x <= 0 || size.y <= 0 || viewport.x <= 0 || viewport.y <= 0) return 1;
  return clampZoom(Math.min((viewport.x - padding * 2) / size.x, (viewport.y - padding * 2) / size.y));
}

/** The world point at the middle of the board: the resting camera target. */
export function boardCentre(width: number, height: number): Vec2 {
  const bounds = boardBounds(width, height);
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

/**
 * Keeps the camera over the board. The slack is generous on purpose — being able
 * to drag a corner into the middle of the screen is worth more than a hard edge.
 */
export function clampCamera(camera: Camera, width: number, height: number): Camera {
  const bounds = boardBounds(width, height);
  const slackX = boundsSize(bounds).x * 0.25 + TILE_W;
  const slackY = boundsSize(bounds).y * 0.25 + TILE_H;
  return {
    zoom: camera.zoom,
    x: Math.min(bounds.maxX + slackX, Math.max(bounds.minX - slackX, camera.x)),
    y: Math.min(bounds.maxY + slackY, Math.max(bounds.minY - slackY, camera.y))
  };
}

/** Frame-rate independent easing toward a target: the TV's camera moves. */
export function approach(current: number, target: number, rate: number, dt: number): number {
  const factor = 1 - Math.exp(-rate * dt);
  return current + (target - current) * factor;
}
