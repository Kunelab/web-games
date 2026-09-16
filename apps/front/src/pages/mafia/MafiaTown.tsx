import { useEffect, useState } from 'react';

import type { MafiaPublicPlayer } from 'mafia-core';

import { mafiaFolkArt, mafiaTownArt } from '../../app/assets';

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
 * **The houses stand on two streets that open towards you.** They used to ring a
 * square, which meant a quarter of the town stood along the bottom edge with
 * its back to the camera, in front of everything else, hiding the square it was
 * supposed to surround. Now the plots form a chevron — one street running down
 * to the left, one down to the right, nothing across the near side — so every
 * roof is behind the square rather than in front of it, every house faces in,
 * and the ground nearest the viewer is left clear for the people standing on it.
 *
 * **A seat's house is drawn at random.** Slot order used to be plot order, which
 * made the town a bar chart of the join list: the first four to arrive owned one
 * corner and the stragglers owned the opposite one, and anybody could read the
 * lobby off the hill. The plot is drawn from the join code instead, so it is
 * stable for the whole game and identical on every screen, and it tells you
 * nothing about who sat down when.
 *
 * Three layers, painted in that order: the ground and the square, then the
 * houses in depth order, then *the folk* — every villager, grave and pennant in
 * one pass on top. The third layer is not a flourish. A villager stands at the
 * near corner of its own plot, which puts it inside the next plot's footprint:
 * with one group per plot, the neighbour's roof was painted over half the
 * town's heads. A villager is a player, and a player is never scenery you can
 * lose behind a wall.
 *
 * The art is a set of cutouts under `public/games/mafia/`, and every one of them
 * is allowed to be missing: the vector town underneath is the fallback, so a
 * fresh checkout with no art in it still shows a town rather than a blank strip.
 */

/** Plot to plot along one street, in projected pixels. */
const STEP_X = 54;
const STEP_Y = 18;
/** How far the innermost plot stands off the apex, so the two streets do not meet. */
const APEX_GAP = 6;
/** How far in front of the back street the near one runs, and how far it is inset. */
const FRONT_Y = 62;
const FRONT_X = 27;
/** Six plots per street per row: two rows, two streets, twenty-four seats. */
const PER_ROW = 6;

/** How wide a house is drawn, and the box its cutout is fitted into. */
const HOUSE_W = 72;
const HOUSE_H = 80;
const VILLAGER_W = 26;
const VILLAGER_H = 46;

interface Plot {
  index: number;
  x: number;
  y: number;
  /** Left street or right. Decides which way everything on it faces. */
  side: 'left' | 'right';
}

/**
 * Two streets of two rows, from the apex outwards.
 *
 * Twenty-four plots in one line would be a mile of village: at a step wide
 * enough to see a door, the town is twice the width of a phone, and at a step
 * narrow enough to fit, each house is a roof tile. Two rows halve the width and
 * buy the one thing a flat chevron has none of, which is depth — the near row
 * sits between the far one and the square, inset half a step so it reads as a
 * second street rather than as a second copy of the first.
 *
 * The apex itself is left empty. It is where the two streets would meet, and a
 * house there has no side to face.
 */
const PLOTS: Plot[] = (() => {
  const plots: Plot[] = [];
  const add = (x: number, y: number, side: 'left' | 'right'): void => {
    plots.push({ index: plots.length, x: side === 'right' ? x : -x, y, side });
  };
  for (let step = 1; step <= PER_ROW; step++) {
    add(step * STEP_X + APEX_GAP, step * STEP_Y, 'right');
    add(step * STEP_X + APEX_GAP, step * STEP_Y, 'left');
  }
  for (let step = 1; step <= PER_ROW; step++) {
    add(step * STEP_X + APEX_GAP - FRONT_X, FRONT_Y + step * STEP_Y, 'right');
    add(step * STEP_X + APEX_GAP - FRONT_X, FRONT_Y + step * STEP_Y, 'left');
  }
  return plots;
})();

/**
 * Painter's order: far first, so a near house overlaps the one behind it.
 *
 * Each plot paints its house *and then its own villager*, rather than the town
 * painting every roof and every person in two passes. The two-pass version was
 * right when the houses were a single ring and wrong the moment there were two
 * rows of them: a villager on the back street was painted over the roof of the
 * house in front of it and appeared to be standing on the neighbour's thatch.
 * Within a row the geometry keeps them clear of each other — a house is wider
 * than a step, a villager is not — so painting in depth costs nothing and the
 * one thing it fixes is the thing that looked broken.
 */
const PAINT_ORDER = [...PLOTS].sort((a, b) => a.y - b.y || Math.abs(a.x) - Math.abs(b.x));

/** The middle of the open ground the two streets enclose. */
const SQUARE = { x: 0, y: FRONT_Y + PER_ROW * STEP_Y + 44 };

/**
 * Which plot a seat lives on, drawn from the table's own code.
 *
 * Deterministic, so every phone, television and reload agrees without the
 * server having to carry a field for it; and shuffled, so the hill is not a
 * picture of the join order. A seat keeps its house for the whole game, which
 * is the property that matters: people navigate by "the one on the end".
 */
