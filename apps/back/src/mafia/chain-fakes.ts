import type { FastifyBaseLogger } from 'fastify';

import type { ApiSlot } from '../env.js';
import { RungError, type Ask, type ChainConfig, type Rung, type Transport } from './chain.js';

/**
 * Stand-ins for the chain's two external dependencies, for tests: the
 * endpoints, and the configuration that names them.
 *
 * The chain's behaviour is about the tail of a free tier, how long it takes
 * and whether it refuses, so that is all a fake endpoint does: answer after a
 * set delay, or refuse. No server, no environment, nothing that can reach a
 * paid model from a unit suite.
 */

const quiet = () => undefined;
export const silentLog = {
  info: quiet,
  warn: quiet,
  error: quiet,
  debug: quiet,
  fatal: quiet,
  trace: quiet,
  silent: quiet,
  level: 'silent',
  child() {
    return silentLog;
  }
} as unknown as FastifyBaseLogger;

/** One OpenAI-compatible slot per model name, in slot order. */
export function slots(...models: string[]): ApiSlot[] {
  return models.map((model, index) => ({
    rung: `api${String(index + 1)}`,
    url: `http://fake/${model}`,
    key: 'test-key',
    model
  }));
}

/** A chain over these endpoints and nothing else, with the deployment's defaults otherwise. */
export function chainOver(endpoints: ApiSlot[], overrides: Partial<ChainConfig> = {}): ChainConfig {
  return {
    provider: 'api*',
    errands: {},
    slots: endpoints,
    anthropic: false,
    turnMs: 25_000,
    speakMs: 10_000,
    cooldownMs: 60_000,
    hedgeMs: 0,
    apiParallel: 1,
    localParallel: 1,
    spread: 0,
    ...overrides
  };
}

/**
 * Endpoints that answer after a delay (`delay`, by model, 5 ms by default) with
 * `answer` (`{ line: 'ok' }` by default), or refuse when `refuses` says so.
 * Every request they were sent is kept, in order, in `sent`.
 */
export function fakeEndpoints(
  endpoints: ApiSlot[],
  behaviour: {
    delay?: (model: string) => number;
    refuses?: (model: string, user: string) => boolean;
    answer?: (request: Ask) => Record<string, unknown>;
  } = {}
): Transport & { sent: { rung: Rung; system: string; user: string }[] } {
  const { delay = () => 5, refuses = () => false, answer = () => ({ line: 'ok' }) } = behaviour;
  const modelOf = new Map(endpoints.map((slot) => [slot.rung, slot.model]));
  const sent: { rung: Rung; system: string; user: string }[] = [];
  return {
    sent,
    model: (rung) => modelOf.get(rung) ?? 'none',
    ask: (rung, request) => {
      sent.push({ rung, system: request.system, user: request.user });
      const model = modelOf.get(rung) ?? 'none';
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          if (refuses(model, request.user)) reject(new RungError(`${rung} 500`, 500));
          else resolve(answer(request));
        }, delay(model));
      });
    }
  };
}
