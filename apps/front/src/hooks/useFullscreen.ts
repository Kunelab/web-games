import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Full screen, for the screen the room is looking at.
 *
 * A television running a game in a browser tab shows a URL bar, a row of other
 * tabs and, after a moment, a mouse pointer parked in the middle of the stage.
 * None of that is part of the evening, and on a real television none of it is
 * small. Mafia's screen had this and the other two did not, which is the only
 * reason it is a hook now rather than a function in one file.
 *
 * The state is read back from the *document* rather than remembered, because
 * full screen can be left without touching the button: Escape does it, and so
 * does the browser when the tab goes to the background. A remembered flag would
 * then label the button wrongly for the rest of the game.
 */
export function useFullscreen<T extends HTMLElement>(): {
  ref: React.RefObject<T | null>;
  active: boolean;
  toggle: () => void;
} {
  const ref = useRef<T>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const sync = () => setActive(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', sync);
    sync();
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  const toggle = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    // Refused when the call did not come from a real press, and unsupported on
    // an iPhone outright. Neither is worth an error on a screen in a living room.
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void node.requestFullscreen().catch(() => undefined);
  }, []);

  return { ref, active, toggle };
}
