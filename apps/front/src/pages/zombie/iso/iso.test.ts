import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createGame, gameConfigSchema, joinHero, LAYOUT_IDS, startGame, toView, type CzView } from 'coronaz-core';

/**
 * The renderer's tests.
 *
 * Two things in here can be wrong in ways nobody sees until they are playing: the
 * side of a room a wall is drawn on, and which tile a click lands on. Both have
 * been wrong already. Walls were drawn on the opposite edge from the boundary they
 * represented (the axes of an isometric grid are not the axes of the screen), and
 * clicks were resolved by inverting the projection, which answers "which tile is
 * under this point on the floor" when everything is drawn standing *up* from its
 * tile — so aiming past a wardrobe moved you a room too far.
 *
 * Neither showed up in a screenshot. Both show up here.
 *
 * There is no browser, so the pick canvas is backed by a small scanline rasteriser
 * below: it is enough to fill polygons and read pixels back, which is all the
 * hit-test does.
 */

/* ----------------------------- a canvas, sort of ---------------------------- */

interface Point {
  x: number;
  y: number;
}

/** A 2D context with real pixels: fills polygons, reads them back. */
function rasterContext(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  let scaleX = 1;
  let scaleY = 1;
  let offsetX = 0;
  let offsetY = 0;
  const stack: [number, number, number, number][] = [];
  let path: Point[] = [];
  let fill: [number, number, number] | null = null;

  return {
    canvas: { width, height },
    data,
    set fillStyle(value: string) {
      const match = /rgb\((\d+) (\d+) (\d+)\)/.exec(String(value));
      fill = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
    },
    set strokeStyle(_value: unknown) {},
    set lineWidth(_value: number) {},
    set globalAlpha(_value: number) {},
    set imageSmoothingEnabled(_value: boolean) {},
    set font(_value: string) {},
    set textAlign(_value: string) {},
    save() {
      stack.push([scaleX, scaleY, offsetX, offsetY]);
    },
    restore() {
      const previous = stack.pop();
      if (previous) [scaleX, scaleY, offsetX, offsetY] = previous;
    },
    scale(sx: number, sy: number) {
      scaleX *= sx;
      scaleY *= sy;
    },
    translate(tx: number, ty: number) {
      offsetX += scaleX * tx;
      offsetY += scaleY * ty;
    },
    setTransform() {},
    beginPath() {
      path = [];
    },
    closePath() {},
    moveTo(x: number, y: number) {
      path.push({ x: scaleX * x + offsetX, y: scaleY * y + offsetY });
    },
    lineTo(x: number, y: number) {
      path.push({ x: scaleX * x + offsetX, y: scaleY * y + offsetY });
    },
    /** Scanline fill, no antialiasing: identifiers must not be blended. */
    fill() {
      if (path.length < 3 || !fill) return;
      const ys = path.map((point) => point.y);
      const from = Math.max(0, Math.floor(Math.min(...ys)));
      const to = Math.min(height - 1, Math.ceil(Math.max(...ys)));

      for (let y = from; y <= to; y++) {
        const crossings: number[] = [];
        for (let i = 0; i < path.length; i++) {
          const a = path[i];
          const b = path[(i + 1) % path.length];
          if (!a || !b || a.y === b.y) continue;
          if (y + 0.5 < Math.min(a.y, b.y) || y + 0.5 >= Math.max(a.y, b.y)) continue;
          crossings.push(a.x + ((y + 0.5 - a.y) / (b.y - a.y)) * (b.x - a.x));
        }
        crossings.sort((a, b) => a - b);
        for (let i = 0; i + 1 < crossings.length; i += 2) {
          const start = Math.max(0, Math.ceil(crossings[i] ?? 0));
          const end = Math.min(width, crossings[i + 1] ?? 0);
          for (let x = start; x < end; x++) {
            const at = (y * width + x) * 4;
            data[at] = fill[0];
            data[at + 1] = fill[1];
            data[at + 2] = fill[2];
            data[at + 3] = 255;
          }
        }
      }
    },
    stroke() {},
    clip() {},
    fillRect() {},
    clearRect() {},
    ellipse() {},
    arc() {},
    quadraticCurveTo() {},
    drawImage() {},
    fillText() {},
    setLineDash() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    getImageData(x: number, y: number, w: number, h: number) {
      const out = new Uint8ClampedArray(w * h * 4);
      for (let row = 0; row < h; row++) {
        for (let column = 0; column < w; column++) {
          const source = ((y + row) * width + (x + column)) * 4;
          out.set(data.subarray(source, source + 4), (row * w + column) * 4);
        }
      }
      return { data: out };
    }
  };
}

