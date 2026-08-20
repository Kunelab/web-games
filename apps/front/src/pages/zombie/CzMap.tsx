import {
  heroDef,
  PROGRAM_LABELS,
  RARITY_META,
  SHINY_LOOT,
  zombieDef,
  type CzRoomView,
  type CzView
} from 'coronaz-core';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { heroHue, zombieSprite } from './czAssets';
import { loadArtManifest, onArtLoaded } from './iso/art';
import {
  boardBounds,
  boundsSize,
  diamond,
  fitZoom,
  project,
  screenToWorld,
  TILE_H,
  type Camera,
  type Vec2
} from './iso/geometry';
import { pickCellAt, renderScene, sceneSignature } from './iso/scene';
import { useCzCamera, type FollowTarget } from './useCzCamera';

/**
 * The board, in fake three dimensions, for every screen at once.
 *
 * The floor, the walls and the furniture are painted into an offscreen canvas by
 * `renderScene` and blitted under the camera, so dragging and zooming a building
 * costs one composite per frame. The creatures live in a DOM layer on top: they
 * need tap targets, health bars and a CSS transition that makes a state update
 * look like a walk rather than a teleport, and none of that is worth reinventing
 * inside a canvas.
 *
 * The camera is the new part. A phone drags and pinches, a PC drags and wheels
 * like an RTS, and a television drives itself — following the survivors while
 * they act, pulling back to the whole floor plan when the horde takes its turn,
 * and standing down for anyone who touches it.
 */
