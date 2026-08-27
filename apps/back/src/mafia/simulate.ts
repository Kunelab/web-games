/* eslint-disable no-console */
import type { FastifyBaseLogger } from 'fastify';

import { env } from '../env.js';
import { MafiaManager } from './manager.js';
import { say } from './say.js';

/**
 * Headless table: a full house of bots plays an entire game through the real
 * manager — real timers, real persistence, the real bot driver — and prints the
 * transcript plus what the bots ended up believing.
 *
 *   pnpm --filter back mafia:sim
 *
 * The clocks size themselves from `MAFIA_BOT_TEMPO`, which is the whole reason
 * this file is not three lines long. `live` wants a blitz: the phase clock is the
 * boss and the point is to prove a table finishes at speed. `deliberate` wants
 * the opposite — every bot gets several think-then-act rounds, one after another,
 * and a phase that ends before the last bot has spoken is not slow-and-thorough,
 * it is fast-and-broken. So the day is derived from the work it has to contain:
 * bots × rounds × the time one turn actually takes.
 *
 * Everything is overridable; see BANNER below for the knobs.
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

const bots = Number(process.env.SIM_BOTS ?? 12);
/** The language this table is spoken in, and the one the transcript prints. */
const locale = process.env.SIM_LOCALE === 'en' ? 'en' : 'fr';
const t = say(locale);
const tempo = env.MAFIA_BOT_TEMPO;
const provider = env.MAFIA_BOT_PROVIDER;

/**
 * How long one bot's turn takes, end to end.
 *
 * Measured, not guessed: a 4B model on a consumer GPU answers a briefing in about
 * a second once thinking is disabled — it was thirty when the model was allowed to
 * reason, which is why `ollamaDecision` turns that off. The API is comparable, the
 * scripted brain is instant.
 *
 * The driver paces its own rounds off the same figure, so the phase clock and the
 * schedule agree. When they disagree, bots get cut off mid-round and the run
 * measures the clock rather than the bots.
 */
const turnMs = provider === 'ollama' ? 1400 : provider === 'anthropic' ? 1200 : 60;
const rounds = env.MAFIA_BOT_ROUNDS;

/**
 * The phase clocks.
 *
 * Deliberate: every bot speaks in every round, so the day has to hold
 * bots × rounds × turnMs with room to spare. Night is the same shape (everyone
 * with a power acts) so it gets the same budget, minus the ones who have nothing
 * to play. Live: the documented blitz, because that is the thing being tested.
 */
const deliberateDayMs = Math.max(30_000, bots * rounds * turnMs + 8000);
const clocks =
  tempo === 'deliberate'
    ? {
        dayMs: Number(process.env.SIM_DAY_MS ?? deliberateDayMs),
        nightMs: Number(process.env.SIM_NIGHT_MS ?? Math.max(15_000, Math.round(deliberateDayMs * 0.7))),
        defenseMs: Math.max(5000, turnMs * 2),
        judgementMs: Math.max(8000, bots * turnMs + 3000),
        aftermathMs: 5000
      }
    : {
        dayMs: Number(process.env.SIM_DAY_MS ?? (provider === 'scripted' ? 2500 : 30_000)),
        nightMs: Number(process.env.SIM_NIGHT_MS ?? (provider === 'scripted' ? 1500 : 15_000)),
        defenseMs: provider === 'scripted' ? 800 : 5000,
        judgementMs: provider === 'scripted' ? 1000 : 8000,
        aftermathMs: provider === 'scripted' ? 800 : 4000
      };

/** A day of every bot thinking `rounds` times, times a generous number of days. */
const defaultTimeout = tempo === 'deliberate' ? (clocks.dayMs + clocks.nightMs) * 14 : 180_000;
const watchdogMs = Number(process.env.SIM_TIMEOUT_MS ?? defaultTimeout);

const BANNER = `
  tempo     ${tempo}${tempo === 'deliberate' ? ` (${rounds} rounds/phase)` : ''}
  brain     ${provider}${provider === 'ollama' ? ` · ${env.MAFIA_BOT_MODEL} @ ${env.OLLAMA_URL}` : ''}${
    provider === 'anthropic' ? ` · ${env.MAFIA_BOT_MODEL_ANTHROPIC}` : ''
  }
  bots      ${bots}
  day/night ${(clocks.dayMs / 1000).toFixed(0)}s / ${(clocks.nightMs / 1000).toFixed(0)}s
  patience  ${(watchdogMs / 1000).toFixed(0)}s

  language  ${locale}

  knobs: SIM_BOTS, SIM_DAY_MS, SIM_NIGHT_MS, SIM_TIMEOUT_MS, SIM_TAIL, SIM_LOCALE
         MAFIA_BOT_TEMPO=live|deliberate, MAFIA_BOT_ROUNDS=1..6
         MAFIA_BOT_PROVIDER=ollama|anthropic|scripted
`;

const manager = new MafiaManager(log);
const state = manager.create({ hostUserId: null, config: { ...clocks, locale }, takenCodes: new Set() });

manager.addBots(state.code, bots);
manager.start(state.code);

console.log(BANNER);
console.log(`table ${state.code} — ${Object.keys(state.players).length} bots, c'est parti\n`);