/** Everything the art context is asked to do, ignored. */
function silentContext(): unknown {
  const nothing = () => undefined;
  return new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === 'canvas') return { width: 0, height: 0 };
        if (key === 'createLinearGradient' || key === 'createRadialGradient') {
          return () => ({ addColorStop: nothing });
        }
        return nothing;
      },
      set: () => true
    }
  );
}

/**
 * Installs the stub. Only the pick canvas gets real pixels — it asks for
 * `willReadFrequently`, which is exactly the canvas whose contents are read.
 */
function installCanvas(): void {
  const globals = globalThis as Record<string, unknown>;
  globals.document = {
    createElement: () => {
      const canvas = { width: 0, height: 0 } as {
        width: number;
        height: number;
        getContext?: (kind: string, options?: { willReadFrequently?: boolean }) => unknown;
      };
      let cached: unknown = null;
      canvas.getContext = (_kind, options) => {
        if (!options?.willReadFrequently) return silentContext();
        // A real canvas hands back the same context every time, and the hit-test
        // depends on it: a fresh one would read an empty buffer.
        cached ??= rasterContext(canvas.width, canvas.height);
        return cached;
      };
      return canvas;
    }
  };
  globals.Image = class {
    onerror: (() => void) | null = null;
    set src(_value: string) {}
  };
  globals.fetch = () => Promise.resolve({ ok: false });
  globals.window = { devicePixelRatio: 1 };
}

installCanvas();

const { paintLip, paintThreshold, paintWall, palette } = await import('./art');
const { project, TILE_H, TILE_W, WALL_H } = await import('./geometry');
const { furnishZone } = await import('./decor');
const { propDef, PROPS } = await import('./props');
const { pickCellAt, renderScene } = await import('./scene');

/* --------------------------------- fixtures -------------------------------- */

function board(layout: string, seed: number, fog: 'full' | 'none' = 'none'): CzView {
  const state = createGame({
    code: 'TEST',
    hostToken: 'h',
    gmToken: 'g',
    hostUserId: null,
    config: gameConfigSchema.parse({ layout, fog }),
    seed
  });
  joinHero(state, 'Testeuse', undefined);
  startGame(state, 0);
  return toView(state, { kind: 'tv' });
}

/** The same question the scene asks: which sides of this cell are solid. */
function wallsOf(view: CzView) {
  const index = (x: number, y: number) =>
    x < 0 || y < 0 || x >= view.width || y >= view.height ? -1 : y * view.width + x;
  return (cell: number) => {
    const x = cell % view.width;
    const y = Math.floor(cell / view.width);
    const code = (side: string): string => {
      if (side === 'east') return view.edgeRight[index(x, y)] ?? '#';
      if (side === 'south') return view.edgeDown[index(x, y)] ?? '#';
      if (side === 'west') {
        const left = index(x - 1, y);
        return left === -1 ? '#' : (view.edgeRight[left] ?? '#');
      }
      const up = index(x, y - 1);
      return up === -1 ? '#' : (view.edgeDown[up] ?? '#');
    };
    const solid = (side: string) => code(side) === '#' || code(side) === '?';
    return { north: solid('north'), east: solid('east'), south: solid('south'), west: solid('west') };
  };
}

