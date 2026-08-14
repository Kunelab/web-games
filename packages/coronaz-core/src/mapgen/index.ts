import type { GameConfig } from '../config.js';
import { degree, distancesFrom, MAX_ROOM_CELLS, type Board, type Room, type RoomProgram } from '../map.js';
import { chance, pick, randInt, shuffled, type RngState } from '../rng.js';
import { partition } from './bsp.js';
import { borderOf, BoardBuilder, chunk, rectArea, rectCells, type Plot, type Rect } from './builder.js';
import { layoutDef, rollLayout } from './layouts.js';
import { buildingProgram, floorFor, roomList, type ProgramEntry } from './programs.js';

export { LAYOUTS, LAYOUT_IDS, layoutDef } from './layouts.js';
export { BUILDING_PROGRAMS, PROGRAM_LABELS, buildingProgram } from './programs.js';
export type { Rect, Plot, Plan, LayoutDef } from './builder.js';

/**
 * Building a world, in four passes.
 *
 * 1. **Plan** — a layout says where the streets run and where the buildings stand.
 * 2. **Carve** — outdoors becomes one continuous arch-joined space; each building
 *    is partitioned into spaces, one per room of its programme, and each space into
 *    rooms under the cell cap.
 * 3. **Connect** — a spanning tree of doors inside each building, entrances onto
 *    the street, and a repair pass that guarantees nothing is stranded.
 * 4. **Place** — the objectives, which now understand inside from outside: you
 *    arrive from the street and you leave by another one.
 *
 * The previous generator did one thing — carve the entire grid into rooms of one to
 * four cells — and that single decision is what made every raid a warren of
 * identical cupboards with no outdoors and no sense.
 */

/** Rooms whose programmes happily open onto each other without a door. */
const OPEN_PLAN: readonly RoomProgram[] = ['living', 'kitchen', 'hall', 'bar', 'lobby', 'canteen'];

export function generateBoard(rng: RngState, config: GameConfig): Board {
  const layout = config.layout === 'random' ? rollLayout(rng) : layoutDef(config.layout);
  const { width, height } = config;
  const builder = new BoardBuilder(width, height);
  const plan = layout.plan(rng, width, height);

  /* ------------------------------- 1. paint -------------------------------- */

  /** Which plot owns each cell; first claim wins, so plots may safely overlap. */
  const plotOf = new Array<number>(width * height).fill(-1);
  const plots: Plot[] = plan.plots.filter((plot) => rectArea(plot.rect) > 0);

  plots.forEach((plot, index) => {
    for (const cell of rectCells(clampRect(plot.rect, width, height), width)) {
      if (plotOf[cell] === -1) plotOf[cell] = index;
    }
  });

  // Whatever no plot wanted is outdoors: the gaps between buildings.
  const fillerIndex = plots.length;
  plots.push({ kind: 'outdoor', rect: { x: 0, y: 0, w: 0, h: 0 }, program: plan.filler });
  for (let cell = 0; cell < plotOf.length; cell++) {
    if (plotOf[cell] === -1) plotOf[cell] = fillerIndex;
  }

  /* ------------------------------- 2. carve -------------------------------- */

  const outdoorHue = randInt(rng, 360);

  // Outdoors, all of it at once: chunked into rooms and joined by arches, so a
  // street is one continuous space you can see and shoot down the length of.
  const outdoorCells: number[] = [];
  for (let cell = 0; cell < plotOf.length; cell++) {
    const plot = plots[plotOf[cell] ?? -1];
    if (plot?.kind === 'outdoor') outdoorCells.push(cell);
  }

  const outdoorRooms: Room[] = [];
  for (const piece of chunk(rng, outdoorCells, width)) {
    const first = piece[0] ?? 0;
    const plot = plots[plotOf[first] ?? -1];
    const program = plot?.program ?? plan.filler;
    outdoorRooms.push(
      builder.addRoom(piece, {
        program,
        floor: floorFor(rng, program),
        hue: outdoorHue,
        outdoor: true,
        zone: 0,
        decor: randInt(rng, 0xffffff)
      })
    );
  }

  /**
   * And now the part that makes it *outdoors*: every boundary between two outdoor
   * rooms is an arch, so there is no wall anywhere outside. A street is then one
   * continuous volume — you can see and shoot down the length of it — while still
   * costing a move per room to walk, which is the whole trick this generator rests
   * on. Without this the outdoors is a row of walled paddocks and the repair pass
   * quietly turns it into a maze of doorways.
   */
  const outdoorSet = new Set(outdoorCells);
  for (const room of outdoorRooms) {
    for (const { inside, outside } of borderOf(room.cells, width, height)) {
      if (!outdoorSet.has(outside)) continue;
      if (builder.roomIdAt(outside) === room.id) continue;
      builder.setEdge(inside, outside, 'arch');
    }
  }

  // Buildings, one at a time.
  const buildings: { zone: number; rooms: Room[]; cells: Set<number> }[] = [];

  for (const plot of plots) {
    if (plot.kind !== 'building') continue;
    const rect = clampRect(plot.rect, width, height);
    const cells = rectCells(rect, width).filter((cell) => !builder.claimed(cell));
    if (cells.length < 2) continue;

    const built = carveBuilding(rng, builder, rect, cells, plot.building ?? 'house');
    if (built) buildings.push(built);
  }

  // A cell inside a building footprint that lost its plot to an earlier claim can
  // leave a room's interior boundaries stale; one pass fixes all of them.
  builder.sealInterior();

  /* ------------------------------ 3. connect ------------------------------- */

  for (const building of buildings) {
    connectEntrances(rng, builder, building);
  }

  const board = repairConnectivity(rng, builder, layout.id);

  /* ------------------------------- 4. place -------------------------------- */

  placeObjectives(rng, board, config);
  return board;
}

