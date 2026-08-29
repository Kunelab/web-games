/* eslint-disable no-console -- a CLI's output is its interface */
import { DIFFICULTY_PRESETS, gameConfigSchema } from '../config.js';
import { connectionsOf, degree, lineOfSight, shortestPath, type Room } from '../map.js';
import { createGame, type CzState } from '../state.js';
import { runGame } from './simulate.js';
import { uniformParty } from './simulate.js';

/**
 * What a district is actually shaped like, and how long a small team takes to
 * get out of one.
 *
 *   pnpm --filter coronaz-core district
 *   pnpm --filter coronaz-core district -- --games 300 --size 22
 *   pnpm --filter coronaz-core district -- --preset difficile
 *
 * Two questions, one bench, because they are the same question. "The map is a
 * maze" is a claim about connectivity, and connectivity is measurable: a district
 * where the average room has two ways out *is* a corridor system, whatever it
 * looks like, and a team crossing one spends its evening walking.
 *
 * The number that settles it is not the average, though — it is the loop count.
 * A layout with no loops is a tree: exactly one route between any two rooms, every
 * wrong turn paid for twice, and no way to go around anything. Loops are what make
 * a map readable, and `E - R + 1` counts them exactly.
 */

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const games = Number(arg('games', '100'));
const size = Number(arg('size', '22'));
const preset = arg('preset', 'normal');
const seedBase = Number(arg('seedbase', '1'));

const config = gameConfigSchema.parse({
  ...DIFFICULTY_PRESETS[preset],
  scenario: 'escape',
  width: size,
  height: size,
  layout: 'random',
  biome: 'random',
  mode: 'ai',
  heroPhaseSeconds: 0,
  gmPhaseSeconds: 0
});

/** Same spread the rest of the bench uses, so runs line up with it. */
const seedAt = (index: number): number => seedBase * 1_000_003 + index * 7919;

/* ----------------------------- the shape of it ---------------------------- */

interface Shape {
  rooms: number;
  doors: number;
  degrees: number[];
  /**
   * Ways out that are actual doors, and ways out that are open archways.
   *
   * Worth separating, because they are not the same claim about a map. An arch
   * is "no wall at all" — a street or an open-plan hall is several rooms of one
   * space — so a layout full of streets scores well on raw adjacency while every
   * *building* in it may still be a corridor system. Counting them together is
   * how an open-air map flatters itself.
   */
  doorDegrees: number[];
  archDegrees: number[];
  loops: number;
  /** Rooms between the start and the way out, by the shortest route. */
  exitDistance: number;
  layout: string;
  biome: string;
  /** Share of the bounding box the district actually occupies. */
  filled: number;
  /**
   * Share of the box's border ring that is not district at all.
   *
   * The measure of "is this still a rectangle": debris never lands on the border,
   * so anything missing from the ring is the outline, and a plain block scores
   * zero however much rubble fell inside it.
   */
  edgeVoid: number;
  /** Tiles from the arrival to the nearest corner of the district. */
  startCorner: number;
  /** Tiles from the way out to the corner opposite the arrival. */
  exitCorner: number;
  exitSeen: boolean;
  /** Border rooms out of sight of the arrival — the pool the exit may draw from. */
  hiddenGates: number;
  /** Of those, how many sit within the corner slack of the far corner. */
  hiddenAtCorner: number;
  keys: number;
  keysSeen: number;
  /** Closest any two keys come to each other, and to the arrival. */
  keyGap: number;
  keyStartGap: number;
}

