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
  /**
   * Glass. Sight and gunfire cross it; bodies do not.
   *
   * The first boundary in this game where those two answers differ, and the reason
   * it is worth adding: the moment you step indoors the fight goes blind, because
   * every wall stops sight as absolutely as it stops movement. A window means a
   * survivor can watch the street from the shop, shoot from cover, and be shot at
   * through it; it means a room can be dangerous without being reachable. All of
   * that from one edge state, and none of the movement rules change.
   */
  | 'window'
  /** Fog: this boundary touches a room the team has never seen. */
  | 'unknown';

const EDGE_CODE: Record<EdgeKind, string> = {
  open: '.',
  wall: '#',
  door: 'D',
  arch: 'A',
  window: 'W',
  unknown: '?'
};

const EDGE_OF_CODE: Record<string, EdgeKind> = {
  '.': 'open',
  '#': 'wall',
  D: 'door',
  A: 'arch',
  W: 'window',
  unknown: 'unknown',
  '?': 'unknown'
};

export function edgeCode(kind: EdgeKind): string {
  return EDGE_CODE[kind];
}

/** The inverse, for the generator: what a stored code means. */
export function edgeOfCode(code: string): EdgeKind {
  return EDGE_OF_CODE[code] ?? 'wall';
}

/** Whether a creature can cross this boundary. Glass does not open. */
export function passable(kind: EdgeKind): boolean {
  return kind === 'open' || kind === 'door' || kind === 'arch';
}

/**
 * Whether sight and gunfire cross it.
 *
 * The same answer as `passable` for everything except a window, which is the whole
 * point of a window. Kept as its own function precisely so the two can disagree:
 * every rule that asks "can I see it" or "can I shoot it" reads this, and every rule
 * that asks "can I walk there" reads the other.
 */
export function seeThrough(kind: EdgeKind): boolean {
  return passable(kind) || kind === 'window';
}

/** The most cells one *indoor* room may own. See the note on arch clusters above. */
export const MAX_ROOM_CELLS = 4;

/**
 * The most cells one outdoor room may own, which is larger, and deliberately.
 *
 * A move costs one action point per room whatever the room's size, so room size *is*
 * the cost of walking. Indoors that has to stay tight: a house whose ground floor is
 * one room would be crossed for a single point, and the whole tension of searching a
 * building under pressure comes from paying to move through it.
 *
 * Outdoors the same rule was making the map feel enormous in the wrong way. A square
 * cut into nine one-cell rooms cost nine points to cross, so nobody crossed it, and
 * the open ground the layouts had gone to such trouble to create was scenery rather
 * than space. Nine cells lets a plaza be two or three strides wide, which is what
 * "everything is not too far" means in action points.
 */
export const MAX_OUTDOOR_ROOM_CELLS = 9;

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
  | 'reception'
  /* Hospital */
  | 'ward'
  | 'surgery'
  | 'pharmacy'
  | 'morgue'
  /* Police */
  | 'cell'
  | 'evidence'
  | 'armoury'
  /* Outside */
  | 'street'
  | 'crossing'
  | 'sidewalk'
  | 'square'
  | 'park'
  | 'alley'
  | 'yard'
  | 'parking'
  | 'dock';

/** The outdoor programmes, in one place: the renderer needs to know there is no roof. */
export const OUTDOOR_PROGRAMS: readonly RoomProgram[] = [
  'street',
  'crossing',
  'sidewalk',
  'square',
  'park',
  'alley',
  'yard',
  'parking',
  'dock'
];

/**
 * The outdoors a vehicle uses, as opposed to the outdoors a person uses.
 *
 * Worth naming because it is the difference between a town and a car park: a road
 * carries markings and almost no props, a pavement carries lamp posts and bins, a
 * square carries benches and planters. Getting that wrong is most of why the old
 * outdoors read as one enormous hangar with furniture scattered in it.
 */
export const ROADWAY_PROGRAMS: readonly RoomProgram[] = ['street', 'crossing', 'alley', 'parking', 'dock'];

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
   * What searching *here* is worth, as a bonus on the loot roll: -0.2 is a street,
   * 0 is an ordinary living room, +1 is a police armoury.
   *
   * Rooms used to be interchangeable containers, so exploring was a chore priced
   * entirely in action points and the answer was always "search the nearest thing".
   * A pharmacy that pays better than a corridor turns the map itself into the
   * decision, and it is the room's *programme* that says so, which means the player
   * can read it off the screen rather than having to learn a table.
   */
  loot: number;
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
  /**
   * How many more things can be found here. Decremented by every search.
   *
   * Rooms had no search budget at all, and nothing in the engine marked one as
   * searched — so the optimal play in a room the loot table pays double for was to
   * stand still and search it over and over, bounded only by action points, bag
   * space, and a loot fatigue counted per *hero* rather than per room. Standing
   * still is the least interesting thing this game can ask of anyone, and it
   * quietly undid the work that made rooms differ: you never had to cross the
   * street to the pharmacy, only to arrive once and camp.
   *
   * The supply is deliberately far larger than a table can spend — roughly two
   * hundred finds on a district against the thirty a raid uses — so this is not a
   * scarcity dial. It binds *locally*, which is the whole intent: a good room is a
   * destination that runs dry, so exploring is the way to keep finding things.
   */
  finds: number;
}

