/**
 * Reading back what the flight recorder wrote.
 *
 * The files are JSONL and can be read with `jq`, which is the point of the
 * format — but the questions actually asked of them are always the same four,
 * and answering those by eye over three thousand lines is not reading, it is
 * archaeology:
 *
 *   - How fast did the table answer a person? (the only number that matters)
 *   - Did the model run at all, on which rung, and how slow was it?
 *   - What did the readers make of what people typed?
 *   - What did a seat decide, and did it ever say it?
 *
 *     pnpm --filter back trace                  # the last games, newest first
 *     pnpm --filter back trace latest           # summarise the newest
 *     pnpm --filter back trace latest --talk    # ...and print the conversation
 *     pnpm --filter back trace mafia-2026-… --raw chat,parse
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { traceDir } from '../env.js';

/* eslint-disable no-console */

interface Line {
  t: number;
  ev: string;
  [key: string]: unknown;
}

const DIM = '[2m';
const BOLD = '[1m';
const OFF = '[0m';

/**
 * A value out of a record, as something printable.
 *
 * Everything read back out of a JSONL line is `unknown`, and `String()` on an
 * unknown is how `[object Object]` gets into a report. Anything that is not a
 * scalar is printed as the JSON it was written as.
 */
function text(value: unknown, fallback = '?'): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return fallback;
  return JSON.stringify(value);
}

function ms(value: number): string {
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
}

/** The middle and the bad end of a set of measurements. */
function spread(values: number[]): string {
  if (values.length === 0) return '—';
  const sorted = [...values].sort((left, right) => left - right);
  const at = (share: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
  return `${ms(at(0.5))} median, ${ms(at(0.9))} p90, ${ms(sorted[sorted.length - 1])} worst`;
}

async function files(): Promise<{ name: string; at: number; size: number }[]> {
  const names = (await readdir(traceDir)).filter((name) => name.endsWith('.jsonl'));
  const rows = await Promise.all(
    names.map(async (name) => {
      const info = await stat(join(traceDir, name));
      return { name, at: info.mtimeMs, size: info.size };
    })
  );
  return rows.sort((left, right) => right.at - left.at);
}

async function read(name: string): Promise<Line[]> {
  const body = await readFile(join(traceDir, name), 'utf8');
  const lines: Line[] = [];
  for (const row of body.split('\n')) {
    if (!row.trim()) continue;
    try {
      lines.push(JSON.parse(row) as Line);
    } catch {
      // A half-written last line is what a power cut looks like. Keep the rest.
    }
  }
  return lines;
}

function list(rows: { name: string; at: number; size: number }[]): void {
  if (rows.length === 0) {
    console.log(`no traces in ${traceDir}`);
    return;
  }
  console.log(`${BOLD}${rows.length} trace(s) in ${traceDir}${OFF}\n`);
  for (const row of rows) {
    const kb = (row.size / 1024).toFixed(0).padStart(6);
    console.log(`  ${kb} KB  ${new Date(row.at).toLocaleString()}  ${row.name}`);
  }
  console.log(`\n${DIM}pnpm --filter back trace latest${OFF}`);
}

/**
 * How long the table took to answer a person, which is the whole question.
 *
 * Measured from a human line in a room to the first bot line in the same room,
 * and reported next to what each reader managed in the same window — so a slow
 * answer can be attributed to the reader, to the chain, or to nobody having had
 * anything to say.
 */
function reactions(lines: Line[]): void {
  const answers: number[] = [];
  const parses: number[] = [];
  const ears: number[] = [];
  let ignored = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.ev !== 'chat' || line.bot !== false) continue;
    const room = line.channel;

    let answered = false;
    for (let next = index + 1; next < lines.length; next++) {
      const later = lines[next];
      if (later.t - line.t > 30_000) break;
      if (later.ev === 'chat' && later.bot === false) break;
      if (later.ev === 'parse' && later.text === line.text) parses.push(later.t - line.t);
      if (later.ev === 'ear') ears.push(later.t - line.t);
      if (later.ev === 'chat' && later.bot === true && later.channel === room) {
        answers.push(later.t - line.t);
        answered = true;
        break;
      }
    }
    if (!answered) ignored++;
  }

  console.log(`${BOLD}answering people${OFF}`);
  console.log(`  a bot answered      ${answers.length} of ${answers.length + ignored} human lines`);
  console.log(`  time to that answer ${spread(answers)}`);
  console.log(`  the parser read it  ${spread(parses)}`);
  console.log(`  the ear read it     ${spread(ears)}`);
}

