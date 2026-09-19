/* eslint-disable no-console */
/**
 * One full game per template, back to back, with the real everything.
 *
 * The bench in `mafia-core` plays thousands of games a minute and answers
 * questions about *rules*: win rates, how long a board lasts, whether a role is
 * worth its seat. It cannot answer a single question about the part of this
 * system that actually breaks, because it never calls a model. Everything that
 * goes wrong in production goes wrong between the prompt and the chat box: a
 * rung that stopped answering, a mouth that leaks a house number into a hushed
 * room, an ear that reads eight lines and files nothing, a phrasebook fallback
 * nobody notices because a phrasebook line still looks like a line.
 *
 * So this is the other bench. One table at a time, every seat a bot, the real
 * manager with its real timers, the real chain with real API calls, and the
 * flight recorder writing it all down. It is slow on purpose: `--speed 1` is a
 * table playing at the speed a person would play it, which is the only speed at
 * which "the model answered after the moment had passed" is something that can
 * be observed rather than something that can be argued about.
 *
 *   pnpm --filter back bench-games                  # every template, speed 5
 *   pnpm --filter back bench-games -- --speed 1     # real time, hours
 *   pnpm --filter back bench-games -- --only chaos,auto
 *   pnpm --filter back bench-games -- --seats 15 --locale fr
 *
 * Sequential by construction. Two tables at once would put twice the seats'
 * worth of calls onto the same rate-limited endpoint, and every latency in the
 * run would be measuring the other game.
 *
 * Writes one directory per run: every game's JSONL beside a `manifest.jsonl`
 * with a line per finished game. Read them back with `pnpm --filter back trace`.
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import type { FastifyBaseLogger } from 'fastify';
import type { MafiaSetupChoice } from 'mafia-core';

import type { MafiaManager as Manager } from '../mafia/manager.js';

function flag(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  const value = at >= 0 ? process.argv[at + 1] : undefined;
  return value && !value.startsWith('--') ? value : null;
}

/**
 * A numeric flag, or the default when it is not one.
 *
 * `Number('fast')` is `NaN`, and `NaN` propagates silently through every
 * arithmetic this file does with these values. A mistyped `--speed` makes every
 * phase clock `NaN`; a mistyped `--timeout` makes the watchdog `NaN`, and since
 * `elapsed > NaN` is false the batch waits for a game that can never time out.
 * A bench that hangs forever on a typo is worse than one that ignores it, and
 * both are worse than one that says so.
 */
function numberFlag(name: string, fallback: number, min = 1): number {
  const raw = flag(name);
  if (raw === null) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    console.warn(`  --${name} ${raw} is not a number >= ${min}; using ${fallback}`);
    return fallback;
  }
  return value;
}

