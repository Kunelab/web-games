import { pooledFields, type AnswerField } from '../media/answer-field.js';
import { boundedLevenshtein } from './levenshtein.js';
import { normalizeAnswer } from './normalize.js';
import { phoneticFold } from './phonetic.js';

/** Which route accepted the submission, so a host can see why it counted. */
export type MatchRoute = 'exact' | 'number' | 'punctuation' | 'typo' | 'phonetic' | 'partial';

export interface MatchResult {
  matched: boolean;
  /** Which accepted spelling it matched, useful for showing the host why. */
  matchedAgainst?: string;
  /** 1 for an exact normalised hit, lower the more was forgiven. */
  confidence: number;
  /** How it was accepted. Absent on a miss. */
  route?: MatchRoute;
}

const NO_MATCH: MatchResult = { matched: false, confidence: 0 };

/**
 * Confidence is a ranking, not a probability.
 *
 * Its only job is to order candidates: which alias a submission matched, and on a
 * memory panel which of twenty items the player meant. So the routes are laid out
 * in bands, and within the typo band each forgiven edit costs a little. Ranking by
 * edits rather than by a share of the answer's length is deliberate: a long answer
 * should not outrank a short one just for being long.
 */
const CONFIDENCE = {
  exact: 1,
  /** 0.9 for one edit, 0.85 for two, never below the phonetic band. */
  typo: (distance: number) => Math.max(0.8, 0.95 - 0.05 * distance),
  phonetic: 0.78,
  phoneticWithTypo: 0.72,
  partialExact: 0.7,
  partialPhonetic: 0.65,
  partialTypo: 0.6
} as const;

/**
 * Decides whether a player's text counts as the answer.
 *
 * Deliberately generous. In a party game a rejected correct answer is far worse
 * than an accepted near-miss, and the alternative is the host arbitrating every
 * round by hand. Five things are forgiven, in increasing order of cost:
 *
 *  1. Formatting: case, accents, ligatures, punctuation, a leading article,
 *     YouTube noise.
 *  2. Number formatting, when the whole answer is a number.
 *  3. Typos, up to a budget that scales with the answer's length.
 *  4. Phonetic spelling, whatever its edit distance.
 *  5. Partial credit for a multi-word answer, when the player gives a distinctive
 *     enough subset ("Schwarzenegger" for "Arnold Schwarzenegger").
 *
 * Two things are never forgiven, because forgiving them accepts a different
 * answer rather than a badly written one:
 *
 *  - Digits. "1991" is not a near-miss of "1992", and a year is short enough that
 *    a single-edit budget would cover every neighbouring year. Any digit anywhere
 *    in the answer has to be written exactly, so this holds for "Blade Runner
 *    2049" as much as for a bare year.
 *  - Short answers. Below `MIN_FUZZ_LETTERS` letters, one edit is usually the
 *    whole difference between two real answers, so nothing is forgiven beyond
 *    formatting and a phonetic respelling.
 */
export function matchAnswer(submitted: string, field: AnswerField): MatchResult {
  const candidate = normalizeAnswer(submitted);
  if (!candidate) {
    return NO_MATCH;
  }

  const accepted = [field.value, ...field.aliases];
  let best = NO_MATCH;

  for (const raw of accepted) {
    const target = normalizeAnswer(raw);
    if (!target) continue;

    if (candidate === target) {
      return { matched: true, matchedAgainst: raw, confidence: CONFIDENCE.exact, route: 'exact' };
    }

    // "1 000 000" and "1000000" are the same number, however it was typed.
    if (sameNumber(candidate, target)) {
      return { matched: true, matchedAgainst: raw, confidence: CONFIDENCE.exact, route: 'number' };
    }

    // Where the answer ends and the punctuation begins is the host's business, not
    // the player's, so it costs nothing: "ACDC" for "AC/DC", "REM" for "R.E.M.",
    // "Guns and Roses" for "Guns N' Roses", "Simon Garfunkel" for "Simon &
    // Garfunkel". This is formatting, so it is settled before the choices below.
    if (sameLooseForm(candidate, target)) {
      return { matched: true, matchedAgainst: raw, confidence: CONFIDENCE.exact, route: 'punctuation' };
    }

    // A choice-based field is a pick, not a spelling exercise: no fuzz at all.
    if (field.choices?.length) {
      continue;
    }

    best = keepBest(best, fuzzyMatch(candidate, target, field.tolerance), raw);
    best = keepBest(best, matchDistinctiveSubset(candidate, target, field.tolerance), raw);
  }

  return best;
}