/* ------------------------------- the geometry ------------------------------- */

describe('the projection', () => {
  it('draws every boundary on the edge it shares', () => {
    // `+x` runs down-right and `+y` down-left, so the boundary with the cell at
    // `y - 1` is the diamond's top-RIGHT edge. Getting this backwards draws every
    // wall on the wrong side of its room and still looks plausible in a picture.
    const paths: Point[][] = [];
    let current: Point[] = [];
    const recorder = {
      save() {},
      restore() {},
      beginPath() {
        current = [];
        paths.push(current);
      },
      closePath() {},
      moveTo(x: number, y: number) {
        current.push({ x, y });
      },
      lineTo(x: number, y: number) {
        current.push({ x, y });
      },
      fill() {},
      stroke() {},
      clip() {},
      fillRect() {},
      ellipse() {},
      setLineDash() {},
      createLinearGradient: () => ({ addColorStop() {} }),
      set fillStyle(_v: unknown) {},
      set strokeStyle(_v: unknown) {},
      set lineWidth(_v: number) {},
      set globalAlpha(_v: number) {}
    } as unknown as CanvasRenderingContext2D;

    const colors = palette(200, 'lino', 'office');
    const middle = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const footOf = (draw: () => void): Point => {
      paths.length = 0;
      draw();
      const first = paths.find((entry) => entry.length >= 2);
      assert(first?.[0] && first[1], 'nothing was drawn');
      return middle(first[0], first[1]);
    };

    for (const [cx, cy] of [
      [0, 0],
      [3, 2],
      [1, 5]
    ] as const) {
      // Walls and skirtings stand exactly on their boundary. A seam is a threshold
      // band that straddles it, so it is allowed a few pixels either side.
      const cases = [
        ['north', 0, -1, 0.01, () => paintWall(recorder, cx, cy, 'north', colors, {})],
        ['west', -1, 0, 0.01, () => paintWall(recorder, cx, cy, 'west', colors, {})],
        ['north see-through', 0, -1, 0.01, () => paintWall(recorder, cx, cy, 'north', colors, { translucent: true })],
        ['south lip', 0, 1, 0.01, () => paintLip(recorder, cx, cy, 'south', colors)],
        ['east lip', 1, 0, 0.01, () => paintLip(recorder, cx, cy, 'east', colors)],
        ['north seam', 0, -1, 4, () => paintThreshold(recorder, cx, cy, 'north', colors, 'seam')]
      ] as const;

      for (const [label, dx, dy, tolerance, draw] of cases) {
        const foot = footOf(draw);
        const wanted = middle(project(cx, cy), project(cx + dx, cy + dy));
        assert(
          Math.hypot(foot.x - wanted.x, foot.y - wanted.y) < tolerance,
          `${label} of (${cx},${cy}) sits at ${JSON.stringify(foot)}, its boundary is at ${JSON.stringify(wanted)}`
        );
      }
    }
  });

  it('keeps the tile and the wall in proportion', () => {
    // A flat angle with tall walls shows more wall than floor, which is what the
    // first playtest said. If someone raises the walls again, this should argue.
    assert(TILE_H / TILE_W > 0.6, 'the camera has flattened back towards 2:1');
    assert(WALL_H < TILE_H / 1.5, 'the walls are tall enough to hide the floor behind them');
  });
});

/* -------------------------------- the picking ------------------------------- */