const speed = numberFlag('speed', 5);
const seats = numberFlag('seats', 15);
const locale = flag('locale') === 'en' ? 'en' : 'fr';
const only = (flag('only') ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const asked = flag('out');
const runDir = asked && isAbsolute(asked) ? asked : resolve(process.cwd(), asked ?? `traces/bench-${stamp}`);

/**
 * Set before anything imports `env`, which parses once at module load.
 *
 * `GAME_TRACE_DIR` is most of the point of the run — every game of one batch in
 * one folder, nothing from yesterday mixed in — and `GAME_TRACE_KEEP` defaults
 * to ten per game, which would quietly delete the first games of a batch while
 * the last ones were still playing. Hence the dynamic imports in `main`.
 */
process.env.GAME_TRACE = process.env.GAME_TRACE ?? 'full';
process.env.GAME_TRACE_DIR = runDir;
process.env.GAME_TRACE_KEEP = '200';

const verbose = process.argv.includes('--verbose');

/**
 * The driver complains in prose, and the complaints are the point.
 *
 * "a line came back after the room closed" is exactly the kind of thing this
 * run exists to surface — and printing each one buries the eight lines that
 * matter under two hundred that say the same thing. So they are counted per
 * game and reported as a number, with `--verbose` to see them.
 *
 * Every one of them is in the trace regardless. Nothing here is the only copy.
 */
const grumbles = { warn: 0, error: 0, kinds: new Map<string, number>() };

function note(level: 'warn' | 'error', args: unknown[]): void {
  grumbles[level] += 1;
  // The message is the last argument the driver passes; the object is context.
  const said = args.find((one) => typeof one === 'string');
  if (typeof said === 'string') grumbles.kinds.set(said, (grumbles.kinds.get(said) ?? 0) + 1);
  if (verbose) console.warn(`  [${level}]`, ...args);
}

const quiet = () => undefined;
const log = {
  info: quiet,
  warn: (...args: unknown[]) => note('warn', args),
  error: (...args: unknown[]) => note('error', args),
  debug: quiet,
  fatal: (...args: unknown[]) => note('error', args),
  trace: quiet,
  silent: quiet,
  level: 'warn',
  child() {
    return log;
  }
} as unknown as FastifyBaseLogger;

interface Row {
  template: string;
  code: string;
  seats: number;
  winner: string;
  days: number;
  ended: boolean;
  wallSeconds: number;
  spoken: number;
  announced: number;
  deaths: number;
  claims: number;
  warns: number;
  errors: number;
  note?: string;
}

interface Template {
  name: string;
  setup: MafiaSetupChoice;
  seats: number;
}

async function main(): Promise<void> {
  await mkdir(runDir, { recursive: true });

  const { SETUPS, DEFAULT_CONFIG } = await import('mafia-core');
  const { MafiaManager } = await import('../mafia/manager.js');
  const { env } = await import('../env.js');

  /**
   * Every default template, in the order a person meets them.
   *
   * The three generated modes first, because they are what an unattended table
   * actually deals: `auto` is the default, and `chaos` is the one most likely to
   * produce a board no rule was written for — which is exactly why it is in the
   * list rather than left for somebody to remember.
   */
  const templates: Template[] = [
    { name: 'auto', setup: { mode: 'auto' }, seats },
    { name: 'chaos', setup: { mode: 'chaos' }, seats },
    { name: 'census', setup: { mode: 'census' }, seats },
    ...SETUPS.map((preset) => ({
      name: preset.id,
      setup: { mode: 'preset' as const, presetId: preset.id },
      // A template's own length is the player count it was written for.
      seats: preset.slots.length
    }))
  ];

  const chosen = only.length > 0 ? templates.filter((one) => only.includes(one.name)) : templates;
  if (chosen.length === 0) {
    console.error(`  no template matched --only ${only.join(',')}`);
    console.error(`  known: ${templates.map((one) => one.name).join(', ')}`);
    process.exit(1);
  }

  /**
   * The clocks, divided rather than replaced.
   *
   * `--speed 1` is `DEFAULT_CONFIG` untouched: the table a person sits at. Above
   * that, every phase shrinks by the same factor, so the *shape* of a game
   * survives — a night is still a third of a day, a defence still outlasts a
   * judgement — and only the absolute numbers move. A run at 5 finds a leaking
   * prompt or a dead rung just as well. What it cannot find is a model that is
   * merely too slow, because at speed 5 everything is.
   */
  const scale = (ms: number): number => Math.max(800, Math.round(ms / speed));
  const clocks = {
    dayMs: scale(DEFAULT_CONFIG.dayMs),
    firstDayMs: scale(DEFAULT_CONFIG.firstDayMs),
    nightMs: scale(DEFAULT_CONFIG.nightMs),
    defenseMs: scale(DEFAULT_CONFIG.defenseMs),
    judgementMs: scale(DEFAULT_CONFIG.judgementMs),
    aftermathMs: scale(DEFAULT_CONFIG.aftermathMs),
    voteLockMs: scale(DEFAULT_CONFIG.voteLockMs)
  };

  /**
   * How long one game may take before it is called stuck.
   *
   * Derived from the clocks rather than picked, because the clocks are the thing
   * that moves: the longest legal game is `maxDays` of a full day, a full night
   * and every trial the day allows, and half again on top for a model being
   * slower than the phase meant to contain it.
   */
  const longestDay =
    clocks.dayMs +
    clocks.nightMs +
    DEFAULT_CONFIG.trialsPerDay * (clocks.defenseMs + clocks.judgementMs + clocks.aftermathMs);
  const watchdogMs = numberFlag('timeout', Math.round(longestDay * DEFAULT_CONFIG.maxDays * 1.5));

  console.log(`\n  bench   ${chosen.length} game(s), speed ${speed}x, ${locale}`);
  console.log(`  brain   ${env.MAFIA_BOT_PROVIDER}, tempo ${env.MAFIA_BOT_TEMPO}`);
  console.log(`  clocks  day ${(clocks.dayMs / 1000).toFixed(0)}s · night ${(clocks.nightMs / 1000).toFixed(0)}s`);
  console.log(`  give up after ${(watchdogMs / 60_000).toFixed(0)} min per game`);
  console.log(`  writing ${runDir}\n`);

  /**
   * What this batch was, written down beside it.
   *
   * The recorder's `open` event carries no config: `manager.start` passes one,
   * but by then the table has already traced its first phase, and `trace()`
   * hands back the recorder it already has rather than re-opening it with new
   * meta. So a trace on its own cannot say whether it was played at real speed
   * or at five times it, which is the first thing anybody reading a batch back
   * in three months needs to know.
   */
  await writeFile(
    join(runDir, 'run.json'),
    `${JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        speed,
        locale,
        seats,
        clocks,
        watchdogMs,
        provider: env.MAFIA_BOT_PROVIDER,
        tempo: env.MAFIA_BOT_TEMPO,
        chains: {
          decide: env.MAFIA_CHAIN_DECIDE ?? null,
          speak: env.MAFIA_CHAIN_SPEAK ?? null,
          listen: env.MAFIA_CHAIN_LISTEN ?? null
        },
        templates: chosen.map((one) => ({ name: one.name, seats: one.seats }))
      },
      null,
      2
    )}
`,
    'utf8'
  );

  const manager = new MafiaManager(log);
  manager.startSweeping();
  const rows: Row[] = [];

  for (const [index, template] of chosen.entries()) {
    const head = `  [${index + 1}/${chosen.length}] ${template.name.padEnd(22)}`;
    grumbles.warn = 0;
    grumbles.error = 0;
    const startedAt = Date.now();

    const state = manager.create({
      hostUserId: null,
      config: { ...clocks, locale, setup: template.setup },
      takenCodes: new Set()
    });
    manager.addBots(state.code, template.seats);
    manager.start(state.code);

    const row = await play(manager, state.code, template, startedAt, watchdogMs);
    rows.push(row);

    const how = row.ended ? `${row.winner} on day ${row.days}` : `STUCK — ${row.note ?? 'no reason given'}`;
    const noisy = row.warns + row.errors > 0 ? `  (${row.warns} warn, ${row.errors} err)` : '';
    console.log(`${head} ${`${row.wallSeconds}s`.padStart(6)}  ${how}${noisy}`);

    /**
     * Written as each game lands, not at the end.
     *
     * A batch is hours long and the machine running it may not survive all of
     * them. A manifest that only exists once every game has finished is a
     * manifest that does not exist on the run you most want to read.
     */
    await appendFile(join(runDir, 'manifest.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');
    await manager.destroy(state.code);
  }

  manager.stopSweeping();
  summarise(rows);

  /**
   * Flush before leaving.
   *
   * `process.exit` does not wait for a pending stdout write, and through a pipe
   * — which is how a bench run is actually read, and the only way it is kept —
   * stdout is not synchronous. The summary is the one part of a twenty minute
   * run anybody reads, and it was the part most likely to be cut in half.
   *
   * The exit is still forced rather than left to an empty event loop, because
   * the manager keeps handles alive that would otherwise hold the process open
   * long after the work is done.
   */
  await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
  process.exit(0);
}

/** Watches one table to its end, or to the end of our patience. */
function play(manager: Manager, code: string, template: Template, startedAt: number, watchdogMs: number): Promise<Row> {
  /**
   * The ledger, kept as a running maximum rather than read at the end.
   *
   * The driver forgets a table the moment the game ends — right for a server,
   * and it means asking afterwards how many claims were filed always answers
   * zero. The same trap `simulate.ts` documents falling into.
   */
  let claims = 0;

  return new Promise<Row>((done) => {
    const watcher = setInterval(() => {
      const current = manager.get(code);
      const wallSeconds = Math.round((Date.now() - startedAt) / 1000);

      if (!current) {
        clearInterval(watcher);
        return done(shape(template, code, undefined, wallSeconds, claims, 'table vanished'));
      }

      claims = Math.max(claims, manager.botLedger(code).length);

      if (current.phase === 'ended') {
        clearInterval(watcher);
        return done(shape(template, code, current, wallSeconds, claims));
      }
      if (Date.now() - startedAt > watchdogMs) {
        clearInterval(watcher);
        const where = `stuck in ${current.phase}, day ${current.day}, stage ${current.stage ?? '-'}`;
        return done(shape(template, code, current, wallSeconds, claims, where));
      }
    }, 500);
  });
}

type Final = ReturnType<Manager['get']>;

function shape(
  template: Template,
  code: string,
  state: Final,
  wallSeconds: number,
  claims: number,
  note?: string
): Row {
  const messages = state?.chat.messages ?? [];
  const spoken = messages.filter((message) => message.authorId).length;
  const crowned = (state?.winners ?? []).map((one) => one.kind ?? '?');
  return {
    template: template.name,
    code,
    seats: template.seats,
    winner: crowned.length > 0 ? [...new Set(crowned)].join('+') : state?.phase === 'ended' ? 'draw' : '—',
    days: state?.day ?? 0,
    ended: state?.phase === 'ended',
    wallSeconds,
    spoken,
    announced: messages.length - spoken,
    deaths: state?.deaths.length ?? 0,
    claims,
    warns: grumbles.warn,
    errors: grumbles.error,
    ...(note ? { note } : {})
  };
}

/**
 * The table at the end, and the two numbers that say whether the run was worth
 * having at all.
 *
 * `said` near zero means the chain was unreachable and every seat fell through
 * to the phrasebook — a failure that otherwise looks exactly like a working run,
 * because a phrasebook line is still a line. `claims` near zero means the models
 * wrote prose and left the structured field null, so the deduction loop spent
 * the whole game reasoning about nothing. Neither shows up in a win rate, and
 * neither is visible in a transcript unless you already suspect it.
 */
function summarise(rows: Row[]): void {
  const rule = `  ${'─'.repeat(78)}`;
  console.log(`\n${rule}`);
  console.log(
    `  ${'template'.padEnd(22)} ${'winner'.padEnd(14)} ${'day'.padStart(4)} ${'wall'.padStart(7)} ${'said'.padStart(6)} ${'claims'.padStart(7)}`
  );
  for (const row of rows) {
    const tail = row.ended ? '' : `  ← ${row.note ?? 'unfinished'}`;
    console.log(
      `  ${row.template.padEnd(22)} ${row.winner.padEnd(14)} ${String(row.days).padStart(4)} ${`${row.wallSeconds}s`.padStart(7)} ${String(row.spoken).padStart(6)} ${String(row.claims).padStart(7)}${tail}`
    );
  }
  console.log(rule);

  const stuck = rows.filter((row) => !row.ended);
  const mute = rows.filter((row) => row.ended && row.spoken < row.seats);
  const silent = rows.filter((row) => row.ended && row.claims === 0);
  if (stuck.length > 0) {
    console.log(`  ⚠ ${stuck.length} never finished: ${stuck.map((row) => row.template).join(', ')}`);
  }
  if (mute.length > 0) {
    console.log(`  ⚠ ${mute.length} said less than one line per seat — the chain was probably unreachable`);
  }
  if (silent.length > 0) {
    console.log(`  ⚠ ${silent.length} filed no claims at all — models writing prose, claim field left null`);
  }
  if (stuck.length + mute.length + silent.length === 0) {
    console.log('  every game finished, all of them talking and filing.');
  }

  /**
   * What the driver complained about, grouped.
   *
   * One line per kind rather than per occurrence: two hundred copies of "a line
   * came back after the room closed" is one fact about the run, and the count is
   * the interesting half of it. Every one is in the trace either way.
   */
  if (grumbles.kinds.size > 0) {
    console.log('\n  what the driver complained about:');
    for (const [said, n] of [...grumbles.kinds].sort((left, right) => right[1] - left[1])) {
      console.log(`    ${String(n).padStart(5)} × ${said}`);
    }
    if (!verbose) console.log('    (--verbose prints each one with its context)');
  }
  console.log(`\n  traces + manifest: ${runDir}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
