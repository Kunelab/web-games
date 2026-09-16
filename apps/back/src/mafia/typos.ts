import type { Locale } from 'i18n';

/**
 * The fingerprints of somebody typing fast.
 *
 * Every other line in the square comes from a person with a keyboard, and
 * people miss keys. A table where the eleven bots are the only seats with
 * flawless spelling is a table where you can pick them out without reading a
 * word they say — the tell is not what they argue, it is that they never once
 * write "thier". So a small share of what a bot says arrives slightly wrong.
 *
 * Two kinds, because people make two kinds:
 *
 *  - a **slip**, which is the hand rather than the head: two letters swapped, a
 *    letter dropped, a letter held down too long. Only on words long enough for
 *    it to read as a typo rather than as a different word;
 *  - a **swap**, which is the head rather than the hand: their/there,
 *    your/you're, a/à, ou/où. The mistakes a person makes *knowing better*, and
 *    the ones that actually look human.
 *
 * At most one per line, roughly one line in ten, and never both — a sentence
 * with two mistakes in it reads as a broken generator rather than as haste.
 *
 * ## What it must never touch
 *
 * A name and a house number are the load-bearing parts of everything said here:
 * "I was at Baloo" and "I was at Balo" are the same sentence to a reader and
 * two different accusations to somebody checking the roster, and a slipped
 * digit turns an alibi into a different alibi. So anything the caller passes in
 * `protect`, and anything containing a digit, is left exactly as written. The
 * mistake goes on the prose, where the worst it can cost is a second reading.
 *
 * Deterministic in `seed`, so the same line from the same seat on the same day
 * fumbles the same way however many times it is rendered.
 */

/** Share of lines that get a wrong-word swap. */
const SWAP_RATE = 0.05;
/** Share of the rest that get a keyboard slip. */
const SLIP_RATE = 0.05;
/** Below this, a dropped letter makes a different word rather than a typo. */
const MIN_SLIP_LENGTH = 6;
/** Below this, a line is too short for a mistake to read as haste. */
const MIN_LINE_WORDS = 4;

/**
 * The words people type instead of the ones they mean.
 *
 * Deliberately one-way per entry rather than a symmetric pair list: "to" → "too"
 * is a mistake a person makes, and firing it on every "to" in a sentence would
 * be a different thing entirely, which is why only one occurrence is ever
 * touched. Written lower case and matched case-insensitively; the replacement
 * takes the case of what it replaces.
 */
const SWAPS: Record<Locale, readonly (readonly [string, string])[]> = {
  en: [
    ['their', 'there'],
    ['there', 'their'],
    ['they’re', 'their'],
    ['your', 'you’re'],
    ['you’re', 'your'],
    ['to', 'too'],
    ['too', 'to'],
    ['its', 'it’s'],
    ['it’s', 'its'],
    ['then', 'than'],
    ['than', 'then'],
    ['lose', 'loose'],
    ['were', 'we’re'],
    ['whose', 'who’s'],
    ['who’s', 'whose']
  ],
  fr: [
    ['a', 'à'],
    ['à', 'a'],
    ['ou', 'où'],
    ['où', 'ou'],
    ['ces', 'ses'],
    ['ses', 'ces'],
    ['on', 'ont'],
    ['ont', 'on'],
    ['et', 'est'],
    ['est', 'et'],
    ['sa', 'ça'],
    ['ça', 'sa'],
    ['la', 'là'],
    ['là', 'la'],
    ['ma', 'm’a'],
    ['se', 'ce'],
    ['ce', 'se'],
    ['leur', 'leurs'],
    ['quand', 'quant'],
    ['tous', 'tout']
  ]
};

/**
 * Both apostrophes are the same apostrophe.
 *
 * The catalogues are typeset with `’` and a person typing into the chat box
 * produces `'`, so a swap table written one way would only ever fire on half
 * the lines it should.
 */
