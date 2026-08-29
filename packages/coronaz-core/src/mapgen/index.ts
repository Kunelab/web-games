import type { GameConfig } from '../config.js';
import {
  degree,
  distancesFrom,
  lineOfSight,
  MAX_ROOM_CELLS,
  neighbors,
  type Board,
  type Room,
  type RoomProgram
} from '../map.js';
import { chance, pick, randInt, shuffled, type RngState } from '../rng.js';
import { partition } from './bsp.js';
import { borderOf, BoardBuilder, chunk, rectArea, rectCells, tileRects, type Plot, type Rect } from './builder.js';
import { BIOME_IDS, biomeDef } from '../content/registry.js';
import { layoutDef, rollLayout } from './layouts.js';
import {
  BUILDING_PROGRAMS,
  buildingProgram,
  floorFor,
  isStructural,
  findsFor,
  lootBonusFor,
  START_FINDS,
  SHINY_LOOT,
  MAX_CLUSTER_ROOMS,
  maxClusters,
  overflowOf,
  roomBudget,
  roomList,
  type ProgramEntry
} from './programs.js';

export { LAYOUTS, LAYOUT_IDS, layoutDef } from './layouts.js';
export { BUILDING_PROGRAMS, PROGRAM_LABELS, SHINY_LOOT, buildingProgram, findsFor, lootBonusFor } from './programs.js';
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

/**
 * Rooms whose programmes happily open onto each other without a door.
 *
 * Kept short on purpose. With kitchens and canteens in here as well, and a high
 * chance of taking it, a building's interior lost nearly all of its walls and came
 * out reading as a hangar with furniture in it. A living room opening onto a hall
 * is a house; every room opening onto every other room is a warehouse.
 */
const OPEN_PLAN: readonly RoomProgram[] = ['living', 'hall', 'bar', 'lobby'];