function clampRect(rect: Rect, width: number, height: number): Rect {
  const x = Math.max(0, Math.min(width - 1, rect.x));
  const y = Math.max(0, Math.min(height - 1, rect.y));
  return {
    x,
    y,
    w: Math.max(0, Math.min(width - x, rect.w)),
    h: Math.max(0, Math.min(height - y, rect.h))
  };
}

/**
 * One building: partitioned into spaces, each space given a programme and split
 * into rooms, then wired together with doors.
 */
function carveBuilding(
  rng: RngState,
  builder: BoardBuilder,
  rect: Rect,
  cells: number[],
  programId: string
): { zone: number; rooms: Room[]; cells: Set<number> } | null {
  const program = buildingProgram(programId);
  const wanted = roomList(rng, program);
  const grain = program.grain ?? 3;
  const target = Math.max(1, Math.min(wanted.length, Math.floor(cells.length / grain) || 1));

  const owned = new Set(cells);
  const spaces = partition(rng, rect, { target, minSide: 1, minArea: 2 })
    .map((space) => rectCells(space, builder.width).filter((cell) => owned.has(cell)))
    .filter((space) => space.length > 0);
  if (spaces.length === 0) return null;

  /* Which spaces touch which, for the programme's shape preferences and the doors. */
  const spaceOf = new Map<number, number>();
  spaces.forEach((space, index) => {
    for (const cell of space) spaceOf.set(cell, index);
  });

  const adjacency: Set<number>[] = spaces.map(() => new Set<number>());
  for (const [cell, index] of spaceOf) {
    for (const { outside } of borderOf([cell], builder.width, builder.height)) {
      const other = spaceOf.get(outside);
      if (other !== undefined && other !== index) {
        adjacency[index]?.add(other);
        adjacency[other]?.add(index);
      }
    }
  }

  /* Hand out the programme. Preferences first, then whatever is left. */
  const assignment = assignPrograms(rng, spaces, adjacency, wanted);

  const zone = builder.nextZone();
  const hue = randInt(rng, 360);
  const rooms: Room[] = [];

  spaces.forEach((space, index) => {
    const program = assignment[index] ?? 'storage';
    const floor = floorFor(rng, program);
    // A space bigger than a room becomes several rooms joined by arches: one
    // volume to the eye, several moves to the rules.
    const pieces = chunk(rng, space, builder.width, MAX_ROOM_CELLS);
    const made = pieces.map((piece) =>
      builder.addRoom(piece, {
        program,
        floor,
        hue,
        outdoor: false,
        zone,
        decor: randInt(rng, 0xffffff)
      })
    );
    rooms.push(...made);

    // Arches between the pieces of one space.
    for (const room of made) {
      for (const { inside, outside } of borderOf(room.cells, builder.width, builder.height)) {
        const otherId = builder.roomIdAt(outside);
        if (!otherId || otherId === room.id) continue;
        if (made.some((sibling) => sibling.id === otherId)) {
          builder.setEdge(inside, outside, 'arch');
        }
      }
    }
  });

  /* Doors between spaces: a spanning tree, plus a few extra ways round. */
  const seen = new Set<number>([0]);
  const frontier = [0];
  const openBetween = (a: number, b: number) => {
    const kind =
      OPEN_PLAN.includes(assignment[a] ?? 'storage') &&
      OPEN_PLAN.includes(assignment[b] ?? 'storage') &&
      chance(rng, 0.65)
        ? 'arch'
        : 'door';

    const options: { inside: number; outside: number }[] = [];
    for (const cell of spaces[a] ?? []) {
      for (const { outside } of borderOf([cell], builder.width, builder.height)) {
        if (spaceOf.get(outside) === b) options.push({ inside: cell, outside });
      }
    }
    if (options.length === 0) return;
    if (kind === 'arch') {
      // An arch takes the whole shared wall; a door takes one cell of it.
      for (const option of options) builder.setEdge(option.inside, option.outside, 'arch');
    } else {
      const option = pick(rng, options);
      builder.setEdge(option.inside, option.outside, 'door');
    }
  };

  while (frontier.length > 0) {
    const current = frontier.pop();
    if (current === undefined) continue;
    for (const next of shuffled(rng, [...(adjacency[current] ?? [])])) {
      if (seen.has(next)) continue;
      seen.add(next);
      openBetween(current, next);
      frontier.push(next);
    }
  }
  // Spaces the tree could not reach (partitioned into an island by a claim
  // conflict) still get a way in.
  spaces.forEach((_, index) => {
    if (seen.has(index)) return;
    const neighbour = [...(adjacency[index] ?? [])][0];
    if (neighbour !== undefined) {
      openBetween(index, neighbour);
      seen.add(index);
    }
  });

  for (let a = 0; a < spaces.length; a++) {
    for (const b of adjacency[a] ?? []) {
      if (b <= a) continue;
      if (chance(rng, 0.18)) openBetween(a, b);
    }
  }

  return { zone, rooms, cells: owned };
}