describe('clicking the board', () => {
  it('gives the tile a prop stands on, not the one behind it', () => {
    let onItsOwnTile = 0;
    let tallProps = 0;

    LAYOUT_IDS.forEach((layout, index) => {
      const view = board(layout, 4211 * (index + 1));
      const scene = renderScene(view, 1);
      const walls = wallsOf(view);

      for (const zone of new Set(view.rooms.map((room) => room.zone))) {
        const rooms = view.rooms.filter((room) => room.zone === zone);
        for (const [id, decor] of furnishZone(rooms, view.width, walls)) {
          const room = rooms.find((candidate) => candidate.id === id);
          if (!room) continue;
          for (const prop of decor.props) {
            const height = propDef(prop.kind)?.height ?? 0.5;
            if (height < 0.8) continue; // only the ones tall enough to mislead
            const cell = Math.round(prop.cy) * view.width + Math.round(prop.cx);
            if (!room.cells.includes(cell)) continue;
            const base = project(prop.cx, prop.cy);
            tallProps += 1;
            if (pickCellAt(scene, { x: base.x, y: base.y - height * TILE_H * 0.7 }) === cell) {
              onItsOwnTile += 1;
            }
          }
        }
      }
    });

    assert(tallProps > 50, `only ${tallProps} tall props to test`);
    const rate = onItsOwnTile / tallProps;
    assert(rate > 0.9, `only ${(rate * 100).toFixed(0)}% of tall props claim the tile they stand on`);
  });

  it('gives every tile its own floor, dark ones included', () => {
    // Walking into the unexplored is the game, so unlit tiles are clickable too.
    const view = board('quartier', 90210, 'full');
    const scene = renderScene(view, 1);
    let hits = 0;
    let total = 0;
    for (const room of view.rooms) {
      for (const cell of room.cells) {
        total += 1;
        if (pickCellAt(scene, project(cell % view.width, Math.floor(cell / view.width))) === cell) hits += 1;
      }
    }
    // Not all of them: a prop standing in a nearer tile legitimately covers the
    // middle of the one behind, and then the prop is what you clicked.
    assert(hits / total > 0.8, `only ${((hits / total) * 100).toFixed(0)}% of tiles answer for their own centre`);
  });

  it('answers nothing off the board', () => {
    const view = board('residence', 7);
    const scene = renderScene(view, 1);
    assert.equal(pickCellAt(scene, { x: -10_000, y: -10_000 }), null);
  });
});

/* ------------------------------- the furniture ------------------------------ */

