/**
 * What time it is, and a way to be told later.
 *
 * `Date` and `setTimeout` in production; a test's own hand on the clock, so a
 * table can be run through an evening without waiting one out. Everything on
 * the server that schedules or stamps takes one of these rather than reaching
 * for the globals.
 */
export interface Clock {
  now(): number;
  /** Runs `fn` once, `ms` from now, unless the returned function is called first. */
  after(ms: number, fn: () => void): () => void;
}

/** The real one. Its timers never keep the process alive on their own. */
export const systemClock: Clock = {
  now: () => Date.now(),
  after(ms, fn) {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return () => clearTimeout(timer);
  }
};

/**
 * A clock that only moves when it is told to, for tests.
 *
 * `advance` runs every timer that falls due, in the order they fall due, with
 * `now` reading the moment each was due; a timer armed by another timer runs in
 * the same advance if it falls inside it.
 */
export function handClock(start = 0): Clock & { advance(ms: number): void; pending(): number } {
  let now = start;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    after(ms, fn) {
      const id = next++;
      timers.set(id, { at: now + Math.max(0, ms), fn });
      return () => {
        timers.delete(id);
      };
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | null = null;
        for (const entry of timers) {
          if (entry[1].at <= until && (due === null || entry[1].at < due[1].at)) due = entry;
        }
        if (due === null) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
    pending: () => timers.size
  };
}