function plotsFor(seed: string): Map<number, Plot> {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  let state = hash >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };

  // Fisher-Yates, seeded. `sort(() => rng() - 0.5)` is not a shuffle.
  const order = [...PLOTS];
  for (let index = order.length - 1; index > 0; index--) {
    const swap = Math.floor(next() * (index + 1));
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  return new Map(order.map((plot, index) => [index + 1, plot]));
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

/**
 * Whether this browser has the town's art.
 *
 * Probed once per page rather than per house: the whole set ships together, so
 * one file answering for all of them is the truth and twenty-four onError
 * handlers are not. Until it answers, the vector town is drawn — it is instant,
 * it is never wrong, and it is what a checkout with no art in it gets forever.
 */
let artProbe: Promise<boolean> | null = null;
function useTownArt(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    artProbe ??= new Promise<boolean>((resolve) => {
      const image = new Image();
      image.onload = () => resolve(true);
      image.onerror = () => resolve(false);
      image.src = mafiaTownArt('house-village-day');
    });
    let mounted = true;
    void artProbe.then((found) => {
      if (mounted) setReady(found);
    });
    return () => {
      mounted = false;
    };
  }, []);
  return ready;
}

export type TownTheme = 'village' | 'cite';

export interface MafiaTownProps {
  players: MafiaPublicPlayer[];
  mySlot: number | null;
  night: boolean;
  /** The table's join code: what the plot shuffle is drawn from. */
  seed?: string;
  /** Skin hook. Colours only for now; a second set of cutouts swaps in later. */
  theme?: TownTheme;
  /**
   * How much board to fit in the frame. 1 is the town filling it; 1.5 pulls the
   * camera back by half, which is what a twenty-four house street needs before
   * the names on the roster and the houses on the hill line up in one glance.
   */
  zoom?: number;
}

export function MafiaTown({ players, mySlot, night, seed = '', theme = 'village', zoom = 1 }: MafiaTownProps) {
  const art = useTownArt();
  const bySlot = new Map(players.map((player) => [player.slot, player]));
  // Plot to seat, which is the direction the painters need: they walk the town
  // in depth order and ask who lives here.
  const livesHere = new Map([...plotsFor(seed)].map(([slot, plot]) => [plot.index, slot]));

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
  const pad = 26 * zoom;
  const reach = PER_ROW * STEP_X + APEX_GAP + HOUSE_W / 2;
  const minX = -reach - pad;
  const maxX = reach + pad;
  const minY = -HOUSE_H - pad;
  const maxY = SQUARE.y + 46 + pad;

  return (
    <div className={`mz-town${night ? ' mz-town--night' : ''}`} data-town-theme={theme}>
      <svg
        className="mz-town-canvas"
        viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
        aria-hidden="true"
        focusable="false"
      >
        <polygon
          points={diamond(SQUARE.x, SQUARE.y - STEP_Y * 5, reach * 3, (SQUARE.y + HOUSE_H) * 1.8)}
          className="mz-ground"
        />

        {/*
          The town, painted from the back of the hill forwards.

          House then villager, plot by plot, so a person is in front of their own
          house and behind whatever stands between them and the square. Graves
          come along in the same pass, because a grave stands exactly where its
          owner used to and a marker you cannot see marks nothing.
        */}
        {PAINT_ORDER.map((plot) => {
          const slot = livesHere.get(plot.index);
          const player = slot === undefined ? undefined : bySlot.get(slot);
          // In front of the door, on the side the street faces.
          const stood = { x: plot.x + (plot.side === 'right' ? -12 : 12), y: plot.y + 20 };

          return (
            <g key={plot.index} className={`mz-plot${player && !player.alive ? ' mz-plot--dead' : ''}`}>
              <polygon points={diamond(plot.x, plot.y + 8, 62, 22)} className="mz-plot-ground" />
              {!player && <polygon points={diamond(plot.x, plot.y + 8, 26, 10)} className="mz-plot-empty" />}
              {player && <House plot={plot} art={art} night={night} barred={!player.alive} />}
              {player && slot !== undefined && (
                <>
                  {mySlot === slot && <Pennant x={plot.x} y={plot.y} tall={player.alive} />}
                  {/* Away at their own trial: the plot keeps the house, the square keeps them. */}
                  {player.alive && slot !== accused?.slot && (
                    <Villager x={stood.x} y={stood.y} hue={seatHue(slot)} art={art} facing={plot.side} />
                  )}
                  {!player.alive && <Tombstone x={stood.x} y={stood.y} art={art} />}
                </>
              )}
            </g>
          );
        })}

        {/* The square, in front of every house and behind nothing. */}
        <g className="mz-square">
          <polygon points={diamond(SQUARE.x, SQUARE.y, 186, 64)} className="mz-plaza" />
          {accused ? (
            <Prop
              art={art}
              file="prop-gallows"
              x={SQUARE.x}
              y={SQUARE.y}
              w={78}
              h={92}
              fallback={<Gallows x={SQUARE.x} y={SQUARE.y} />}
            />
          ) : (
            <Prop
              art={art}
              file="prop-fountain"
              x={SQUARE.x}
              y={SQUARE.y}
              w={88}
              h={70}
              fallback={<Fountain x={SQUARE.x} y={SQUARE.y} />}
            />
          )}

          {/* Under the rope, in their own seat's colour, so the roster names them. */}
          {accused && (
            <Villager
              x={SQUARE.x + 30}
              y={SQUARE.y + 8}
              hue={seatHue(accused.slot)}
              art={art}
              facing="right"
              accused
            />
          )}
        </g>
      </svg>
    </div>
  );
}

