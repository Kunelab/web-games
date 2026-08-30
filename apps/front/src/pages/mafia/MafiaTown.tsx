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
  /** Someone is at the barre: the fountain becomes a gallows. */
  onTrial: boolean;
  /** Skin hook. Colours only for now; house and villager art swap in later. */
  theme?: TownTheme;
  /**
   * How much board to fit in the frame. 1 is the town filling it; 1.5 pulls the
   * camera back by half, which is what a twenty-four house ring needs before the
   * names on the roster and the houses on the hill line up in one glance.
   */
  zoom?: number;
}

export function MafiaTown({ players, mySlot, night, onTrial, theme = 'village', zoom = 1 }: MafiaTownProps) {
  const bySlot = new Map(players.map((player) => [player.slot, player]));
  const centre = project((GRID - 1) / 2, (GRID - 1) / 2);

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
          {onTrial ? <Gallows x={centre.x} y={centre.y} /> : <Fountain x={centre.x} y={centre.y} />}
        </g>

        {PAINT_ORDER.map((plot) => {
          const player = bySlot.get(plot.slot);
          const { x, y } = project(plot.col, plot.row);
          const mine = mySlot === plot.slot;

          return (
            <g key={plot.slot} className={`mz-plot${player && !player.alive ? ' mz-plot--dead' : ''}`}>
              <polygon points={diamond(x, y, TILE_W * 0.92, TILE_H * 0.92)} className="mz-plot-ground" />

              {!player && <polygon points={diamond(x, y, TILE_W * 0.42, TILE_H * 0.42)} className="mz-plot-empty" />}
              {player?.alive && <House x={x} y={y} night={night} />}
              {player && !player.alive && <Tombstone x={x} y={y} />}
              {player?.alive && <Villager x={x + TILE_W * 0.24} y={y + TILE_H * 0.28} hue={seatHue(plot.slot)} />}
              {mine && player && <Pennant x={x} y={y} tall={player.alive} />}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** A prism, a roof, a door, one window. The skin slot. */
function House({ x, y, night }: { x: number; y: number; night: boolean }) {
  const w = TILE_W * 0.5;
  const h = TILE_H * 0.5;
  const wall = 21;
  const roof = 13;
  const base = y + h / 2 - 2;
  const eave = base - h / 2 - wall;

  return (
    <g className="mz-house">
      <polygon points={`${x - w / 2},${base - h / 2} ${x},${base} ${x},${base - wall} ${x - w / 2},${eave}`} className="mz-wall-l" />
      <polygon points={`${x + w / 2},${base - h / 2} ${x},${base} ${x},${base - wall} ${x + w / 2},${eave}`} className="mz-wall-r" />
      <polygon points={`${x - w / 2},${eave} ${x},${base - wall} ${x + w / 2},${eave} ${x},${eave - roof}`} className="mz-roof" />
      <rect
        x={x + w * 0.1}
        y={eave + 7}
        width={7}
        height={7}
        className={night ? 'mz-window mz-window--lit' : 'mz-window'}
      />
      <rect x={x - w * 0.28} y={base - h / 4 - 11} width={7} height={11} className="mz-door" />
    </g>
  );
}

function Villager({ x, y, hue }: { x: number; y: number; hue: number }) {
  return (
    <g className="mz-villager">
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
