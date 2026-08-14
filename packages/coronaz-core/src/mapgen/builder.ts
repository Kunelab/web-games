import {
  edgeCode,
  MAX_ROOM_CELLS,
  roomId,
  type Board,
  type EdgeKind,
  type FloorKind,
  type Room,
  type RoomProgram
} from '../map.js';
import { pick, randInt, shuffled, type RngState } from '../rng.js';

/**
 * The scratch board a generator writes on, and the vocabulary every layout shares.
 *
 * A layout's job is to say *what goes where* — this holds the bookkeeping that all
 * of them need: painting plots, chunking a region into rooms under the cell cap,
 * setting boundaries, and finally freezing the whole thing into a `Board`.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function rectCells(rect: Rect, width: number): number[] {
  const cells: number[] = [];
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      cells.push(y * width + x);
    }
  }
  return cells;
}

export function rectArea(rect: Rect): number {
  return rect.w * rect.h;
}

/** A slice of the plan: a stretch of outdoors, or the footprint of a building. */
export interface Plot {
  kind: 'outdoor' | 'building';
  rect: Rect;
  /** For outdoors, the programme every room of it gets. */
  program?: RoomProgram;
  /** For a building, which programme list to furnish it from. */
  building?: string;
}

/** What a layout returns. Anything not claimed becomes the layout's filler. */
export interface Plan {
  plots: Plot[];
  /** Programme for cells no plot claimed: usually 'yard' or 'alley'. */
  filler: RoomProgram;
}

export interface LayoutDef {
  id: string;
  name: string;
  /** One line for the setup screen. */
  blurb: string;
  plan: (rng: RngState, width: number, height: number) => Plan;
}

export class BoardBuilder {
  readonly width: number;
  readonly height: number;
  private readonly right: string[];
  private readonly down: string[];
  private readonly owner: string[];
  private readonly rooms: Room[] = [];
  private zoneCounter = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    const cells = width * height;
    // Everything starts walled off; opening a boundary is a deliberate act.
    this.right = new Array<string>(cells).fill(edgeCode('wall'));
    this.down = new Array<string>(cells).fill(edgeCode('wall'));
    this.owner = new Array<string>(cells).fill('');
  }

  cell(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return -1;
    return y * this.width + x;
  }

  xy(cell: number): { x: number; y: number } {
    return { x: cell % this.width, y: Math.floor(cell / this.width) };
  }

  claimed(cell: number): boolean {
    return cell >= 0 && this.owner[cell] !== '';
  }

  /** A fresh building identifier; 0 is reserved for the outdoors. */
  nextZone(): number {
    return ++this.zoneCounter;
  }

  /**
   * Adds one room over the given cells. The caller has already decided the cells
   * are contiguous and under the cap — `chunk` is what guarantees both.
   */
  addRoom(
    cells: number[],
    attributes: {
      program: RoomProgram;
      floor: FloorKind;
      hue: number;
      outdoor: boolean;
      zone: number;
      decor: number;
    }
  ): Room {
    const sorted = [...cells].sort((a, b) => a - b);
    const first = sorted[0];
    if (first === undefined) throw new Error('a room needs at least one cell');

    const xs = sorted.map((cell) => cell % this.width);
    const ys = sorted.map((cell) => Math.floor(cell / this.width));
    const x = Math.min(...xs);
    const y = Math.min(...ys);

    /**
     * The id names a cell the room actually owns — the row-major first one — and
     * not the corner of its bounding box.
     *
     * Those are the same thing only for rectangles. A flood-filled footprint can
     * be L-shaped, and then its bounding-box corner belongs to the *neighbour*,
     * so two rooms end up with the same name: the room index keeps one of them,
     * half the doors lead to a room that is no longer in it, and the board reports
     * itself as disconnected. Which is exactly what happened.
     */
    const room: Room = {
      id: roomId(first % this.width, Math.floor(first / this.width)),
      x,
      y,
      w: Math.max(...xs) - x + 1,
      h: Math.max(...ys) - y + 1,
      cells: sorted,
      kind: 'normal',
      hasKey: false,
      ...attributes
    };

    for (const cell of sorted) this.owner[cell] = room.id;
    this.rooms.push(room);

    // Inside one room there is no wall at all.
    for (const cell of sorted) {
      const { x: cx, y: cy } = this.xy(cell);
      const right = this.cell(cx + 1, cy);
      const down = this.cell(cx, cy + 1);
      if (right !== -1 && this.owner[right] === room.id) this.right[cell] = edgeCode('open');
      if (down !== -1 && this.owner[down] === room.id) this.down[cell] = edgeCode('open');
    }

    return room;
  }

  /**
   * Re-runs the "same room, no wall" rule for a room whose neighbours were only
   * claimed after it was added. Cheaper than ordering the whole generator around
   * the problem.
   */
  sealInterior(): void {
    for (let cell = 0; cell < this.owner.length; cell++) {
      const mine = this.owner[cell];
      if (!mine) continue;
      const { x, y } = this.xy(cell);
      const right = this.cell(x + 1, y);
      const down = this.cell(x, y + 1);
      if (right !== -1 && this.owner[right] === mine) this.right[cell] = edgeCode('open');
      if (down !== -1 && this.owner[down] === mine) this.down[cell] = edgeCode('open');
    }
  }

  setEdge(a: number, b: number, kind: EdgeKind): void {
    if (a === -1 || b === -1) return;
    const from = this.xy(a);
    const to = this.xy(b);
    if (to.y === from.y && to.x === from.x + 1) this.right[a] = edgeCode(kind);
    else if (to.y === from.y && to.x === from.x - 1) this.right[b] = edgeCode(kind);
    else if (to.x === from.x && to.y === from.y + 1) this.down[a] = edgeCode(kind);
    else if (to.x === from.x && to.y === from.y - 1) this.down[b] = edgeCode(kind);
  }

  roomIdAt(cell: number): string {
    return cell === -1 ? '' : (this.owner[cell] ?? '');
  }

  allRooms(): readonly Room[] {
    return this.rooms;
  }

  freeze(layout: string): Board {
    return {
      width: this.width,
      height: this.height,
      rooms: this.rooms,
      cellRoom: [...this.owner],
      edgeRight: this.right.join(''),
      edgeDown: this.down.join(''),
      layout
    };
  }
}

