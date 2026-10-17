import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { auditTrace, renderAudit, sameLine, type TraceLine } from './audit.js';

/**
 * A game small enough to read, with one of every fault in it.
 *
 * The lines are lifted from `9RVWV`, where all of these happened to the same
 * person: Max (1), initiated into the lodge, audited to Citizen, then denied his
 * badge and voted by the brothers who had sat with him. The bots are Remy (13,
 * the Mason Leader), Aragorn (24, the dealt Mason) and Diddy Kong (21).
 */
const SEATS = [
  { slot: 1, name: 'Max', bot: false, role: 'lookout' },
  { slot: 13, name: 'Remy', bot: true, role: 'mason-leader' },
  { slot: 21, name: 'Diddy Kong', bot: true, role: 'mass-murderer' },
  { slot: 24, name: 'Aragorn', bot: true, role: 'mason' }
];

function prompt(name: string, slot: number, intent: string, rest: string[]): string {
  return [
    `You are ${name}. Your number at this table is ${slot}. You are dry.`,
    `You have decided to: ${intent}`,
    ...rest,
    'Your line:'
  ].join('\n');
}

function speak(t: number, botId: string, text: string, answer: string): TraceLine {
  return { t, ev: 'llm', task: 'speak', ok: true, ms: 400, botId, prompt: text, answer: { line: answer } };
}

function chat(t: number, slot: number, text: string, channel = 'day', day = 2, phase = 'day'): TraceLine {
  const seat = SEATS.find((entry) => entry.slot === slot)!;
  return { t, ev: 'chat', slot, name: seat.name, bot: seat.bot, channel, text, day, phase };
}

const TRACE: TraceLine[] = [
  { t: 0, ev: 'deal', seats: SEATS },
  { t: 1, ev: 'phase', phase: 'day', day: 1, stage: 'discussion', onTrial: null },
  chat(100, 1, 'Hi', 'day', 1),
  { t: 1000, ev: 'phase', phase: 'night', day: 1, stage: null, onTrial: null },
  // The lodge, with Max in it.
  chat(1100, 13, 'Tonight I knock on Diddy Kong.', 'mason', 1, 'night'),
  chat(1200, 1, 'no', 'mason', 1, 'night'),
  {
    t: 1201,
    ev: 'room-parse',
    room: 'mason',
    slot: 1,
    text: 'no',
    ask: { kind: 'target', slot: 21, who: 'Diddy Kong', fromSlot: 13, human: false },
    spared: [],
    claimed: null
  },
  { t: 1500, ev: 'night-action', slot: 13, name: 'Remy', bot: true, day: 1, phase: 'night', target: 21, second: null },
  { t: 2000, ev: 'phase', phase: 'day', day: 2, stage: 'discussion', onTrial: null },
  chat(2100, 1, 'I still think 21 is weird'),
  // Answered by a seat nobody spoke to, and the context reaches back to day 1.
  speak(
    2400,
    'aragorn',
    prompt('Aragorn', 24, 'ask the room, one last time, whether anybody has anything.', [
      'ANSWER THIS. Somebody just said, to you or about you:',
      'Max: I still think 21 is weird',
      'Reply to what they actually said.',
      'The last things said in the room (context only):',
      'Max: Hi',
      'Max: I still think 21 is weird'
    ]),
    'Diddy Kong, you’re voting for me, what exactly did I do?'
  ),
  chat(2500, 24, 'Diddy Kong, you’re voting for me, what exactly did I do?'),
  // Answered by the seat that was named: not a fault.
  speak(
    2600,
    'diddy',
    prompt('Diddy Kong', 21, 'push back at Max, who is voting for you, and demand they say what you actually did.', [
      'ANSWER THIS. Somebody just said, to you or about you:',
      'Max: I still think 21 is weird'
    ]),
    'Max, name one thing I did.'
  ),
  chat(2700, 21, 'Max, name one thing I did.'),
  // A Mason badge denied, by the brother who sat in the lodge with him.
  speak(
    2800,
    'aragorn',
    prompt('Aragorn', 24, 'say Max is not the Mason, because you are the Mason, and one of you is lying.', []),
    "Max isn't the Mason, I am, so one of us is lying here"
  ),
  chat(2900, 24, "Max isn't the Mason, I am, so one of us is lying here"),
  { t: 3000, ev: 'vote', slot: 24, name: 'Aragorn', bot: true, day: 2, phase: 'day', target: 1 },
  chat(3100, 21, 'Max, you’re the only one who’d ask that stupid question.')
];

