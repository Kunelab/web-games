import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { useClockUpkeep, useServerClock } from '../hooks/useServerClock';
import { browserSeatStore, socketTransport } from './browser';
import {
  createSeat,
  type JoinAnswer,
  type SeatController,
  type SeatProtocol,
  type SeatSnapshot,
  type Transport
} from './seat';

export type Seat<C, S, A, V, About = undefined> = SeatSnapshot<A, V> &
  Pick<SeatController<C, S, A, V, About>, 'join' | 'call' | 'send' | 'on'> & {
    /** Current time on the server's clock, for countdowns. Stable identity. */
    serverNow: () => number;
  };

/** The seat a protocol gives, for a component its screen hands one to. */
export type SeatOf<P> =
  P extends SeatProtocol<infer C, infer S, infer A, infer V, infer About> ? Seat<C, S, A, V, About> : never;

/**
 * The line a seat stands on before its socket exists, which is one render.
 *
 * A seat on it is a real seat that never connects: it reads `connecting`,
 * refuses a join and answers a call with the silence, all through the same
 * code as the live one rather than through a second set of stand-ins.
 */
const NO_LINE: Transport = {
  connected: false,
  timeout: () => ({ emitWithAck: () => Promise.reject(new Error('no line yet')) }),
  emit: () => undefined,
  on: () => undefined,
  off: () => undefined
};

/**
 * A seat for as long as the screen is mounted: its own socket, its server
 * clock, and a re-render whenever the seat changes. Everything about the seat
 * itself is `createSeat`'s; this only gives it a lifetime.
 *
 * `about` is what the phone says about itself on every join (Mafia: the
 * locale). It is compared by identity, so pass a primitive or a stable object;
 * changing it never reopens the socket.
 */
export function useSeat<C, S, A extends JoinAnswer, V, About = undefined>(
  protocol: SeatProtocol<C, S, A, V, About>,
  code: string,
  about?: About
): Seat<C, S, A, V, About> {
  const [line, setLine] = useState<{
    transport: Transport & { close(): void };
    seat: SeatController<C, S, A, V, About>;
  } | null>(null);
  const { serverNow, synchronise } = useServerClock();

  // Declared before the effect that opens the line, so a line opened in the same
  // commit reads the current value rather than the first one.
  const latestAbout = useRef(about);
  useEffect(() => {
    latestAbout.current = about;
    if (about !== undefined) line?.seat.describe(about);
  }, [line, about]);

  useEffect(() => {
    const transport = socketTransport();
    const live = createSeat(protocol, code, transport, browserSeatStore);
    if (latestAbout.current !== undefined) live.describe(latestAbout.current);

    // Every countdown is drawn from the server's clock, so it is measured as
    // soon as there is a line to measure it on.
    const measure = () => synchronise(transport);
    // The server probes latency by asking to be acknowledged; nothing to send back.
    const probe = (_payload: unknown, ack?: () => void) => {
      if (typeof ack === 'function') ack();
    };
    transport.on('connect', measure);
    transport.on('clock:sync', probe);

    // Publishing the line is the whole purpose of this effect: it is an external
    // resource whose lifetime is the screen's, which is what effects are for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLine({ transport, seat: live });
    return () => {
      live.close();
      transport.close();
      setLine(null);
    };
  }, [protocol, code, synchronise]);

  useClockUpkeep(line?.transport ?? null, synchronise);

  const dormant = useMemo(() => createSeat(protocol, code, NO_LINE, browserSeatStore), [protocol, code]);
  const seat = line?.seat ?? dormant;
  const snapshot = useSyncExternalStore(seat.subscribe, seat.snapshot);

  return { ...snapshot, join: seat.join, call: seat.call, send: seat.send, on: seat.on, serverNow };
}