export function CzMap({
  view,
  onRoomTap,
  onZombieTap,
  targetRooms,
  selectedZombieId,
  inReach,
  spentZombies,
  focusRoomId,
  myPlayerId,
  compact = false,
  camera: cameraMode = 'manual'
}: {
  view: CzView;
  onRoomTap?: (roomId: string) => void;
  onZombieTap?: (zombieId: string) => void;
  targetRooms?: ReadonlySet<string>;
  selectedZombieId?: string | null;
  /**
   * The creatures the tap would actually reach. Given, everything else on the
   * board dims: the phone stops offering taps it knows the server will refuse,
   * which is the whole reason combat used to read as random.
   */
  inReach?: ReadonlySet<string>;
  /** Creatures with no action points left, for the game master's queue. */
  spentZombies?: ReadonlySet<string>;
  /**
   * A room to put the camera on when this value changes.
   *
   * The game master's queue button needs it: selecting the next creature that owes
   * a turn is worthless if that creature is off-screen, which on a district-sized
   * board it usually is. Only *changes* move the camera, so a hand that has since
   * dragged elsewhere is not yanked back on every state broadcast.
   */
  focusRoomId?: string | null;
  myPlayerId?: string | null;
  compact?: boolean;
  /**
   * `manual`: only the player moves it. `auto`: it follows the action and frames
   * the whole floor during the horde's phase, until a human interrupts.
   */
  camera?: 'manual' | 'auto';
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [artTick, setArtTick] = useState(0);
  /**
   * Where a self-driving screen should look, recomputed from the state rather
   * than stored: the shot is a function of the phase and who is where, so it has
   * no business being state that could disagree with the board.
   */
  const [viewportSize, setViewportSize] = useState<Vec2>({ x: 0, y: 0 });
  const follow = useMemo(
    () => (cameraMode === 'auto' && viewportSize.x > 0 ? actionShot(view, viewportSize, myPlayerId ?? null) : null),
    [cameraMode, view, viewportSize, myPlayerId]
  );

  /** The opening shot: your own survivor if you have one, else the start room. */
  const openOn = useMemo(() => {
    const roomById = new Map(view.rooms.map((room) => [room.id, room]));
    const mine = myPlayerId ? view.heroes.find((hero) => hero.playerId === myPlayerId) : undefined;
    const room =
      (mine ? roomById.get(mine.roomId) : undefined) ??
      view.rooms.find((candidate) => candidate.kind === 'start') ??
      view.rooms[0];
    const cell = room?.cells[0];
    if (cell === undefined) return null;
    return project(cell % view.width, Math.floor(cell / view.width));
    // The first frame is the only one this feeds, so the party's later movements
    // are `follow`'s business, not this one's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.width, view.rooms.length]);

  const { containerRef, camera, viewport, following, fitAll, zoomBy, jumpTo } = useCzCamera({
    width: view.width,
    height: view.height,
    follow,
    openOn
  });
  if (viewport.x !== viewportSize.x || viewport.y !== viewportSize.y) {
    // The camera owns the measurement; the shot needs it. Assigning during
    // render is what React recommends over an effect for derived state.
    setViewportSize(viewport);
  }

  /**
   * Put the camera on a named room when the caller changes its mind about which
   * room matters. The dependency list is deliberately only the id: re-centring on
   * every broadcast would fight the hand that is dragging.
   */
  useEffect(() => {
    if (!focusRoomId) return;
    const room = view.rooms.find((candidate) => candidate.id === focusRoomId);
    const cell = room?.cells[0];
    if (cell === undefined) return;
    jumpTo(project(cell % view.width, Math.floor(cell / view.width)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the id is the trigger
  }, [focusRoomId]);

  /* --------------------------------- the art -------------------------------- */

  useEffect(() => {
    loadArtManifest();
    // A raster arriving mid-raid repaints the scene rather than waiting a turn.
    return onArtLoaded(() => setArtTick((tick) => tick + 1));
  }, []);

  const signature = sceneSignature(view);
  const scene = useMemo(
    () => renderScene(view, typeof window === 'undefined' ? 1 : Math.min(2, window.devicePixelRatio || 1)),
    // The signature is the whole dependency: it changes exactly when the picture
    // would, and repainting a whole building on every state broadcast would be
    // wasted work. `artTick` forces a repaint when new artwork lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature, artTick]
  );

  /* -------------------------------- painting -------------------------------- */

  const [pulse, setPulse] = useState(0);
  const highlights = targetRooms ?? EMPTY;

  useEffect(() => {
    if (highlights.size === 0) return;
    // Only spin a frame loop while something on the board is asking to be tapped.
    let raf = 0;
    const tick = () => {
      setPulse(performance.now() / 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [highlights.size]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewport.x <= 0 || viewport.y <= 0) return;

    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(viewport.x * ratio);
    const pixelHeight = Math.round(viewport.y * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, viewport.x, viewport.y);
    ctx.fillStyle = '#07080b';
    ctx.fillRect(0, 0, viewport.x, viewport.y);

    // World space, under the camera. Everything below is drawn in world pixels.
    ctx.translate(viewport.x / 2, viewport.y / 2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);

    const sceneImage = scene.canvas;
    const sceneRatio = Math.min(2, window.devicePixelRatio || 1);
    ctx.imageSmoothingEnabled = camera.zoom < 1;
    ctx.drawImage(
      sceneImage,
      scene.origin.x,
      scene.origin.y,
      sceneImage.width / sceneRatio,
      sceneImage.height / sceneRatio
    );

    /**
     * Where you are, and where one step takes you.
     *
     * Outlined as *rooms*, not as tiles. A room owns up to four cells, so the tile
     * beside you may belong to a different room while a tile three cells away is a
     * single step — which is exactly what "I cannot click the tile next to me but a
     * far one counts as next to me" means. Filling each cell separately drew the
     * boundaries *between* cells of one room and hid the boundary that matters, so
     * now only a room's outer border is stroked, and your own room is stroked too.
     */
    const outline = (room: CzRoomView, colour: string, width: number) => {
      ctx.strokeStyle = colour;
      ctx.lineWidth = width / camera.zoom;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (const edge of roomOutline(room, view.width, view.height)) {
        ctx.moveTo(edge[0].x, edge[0].y);
        ctx.lineTo(edge[1].x, edge[1].y);
      }
      ctx.stroke();
    };

    const fillRoom = (room: CzRoomView, colour: string) => {
      ctx.fillStyle = colour;
      for (const cell of room.cells) {
        const shape = diamond(cell % view.width, Math.floor(cell / view.width));
        ctx.beginPath();
        ctx.moveTo(shape[0].x, shape[0].y);
        for (const point of shape.slice(1)) ctx.lineTo(point.x, point.y);
        ctx.closePath();
        ctx.fill();
      }
    };

    if (highlights.size > 0) {
      const wave = 0.45 + 0.3 * Math.sin(pulse * 3.2);
      for (const room of view.rooms) {
        if (!highlights.has(room.id)) continue;
        fillRoom(room, `rgb(110 190 255 / ${(wave * 0.22).toFixed(3)})`);
        outline(room, `rgb(160 215 255 / ${wave.toFixed(3)})`, 2.5);
      }
    }

    const standing = myPlayerId
      ? view.heroes.find((hero) => hero.playerId === myPlayerId && hero.alive && !hero.escaped && !hero.forfeited)
      : undefined;
    const myRoom = standing ? view.rooms.find((room) => room.id === standing.roomId) : undefined;
    if (myRoom) outline(myRoom, 'rgb(255 255 255 / 0.5)', 2);
  });

  /**
   * What the pointer is over, when it is over somewhere you could go.
   *
   * The map knows a great deal a player cannot see: this room is a pharmacy, that one
   * is an armoury, the one past it is a morgue. Outdoors that hardly matters, because
   * a street looks like a street; inside a bunker every door looks the same, and the
   * whole point of giving rooms programmes and loot bonuses is lost if the only way
   * to find out is to spend an action point walking in.
   */
  const [hover, setHover] = useState<{ room: CzRoomView; x: number; y: number } | null>(null);

  /* ------------------------------- interaction ------------------------------ */

  /** Which room a point on the picture is over, via the pick map. */
  function roomUnder(event: React.PointerEvent<HTMLDivElement>): CzRoomView | undefined {
    const element = containerRef.current;
    if (!element) return undefined;
    const rect = element.getBoundingClientRect();
    const world = screenToWorld({ x: event.clientX - rect.left, y: event.clientY - rect.top }, camera, viewport);
    const cell = pickCellAt(scene, world);
    if (cell === null) return undefined;
    return view.rooms.find((candidate) => candidate.cells.includes(cell));
  }

  function onHover(event: React.PointerEvent<HTMLDivElement>) {
    // Only where you could actually go, and only on a device with a pointer: a
    // finger has nothing to hover with, and a label under a thumb is in the way.
    if (event.pointerType !== 'mouse') return;
    const element = containerRef.current;
    if (!element || !onRoomTap) return;
    const room = roomUnder(event);
    if (!room || !highlights.has(room.id) || room.seen === 'hidden') {
      setHover(null);
      return;
    }
    const rect = element.getBoundingClientRect();
    setHover({ room, x: event.clientX - rect.left, y: event.clientY - rect.top });
  }

  function onClick(event: React.PointerEvent<HTMLDivElement>) {
    const element = containerRef.current;
    if (!element || !onRoomTap) return;
    // A drag that ends over a room is not a tap on it.
    if (element.dataset.dragged === 'true') return;
    // Nor is a tap on a creature standing in it: the token has its own job, and
    // it sits inside this element, so its events bubble through here.
    if (event.target instanceof Element && event.target.closest('.cz-token')) return;

    const rect = element.getBoundingClientRect();
    // Ask the picture what is under the pointer, not the projection: everything is
    // drawn standing up from its tile, so the floor's inverse is off by whatever
    // furniture happens to be in the way.
    const world = screenToWorld({ x: event.clientX - rect.left, y: event.clientY - rect.top }, camera, viewport);
    const cell = pickCellAt(scene, world);
    if (cell === null) return;
    const room = view.rooms.find((candidate) => candidate.cells.includes(cell));
    if (room && highlights.has(room.id)) onRoomTap(room.id);
  }

  /* ------------------------------ the creatures ----------------------------- */

  const roomById = useMemo(() => new Map(view.rooms.map((room) => [room.id, room])), [view.rooms]);

  /**
   * Where a creature stands inside its room. Occupants spread across the room's
   * own cells first, then around the middle of one — a 2×2 hall with six zombies
   * in it should look like a crowd in a hall, not a stack on one tile.
   */
  const spots = useMemo(() => {
    const byRoom = new Map<string, number>();
    const result = new Map<string, Vec2>();

    const place = (id: string, room: CzRoomView | undefined, kind: 'hero' | 'zombie') => {
      if (!room) return;
      const seen = byRoom.get(room.id) ?? 0;
      byRoom.set(room.id, seen + 1);

      const cell = room.cells[seen % room.cells.length] ?? room.cells[0] ?? 0;
      const ring = Math.floor(seen / room.cells.length);
      const angle = (seen * 2.399 + (kind === 'hero' ? 0 : Math.PI)) % (Math.PI * 2);
      const spread = 0.16 + ring * 0.11;
      result.set(id, {
        x: (cell % view.width) + Math.cos(angle) * spread + (kind === 'hero' ? -0.06 : 0.06),
        y: Math.floor(cell / view.width) + Math.sin(angle) * spread * 0.8 + (kind === 'hero' ? 0.08 : -0.08)
      });
    };

    for (const hero of view.heroes) {
      if (!hero.alive || hero.escaped || hero.forfeited) continue;
      place(hero.playerId, roomById.get(hero.roomId), 'hero');
    }
    for (const zombie of [...view.zombies].sort((a, b) => a.id.localeCompare(b.id))) {
      place(zombie.id, roomById.get(zombie.roomId), 'zombie');
    }
    return result;
  }, [view.heroes, view.zombies, roomById, view.width]);

  /**
   * Token size in *world* pixels, not screen pixels. The layer below carries the
   * camera, so the zoom is applied once, by the browser, to everything at once.
   */
  const tokenSize = 30;

  /**
   * The camera, as one transform on the whole entity layer.
   *
   * The pieces used to be positioned in screen coordinates, which meant a camera
   * move changed every token's `left` and `top` — and each one is CSS-transitioned
   * so that a *state* update looks like a walk. Recentring or zooming therefore set
   * every creature crawling towards its new screen position, lagging behind the
   * canvas: the wiggle. Positioned in world coordinates under a transformed parent,
   * a camera move is instant (the transform is not transitioned) and only an actual
   * step still animates.
   */
  const cameraTransform = {
    transform: `translate(${(viewport.x / 2 - camera.x * camera.zoom).toFixed(2)}px, ${(viewport.y / 2 - camera.y * camera.zoom).toFixed(2)}px) scale(${camera.zoom.toFixed(4)})`,
    transformOrigin: '0 0',
    /**
     * The zoom, published so a tap target can undo it.
     *
     * Everything in this layer is sized in world pixels and scaled by the camera,
     * so a 30px creature is 10 screen pixels at the zoom that fits a district on a
     * phone — well under the 44px a thumb needs. The hit area divides by this to
     * come back out at a constant size on the glass, whatever the camera is doing.
     */
    ['--cz-zoom' as string]: camera.zoom.toFixed(4)
  } as React.CSSProperties;

  return (
    <div className={`cz-map-wrap ${compact ? 'compact' : ''}`}>
      <div
        className="cz-stage"
        ref={containerRef}
        tabIndex={0}
        role="application"
        aria-label="Plateau"
        onPointerUp={onClick}
        onPointerMove={onHover}
        onPointerLeave={() => setHover(null)}
      >
        <canvas ref={canvasRef} className="cz-canvas" />

        {/* The name of the room you are about to walk into, and whether it is worth
            it. Positioned in screen space, so it does not ride the camera. */}
        {hover && (
          <span
            className="cz-room-tip"
            style={{ left: `${hover.x}px`, top: `${hover.y}px` }}
            aria-hidden="true"
          >
            {PROGRAM_LABELS[hover.room.program]}
            {hover.room.loot >= SHINY_LOOT && <span className="cz-room-rich"> ✨</span>}
            {hover.room.hasKey && ' 🔑'}
          </span>
        )}

        {/* The pieces: absolutely positioned so a state update slides them. */}
        <div className="cz-entities" style={cameraTransform}>
          {view.heroes
            .filter((hero) => hero.alive && !hero.escaped && !hero.forfeited)
            .map((hero) => {
              const spot = spots.get(hero.playerId);
              const room = roomById.get(hero.roomId);
              if (!spot || room?.seen === 'hidden') return null;
              const at = project(spot.x, spot.y);
              return (
                <div
                  key={hero.playerId}
                  className={`cz-token cz-token-hero ${hero.playerId === myPlayerId ? 'me' : ''}`}
                  style={{
                    left: `${at.x.toFixed(1)}px`,
                    top: `${at.y.toFixed(1)}px`,
                    width: `${tokenSize.toFixed(1)}px`,
                    fontSize: `${(tokenSize * 0.52).toFixed(1)}px`,
                    zIndex: 3000 + Math.round((spot.x + spot.y) * 10),
                    // `color` feeds the footprint's `currentColor`, so the ring on
                    // the floor matches the ring on the piece.
                    color: `hsl(${heroHue(hero.heroId)} 70% 55%)`,
                    borderColor: `hsl(${heroHue(hero.heroId)} 70% 55%)`
                  }}
                  title={`${hero.name} · ${hero.hp}/${hero.maxHp} PV`}
                >
                  <span className="cz-token-face">{heroDef(hero.heroId).emoji}</span>
                  <span className="cz-token-hp" style={{ width: `${Math.max(6, (hero.hp / hero.maxHp) * 100)}%` }} />
                  <span className="cz-token-foot" />
                </div>
              );
            })}

          {view.zombies.map((zombie) => {
            const spot = spots.get(zombie.id);
            if (!spot) return null;
            const at = project(spot.x, spot.y);
            const def = zombieDef(zombie.def);
            const art = zombieSprite(zombie.def);
            const big = def.boss ? 1.35 : 1;
            // Ringed when the tap would land, faded when it would not. Absent the
            // set, nothing is faded: the television and the idle phone show a
            // board, not a targeting solution.
            const aimable = inReach ? inReach.has(zombie.id) : null;
            return (
              <button
                key={zombie.id}
                type="button"
                className={`cz-token cz-token-zombie ${def.boss ? 'boss' : ''} ${
                  selectedZombieId === zombie.id ? 'selected' : ''
                } ${onZombieTap ? 'tappable' : ''} ${
                  aimable === null ? '' : aimable ? 'in-reach' : 'out-of-reach'
                } ${spentZombies?.has(zombie.id) ? 'spent' : ''}`}
                style={{
                  left: `${at.x.toFixed(1)}px`,
                  top: `${at.y.toFixed(1)}px`,
                  width: `${(tokenSize * big).toFixed(1)}px`,
                  fontSize: `${(tokenSize * 0.52).toFixed(1)}px`,
                  zIndex: 2000 + Math.round((spot.x + spot.y) * 10),
                  // The horde speaks Fortnite too: a walker rings grey, a boss gold.
                  color: RARITY_META[def.rarity].color,
                  borderColor: RARITY_META[def.rarity].color
                }}
                title={`${def.name} (${RARITY_META[def.rarity].label}) · ${zombie.hp}/${zombie.maxHp} PV${
                  zombie.bonusDmg > 0 ? ' · élite' : ''
                }${aimable === false ? ' · hors de portée' : ''}${
                  spentZombies?.has(zombie.id) ? ' · a fini son tour' : ''
                }`}
                disabled={!onZombieTap}
                onClick={onZombieTap ? () => onZombieTap(zombie.id) : undefined}
              >
                {art ? <img src={art} alt={def.name} /> : <span className="cz-token-face">{def.emoji}</span>}
                <span
                  className="cz-token-hp horde"
                  style={{ width: `${Math.max(6, (zombie.hp / zombie.maxHp) * 100)}%` }}
                />
                <span className="cz-token-foot" />
                {/* The horde's action points, on the piece. The game master used to
                    have to select a creature to learn whether it had already moved,
                    which by turn eight is thirty taps to find the ones that have
                    not. */}
                {spentZombies && !spentZombies.has(zombie.id) && zombie.ap > 0 && (
                  <span className="cz-token-ap tabular">{zombie.ap}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* The whole building, small, with the camera's window drawn on it.
            Only on the screens someone is holding: a television drives itself,
            and an inset map on it would be furniture nobody uses. */}
        {compact && <CzMinimap scene={scene} camera={camera} viewport={viewport} view={view} onJump={jumpTo} />}

        <div className="cz-camera-controls">
          <button type="button" onClick={() => zoomBy(1.2)} aria-label="Zoomer">
            +
          </button>
          <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="Dézoomer">
            −
          </button>
          <button
            type="button"
            className={cameraMode === 'auto' && following ? 'live' : ''}
            onClick={fitAll}
            aria-label="Voir tout le plateau"
            title={
              cameraMode === 'auto'
                ? following
                  ? 'La caméra suit l’action — cliquez pour tout voir'
                  : 'Tout voir, et rendre la main à la caméra'
                : 'Tout voir'
            }
          >
            ⤢
          </button>
        </div>
      </div>
    </div>
  );
}

const EMPTY: ReadonlySet<string> = new Set();

/**
 * The outer border of a room, as world-space segments.
 *
 * A cell edge belongs to the outline when the neighbour across it is not part of
 * the same room. The diamond's corners are north, east, south, west in that order,
 * and the axes are not the screen's: `-y` is up-*right*, so the boundary with the
 * cell above is the top-right edge.
 */
function roomOutline(room: CzRoomView, width: number, height: number): [Vec2, Vec2][] {
  const owned = new Set(room.cells);
  const edges: [Vec2, Vec2][] = [];

  for (const cell of room.cells) {
    const cx = cell % width;
    const cy = Math.floor(cell / width);
    const [n, e, s, w] = diamond(cx, cy);

    const sides = [
      [0, -1, n, e],
      [1, 0, e, s],
      [0, 1, s, w],
      [-1, 0, w, n]
    ] as const;

    for (const [dx, dy, from, to] of sides) {
      const nx = cx + dx;
      const ny = cy + dy;
      const outside = nx < 0 || ny < 0 || nx >= width || ny >= height;
      if (outside || !owned.has(ny * width + nx)) edges.push([from, to]);
    }
  }

  return edges;
}

/**
 * The whole building, small, in a corner — and a tap on it moves the camera there.
 *
 * Almost free, which is why it exists: the scene is *already* a canvas of the
 * entire floor plan, so the map is one `drawImage` of it scaled down, plus a
 * rectangle for where the camera is looking and a dot per creature. It is the
 * cheapest possible answer to "I cannot tell how this place is laid out", and it
 * is the piece that makes a closer default zoom affordable at all: you can be
 * zoomed into one room without losing the plan.
 */
function CzMinimap({
  scene,
  camera,
  viewport,
  view,
  onJump
}: {
  scene: { canvas: HTMLCanvasElement; origin: Vec2 };
  camera: Camera;
  viewport: Vec2;
  view: CzView;
  onJump: (world: Vec2) => void;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const ratio = typeof window === 'undefined' ? 1 : Math.min(2, window.devicePixelRatio || 1);
  const bounds = boardBounds(view.width, view.height);
  const size = boundsSize(bounds);
  /** Long side 132px: readable on a phone without eating the board. */
  const scale = size.x <= 0 ? 1 : Math.min(132 / size.x, 96 / size.y);
  const boxW = Math.max(40, size.x * scale);
  const boxH = Math.max(30, size.y * scale);

  useLayoutEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    canvas.width = Math.round(boxW * ratio);
    canvas.height = Math.round(boxH * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, boxW, boxH);

    // The plan itself, scaled to fit.
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.drawImage(
      scene.canvas,
      (scene.origin.x - bounds.minX) * scale,
      (scene.origin.y - bounds.minY) * scale,
      (scene.canvas.width / ratio) * scale,
      (scene.canvas.height / ratio) * scale
    );
    ctx.restore();

    const toMini = (world: Vec2): Vec2 => ({
      x: (world.x - bounds.minX) * scale,
      y: (world.y - bounds.minY) * scale
    });

    // Who is where. Creatures are what you actually look at a minimap for.
    const roomById = new Map(view.rooms.map((room) => [room.id, room]));
    const dot = (roomId: string, color: string, radius: number) => {
      const cell = roomById.get(roomId)?.cells[0];
      if (cell === undefined) return;
      const at = toMini(project(cell % view.width, Math.floor(cell / view.width)));
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
      ctx.fill();
    };
    for (const zombie of view.zombies) dot(zombie.roomId, 'rgb(229 72 77 / 0.9)', 1.6);
    for (const hero of view.heroes) {
      if (hero.alive && !hero.escaped && !hero.forfeited) dot(hero.roomId, 'rgb(120 205 255 / 0.95)', 2.2);
    }

    // The camera's window on the plan.
    const half = { x: viewport.x / 2 / camera.zoom, y: viewport.y / 2 / camera.zoom };
    const topLeft = toMini({ x: camera.x - half.x, y: camera.y - half.y });
    ctx.strokeStyle = 'rgb(255 255 255 / 0.7)';
    ctx.lineWidth = 1;
    ctx.strokeRect(topLeft.x, topLeft.y, half.x * 2 * scale, half.y * 2 * scale);
  });

  return (
    <canvas
      ref={ref}
      className="cz-minimap"
      style={{ width: `${boxW}px`, height: `${boxH}px` }}
      onPointerDown={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        onJump({
          x: bounds.minX + (event.clientX - rect.left) / scale,
          y: bounds.minY + (event.clientY - rect.top) / scale
        });
      }}
      aria-label="Plan du bâtiment"
    />
  );
}

/**
 * Where a self-driving screen should be looking.
 *
 * While the survivors act it frames them and whatever is close enough to bite
 * them, at a distance you can read from a sofa. When the horde's phase begins it
 * pulls all the way back to the whole floor plan, because that is the two minutes
 * where the interesting thing on screen is the shape of what is coming rather
 * than any one room.
 *
 * `focus` is a player's own seat: their phone follows *them*, not the party's
 * centre of mass, which on a wide map is frequently a corridor they are nowhere
 * near. A television passes nothing and gets the whole table.
 */
function actionShot(view: CzView, viewport: Vec2, focus: string | null): FollowTarget {
  const wide = { ...boardMiddle(view), zoom: fitZoom(viewport, view.width, view.height) };
  if (view.phase !== 'heroes') return wide;

  const active = view.heroes.filter((hero) => hero.alive && !hero.escaped && !hero.forfeited);
  const mine = focus ? active.filter((hero) => hero.playerId === focus) : [];
  const heroes = mine.length > 0 ? mine : active;
  if (heroes.length === 0) return wide;

  const roomById = new Map(view.rooms.map((room) => [room.id, room]));
  const points: Vec2[] = [];
  for (const hero of heroes) {
    const room = roomById.get(hero.roomId);
    const cell = room?.cells[0];
    if (cell === undefined) continue;
    points.push({ x: cell % view.width, y: Math.floor(cell / view.width) });
  }
  // Anything in a room the party occupies is part of the shot: the camera should
  // not cut away from the thing about to eat someone.
  for (const zombie of view.zombies) {
    if (!heroes.some((hero) => hero.roomId === zombie.roomId)) continue;
    const cell = roomById.get(zombie.roomId)?.cells[0];
    if (cell === undefined) continue;
    points.push({ x: cell % view.width, y: Math.floor(cell / view.width) });
  }
  if (points.length === 0) return wide;

  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const centre = project((minX + maxX) / 2, (minY + maxY) / 2);

  // Close enough to see the furniture, far enough that the party fits with room
  // to breathe — and never closer than the whole board would be anyway.
  const spread = Math.max(maxX - minX, maxY - minY) + 4;
  // Reading distance, not surveillance distance: the old floor of 0.55 was a map
  // you could see all of and understand none of.
  const wanted = Math.min(1.5, Math.max(0.9, 8 / spread));
  return { x: centre.x, y: centre.y - TILE_H, zoom: Math.max(wide.zoom, wanted) };
}

function boardMiddle(view: CzView): Vec2 {
  const centre = project((view.width - 1) / 2, (view.height - 1) / 2);
  return { x: centre.x, y: centre.y };
}
