import { phaseProgress } from 'game-core';
import { useEffect, useRef } from 'react';

/**
 * An image that resolves from illegible to sharp over the answer phase.
 *
 * Two effects, two rendering paths, because the browser offers them different
 * machinery. `blur` is a compositor-driven Web Animation on a plain `img`; see the
 * comment on `BlurImage` for why neither an interval nor a CSS transition survived
 * contact with it. `pixelate` has no CSS filter to animate, so it is a canvas: the
 * image is drawn tiny and scaled back up with smoothing off, which is what turns a
 * face into blocks, and the block size follows the synchronised clock frame by frame.
 *
 * Either way the clock decides what is shown: progress is derived from server time,
 * so a screen opened halfway through a round starts halfway through the reveal, and
 * every screen in the room shows the same frame without one byte of animation
 * traffic.
 */
export function RevealImage({
  src,
  mode = 'blur',
  intensity,
  startZoom,
  startAt,
  durationMs,
  serverNow,
  className,
  revealed = false
}: {
  src: string;
  /** `blur` softens, `pixelate` shows mosaic blocks. Faces read better pixelated. */
  mode?: 'pixelate' | 'blur';
  /** Blur radius or pixel block size at the start, in the payload's own units. */
  intensity: number;
  startZoom: number;
  /** Server time the answer phase began. */
  startAt: number;
  /** How long the reveal should take. Never zero, or there is nothing to reveal. */
  durationMs: number;
  serverNow: () => number;
  className?: string;
  /** True once the answer is out: no effect, no animation, no waiting. */
  revealed?: boolean;
}) {
  if (mode === 'pixelate') {
    return (
      <PixelateImage
        src={src}
        intensity={intensity}
        startZoom={startZoom}
        startAt={startAt}
        durationMs={durationMs}
        serverNow={serverNow}
        className={className}
        revealed={revealed}
      />
    );
  }

  return (
    <BlurImage
      src={src}
      intensity={intensity}
      startZoom={startZoom}
      startAt={startAt}
      durationMs={durationMs}
      serverNow={serverNow}
      className={className}
      revealed={revealed}
    />
  );
}

type EffectProps = {
  src: string;
  intensity: number;
  startZoom: number;
  startAt: number;
  durationMs: number;
  serverNow: () => number;
  className?: string;
  revealed: boolean;
};

/**
 * The blur reveal.
 *
 * The animation is handed to the browser rather than driven from React. Recomputing
 * the blur and the scale on an interval, as this first did, meant a re-render every
 * tick and a visible stutter: each step moved the scale by a fraction of a percent,
 * the blur's output landed on a slightly different pixel each time, and a centred
 * image jittered sideways.
 *
 * A CSS transition was the next attempt and it does not work here. A transition needs
 * a committed "before" value to interpolate from, and setting the start and the end in
 * the same frame gives it none, so the picture simply appeared at its end state: no
 * blur to resolve and, depending on the property, a zoom that never came back at all.
 * Forcing a reflow between the two would fix it by accident.
 *
 * `animate` states both ends as keyframes, so there is nothing to flush and nothing to
 * time. It runs on the compositor, it is cancellable, and `fill: 'both'` holds the
 * first frame before it starts and the last one after it ends.
 */
function BlurImage({ src, intensity, startZoom, startAt, durationMs, serverNow, className, revealed }: EffectProps) {
  const image = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const element = image.current;
    if (!element) return;

    if (revealed) {
      return;
    }

    const progress = phaseProgress(startAt, durationMs, serverNow());
    const remaining = Math.max(0, durationMs * (1 - progress));

    const animation = element.animate(
      [
        {
          // Where the clock says the reveal has got to, which is the start for a
          // screen that joined late as much as for one that was there all along.
          filter: `blur(${((intensity * (1 - progress)) / 2).toFixed(2)}px)`,
          transform: `scale(${(1 + (startZoom - 1) * (1 - progress)).toFixed(4)})`
        },
        { filter: 'blur(0px)', transform: 'scale(1)' }
      ],
      { duration: remaining, easing: 'linear', fill: 'both' }
    );

    return () => animation.cancel();
  }, [src, intensity, startZoom, startAt, durationMs, serverNow, revealed]);

  return (
    <img
      ref={image}
      className={className}
      src={src}
      alt=""
      // Promises the compositor both properties will move, so it can prepare a layer
      // instead of repainting the image on every frame.
      style={{ willChange: 'filter, transform' }}
    />
  );
}

