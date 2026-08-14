import { chance, pick, randInt, seedRng, shuffled, type CzRoomView, type RngState } from 'coronaz-core';

import { WALLPAPERS, type Wallpaper } from './art';
import { PROPS, propDef, type Placement, type PropDef } from './props';

/**
 * Furnishing, as a pure function of the rooms.
 *
 * The server rolls one number per room (`decor`) and every client turns it into the
 * same desks, bins and wallpaper. That is the whole design: the protocol pays four
 * bytes, the television and three phones agree on where the furniture is, and a
 * seed reproduces the building down to which bin is overflowing.
 *
 * What changed after the first playtest is *discipline*. Placement was
 * rule-driven but unbounded, and the result was five tables in a room, no chairs
 * anywhere near them, and three fridges in one building. So now:
 *
 * - a **building** is furnished as one job, not room by room, because "one fridge
 *   per building" is not a question a single room can answer;
 * - every prop has a ceiling per room *and* per building (`maxPerRoom`, `maxPerZone`);
 * - a room gets a budget of distinct furniture *families*, so a small office is a
 *   desk and a chair and a bin, not one of everything;
 * - and furniture arrives in company: a table brings chairs, a bed brings a
 *   nightstand, a desk brings the chair someone left pulled out.
 */

export interface PlacedProp {
  kind: string;
  /** Fractional cell coordinates. */
  cx: number;
  cy: number;
  long: 'x' | 'y';
  variant: number;
}

export interface RoomDecor {
  wallpaper: Wallpaper;
  props: PlacedProp[];
}

/** Which boundaries of a cell are solid wall, in the four compass directions. */
export interface CellWalls {
  north: boolean;
  east: boolean;
  south: boolean;
  west: boolean;
}

const WALLPAPER_BY_PROGRAM: Partial<Record<CzRoomView['program'], readonly Wallpaper[]>> = {
  living: ['stripes', 'panel', 'plain'],
  bedroom: ['stripes', 'panel', 'plain'],
  kitchen: ['tiles', 'panel'],
  bath: ['tiles'],
  restroom: ['tiles'],
  office: ['plain', 'panel', 'stripes'],
  archive: ['panel', 'plain'],
  lab: ['tiles', 'plain'],
  server: ['plain', 'grime'],
  workshop: ['grime', 'plain'],
  storage: ['grime', 'plain'],
  lobby: ['panel', 'stripes', 'plain'],
  corridor: ['plain', 'grime', 'stripes'],
  hall: ['panel', 'plain'],
  bar: ['panel', 'stripes'],
  backstage: ['grime', 'plain'],
  dorm: ['plain', 'panel'],
  canteen: ['tiles', 'panel']
};

interface Anchor {
  cx: number;
  cy: number;
  long: 'x' | 'y';
  where: Placement;
}

/**
 * Furnishes every room of one building (or one stretch of outdoors) together.
 *
 * `wallsOf` answers which sides of a cell are solid, which is the only thing the
 * layout needs from the board.
 */
export function furnishZone(
  rooms: readonly CzRoomView[],
  width: number,
  wallsOf: (cell: number) => CellWalls
): Map<string, RoomDecor> {
  const result = new Map<string, RoomDecor>();
  if (rooms.length === 0) return result;

  /**
   * One seed for the whole building, so its rooms are drawn from one deck: the
   * building's rooms then agree with each other about how many fridges exist.
   */
  const zoneSeed = rooms.reduce((sum, room) => (sum ^ room.decor) >>> 0, 0x9e3779b9);
  const rng = seedRng(zoneSeed);
  /** How many of each kind this building already holds. */
  const zoneCount = new Map<string, number>();

  // Biggest rooms first: the signature furniture should land in the room that has
  // space for it, not in whichever room happens to be first in the list.
  const order = [...rooms].sort((a, b) => b.cells.length - a.cells.length);

  for (const room of order) {
    result.set(room.id, furnishRoom(rng, room, width, wallsOf, zoneCount));
  }

  return result;
}

