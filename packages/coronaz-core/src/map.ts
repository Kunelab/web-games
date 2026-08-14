/**
 * The board's model and every question you can ask of it. How one gets *built*
 * lives in `mapgen/`, which imports this and never the other way round.
 *
 * A grid of *cells* carved into rooms of one to four cells:
 *
 * - a **cell** is a unit of floor, and the grid is measured in cells;
 * - a **room** owns one to four adjacent cells and is still the atom of every
 *   rule — one move, one search, one line of sight;
 * - a **boundary** between two adjacent cells is `open` (they are the same room),
 *   `wall`, `door` (a one-cell gap) or `arch` (the shared wall is gone entirely,
 *   so two rooms read as one space without being one room).
 *
 * The room cap is a rule, not a limitation: a move costs one action point
 * whatever the room's size, so a single-room dancefloor would be crossable for
 * one point. Big spaces are therefore built as *arch-connected clusters* of small
 * rooms — visually one volume, mechanically several steps. That is what lets the
 * generator draw streets and halls without touching the economy of the game.
 *
 * The adjacency graph is derived from the boundaries, never stored, so the map
 * cannot disagree with itself. Everything else — pathfinding, line of sight, fog —
 * is a function of the boundaries.
 *
 * Boundaries are stored as one character per cell in two strings rather than as
 * arrays of objects, because a 32×24 board has 768 of them and the whole board
 * ships inside every state broadcast.
 */

/** What sits between two adjacent cells. */
export type EdgeKind =
  /** Same room: no wall at all, and nothing to draw. */
  | 'open'
  /** Impassable. */
  | 'wall'
  /** A one-cell doorway between two rooms. */
  | 'door'
  /** The shared wall is gone: two rooms, one open space. */
  | 'arch'
  /** Fog: this boundary touches a room the team has never seen. */
  | 'unknown';

const EDGE_CODE: Record<EdgeKind, string> = {
  open: '.',
  wall: '#',
  door: 'D',
  arch: 'A',
  unknown: '?'
};

const EDGE_OF_CODE: Record<string, EdgeKind> = {
  '.': 'open',
  '#': 'wall',
  D: 'door',
  A: 'arch',
  '?': 'unknown'
};

export function edgeCode(kind: EdgeKind): string {
  return EDGE_CODE[kind];
}

/** Whether a creature can cross this boundary. */
export function passable(kind: EdgeKind): boolean {
  return kind === 'open' || kind === 'door' || kind === 'arch';
}

/** Whether sight crosses it. Doors were always open gaps; nothing is glazed. */
export function seeThrough(kind: EdgeKind): boolean {
  return passable(kind);
}

/** The most cells one room may own. See the note on arch clusters above. */
export const MAX_ROOM_CELLS = 4;

export type RoomKind = 'normal' | 'start' | 'exit' | 'spawn' | 'fungus';

/**
 * What a room was for, before. Cosmetic to the rules and load-bearing for
 * everything else: it picks the floor, the wallpaper and the furniture, and it is
 * assigned from a *building programme* rather than rolled per room — which is the
 * difference between a flat and four random rooms in a row.
 */
export type RoomProgram =
  /* Homes */
  | 'living'
  | 'kitchen'
  | 'bath'
  | 'bedroom'
  /* Work */
  | 'office'
  | 'archive'
  | 'lab'
  | 'server'
  | 'workshop'
  | 'storage'
  /* Public */
  | 'lobby'
  | 'corridor'
  | 'hall'
  | 'bar'
  | 'restroom'
  | 'backstage'
  /* Institutional */
  | 'dorm'
  | 'canteen'
  /* Outside */
  | 'street'
  | 'crossing'
  | 'alley'
  | 'yard'
  | 'parking'
  | 'dock';

/** The outdoor programmes, in one place: the renderer needs to know there is no roof. */
export const OUTDOOR_PROGRAMS: readonly RoomProgram[] = ['street', 'crossing', 'alley', 'yard', 'parking', 'dock'];

export function isOutdoorProgram(program: RoomProgram): boolean {
  return OUTDOOR_PROGRAMS.includes(program);
}

export type FloorKind =
  /* Indoors */
  | 'parquet'
  | 'carpet'
  | 'tile'
  | 'lino'
  | 'concrete'
  | 'grate'
  /* Outdoors */
  | 'asphalt'
  | 'pavement'
  | 'gravel'
  | 'grass'
  | 'cobble';

export interface Room {
  id: string;
  /**
   * The footprint's top-left cell. Kept named `x`/`y` because every rule that
   * used to read a room's coordinates still wants one anchor point.
   */
  x: number;
  y: number;
  /** Bounding box in cells. An L is 2×2 with three cells. */
  w: number;
  h: number;
  /** Cell indices owned by this room, row-major and ascending. */
  cells: number[];
  kind: RoomKind;
  hasKey: boolean;
  /**
   * The room's tint, 0–359. Rooms in one building share it, which makes a
   * building read as one place — the 2020 game's best visual idea, kept and given
   * a better reason than "sometimes".
   */
  hue: number;
  floor: FloorKind;
  program: RoomProgram;
  /** Outside. No roof, no wallpaper, and the sky for a ceiling. */
  outdoor: boolean;
  /**
   * Which building this room belongs to; 0 for anything outdoors. Furnishing uses
   * it to keep a building sane — one kitchen's worth of fridges, not four.
   */
  zone: number;
  /**
   * Cosmetic seed. The furniture is a pure function of this number, so the
   * decoration costs the protocol four bytes instead of a prop list.
   */
  decor: number;
}