/**
 * Gives each space a programme, honouring what each room wants: the living room
 * takes the biggest space, the bathroom a dead end, the corridor the busiest
 * junction. It is the difference between a flat and four rooms in a row.
 */
function assignPrograms(
  rng: RngState,
  spaces: number[][],
  adjacency: Set<number>[],
  wanted: ProgramEntry[]
): RoomProgram[] {
  const assignment: RoomProgram[] = new Array<RoomProgram>(spaces.length);
  const free = new Set(spaces.map((_, index) => index));

  const score = (index: number, wants: ProgramEntry['wants']): number => {
    const size = spaces[index]?.length ?? 0;
    const links = adjacency[index]?.size ?? 0;
    if (wants === 'big') return size * 10 - links;
    if (wants === 'hub') return links * 10 + size;
    if (wants === 'dead-end') return -links * 10 - size;
    return 0;
  };

  const ordered = [
    ...wanted.filter((entry) => entry.wants === 'big'),
    ...wanted.filter((entry) => entry.wants === 'hub'),
    ...wanted.filter((entry) => entry.wants === 'dead-end'),
    ...wanted.filter((entry) => !entry.wants)
  ];

  for (const entry of ordered) {
    if (free.size === 0) break;
    const candidates = shuffled(rng, [...free]);
    const best = entry.wants
      ? candidates.reduce((a, b) => (score(b, entry.wants) > score(a, entry.wants) ? b : a))
      : candidates[0];
    if (best === undefined) break;
    assignment[best] = entry.program;
    free.delete(best);
  }

  // More spaces than the programme asked for: fill with its plainest rooms.
  const filler = wanted.filter((entry) => !entry.wants).map((entry) => entry.program);
  for (const index of free) {
    assignment[index] = filler.length > 0 ? pick(rng, filler) : 'storage';
  }

  return assignment;
}

