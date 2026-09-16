/**
 * The flight recorder.
 *
 * Everything interesting about a table happens in the second between somebody
 * pressing enter and a seat answering, and until this existed that second left
 * no trace anywhere. The chat shows the answer. The server log shows which rung
 * was up. Nothing at all showed the draft the policy wrote, the claim the
 * parser filed off a line, the prompt the model was handed, the sentence it
 * sent back, or which of those two the table actually said — so every question
 * worth asking about the bots ("why did it ignore me", "why did it vote that",
 * "did the model even run") could only be answered by guessing.
 *
 * One file per game, JSON per line, appended as it is played. The last handful
 * of games are kept and the rest are deleted on the way in, which is the whole
 * of the retention policy: these are for reading tomorrow morning, not for
 * keeping.
 *
 * Three properties it has to have, because it runs inside a live game:
 *
 *  - **It cannot throw.** Every entry point swallows its own errors. A recorder
 *    that can break a table is worse than no recorder.
 *  - **It cannot block.** Lines are buffered and flushed on a timer, so the
 *    game path does a string concatenation and nothing else.
 *  - **It cannot grow without limit.** Long strings are clipped unless asked
 *    not to be, and a file that reaches its ceiling stops recording rather than
 *    filling the disk of a mini PC.
 */
import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { env, traceDir } from './env.js';

/** The games that keep a log. One directory, one prefix each. */
export type TraceGame = 'mafia' | 'coronaz';

/** How long any one string in a record may be, unless `full` was asked for. */
const CLIP = 1200;

/** How long a file may get before it stops accepting lines. */
const MAX_BYTES = 12 * 1024 * 1024;

/** How often buffered lines reach the disk. */
const FLUSH_MS = 400;

/**
 * One game's log.
 *
 * `event` is the whole of the interface: a name and whatever is worth knowing.
 * Records are shallow on purpose — one flat object per line reads well in a
 * terminal with `jq` and diffs well between two games.
 */
export interface Trace {
  event(name: string, data?: Record<string, unknown>): void;
  /** True when anything is actually being written, for callers that can skip work. */
  readonly on: boolean;
  close(summary?: Record<string, unknown>): void;
}

/** The recorder that is handed out when recording is off. */
const SILENT: Trace = {
  on: false,
  event: () => undefined,
  close: () => undefined
};

interface Live {
  file: string;
  buffer: string[];
  bytes: number;
  timer: NodeJS.Timeout | null;
  full: boolean;
  startedAt: number;
}

const open = new Map<string, Live>();
/**
 * Games whose log has been closed on purpose.
 *
 * A finished table is not silent: people read the standings, say well played
 * and argue about night two for another minute. None of that belongs in the
 * game's log, and without this each stray line would open a *second* file for
 * the same table and quietly spend one of the ten slots on an epilogue.
 */
const finished = new Set<string>();
let prepared: Promise<void> | null = null;

/** The directory, made once per process. */
function ready(): Promise<void> {
  prepared ??= mkdir(traceDir, { recursive: true }).then(
    () => undefined,
    () => undefined
  );
  return prepared;
}

/**
 * Strings cut down to a length a person can read.
 *
 * Applied to every string in a record rather than to named fields, because the
 * thing that blows a log up is always the field nobody thought of: a prompt, a
 * transcript, a will, a stack. `full` keeps everything, and is the setting for
 * the evening you are actually chasing a prompt.
 */
function clip(value: unknown, full: boolean): unknown {
  if (typeof value === 'string') {
    if (full || value.length <= CLIP) return value;
    return `${value.slice(0, CLIP)}…[+${value.length - CLIP}]`;
  }
  if (Array.isArray(value)) return value.slice(0, 60).map((entry) => clip(entry, full));
  if (value && typeof value === 'object') {
    if (value instanceof Map) return clip(Object.fromEntries(value), full);
    if (value instanceof Set) return clip([...value], full);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = clip(entry, full);
    return out;
  }
  if (typeof value === 'bigint') return String(value);
  return value;
}

function flush(live: Live): void {
  live.timer = null;
  if (live.buffer.length === 0) return;
  const payload = live.buffer.join('');
  live.buffer = [];
  void ready().then(() =>
    appendFile(live.file, payload, 'utf8').catch(() => {
      // A recorder that cannot write is a recorder that says nothing. It is
      // never a reason to interrupt a game.
    })
  );
}