function shapeOf(state: CzState): Shape {
  const board = state.board;
  const degrees = board.rooms.map((room) => degree(board, room));
  // Each doorway is one edge counted from both ends.
  const doors = degrees.reduce((sum, d) => sum + d, 0) / 2;

  const doorDegrees: number[] = [];
  const archDegrees: number[] = [];
  for (const room of board.rooms) {
    const byDoor = new Set<string>();
    const byArch = new Set<string>();
    for (const connection of connectionsOf(board, room)) {
      (connection.kind === 'door' ? byDoor : byArch).add(connection.roomId);
    }
    // A pair joined both ways counts as a door: it is enterable either way.
    for (const id of byDoor) byArch.delete(id);
    doorDegrees.push(byDoor.size);
    archDegrees.push(byArch.size);
  }

  /**
   * Independent loops: edges, minus the edges a tree of this many rooms would
   * need, plus one. Zero means a perfect maze — one route to anywhere, and every
   * dead end is a wasted trip out and back.
   */
  const loops = doors - board.rooms.length + 1;

  const start = board.rooms.find((room) => room.kind === 'start');
  const exit = board.rooms.find((room) => room.kind === 'exit');
  const route = start && exit ? shortestPath(board, start.id, exit.id) : null;

  /** Chebyshev tiles between two rooms, at their closest. */
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

  const toPoint = (room: Room, px: number, py: number): number => {
    let best = Infinity;
    for (const cell of room.cells) {
      const x = cell % board.width;
      const y = Math.floor(cell / board.width);
      best = Math.min(best, Math.max(Math.abs(x - px), Math.abs(y - py)));
    }
    return best;
  };

  const corners = [
    [0, 0],
    [board.width - 1, 0],
    [0, board.height - 1],
    [board.width - 1, board.height - 1]
  ] as const;

  const seen = start ? lineOfSight(board, start.id) : new Map<string, number>();
  const keyRooms = board.rooms.filter((room) => room.hasKey);

  const onBorder = (room: Room): boolean =>
    room.cells.some((cell) => {
      const x = cell % board.width;
      const y = Math.floor(cell / board.width);
      return x === 0 || y === 0 || x === board.width - 1 || y === board.height - 1;
    });
  const gates = board.rooms.filter((room) => room.outdoor && onBorder(room));

  let startCorner = -1;
  let exitCorner = -1;
  let nearestCorner = 0;
  if (start) {
    for (let index = 1; index < corners.length; index++) {
      if (
        toPoint(start, corners[index][0], corners[index][1]) <
        toPoint(start, corners[nearestCorner][0], corners[nearestCorner][1])
      ) {
        nearestCorner = index;
      }
    }
    startCorner = toPoint(start, corners[nearestCorner][0], corners[nearestCorner][1]);
    const across = corners[3 - nearestCorner];
    if (exit) exitCorner = toPoint(exit, across[0], across[1]);
  }

  let keyGap = Infinity;
  for (let a = 0; a < keyRooms.length; a++) {
    for (let b = a + 1; b < keyRooms.length; b++) keyGap = Math.min(keyGap, gap(keyRooms[a], keyRooms[b]));
  }

  return {
    rooms: board.rooms.length,
    doors,
    degrees,
    doorDegrees,
    archDegrees,
    loops,
    exitDistance: route?.length ?? -1,
    layout: board.layout,
    biome: state.config.biome,
    filled: board.cellRoom.filter((id) => id !== '').length / (board.width * board.height),
    edgeVoid: (() => {
      let ring = 0;
      let empty = 0;
      for (let cell = 0; cell < board.cellRoom.length; cell++) {
        const x = cell % board.width;
        const y = Math.floor(cell / board.width);
        if (x !== 0 && y !== 0 && x !== board.width - 1 && y !== board.height - 1) continue;
        ring += 1;
        if ((board.cellRoom[cell] ?? '') === '') empty += 1;
      }
      return empty / Math.max(1, ring);
    })(),
    startCorner,
    exitCorner,
    exitSeen: exit ? seen.has(exit.id) : false,
    hiddenGates: gates.filter((room) => !seen.has(room.id)).length,
    hiddenAtCorner: gates.filter(
      (room) =>
        !seen.has(room.id) &&
        startCorner >= 0 &&
        toPoint(room, corners[3 - nearestCorner][0], corners[3 - nearestCorner][1]) <= 5
    ).length,
    keys: keyRooms.length,
    keysSeen: keyRooms.filter((room) => seen.has(room.id)).length,
    keyGap: keyRooms.length > 1 ? keyGap : Infinity,
    keyStartGap: start && keyRooms.length > 0 ? Math.min(...keyRooms.map((room) => gap(room, start))) : Infinity
  };
}

const shapes: Shape[] = [];
for (let index = 0; index < games; index++) {
  shapes.push(
    shapeOf(
      createGame({
        code: 'DIST',
        hostToken: 'h',
        gmToken: 'g',
        hostUserId: null,
        config,
        seed: seedAt(index),
        now: 0
      })
    )
  );
}