describe('the trace audit', () => {
  const game = auditTrace(TRACE, '9RVWV')!;

  it('counts a line answered by a seat nobody spoke to, and not the one that was named', () => {
    assert.deepEqual(
      game.misaddressed.map((row) => row.who),
      ['Aragorn (24)']
    );
  });

  it('counts a counter-claim on a badge the lodge hands out', () => {
    assert.equal(game.counterClaims.length, 1);
  });

  it('counts a former brother denying the badge and voting the seat', () => {
    assert.deepEqual(
      game.teammates.map((row) => row.text),
      ['denies Max (1) the Mason, after the mason room', 'votes Max (1) on day 2, after the mason room']
    );
  });

  it('counts a bare "no" in the lodge that the lodge then ignored', () => {
    assert.equal(game.vetoes.length, 1);
    assert.match(game.vetoes[0].excerpt ?? '', /Diddy Kong \(21\)/);
  });

  it('counts a prompt shown yesterday as context', () => {
    assert.equal(game.stale.length, 1);
  });

  it('counts the wagon lines and the insult aimed at a person', () => {
    assert.deepEqual(game.demand, { lines: 2, of: 4, evidence: game.demand.evidence });
    assert.equal(game.insults.length, 1);
  });

  it('skips a file that is not a game', () => {
    assert.equal(auditTrace([{ t: 0, ev: 'open' }]), null);
  });

  it('renders a row per game', () => {
    const table = renderAudit([game]);
    assert.match(table.split('\n')[1], /^9RVWV\s+Max\s+1\s+1\s+2\s+1\s+1\s+2\/4 50%\s+1$/);
  });

  it('matches a posted line to its answer through the typist', () => {
    assert.ok(
      sameLine(
        'Diddy Kong, you’re voting for me—what exactly did I do?',
        'Diddy Kong, youre voting for me, what exaclty did I do?'
      )
    );
    assert.ok(!sameLine('Max, name one thing I did.', 'Anybody got anything before we toss today?'));
  });
});

/**
 * What the first pass of the audit could not see.
 *
 * A former brother who accuses rather than votes; a family told "Don't kill
 * max" by a person who then knifes Max (`J6D7G`); and replies held in a whisper
 * or a team room, where every line is said to whoever is listening and so
 * cannot be misaddressed.
 */
describe('the trace audit, second pass', () => {
  const seats = [
    { slot: 1, name: 'Max', bot: false, role: 'lookout' },
    { slot: 8, name: 'Xavier', bot: false, role: 'blackmailer' },
    { slot: 13, name: 'Remy', bot: true, role: 'mason-leader' },
    { slot: 14, name: 'Galadriel', bot: true, role: 'godfather' },
    { slot: 24, name: 'Aragorn', bot: true, role: 'mason' }
  ];
  const said = (t: number, slot: number, text: string, channel: string, day = 2, phase = 'day'): TraceLine => {
    const seat = seats.find((entry) => entry.slot === slot)!;
    return { t, ev: 'chat', slot, name: seat.name, bot: seat.bot, channel, text, day, phase };
  };
  const answer = (t: number, botId: string, name: string, slot: number, quoted: string, line: string): TraceLine => ({
    t,
    ev: 'llm',
    task: 'speak',
    ok: true,
    ms: 300,
    botId,
    prompt: [
      `You are ${name}. Your number at this table is ${slot}. You are dry.`,
      'You have decided to: answer them.',
      'ANSWER THIS. This was just said to you:',
      quoted,
      'Your line:'
    ].join('\n'),
    answer: { line }
  });

  const game = auditTrace(
    [
      { t: 0, ev: 'deal', seats },
      { t: 1, ev: 'phase', phase: 'night', day: 1, stage: null, onTrial: null },
      said(100, 13, 'Tonight I bring Max in.', 'mason', 1, 'night'),
      said(150, 24, 'Welcome.', 'mason', 1, 'night'),
      said(160, 1, 'thanks', 'mason', 1, 'night'),
      // The family, told by a person not to touch Max, and a bot saying the same.
      said(200, 8, "Don't kill max", 'mafia', 1, 'night'),
      {
        t: 201,
        ev: 'room-parse',
        room: 'mafia',
        slot: 8,
        text: "Don't kill max",
        ask: null,
        spared: [{ kind: 'spare', slot: 1, who: 'Max', fromSlot: 8, human: true }],
        claimed: null
      },
      {
        t: 900,
        ev: 'night-action',
        slot: 14,
        name: 'Galadriel',
        bot: true,
        day: 1,
        phase: 'night',
        target: 1,
        second: null
      },
      { t: 1000, ev: 'phase', phase: 'day', day: 2, stage: 'discussion', onTrial: null },
      // The brother who sat in the lodge with Max, accusing him without voting.
      {
        t: 1100,
        ev: 'draft',
        botId: 'aragorn',
        slot: 24,
        role: 'mason',
        task: 'day',
        channel: 'day',
        claim: 'accuse',
        about: 1,
        say: 'Max is lying to all of us.'
      },
      said(1101, 24, 'Max is lying to all of us.', 'day'),
      // A whisper and a lodge line answered by the one listening: not misaddressed.
      said(1200, 1, 'what do you think?', 'pm:aragorn:max'),
      answer(1300, 'aragorn', 'Aragorn', 24, 'Max: what do you think?', 'Not sure yet.'),
      said(1301, 24, 'Not sure yet.', 'pm:aragorn:max'),
      said(2000, 1, 'anyone?', 'mason', 2, 'night'),
      answer(2100, 'remy', 'Remy', 13, 'Max: anyone?', 'Here.'),
      said(2101, 13, 'Here.', 'mason', 2, 'night')
    ],
    'SECOND'
  )!;

  it('counts a former brother accusing the seat, not only voting it', () => {
    assert.ok(
      game.teammates.some((row) => /accuses Max \(1\)/.test(row.text)),
      JSON.stringify(game.teammates.map((row) => row.text))
    );
  });

  it('counts a house a person spared by name that the family then hit', () => {
    assert.equal(game.vetoes.length, 1);
    assert.match(game.vetoes[0].excerpt ?? '', /Max \(1\)/);
  });

  it('does not count a reply in a whisper or a team room as misaddressed', () => {
    assert.deepEqual(game.misaddressed, []);
  });
});