export interface Board {
  /** In cells, not rooms. */
  width: number;
  height: number;
  rooms: Room[];
  /** Room id per cell, row-major. */
  cellRoom: string[];
  /** Boundary to each cell's right neighbour, one character per cell. */
  edgeRight: string;
  /** Boundary to each cell's bottom neighbour, one character per cell. */
  edgeDown: string;
  /** Which layout generator drew it, for the record and for the UI. */
  layout: string;
}

/** A way out of a room: which room, how open, and across which two cells. */
export interface Connection {
  roomId: string;
  kind: 'door' | 'arch';
  /** The cell on this side, and its neighbour, as indices. */
  from: number;
  to: number;
  /** Unit step from `from` to `to`. */
  dx: number;
  dy: number;
}

export const DIRS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1]
];

export function roomId(x: number, y: number): string {
  return `r${x}_${y}`;
}

export function cellIndex(board: Board, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= board.width || y >= board.height) return -1;
  return y * board.width + x;
}

export function cellXY(board: Board, index: number): { x: number; y: number } {
  return { x: index % board.width, y: Math.floor(index / board.width) };
}

/**
 * Derived indexes, cached per board object.
 *
 * A board is plain JSON so it can be persisted and broadcast, which rules out
 * storing lookups on it. But `getRoom` used to be a linear scan through the room
 * list and it runs inside BFS, and the boards are now several times larger.
 * Geometry never changes after generation (only `kind` and `hasKey` do), so
 * caching room lookup and adjacency against the board's identity is safe; a board
 * that came off the wire is simply a new object with a cold cache.
 */
interface BoardIndex {
  byId: Map<string, Room>;
  connections: Map<string, Connection[]>;
}

const indexes = new WeakMap<Board, BoardIndex>();

function indexOf(board: Board): BoardIndex {
  const existing = indexes.get(board);
  if (existing) return existing;

  const byId = new Map<string, Room>();
  for (const room of board.rooms) byId.set(room.id, room);

  const connections = new Map<string, Connection[]>();
  for (const room of board.rooms) {
    const found: Connection[] = [];
    for (const cell of room.cells) {
      const { x, y } = cellXY(board, cell);
      for (const [dx, dy] of DIRS) {
        const kind = edgeBetween(board, x, y, x + dx, y + dy);
        if (kind !== 'door' && kind !== 'arch') continue;
        const to = cellIndex(board, x + dx, y + dy);
        const otherId = board.cellRoom[to];
        if (otherId === undefined || otherId === room.id) continue;
        found.push({ roomId: otherId, kind, from: cell, to, dx, dy });
      }
    }
    connections.set(room.id, found);
  }

  const built: BoardIndex = { byId, connections };
  indexes.set(board, built);
  return built;
}

export function roomAt(board: Board, x: number, y: number): Room | undefined {
  const index = cellIndex(board, x, y);
  if (index === -1) return undefined;
  const id = board.cellRoom[index];
  return id === undefined ? undefined : indexOf(board).byId.get(id);
}

export function roomOfCell(board: Board, cell: number): Room | undefined {
  const id = board.cellRoom[cell];
  return id === undefined ? undefined : indexOf(board).byId.get(id);
}

export function getRoom(board: Board, id: string): Room {
  const room = indexOf(board).byId.get(id);
  if (!room) throw new Error(`Unknown room: ${id}`);
  return room;
}

/** The boundary between two orthogonally adjacent cells, in either direction. */
export function edgeBetween(board: Board, ax: number, ay: number, bx: number, by: number): EdgeKind {
  const a = cellIndex(board, ax, ay);
  const b = cellIndex(board, bx, by);
  if (a === -1 || b === -1) return 'wall';

  // The boundary belongs to the left/upper cell of the pair.
  if (by === ay && bx === ax + 1) return readEdge(board.edgeRight, a);
  if (by === ay && bx === ax - 1) return readEdge(board.edgeRight, b);
  if (bx === ax && by === ay + 1) return readEdge(board.edgeDown, a);
  if (bx === ax && by === ay - 1) return readEdge(board.edgeDown, b);
  return 'wall';
}

function readEdge(source: string, index: number): EdgeKind {
  return EDGE_OF_CODE[source[index] ?? '#'] ?? 'wall';
}

/** The boundary on a cell's right or bottom side, for renderers walking cells. */
export function edgeAt(board: Board, cell: number, side: 'right' | 'down'): EdgeKind {
  return readEdge(side === 'right' ? board.edgeRight : board.edgeDown, cell);
}

/** Every doorway and archway out of this room, one entry per cell boundary. */
export function connectionsOf(board: Board, room: Room): Connection[] {
  return indexOf(board).connections.get(room.id) ?? [];
}