const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
const pct = (part: number, whole: number): string => `${((100 * part) / Math.max(1, whole)).toFixed(1)}%`;

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

const allDegrees = shapes.flatMap((shape) => shape.degrees);
const deadEnds = allDegrees.filter((d) => d <= 1).length;
const corridors = allDegrees.filter((d) => d === 2).length;
const threeWay = allDegrees.filter((d) => d === 3).length;
const hubs = allDegrees.filter((d) => d >= 4).length;

console.log(`\n=== La forme du quartier (${size}×${size}, ${preset}, monde et biome aléatoires, ${games} cartes) ===\n`);
const filled = shapes.map((s) => s.filled);
console.log(
  `emprise du quartier   ${(100 * mean(filled)).toFixed(1)}% de la boîte  ` +
    `(p10 ${(100 * quantile(filled, 0.1)).toFixed(0)}%, médiane ${(100 * quantile(filled, 0.5)).toFixed(0)}%, ` +
    `p90 ${(100 * quantile(filled, 0.9)).toFixed(0)}%, min ${(100 * Math.min(...filled)).toFixed(0)}%)`
);
const edges = shapes.map((s) => s.edgeVoid);
console.log(
  `bordure entamée       ${(100 * mean(edges)).toFixed(1)}% du pourtour  ` +
    `(rectangle franc sur ${pct(edges.filter((e) => e < 0.02).length, edges.length)} des cartes)`
);
console.log(`pièces par carte      ${mean(shapes.map((s) => s.rooms)).toFixed(1)}`);
console.log(`liaisons par carte    ${mean(shapes.map((s) => s.doors)).toFixed(1)}`);
console.log(`SORTIES PAR PIÈCE     ${mean(allDegrees).toFixed(2)}   (médiane ${quantile(allDegrees, 0.5)})`);
console.log(
  `  dont portes         ${mean(shapes.flatMap((s) => s.doorDegrees)).toFixed(2)}` +
    `   arches ${mean(shapes.flatMap((s) => s.archDegrees)).toFixed(2)}  (rue = espace ouvert)`
);
console.log(`boucles (E-P+1)       ${mean(shapes.map((s) => s.loops)).toFixed(1)}   ` + `— 0 = labyrinthe parfait`);
console.log(`boucles par pièce     ${(mean(shapes.map((s) => s.loops)) / mean(shapes.map((s) => s.rooms))).toFixed(3)}`);
console.log(`sortie à              ${mean(shapes.map((s) => s.exitDistance)).toFixed(1)} pièces du départ`);
console.log('');
console.log(`cul-de-sac (1 porte)  ${pct(deadEnds, allDegrees.length).padStart(6)}`);
console.log(`couloir    (2 portes) ${pct(corridors, allDegrees.length).padStart(6)}`);
console.log(`carrefour  (3 portes) ${pct(threeWay, allDegrees.length).padStart(6)}`);
console.log(`place      (4+)       ${pct(hubs, allDegrees.length).padStart(6)}`);
console.log(`→ intersections        ${pct(threeWay + hubs, allDegrees.length).padStart(6)} des pièces`);

/* ------------------------------- objectifs -------------------------------- */

const finite = (values: number[]): number[] => values.filter((value) => Number.isFinite(value));
const keyGaps = finite(shapes.map((s) => s.keyGap));
const keyStartGaps = finite(shapes.map((s) => s.keyStartGap));