const flat = (word: string): string => word.replace(/['’]/g, '’').toLowerCase();

const SWAP_INDEX: Record<Locale, Map<string, string>> = {
  en: new Map(SWAPS.en.map(([from, to]) => [flat(from), to])),
  fr: new Map(SWAPS.fr.map(([from, to]) => [flat(from), to]))
};

/**
 * Turns names into the form `fumble` protects them by.
 *
 * Callers hold phrases — "Han Solo", "Serial Killer" — and this pass works one
 * word at a time, so a two-word name with only one word protected would still
 * come out mangled half the time. Kept here rather than at the call site so the
 * normalising rule (case, both apostrophes) has exactly one definition.
 */
export function protectedWords(phrases: Iterable<string>): Set<string> {
  const words = new Set<string>();
  for (const phrase of phrases) {
    for (const word of phrase.split(/[\s-]+/)) {
      if (word) words.add(flat(word.replace(/[^\p{L}\p{M}’']/gu, '')));
    }
  }
  words.delete('');
  return words;
}

/* -------------------------- how one seat punctuates ------------------------ */

/**
 * Whether this seat bothers with a full stop at the end of a line.
 *
 * Nobody types "Morning." into a chat box. Some people type "Morning", some
 * type "morning", and a few do punctuate properly — and which one you are is a
 * fixed habit, not a per-message choice, which is exactly what made every bot
 * line identifiable at a glance: they all ended in a tidy full stop, every
 * time, and no human table has ever looked like that.
 *
 * So it is decided once per seat and never varies. Roughly half the table
 * punctuates. Only a trailing full stop is ever dropped: a question mark and an
 * exclamation mark are the reason somebody reached for punctuation in the first
 * place, and an ellipsis is a deliberate silence. Internal stops stay, which is
 * how people actually type — the sentence break is information, the final one
 * is ceremony.
 */
export function punctuates(seed: string): boolean {
  const roll = rng('stop:' + seed);
  return roll() < 0.45;
}

/** Strips the ceremonial full stop, for a seat that does not type them. */
export function unpunctuated(text: string): string {
  return text.endsWith('.') && !text.endsWith('..') ? text.slice(0, -1) : text;
}

/** A small deterministic generator, so one seed gives one sequence. */
function rng(seed: string): () => number {
  let state = 0;
  for (let i = 0; i < seed.length; i++) state = (state * 31 + seed.charCodeAt(i)) >>> 0;
  state = (state ^ 0x9e3779b9) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Letters only, so punctuation and digits never become part of a word. */
const WORDS = /[\p{L}\p{M}’']+/gu;

interface Token {
  text: string;
  start: number;
}

function tokens(text: string, protect: ReadonlySet<string>): Token[] {
  const found: Token[] = [];
  for (const match of text.matchAll(WORDS)) {
    const word = match[0];
    if (match.index === undefined) continue;
    // A name is the one thing in the sentence that has to survive intact.
    if (protect.has(flat(word))) continue;
    found.push({ text: word, start: match.index });
  }
  return found;
}

/** Keeps the replacement wearing the case the original word had. */
function likewise(original: string, replacement: string): string {
  if (original[0] && original[0] === original[0].toUpperCase() && original[0] !== original[0].toLowerCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/** One word typed wrong: swapped letters, a dropped one, or a doubled one. */
function slipped(word: string, roll: () => number): string | null {
  // The first letter stays: a person's hand slips inside a word, not at the
  // start of it, and leaving it alone keeps capitalisation honest for free.
  const at = 1 + Math.floor(roll() * (word.length - 2));
  const kind = Math.floor(roll() * 3);
  if (kind === 0) {
    if (at + 1 >= word.length) return null;
    return word.slice(0, at) + word[at + 1] + word[at] + word.slice(at + 2);
  }
  if (kind === 1) return word.slice(0, at) + word.slice(at + 1);
  return word.slice(0, at) + word[at] + word.slice(at);
}

/**
 * One line, as it would come out of somebody typing it in a hurry.
 *
 * `protect` holds whatever must survive untouched, lower cased — the names at
 * the table, in practice. Words containing a digit are protected without being
 * asked, because a house number is never worth mistyping.
 */
export function fumble(text: string, tongue: Locale, seed: string, protect: ReadonlySet<string> = new Set()): string {
  const roll = rng(seed);

  const words = tokens(text, protect).filter((token) => !/\d/.test(token.text));
  /**
   * A line of three words or fewer is left alone.
   *
   * "Mornnig." is not a person typing fast, it is a person with one word to say
   * getting it wrong, and it reads as a glitch rather than as haste. A typo
   * needs a sentence around it to look like one.
   */
  if (words.length < MIN_LINE_WORDS) return text;

  /* --------------------------- the head's mistake -------------------------- */
  if (roll() < SWAP_RATE) {
    const table = SWAP_INDEX[tongue] ?? SWAP_INDEX.en;
    const candidates = words.filter((token) => table.has(flat(token.text)));
    const chosen = candidates[Math.floor(roll() * candidates.length)];
    if (chosen) {
      const replacement = table.get(flat(chosen.text));
      if (replacement) {
        return (
          text.slice(0, chosen.start) +
          likewise(chosen.text, replacement) +
          text.slice(chosen.start + chosen.text.length)
        );
      }
    }
  }

  /* --------------------------- the hand's mistake -------------------------- */
  if (roll() < SLIP_RATE) {
    /**
     * Never inside a word with an apostrophe in it.
     *
     * French is built out of them — "qu'est", "l'encens", "j'étais" — and a
     * transposition that lands on one produces "q'uest", which does not read as
     * somebody typing fast. It reads as text that has been through something.
     * An apostrophe is a deliberate keystroke; the slips here are the ones the
     * hand makes on a run of letters. Those words are still eligible for a
     * wrong-word swap, which is where they belong anyway.
     */
    const candidates = words.filter((token) => token.text.length >= MIN_SLIP_LENGTH && !/['’]/.test(token.text));
    const chosen = candidates[Math.floor(roll() * candidates.length)];
    if (chosen) {
      const broken = slipped(chosen.text, roll);
      if (broken && broken !== chosen.text) {
        return text.slice(0, chosen.start) + broken + text.slice(chosen.start + chosen.text.length);
      }
    }
  }

  return text;
}
