import { io, type Socket } from 'socket.io-client';

import { apiOrigin } from '../tools/api-url';
import type { SeatStore, Transport } from './seat';

/**
 * The seat's two adapters as the browser provides them: socket.io for the line
 * and `localStorage` for the memory. The test adapters live in `seat.test.ts`.
 */

/**
 * Every game socket connects the same way: to the API's origin, websocket
 * first. Untyped here; each caller annotates the event maps it speaks.
 */
export function openSocket(): Socket {
  return io(apiOrigin, { transports: ['websocket', 'polling'] });
}

/** A fresh socket.io connection, as the seat and the server clock see it. */
export function socketTransport(): Transport & { close(): void } {
  const socket = openSocket();
  return {
    get connected() {
      return socket.connected;
    },
    timeout: (ms) => ({ emitWithAck: (event, ...args) => socket.timeout(ms).emitWithAck(event, ...args) }),
    emit: (event, ...args) => void socket.emit(event, ...args),
    on: (event, listener) => void socket.on(event, listener as (...args: unknown[]) => void),
    off: (event, listener) => void socket.off(event, listener as (...args: unknown[]) => void),
    close: () => {
      socket.removeAllListeners();
      socket.close();
    }
  };
}

/**
 * `localStorage`, minus the exceptions.
 *
 * A phone with storage disabled throws on every access. Before this, that
 * surfaced inside a join as "the server is not answering"; now such a phone
 * simply has no memory, and joins afresh after a reload.
 */
export const browserSeatStore: SeatStore = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // See above: nothing to remember it in.
    }
  }
};