console.log(`\n--- les objectifs ---`);
const within = (values: number[], limit: number): string => pct(values.filter((v) => v <= limit).length, values.length);
const startCorners = shapes.map((s) => s.startCorner);
const exitCorners = shapes.map((s) => s.exitCorner);
console.log(
  `départ à              ${mean(startCorners).toFixed(1)} tuiles d'un coin  ` +
    `(≤5 : ${within(startCorners, 5)}, médiane ${quantile(startCorners, 0.5)}, max ${Math.max(...startCorners)})`
);
console.log(
  `sortie à              ${mean(exitCorners).toFixed(1)} tuiles du coin opposé  ` +
    `(≤5 : ${within(exitCorners, 5)}, médiane ${quantile(exitCorners, 0.5)}, max ${Math.max(...exitCorners)})`
);
console.log(`sortie visible        ${pct(shapes.filter((s) => s.exitSeen).length, shapes.length)} des cartes`);
console.log(
  `  bordures cachées    ${mean(shapes.map((s) => s.hiddenGates)).toFixed(1)} par carte  ` +
    `(aucune sur ${pct(shapes.filter((s) => s.hiddenGates === 0).length, shapes.length)})`
);
console.log(
  `  dont près du coin   ${mean(shapes.map((s) => s.hiddenAtCorner)).toFixed(1)}  ` +
    `(aucune sur ${pct(shapes.filter((s) => s.hiddenAtCorner === 0).length, shapes.length)})`
);
console.log(
  `clés par carte        ${mean(shapes.map((s) => s.keys)).toFixed(2)}  ` +
    `(visibles du départ : ${pct(
      shapes.reduce((sum, s) => sum + s.keysSeen, 0),
      shapes.reduce((sum, s) => sum + s.keys, 0)
    )})`
);
console.log(
  `écart entre clés      min ${Math.min(...keyGaps)}  moyenne ${mean(keyGaps).toFixed(1)}  ` +
    `(< 4 sur ${pct(keyGaps.filter((g) => g < 4).length, keyGaps.length)} des cartes)`
);
console.log(
  `clé la plus proche    min ${Math.min(...keyStartGaps)}  moyenne ${mean(keyStartGaps).toFixed(1)} tuiles du départ  ` +
    `(< 5 sur ${pct(keyStartGaps.filter((g) => g < 5).length, keyStartGaps.length)} des cartes)`
);

/* -------------------------- per layout, per biome ------------------------- */

function breakdown(title: string, key: (shape: Shape) => string): void {
  const groups = new Map<string, Shape[]>();
  for (const shape of shapes) {
    const name = key(shape);
    const bucket = groups.get(name) ?? [];
    bucket.push(shape);
    groups.set(name, bucket);
  }

  console.log(`\n--- ${title} ---`);
  console.log('monde                cartes  pièces  sorties  portes  boucles  carrefours');
  for (const [name, group] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const degrees = group.flatMap((shape) => shape.degrees);
    const crossings = degrees.filter((d) => d >= 3).length;
    console.log(
      `${name.slice(0, 20).padEnd(20)} ${String(group.length).padStart(6)}  ` +
        `${mean(group.map((s) => s.rooms)).toFixed(0).padStart(6)}  ` +
        `${mean(degrees).toFixed(2).padStart(7)}  ` +
        `${mean(group.flatMap((s) => s.doorDegrees)).toFixed(2).padStart(6)}  ` +
        `${mean(group.map((s) => s.loops)).toFixed(1).padStart(7)}  ` +
        `${pct(crossings, degrees.length).padStart(10)}`
    );
  }
}

breakdown('par monde', (shape) => shape.layout);

/* ------------------------------ and the play ------------------------------ */

console.log(`\n=== Combien de tours pour sortir (${preset}, héros experts) ===\n`);
console.log('équipe  victoires   tours moy.  médiane   p90   au plafond  morts  pièces vues');

for (const partySize of [1, 2]) {
  const party = uniformParty(partySize, 'balanced', 'expert');
  const turns: number[] = [];
  let wins = 0;
  let deaths = 0;
  let capped = 0;

  for (let index = 0; index < games; index++) {
    const outcome = runGame({ config, seed: seedAt(index), party });
    turns.push(outcome.turns);
    wins += outcome.won ? 1 : 0;
    deaths += outcome.heroesDead;
    // The cap is the simulator's "this raid rotted"; see TURN_CAP.
    if (outcome.turns > 60) capped += 1;
  }

  console.log(
    `${String(partySize).padStart(6)}  ${pct(wins, games).padStart(9)}  ` +
      `${mean(turns).toFixed(1).padStart(10)}  ` +
      `${String(quantile(turns, 0.5)).padStart(7)}  ` +
      `${String(quantile(turns, 0.9)).padStart(4)}  ` +
      `${pct(capped, games).padStart(10)}  ` +
      `${(deaths / games).toFixed(2).padStart(5)}  ` +
      `${mean(shapes.map((s) => s.rooms)).toFixed(0).padStart(11)}`
  );
}

console.log('');
