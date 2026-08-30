import type { Catalogue } from '../index.js';

/**
 * The quizzes, in English: what the five question types are, how a point is
 * earned, and the screens that build and open a room.
 *
 * A question's *content* is never in here. The whole point of the library is
 * that somebody writes their own questions in their own words, and those words
 * are theirs in every language.
 */
export const quizEn: Catalogue = {
  /* --------------------------- the five question types ---------------------- */
  'quiz.kind.blindtest': 'Blind test',
  'quiz.kind.quiz': 'Question',
  'quiz.kind.estimation': 'Estimate',
  'quiz.kind.image-reveal': 'Picture',
  'quiz.kind.image-memory': 'Panel',

  'quiz.kind.blindtest.about':
    'A clip plays, you name the title and the artist. Each field is its own race: getting the artist first scores, even if somebody else had the title before you.',
  'quiz.kind.quiz.about':
    'A question, with or without options. Answering blind, without asking for the choices, scores more.',
  'quiz.kind.estimation.about':
    'A question with a number for an answer. Everybody puts one forward, closest wins, and the gap decides the rest.',
  'quiz.kind.image-reveal.about':
    'A pixelated image sharpens second by second. The first to recognise it takes the maximum.',
  'quiz.kind.image-memory.about':
    'A panel to memorise for a few seconds, then to recite. Each cell is a race of its own.',

  /* --------------------------------- the guide ------------------------------ */
  'quiz.guide.title': 'Quiz — rules and question types',
  'quiz.guide.lede': 'Five ways to make somebody guess something, one scoring system.',
  'quiz.guide.flow': 'How it goes',
  'quiz.guide.flow.1':
    'A quiz is a run of questions. In an organised game somebody opens a room, picks the quiz and opens the game screen; the others join with a code or a QR. In a **quick match** there is no organiser: the quiz is rolled, the table votes to change it, and every phone is both the stage and the buzzer.',
  'quiz.guide.flow.2':
    'A quiz its author marked **public** can be played by anyone — it is also the pool quick matches draw from.',
  'quiz.guide.scoring': 'How the score works',
  'quiz.guide.scoring.1':
    'Every answer is its own race. Three things go into the total: **the place you took** on that answer, which counts for most; **the time left** on the clock; and **your time against everyone else who got it**, which rewards whoever knew when the question was hard for the whole room.',
  'quiz.guide.scoring.2':
    'Network lag is compensated: what counts is when you pressed, not when your message arrived. Points have decimals, and that is normal.',
  'quiz.guide.scoring.3':
    'Two optional bonuses, set when the room opens. **Combo** multiplies the points of rounds won back to back, up to ×2. **Catch-up** gives up to ×1.5 to the bottom third of the standings, if it is genuinely adrift.',
  'quiz.guide.kinds': 'The question types',
  'quiz.guide.tokens': 'Tokens',
  'quiz.guide.tokens.1':
    'Every point scored is worth a token, credited at the end of the game. Tokens buy nothing but appearances: nothing on sale changes a game.',
  'quiz.guide.back': '← Back to the Quiz menu',

  /* ----------------------------- opening a room ----------------------------- */
  'quiz.create.title': 'Open a room',
  'quiz.create.lede':
    'Pick the quiz to play. The next screen sets the game up — order, clock, points — and decides whether the room is public or private.',
  'quiz.create.mine': 'My quizzes',
  'quiz.create.mineEmpty': 'You have no quiz yet. A quiz is a group of questions.',
  'quiz.create.makeOne': 'Build a quiz',
  'quiz.create.public': 'Public quizzes',
  'quiz.create.publicEmpty': 'Nobody has published a quiz yet.',
  'quiz.create.untitled': 'Untitled',
  'quiz.create.playable': '{count} playable questions',
  'quiz.create.by': '· by {login}',
  'quiz.create.publicBadge': 'Public',

  /* ------------------------------- the Mafia guide -------------------------- */
  'mafia.guide.title': 'Mafia — roles and rules',
  'mafia.guide.lede':
    'A town falls asleep every night and wakes up one body short. Somebody around the table knows why.',
  'mafia.guide.idea': 'The idea',
  'mafia.guide.idea.1':
    'The town is the majority and blind: it does not know who is who. The mafia is the minority and can see — its members know each other, and kill once a night. The town wins by hanging the last of the guilty; the mafia wins the day it equals the town.',
  'mafia.guide.idea.2':
    'Between the two live the **neutrals**, who each have their own victory condition and help nobody for free.',
  'mafia.guide.cycle': 'A day, a night',
  'mafia.guide.cycle.day':
    '**By day**, everybody talks and the town puts somebody on the stand. The accused defends themselves, then the town votes guilty or not. Three trials a day at most.',
  'mafia.guide.cycle.night':
    '**By night**, every role acts in silence: the mafia picks its victim, the doctor picks who to protect, the sheriff probes somebody. It all resolves at once, and in the morning the town sees the result without knowing what produced it.',
  'mafia.guide.cycle.reveal':
    'What a body gives away — its whole role, its camp only, or nothing at all — is a table setting. The middle one is the interesting one: it keeps the shape of the game while giving the Coroner something to do.',
  'mafia.guide.roleCount': '{count} roles',
  'mafia.guide.unique': 'One per table at most.',
  'mafia.guide.back': '← Back to the Mafia menu'
};

export default quizEn;