/** Everything that is forgiven for a free-text answer, cheapest route first. */
function fuzzyMatch(candidate: string, target: string, tolerance: number): MatchResult {
  if (tolerance <= 0) {
    // The host asked for an exact answer: only formatting is forgiven.
    return NO_MATCH;
  }

  // A wrong number is a wrong answer, so nothing below may run.
  if (digitSignature(candidate) !== digitSignature(target)) {
    return NO_MATCH;
  }

  // A swapped pair is forgiven at any length, including where no budget is: it is
  // the commonest mechanical slip and the commonest dyslexic one, and unlike a
  // wrong letter it cannot turn one answer into another. Digits are already out,
  // so this cannot accept 1919 for 1991.
  if (isOneSwapAway(candidate, target)) {
    return { matched: true, confidence: CONFIDENCE.typo(1), route: 'typo' };
  }

  const budget = typoBudget(target, tolerance);

  const distance = editsWithinBudget(candidate, target, tolerance, budget);
  if (distance !== null) {
    return { matched: true, confidence: CONFIDENCE.typo(distance), route: 'typo' };
  }

  // The phonetic routes run even when the budget is zero: "koi" for "quoi" is not
  // a near-miss that needs a budget, it is the same word written as it sounds.
  const foldedTarget = phoneticFold(target);
  const foldedCandidate = phoneticFold(candidate);

  if (foldedCandidate === foldedTarget) {
    return { matched: true, confidence: CONFIDENCE.phonetic, route: 'phonetic' };
  }

  // Folding preserves the word count, so the same word-by-word budget applies. It
  // is deliberately the budget of the written answer, not of the fold: folding
  // shortens a word, and letting it shorten the allowance too would quietly make
  // this route stricter than the one above it.
  if (editsWithinBudget(foldedCandidate, foldedTarget, tolerance, budget) !== null) {
    return { matched: true, confidence: CONFIDENCE.phoneticWithTypo, route: 'phonetic' };
  }

  return NO_MATCH;
}

/**
 * The edit distance between two answers, or null if it is over budget.
 *
 * Budgeted word by word rather than across the answer as a whole, which is the
 * difference between forgiving a badly typed answer and accepting a different one.
 * "Rage Against The Vaccine" is only two edits from "Rage Against The Machine",
 * and an answer that long is allowed three: spent on one short word those two
 * edits change which word it is, spent one apiece across "Aganst" and "Machin"
 * they are exactly the mistakes this is meant to forgive.
 *
 * The answer-wide budget still caps the total, so a long answer cannot collect one
 * free edit per word indefinitely.
 */
function editsWithinBudget(candidate: string, target: string, tolerance: number, total: number): number | null {
  if (total <= 0) {
    return null;
  }

  const candidateWords = candidate.split(' ');
  const targetWords = target.split(' ');

  // A different word count means a word was added, dropped or run into its
  // neighbour. Word-by-word alignment says nothing useful about that, so the two
  // are compared whole, with the spaces taken out so that the run-together case
  // spends nothing: a missing word still costs its own length, which the budget is
  // never wide enough to cover.
  if (candidateWords.length !== targetWords.length) {
    const distance = boundedLevenshtein(withoutSpaces(candidate), withoutSpaces(target), total);
    return distance <= total ? distance : null;
  }

  let spent = 0;

  for (const [index, word] of targetWords.entries()) {
    const typed = candidateWords[index] ?? '';
    if (typed === word) {
      continue;
    }

    const budget = Math.min(wordBudget(word, tolerance), total - spent);
    if (budget <= 0) {
      return null;
    }

    const distance = boundedLevenshtein(typed, word, budget);
    if (distance > budget) {
      return null;
    }

    spent += distance;
  }

  return spent;
}

