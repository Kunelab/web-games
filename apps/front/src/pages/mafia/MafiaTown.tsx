import type { MafiaPublicPlayer } from 'mafia-core';

/**
 * The town, and nothing but the town.
 *
 * This is scenery. It is not the board and it is not a control: every action in
 * this game happens on a real button in the player list, where a label can be
 * read and a thumb can land. That split is deliberate — the previous version put
 * twenty-four tappable plots and twenty-four name labels into one un-zoomable
 * SVG, which on a 360px phone meant six-pixel names and tap targets the size of
 * a grain of rice. Names belong in a list. Houses belong on a hill.
 *
 * So this component takes no handlers, exposes nothing focusable, and is hidden
 * from assistive technology outright. What it does carry is *state you can read
 * at a glance across the room*: who is still standing, who is in the ground,
 * whether it is day or night, and whether the gallows is occupied.
 *
 * Three layers, painted in that order: the ground and the square, then the
 * houses in depth order, then *the folk* — every villager, grave and pennant in
 * one pass on top. The third layer is not a flourish. Houses are sorted by tile
 * depth while a villager stands at the near corner of its own tile, which puts
 * it inside the next tile's footprint: with one group per plot, the neighbour's
 * roof was painted over half the town's heads. A villager is a player, and a
 * player is never scenery you can lose behind a wall.
 *
 * Twenty-four plots sit on the ring of a 7×7 grid — the perimeter of that square
 * is exactly 24 cells, so a seat number is the same house forever, whatever it is
 * later dressed as. Everything paints from CSS custom properties (see the
 * `--town-*` block in mafia.css), which is the whole skinning seam: a new theme
 * is a block of colour tokens, and a house or villager skin later swaps the
 * shapes behind these same class names.
 */

const TILE_W = 76;
/** Shallow on purpose: a letterbox strip reads better above a list than a square. */
const TILE_H = 26;
const GRID = 7;

interface Plot {
  slot: number;
  col: number;
  row: number;
}

/** The 24 ring cells, clockwise from the north corner. */
const PLOTS: Plot[] = (() => {
  const cells: { col: number; row: number }[] = [];
  for (let col = 0; col < GRID; col++) cells.push({ col, row: 0 });
  for (let row = 1; row < GRID; row++) cells.push({ col: GRID - 1, row });
  for (let col = GRID - 2; col >= 0; col--) cells.push({ col, row: GRID - 1 });
  for (let row = GRID - 2; row >= 1; row--) cells.push({ col: 0, row });
  return cells.map((cell, index) => ({ slot: index + 1, ...cell }));
})();

/**
 * Painter's order: far plots first, so a near house overlaps the one behind it
 * instead of whichever happened to come next around the ring.
 */
const PAINT_ORDER = [...PLOTS].sort((a, b) => a.col + a.row - (b.col + b.row) || a.col - b.col);

function project(col: number, row: number): { x: number; y: number } {
  return { x: ((col - row) * TILE_W) / 2, y: ((col + row) * TILE_H) / 2 };
}

/**
 * Seat tint. Stepped through a coarse wheel rather than 360/24, because fifteen
 * degrees apart makes neighbours identical and the point of a colour is to tell
 * two of them apart.
 */
const SEAT_HUES = [8, 32, 48, 96, 150, 180, 200, 224, 262, 292, 320, 344];
const seatHue = (slot: number): number => SEAT_HUES[(slot * 5) % SEAT_HUES.length] ?? 0;

const diamond = (x: number, y: number, w: number, h: number): string =>
  `${x},${y - h / 2} ${x + w / 2},${y} ${x},${y + h / 2} ${x - w / 2},${y}`;

export type TownTheme = 'village' | 'cite';

export interface MafiaTownProps {
  players: MafiaPublicPlayer[];
  mySlot: number | null;
  night: boolean;
  /** Skin hook. Colours only for now; house and villager art swap in later. */
  theme?: TownTheme;
  /**
   * How much board to fit in the frame. 1 is the town filling it; 1.5 pulls the
   * camera back by half, which is what a twenty-four house ring needs before the
   * names on the roster and the houses on the hill line up in one glance.
   */
  zoom?: number;
}