function models(lines: Line[]): void {
  const calls = lines.filter((line) => line.ev === 'llm');
  if (calls.length === 0) {
    console.log(`\n${BOLD}the model${OFF}\n  never called: the table played the phrasebook all game`);
    return;
  }
  const byRung = new Map<string, { ok: number[]; bad: number; model: string }>();
  for (const call of calls) {
    const key = `${text(call.errand ?? call.task)} via ${text(call.rung)}`;
    const row = byRung.get(key) ?? { ok: [], bad: 0, model: text(call.model) };
    if (call.ok) row.ok.push(Number(call.ms));
    else row.bad++;
    byRung.set(key, row);
  }

  console.log(`\n${BOLD}the model${OFF}  (${calls.length} calls)`);
  for (const [key, row] of [...byRung].sort((left, right) => right[1].ok.length - left[1].ok.length)) {
    const failed = row.bad > 0 ? `, ${row.bad} refused` : '';
    console.log(`  ${key.padEnd(24)} ${String(row.ok.length).padStart(4)} ok${failed}   ${spread(row.ok)}   ${DIM}${row.model}${OFF}`);
  }

  const benched = lines.filter((line) => line.ev === 'chain' && line.benched);
  for (const drop of benched.slice(0, 8)) {
    console.log(`  ${DIM}benched ${text(drop.rung)}: ${text(drop.error)}${OFF}`);
  }
  if (benched.length > 8) console.log(`  ${DIM}…and ${benched.length - 8} more${OFF}`);
}

function readers(lines: Line[]): void {
  const parsed = lines.filter((line) => line.ev === 'parse');
  const heard = lines.filter((line) => line.ev === 'ear');

  const kinds = new Map<string, number>();
  let filedByParser = 0;
  for (const line of parsed) {
    for (const claim of (line.filed as { kind: string }[] | undefined) ?? []) {
      kinds.set(`parser ${claim.kind}`, (kinds.get(`parser ${claim.kind}`) ?? 0) + 1);
      filedByParser++;
    }
  }
  let filedByEar = 0;
  for (const line of heard) {
    for (const claim of (line.filed as { kind: string }[] | undefined) ?? []) {
      kinds.set(`ear    ${claim.kind}`, (kinds.get(`ear    ${claim.kind}`) ?? 0) + 1);
      filedByEar++;
    }
  }

  console.log(`\n${BOLD}reading what people typed${OFF}`);
  console.log(`  parser  ${parsed.length} lines read, ${filedByParser} claims, ${parsed.filter((line) => ((line.filed as unknown[]) ?? []).length === 0).length} read as nothing`);
  console.log(`  ear     ${heard.length} passes, ${filedByEar} claims`);
  for (const [kind, count] of [...kinds].sort((left, right) => right[1] - left[1])) {
    console.log(`    ${kind.padEnd(22)} ${count}`);
  }

  /**
   * What the ear understood and the board would not take.
   *
   * The most useful two lines in this whole report when a table felt deaf: a
   * model that named a house that is not at the table, or a role this deal does
   * not contain, produces exactly the same silence as a model that read
   * nothing, and only this tells them apart.
   */
  const refused = new Map<string, number>();
  for (const line of heard) {
    for (const drop of (line.dropped as { why: string }[] | undefined) ?? []) {
      refused.set(drop.why, (refused.get(drop.why) ?? 0) + 1);
    }
  }
  if (refused.size > 0) {
    const total = [...refused.values()].reduce((sum, count) => sum + count, 0);
    console.log(`  ${BOLD}${total} claim(s) the ear heard and the board refused${OFF}`);
    for (const [why, count] of [...refused].sort((left, right) => right[1] - left[1])) {
      console.log(`    ${why.padEnd(22)} ${count}`);
    }
  }

  /**
   * And the lines nobody made anything of at all.
   *
   * Printed rather than counted, because the count says "the readers found
   * nothing in eleven sentences" and the sentences say *why* — a nickname the
   * roster does not hold, a claim phrased in a way neither reader knows, or
   * eleven people saying "lol", which is the answer you hope for.
   */
  const missed = parsed.filter((line) => ((line.filed as unknown[]) ?? []).length === 0);
  if (missed.length > 0) {
    console.log(`  ${DIM}read as nothing:${OFF}`);
    for (const line of missed.slice(-8)) {
      console.log(`    ${DIM}${text(line.slot)}: ${text(line.utterance ?? line.text)}${OFF}`);
    }
    if (missed.length > 8) console.log(`    ${DIM}…and ${missed.length - 8} more${OFF}`);
  }
}

