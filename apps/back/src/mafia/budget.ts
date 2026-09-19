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
import { mouthPrompt, mouthRules, type Intent } from './mouth.js';
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

// prettier-ignore
const NAMES = [
  'Boba Fett', 'Loki', 'Aragorn', 'Sanji', 'R2-D2', 'Wall-E', 'Kirby', 'Galadriel',
  'Kakashi', 'Michael Myers', 'Spyro', 'Pumbaa', 'Master Chief', 'Terminator', 'Yoda',
  'Gandalf', 'Neo', 'Ripley', 'Vader', 'Zelda', 'Mario', 'Samus', 'Arthur', 'Merlin'
];

/** Section headings `brief` emits, so a breakdown can be attributed to them. */
// prettier-ignore
const HEADS = [
  'Day ', 'You:', 'With you:', 'Roles dealt', 'What matters', 'Nobody stands out',
  'You know:', 'ON TRIAL', 'This morning', 'Recent lines', 'WHAT WAS ACTUALLY SAID',
  'WHAT YOU MAY DO RIGHT NOW', 'HOW YOU WIN', 'CAUGHT IN A LIE', 'Nobody has spoken', 'TASK'
];

/**
 * A table three days in, with a board and a conversation on it.
 *
 * Deterministic (`rng` is a constant) so the number moves when the *prompt*
 * changes and not when the dice do — the whole point is to compare runs.
 */
function midGame(players: number, humans: number, chatLines: number, said?: string): string {
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
      said ?? `I was home last night, and I do not believe a word house ${1 + (index % 12)} has said all day.`,
      now
    );
  }

  const me = alive[alive.length - 1];
  const view = toMafiaView(state, { kind: 'player', playerId: me.playerId });
  return brief(view, minds.board(state, me.playerId), minds.mind(state, me.playerId)!, 'TASK <task line>', 'en');
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
/**
 * Raised by eighty tokens across the board, once, for the rules page.
 *
 * Every briefing now carries `legalMoves`: what this seat may actually do this
 * minute, with the legal targets, the charges left, whether the ballot has
 * opened and what a trial is. It measures 81 tokens and it is the cheapest
 * thing in the prompt, because the alternative is not a smaller prompt — it is
 * a model that heals as a Sheriff, votes on day one and targets a corpse, and
 * every one of those is a whole request spent on a move the engine refuses.
 * Eighty tokens to not waste four hundred.
 *
 * The ceilings are still ceilings. They moved because the job grew, and the
 * number to watch is that they do not move again quietly.
 */
interface Scenario {
  scenario: string;
  players: number;
  humans: number;
  chat: number;
  ceiling: number;
  said?: string;
}

const SCENARIOS: Scenario[] = [
  { scenario: 'all bots, quiet day', players: 15, humans: 0, chat: 4, ceiling: 480 },
  { scenario: 'all bots, busy day', players: 15, humans: 0, chat: 30, ceiling: 530 },
  { scenario: '2 humans at the table', players: 15, humans: 2, chat: 30, ceiling: 790 },
  { scenario: '5 humans, 24 seats', players: 24, humans: 5, chat: 40, ceiling: 950 },
  /**
   * The afternoon the ceilings exist for.
   *
   * The chat refuses anything past four hundred characters, and nothing stopped
   * twenty-six of those reaching one briefing: two and a half thousand tokens
   * of somebody else's typing, on every seat's turn, out of the same allowance
   * per minute the whole table shares. The transcript is bounded in characters
   * now, and this is what checks that it still is.
   */
  {
    scenario: 'everybody typing the longest line the chat allows',
    players: 24,
    humans: 5,
    chat: 40,
    ceiling: 950,
    said: 'x'.repeat(390)
  }
];

/**
 * The mouth path, which is what a turn costs under `MAFIA_BOT_MIND=policy`.
 *
 * Measured separately because it is a different prompt entirely, not a smaller
 * version of the briefing: the brain has already decided, and the model is told
 * an intention rather than a board.
 *
 * Most of it is the fixed rulebook, so what this number really watches is the
 * variable half. A jump on a table that got bigger or noisier means board state
 * has leaked onto a sheet that is supposed to carry none: no roster, no roles,
 * no claims, only what this seat already decided and the words it is answering.
 */
function mouthTurn(): string {
  const intent: Intent = {
    act: 'accuse house 11 (Loki) and vote for them',
    because: 'they swore they never left, and house 3 puts them on a doorstep',
    mood: 'impulsive and combative, quick to accuse',
    fallback: '11 does not add up. That is my vote.'
  };
  const recent = [
    { slot: 11, name: 'Loki', text: 'I was home all night, nothing to report' },
    { slot: 3, name: 'Aragorn', text: 'somebody went into 11 last night, I saw the door' },
    { slot: 2, name: 'Wall-E', text: 'so who are we voting for then' },
    { slot: 5, name: 'Galadriel', text: 'not me, I have been saying the same thing all game' }
  ];
  return `${mouthRules('en')}
${mouthPrompt({ name: 'Kirby', slot: 7 }, intent, recent)}`;
}

export function measureBudget(): BudgetRow[] {
  const deciding = SCENARIOS.map(({ scenario, players, humans, chat, ceiling, said }) => {
    const prompt = midGame(players, humans, chat, said);
    return { scenario, players, humans, prompt: tokens(prompt), ceiling, sections: breakdown(prompt) };
  });

  const mouth = mouthTurn();
  return [
    ...deciding,
    {
      scenario: 'one turn through the mouth (policy mind)',
      players: 15,
      humans: 2,
      prompt: tokens(mouth),
      /**
       * Moved from 450, then from 650, then from 760. Three times, deliberately
       * each time.
       *
       * The mouth was two hundred tokens when it could only be told a move and a
       * mood. It has since been given the vote to stay consistent with, the
       * actual sentences it is answering, and a rulebook that treats quoted chat
       * as untrusted data. Those are jobs, not leakage: the sheet still carries
       * no board, no roster and no roles, which is the property this number is
       * really guarding. The redundant half of the rulebook came out (two pairs
       * of rules saying the same thing) and what is left is 593.
       *
       * The second move is the no-calendar rule, which took it to 703. Same
       * test as before, and it passes it: a table with numbered days and no
       * weekdays is a fact about the game every seat already knows, not a fact
       * about *this* game that the mouth is not allowed to be told. Nothing it
       * adds could convict a seat.
       *
       * The third move is arithmetic rather than judgement. Two rules landed in
       * that same pass and only one of them was counted: the no-calendar rule at
       * 69 tokens took it to 703, and the never-name-your-own-side rule at 80
       * took it to 783, against a ceiling raised to 760. So the check has been
       * failing ever since it was last edited, by exactly the size of the rule
       * whose name is missing from the paragraph above. It is allowed on the
       * same test as the other: "do not say you are in the cult" is a rule about
       * how to talk, not a fact about who is in one, and a townsman told it
       * learns nothing. 800, which is the measured 783 with room for the next
       * sentence rather than a number pinned to today's byte count.
       *
       * So the number moves and keeps meaning what it meant. It is worth saying
       * what would not be allowed to move it: a board, a roster, a role, or any
       * line that tells the mouth something the seat it speaks for has not been
       * told. If one of those ever makes this fail, the prompt is the thing to
       * change.
       */
      ceiling: 800,
      sections: [{ head: 'rules + intent + four lines', tokens: tokens(mouth), lines: mouth.split('\n').length }]
    }
  ];
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