/**
 * Edits allowed inside one word of an answer that already has a budget.
 *
 * One is always allowed, however short the word: inside a multi-word answer a
 * short word is not what tells two answers apart, so a missing letter in "O'" or a
 * doubled one in "Piaff" must not fail the whole thing. This floor is safe only
 * because it is unreachable for a short answer: `typoBudget` returns zero for one,
 * and `editsWithinBudget` gives up before it ever gets here.
 */
function wordBudget(word: string, tolerance: number): number {
  return Math.max(1, Math.floor(countLetters(word) * tolerance));
}

/**
 * Whether the two differ by exactly one swap of neighbouring letters.
 *
 * Word by word, and only one word may be affected, so this stays a slip of the
 * fingers rather than a second budget. Cheap enough to run before the matrix.
 */
function isOneSwapAway(candidate: string, target: string): boolean {
  const candidateWords = candidate.split(' ');
  const targetWords = target.split(' ');

  if (candidateWords.length !== targetWords.length) {
    return false;
  }

  let swaps = 0;

  for (const [index, word] of targetWords.entries()) {
    const typed = candidateWords[index] ?? '';
    if (typed === word) {
      continue;
    }
    if (swaps > 0 || !isTransposition(typed, word)) {
      return false;
    }
    swaps += 1;
  }

  return swaps === 1;
}

/** Two adjacent characters exchanged, and nothing else. */
function isTransposition(typed: string, word: string): boolean {
  if (typed.length !== word.length) {
    return false;
  }

  const differing: number[] = [];
  for (let index = 0; index < word.length; index += 1) {
    if (typed[index] !== word[index]) {
      differing.push(index);
      if (differing.length > 2) {
        return false;
      }
    }
  }

  if (differing.length !== 2) {
    return false;
  }

  const [first, second] = differing as [number, number];
  return second === first + 1 && typed[first] === word[second] && typed[second] === word[first];
}

/**
 * How many wrong letters an answer is allowed, in total.
 *
 * Purely proportional, and counted in letters so that neither the spaces of a
 * multi-word answer nor the digits of a year buy room. At the default tolerance
 * that means nothing at all below six letters, one edit from six, two from twelve:
 * a short answer has to be right because at that length one wrong letter is
 * usually a different answer rather than a mistyped one, which is the whole
 * problem with a field like a year. The `loose` preset lowers those thresholds
 * rather than adding a special case for short answers.
 *
 * Zero is not a dead end: an exact match, a swapped pair and a phonetic respelling
 * all bypass this.
 */
export function typoBudget(target: string, tolerance: number): number {
  if (tolerance <= 0) {
    return 0;
  }

  return Math.floor(countLetters(target) * tolerance);
}

/** Letters only: neither the spaces of a multi-word answer nor digits buy room. */
function countLetters(text: string): number {
  return text.replace(/[^a-z]/g, '').length;
}

/**
 * Words that join other words without identifying anything on their own.
 *
 * Dropped from both sides before comparing, which is what lets a player answer
 * "Simon Garfunkel" or "Rage Against Machine". None of them can be the difference
 * between two real answers to the same question, and "n" is here because an
 * apostrophised "Rock 'n' Roll" survives normalisation as a bare n.
 */
const JOINERS = new Set(['and', 'et', 'n', 'the', 'a', 'an', 'le', 'la', 'les', 'l', 'de', 'du', 'des', 'd', 'of']);

/**
 * Whether the two differ only in how they are written.
 *
 * Spacing goes, because whether a name is one word or two is a typographic
 * convention the player never saw: normalisation has already turned "AC/DC" into
 * two words and "R.E.M." into three, and a player who types them closed up is not
 * making a mistake. Joining words go with them, for the same reason.
 *
 * If an answer is nothing but joining words, they are kept: dropping them would
 * compare two empty strings and match everything against everything.
 */
function sameLooseForm(candidate: string, target: string): boolean {
  return looseForm(candidate) === looseForm(target);
}

function looseForm(normalized: string): string {
  const words = normalized.split(' ').filter((word) => !JOINERS.has(word));
  return words.length > 0 ? words.join('') : withoutSpaces(normalized);
}

function withoutSpaces(text: string): string {
  return text.replace(/ /g, '');
}

