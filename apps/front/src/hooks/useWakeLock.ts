import { useEffect } from 'react';

/**
 * Keeps the screen awake for as long as a game screen is on it.
 *
 * A phone locks itself after half a minute untouched, and half a minute
 * untouched is exactly what a blind test clip, a night phase or somebody else's
 * turn looks like from the outside. The player then misses the buzzer window,
 * or comes back to a socket that closed while the screen was off. The
 * television has the same problem with worse consequences: nobody is touching
 * it at all, so it is the one screen guaranteed to go dark mid-round.
 *
 * Three things make this fiddlier than one call.
 *
 * The lock is **dropped by the browser** whenever the page is hidden, and it is
 * not given back on return, so the `visibilitychange` listener is not a nicety:
 * without it the first tab switch of the evening silently ends the feature.
 *
 * The request **must not be treated as fatal**. Safari below 16.4 has no
 * `wakeLock` at all, Firefox hides it behind a flag, and any browser may reject
 * it (a page that is not visible, a battery saver). None of those are errors
 * worth showing a player in the middle of a game, so every failure is swallowed
 * and the screen simply behaves as it did before.
 *
 * And the sentinel is **released on the way out**. Holding the lock after the
 * game screen unmounts would keep a phone lit on the results page until its
 * owner noticed.
 */
export function useWakeLock(active = true): void {
  useEffect(() => {
    if (!active) return;
    if (!('wakeLock' in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    // The effect can be torn down while a request is still in flight, in which
    // case the sentinel arrives after we stopped wanting it.
    let live = true;

    const request = async () => {
      if (!live || sentinel !== null || document.visibilityState !== 'visible') return;
      try {
        sentinel = await navigator.wakeLock.request('screen');
        if (!live) {
          void sentinel.release();
          sentinel = null;
          return;
        }
        // The browser may let go on its own; forget the stale sentinel so the
        // next visibility change asks for a fresh one rather than assuming it
        // still holds this one.
        sentinel.addEventListener('release', () => {
          sentinel = null;
        });
      } catch {
        // Unsupported, denied, or the page lost visibility mid-request.
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void request();
    };

    void request();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVisibility);
      void sentinel?.release();
      sentinel = null;
    };
  }, [active]);
}