/**
 * Ways in. A building wants one or two doors onto the outdoors, preferably from
 * somewhere public; if it has no outdoor neighbour at all (hemmed in by other
 * buildings) it settles for a door into its neighbour.
 */
function connectEntrances(
  rng: RngState,
  builder: BoardBuilder,
  building: { zone: number; rooms: Room[]; cells: Set<number> }
): void {
  const publicFirst = [...building.rooms].sort((a, b) => rank(b.program) - rank(a.program));

  const outward: { inside: number; outside: number; room: Room }[] = [];
  const inward: { inside: number; outside: number; room: Room }[] = [];

  for (const room of publicFirst) {
    for (const { inside, outside } of borderOf(room.cells, builder.width, builder.height)) {
      if (building.cells.has(outside)) continue;
      const otherId = builder.roomIdAt(outside);
      if (!otherId) continue;
      const other = builder.allRooms().find((candidate) => candidate.id === otherId);
      if (!other) continue;
      (other.outdoor ? outward : inward).push({ inside, outside, room });
    }
  }

  const doors = outward.length > 0 ? outward : inward;
  if (doors.length === 0) return;

  const wanted = 1 + (doors.length > 6 && chance(rng, 0.6) ? 1 : 0);
  const chosen = shuffled(rng, doors).slice(0, wanted);
  // Prefer the most public room among the shuffled candidates for the front door.
  chosen.sort((a, b) => rank(b.room.program) - rank(a.room.program));
  for (const door of chosen) builder.setEdge(door.inside, door.outside, 'door');
}

/** How willing a room is to be the way in. A bathroom is not a front door. */
function rank(program: RoomProgram): number {
  if (program === 'lobby' || program === 'hall') return 5;
  if (program === 'corridor') return 4;
  if (program === 'living' || program === 'bar' || program === 'dock') return 3;
  if (program === 'storage' || program === 'workshop' || program === 'canteen') return 2;
  if (program === 'bath' || program === 'restroom' || program === 'bedroom') return 0;
  return 1;
}

/**
 * The guarantee: everything is reachable from everything, or a door is punched
 * until it is. The 2020 original rolled independent doors and could strand a whole
 * region, and a stranded key is an unwinnable raid.
 *
 * Each repair returns a *fresh* board rather than editing one in place, because the
 * board's derived indexes (room lookup, adjacency) are cached against the object's
 * identity — mutating its edges under that cache would leave the next pass reading
 * yesterday's doors.
 */
function repairConnectivity(rng: RngState, builder: BoardBuilder, layout: string): Board {
  let board = builder.freeze(layout);

  for (let guard = 0; guard < 64; guard++) {
    const rooms = board.rooms;
    const first = rooms[0];
    if (!first) return board;

    const reached = distancesFrom(board, first.id);
    if (reached.size === rooms.length) return board;

    // Any stranded room that touches a reached one gets a door.
    let opened = false;
    for (const room of shuffled(rng, rooms)) {
      if (reached.has(room.id)) continue;
      for (const { inside, outside } of borderOf(room.cells, board.width, board.height)) {
        const otherId = board.cellRoom[outside];
        if (!otherId || !reached.has(otherId)) continue;
        builder.setEdge(inside, outside, 'door');
        opened = true;
        break;
      }
      if (opened) break;
    }
    if (!opened) return board; // Genuinely disjoint geometry; nothing more to do.
    board = builder.freeze(layout);
  }

  return board;
}