describe('furnishing', () => {
  it('respects every quota, and puts nothing where it does not belong', () => {
    const problems: string[] = [];
    let rooms = 0;
    let props = 0;

    for (const layout of LAYOUT_IDS) {
      for (const seed of [613, 1226]) {
        const view = board(layout, seed);
        const walls = wallsOf(view);

        for (const zone of new Set(view.rooms.map((room) => room.zone))) {
          const zoneRooms = view.rooms.filter((room) => room.zone === zone);
          const decor = furnishZone(zoneRooms, view.width, walls);
          const perZone = new Map<string, number>();

          for (const room of zoneRooms) {
            const placed = decor.get(room.id)?.props ?? [];
            rooms += 1;
            props += placed.length;
            const perRoom = new Map<string, number>();

            for (const prop of placed) {
              perRoom.set(prop.kind, (perRoom.get(prop.kind) ?? 0) + 1);
              perZone.set(prop.kind, (perZone.get(prop.kind) ?? 0) + 1);

              const definition = propDef(prop.kind);
              assert(definition, `unknown prop ${prop.kind}`);
              const belongs = (definition.programs[room.program] ?? 0) > 0;
              const invited = PROPS.some(
                (other) =>
                  other.companions?.some((companion) => companion.kind === prop.kind) &&
                  (other.programs[room.program] ?? 0) > 0
              );
              if (!belongs && !invited) problems.push(`${prop.kind} in a ${room.program}`);
            }

            for (const [kind, count] of perRoom) {
              const limit = propDef(kind)?.maxPerRoom ?? 1;
              if (count > limit) problems.push(`${count}× ${kind} in one ${room.program} (max ${limit})`);
            }
          }

          for (const [kind, count] of perZone) {
            const limit = propDef(kind)?.maxPerZone;
            if (limit !== undefined && count > limit) {
              problems.push(`${count}× ${kind} in one building (max ${limit})`);
            }
          }
        }
      }
    }

    assert(rooms > 200 && props > 400, `only ${props} props over ${rooms} rooms`);
    assert.deepEqual([...new Set(problems)].slice(0, 10), [], 'the furnishing broke its own rules');
  });

  it('leaves the road nearly bare and the interiors busy', () => {
    /**
     * The measurement behind "the modern biome feels like one big hangar".
     *
     * Everything was furnished at 1.9 props per cell, so a stretch of road carried as
     * much stuff as a kitchen and the whole map read as one interior with the roof
     * torn off. What makes a town legible from above is that the *density* differs by
     * kind of place, so that is what this pins: a road is nearly empty, a pavement
     * and a square are sparse, and an interior is crowded.
     */
    const cells = new Map<string, number>();
    const props = new Map<string, number>();

    for (const layout of LAYOUT_IDS) {
      for (const seed of [77, 4242]) {
        const view = board(layout, seed);
        const walls = wallsOf(view);
        for (const zone of new Set(view.rooms.map((room) => room.zone))) {
          const zoneRooms = view.rooms.filter((room) => room.zone === zone);
          const decor = furnishZone(zoneRooms, view.width, walls);
          for (const room of zoneRooms) {
            cells.set(room.program, (cells.get(room.program) ?? 0) + room.cells.length);
            props.set(room.program, (props.get(room.program) ?? 0) + (decor.get(room.id)?.props.length ?? 0));
          }
        }
      }
    }

    const per = (program: string): number => (props.get(program) ?? 0) / Math.max(1, cells.get(program) ?? 0);

    assert(cells.get('street'), 'no street was generated to measure');
    assert(per('street') < 0.4, 'a road is furnished like a room: ' + per('street').toFixed(2) + ' props a cell');
    assert(per('living') > 1, 'a living room is bare: ' + per('living').toFixed(2) + ' props a cell');
    assert(
      per('living') > per('street') * 3,
      'a road (' + per('street').toFixed(2) + ') is furnished like a living room (' + per('living').toFixed(2) + ')'
    );
  });

  it('gives a table its chairs', () => {
    // A table alone in a room was the clearest sign nothing here was thinking
    // about rooms rather than about objects.
    let tables = 0;
    let seated = 0;

    for (const layout of LAYOUT_IDS) {
      const view = board(layout, 2024);
      const walls = wallsOf(view);
      for (const zone of new Set(view.rooms.map((room) => room.zone))) {
        const zoneRooms = view.rooms.filter((room) => room.zone === zone);
        for (const [, decor] of furnishZone(zoneRooms, view.width, walls)) {
          for (const table of decor.props.filter((prop) => prop.kind === 'table' || prop.kind === 'desk')) {
            tables += 1;
            if (
              decor.props.some(
                (prop) => prop.kind === 'chair' && Math.hypot(prop.cx - table.cx, prop.cy - table.cy) < 1.2
              )
            ) {
              seated += 1;
            }
          }
        }
      }
    }

    assert(tables > 20, `only ${tables} tables to check`);
    assert(seated / tables > 0.7, `only ${((seated / tables) * 100).toFixed(0)}% of tables have a chair`);
  });
});

/* -------------------------------- the scene --------------------------------- */

describe('rendering', () => {
  it('draws every layout, in every fog, without a broken coordinate', () => {
    // A NaN anywhere in the transform chain silently blanks a canvas.
    for (const layout of LAYOUT_IDS) {
      for (const fog of ['none', 'full'] as const) {
        const view = board(layout, 977, fog);
        const scene = renderScene(view, 1);
        assert(scene.canvas.width > 0 && scene.canvas.height > 0, `${layout}/${fog}: empty canvas`);
        assert.equal(scene.pick.width, scene.canvas.width, 'the pick map must match the picture');
        assert.equal(scene.signature, renderScene(view, 1).signature, 'the same board draws the same scene');
      }
    }
  });
});