export function MafiaTown({ players, mySlot, night, theme = 'village', zoom = 1 }: MafiaTownProps) {
  const bySlot = new Map(players.map((player) => [player.slot, player]));
  const centre = project((GRID - 1) / 2, (GRID - 1) / 2);

  /**
   * Who is at the barre, read off the roster rather than taken as a prop.
   *
   * It used to arrive as a bare `onTrial` boolean, which could say the square is
   * a gallows but never who was standing in it — so the town raised a scaffold
   * and left the accused at home, on their own plot, through their own trial.
   * One source of truth means the rope and the person under it cannot disagree.
   */
  const accused = players.find((player) => player.onTrial && player.alive) ?? null;

  // The camera pulls back by padding the box rather than scaling the drawing:
  // strokes and text keep their own weight that way, which is the whole reason
  // the scenery is an SVG.
  const pad = 58 * zoom;
  const corners = [project(0, 0), project(GRID - 1, 0), project(GRID - 1, GRID - 1), project(0, GRID - 1)];
  const minX = Math.min(...corners.map((corner) => corner.x)) - pad;
  const maxX = Math.max(...corners.map((corner) => corner.x)) + pad;
  const minY = Math.min(...corners.map((corner) => corner.y)) - pad - 12 * zoom;
  const maxY = Math.max(...corners.map((corner) => corner.y)) + pad;

  return (
    <div className={`mz-town${night ? ' mz-town--night' : ''}`} data-town-theme={theme}>
      <svg
        className="mz-town-canvas"
        viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
        aria-hidden="true"
        focusable="false"
      >
        <polygon points={diamond(centre.x, centre.y, (GRID + 2) * TILE_W, (GRID + 2) * TILE_H)} className="mz-ground" />

        <g className="mz-square">
          <polygon points={diamond(centre.x, centre.y, TILE_W * 2.4, TILE_H * 2.4)} className="mz-plaza" />
          {accused ? <Gallows x={centre.x} y={centre.y} /> : <Fountain x={centre.x} y={centre.y} />}
        </g>

        {PAINT_ORDER.map((plot) => {
          const player = bySlot.get(plot.slot);
          const { x, y } = project(plot.col, plot.row);

          return (
            <g key={plot.slot} className={`mz-plot${player && !player.alive ? ' mz-plot--dead' : ''}`}>
              <polygon points={diamond(x, y, TILE_W * 0.92, TILE_H * 0.92)} className="mz-plot-ground" />

              {!player && <polygon points={diamond(x, y, TILE_W * 0.42, TILE_H * 0.42)} className="mz-plot-empty" />}
              {player && <House x={x} y={y} night={night} barred={!player.alive} />}
            </g>
          );
        })}

        {/*
          The folk, over every roof in the town.

          Still in depth order among themselves, so a near villager overlaps the
          one behind — what they no longer do is vanish under the house next
          door. Graves come along because a grave stands exactly where its owner
          used to, and a marker you cannot see marks nothing.
        */}
        <g className="mz-folk">
          {PAINT_ORDER.map((plot) => {
            const player = bySlot.get(plot.slot);
            if (!player) return null;
            const { x, y } = project(plot.col, plot.row);
            const stood = { x: x + TILE_W * 0.24, y: y + TILE_H * 0.28 };

            return (
              <g key={plot.slot}>
                {mySlot === plot.slot && <Pennant x={x} y={y} tall={player.alive} />}
                {/* Away at their own trial: the plot keeps the house, the square keeps them. */}
                {player.alive && plot.slot !== accused?.slot && (
                  <Villager x={stood.x} y={stood.y} hue={seatHue(plot.slot)} />
                )}
                {!player.alive && <Tombstone x={stood.x} y={stood.y} />}
              </g>
            );
          })}

          {/* Under the rope, in their own seat's colour, so the roster names them. */}
          {accused && <Villager x={centre.x + 11} y={centre.y - 2} hue={seatHue(accused.slot)} accused />}
        </g>
      </svg>
    </div>
  );
}

/**
 * A prism, a roof, a door, one window. The skin slot.
 *
 * `barred` is the house of someone in the ground. The plot used to swap the
 * house out for a headstone, which quietly emptied the hill: by the endgame half
 * the ring was bare lawn, and a town that loses its houses stops reading as a
 * town. Nobody demolishes a house when its owner dies — they board it up. So
 * the house stays, planks go across the door and the window, and the lamp never
 * comes on again at night.
 */
