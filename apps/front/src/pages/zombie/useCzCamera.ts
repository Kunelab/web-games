import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  approach,
  boardCentre,
  clampCamera,
  clampZoom,
  fitZoom,
  screenToWorld,
  type Camera,
  type Vec2
} from './iso/geometry';

/**
 * The camera, and every way a room full of people might move it.
 *
 * Three input styles, one state. A PC drags with the mouse and zooms on the
 * wheel, like an RTS. A phone drags with one finger and pinches with two. A
 * television has no input at all, so it is *told* where to look — and the
 * interesting part is the handover: a screen that is following the action must
 * give up the moment a human touches it, and take over again once they stop.
 */

export interface FollowTarget {
  /** World point to centre on. */
  x: number;
  y: number;
  /** Zoom to ease towards; omit to keep the current one. */
  zoom?: number;
}

export interface CameraOptions {
  /** Board size in cells. */
  width: number;
  height: number;
  /** Whether pointers may move this camera at all. */
  interactive?: boolean;
  /** Where the camera should drift when nobody is driving. */
  follow?: FollowTarget | null;
  /** Seconds of no input before a followed camera resumes control. */
  handBackAfter?: number;
  /**
   * The opening shot. Fitting the whole board was fine on eight rooms and useless
   * on a hundred and sixty cells — you could see everything and read nothing — so
   * a screen that knows where the action starts says so here and gets framed on it
   * at a readable distance instead.
   */
  openOn?: Vec2 | null;
}

export interface CameraControl {
  containerRef: React.RefObject<HTMLDivElement | null>;
  camera: Camera;
  viewport: Vec2;
  /** True while the camera is driving itself. */
  following: boolean;
  /** Frame the whole board and hand control back to the follower. */
  fitAll: () => void;
  /** Zoom about the centre of the viewport. */
  zoomBy: (factor: number) => void;
  /** Centre on a world point at the current zoom, and take manual control. */
  jumpTo: (world: Vec2) => void;
}

/** The distance a room is readable at: close enough to see the furniture. */
export const READABLE_ZOOM = 1;