function bots(lines: Line[]): void {
  const drafts = lines.filter((line) => line.ev === 'draft');
  const unsaid = lines.filter((line) => line.ev === 'unsaid');
  const why = new Map<string, number>();
  for (const draft of drafts) if (draft.why) why.set(text(draft.why), (why.get(text(draft.why)) ?? 0) + 1);

  console.log(`\n${BOLD}what the seats decided${OFF}`);
  console.log(`  ${drafts.length} turns drafted, ${drafts.filter((line) => line.model).length} sent to the mouth`);
  for (const [reason, count] of [...why].sort((left, right) => right[1] - left[1])) {
    console.log(`    ${DIM}no model: ${reason.padEnd(18)}${OFF} ${count}`);
  }
  if (unsaid.length > 0) {
    console.log(`  ${unsaid.length} lines decided and never said (floor, repeat, or no room)`);
  }
}

/** The game as a person would have watched it. */
function talk(lines: Line[]): void {
  console.log(`\n${BOLD}the table${OFF}`);
  for (const line of lines) {
    const at = `${DIM}${(line.t / 1000).toFixed(1).padStart(7)}s${OFF}`;
    if (line.ev === 'phase') {
      console.log(`${at} ${BOLD}— ${text(line.phase)} ${text(line.day)}${line.stage ? ` (${text(line.stage)})` : ''}, ${text(line.alive)} alive —${OFF}`);
    } else if (line.ev === 'chat') {
      const who = `${text(line.slot)} ${text(line.name, "")}`.padEnd(18);
      const room = line.channel === 'day' ? '' : `${DIM}[${text(line.channel)}]${OFF} `;
      console.log(`${at} ${line.bot ? '' : BOLD}${who}${OFF} ${room}${text(line.text)}`);
    } else if (line.ev === 'parse' && ((line.filed as unknown[]) ?? []).length > 0) {
      console.log(`${at} ${DIM}   parser: ${JSON.stringify(line.filed)}${OFF}`);
    } else if (line.ev === 'ear') {
      console.log(`${at} ${DIM}   ear: ${JSON.stringify(line.filed)}${OFF}`);
    } else if (line.ev === 'death') {
      console.log(`${at} ${BOLD}☠ ${text(line.slot)} ${text(line.name)} (${text(line.role)}) — ${text(line.source)}${OFF}`);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const rows = await files().catch(() => []);
  const wanted = args.find((arg) => !arg.startsWith('--'));

  if (!wanted) {
    list(rows);
    return;
  }

  const name = wanted === 'latest' ? rows[0]?.name : rows.find((row) => row.name.includes(wanted))?.name;
  if (!name) {
    console.error(`no trace matching "${wanted}"`);
    process.exitCode = 1;
    return;
  }

  const lines = await read(name);
  const opened = lines.find((line) => line.ev === 'open');
  const dealt = lines.find((line) => line.ev === 'deal');
  const closed = lines.find((line) => line.ev === 'close');

  console.log(`${BOLD}${name}${OFF}  ${lines.length} records, ${ms(lines[lines.length - 1]?.t ?? 0)} of play\n`);
  if (dealt?.seats) {
    for (const seat of dealt.seats as { slot: number; name: string; bot: boolean; role: string }[]) {
      console.log(`  ${String(seat.slot).padStart(2)} ${seat.name.padEnd(16)} ${seat.bot ? DIM + 'bot' + OFF : BOLD + 'human' + OFF}  ${seat.role}`);
    }
  } else if (dealt?.heroes) {
    for (const hero of dealt.heroes as { name: string; bot: boolean; hero: string }[]) {
      console.log(`  ${hero.name.padEnd(16)} ${hero.bot ? 'bot' : 'human'}  ${hero.hero}`);
    }
  }
  console.log('');

  const raw = args.find((arg) => arg.startsWith('--raw'));
  if (raw) {
    const kinds = new Set((raw.split('=')[1] ?? '').split(',').filter(Boolean));
    for (const line of lines) {
      if (kinds.size === 0 || kinds.has(line.ev)) console.log(JSON.stringify(line));
    }
    return;
  }

  if (text(opened?.game) === 'coronaz') {
    const acts = lines.filter((line) => line.ev === 'act');
    console.log(`${BOLD}the raid${OFF}`);
    console.log(`  ${acts.length} actions, ${acts.filter((line) => !line.ok).length} refused`);
    console.log(`  ended ${text(closed?.phase)} on turn ${text(closed?.turn)}`);
    if (args.includes('--talk')) talk(lines);
    return;
  }

  reactions(lines);
  models(lines);
  readers(lines);
  bots(lines);
  if (closed) console.log(`\n${BOLD}winners${OFF} ${JSON.stringify(closed.winners ?? closed.reason ?? '?')}`);
  if (args.includes('--talk')) talk(lines);
}

void main();