function House({ x, y, night, barred = false }: { x: number; y: number; night: boolean; barred?: boolean }) {
  const w = TILE_W * 0.5;
  const h = TILE_H * 0.5;
  const wall = 21;
  const roof = 13;
  const base = y + h / 2 - 2;
  const eave = base - h / 2 - wall;

  return (
    <g className={barred ? 'mz-house mz-house--barred' : 'mz-house'}>
      <polygon points={`${x - w / 2},${base - h / 2} ${x},${base} ${x},${base - wall} ${x - w / 2},${eave}`} className="mz-wall-l" />
      <polygon points={`${x + w / 2},${base - h / 2} ${x},${base} ${x},${base - wall} ${x + w / 2},${eave}`} className="mz-wall-r" />
      <polygon points={`${x - w / 2},${eave} ${x},${base - wall} ${x + w / 2},${eave} ${x},${eave - roof}`} className="mz-roof" />
      <rect
        x={x + w * 0.1}
        y={eave + 7}
        width={7}
        height={7}
        className={night && !barred ? 'mz-window mz-window--lit' : 'mz-window'}
      />
      <rect x={x - w * 0.28} y={base - h / 4 - 11} width={7} height={11} className="mz-door" />
      {barred && <Boards x={x} w={w} h={h} base={base} eave={eave} />}
    </g>
  );
}

/**
 * The planks: an X over the door, one bar across the window.
 *
 * Nailed to the house's own geometry rather than to numbers of its own, so a
 * later skin that moves the door takes its boards with it.
 */
function Boards({ x, w, h, base, eave }: { x: number; w: number; h: number; base: number; eave: number }) {
  const doorX = x - w * 0.28;
  const doorTop = base - h / 4 - 11;
  const winX = x + w * 0.1;
  const winMid = eave + 10.5;

  return (
    <g className="mz-boards">
      <line x1={doorX - 2} y1={doorTop + 2} x2={doorX + 9} y2={doorTop + 9} className="mz-plank" />
      <line x1={doorX - 2} y1={doorTop + 9} x2={doorX + 9} y2={doorTop + 2} className="mz-plank" />
      <line x1={winX - 1.5} y1={winMid} x2={winX + 8.5} y2={winMid} className="mz-plank" />
    </g>
  );
}

function Villager({ x, y, hue, accused = false }: { x: number; y: number; hue: number; accused?: boolean }) {
  return (
    <g className={accused ? 'mz-villager mz-villager--accused' : 'mz-villager'}>
      <ellipse cx={x} cy={y + 7} rx={7} ry={3} className="mz-villager-shadow" />
      <path
        d={`M ${x - 5} ${y + 5} Q ${x - 6} ${y - 6} ${x} ${y - 7} Q ${x + 6} ${y - 6} ${x + 5} ${y + 5} Z`}
        fill={`hsl(${hue} 52% 46%)`}
      />
      <circle cx={x} cy={y - 11} r={4.5} fill={`hsl(${hue} 40% 70%)`} />
    </g>
  );
}

function Tombstone({ x, y }: { x: number; y: number }) {
  return (
    <g className="mz-tomb">
      <ellipse cx={x} cy={y + 5} rx={12} ry={4} className="mz-tomb-ground" />
      <path d={`M ${x - 7} ${y + 4} L ${x - 7} ${y - 11} Q ${x} ${y - 20} ${x + 7} ${y - 11} L ${x + 7} ${y + 4} Z`} className="mz-tomb-stone" />
    </g>
  );
}

function Fountain({ x, y }: { x: number; y: number }) {
  return (
    <g className="mz-fountain">
      <ellipse cx={x} cy={y} rx={17} ry={8} className="mz-fountain-basin" />
      <ellipse cx={x} cy={y - 3} rx={7} ry={3.5} className="mz-fountain-water" />
    </g>
  );
}

function Gallows({ x, y }: { x: number; y: number }) {
  return (
    <g className="mz-gallows">
      <ellipse cx={x} cy={y + 2} rx={17} ry={8} className="mz-gallows-base" />
      <rect x={x - 15} y={y - 44} width={4} height={46} />
      <rect x={x - 15} y={y - 44} width={30} height={4} />
      <line x1={x + 11} y1={y - 40} x2={x + 11} y2={y - 26} className="mz-rope" />
      <circle cx={x + 11} cy={y - 22} r={4.5} className="mz-noose" />
    </g>
  );
}

/** Your own plot, marked without a word on it. */
function Pennant({ x, y, tall }: { x: number; y: number; tall: boolean }) {
  const top = y - (tall ? 46 : 26);
  return (
    <g className="mz-pennant">
      <line x1={x - TILE_W * 0.3} y1={y} x2={x - TILE_W * 0.3} y2={top} />
      <polygon
        points={`${x - TILE_W * 0.3},${top} ${x - TILE_W * 0.3 + 15},${top + 5} ${x - TILE_W * 0.3},${top + 10}`}
        className="mz-pennant-flag"
      />
    </g>
  );
}