export function useCzCamera({
  width,
  height,
  interactive = true,
  follow = null,
  handBackAfter = 6,
  openOn = null
}: CameraOptions): CameraControl {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<Vec2>({ x: 0, y: 0 });
  const [camera, setCamera] = useState<Camera>(() => ({ ...boardCentre(width, height), zoom: 1 }));

  /**
   * When a human last drove. A ref rather than state on purpose: a drag fires
   * dozens of these a second, and re-running the animation effect on each one
   * would tear down and rebuild the frame loop under the user's finger.
   */
  const manualUntilRef = useRef(0);
  const [following, setFollowing] = useState(false);
  const handBack = handBackAfter * 1000;

  const takeManual = useCallback(() => {
    manualUntilRef.current = Date.now() + handBack;
    setFollowing(false);
  }, [handBack]);

  /**
   * Live mirrors, so the raw event listeners and the frame loop never close over
   * stale state. Written after each commit rather than during render: a listener
   * only ever reads them between frames, so one paint of lag is not observable,
   * and mutating a ref mid-render is not.
   */
  const cameraRef = useRef(camera);
  const viewportRef = useRef(viewport);
  const followRef = useRef(follow);
  const openOnRef = useRef(openOn);
  useEffect(() => {
    cameraRef.current = camera;
    viewportRef.current = viewport;
    followRef.current = follow;
    openOnRef.current = openOn;
  }, [camera, viewport, follow, openOn]);

  /* ------------------------------- viewport -------------------------------- */

  /**
   * The viewport, measured — and the opening shot taken from it.
   *
   * Both live in the same place because they are one event: the first time this
   * board is measured, the camera takes its opening shot; a later resize only
   * updates the measurement, or every window drag would yank the camera back.
   * The board's own size is in the key, so a new raid gets a fresh opening shot.
   */
  const framed = useRef('');
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const measure = (box: { width: number; height: number }) => {
      const size = { x: box.width, y: box.height };
      setViewport(size);
      const key = `${width}x${height}`;
      if (size.x <= 0 || size.y <= 0 || framed.current === key) return;
      framed.current = key;
      // Where the action starts, at reading distance — or the whole board when
      // nobody has told us where to look.
      const start = openOnRef.current;
      setCamera(
        start
          ? { x: start.x, y: start.y, zoom: Math.max(fitZoom(size, width, height), READABLE_ZOOM) }
          : { ...boardCentre(width, height), zoom: fitZoom(size, width, height) }
      );
    };

    const observer = new ResizeObserver(([entry]) => {
      if (entry?.contentRect) measure(entry.contentRect);
    });
    observer.observe(element);
    // The first measurement cannot wait for a resize that may never come.
    measure({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, [width, height]);

  const fitAll = useCallback(() => {
    setCamera({ ...boardCentre(width, height), zoom: fitZoom(viewportRef.current, width, height) });
    // An explicit "show me everything" also hands the wheel back to the follower.
    manualUntilRef.current = 0;
  }, [width, height]);

  const zoomBy = useCallback(
    (factor: number) => {
      setCamera((current) => ({ ...current, zoom: clampZoom(current.zoom * factor) }));
      takeManual();
    },
    [takeManual]
  );

  const jumpTo = useCallback(
    (world: Vec2) => {
      setCamera((current) => clampCamera({ ...current, x: world.x, y: world.y }, width, height));
      takeManual();
    },
    [takeManual, width, height]
  );

  /* -------------------------------- pointers ------------------------------- */

  useEffect(() => {
    const element = containerRef.current;
    if (!element || !interactive) return;

    /** Live pointers, so one finger pans and two pinch. */
    const active = new Map<number, Vec2>();
    let pinchStart: { distance: number; zoom: number } | null = null;
    let moved = false;

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.pointerType === 'mouse') return;
      /**
       * Hands off anything that starts on a creature.
       *
       * The tokens are real buttons inside this element, and capturing the pointer
       * here redirects the whole gesture — including the `pointerup` — to the
       * stage, so the button never completes a click and tapping a zombie did
       * nothing at all. Panning from a token is worth losing; attacking is not.
       */
      if (event.target instanceof Element && event.target.closest('.cz-token')) return;

      active.set(event.pointerId, { x: event.clientX, y: event.clientY });
      moved = false;
      if (active.size === 2) {
        const [a, b] = [...active.values()];
        if (a && b) {
          pinchStart = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: cameraRef.current.zoom };
        }
      }
      element.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent) => {
      const previous = active.get(event.pointerId);
      if (!previous) return;
      const next = { x: event.clientX, y: event.clientY };
      active.set(event.pointerId, next);

      if (active.size >= 2 && pinchStart) {
        const [a, b] = [...active.values()];
        if (!a || !b) return;
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchStart.distance > 0) {
          const zoom = clampZoom((pinchStart.zoom * distance) / pinchStart.distance);
          setCamera((current) => ({ ...current, zoom }));
          takeManual();
        }
        moved = true;
        return;
      }

      const dx = next.x - previous.x;
      const dy = next.y - previous.y;
      if (Math.abs(dx) + Math.abs(dy) < 0.5) return;
      moved = true;
      element.classList.add('dragging');
      setCamera((current) =>
        clampCamera({ ...current, x: current.x - dx / current.zoom, y: current.y - dy / current.zoom }, width, height)
      );
      takeManual();
    };

    const onPointerUp = (event: PointerEvent) => {
      active.delete(event.pointerId);
      if (active.size < 2) pinchStart = null;
      if (active.size === 0) element.classList.remove('dragging');
      // A drag must not also count as a tap on the room underneath.
      if (moved) {
        element.dataset.dragged = 'true';
        window.setTimeout(() => {
          delete element.dataset.dragged;
        }, 0);
      }
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const before = screenToWorld(pointer, cameraRef.current, viewportRef.current);
      const zoom = clampZoom(cameraRef.current.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
      const after = screenToWorld(pointer, { ...cameraRef.current, zoom }, viewportRef.current);
      // Keep the world point under the cursor pinned: the only zoom that feels right.
      setCamera((current) =>
        clampCamera({ zoom, x: current.x + (before.x - after.x), y: current.y + (before.y - after.y) }, width, height)
      );
      takeManual();
    };

    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', onPointerUp);
    element.addEventListener('pointercancel', onPointerUp);
    element.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerUp);
      element.removeEventListener('wheel', onWheel);
    };
  }, [interactive, width, height, takeManual]);

  /* -------------------------------- keyboard ------------------------------- */

  useEffect(() => {
    const element = containerRef.current;
    if (!element || !interactive) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const step = 90 / cameraRef.current.zoom;
      const pan = (dx: number, dy: number) => {
        setCamera((current) => clampCamera({ ...current, x: current.x + dx, y: current.y + dy }, width, height));
        takeManual();
      };
      if (event.key === 'ArrowLeft') pan(-step, 0);
      else if (event.key === 'ArrowRight') pan(step, 0);
      else if (event.key === 'ArrowUp') pan(0, -step);
      else if (event.key === 'ArrowDown') pan(0, step);
      else if (event.key === '+' || event.key === '=') zoomBy(1.15);
      else if (event.key === '-') zoomBy(1 / 1.15);
      else if (event.key === '0') fitAll();
      else return;
      event.preventDefault();
    };

    element.addEventListener('keydown', onKeyDown);
    return () => element.removeEventListener('keydown', onKeyDown);
  }, [interactive, width, height, takeManual, zoomBy, fitAll]);

  /* --------------------------------- follow -------------------------------- */

  /**
   * One frame loop for the whole life of the component, easing towards whatever
   * the screen has been told to watch — and standing down while a human is
   * driving, then taking the wheel back after they stop.
   */
  const wanted = follow !== null;
  useEffect(() => {
    if (!wanted) return;

    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      const target = followRef.current;
      if (!target || Date.now() < manualUntilRef.current) return;
      // Already true bails out inside React: this does not re-render every frame.
      setFollowing(true);

      setCamera((current) => {
        const next: Camera = {
          x: approach(current.x, target.x, 3.4, dt),
          y: approach(current.y, target.y, 3.4, dt),
          zoom: target.zoom === undefined ? current.zoom : approach(current.zoom, target.zoom, 2.2, dt)
        };
        // Settle: stop nudging React once it is close enough to look still.
        const still =
          Math.abs(next.x - current.x) < 0.05 &&
          Math.abs(next.y - current.y) < 0.05 &&
          Math.abs(next.zoom - current.zoom) < 0.0004;
        return still ? current : clampCamera(next, width, height);
      });
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [wanted, width, height]);

  // A camera nobody asked to drive itself is never "following", whatever the
  // last raid left in the flag.
  return { containerRef, camera, viewport, following: wanted && following, fitAll, zoomBy, jumpTo };
}
