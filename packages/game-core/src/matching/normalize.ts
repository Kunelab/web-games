/**
 * Words that carry no identifying weight at the start of a title, so
 * "The Beatles" matches "Beatles" and "Les Rita Mitsouko" matches
 * "Rita Mitsouko".
 */
const LEADING_ARTICLES = new Set(['the', 'a', 'an', 'le', 'la', 'les', 'l', 'un', 'une', 'der', 'die', 'das', 'el']);

/**
 * Trailing noise YouTube titles are full of. Stripped so an authored answer of
 * "Africa" still matches what a player saw on screen.
 */
const NOISE_PATTERNS = [
  /\((?:official|officiel)[^)]*\)/gi,
  /\[(?:official|officiel)[^\]]*\]/gi,
  /\((?:lyrics?|paroles?|audio|hd|hq|4k|remaster(?:ed)?|live|clip)[^)]*\)/gi,
  /\[(?:lyrics?|paroles?|audio|hd|hq|4k|remaster(?:ed)?|live|clip)[^\]]*\]/gi,
  /\b(?:official\s+(?:music\s+)?video|clip\s+officiel|music\s+video)\b/gi,
  /\bfeat\.?\b|\bft\.?\b/gi
];

/** Combining diacritical marks, left after an NFD decomposition. */
const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Letters no decomposition splits, so they have to be spelled out by hand.
 *
 * Without this the punctuation rule below turns them into separators: "cœur"
 * became "c ur" and stopped matching the "coeur" a player types, which is not a
 * rare case in a French song title.
 */
const LIGATURES: Array<[RegExp, string]> = [
  [/œ/g, 'oe'],
  [/æ/g, 'ae'],
  [/ß/g, 'ss'],
  [/ø/g, 'o'],
  [/[ðđ]/g, 'd'],
  [/þ/g, 'th'],
  [/ł/g, 'l'],
  [/ı/g, 'i']
];

/**
 * Punctuation standing in for a letter, as some acts spell their own names.
 *
 * Only between two letters, which is what tells "P!nk" and "Ke$ha" apart from the
 * "Wham!" whose exclamation mark really is punctuation and has to keep falling
 * through to the separator rule below.
 */
const STYLISED_LETTERS: Array<[RegExp, string]> = [
  [/(?<=[a-z])!(?=[a-z])/g, 'i'],
  [/(?<=[a-z])\$(?=[a-z])/g, 's']
];

/**
 * Collapses a written answer to a comparable form.
 *
 * Accents are folded rather than stripped so "Beyoncé" and "Beyonce" agree, and
 * punctuation is dropped entirely so "Don't" matches "dont" and, once the
 * ampersand rule has run, "Guns N' Roses" matches "Guns and Roses".
 */
export function normalizeAnswer(input: string): string {
  let text = input.toLowerCase();

  for (const pattern of NOISE_PATTERNS) {
    text = text.replace(pattern, ' ');
  }

  text = text.normalize('NFD').replace(COMBINING_MARKS, '');

  for (const [pattern, replacement] of [...LIGATURES, ...STYLISED_LETTERS]) {
    text = text.replace(pattern, replacement);
  }

  text = text
    // Spell out the symbols people type inconsistently.
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' and ')
    // Apostrophes are deleted rather than spaced, so a player who types "dont"
    // still matches an authored "Don't". Spacing them would split the word and
    // leave the two forms too far apart for the typo budget to bridge.
    .replace(/['‘’ʼ`]/g, '')
    // Everything else becomes a separator.
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = text.split(' ').filter(Boolean);

  // Only a leading article is dropped; "the" inside a title is meaningful.
  if (words.length > 1 && words[0] && LEADING_ARTICLES.has(words[0])) {
    words.shift();
  }

  return words.join(' ');
}

/**
 * Splits a YouTube title into artist and track.
 *
 * Heuristic by nature: the overwhelming convention is "Artist - Title", so that
 * is what this handles, and the caller keeps both fields editable.
 */
export function splitArtistTitle(youtubeTitle: string): { artist: string; title: string } {
  let text = youtubeTitle;

  for (const pattern of NOISE_PATTERNS) {
    text = text.replace(pattern, ' ');
  }
  text = text.replace(/\s+/g, ' ').trim();

  // Hyphen, en dash, em dash, and the vertical bar some channels use.
  const separator = /\s+[-–—|]\s+/;
  const match = separator.exec(text);

  if (!match || match.index === 0) {
    return { artist: '', title: text };
  }

  const artist = text.slice(0, match.index).trim();
  const title = text.slice(match.index + match[0].length).trim();

  // A split that leaves either side empty is worse than no split at all.
  if (!artist || !title) {
    return { artist: '', title: text };
  }

  return { artist, title };
}
