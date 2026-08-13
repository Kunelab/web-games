import { phaseProgress } from 'game-core';
import { useEffect, useRef } from 'react';

/**
 * An image that resolves from illegible to sharp over the answer phase.
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
 *
 * The synchronised clock still decides what is shown: progress is read from it on
 * mount, so a television opened halfway through a round starts halfway through the
 * reveal, and only the remaining time is animated.
 */
export function RevealImage({
  src,
  intensity,
  startZoom,
  startAt,
  durationMs,
  serverNow,
  className,
  revealed = false
}: {
  src: string;
  /** Blur strength at the start, in the payload's own units. */
  intensity: number;
  startZoom: number;
  /** Server time the answer phase began. */
  startAt: number;
  /** How long the reveal should take. Never zero, or there is nothing to reveal. */
  durationMs: number;
  serverNow: () => number;
  className?: string;
  /** True once the answer is out: no blur, no animation, no waiting. */
  revealed?: boolean;
}) {
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