export function generateBoard(rng: RngState, config: GameConfig): Board {
  const layout = config.layout === 'random' ? rollLayout(rng) : layoutDef(config.layout);
  const { width, height } = config;
  const builder = new BoardBuilder(width, height);
  const plan = layout.plan(rng, width, height);

  /* ------------------------------- 1. paint -------------------------------- */

  /**
   * Rubble, chosen before anything else is carved.
   *
   * A district of nothing but usable floor reads as a film set. Collapsed blocks
   * give a world edges and dead ends that were not designed room by room — and
   * because they are chosen *first*, every later pass simply flows around them and
   * the connectivity guarantee covers whatever is left.
   *
   * Placed as blobs rather than as speckle: single scattered holes look like
   * missing tiles, while a four-cell heap of masonry looks like a building came
   * down. Never on the border ring, so the world always has a way round.
   */
  const rubble = new Set<number>();

  /**
   * The district's outline, cut before anything is built inside it.
   *
   * The size in the config is a *bounding box*, not a floor plan, and a world
   * that fills its box to the corner every time is the one thing every map in
   * this game had in common. A district is bounded by whatever the district is
   * next to — a river, a rail cutting, a motorway, the edge of the fire — so its
   * outline is allowed to be a wedge, an L, or a ragged bank, and the raid inside
   * it is a different shape for it.
   *
   * Cut as rubble because rubble is already the word for "no cell here": every
   * later pass flows around it, so an outline costs nothing but this decision.
   */
  {
    const area = width * height;
    const outline: number[] = [];
    const shave = (keep: (x: number, y: number) => boolean): void => {
      for (let cell = 0; cell < area; cell++) {
        if (!keep(cell % width, Math.floor(cell / width))) outline.push(cell);
      }
    };

    /** A ragged edge, walked rather than ruled, so it reads as erosion. */
    const bank = (along: 'top' | 'bottom' | 'left' | 'right'): void => {
      const span = along === 'top' || along === 'bottom' ? width : height;
      const limit = Math.max(2, Math.floor((along === 'top' || along === 'bottom' ? height : width) * 0.22));
      let depth = 1 + randInt(rng, limit);
      const depths: number[] = [];
      for (let index = 0; index < span; index++) {
        depth = Math.max(0, Math.min(limit, depth + randInt(rng, 3) - 1));
        depths.push(depth);
      }
      shave((x, y) => {
        const cut = depths[along === 'top' || along === 'bottom' ? x : y] ?? 0;
        if (along === 'top') return y >= cut;
        if (along === 'bottom') return y < height - cut;
        if (along === 'left') return x >= cut;
        return x < width - cut;
      });
    };

    const style = pick(rng, ['bloc', 'coin', 'coin', 'biseau', 'biseau', 'triangle', 'berge', 'berge'] as const);
    const sides = ['top', 'bottom', 'left', 'right'] as const;

    if (style === 'coin') {
      // A block taken out of one corner: the district turns a corner instead of
      // filling a rectangle.
      const cw = Math.max(3, Math.floor(width * (0.25 + randInt(rng, 3) * 0.06)));
      const ch = Math.max(3, Math.floor(height * (0.25 + randInt(rng, 3) * 0.06)));
      const cx = chance(rng, 0.5) ? 0 : width - cw;
      const cy = chance(rng, 0.5) ? 0 : height - ch;
      shave((x, y) => !(x >= cx && x < cx + cw && y >= cy && y < cy + ch));
    } else if (style === 'biseau') {
      // One or two corners taken off on the diagonal.
      const count = 1 + randInt(rng, 2);
      const chosen = shuffled(rng, [0, 1, 2, 3]).slice(0, count);
      const depth = Math.max(5, Math.floor(Math.min(width, height) * (0.34 + randInt(rng, 3) * 0.05)));
      for (const corner of chosen) {
        const cx = corner % 2 === 0 ? 0 : width - 1;
        const cy = corner < 2 ? 0 : height - 1;
        shave((x, y) => Math.abs(x - cx) + Math.abs(y - cy) >= depth);
      }
    } else if (style === 'triangle') {
      // A whole diagonal edge: the wedge between two roads that never met.
      const flipX = chance(rng, 0.5);
      const flipY = chance(rng, 0.5);
      const slack = 1.2 + randInt(rng, 4) * 0.08;
      shave((x, y) => {
        const nx = (flipX ? width - 1 - x : x) / Math.max(1, width - 1);
        const ny = (flipY ? height - 1 - y : y) / Math.max(1, height - 1);
        return nx + ny < slack;
      });
    } else if (style === 'berge') {
      for (const along of shuffled(rng, [...sides]).slice(0, 1 + randInt(rng, 2))) bank(along);
    }

    /**
     * And a floor under it. An outline that ate most of the box would leave a
     * district too small to lose anybody in, so a greedy roll is simply refused
     * and the block stands.
     */
    if (outline.length <= area * 0.34) {
      for (const cell of outline) rubble.add(cell);
    }
  }

  {
    /**
     * Debris is measured against the district, not against the box.
     *
     * The two are different things that happen to be stored in the same set: the
     * outline is where the district *is not*, and rubble is what fell down inside
     * it. Budgeting them together made the shape self-cancelling — a wedge cut
     * from the corner simply bought fewer collapsed blocks elsewhere, and the
     * amount of standing floor came out the same however the district was shaped.
     */
    const standing = width * height - rubble.size;
    const wanted = rubble.size + Math.floor(standing * config.rubble);

    /**
     * Whether every free cell can still reach every other one.
     *
     * This is the whole reason rubble is placed a blob at a time and checked: a
     * heap of masonry across the wrong alley cuts a district in half, and the
     * connectivity repair further down cannot help — it opens *doors between
     * rooms*, and rubble is not a room. A blob that would split the world is put
     * back.
     */
    const stillWhole = (): boolean => {
      let start = -1;
      let free = 0;
      for (let cell = 0; cell < width * height; cell++) {
        if (rubble.has(cell)) continue;
        free += 1;
        if (start === -1) start = cell;
      }
      if (start === -1) return false;

      const seen = new Set<number>([start]);
      const queue = [start];
      while (queue.length > 0) {
        const cell = queue.pop();
        if (cell === undefined) continue;
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
          if (rubble.has(next) || seen.has(next)) continue;
          seen.add(next);
          queue.push(next);
        }
      }
      return seen.size === free;
    };

    let guard = 0;
    while (rubble.size < wanted && guard++ < 300) {
      const blob: number[] = [];
      let x = 1 + randInt(rng, Math.max(1, width - 2));
      let y = 1 + randInt(rng, Math.max(1, height - 2));
      const size = 2 + randInt(rng, 4);
      for (let step = 0; step < size && rubble.size + blob.length < wanted; step++) {
        if (x <= 0 || y <= 0 || x >= width - 1 || y >= height - 1) break;
        const cell = y * width + x;
        if (!rubble.has(cell)) blob.push(cell);
        if (chance(rng, 0.5)) x += chance(rng, 0.5) ? 1 : -1;
        else y += chance(rng, 0.5) ? 1 : -1;
      }
      if (blob.length === 0) continue;

      for (const cell of blob) rubble.add(cell);
      if (!stillWhole()) {
        for (const cell of blob) rubble.delete(cell);
      }
    }
  }

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

  // Outdoors, all of it at once: cut into rectangles and joined by arches, so a
  // street is one continuous space you can see and shoot down the length of.
  const outdoorCells: number[] = [];
  for (let cell = 0; cell < plotOf.length; cell++) {
    if (rubble.has(cell)) continue;
    const plot = plots[plotOf[cell] ?? -1];
    if (plot?.kind === 'outdoor') outdoorCells.push(cell);
  }

  /**
   * One tiling pass per outdoor programme, not one for the whole outdoors.
   *
   * Tiling everything together would hand out 2×2 blocks that straddle the kerb,
   * half road and half pavement, and then the room would have to pick one floor and
   * lie about the other half. Per programme, every rectangle is all road or all
   * pavement, which is what makes a street look like a street from above.
   */
  const outdoorRooms: Room[] = [];
  const byProgram = new Map<number, number[]>();
  for (const cell of outdoorCells) {
    const index = plotOf[cell] ?? -1;
    const list = byProgram.get(index);
    if (list) list.push(cell);
    else byProgram.set(index, [cell]);
  }

  const outdoorPieces: number[][] = [];
  for (const [index, cells] of byProgram) {
    // Open ground gets the coarse tiling; roads and pavements do not. See tileRects.
    const program = plots[index]?.program ?? plan.filler;
    const open = program === 'square' || program === 'park' || program === 'yard';
    outdoorPieces.push(...tileRects(rng, cells, width, open));
  }

  for (const piece of outdoorPieces) {
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

  /**
   * Which building programmes a wing may draw from.
   *
   * The biome's own list when it is known, and every programme when it is not: a
   * board can be generated before the biome is resolved (the config still says
   * 'random' at that point), and a wing's programme is flavour rather than a rule, so
   * falling back is better than refusing to build.
   */
  const allowed = BIOME_IDS.includes(config.biome)
    ? biomeDef(config.biome).buildings
    : BUILDING_PROGRAMS.map((entry) => entry.id);

  for (const plot of plots) {
    if (plot.kind !== 'building') continue;
    // A plot far bigger than its programme can furnish becomes wings; see below.
    for (const wing of splitOversized(rng, clampRect(plot.rect, width, height), plot.building ?? 'house', allowed)) {
      const rect = clampRect(wing.rect, width, height);
      const cells = rectCells(rect, width).filter((cell) => !builder.claimed(cell) && !rubble.has(cell));
      if (cells.length < 2) continue;

      const built = carveBuilding(rng, builder, rect, cells, wing.building);
      if (built) buildings.push(built);
    }
  }

  // A cell inside a building footprint that lost its plot to an earlier claim can
  // leave a room's interior boundaries stale; one pass fixes all of them.
  builder.sealInterior();

  /* ------------------------------ 3. connect ------------------------------- */

  for (const building of buildings) {
    connectEntrances(rng, builder, building);
    // Windows after the doors, on whatever shell is still solid: see glazeShell.
    glazeShell(rng, builder, building);
  }

  const board = repairConnectivity(rng, builder, layout.id);
  // Last, because a cluster is whatever ended up touching: see trimClusters.
  trimClusters(board, rng);

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
 * Splits a plot that is too big for its programme into wings joined by a corridor.
 *
 * A building programme names about a dozen rooms and allows a couple of clusters of
 * each, so it can furnish roughly twenty spaces before it runs out of things to be.
 * Hand it a plot with sixty spaces in it and fifty of them become corridor: measured
 * at 62 % of a bunker and 63 % of a nightclub, both of which were single plots
 * covering most of the board.
 *
 * The fix is not more generous budgets, because the budgets are the thing keeping a
 * hospital from being eight pharmacies. It is that an oversized plot is not one
 * building. So it is cut, across its long axis, into wings small enough for a
 * programme each, with a one-cell corridor between them: different rooms end up
 * separated by a hallway, which is what a real complex looks like from above and what
 * makes the difference between wings legible at all.
 *
 * Returns one rect and programme per wing, plus the spines. The caller carves each as
 * an ordinary building, so nothing downstream needs to know this happened.
 */
function splitOversized(
  rng: RngState,
  rect: Rect,
  programId: string,
  alternatives: readonly string[]
): { rect: Rect; building: string }[] {
  const program = buildingProgram(programId);
  const grain = program.grain ?? 3;
  const capacity = maxClusters(program);
  const wants = rectArea(rect) / grain;
  // 1.6 rather than 1: a programme should be stretched a little before it is split,
  // or every ordinary building would come out as two half-buildings.
  if (!Number.isFinite(capacity) || wants <= capacity * 1.6) {
    return [{ rect, building: programId }];
  }

  const across = rect.w >= rect.h;
  const span = across ? rect.h : rect.w;
  const wings = Math.max(2, Math.min(4, Math.round(wants / capacity)));
  const spine = 1;
  const depth = Math.floor((span - spine * (wings - 1)) / wings);
  if (depth < 3) return [{ rect, building: programId }];

  /**
   * The first wing keeps the plot's own programme, so a nightclub is still a
   * nightclub; the rest draw from what the biome allows, without replacement, so the
   * wings are different kinds of place rather than the same one twice.
   */
  const pool = shuffled(rng, alternatives.filter((id) => id !== programId && id !== 'spine'));
  const out: { rect: Rect; building: string }[] = [];
  let at = across ? rect.y : rect.x;

  for (let i = 0; i < wings; i++) {
    const size = i === wings - 1 ? (across ? rect.y + rect.h : rect.x + rect.w) - at : depth;
    if (size < 3) break;
    out.push({
      rect: across ? { x: rect.x, y: at, w: rect.w, h: size } : { x: at, y: rect.y, w: size, h: rect.h },
      building: i === 0 ? programId : (pool[(i - 1) % Math.max(1, pool.length)] ?? programId)
    });
    at += size;

    if (i < wings - 1 && at + spine <= (across ? rect.y + rect.h : rect.x + rect.w)) {
      out.push({
        rect: across ? { x: rect.x, y: at, w: rect.w, h: spine } : { x: at, y: rect.y, w: spine, h: rect.h },
        building: 'spine'
      });
      at += spine;
    }
  }

  return out.length > 0 ? out : [{ rect, building: programId }];
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
  const grain = program.grain ?? 3;
  /**
   * How many spaces the building is cut into, and the cap on any one of them.
   *
   * The target used to be capped at the length of the programme's room list, which
   * is what produced the fifty-laboratory facility: twelve spaces over a 484-cell
   * board is forty cells each, and a forty-cell space becomes a dozen rooms that all
   * inherit one programme. The building's *area* decides how many spaces it has now,
   * and `maxArea` guarantees no space is ever more than one cluster's worth.
   */
  const target = Math.max(1, Math.min(Math.floor(cells.length / grain) || 1, maxClusters(program)));
  const wanted = roomList(rng, program, target);

  const owned = new Set(cells);
  const spaces = partition(rng, rect, {
    target,
    minSide: 1,
    minArea: 2,
    /**
     * A space is cut down to about five rooms' worth, not ten.
     *
     * Ten is the ceiling a *cluster* may reach, not the size a space should be aimed
     * at. Aiming at the ceiling meant every space overshot the programme's own budget
     * for that room (a storeroom is six, a bedroom three), so the trim pass turned
     * the overflow into hallway and a bunker came out 62 % corridor: more space was
     * being demoted than assigned. Five is under every budget that matters, so the
     * trim pass goes back to being a guard rather than a bulldozer.
     */
    maxArea: 5 * MAX_ROOM_CELLS
  })
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
    /**
     * A room's own shade of the building's colour. The building keeps one hue so
     * it reads as one place, but every room sharing it exactly made an interior
     * look like one continuous grey shed — a few degrees of drift is the
     * difference between a house and a hangar.
     */
    const roomHue = (hue + randInt(rng, 17) - 8 + 360) % 360;
    /**
     * A space bigger than a room becomes several rooms joined by arches: one volume
     * to the eye, several moves to the rules. That run of rooms is the *cluster*, and
     * this is where its ceiling is enforced: past it, the rooms take the plainest
     * plausible neighbour instead, so a cluster tapers off rather than the building
     * losing its space.
     */
    const pieces = chunk(rng, space, builder.width, MAX_ROOM_CELLS);
    const ceiling = roomBudget(program).rooms;
    const made = pieces.map((piece, order) => {
      const own = order < ceiling ? program : overflowOf(program);
      return builder.addRoom(piece, {
        program: own,
        floor: own === program ? floor : floorFor(rng, own),
        hue: roomHue,
        outdoor: false,
        zone,
        decor: randInt(rng, 0xffffff)
      });
    });
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
      chance(rng, 0.45)
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
      if (chance(rng, 0.62)) openBetween(a, b);
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

  /**
   * How many clusters of each programme this building already has.
   *
   * One space is one cluster, so counting assignments is counting clusters. A
   * programme that has spent its budget is skipped rather than squeezed in, which is
   * what stops a hospital being eight pharmacies; structural programmes have no
   * budget to spend, because corridors are how the building holds together.
   */
  const used = new Map<RoomProgram, number>();
  const spent = (program: RoomProgram): boolean =>
    !isStructural(program) && (used.get(program) ?? 0) >= roomBudget(program).clusters;
  const take = (index: number, program: RoomProgram): void => {
    assignment[index] = program;
    used.set(program, (used.get(program) ?? 0) + 1);
    free.delete(index);
  };

  /**
   * Two clusters of the same room may not touch, or they are one cluster.
   *
   * The per-space ceiling bounds a cluster only if a cluster *is* a space. Three
   * storerooms of six that happened to be partitioned next to each other merged into
   * one run of twenty-one rooms, which is the thing the ceiling exists to prevent,
   * measured on the bunker and the venue. Structural programmes are exempt: corridors
   * are supposed to join up, that is what makes them corridors.
   */
  const touches = (index: number, program: RoomProgram): boolean => {
    if (isStructural(program)) return false;
    for (const other of adjacency[index] ?? []) {
      if (assignment[other] === program) return true;
    }
    return false;
  };

  for (const entry of ordered) {
    if (free.size === 0) break;
    if (spent(entry.program)) continue;
    const candidates = shuffled(rng, [...free]).filter((index) => !touches(index, entry.program));
    if (candidates.length === 0) continue;
    const best = entry.wants
      ? candidates.reduce((a, b) => (score(b, entry.wants) > score(a, entry.wants) ? b : a))
      : candidates[0];
    if (best === undefined) break;
    take(best, entry.program);
  }

  /**
   * More spaces than the programme could spend: the rest become circulation.
   *
   * Corridors rather than a random plain room, deliberately. A building whose
   * leftovers are all storerooms reads as a warehouse; one whose leftovers are
   * hallways reads as a building with hallways in it, which is what the leftover
   * space between a programme's rooms actually is.
   */
  const filler = wanted.filter((entry) => !entry.wants).map((entry) => entry.program);
  for (const index of free) {
    const plain = filler.filter((program) => !spent(program) && !touches(index, program));
    assignment[index] = plain.length > 0 && chance(rng, 0.35) ? pick(rng, plain) : 'corridor';
    if (assignment[index] !== 'corridor') {
      used.set(assignment[index], (used.get(assignment[index]) ?? 0) + 1);
    }
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

  const wanted = 2 + (doors.length > 4 ? 1 + (chance(rng, 0.5) ? 1 : 0) : 0);
  const chosen = shuffled(rng, doors).slice(0, wanted);
  // Prefer the most public room among the shuffled candidates for the front door.
  chosen.sort((a, b) => rank(b.room.program) - rank(a.room.program));
  for (const door of chosen) builder.setEdge(door.inside, door.outside, 'door');
}

/**
 * Glazes a building's outward-facing walls.
 *
 * Run after the doors, on whatever shell is still solid, and only where the outside
 * is genuinely outside: a window onto a neighbour's storeroom is a hole in two
 * buildings, not a window.
 *
 * The rate matters more than it looks. Every pane is a line of sight *and* a line of
 * fire, in both directions, so glazing a whole façade would turn every street into a
 * shooting gallery and every shop into a fishbowl. About half the eligible wall,
 * biased towards the rooms people would put a window in, gives a building openings
 * you can plan around rather than a curtain wall you cannot avoid.
 *
 * Half rather than the third it started at, because the supply of eligible wall is
 * much smaller than it looks: a building's sides that lie on the edge of the board
 * have nothing outside them to see, and in a town most of a block's buildings are
 * hemmed in by other buildings. A third of the eligible wall came out as twelve
 * windows on a whole 22x22 town, which is not a town with windows in it.
 *
 * A bathroom gets frosted glass in real life and none here, for the same reason it
 * does not get the front door: the point of the room is that you cannot see into it.
 */
function glazeShell(
  rng: RngState,
  builder: BoardBuilder,
  building: { zone: number; rooms: Room[]; cells: Set<number> }
): void {
  for (const room of building.rooms) {
    // How willing this kind of room is to have a window at all.
    const appetite =
      room.program === 'bath' || room.program === 'restroom' || room.program === 'cell'
        ? 0
        : room.program === 'living' || room.program === 'bedroom' || room.program === 'ward'
          ? 0.72
          : room.program === 'storage' || room.program === 'archive' || room.program === 'armoury'
            ? 0.15
            : 0.48;
    if (appetite === 0) continue;

    for (const { inside, outside } of borderOf(room.cells, builder.width, builder.height)) {
      if (building.cells.has(outside)) continue;
      // Only a wall becomes glass: never a door, an arch, or the edge of the board.
      if (builder.edgeBetween(inside, outside) !== 'wall') continue;
      const otherId = builder.roomIdAt(outside);
      if (!otherId) continue;
      const other = builder.allRooms().find((candidate) => candidate.id === otherId);
      if (!other?.outdoor) continue;

      if (chance(rng, appetite)) builder.setEdge(inside, outside, 'window');
    }
  }
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
/**
 * Trims any run of same-programme rooms back to the cluster ceiling.
 *
 * Everything upstream *tries* to keep a cluster small: the partition bounds a space,
 * the assignment refuses to put two clusters of one room next to each other, and the
 * split re-labels rooms past the ceiling. None of that is a guarantee, because a
 * cluster is an emergent thing: it is whatever ends up touching. Two capped
 * storerooms plus the overflow of a third merged into a run of fifteen, measured on
 * the venue after all three of those rules were in.
 *
 * So this is the post-condition, applied last and measured by a test: walk each run
 * of touching same-programme rooms, and enforce *both* numbers on it. Past the size
 * ceiling the extra rooms become corridor; past the cluster count the whole run does.
 * The count needs enforcing here as well as at assignment because the overflow of a
 * capped cluster can invent a new one behind the assignment's back: an armoury's
 * overflow becomes archive, and that was how a police station ended up with three
 * archive clusters against a budget of two.
 *
 * A corridor is the honest thing for a room to be when the building has run out of
 * reasons for it to be anything else, and corridors are structural, so they may run
 * as long as they like. Outdoors is exempt for the same reason: a street should be as
 * long as the street.
 */
function trimClusters(board: Board, rng: RngState): void {
  const byId = new Map(board.rooms.map((room) => [room.id, room]));
  const seen = new Set<string>();
  /** Clusters already allowed to stand, per building and programme. */
  const standing = new Map<string, number>();

  for (const room of board.rooms) {
    if (seen.has(room.id) || room.outdoor || isStructural(room.program)) continue;

    // Breadth first, so what survives is the compact core of the cluster and what
    // gets turned into corridor is its straggling edge.
    const queue = [room];
    const run: Room[] = [];
    seen.add(room.id);
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      run.push(current);
      for (const other of neighbors(board, current)) {
        if (seen.has(other.id) || other.zone !== current.zone || other.program !== room.program) continue;
        seen.add(other.id);
        const found = byId.get(other.id);
        if (found) queue.push(found);
      }
    }

    const demote = (target: Room): void => {
      target.program = 'corridor';
      target.floor = floorFor(rng, 'corridor');
      target.loot = lootBonusFor('corridor');
      // And its stock, or a demoted armoury would keep an armoury's four finds
      // while paying a hallway's rate — a jackpot with a hallway's face on it.
      target.finds = findsFor('corridor', target.cells.length);
    };

    const key = `${room.zone}:${room.program}`;
    const already = standing.get(key) ?? 0;
    if (already >= roomBudget(room.program).clusters) {
      // One cluster too many: the whole run becomes hallway.
      for (const extra of run) demote(extra);
      continue;
    }
    standing.set(key, already + 1);

    const ceiling = Math.min(MAX_CLUSTER_ROOMS, roomBudget(room.program).rooms);
    for (const extra of run.slice(ceiling)) demote(extra);
  }
}

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

  /**
   * The two ends of the evening, pinned to opposite corners of the district.
   *
   * The exit used to be simply "the room furthest from the start by the graph",
   * which sounds like variety and is not: on a rectangle the furthest thing from
   * anywhere is the opposite corner, so every raid ran the same diagonal, and
   * because the start was any border room at all it was frequently a mid-edge
   * one — half a district to cross instead of a whole one.
   *
   * Pinning both ends and rolling *which* diagonal gives the opposite of what it
   * sounds like: the walk is a known length, and the district it crosses is
   * different every time. `CORNER_SLACK` keeps it from being the same paving
   * stone twice — anywhere within a few tiles of the corner is that corner.
   */
  const CORNER_SLACK = 5;
  const corners = [
    { x: 0, y: 0 },
    { x: board.width - 1, y: 0 },
    { x: 0, y: board.height - 1 },
    { x: board.width - 1, y: board.height - 1 }
  ];

  /** How close a room gets to a point, in tiles. */
  const reachOf = (room: Room, at: { x: number; y: number }): number => {
    let best = Infinity;
    for (const cell of room.cells) {
      const x = cell % board.width;
      const y = Math.floor(cell / board.width);
      best = Math.min(best, Math.max(Math.abs(x - at.x), Math.abs(y - at.y)));
    }
    return best;
  };

  /**
   * The rooms that count as "at" a corner: everything inside the slack, or — if
   * masonry and buildings have taken that whole patch — simply the nearest one,
   * because a raid with no way in is not a raid.
   */
  const nearest = (pool: Room[], at: { x: number; y: number }): Room | undefined => {
    if (pool.length === 0) return undefined;
    const within = pool.filter((room) => reachOf(room, at) <= CORNER_SLACK);
    if (within.length > 0) return pick(rng, within);
    return pool.reduce((a, b) => (reachOf(b, at) < reachOf(a, at) ? b : a));
  };

  const startPool = gates.length > 0 ? gates : board.rooms;

  /**
   * The diagonal is chosen from the ones the district can actually offer.
   *
   * Picking a corner blind and hoping is what made the arrangement lopsided: the
   * arrival may drift to whichever corner happens to have a doorway, while the
   * exit is pinned to the one opposite and has no such freedom — so a corner
   * built over or buried in rubble left the way out stranded halfway down an
   * edge. Asking first which diagonals have a doorway at *both* ends costs one
   * pass and keeps the roll honest: still random, only now among the corners
   * this world actually has.
   */
  const doorwaysNear = (at: { x: number; y: number }): boolean =>
    startPool.some((room) => reachOf(room, at) <= CORNER_SLACK);
  const usable = [0, 1, 2, 3].filter((index) => {
    const here = corners[index];
    const across = corners[3 - index];
    return here !== undefined && across !== undefined && doorwaysNear(here) && doorwaysNear(across);
  });

  const cornerIndex = usable.length > 0 ? pick(rng, usable) : randInt(rng, 4);
  const start = nearest(startPool, corners[cornerIndex] ?? corners[0]) ?? pick(rng, board.rooms);
  start.kind = 'start';

  /**
   * The far corner is measured from where the arrival actually landed, not from
   * the corner that was asked for.
   *
   * They are usually the same and occasionally not: a corner built over, or
   * buried in rubble, has no doorway within the slack, and the fallback takes
   * the nearest one there is — which can sit against a different corner
   * entirely. Aiming the exit at the opposite of the *intended* corner then
   * points it somewhere that is not opposite anything, and the diagonal the
   * whole arrangement exists to create quietly stops being a diagonal.
   */
  // 0↔3 and 1↔2 are the diagonals of the list above.
  const landed = corners.reduce(
    (best, corner, index) => (reachOf(start, corner) < reachOf(start, corners[best] ?? corner) ? index : best),
    0
  );
  const exitCorner = corners[3 - landed] ?? corners[3];
  /**
   * The start room is stocked, whatever it happens to be.
   *
   * It is almost always a stretch of pavement, which holds one thing — and the raid
   * opens by handing every survivor two free searches, right there. A table of four
   * would find the very first room of the evening empty before anybody had spent an
   * action point, which reads as the game being broken rather than as the room being
   * poor. It already pays a loot bonus for exactly this reason; this is the same
   * decision counted in stock rather than in rarity.
   */
  start.finds = Math.max(start.finds, START_FINDS);

  /* ---------------------------------- exit --------------------------------- */

  // One walk of the graph answers "how far from the start" for the whole board.
  const distance = distancesFrom(board, start.id);
  const far = (room: Room) => distance.get(room.id) ?? -1;

  /**
   * What the arrival can see from where it stands, straight down the streets.
   *
   * The district is crossed on foot and the fog is the reason it is worth
   * crossing. A way out that is legible from the doorstep — down one long
   * boulevard, before a single action point is spent — is not a way out that was
   * found, and the same goes for a key sitting in plain view.
   */
  const seen = lineOfSight(board, start.id);

  /**
   * Reachability is not negotiable, so it filters the pool first; being out of
   * sight and near the far corner are preferences, applied while they can be.
   * Rubble or a sealed block can take a whole patch, and a raid with no way out
   * is worse than a raid with an obvious one.
   */
  const walkable = (pool: Room[]) => pool.filter((room) => room.id !== start.id && far(room) >= 0);
  const borderGates = walkable(gates);
  const streets = walkable(outdoor.length > 0 ? outdoor : board.rooms);
  const outOfSight = (pool: Room[]) => pool.filter((room) => !seen.has(room.id));
  const atCorner = (pool: Room[]) => pool.filter((room) => reachOf(room, exitCorner) <= CORNER_SLACK);

  /**
   * Best available, in order of what matters most.
   *
   * A doorway out of the district, near the far corner, that cannot be seen from
   * the arrival. Each rung drops the least important requirement: first the far
   * corner stops needing to be on the border — a street two tiles inside it is
   * still a street — and only then does being out of sight give way, because on
   * a district whose whole border is one open ring there is nowhere out of sight
   * to put it and an obvious exit still beats an unreachable one.
   */
  const ladder = [
    atCorner(outOfSight(borderGates)),
    atCorner(outOfSight(streets)),
    atCorner(borderGates),
    outOfSight(borderGates),
    borderGates,
    streets
  ];

  const exitPool = ladder.find((pool) => pool.length > 0) ?? [];
  const exit = nearest(exitPool, exitCorner);
  if (exit) exit.kind = 'exit';

  /* ---------------------------------- keys --------------------------------- */

  /**
   * A key goes where the loot is, when there is anywhere like that.
   *
   * Keys used to land in whatever room was busiest, which made them a chore priced in
   * action points: walk in, pick up, walk out. Meanwhile the rooms the loot table
   * pays double for were entirely optional, so a table that ignored them lost nothing
   * but points. Putting one of the keys in the armoury or the pharmacy makes the two
   * decisions the same decision, and it is the cheapest way to make the good rooms
   * load-bearing rather than decorative.
   *
   * Only the first key, and only if such a room exists. All of them behind loot rooms
   * would be a different game (find the three best rooms on the map), and a town that
   * drew no landmark has no such room at all — which is the point of the landmark pool
   * and must not be a way to generate an unwinnable raid.
   */
  /**
   * No two keys within a few tiles of each other.
   *
   * Two keys in neighbouring rooms are one errand, not two: the team walks once
   * and collects both, and the objective that was supposed to send them across
   * the district costs them a corridor. Spacing is what makes three keys three
   * decisions.
   *
   * A preference, though, not a law — see the sweep at the end. A cramped map
   * that cannot honour it must still be winnable.
   */
  const KEY_SPACING = 4;
  const held: Room[] = [];

  const gap = (a: Room, b: Room): number => {
    let best = Infinity;
    for (const one of a.cells) {
      const ax = one % board.width;
      const ay = Math.floor(one / board.width);
      for (const two of b.cells) {
        const bx = two % board.width;
        const by = Math.floor(two / board.width);
        best = Math.min(best, Math.max(Math.abs(ax - bx), Math.abs(ay - by)));
      }
    }
    return best;
  };

  const spaced = (room: Room): boolean => held.every((other) => gap(room, other) >= KEY_SPACING);

  const plant = (room: Room): void => {
    room.hasKey = true;
    held.push(room);
  };

  /**
   * And none of them on the doorstep, or in sight of it.
   *
   * A key a few tiles from where the team lands is not an objective, it is a
   * formality — and one visible straight down the street from the arrival is
   * worse, because the district stops being something to search before anybody
   * has taken a step. Both are preferences with the same escape hatch as the
   * spacing: a small map that cannot honour them still gets its keys.
   */
  const KEY_START_GAP = 5;
  const roomy = indoor.length >= config.keys ? indoor : board.rooms;
  const anyNormal = roomy.filter((room) => room.kind === 'normal');
  const keyPool = anyNormal.filter((room) => !seen.has(room.id) && gap(room, start) >= KEY_START_GAP);

  const vaults = shuffled(
    rng,
    keyPool.filter((room) => room.loot >= SHINY_LOOT)
  );
  for (const vault of vaults) {
    if (held.length >= Math.max(1, Math.floor(config.keys / 2))) break;
    if (spaced(vault)) plant(vault);
  }

  // Busiest rooms first, but never two keys in one building while another has none.
  const byZone = new Map<number, Room[]>();
  for (const room of shuffled(rng, keyPool)
    .filter((room) => !room.hasKey)
    .sort((a, b) => degree(board, b) - degree(board, a))) {
    const list = byZone.get(room.zone) ?? [];
    list.push(room);
    byZone.set(room.zone, list);
  }
  const zones = shuffled(rng, [...byZone.keys()]);
  for (let round = 0; held.length < config.keys && round < 8; round++) {
    for (const zone of zones) {
      if (held.length >= config.keys) break;
      const room = byZone.get(zone)?.[round];
      if (!room || room.hasKey || !spaced(room)) continue;
      plant(room);
    }
  }

  /**
   * Whatever spacing could not deliver, placed anyway.
   *
   * A district of two buildings has nowhere to put three keys four tiles apart,
   * and refusing to place them would lock the exit forever. The rule bends here
   * rather than the raid breaking.
   */
  for (const room of [...keyPool, ...anyNormal]) {
    if (held.length >= config.keys) break;
    if (!room.hasKey) plant(room);
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