/** Rooms reachable in one step. Deduplicated: a shared arch is still one move. */
export function neighbors(board: Board, room: Room): Room[] {
  const seen = new Set<string>();
  const result: Room[] = [];
  for (const connection of connectionsOf(board, room)) {
    if (seen.has(connection.roomId)) continue;
    seen.add(connection.roomId);
    const other = indexOf(board).byId.get(connection.roomId);
    if (other) result.push(other);
  }
  return result;
}

export function degree(board: Board, room: Room): number {
  return neighbors(board, room).length;
}

export function cellCount(board: Board): number {
  return board.width * board.height;
}

/**
 * Shortest path through open boundaries, as room ids excluding the start.
 *
 * Plain BFS over the room graph. The original hand-rolled a randomised
 * depth-first search with a backtracking blacklist and an 800-iterations-per-room
 * budget, logged "i'm lost" when it gave up, and was the slowest code in the
 * game. BFS is exact and instant even on the larger boards this model allows.
 */
export function shortestPath(board: Board, fromId: string, toId: string): string[] | null {
  if (fromId === toId) return [];

  const cameFrom = new Map<string, string>();
  const queue: Room[] = [getRoom(board, fromId)];
  const seen = new Set<string>([fromId]);

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    for (const next of neighbors(board, current)) {
      if (seen.has(next.id)) continue;
      seen.add(next.id);
      cameFrom.set(next.id, current.id);

      if (next.id === toId) {
        const path: string[] = [next.id];
        let step = current.id;
        while (step !== fromId) {
          path.unshift(step);
          step = cameFrom.get(step) ?? fromId;
        }
        return path;
      }
      queue.push(next);
    }
  }

  return null;
}

/**
 * The rooms that form one continuous open volume with this one: everything
 * reachable through arches alone, bounded by `depth` rooms.
 *
 * An arch means "no wall at all", so a street or an open-plan hall is several
 * rooms of one space. Line of sight walks straight rays, which is right for
 * shooting and wrong for *seeing*: standing in the middle of an open street it lit
 * four lines and left the rest of the street pitch black, which reads as a broken
 * fog rather than as a rule. You can see the room you are standing in; this is the
 * rest of that room.
 */
export function openSpace(board: Board, fromId: string, depth = Number.POSITIVE_INFINITY): Set<string> {
  const seen = new Set<string>([fromId]);
  let frontier = [getRoom(board, fromId)];

  for (let step = 0; step < depth && frontier.length > 0; step++) {
    const next: Room[] = [];
    for (const room of frontier) {
      for (const link of connectionsOf(board, room)) {
        if (link.kind !== 'arch' || seen.has(link.roomId)) continue;
        seen.add(link.roomId);
        const other = indexOf(board).byId.get(link.roomId);
        if (other) next.push(other);
      }
    }
    frontier = next;
  }

  return seen;
}

/**
 * Distance in moves from one room to every room it can reach.
 *
 * One BFS instead of one per question. Objective placement asks "how far is this
 * from the start" of every room on the board, and the enemy AI asks it of every
 * hero every activation; doing that with `shortestPath` per candidate was the kind
 * of quadratic that only shows up once the boards get big.
 */
export function distancesFrom(board: Board, fromId: string): Map<string, number> {
  const distances = new Map<string, number>([[fromId, 0]]);
  const queue: Room[] = [getRoom(board, fromId)];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const here = distances.get(current.id) ?? 0;
    for (const next of neighbors(board, current)) {
      if (distances.has(next.id)) continue;
      distances.set(next.id, here + 1);
      queue.push(next);
    }
  }

  return distances;
}

/**
 * Rooms visible in a straight line from `from`, through open boundaries, in the
 * four directions. Both line of sight for ranged weapons and the seed of the fog
 * of war; `range` bounds it in *rooms crossed*, Infinity for sight.
 *
 * The ray walks cells rather than rooms, which is what lets it see across a hall
 * and down the length of a street. A room's own cells cost no distance, so a
 * pistol still reaches "one room away" however big that room happens to be.
 */
export function lineOfSight(board: Board, fromId: string, range = Number.POSITIVE_INFINITY): Map<string, number> {
  const from = getRoom(board, fromId);
  const visible = new Map<string, number>([[from.id, 0]]);

  for (const cell of from.cells) {
    const origin = cellXY(board, cell);

    for (const [dx, dy] of DIRS) {
      let x = origin.x;
      let y = origin.y;
      let distance = 0;
      let currentId = from.id;

      for (;;) {
        if (!seeThrough(edgeBetween(board, x, y, x + dx, y + dy))) break;
        x += dx;
        y += dy;
        const index = cellIndex(board, x, y);
        if (index === -1) break;
        const nextId = board.cellRoom[index];
        if (nextId === undefined) break;

        if (nextId !== currentId) {
          distance += 1;
          if (distance > range) break;
          currentId = nextId;
          const known = visible.get(nextId);
          if (known === undefined || distance < known) visible.set(nextId, distance);
        }
      }
    }
  }

  return visible;
}