function arm(live: Live): void {
  if (live.timer) return;
  live.timer = setTimeout(() => flush(live), FLUSH_MS);
  live.timer.unref();
}

/**
 * The newest few kept, everything older deleted.
 *
 * Runs when a game starts rather than when one ends, so a server that is killed
 * mid-game still tidies up on the way back rather than leaving a directory that
 * grows for the life of the machine.
 */
async function rotate(game: TraceGame): Promise<void> {
  try {
    await ready();
    const names = (await readdir(traceDir)).filter((name) => name.startsWith(`${game}-`) && name.endsWith('.jsonl'));
    if (names.length <= env.GAME_TRACE_KEEP) return;
    const dated = await Promise.all(
      names.map(async (name) => ({ name, at: (await stat(join(traceDir, name))).mtimeMs }))
    );
    dated.sort((left, right) => right.at - left.at);
    for (const old of dated.slice(env.GAME_TRACE_KEEP)) await unlink(join(traceDir, old.name)).catch(() => undefined);
  } catch {
    // Retention is housekeeping. It never matters enough to surface.
  }
}

/** A filename a person can find: the game, the table, and when it started. */
function fileName(game: TraceGame, code: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safe = code.replace(/[^A-Za-z0-9_-]/g, '');
  return `${game}-${stamp}-${safe}.jsonl`;
}

/**
 * Starts recording one game, or hands back the recorder already recording it.
 *
 * Cheap to call on every state change, which is how the managers use it: the
 * first call opens the file and the rest find it.
 */
export function trace(game: TraceGame, code: string, meta?: Record<string, unknown>): Trace {
  if (env.GAME_TRACE === 'off') return SILENT;

  const key = `${game}:${code}`;
  const existing = open.get(key);
  if (existing) return recorder(key, existing);
  if (finished.has(key)) return SILENT;

  const live: Live = {
    file: join(traceDir, fileName(game, code)),
    buffer: [],
    bytes: 0,
    timer: null,
    full: env.GAME_TRACE === 'full',
    startedAt: Date.now()
  };
  open.set(key, live);
  void rotate(game);

  const made = recorder(key, live);
  made.event('open', { game, code, ...meta });
  return made;
}

function recorder(key: string, live: Live): Trace {
  return {
    on: true,
    event(name: string, data: Record<string, unknown> = {}): void {
      try {
        if (live.bytes >= MAX_BYTES) return;
        const record = { t: Date.now() - live.startedAt, ev: name, ...(clip(data, live.full) as object) };
        const line = `${JSON.stringify(record)}\n`;
        live.bytes += line.length;
        live.buffer.push(line);
        if (live.bytes >= MAX_BYTES) live.buffer.push(`${JSON.stringify({ ev: 'truncated' })}\n`);
        arm(live);
      } catch {
        // A value that will not serialise is not worth a thrown exception in
        // the middle of a night resolution.
      }
    },
    close(summary?: Record<string, unknown>): void {
      try {
        if (summary) this.event('close', summary);
        if (live.timer) clearTimeout(live.timer);
        flush(live);
      } catch {
        /* nothing here is worth raising */
      } finally {
        open.delete(key);
      }
    }
  };
}

/**
 * Ends a game's log, if it has one.
 *
 * Distinct from `trace(...).close()` in the one way that matters: it never
 * opens a file to close it. A lobby that was abandoned before anybody was dealt
 * a role has nothing to say, and asking for its recorder in order to shut it
 * down would have been the only line in it.
 */
export function endTrace(game: TraceGame, code: string, summary?: Record<string, unknown>): void {
  const key = `${game}:${code}`;
  const live = open.get(key);
  if (!live) return;
  recorder(key, live).close(summary);
  finished.add(key);
}

/** A table let go entirely: it may record again under the same code. */
export function forgetTrace(game: TraceGame, code: string): void {
  finished.delete(`${game}:${code}`);
}

/** Everything still buffered, written now. For a clean shutdown. */
export function flushTraces(): void {
  for (const live of open.values()) {
    if (live.timer) clearTimeout(live.timer);
    flush(live);
  }
}

/** Whether anything is being recorded at all, for callers weighing the cost. */
export const tracing = env.GAME_TRACE !== 'off';