/**
 * Where the objectives go, now that the world has an inside and an outside.
 *
 * You arrive from the street and you leave by another one — which is what
 * "escape" always meant and what a board of nothing but rooms could not express.
 * The keys are indoors, in the busier rooms, spread across different buildings so
 * collecting them is a tour rather than a visit. The horde comes out of the quiet
 * places: back rooms, alleys, cellars.
 */
function placeObjectives(rng: RngState, board: Board, config: GameConfig): void {
  const outdoor = board.rooms.filter((room) => room.outdoor);
  const indoor = board.rooms.filter((room) => !room.outdoor);

  const onBorder = (room: Room) =>
    room.cells.some((cell) => {
      const x = cell % board.width;
      const y = Math.floor(cell / board.width);
      return x === 0 || y === 0 || x === board.width - 1 || y === board.height - 1;
    });

  /* --------------------------------- start --------------------------------- */

  const gates = outdoor.filter(onBorder);
  const start = gates.length > 0 ? pick(rng, gates) : pick(rng, board.rooms);
  start.kind = 'start';

  /* ---------------------------------- exit --------------------------------- */

  // One walk of the graph answers "how far from the start" for the whole board.
  const distance = distancesFrom(board, start.id);
  const far = (room: Room) => distance.get(room.id) ?? -1;
  const exitPool = (gates.length > 1 ? gates : outdoor.length > 0 ? outdoor : board.rooms).filter(
    (room) => room.id !== start.id
  );
  const exit = exitPool.length > 0 ? exitPool.reduce((a, b) => (far(b) > far(a) ? b : a)) : undefined;
  if (exit) exit.kind = 'exit';

  /* ---------------------------------- keys --------------------------------- */

  const keyPool = (indoor.length >= config.keys ? indoor : board.rooms).filter((room) => room.kind === 'normal');
  // Busiest rooms first, but never two keys in one building while another has none.
  const byZone = new Map<number, Room[]>();
  for (const room of shuffled(rng, keyPool).sort((a, b) => degree(board, b) - degree(board, a))) {
    const list = byZone.get(room.zone) ?? [];
    list.push(room);
    byZone.set(room.zone, list);
  }
  const zones = shuffled(rng, [...byZone.keys()]);
  let placed = 0;
  for (let round = 0; placed < config.keys && round < 8; round++) {
    for (const zone of zones) {
      if (placed >= config.keys) break;
      const room = byZone.get(zone)?.[round];
      if (!room) continue;
      room.hasKey = true;
      placed += 1;
    }
  }

  /* --------------------------------- spawns -------------------------------- */

  const spawnPool = board.rooms
    .filter((room) => room.kind === 'normal' && !room.hasKey)
    .sort((a, b) => {
      // Quiet, and away from where the survivors start.
      const quiet = degree(board, a) - degree(board, b);
      if (quiet !== 0) return quiet;
      return far(b) - far(a);
    });
  for (const room of spawnPool.slice(0, config.spawnRooms)) {
    room.kind = 'spawn';
  }
}

/** One line describing a generated world, for the log and the end screen. */
export function boardSummary(board: Board): string {
  const outdoor = board.rooms.filter((room) => room.outdoor).length;
  const zones = new Set(board.rooms.filter((room) => !room.outdoor).map((room) => room.zone));
  return `${board.rooms.length} salles · ${zones.size} bâtiment(s) · ${Math.round(
    (outdoor / Math.max(1, board.rooms.length)) * 100
  )} % dehors`;
}