/**
 * Breaks a region into rooms of at most `cap` contiguous cells.
 *
 * Greedy flood growth from a random seed cell: take a cell, grow into neighbours
 * still in the region until the chunk is full, repeat. Compact by construction —
 * growing breadth-first keeps a chunk blobby rather than snake-shaped, which
 * matters because a snake of four cells reads as a corridor when it should read as
 * a room.
 *
 * This is where "one big space" becomes "several rooms": the caller joins the
 * chunks back together with arches, and the result looks like one volume while
 * still costing a move to cross.
 */
export function chunk(rng: RngState, region: readonly number[], width: number, cap = MAX_ROOM_CELLS): number[][] {
  const remaining = new Set(region);
  const chunks: number[][] = [];

  while (remaining.size > 0) {
    // Prefer starting from a cell with few free neighbours, so leftovers do not
    // end up as orphans in the corners.
    const candidates = [...remaining];
    let seed = candidates[0] ?? 0;
    let fewest = 5;
    for (const candidate of shuffled(rng, candidates)) {
      const { x, y } = { x: candidate % width, y: Math.floor(candidate / width) };
      let free = 0;
      // Only the x wrap needs guarding: an out-of-range row lands on an index that
      // is simply not in `remaining`, which only ever holds cells of this region.
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1]
      ] as const) {
        const next = (y + dy) * width + (x + dx);
        if (x + dx >= 0 && x + dx < width && remaining.has(next)) free += 1;
      }
      if (free < fewest) {
        fewest = free;
        seed = candidate;
      }
      if (free === 0) break;
    }

    const taken: number[] = [seed];
    remaining.delete(seed);
    // A little variety in room size, bounded by the cap.
    const target = Math.max(1, Math.min(cap, 2 + randInt(rng, cap - 1)));

    while (taken.length < target) {
      const frontier: number[] = [];
      for (const cell of taken) {
        const x = cell % width;
        const y = Math.floor(cell / width);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1]
        ] as const) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const next = (y + dy) * width + nx;
          if (remaining.has(next)) frontier.push(next);
        }
      }
      if (frontier.length === 0) break;
      const grown = pick(rng, frontier);
      taken.push(grown);
      remaining.delete(grown);
    }

    chunks.push(taken);
  }

  return chunks;
}

/** Cells of `region` that touch a cell outside it, with the outside cell. */
export function borderOf(
  region: readonly number[],
  width: number,
  height: number
): { inside: number; outside: number; dx: number; dy: number }[] {
  const set = new Set(region);
  const found: { inside: number; outside: number; dx: number; dy: number }[] = [];
  for (const cell of region) {
    const x = cell % width;
    const y = Math.floor(cell / width);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const next = ny * width + nx;
      if (!set.has(next)) found.push({ inside: cell, outside: next, dx, dy });
    }
  }
  return found;
}
