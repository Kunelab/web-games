import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

import { runMany } from './simulate.js';
import type { BenchReply, BenchRequest } from './bench-worker.js';

/**
 * Runs the bench's cells across the machine's cores.
 *
 * The cells are independent and every game in them is seeded, so this is purely
 * a question of who does the arithmetic: the numbers are the same whether one
 * core produces them or twelve. What it buys is the difference between a bench
 * somebody runs while changing a number and a bench somebody stops running.
 *
 * Results are handed back in the order the cells were given, whatever order they
 * finished in, so the matrix reads the same as it always did.
 */

export type CellOptions = Parameters<typeof runMany>[0];
export type CellSummary = ReturnType<typeof runMany>;

/** Called with each cell's summary as soon as every earlier cell has one too. */
export type CellSink = (index: number, summary: CellSummary) => void;

export async function runCells(cells: CellOptions[], onReady: CellSink, workers?: number): Promise<void> {
  if (cells.length === 0) return;

  const lanes = Math.max(1, Math.min(workers ?? availableParallelism(), cells.length));
  // One core is one core: threading a single lane only adds a worker to talk to.
  if (lanes === 1) {
    cells.forEach((options, index) => onReady(index, runMany(options)));
    return;
  }

  const done = new Array<CellSummary | undefined>(cells.length).fill(undefined);
  let handed = 0;
  /** Cells already passed to `onReady`; the matrix prints in its own order. */
  let flushed = 0;

  const flush = (): void => {
    while (flushed < done.length) {
      const summary = done[flushed];
      if (!summary) break;
      onReady(flushed, summary);
      flushed += 1;
    }
  };

  await new Promise<void>((resolve, reject) => {
    let live = lanes;
    let failed = false;

    const fail = (error: unknown): void => {
      if (failed) return;
      failed = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    for (let lane = 0; lane < lanes; lane++) {
      const worker = new Worker(new URL('./bench-worker.ts', import.meta.url));

      const feed = (): void => {
        if (failed || handed >= cells.length) {
          void worker.terminate();
          live -= 1;
          if (live === 0 && !failed) resolve();
          return;
        }
        const index = handed++;
        worker.postMessage({ index, options: cells[index] } satisfies BenchRequest);
      };

      worker.on('message', (reply: BenchReply) => {
        done[reply.index] = reply.summary;
        flush();
        feed();
      });
      worker.on('error', fail);
      feed();
    }
  });
}
