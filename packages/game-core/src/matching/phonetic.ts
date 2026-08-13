/**
 * A rough phonetic form of an answer, for the mistakes that are not typos.
 *
 * Edit distance assumes a wrong letter is an accident of the fingers. Most wrong
 * spellings are not: someone writes down what the word sounds like. "Rhapsody"
 * becomes "rapsodie", "physique" becomes "fizik", "Schwarzenegger" becomes
 * "Shwartzenegger". Each of those is several edits away from the answer, so no
 * typo budget wide enough to accept them is narrow enough to still reject a
 * genuinely different answer.
 *
 * Folding both sides to a common approximation of how they sound solves that
 * without widening the budget: the spellings collapse onto each other and the
 * comparison stays exact. This matters most for dyslexic players, whose errors are
 * overwhelmingly phonetic rather than mechanical, and it costs nothing for anyone
 * else because it only runs after an exact and a near-exact comparison have both
 * failed.
 *
 * Deliberately cruder than Soundex or Metaphone, and deliberately bilingual: the
 * rules only cover the French and English spellings that actually disagree about
 * the same sound. Vowel identity is kept, because dropping it (as Soundex does)
 * would make "Titanic" and "Totonic" the same word and turn every panel of
 * similar answers into a coin toss.
 */

/**
 * Uppercase letters are used as private markers for sounds that have no single
 * letter, which is safe because the input is always the lowercase output of
 * `normalizeAnswer`.
 */
const SIBILANT = 'S';

/** Applied in order: each rule assumes the ones above it have already run. */
const RULES: Array<[RegExp, string]> = [
  // Before the h is deleted further down, since here it is not silent.
  [/ph/g, 'f'],
  // ch, sh and sch are the same sound to a French ear, and the one English
  // spelling of it that French keeps ("chat" vs "shot") is the commonest swap.
  [/sch|sh|ch/g, SIBILANT],
  // Every way of writing a hard k.
  [/ck|qu|q|k/g, 'k'],
  // Soft c before a front vowel, hard c everywhere else.
  [/c(?=[eiy])/g, 's'],
  [/c/g, 'k'],
  [/x/g, 'ks'],
  // y is a vowel in both languages and players pick either spelling.
  [/y/g, 'i'],
  [/z/g, 's'],
  // Whatever h is left is silent in French and inaudible in English.
  [/h/g, ''],
  // Doubled letters are the single most common French spelling doubt
  // ("adresse"/"address", "traffic"/"trafic"), and they are never heard.
  [/(.)\1+/g, '$1']
];

/** French drops these at the end of a word, so players type them or not. */
const SILENT_ENDING = /[es]$/;

/** Below this a trailing letter is most of the word, not an ending. */
const MIN_LENGTH_FOR_ENDING_RULES = 4;

/**
 * Strips the endings that are not pronounced, as many as there are.
 *
 * Repeatedly, because collapsing a double leaves another ending behind and
 * stopping after one would defeat the point: "address" folds to "adres" and
 * "adresse" to "adrese", which only meet once both have been stripped bare.
 */
function stripSilentEndings(word: string): string {
  let stripped = word;

  while (stripped.length >= MIN_LENGTH_FOR_ENDING_RULES && SILENT_ENDING.test(stripped)) {
    stripped = stripped.slice(0, -1);
  }

  return stripped;
}

/**
 * Folds one already-normalised word.
 *
 * A word containing a digit is returned untouched: numbers are not spelled, and
 * treating "1991" as a sound would make it comparable to "1891".
 */
function foldWord(word: string): string {
  if (/\d/.test(word)) {
    return word;
  }

  let folded = word;
  for (const [pattern, replacement] of RULES) {
    folded = folded.replace(pattern, replacement);
  }

  return stripSilentEndings(folded);
}

/**
 * Folds an answer that has already been through `normalizeAnswer`.
 *
 * Word by word, so the ending rules apply where an ending actually is.
 */
export function phoneticFold(normalized: string): string {
  if (!normalized) {
    return '';
  }

  return normalized.split(' ').map(foldWord).join(' ');
}
