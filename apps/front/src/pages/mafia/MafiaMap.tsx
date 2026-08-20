import type { MafiaPublicPlayer } from 'mafia-core';

/**
 * The town, in fake three dimensions and zero assets.
 *
 * Twenty-four plots sit on the ring of a 7×7 isometric grid — the perimeter of
 * that square is exactly 24 cells, so every seat number has a fixed house
 * forever, whatever the future skin. Houses are flat-shaded prisms and the
 * villagers are pegs: the deliberately skinless stand-ins the store will
 * dress later. Everything is one SVG; a phone renders it without breaking a
 * sweat and a click on a plot is a click on a seat.
 */

const TILE_W = 76;
const TILE_H = 38;
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

function project(col: number, row: number): { x: number; y: number } {
  return { x: ((col - row) * TILE_W) / 2, y: ((col + row) * TILE_H) / 2 };
}

function slotHue(slot: number): number {
  return Math.round(((slot - 1) * 360) / 24);
}

const diamond = (x: number, y: number, w: number, h: number): string =>
  `${x},${y - h / 2} ${x + w / 2},${y} ${x},${y + h / 2} ${x - w / 2},${y}`;

export interface MafiaMapProps {
  players: MafiaPublicPlayer[];
  mySlot: number | null;
  night: boolean;
  trialSlot: number | null;
  /** Slots currently clickable, if any. */
  targets?: ReadonlySet<number>;
  selectedSlot?: number | null;
  onSelect?: (slot: number) => void;
}

