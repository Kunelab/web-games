import { parentPort } from 'node:worker_threads';

/**
 * One core's share of the bench.
 *
 * The matrix is dozens of independent cells and every game inside one is fully
 * determined by its seed, so which core ran it cannot show up in the numbers —
 * the bench parallelises without becoming less reproducible.
 *
 * A worker is started once and fed cells for as long as there are any, rather
 * than started per cell: booting a thread and re-importing the engine costs
 * about as much as a small cell is worth.
 */

/**
 * TypeScript sources import each other by their built `.js` names, and a worker
 * thread starts without the loader that maps those back to `.ts`. Registering it
 * here is what lets the worker import the engine at all.
 */
const { register } = await import('tsx/esm/api');
register();

const { runMany } = await import('./simulate.js');

export interface BenchRequest {
  index: number;
  options: Parameters<typeof runMany>[0];
}

export interface BenchReply {
  index: number;
  summary: ReturnType<typeof runMany>;
}

parentPort?.on('message', (request: BenchRequest) => {
  const summary = runMany(request.options);
  parentPort?.postMessage({ index: request.index, summary } satisfies BenchReply);
});
