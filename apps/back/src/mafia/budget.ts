/**
 * What one bot turn costs to ask, and a ceiling on it.
 *
 * The Mafia bots are rate-limited by *tokens per minute*, not by requests: Groq's
 * free tier allows 8000 a minute, so a turn that costs 1400 buys about six turns
 * a minute and a 90-second day phase serves a third of a fifteen-bot table. Every
 * token trimmed from a briefing is another seat that gets to think.
 *
 * That makes prompt size a budgeted resource rather than an implementation
 * detail, and budgets that nobody measures drift. This renders a real briefing
 * for each kind of turn against a real mid-game board and fails if any of them
 * has grown past its ceiling.
 *
 *   pnpm --filter back mafia:budget          # the table, with a breakdown
 *   pnpm --filter back mafia:budget --json   # for a chart, later
 *
 * The ceilings below are deliberately a little above where the code sits, so a
 * sentence added to a prompt is fine and a section added to one is not.
 */
import {
  addMafiaBot,
  advanceMafia,
  createMafiaGame,
  sayInChat,
  startMafia,
  toMafiaView,
  type MafiaState
} from 'mafia-core';

import { brief } from './bot-brief.js';
import { BotMinds } from './bot-mind.js';

/**
 * Tokens, near enough.
 *
 * Four characters per token is the usual rule for English prose, and these
 * briefings are prose with numbers in. A real tokeniser would be more accurate
 * and would mean shipping one for a number whose purpose is to be compared
 * against last week's number.
 */
export const tokens = (text: string): number => Math.round(text.length / 4);

export interface BudgetRow {
  scenario: string;
  players: number;
  humans: number;
  prompt: number;
  ceiling: number;
  sections: { head: string; tokens: number; lines: number }[];
}

const NAMES = [
  'Boba Fett', 'Loki', 'Aragorn', 'Sanji', 'R2-D2', 'Wall-E', 'Kirby', 'Galadriel',
  'Kakashi', 'Michael Myers', 'Spyro', 'Pumbaa', 'Master Chief', 'Terminator', 'Yoda',
  'Gandalf', 'Neo', 'Ripley', 'Vader', 'Zelda', 'Mario', 'Samus', 'Arthur', 'Merlin'
];

/** Section headings `brief` emits, so a breakdown can be attributed to them. */
const HEADS = [
  'Day ', 'You:', 'With you:', 'Roles dealt', 'What matters', 'Nobody stands out',
  'You know:', 'ON TRIAL', 'This morning', 'Recent lines', 'WHAT WAS ACTUALLY SAID',
  'CAUGHT IN A LIE', 'Nobody has spoken', 'TASK'
];

/**
 * A table three days in, with a board and a conversation on it.
 *
 * Deterministic (`rng` is a constant) so the number moves when the *prompt*
 * changes and not when the dice do — the whole point is to compare runs.
 */
function midGame(players: number, humans: number, chatLines: number): string {
  const rng = () => 0.5;
  const state: MafiaState = createMafiaGame({
    code: 'BUDG',
    hostToken: 'h',
    hostUserId: null,
    config: { dayMs: 90_000, nightMs: 40_000, defenseMs: 20_000, judgementMs: 15_000, aftermathMs: 5_000 },
    now: 0
  });

  for (let index = 0; index < players; index++) {
    addMafiaBot(state, `t${index}`, NAMES[index], (max) => Math.floor(rng() * max)).name = NAMES[index];
  }
  // Some seats are people: the transcript window opens wide when they are.
  for (let index = 0; index < humans; index++) Object.values(state.players)[index].isBot = false;
  startMafia(state, 1000, rng);

  let now = 2000;
  const minds = new BotMinds();
  for (let step = 0; step < 500 && state.day < 4; step++) {
    now += 5000;
    advanceMafia(state, now, rng);
  }
  minds.openDay(state);

  const alive = Object.values(state.players).filter((player) => player.alive);
  for (let index = 0; index < chatLines; index++) {
    const speaker = alive[index % alive.length];
    sayInChat(
      state,
      speaker.playerId,
      'day',
      `I was home last night, and I do not believe a word house ${1 + (index % 12)} has said all day.`,
      now
    );
  }

  const me = alive[alive.length - 1];
  const view = toMafiaView(state, { kind: 'player', playerId: me.playerId });
  return brief(view, minds.board(state), minds.mind(state, me.playerId)!, 'TASK <task line>', 'en');
}

function breakdown(prompt: string): BudgetRow['sections'] {
  const buckets = new Map<string, string[]>();
  let current = '(preamble)';
  for (const line of prompt.split('\n')) {
    const head = HEADS.find((candidate) => line.startsWith(candidate));
    if (head) current = head.trim();
    buckets.set(current, [...(buckets.get(current) ?? []), line]);
  }
  return [...buckets].map(([head, lines]) => ({ head, tokens: tokens(lines.join('\n')), lines: lines.length }));
}

/**
 * The scenarios worth holding a line on, and where that line is.
 *
 * A table of bots is the common case and the cheap one. A table with people at
 * it is the one that matters and the expensive one, because the transcript stops
 * being compressible: what a person typed is the content.
 */
const SCENARIOS: { scenario: string; players: number; humans: number; chat: number; ceiling: number }[] = [
  { scenario: 'all bots, quiet day', players: 15, humans: 0, chat: 4, ceiling: 400 },
  { scenario: 'all bots, busy day', players: 15, humans: 0, chat: 30, ceiling: 450 },
  { scenario: '2 humans at the table', players: 15, humans: 2, chat: 30, ceiling: 700 },
  { scenario: '5 humans, 24 seats', players: 24, humans: 5, chat: 40, ceiling: 950 }
];

export function measureBudget(): BudgetRow[] {
  return SCENARIOS.map(({ scenario, players, humans, chat, ceiling }) => {
    const prompt = midGame(players, humans, chat);
    return { scenario, players, humans, prompt: tokens(prompt), ceiling, sections: breakdown(prompt) };
  });
}

/* --------------------------------- the CLI -------------------------------- */
/* eslint-disable no-console */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '')) {
  const rows = measureBudget();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    for (const row of rows) {
      const verdict = row.prompt <= row.ceiling ? 'ok  ' : 'OVER';
      console.log(`\n${verdict} ${row.scenario}: ${row.prompt} tok (ceiling ${row.ceiling})`);
      for (const section of row.sections) {
        console.log(`       ${String(section.tokens).padStart(4)} tok  ${section.head} (${section.lines} lines)`);
      }
    }
  }

  const over = rows.filter((row) => row.prompt > row.ceiling);
  if (over.length > 0) {
    console.error(`\n${over.length} prompt(s) over budget: ${over.map((row) => row.scenario).join(', ')}`);
    process.exit(1);
  }
  console.log('\nevery prompt within budget');
}