const startedAt = Date.now();
/** Messages already printed, so the live feed does not repeat itself. */
let printed = 0;
/**
 * The last non-empty ledger seen.
 *
 * Snapshotted every tick because the driver forgets a table the moment the game
 * ends — sensible for a server, and it made this report print zero affirmations
 * for a game that had filed plenty. The diagnostic was measuring its own cleanup.
 */
let lastLedger: ReturnType<typeof manager.botLedger> = [];

const watcher = setInterval(() => {
  const current = manager.get(state.code);
  if (!current) return exit(1, 'la table a disparu');

  /**
   * The transcript, live.
   *
   * Printed as it happens rather than dumped at the end, because the reason to
   * run the slow tempo at all is to watch bots argue — and a ten-minute run that
   * prints nothing until it finishes is a ten-minute run you cannot debug.
   */
  const fresh = current.chat.messages.slice(printed);
  for (const message of fresh) {
    const who = message.authorName || '···';
    const tag = message.channel === 'day' ? '' : `(${message.channel}) `;
    // The game speaks in keys; a terminal wants words.
    console.log(`  ${tag}${who}: ${message.msg ? t(message.msg) : message.text}`);
  }
  printed = current.chat.messages.length;

  const seen = manager.botLedger(current.code);
  if (seen.length > 0) lastLedger = [...seen];

  if (current.phase === 'ended') {
    report(current);
    return exit(0);
  }

  if (Date.now() - startedAt > watchdogMs) {
    console.error(`\nbloqué en phase ${current.phase} (jour ${current.day}, stage ${current.stage ?? '-'})`);
    console.error('si le tempo est deliberate, SIM_TIMEOUT_MS est probablement trop court');
    printLedger(current.code);
    return exit(1, 'temps écoulé');
  }
}, 400);

/**
 * What the bots recorded, as opposed to what they said.
 *
 * The most diagnostic block in this output, and it prints on a stall as well as
 * on a finish — a stall is exactly when you need it. A transcript full of
 * questions beside a ledger with no questions in it means the models are writing
 * prose and leaving the structured field null: it looks fine in the chat and the
 * deduction loop is doing nothing at all.
 */
function printLedger(code: string): void {
  const live = manager.botLedger(code);
  const ledger = live.length > 0 ? live : lastLedger;
  const byKind = new Map<string, number>();
  for (const claim of ledger) byKind.set(claim.kind, (byKind.get(claim.kind) ?? 0) + 1);
  const breakdown = [...byKind].map(([kind, n]) => `${kind} ${n}`).join(', ');
  console.log(`\nregistre des bots : ${ledger.length} affirmation(s)${breakdown ? ` — ${breakdown}` : ' (vide)'}`);
  if (ledger.length === 0 && provider !== 'scripted') {
    console.log('⚠ aucune affirmation enregistrée : les bots parlent sans rien déclarer (champ claim laissé null)');
  }
}

/** What happened, and what the bots thought was happening. */
function report(final: NonNullable<ReturnType<typeof manager.get>>): void {
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\n${'─'.repeat(66)}`);
  console.log(`terminé au jour ${final.day} en ${seconds}s (${tempo}/${provider})`);

  for (const winner of final.winners) {
    console.log(`  🏆 ${final.players[winner.playerId]?.name}: ${winner.reason}`);
  }

  console.log('\nles masques :');
  for (const player of Object.values(final.players).sort((a, b) => a.slot - b.slot)) {
    const fate = player.alive ? 'vivant' : player.death ? t(player.death.cause) : 'mort';
    console.log(`  ${String(player.slot).padStart(2)}. ${player.name.padEnd(10)} ${String(player.role).padEnd(16)} ${fate}`);
  }

  const spoken = final.chat.messages.filter((message) => message.authorId).length;
  const announced = final.chat.messages.length - spoken;
  console.log(
    `\nmorts ${final.deaths.length} · paroles ${spoken} · annonces ${announced} · points ${final.points.length} entrées`
  );

  /**
   * Whether the bots actually talked.
   *
   * The single most useful number in this output: a run where `paroles` is near
   * zero means the brain was unreachable and every bot silently fell through to
   * the scripted one. That failure looks exactly like a working run otherwise,
   * which is why it gets called out rather than left to be noticed.
   */
  if (provider !== 'scripted' && spoken < Object.keys(final.players).length) {
    console.log(
      '\n⚠ très peu de paroles pour un tempo LLM — le modèle était probablement injoignable\n' +
        `  vérifie : curl ${env.OLLAMA_URL}/api/tags`
    );
  }

  /**
   * What the bots recorded, printed here as well as on a stall.
   */
  printLedger(final.code);

  const tail = Number(process.env.SIM_TAIL ?? 0);
  if (tail > 0) {
    console.log('\nfin de partie :');
    for (const message of final.chat.messages.slice(-tail)) {
      const words = message.msg ? t(message.msg) : message.text;
      console.log(`  [${message.channel}] ${message.authorName || 'ville'}: ${words}`);
    }
  }
}

function exit(code: number, reason?: string): void {
  if (reason) console.error(reason);
  clearInterval(watcher);
  manager.stopSweeping();
  void manager.destroy(state.code).finally(() => process.exit(code));
}
