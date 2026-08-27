import { HEARTBEAT_MS } from 'presence-core';
import { useEffect } from 'react';

/**
 * Tells the server this phone is still here, and asks for the board back when it
 * has been away.
 *
 * Two jobs, together because they are two halves of one story. The beat is how
 * the server learns that a *player* is present, which is not the same question as
 * whether a socket is open: a phone frozen behind a lock screen, a laptop lid on
 * the way down and a tab throttled in the background all keep the connection
 * alive long after the person has stopped being able to play. Missed beats are
 * what open the resync window, and a window that closes is what pauses a game.
 *
 * The other half is the recovery. A reconnect arrives as a *new* connection past
 * socket.io's recovery window, so the server no longer knows which game this
 * socket belongs to — the seat has to be re-presented and the board re-read.
 * `onReconnect` is where each game does that, and it runs on every transition
 * back to connected rather than only the first, because the interesting case is
 * the fifth one.
 *
 * It takes callbacks rather than a socket on purpose: three differently-typed
 * sockets share this, and each keeps its own typed `emit` at the call site
 * instead of widening it to something this file would have to assert about.
 */
export function useHeartbeat(options: {
  connected: boolean;
  /** True once this phone holds a seat: an unseated screen reports nothing. */
  seated: boolean;
  /** Sends one beat. Must be stable, or the interval restarts on every render. */
  beat: () => void;
  /** Re-present the seat and re-read the board. Must be stable. */
  onReconnect?: () => void;
}): void {
  const { connected, seated, beat, onReconnect } = options;

  useEffect(() => {
    if (!connected || !seated) return;

    // Immediately, so coming back is reported without waiting out an interval.
    beat();
    onReconnect?.();

    const timer = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [connected, seated, beat, onReconnect]);
}