/** The digits of an answer, run by run, as they have to be written. */
function digitSignature(text: string): string {
  return (text.match(/\d+/g) ?? []).join(' ');
}

/**
 * Whether both sides are the same number written differently.
 *
 * Only when the whole answer is numeric: inside a longer answer a digit run is
 * part of a title and has to be written as the title writes it.
 */
function sameNumber(candidate: string, target: string): boolean {
  const left = candidate.replace(/\s/g, '');
  const right = target.replace(/\s/g, '');

  return /^\d+$/.test(left) && /^\d+$/.test(right) && left === right;
}

/** A final word this long stands for the whole answer: the surname convention. */
const LAST_WORD_MIN_LENGTH = 6;

/** Any word this long is unambiguous wherever it appears. */
const ANY_WORD_MIN_LENGTH = 9;

/**
 * Credit for naming the distinctive part of a multi-word answer.
 *
 * Length alone cannot decide this. "Willis" and "Arnold" are both six letters, yet
 * "Willis" should score for "Bruce Willis" while "Arnold" should not score for
 * "Arnold Schwarzenegger". The difference is position, because western names put
 * the identifying part last. So a final word needs only to be reasonably long,
 * while a word earlier in the answer has to be long enough to be unmistakable on
 * its own. That also keeps "the" and "de" from ever scoring.
 *
 * Every qualifying word is tried, not just the longest: for "Sylvester Stallone"
 * the longest word is the forename, so checking only that would reject the surname,
 * which is precisely what players type. A host who wants some other short form
 * accepted adds it as an alias.
 */
function matchDistinctiveSubset(candidate: string, target: string, tolerance: number): MatchResult {
  const words = target.split(' ');
  if (words.length < 2) {
    return NO_MATCH;
  }

  let best = NO_MATCH;

  words.forEach((word, index) => {
    const isLast = index === words.length - 1;
    const qualifies = isLast ? word.length >= LAST_WORD_MIN_LENGTH : word.length >= ANY_WORD_MIN_LENGTH;

    if (!qualifies) {
      return;
    }

    if (candidate === word) {
      // Real but partial: capped below any full match.
      best = keepBest(best, { matched: true, confidence: CONFIDENCE.partialExact, route: 'partial' });
      return;
    }

    // The same forgiveness as a whole answer, applied to the word: a player who
    // knows the surname should not be failed for misspelling it.
    const fuzzy = fuzzyMatch(candidate, word, tolerance);
    if (fuzzy.matched) {
      const confidence = fuzzy.route === 'phonetic' ? CONFIDENCE.partialPhonetic : CONFIDENCE.partialTypo;
      best = keepBest(best, { matched: true, confidence, route: 'partial' });
    }
  });

  return best;
}

/** Keeps whichever result is stronger, tagging the winner with its spelling. */
function keepBest(best: MatchResult, candidate: MatchResult, matchedAgainst?: string): MatchResult {
  if (!candidate.matched || candidate.confidence <= best.confidence) {
    return best;
  }

  return matchedAgainst === undefined ? candidate : { ...candidate, matchedAgainst };
}

/**
 * Matches one submission against every field it could be an answer to.
 *
 * A player types "Schwarzenegger" and the server works out which of the twenty faces
 * on the panel they meant, or types "1991" on a three-answer film round and has
 * answered the year. Returns the best field they have not already been credited for,
 * so naming the same thing twice cannot score twice.
 *
 * Fields offering choices are never candidates, however well the text matches: those
 * are answered against their own prompt, because that is where the revealed-choices
 * state and the blind-answer bonus live. `pooledFields` is applied here rather than
 * being left to the caller so that no call site can get this wrong.
 */
export function matchAnyField(
  submitted: string,
  fields: AnswerField[],
  alreadyMatchedKeys: ReadonlySet<string>
): { field: AnswerField; result: MatchResult } | null {
  let best: { field: AnswerField; result: MatchResult } | null = null;

  for (const field of pooledFields(fields)) {
    if (alreadyMatchedKeys.has(field.key)) {
      continue;
    }

    const result = matchAnswer(submitted, field);
    if (result.matched && (!best || result.confidence > best.result.confidence)) {
      best = { field, result };
    }
  }

  return best;
}