export interface Board {
  /** In cells, not rooms. */
  width: number;
  height: number;
  rooms: Room[];
  /**
   * Room id per cell, row-major. An empty string is rubble: a cell no room owns,
   * which nothing can enter and nothing can see through. The generator guarantees
   * everything that *is* a room stays one connected world around it.
   */
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
  /**
   * The deduplicated adjacency, one entry per room.
   *
   * Cached with the rest of the geometry because BFS asks for a room's
   * neighbours once per visit and a single hero decision runs several searches:
   * rebuilding the list on each call — a Set for the dedup, an array for the
   * result, per room per visit — was the largest source of allocation in the
   * whole game.
   */
  neighbors: Map<string, Room[]>;
  /**
   * Searches already answered for this board, keyed `from>to`.
   *
   * A search reads nothing but the geometry, and the geometry is fixed once the
   * district is generated — so the same question always has the same answer, and
   * asking it twice is pure waste. It is asked constantly: every creature paths
   * to its prey each time it moves, and a horde converging on the same few rooms
   * re-walks the same corridors from the same doorways over and over.
   *
   * Bounded by the pairs actually asked about, and collected with the board it
   * belongs to.
   */
  paths: Map<string, string[] | null>;
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

  const neighbors = new Map<string, Room[]>();
  for (const room of board.rooms) {
    const seen = new Set<string>();
    const found: Room[] = [];
    for (const connection of connections.get(room.id) ?? []) {
      if (seen.has(connection.roomId)) continue;
      seen.add(connection.roomId);
      const other = byId.get(connection.roomId);
      if (other) found.push(other);
    }
    neighbors.set(room.id, found);
  }

  const built: BoardIndex = { byId, connections, neighbors, paths: new Map() };
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

/**
 * Rooms reachable in one step. Deduplicated: a shared arch is still one move.
 *
 * Read straight out of the board index, so this is a lookup rather than a
 * rebuild. The list belongs to the index and is handed out as-is: like
 * `connectionsOf`, callers read it and never edit it.
 */
export function neighbors(board: Board, room: Room): Room[] {
  return indexOf(board).neighbors.get(room.id) ?? [];
}

export function degree(board: Board, room: Room): number {
  return neighbors(board, room).length;
}

export function cellCount(board: Board): number {
  return board.width * board.height;
}

/** Rubble: a cell no room owns. Impassable, unseeable, undrawable as floor. */
export function isRubble(board: Board, cell: number): boolean {
  return (board.cellRoom[cell] ?? '') === '';
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

  const index = indexOf(board);
  const key = `${fromId}>${toId}`;
  // `undefined` is "never asked"; a stored `null` is "asked, and there is no way".
  const answered = index.paths.get(key);
  if (answered !== undefined) return answered;

  const found = searchPath(board, fromId, toId);
  index.paths.set(key, found);
  return found;
}

function searchPath(board: Board, fromId: string, toId: string): string[] | null {
  const cameFrom = new Map<string, string>();
  const queue: Room[] = [getRoom(board, fromId)];
  const seen = new Set<string>([fromId]);

  /**
   * Walked with a head index rather than drained with `shift()`, which re-indexes
   * the whole queue on every pop and makes the search quadratic in the rooms it
   * visits — on the larger boards this model allows, that is most of the cost of
   * a search that is otherwise linear.
   */
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    if (!current) break;

    for (const next of neighbors(board, current)) {
      if (seen.has(next.id)) continue;
      seen.add(next.id);
      cameFrom.set(next.id, current.id);

      if (next.id === toId) {
        // Built back-to-front and reversed once, rather than unshifted at every
        // step: same path, without re-indexing the array for each room on it.
        const path: string[] = [next.id];
        let step = current.id;
        while (step !== fromId) {
          path.push(step);
          step = cameFrom.get(step) ?? fromId;
        }
        return path.reverse();
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
/**
 * Rooms within `steps` doorways, whether or not you can see into them.
 *
 * The counterpart to `lineOfSight`, and the difference is the whole reason this
 * exists: line of sight is *unbounded* along a straight open run, so it already
 * reveals every immediate neighbour of every room and a corridor all the way to its
 * end. What it never reveals is anything **around a corner**.
 *
 * That made "lights the rooms next door" a promise nothing could keep — see the note
 * on `torchReach`. A perk or a lamp that wants to push the dark back has to be
 * measured in steps, not in rays.
 */
export function withinSteps(board: Board, fromId: string, steps: number): Set<string> {
  const reached = new Set<string>([fromId]);
  if (steps <= 0) return reached;

  let frontier = [getRoom(board, fromId)];
  for (let depth = 0; depth < steps; depth++) {
    const next: Room[] = [];
    for (const room of frontier) {
      for (const other of neighbors(board, room)) {
        if (reached.has(other.id)) continue;
        reached.add(other.id);
        next.push(other);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return reached;
}

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
