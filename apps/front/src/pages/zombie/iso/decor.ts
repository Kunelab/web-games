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

/**
 * How thickly a room of each kind is furnished, in props per cell.
 *
 * Everything used to be furnished at 1.9 props per cell, indoors and out, and that
 * single number is most of why the modern biome read as one gigantic hangar with
 * furniture strewn across it. A four-cell stretch of road got eight objects on it.
 * Roads do not have eight objects on them; they have a parked car and a manhole, and
 * everything else is at the kerb.
 *
 * So density is now a property of the *kind of place*, which also gives each one an
 * identity from above: a road is nearly bare, a pavement has lamp posts and bins, a
 * square has benches and a fountain, a park has trees, and only interiors are
 * actually cluttered. The three numbers a room gets from this table (how many props,
 * how many distinct families, how eager it is) are what make a street look like a
 * street rather than a living room with the roof off.
 */
const DENSITY: Record<CzRoomView['program'], { props: number; families: number }> = {
  /* Interiors: crowded, because a lived-in room is crowded. */
  living: { props: 1.8, families: 5 },
  bedroom: { props: 1.7, families: 4 },
  kitchen: { props: 1.9, families: 5 },
  bath: { props: 1.5, families: 4 },
  office: { props: 1.7, families: 5 },
  archive: { props: 1.8, families: 3 },
  lab: { props: 1.7, families: 4 },
  server: { props: 1.5, families: 3 },
  workshop: { props: 1.9, families: 5 },
  storage: { props: 2, families: 3 },
  lobby: { props: 1, families: 3 },
  corridor: { props: 0.5, families: 2 },
  hall: { props: 1.1, families: 4 },
  bar: { props: 1.8, families: 4 },
  restroom: { props: 1.5, families: 3 },
  backstage: { props: 1.6, families: 4 },
  dorm: { props: 1.6, families: 3 },
  canteen: { props: 1.6, families: 4 },
  reception: { props: 1.2, families: 4 },
  ward: { props: 1.6, families: 4 },
  surgery: { props: 1.6, families: 4 },
  pharmacy: { props: 1.9, families: 4 },
  morgue: { props: 1.3, families: 3 },
  cell: { props: 0.8, families: 2 },
  evidence: { props: 1.9, families: 3 },
  armoury: { props: 1.8, families: 3 },

  /* Outdoors. A road is the emptiest thing on the map, on purpose. */
  street: { props: 0.14, families: 1 },
  crossing: { props: 0.3, families: 2 },
  sidewalk: { props: 0.4, families: 2 },
  square: { props: 0.45, families: 3 },
  park: { props: 0.6, families: 3 },
  alley: { props: 0.8, families: 3 },
  yard: { props: 0.5, families: 3 },
  parking: { props: 0.5, families: 2 },
  dock: { props: 1, families: 3 }
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
   * How many *different* families of furniture a room may hold: the smaller of what
   * its kind allows and what its size allows. A one-cell bathroom with a toilet, a
   * sink and a bin is furnished; the same room with a toilet, a sink, a bin, a
   * radiator, a locker and a plant is a jumble sale. Clutter (paper, blood, bins) is
   * exempt indoors: that is what makes a room look lived in rather than
   * showroom-empty.
   */
  const density = DENSITY[room.program];
  const familyBudget = Math.min(density.families, 2 + Math.ceil(cells.length / 2));
  const families = new Set<string>();
  /**
   * No floor of two any more. A two-cell piece of road wants nothing on it at all,
   * and forcing a minimum is exactly how the outdoors filled up: every empty place
   * on the map was told to find something to hold.
   */
  const total = Math.max(0, Math.round(cells.length * density.props + (randInt(rng, 3) - 1) * density.props));

  const radiusOf = (kind: string) => propDef(kind)?.radius ?? 0.2;
  /**
   * Whether a prop can stand here without overlapping another.
   *
   * `except` is the prop it *belongs* to, and it exists because a chair tucked at a
   * desk overlaps the desk, by definition: that is what "tucked at" means. Without
   * the exemption the only ring positions that cleared the generic separation were
   * the far ones, which then fell outside a small room, and 46 % of office desks came
   * out with no chair at all. A companion may touch its parent and nothing else.
   */
  const fits = (kind: string, cx: number, cy: number, except?: PlacedProp): boolean => {
    const radius = radiusOf(kind);
    return placed.every((other) => {
      if (other === except) return true;
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
    const parent: PlacedProp = {
      kind: def.kind,
      cx: anchor.cx,
      cy: anchor.cy,
      long: anchor.long,
      variant: randInt(rng, 1000)
    };
    placed.push(parent);
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
      /**
       * Which way is *into* the room, from the parent's own position.
       *
       * This is the fix for a chair that was never there. The ring below started at
       * angle zero, so a companion always went towards +x first: a desk against the
       * east wall put its chair through the wall, the spot failed `inRoom`, and the
       * desk simply had no chair. Measured at 47 % of office desks seated, which is
       * about what a coin flip on the wall's direction predicts.
       *
       * Aiming at the room's own centre of mass first fixes every companion at once,
       * and it is also what a person does with a chair: you put it on the side you
       * can walk up to.
       */
      const inward = Math.atan2(
        cells.reduce((sum, cell) => sum + cell.cy, 0) / cells.length - anchor.cy,
        cells.reduce((sum, cell) => sum + cell.cx, 0) / cells.length - anchor.cx
      );

      for (let i = 0; i < count; i++) {
        if ((roomCount.get(partner.kind) ?? 0) >= partner.maxPerRoom) break;
        /** Spread the companions around, but starting from the inward direction. */
        const angle = inward + (i / Math.max(1, count)) * Math.PI * 1.4 - Math.PI * 0.7 + randInt(rng, 60) / 160;

        /**
         * Around the parent, on a ring, pulled in until it fits, and reflected if
         * that fails: a chair pushed right up against the table is what a small
         * kitchen actually looks like, and a table with no chair at all was the thing
         * that read as broken.
         */
        const spot = [1.05, 0.86, 0.72, -0.86]
          .map((scale) => ({
            cx: anchor.cx + Math.cos(angle) * reach * scale,
            cy: anchor.cy + Math.sin(angle) * reach * scale * 0.8,
            long: Math.abs(Math.cos(angle)) > 0.5 ? ('y' as const) : ('x' as const),
            where: 'floor' as const
          }))
          .find((candidate) => inRoom(candidate, cells) && fits(partner.kind, candidate.cx, candidate.cy, parent));
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

  /**
   * The signature piece first, and it gets the anchor it asks for: a bed in a
   * corner, a hall's decks against a wall, a table in the middle.
   *
   * Skipped entirely where the room's budget is zero, which is what keeps a road a
   * road. This used to be unconditional, so every two-cell stretch of tarmac was
   * handed a parked car whatever the density said, and an avenue came out as a
   * traffic jam: measured at 0.36 props a cell on a table that asked for 0.14.
   */
  const signature = total >= 1 ? wanted[0] : undefined;
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

  /**
   * What the world ending left behind: paper, blood, a kicked-over bin.
   *
   * Scaled by the same density, and exempt from the family budget only where the
   * budget is generous in the first place. It used to run at a flat 40 % chance per
   * floor anchor with a +2 allowance over the room's total, which meant a bare piece
   * of road still ended up with two bins and a bloodstain on it: the litter pass was
   * quietly undoing the discipline of the pass above it.
   */
  const clutter = wanted.filter((prop) => prop.clutter);
  const litterRoom = Math.round(total + density.props * 2);
  if (clutter.length > 0 && litterRoom > 0) {
    for (const spot of shuffled(
      rng,
      anchors.filter((anchor) => anchor.where === 'floor')
    )) {
      if (placed.length >= litterRoom) break;
      const def = pick(rng, clutter);
      if (chance(rng, Math.min(0.6, (room.kind === 'spawn' ? 0.6 : 0.4) * density.props))) put(def, spot);
    }
  }

  return { wallpaper, props: placed.sort((a, b) => a.cx + a.cy - (b.cx + b.cy)) };
}

/** Keeps a companion inside its room: a chair in the neighbour's kitchen is worse than no chair. */
function inRoom(spot: Anchor, cells: readonly { cx: number; cy: number }[]): boolean {
  return cells.some((cell) => Math.abs(cell.cx - spot.cx) <= 0.5 && Math.abs(cell.cy - spot.cy) <= 0.5);
}