/**
 * Keeps a very large source from allocating a very large canvas. The television is
 * the biggest screen this draws on, and blocks do not need more than this to be
 * blocks.
 */
const MAX_CANVAS_DIMENSION = 1600;

/**
 * The pixelate reveal.
 *
 * Drawn in two passes per frame: the image is first scaled down so each future block
 * becomes roughly one pixel, with smoothing on so that pixel is the average of its
 * area rather than a point sample, then scaled back up with smoothing off so the
 * blocks have hard edges. Point-sampling instead of averaging made the small canvas
 * shimmer as the block size moved, because each block's colour jumped to whatever
 * pixel happened to land under it.
 *
 * The loop redraws only when the block size has moved by half a pixel. Block size
 * shrinks slowly for most of the phase, so most frames cost a clock read and a
 * comparison, not a paint.
 *
 * The source image is deliberately loaded without `crossOrigin`: the canvas gets
 * tainted by a cross-origin host image, but tainting only forbids reading pixels
 * back, which nothing here does, whereas requesting CORS would fail outright on any
 * host that does not send the headers.
 */
function PixelateImage({
  src,
  intensity,
  startZoom,
  startAt,
  durationMs,
  serverNow,
  className,
  revealed
}: EffectProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const maybeCanvas = canvasRef.current;
    if (!maybeCanvas) return;
    // Hoisted function declarations below cannot see the narrowing above.
    const canvas: HTMLCanvasElement = maybeCanvas;

    let cancelled = false;
    let frame = 0;
    let zoomAnimation: Animation | null = null;

    const image = new Image();
    image.decoding = 'async';
    image.src = src;

    const small = document.createElement('canvas');
    const smallContext = small.getContext('2d');
    const context = canvas.getContext('2d');

    /** Last block size drawn, so unchanged frames are skipped. */
    let drawnBlock = -1;

    function draw(blockSize: number): void {
      if (!context || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;

      if (Math.abs(blockSize - drawnBlock) < 0.5 && drawnBlock !== -1) return;
      drawnBlock = blockSize;

      const scale = Math.min(1, MAX_CANVAS_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      if (blockSize <= 1) {
        context.imageSmoothingEnabled = true;
        context.drawImage(image, 0, 0, width, height);
        return;
      }

      if (!smallContext) return;

      const smallWidth = Math.max(1, Math.round(width / blockSize));
      const smallHeight = Math.max(1, Math.round(height / blockSize));
      small.width = smallWidth;
      small.height = smallHeight;

      smallContext.imageSmoothingEnabled = true;
      smallContext.drawImage(image, 0, 0, smallWidth, smallHeight);

      context.imageSmoothingEnabled = false;
      context.drawImage(small, 0, 0, smallWidth, smallHeight, 0, 0, width, height);
    }

    function blockAt(progress: number): number {
      // Eases from the authored intensity down to a single pixel at the end.
      return 1 + (intensity - 1) * (1 - progress);
    }

    function tick(): void {
      if (cancelled) return;
      const progress = phaseProgress(startAt, durationMs, serverNow());
      draw(blockAt(progress));

      if (progress < 1) {
        frame = requestAnimationFrame(tick);
      }
    }

    function start(): void {
      if (cancelled) return;

      if (revealed) {
        draw(1);
        return;
      }

      // The zoom rides on the same keyframe machinery as the blur path: it is a
      // transform, the compositor owns it, and the canvas repaints underneath it.
      const progress = phaseProgress(startAt, durationMs, serverNow());
      const remaining = Math.max(0, durationMs * (1 - progress));
      if (startZoom > 1) {
        zoomAnimation = canvas.animate(
          [{ transform: `scale(${(1 + (startZoom - 1) * (1 - progress)).toFixed(4)})` }, { transform: 'scale(1)' }],
          { duration: remaining, easing: 'linear', fill: 'both' }
        );
      }

      tick();
    }

    // A cached image can already be decoded before the handler is attached, in
    // which case no load event ever fires. Both paths start the loop.
    image.onload = start;
    if (image.complete && image.naturalWidth > 0) {
      start();
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      zoomAnimation?.cancel();
      image.onload = null;
    };
  }, [src, intensity, startZoom, startAt, durationMs, serverNow, revealed]);

  return <canvas ref={canvasRef} className={className} style={{ willChange: 'transform' }} />;
}