function furnishRoom(
  rng: RngState,
  room: CzRoomView,
  width: number,
  wallsOf: (cell: number) => CellWalls,
  zoneCount: Map<string, number>
): RoomDecor {
  const wallpaper = pick(rng, WALLPAPER_BY_PROGRAM[room.program] ?? WALLPAPERS);

  const cells = room.cells.map((cell) => ({
    cell,
    cx: cell % width,
    cy: Math.floor(cell / width),
    walls: wallsOf(cell)
  }));

  /* ------------------------------- anchors -------------------------------- */

  const anchors: Anchor[] = [];
  const inset = 0.31;

  for (const cell of cells) {
    const { walls } = cell;
    if (walls.north) anchors.push({ cx: cell.cx, cy: cell.cy - inset, long: 'x', where: 'wall' });
    if (walls.south) anchors.push({ cx: cell.cx, cy: cell.cy + inset, long: 'x', where: 'wall' });
    if (walls.west) anchors.push({ cx: cell.cx - inset, cy: cell.cy, long: 'y', where: 'wall' });
    if (walls.east) anchors.push({ cx: cell.cx + inset, cy: cell.cy, long: 'y', where: 'wall' });

    // A corner is two walls meeting, and it is where the big awkward things go.
    for (const [a, b, dx, dy, long] of [
      ['north', 'west', -1, -1, 'x'],
      ['north', 'east', 1, -1, 'y'],
      ['south', 'west', -1, 1, 'y'],
      ['south', 'east', 1, 1, 'x']
    ] as const) {
      if (walls[a] && walls[b]) {
        anchors.push({ cx: cell.cx + dx * inset, cy: cell.cy + dy * inset, long, where: 'corner' });
      }
    }
  }

  if (cells.length >= 2) {
    const cx = cells.reduce((sum, cell) => sum + cell.cx, 0) / cells.length;
    const cy = cells.reduce((sum, cell) => sum + cell.cy, 0) / cells.length;
    anchors.push({ cx, cy, long: 'x', where: 'centre' });
    anchors.push({ cx, cy, long: 'y', where: 'centre' });
  }
  for (const cell of cells) {
    anchors.push({ cx: cell.cx, cy: cell.cy, long: 'x', where: 'floor' });
    anchors.push({
      cx: cell.cx + (randInt(rng, 40) - 20) / 100,
      cy: cell.cy + (randInt(rng, 40) - 20) / 100,
      long: 'y',
      where: 'floor'
    });
  }

  /* -------------------------------- budgets -------------------------------- */

  const placed: PlacedProp[] = [];
  const roomCount = new Map<string, number>();
  /**
   * How many *different* families of furniture a room may hold. A one-cell
   * bathroom with a toilet, a sink and a bin is furnished; the same room with a
   * toilet, a sink, a bin, a radiator, a locker and a plant is a jumble sale.
   * Clutter (paper, blood, bins) is exempt: that is what makes a room look lived
   * in rather than showroom-empty.
   */
  const familyBudget = Math.min(5, 2 + Math.ceil(cells.length / 2));
  const families = new Set<string>();
  const total = Math.max(2, Math.round(cells.length * 1.9 + randInt(rng, 2)));

  const radiusOf = (kind: string) => propDef(kind)?.radius ?? 0.2;
  const fits = (kind: string, cx: number, cy: number): boolean => {
    const radius = radiusOf(kind);
    return placed.every((other) => {
      const gap = Math.hypot(other.cx - cx, other.cy - cy);
      return gap >= (radius + radiusOf(other.kind)) * 0.78;
    });
  };

  const allowed = (def: PropDef): boolean => {
    if ((roomCount.get(def.kind) ?? 0) >= def.maxPerRoom) return false;
    if (def.maxPerZone !== undefined && (zoneCount.get(def.kind) ?? 0) >= def.maxPerZone) return false;
    if (!def.clutter && !families.has(def.kind) && families.size >= familyBudget) return false;
    return true;
  };

  const put = (def: PropDef, anchor: Anchor): boolean => {
    if (!allowed(def) || !fits(def.kind, anchor.cx, anchor.cy)) return false;
    placed.push({
      kind: def.kind,
      cx: anchor.cx,
      cy: anchor.cy,
      long: anchor.long,
      variant: randInt(rng, 1000)
    });
    roomCount.set(def.kind, (roomCount.get(def.kind) ?? 0) + 1);
    zoneCount.set(def.kind, (zoneCount.get(def.kind) ?? 0) + 1);
    if (!def.clutter) families.add(def.kind);

    // Company. A table without chairs was the clearest sign that nothing here
    // was thinking about rooms.
    for (const companion of def.companions ?? []) {
      const partner = propDef(companion.kind);
      if (!partner) continue;
      const [low, high] = companion.count;
      const count = low + randInt(rng, high - low + 1);
      const reach = radiusOf(def.kind) + radiusOf(companion.kind);
      for (let i = 0; i < count; i++) {
        if ((roomCount.get(partner.kind) ?? 0) >= partner.maxPerRoom) break;
        const angle = (i / Math.max(1, count)) * Math.PI * 2 + randInt(rng, 100) / 160;

        /**
         * Around the parent, on a ring — pulled in until it fits.
         *
         * A comfortable ring puts a chair outside a one-cell room, and the honest
         * fix is to tuck it closer rather than to drop it: a chair pushed right up
         * against the table is what a small kitchen actually looks like, and a
         * table with no chair at all was the thing that read as broken.
         */
        const spot = [1.05, 0.86, 0.72]
          .map((scale) => ({
            cx: anchor.cx + Math.cos(angle) * reach * scale,
            cy: anchor.cy + Math.sin(angle) * reach * scale * 0.8,
            long: Math.abs(Math.cos(angle)) > 0.5 ? ('y' as const) : ('x' as const),
            where: 'floor' as const
          }))
          .find((candidate) => inRoom(candidate, cells) && fits(partner.kind, candidate.cx, candidate.cy));
        if (!spot) continue;

        placed.push({
          kind: partner.kind,
          cx: spot.cx,
          cy: spot.cy,
          long: spot.long,
          variant: randInt(rng, 1000)
        });
        roomCount.set(partner.kind, (roomCount.get(partner.kind) ?? 0) + 1);
        zoneCount.set(partner.kind, (zoneCount.get(partner.kind) ?? 0) + 1);
      }
    }
    return true;
  };

  /* -------------------------------- filling -------------------------------- */

  /** What this room is for, most characteristic first. */
  const wanted = shuffled(
    rng,
    PROPS.filter((prop) => (prop.programs[room.program] ?? 0) > 0)
  ).sort((a, b) => (b.programs[room.program] ?? 0) - (a.programs[room.program] ?? 0));

  // The signature piece first, and it gets the anchor it asks for: a bed in a
  // corner, a hall's decks against a wall, a table in the middle.
  const signature = wanted[0];
  if (signature) {
    const spots = shuffled(
      rng,
      anchors.filter((anchor) => anchor.where === signature.where)
    );
    for (const spot of spots) {
      if (put(signature, spot)) break;
    }
  }

  for (const where of ['corner', 'wall', 'centre', 'floor'] as const) {
    const spots = shuffled(
      rng,
      anchors.filter((anchor) => anchor.where === where)
    );
    const candidates = wanted.filter((prop) => prop.where === where && !prop.clutter);
    for (const spot of spots) {
      if (placed.length >= total) break;
      const def = candidates.find((candidate) => allowed(candidate) && fits(candidate.kind, spot.cx, spot.cy));
      if (!def) continue;
      // Weighted refusal, so two rooms with the same programme differ.
      const eagerness = Math.min(0.9, 0.3 + (def.programs[room.program] ?? 0) / 14);
      if (!chance(rng, eagerness)) continue;
      put(def, spot);
    }
  }

  // What the world ending left behind: paper, blood, a kicked-over bin.
  const clutter = wanted.filter((prop) => prop.clutter);
  if (clutter.length > 0) {
    for (const spot of shuffled(
      rng,
      anchors.filter((anchor) => anchor.where === 'floor')
    )) {
      if (placed.length >= total + 2) break;
      const def = pick(rng, clutter);
      if (chance(rng, room.kind === 'spawn' ? 0.6 : 0.4)) put(def, spot);
    }
  }

  return { wallpaper, props: placed.sort((a, b) => a.cx + a.cy - (b.cx + b.cy)) };
}

/** Keeps a companion inside its room: a chair in the neighbour's kitchen is worse than no chair. */
function inRoom(spot: Anchor, cells: readonly { cx: number; cy: number }[]): boolean {
  return cells.some((cell) => Math.abs(cell.cx - spot.cx) <= 0.5 && Math.abs(cell.cy - spot.cy) <= 0.5);
}
