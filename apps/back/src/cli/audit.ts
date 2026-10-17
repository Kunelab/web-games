/**
 * The faults a person at the table notices, counted off a trace.
 *
 * `trace` answers "how fast, how often, what did the readers make of it". This
 * answers the question the October games were actually played to answer: what
 * did the bots get *wrong*, in the ways a person sitting there would complain
 * about. Every class below is a symptom from `docs/mafia-bots-fix-plan.md`, and
 * each was first found by reading ten traces by hand with throwaway scripts.
 * Those scripts are what this is, ported, so that every fix can be judged
 * against the same ten games instead of against a unit test that only knows
 * the sentence it was written for.
 *
 *     pnpm --filter back trace --audit                       # every trace in the trace dir
 *     pnpm --filter back trace --audit path/to/traces/       # or a directory
 *     pnpm --filter back trace --audit a.jsonl b.jsonl --verbose
 *
 * Deliberately approximate. A trace records what was decided, what the model
 * was told and what was posted, and not which of those caused which: a line is
 * matched to the call that wrote it by speaker, time and wording, and a team is
 * whoever was seen in its room. The counts are for comparing a build with the
 * one before it on the same games, not for quoting as truth.
 */
import { CREATES, ROLES, type RoleId } from 'mafia-core';

import { fold, refusesBare, roleFromName, seatHits } from '../mafia/asks.js';
import { insults as isInsult } from '../mafia/mouth.js';

/** One record of a trace file. */
export interface TraceLine {
  t: number;
  ev: string;
  [key: string]: unknown;
}

/** One fault, as the line that shows it. */
export interface Evidence {
  t: number;
  who: string;
  text: string;
  /** The room it was said in, when it was said. */
  channel?: string;
  /** What the model was told, or what it was told about, trimmed to the part that matters. */
  excerpt?: string;
}

export interface GameAudit {
  code: string;
  humans: string[];
  /** A bot answering a human line that was not put to it. */
  misaddressed: Evidence[];
  /** "X is not the Mason, because I am" about a badge more than one seat can wear. */
  counterClaims: Evidence[];
  /** A seat that sat in a team room with another, later voting it or denying its badge. */
  teammates: Evidence[];
  /** "no" said in a team room, and the team acting on the house it refused anyway. */
  vetoes: Evidence[];
  /** A prompt whose "last things said" reached back into an earlier phase. */
  stale: Evidence[];
  /** Bot day lines that were the wagon's "what did I do?" rather than anything else. */
  demand: { lines: number; of: number; evidence: Evidence[] };
  /** A bot line naming a person and calling them names. */
  insults: Evidence[];
}

interface Seat {
  slot: number;
  name: string;
  bot: boolean;
  role: string;
}

/** A speak call as the model saw it, once per distinct prompt. */
interface Speak {
  t: number;
  /** When the prompt was built, which is the moment its context belongs to. */
  asked: number;
  slot: number;
  name: string;
  prompt: string;
  answers: string[];
  intent: string;
  /** The chat line this call ended up as, if it was posted. */
  posted?: TraceLine;
}

/* --------------------------------- reading -------------------------------- */

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);

/**
 * Badges more than one seat can hold at once.
 *
 * Everything the role table does not mark `unique`, plus what the game makes
 * mid-game: the lodge initiates Masons, the Auditor strips to Citizen and the
 * mafia's lower ranks, the Cult converts, the Executioner leaves a Jester. A
 * deal holding one Mason says nothing about how many there are on day four,
 * which is the whole of symptom 4.
 */
const MADE_MID_GAME: ReadonlySet<RoleId> = new Set(Object.values(CREATES).flat());

function sharedBadge(role: RoleId): boolean {
  return MADE_MID_GAME.has(role) || !ROLES[role].unique;
}

/** The room a role talks in at night, if it has one. */
function teamRoom(role: string): string | null {
  if (role === 'mason' || role === 'mason-leader') return 'mason';
  const def = (ROLES as Record<string, { faction: string } | undefined>)[role];
  if (!def) return null;
  return def.faction === 'mafia' || def.faction === 'triad' || def.faction === 'cult' ? def.faction : null;
}