export function MafiaMap({ players, mySlot, night, trialSlot, targets, selectedSlot, onSelect }: MafiaMapProps) {
  const bySlot = new Map(players.map((player) => [player.slot, player]));
  const center = project((GRID - 1) / 2, (GRID - 1) / 2);

  // Fixed frame around the projected grid.
  const pad = 70;
  const corners = [project(0, 0), project(GRID - 1, 0), project(GRID - 1, GRID - 1), project(0, GRID - 1)];
  const minX = Math.min(...corners.map((c) => c.x)) - pad;
  const maxX = Math.max(...corners.map((c) => c.x)) + pad;
  const minY = Math.min(...corners.map((c) => c.y)) - pad;
  const maxY = Math.max(...corners.map((c) => c.y)) + pad + 30;

  return (
    <svg
      className={night ? 'mz-map mz-map--night' : 'mz-map'}
      viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
      role="img"
      aria-label="La ville"
    >
      {/* Ground. */}
      <polygon
        points={diamond(center.x, center.y, (GRID + 1) * TILE_W, (GRID + 1) * TILE_H)}
        className="mz-ground"
      />

      {/* Town square: a fountain by day and peace, a gallows during a trial. */}
      <g className="mz-square">
        <polygon points={diamond(center.x, center.y, TILE_W * 2.2, TILE_H * 2.2)} className="mz-plaza" />
        {trialSlot === null ? (
          <>
            <ellipse cx={center.x} cy={center.y} rx={16} ry={8} className="mz-fountain" />
            <ellipse cx={center.x} cy={center.y - 4} rx={7} ry={3.5} className="mz-fountain-top" />
          </>
        ) : (
          <g className="mz-gallows">
            <rect x={center.x - 22} y={center.y - 46} width={5} height={48} />
            <rect x={center.x - 22} y={center.y - 46} width={36} height={5} />
            <line x1={center.x + 10} y1={center.y - 42} x2={center.x + 10} y2={center.y - 26} className="mz-rope" />
            <circle cx={center.x + 10} cy={center.y - 22} r={5} className="mz-noose" />
          </g>
        )}
      </g>

      {PLOTS.map((plot) => {
        const player = bySlot.get(plot.slot);
        const { x, y } = project(plot.col, plot.row);
        const clickable = !!player && !!targets?.has(plot.slot) && !!onSelect;
        const isSelected = selectedSlot === plot.slot;
        const isTrial = trialSlot === plot.slot;

        const classes = [
          'mz-plot',
          clickable ? 'mz-plot--target' : '',
          isSelected ? 'mz-plot--selected' : '',
          isTrial ? 'mz-plot--trial' : '',
          player && !player.alive ? 'mz-plot--dead' : ''
        ]
          .filter(Boolean)
          .join(' ');

        return (
          <g
            key={plot.slot}
            className={classes}
            onClick={clickable ? () => onSelect(plot.slot) : undefined}
            role={clickable ? 'button' : undefined}
          >
            <polygon points={diamond(x, y, TILE_W * 0.94, TILE_H * 0.94)} className="mz-plot-ground" />

            {player ? (
              player.alive ? (
                <House x={x} y={y} night={night} />
              ) : (
                <Tombstone x={x} y={y} />
              )
            ) : (
              <polygon points={diamond(x, y, TILE_W * 0.5, TILE_H * 0.5)} className="mz-plot-empty" />
            )}

            {player?.alive && <Peg x={x} y={y + TILE_H * 0.32} hue={slotHue(plot.slot)} connected={player.connected} />}

            <text x={x} y={y + TILE_H * 0.95} textAnchor="middle" className="mz-name">
              {plot.slot}. {player ? player.name : '—'}
              {player?.revealedMayor ? ' 🎗️' : ''}
            </text>

            {player && player.votesAgainst > 0 && (
              <g className="mz-votes">
                <circle cx={x + TILE_W * 0.3} cy={y - TILE_H * 0.9} r={10} />
                <text x={x + TILE_W * 0.3} y={y - TILE_H * 0.9 + 3.5} textAnchor="middle">
                  {player.votesAgainst}
                </text>
              </g>
            )}

            {player && mySlot === plot.slot && (
              <text x={x} y={y - TILE_H * 1.25} textAnchor="middle" className="mz-you">
                ▼ vous
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** A skinless house: three faces of a prism and a door. The future skin slot. */
function House({ x, y, night }: { x: number; y: number; night: boolean }) {
  const w = TILE_W * 0.52;
  const h = TILE_H * 0.52;
  const wall = 22;
  const roof = 14;
  const baseY = y + h / 2 - 2;
  return (
    <g className="mz-house">
      {/* left wall */}
      <polygon points={`${x - w / 2},${baseY - h / 2} ${x},${baseY} ${x},${baseY - wall} ${x - w / 2},${baseY - h / 2 - wall}`} className="mz-wall-l" />
      {/* right wall */}
      <polygon points={`${x + w / 2},${baseY - h / 2} ${x},${baseY} ${x},${baseY - wall} ${x + w / 2},${baseY - h / 2 - wall}`} className="mz-wall-r" />
      {/* roof */}
      <polygon
        points={`${x - w / 2},${baseY - h / 2 - wall} ${x},${baseY - wall} ${x + w / 2},${baseY - h / 2 - wall} ${x},${baseY - h - wall - roof}`}
        className="mz-roof"
      />
      {/* window, lit at night */}
      <rect x={x + w * 0.14} y={baseY - wall + 2 - h / 2} width={7} height={7} className={night ? 'mz-window mz-window--lit' : 'mz-window'} />
      {/* door */}
      <rect x={x - w * 0.3} y={baseY - 12 - h / 4} width={8} height={12} className="mz-door" />
    </g>
  );
}

/** A skinless villager: a peg with a head, tinted by seat. */
function Peg({ x, y, hue, connected }: { x: number; y: number; hue: number; connected: boolean }) {
  return (
    <g className={connected ? 'mz-peg' : 'mz-peg mz-peg--away'}>
      <ellipse cx={x} cy={y + 8} rx={9} ry={4} className="mz-shadow" />
      <path d={`M ${x - 6} ${y + 6} Q ${x - 7} ${y - 8} ${x} ${y - 9} Q ${x + 7} ${y - 8} ${x + 6} ${y + 6} Z`} fill={`hsl(${hue}, 55%, 48%)`} />
      <circle cx={x} cy={y - 13} r={5.5} fill={`hsl(${hue}, 45%, 68%)`} />
    </g>
  );
}

function Tombstone({ x, y }: { x: number; y: number }) {
  return (
    <g className="mz-tomb">
      <ellipse cx={x} cy={y + 6} rx={13} ry={5} className="mz-tomb-ground" />
      <path d={`M ${x - 8} ${y + 5} L ${x - 8} ${y - 10} Q ${x} ${y - 19} ${x + 8} ${y - 10} L ${x + 8} ${y + 5} Z`} className="mz-tomb-stone" />
      <text x={x} y={y - 2} textAnchor="middle" className="mz-tomb-rip">
        ✝
      </text>
    </g>
  );
}
