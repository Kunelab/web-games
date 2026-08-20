/* eslint-disable no-console */
import type { FastifyBaseLogger } from 'fastify';

import { MafiaManager } from './manager.js';

/**
 * Headless smoke: a full table of bots plays an entire game on a blitz clock,
 * through the real manager — real timers, real persistence, real bot driver.
 *
 *   pnpm --filter back mafia:sim
 *
 * Respects MAFIA_BOT_PROVIDER: 'scripted' finishes in under a minute; 'ollama'
 * exercises the local model end to end (slower, and the chat becomes worth
 * reading). Needs SECRET and a DATABASE_FILE you don't mind writing to.
 */

const quiet = () => undefined;
const log = {
  info: (...args: unknown[]) => console.log('[info]', ...args),
  warn: (...args: unknown[]) => console.warn('[warn]', ...args),
  error: (...args: unknown[]) => console.error('[error]', ...args),
  debug: quiet,
  fatal: (...args: unknown[]) => console.error('[fatal]', ...args),
  trace: quiet,
  silent: quiet,
  level: 'info',
  child() {
    return log;
  }
} as unknown as FastifyBaseLogger;

const manager = new MafiaManager(log);

const state = manager.create({
  hostUserId: null,
  config: {
    dayMs: Number(process.env.SIM_DAY_MS ?? 2500),
    nightMs: Number(process.env.SIM_NIGHT_MS ?? 1500),
    defenseMs: 800,
    judgementMs: 1000,
    aftermathMs: 800
  },
  takenCodes: new Set()
});

manager.addBots(state.code, Number(process.env.SIM_BOTS ?? 12));
manager.start(state.code);
console.log(`table ${state.code}: ${Object.keys(state.players).length} bots, c'est parti`);

const startedAt = Date.now();
const watchdogMs = Number(process.env.SIM_TIMEOUT_MS ?? 180_000);

const watcher = setInterval(() => {
  const current = manager.get(state.code);
  if (!current) return exit(1, 'la table a disparu');

  if (current.phase === 'ended') {
    console.log(`\nterminé au jour ${current.day} en ${Math.round((Date.now() - startedAt) / 1000)}s`);
    for (const winner of current.winners) {
      console.log(`  🏆 ${current.players[winner.playerId]?.name}: ${winner.reason}`);
    }
    console.log(`  morts: ${current.deaths.length}, messages: ${current.chat.messages.length}, points: ${current.points.length} entrées`);
    for (const message of current.chat.messages.slice(-15)) {
      console.log(`  [${message.channel}] ${message.authorName || 'ville'}: ${message.text}`);
    }
    return exit(0);
  }

  if (Date.now() - startedAt > watchdogMs) {
    console.error(`bloqué en phase ${current.phase} (jour ${current.day}, stage ${current.stage ?? '-'})`);
    return exit(1, 'temps écoulé');
  }
}, 400);

function exit(code: number, reason?: string): void {
  if (reason) console.error(reason);
  clearInterval(watcher);
  manager.stopSweeping();
  void manager.destroy(state.code).finally(() => process.exit(code));
}