const TEAM_ROOMS = new Set(['mafia', 'triad', 'cult', 'mason']);

/** Words, for comparing a model's answer with what was posted after typos and trimming. */
function words(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Whether a posted line is this answer.
 *
 * Not equality: the typist adds mistakes on purpose, the guard trims, and a
 * hedged call has two answers of which one was used. Most of the same words in
 * either direction is the line.
 */
export function sameLine(left: string, right: string): boolean {
  const a = words(left);
  const b = words(right);
  if (a.length === 0 || b.length === 0) return false;
  const pool = new Map<string, number>();
  for (const word of b) pool.set(word, (pool.get(word) ?? 0) + 1);
  let common = 0;
  for (const word of a) {
    const left = pool.get(word) ?? 0;
    if (left > 0) {
      common++;
      pool.set(word, left - 1);
    }
  }
  return (2 * common) / (a.length + b.length) >= 0.6;
}

/** How long after a call its line may still show up in chat: typing, the floor, a queue. */
const POSTED_WITHIN_MS = 45_000;

/** "Name: text" lines of a prompt block, from the line after `header` to the first line that is not one. */
function block(prompt: string, header: RegExp): { who: string; text: string }[] | null {
  const rows = prompt.split('\n');
  const start = rows.findIndex((row) => header.test(row));
  if (start < 0) return null;
  const out: { who: string; text: string }[] = [];
  for (const row of rows.slice(start + 1)) {
    if (/^(?:Reply |The last things|YOU ALREADY|Your line|You have decided)/.test(row)) break;
    const colon = row.indexOf(': ');
    if (colon <= 0 || colon > 40) break;
    out.push({ who: row.slice(0, colon), text: row.slice(colon + 2) });
  }
  return out;
}

/**
 * The header of the block a seat is told to answer.
 *
 * Today's wording is "ANSWER THIS. Somebody just said, to you or about you:".
 * Phase 1 of the plan rewrites it to say who it was said to, so the newer
 * phrasings are accepted too and the audit keeps working across the change.
 */
const ANSWER_HEADER = /(?:ANSWER THIS|said to you|said in your room).*:\s*$/;
const CONTEXT_HEADER = /^The last things said in the room/;

/** The intents the wagon writes when a seat is being voted. */
const DEMANDING = /^(?:push back at\b|ask\b.*\bwhat they actually have\b)/;
const DEMAND_PHRASE = /\bwhat (?:exactly )?did i (?:actually )?do\b/;

/**
 * The two shapes a counter-claim is decided in, read off the intent and its
 * "Because:" line only. The rest of the prompt quotes what the seat already
 * said today, and a counter-claim in that list is not this call making one.
 */
const COUNTER = /^(?:say )?(.+?) is not the ([A-Z][\w' -]*?), because (?:you are|I am) the \2\b/;
const BOTH = /(?:^|\b)(\S+(?: \S+)?) and (\S+(?: \S+)?) both claim to be the ([A-Z][\w' -]*?)\b/;

/* --------------------------------- the audit ------------------------------- */

/**
 * Every fault class, for one game. Null for a file that is not a Mafia game
 * (the unit suite's own recorder output has no `deal`).
 */
export function auditTrace(lines: readonly TraceLine[], code = '?'): GameAudit | null {
  const deal = lines.find((line) => line.ev === 'deal');
  const seats = (deal?.seats as Seat[] | undefined) ?? null;
  if (!seats) return null;

  const bySlot = new Map(seats.map((seat) => [seat.slot, seat]));
  const byName = new Map(seats.map((seat) => [seat.name, seat]));
  const roster = seats.map((seat) => ({ slot: seat.slot, name: seat.name }));
  const humanSeats = roster.filter((seat) => !bySlot.get(seat.slot)?.bot);
  const label = (slot: number): string => `${bySlot.get(slot)?.name ?? '?'} (${slot})`;

  /* The phase every moment belongs to, and the votes and the stand at that moment. */
  const phases = lines.filter((line) => line.ev === 'phase');
  const phaseAt = (t: number): TraceLine | undefined => {
    let found: TraceLine | undefined;
    for (const phase of phases) {
      if (phase.t > t) break;
      found = phase;
    }
    return found;
  };

  const chats = lines.filter((line) => line.ev === 'chat');

  /* Who sat in which team room, and from when. */
  const member = new Map<string, Map<number, number>>();
  const join = (room: string, slot: number, t: number): void => {
    const seats = member.get(room) ?? new Map<number, number>();
    if (!seats.has(slot) || (seats.get(slot) ?? 0) > t) seats.set(slot, t);
    member.set(room, seats);
  };
  for (const seat of seats) {
    const room = teamRoom(seat.role);
    if (room) join(room, seat.slot, 0);
  }
  for (const line of lines) {
    const slot = num(line.slot);
    if (slot === null) continue;
    if (line.ev === 'chat' && TEAM_ROOMS.has(str(line.channel))) join(str(line.channel), slot, line.t);
    if ((line.ev === 'draft' || line.ev === 'revote') && str(line.role)) {
      const room = teamRoom(str(line.role));
      if (room) join(room, slot, line.t);
    }
  }
  const sharedRoom = (left: number, right: number, t: number): string | null => {
    for (const [room, seats] of member) {
      const a = seats.get(left);
      const b = seats.get(right);
      if (a !== undefined && b !== undefined && a <= t && b <= t) return room;
    }
    return null;
  };

  /* The speak calls, once per prompt, each matched to the line it became. */
  const speaks: Speak[] = [];
  const seen = new Map<string, Speak>();
  for (const line of lines) {
    if (line.ev !== 'llm' || line.task !== 'speak' || !line.ok) continue;
    const prompt = str(line.prompt);
    const answer = str((line.answer as { line?: unknown } | null)?.line);
    const key = `${str(line.botId)}\n${prompt}`;
    const already = seen.get(key);
    if (already) {
      if (answer) already.answers.push(answer);
      continue;
    }
    const me = /^You are (.+?)\. Your number at this table is (\d+)/.exec(prompt);
    if (!me) continue;
    const call: Speak = {
      t: line.t,
      asked: line.t - (num(line.ms) ?? 0),
      slot: Number(me[2]),
      name: me[1],
      prompt,
      answers: answer ? [answer] : [],
      intent: /^You have decided to: (.*)$/m.exec(prompt)?.[1] ?? ''
    };
    seen.set(key, call);
    speaks.push(call);
  }
  const used = new Set<TraceLine>();
  for (const call of speaks) {
    call.posted = chats.find(
      (chat) =>
        !used.has(chat) &&
        num(chat.slot) === call.slot &&
        chat.t >= call.t - 1000 &&
        chat.t <= call.t + POSTED_WITHIN_MS &&
        call.answers.some((answer) => sameLine(answer, str(chat.text)))
    );
    if (call.posted) used.add(call.posted);
  }
  const callOf = new Map(speaks.filter((call) => call.posted).map((call) => [call.posted as TraceLine, call]));

  /* ---- misaddressed ---- */
  const misaddressed: Evidence[] = [];
  const votesAt = (t: number, day: unknown): number[] => {
    const tally = new Map<number, number>();
    const latest = new Map<number, number | null>();
    for (const line of lines) {
      if (line.t > t) break;
      if (line.ev === 'vote' && line.day === day && line.phase === 'day')
        latest.set(Number(line.slot), num(line.target));
    }
    for (const target of latest.values()) if (target !== null) tally.set(target, (tally.get(target) ?? 0) + 1);
    const best = Math.max(0, ...tally.values());
    return best === 0 ? [] : [...tally].filter(([, count]) => count === best).map(([slot]) => slot);
  };
  for (const call of speaks) {
    const heard = block(call.prompt, ANSWER_HEADER);
    if (!heard || heard.length === 0 || !call.posted) continue;
    const channel = str(call.posted.channel);
    // A cell and a whisper are two people, and a team room is said to all of it: none can be misaddressed.
    if (channel.startsWith('jail') || channel.startsWith('pm:') || TEAM_ROOMS.has(channel)) continue;
    const human = heard.filter((entry) => byName.get(entry.who)?.bot === false);
    const quoted = human.length > 0 ? human : heard;
    if (quoted.some((entry) => seatHits(entry.text, roster).some((hit) => hit.slot === call.slot))) continue;
    const phase = phaseAt(call.asked);
    if (num(phase?.onTrial) === call.slot) continue;
    if (votesAt(call.asked, phase?.day).includes(call.slot)) continue;
    misaddressed.push({
      t: call.posted.t,
      who: label(call.slot),
      channel,
      text: str(call.posted.text),
      excerpt: quoted.map((entry) => `${entry.who}: ${entry.text}`).join(' / ')
    });
  }

  /* ---- counter-claims on a shared badge, and on a teammate ---- */
  const counterClaims: Evidence[] = [];
  const teammates: Evidence[] = [];
  for (const call of speaks) {
    const because = /^Because: (.*)$/m.exec(call.prompt)?.[1] ?? '';
    const counter = COUNTER.exec(call.intent);
    const both = counter ? null : (BOTH.exec(call.intent) ?? BOTH.exec(because));
    const badge = counter?.[2] ?? both?.[3];
    if (!badge) continue;
    const role = roleFromName(badge);
    if (!role) continue;
    const at = call.posted?.t ?? call.t;
    const excerpt = (counter ?? both)?.[0];
    if (sharedBadge(role)) {
      counterClaims.push({
        t: at,
        who: label(call.slot),
        channel: str(call.posted?.channel) || undefined,
        text: call.posted ? str(call.posted.text) : `(not posted) ${call.answers[0] ?? ''}`,
        excerpt
      });
    }
    // "they and Max both claim…": "they" is the seat the intent is about, the other one is the rival.
    const rival = counter?.[1] ?? [both?.[1], both?.[2]].find((name) => name && byName.has(name));
    const target = rival ? byName.get(rival)?.slot : undefined;
    if (target !== undefined) {
      const room = sharedRoom(call.slot, target, call.asked);
      if (room) {
        teammates.push({
          t: at,
          who: label(call.slot),
          text: `denies ${label(target)} the ${badge}, after the ${room} room`,
          excerpt
        });
      }
    }
  }

  /* ---- a teammate voted ---- */
  const voted = new Set<string>();
  for (const line of lines) {
    if (line.ev !== 'vote' || line.bot !== true) continue;
    const slot = num(line.slot);
    const target = num(line.target);
    if (slot === null || target === null) continue;
    const room = sharedRoom(slot, target, line.t);
    if (!room) continue;
    const key = `${slot}>${target}@${String(line.day)}`;
    if (voted.has(key)) continue;
    voted.add(key);
    teammates.push({
      t: line.t,
      who: label(slot),
      text: `votes ${label(target)} on day ${String(line.day)}, after the ${room} room`
    });
  }
  /* ---- a teammate accused, which a bot can do without ever voting ---- */
  const accused = new Set<string>();
  for (const line of lines) {
    if (line.ev !== 'draft' || line.claim !== 'accuse') continue;
    const slot = num(line.slot);
    const target = num(line.about);
    if (slot === null || target === null || slot === target) continue;
    const room = sharedRoom(slot, target, line.t);
    const day = phaseAt(line.t)?.day;
    const key = `${slot}>${target}@${String(day)}`;
    if (!room || accused.has(key)) continue;
    accused.add(key);
    teammates.push({
      t: line.t,
      who: label(slot),
      text: `accuses ${label(target)} on day ${String(day)}, after the ${room} room`,
      excerpt: str(line.say) || undefined
    });
  }
  teammates.sort((left, right) => left.t - right.t);

  /* ---- a veto in a team room, and the team acting on the house anyway ---- */
  const vetoes: Evidence[] = [];
  for (const parse of lines) {
    // A person's veto: a bot refusing in its own room is the room agreeing with itself.
    if (parse.ev !== 'room-parse' || bySlot.get(Number(parse.slot))?.bot !== false) continue;
    const room = str(parse.room);
    /**
     * The houses refused. By name ("Don't kill max", `J6D7G`), as the reader
     * filed them; or a bare "no", which refers to the last house anybody else
     * put forward in that room.
     */
    const refused = ((parse.spared as { slot?: unknown }[] | null) ?? [])
      .map((entry) => num(entry.slot))
      .filter((slot): slot is number => slot !== null);
    if (refused.length === 0 && refusesBare(str(parse.text))) {
      let proposed = num((parse.ask as { slot?: unknown } | null)?.slot);
      if (proposed === null) {
        for (const chat of chats) {
          if (chat.t >= parse.t) break;
          if (chat.channel !== room || num(chat.slot) === num(parse.slot)) continue;
          const hits = seatHits(str(chat.text), roster);
          if (hits.length > 0) proposed = hits[hits.length - 1].slot;
        }
      }
      if (proposed !== null) refused.push(proposed);
    }
    if (refused.length === 0) continue;

    const night = phaseAt(parse.t)?.day;
    const team = member.get(room) ?? new Map<number, number>();
    const final = new Map<number, TraceLine>();
    for (const line of lines) {
      if (line.ev === 'night-action' && line.day === night && line.phase === 'night' && team.has(Number(line.slot))) {
        final.set(Number(line.slot), line);
      }
    }
    for (const proposed of new Set(refused)) {
      const acted = [...final.values()].find((line) => num(line.target) === proposed || num(line.second) === proposed);
      if (!acted) continue;
      vetoes.push({
        t: parse.t,
        who: label(Number(parse.slot)),
        channel: room,
        text: str(parse.text),
        excerpt: `refused ${label(proposed)}; ${label(Number(acted.slot))} acted on it that night`
      });
    }
  }

  /* ---- context from an earlier phase ---- */
  const stale: Evidence[] = [];
  for (const call of speaks) {
    const context = block(call.prompt, CONTEXT_HEADER);
    if (!context || context.length === 0) continue;
    const phase = phaseAt(call.asked);
    const old: string[] = [];
    for (const entry of context) {
      const said = fold(entry.text);
      let source: TraceLine | undefined;
      for (const chat of chats) {
        if (chat.t > call.asked) break;
        if (chat.name !== entry.who) continue;
        const text = fold(str(chat.text));
        if (text.slice(0, 40) === said.slice(0, 40) || text.includes(said.slice(0, 30))) source = chat;
      }
      if (source && (source.day !== phase?.day || source.phase !== phase?.phase)) {
        old.push(`${entry.who}: ${entry.text} [${String(source.phase)} ${String(source.day)}]`);
      }
    }
    if (old.length === 0) continue;
    stale.push({
      t: call.posted?.t ?? call.t,
      who: label(call.slot),
      channel: str(call.posted?.channel) || undefined,
      text: call.posted ? str(call.posted.text) : `(not posted) ${call.answers[0] ?? ''}`,
      excerpt: `${String(phase?.phase)} ${String(phase?.day)}, shown ${old.slice(0, 2).join(' / ')}`
    });
  }

  /* ---- "what did I do?" ---- */
  const dayLines = chats.filter((chat) => chat.bot === true && chat.channel === 'day');
  const demands: Evidence[] = [];
  for (const chat of dayLines) {
    const intent = callOf.get(chat)?.intent ?? '';
    if (!DEMANDING.test(intent) && !DEMAND_PHRASE.test(fold(str(chat.text)))) continue;
    demands.push({ t: chat.t, who: label(Number(chat.slot)), text: str(chat.text), excerpt: intent || '(phrasebook)' });
  }

  /* ---- names called ---- */
  const insults: Evidence[] = [];
  for (const chat of chats) {
    if (chat.bot !== true) continue;
    const text = str(chat.text);
    if (!isInsult(fold(text))) continue;
    const aimed = seatHits(text, humanSeats).filter((hit) => hit.slot !== num(chat.slot));
    if (aimed.length === 0) continue;
    insults.push({
      t: chat.t,
      who: label(Number(chat.slot)),
      channel: str(chat.channel),
      text,
      excerpt: `at ${aimed.map((hit) => label(hit.slot)).join(', ')}`
    });
  }

  return {
    code,
    humans: seats.filter((seat) => !seat.bot).map((seat) => seat.name),
    misaddressed,
    counterClaims,
    teammates,
    vetoes,
    stale,
    demand: { lines: demands.length, of: dayLines.length, evidence: demands },
    insults
  };
}

/* -------------------------------- the report ------------------------------- */

const COLUMNS: { head: string; get: (game: GameAudit) => string }[] = [
  { head: 'misaddr', get: (game) => String(game.misaddressed.length) },
  { head: 'counter', get: (game) => String(game.counterClaims.length) },
  { head: 'ex-mate', get: (game) => String(game.teammates.length) },
  { head: 'veto', get: (game) => String(game.vetoes.length) },
  { head: 'stale', get: (game) => String(game.stale.length) },
  {
    head: 'demand',
    get: (game) =>
      game.demand.of === 0
        ? '-'
        : `${game.demand.lines}/${game.demand.of} ${Math.round((100 * game.demand.lines) / game.demand.of)}%`
  },
  { head: 'insult', get: (game) => String(game.insults.length) }
];

function seconds(t: number): string {
  return `${(t / 1000).toFixed(0).padStart(5)}s`;
}

function evidence(title: string, rows: Evidence[]): string[] {
  if (rows.length === 0) return [];
  const out = [`  ${title} (${rows.length})`];
  for (const row of rows) {
    const room = row.channel && row.channel !== 'day' ? ` [${row.channel}]` : '';
    out.push(`    ${seconds(row.t)}  ${row.who}${room}: ${row.text}`);
    if (row.excerpt) out.push(`             > ${row.excerpt}`);
  }
  return out;
}

/** One row per game, a total, and with `verbose` every line that was counted. */
export function renderAudit(games: GameAudit[], verbose = false): string {
  const head = [
    'game'.padEnd(6),
    'humans'.padEnd(16),
    ...COLUMNS.map((column) => column.head.padStart(column.head === 'demand' ? 13 : 8))
  ];
  const out = [head.join(' ')];
  for (const game of games) {
    const humans = game.humans.join(',').slice(0, 16).padEnd(16);
    out.push(
      [
        game.code.padEnd(6),
        humans,
        ...COLUMNS.map((column) => column.get(game).padStart(column.head === 'demand' ? 13 : 8))
      ].join(' ')
    );
  }
  if (games.length > 1) {
    const sum = (pick: (game: GameAudit) => number): number => games.reduce((total, game) => total + pick(game), 0);
    const lines = sum((game) => game.demand.lines);
    const of = sum((game) => game.demand.of);
    out.push(
      [
        'total'.padEnd(6),
        ''.padEnd(16),
        ...[
          sum((game) => game.misaddressed.length),
          sum((game) => game.counterClaims.length),
          sum((game) => game.teammates.length),
          sum((game) => game.vetoes.length),
          sum((game) => game.stale.length)
        ].map((count) => String(count).padStart(8)),
        (of === 0 ? '-' : `${lines}/${of} ${Math.round((100 * lines) / of)}%`).padStart(13),
        String(sum((game) => game.insults.length)).padStart(8)
      ].join(' ')
    );
  }
  out.push(
    '',
    'misaddr: a bot answered a human line that named neither it nor its trial or wagon. counter: a counter-claim on a badge',
    'more than one seat can hold. ex-mate: a vote or badge denial against a seat it shared a team room with. veto: a bare',
    '"no" in a team room, then the team acted on that house. stale: context lines from an earlier phase. demand: bot day',
    'lines that were "what did I do?". insult: a bot line naming a human with a word from the list.'
  );
  if (!verbose) return out.join('\n');

  for (const game of games) {
    out.push('', `== ${game.code}  humans: ${game.humans.join(', ')}`);
    out.push(...evidence('misaddressed', game.misaddressed));
    out.push(...evidence('counter-claims on a shared badge', game.counterClaims));
    out.push(...evidence('teammate hostility', game.teammates));
    out.push(...evidence('ignored vetoes', game.vetoes));
    out.push(...evidence('stale context', game.stale));
    out.push(...evidence('demands', game.demand.evidence));
    out.push(...evidence('insults', game.insults));
  }
  return out.join('\n');
}