/**
 * A cutout, anchored by its feet.
 *
 * `xMidYMax meet` is the whole trick: the art is trimmed to its own edges and
 * every piece has a different aspect, so fitting it into a box that touches the
 * ground at the bottom centre means a taller house and a squatter one both stand
 * on the same spot without anybody measuring either.
 */
function Sprite({
  file,
  x,
  y,
  w,
  h,
  mirrored = false,
  folk = false
}: {
  file: string;
  x: number;
  y: number;
  w: number;
  h: number;
  mirrored?: boolean;
  folk?: boolean;
}) {
  return (
    <image
      href={folk ? mafiaFolkArt(file) : mafiaTownArt(file)}
      x={-w / 2}
      y={-h}
      width={w}
      height={h}
      preserveAspectRatio="xMidYMax meet"
      transform={`translate(${x} ${y})${mirrored ? ' scale(-1 1)' : ''}`}
    />
  );
}

/** A prop in the square: the art when it is there, the drawn one when it is not. */
function Prop({
  art,
  file,
  x,
  y,
  w,
  h,
  fallback
}: {
  art: boolean;
  file: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fallback: React.ReactNode;
}) {
  if (!art) return <>{fallback}</>;
  return <Sprite file={file} x={x} y={y + 6} w={w} h={h} />;
}

/**
 * A house, facing the square it stands on.
 *
 * The cutout is drawn with its door towards the lower left, so a house on the
 * right-hand street already looks inward and one on the left-hand street is
 * mirrored to match. That is the only rotation a flat sprite has, and it is the
 * one that matters: a row of houses all facing the same way reads as wallpaper,
 * and a house with its back to the square reads as a mistake.
 *
 * `barred` is the house of somebody in the ground. The plot used to swap the
 * house out for a headstone, which quietly emptied the hill: by the endgame half
 * the street was bare lawn, and a town that loses its houses stops reading as a
 * town. Nobody demolishes a house when its owner dies — they board it up.
 */
function House({ plot, art, night, barred = false }: { plot: Plot; art: boolean; night: boolean; barred?: boolean }) {
  if (art) {
    return (
      <g className={barred ? 'mz-house mz-house--barred' : 'mz-house'}>
        <ellipse cx={plot.x} cy={plot.y + 4} rx={30} ry={9} className="mz-house-shadow" />
        <Sprite
          file={barred ? 'house-village-boarded' : 'house-village-day'}
          x={plot.x}
          y={plot.y + 8}
          w={HOUSE_W}
          h={HOUSE_H}
          mirrored={plot.side === 'left'}
        />
      </g>
    );
  }
  return <DrawnHouse x={plot.x} y={plot.y} night={night} barred={barred} />;
}

/** The town as it was drawn before there was any art, kept as the floor. */
function DrawnHouse({ x, y, night, barred = false }: { x: number; y: number; night: boolean; barred?: boolean }) {
  const w = 38;
  const h = 13;
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

/**
 * A villager, facing the same way as the house behind them.
 *
 * The cutout carries no seat colour, so the tint moves to the ground under
 * their feet: twenty-four identical models are a crowd, and the one thing the
 * hill has to do is let you find your own seat in it.
 */
function Villager({
  x,
  y,
  hue,
  art,
  facing,
  accused = false
}: {
  x: number;
  y: number;
  hue: number;
  art: boolean;
  facing: 'left' | 'right';
  accused?: boolean;
}) {
  if (art) {
    return (
      <g className={accused ? 'mz-villager mz-villager--accused' : 'mz-villager'}>
        <ellipse cx={x} cy={y + 2} rx={9} ry={3.5} fill={`hsl(${hue} 52% 46%)`} className="mz-villager-mark" />
        <Sprite
          file={accused ? 'model-villager-accused' : 'model-villager-base'}
          x={x}
          y={y}
          w={VILLAGER_W}
          h={VILLAGER_H}
          mirrored={facing === 'left'}
          folk
        />
      </g>
    );
  }

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

function Tombstone({ x, y, art }: { x: number; y: number; art: boolean }) {
  if (art) {
    return (
      <g className="mz-tomb">
        <ellipse cx={x} cy={y + 2} rx={11} ry={4} className="mz-tomb-ground" />
        <Sprite file="prop-tombstone" x={x} y={y + 2} w={34} h={34} />
      </g>
    );
  }
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
  const top = y - (tall ? 62 : 34);
  return (
    <g className="mz-pennant">
      <line x1={x - 30} y1={y} x2={x - 30} y2={top} />
      <polygon points={`${x - 30},${top} ${x - 15},${top + 5} ${x - 30},${top + 10}`} className="mz-pennant-flag" />
    </g>
  );
}
