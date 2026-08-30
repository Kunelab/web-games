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
  /**
   * A featured artist, and everybody they brought.
   *
   * This used to be `/\bfeat\.?\b|\bft\.?\b/`, which had two faults. The
   * trailing `\b` cannot match between a full stop and a space — both are
   * non-word — so the engine backtracked, matched the bare `ft`, and left the
   * orphaned dot behind: "Despacito ft. Daddy Yankee" came out of the lookup as
   * *"Despacito . Daddy Yankee"*, and that is what landed in the answer field.
   *
   * And removing the word was never the point. The answer to a blind test is
   * "Despacito", not "Despacito Daddy Yankee" — the guest belongs with the
   * artist, not in the title. So the whole clause goes.
   *
   * Bounded rather than run to the end of the string, because the credit is not
   * always last: "Calvin Harris ft. Rihanna - This Is What You Came For" puts it
   * on the *artist* side, and eating to the end would take the song with it.
   * Stopping at the next separator keeps both shapes right.
   */
  /\s*\b(?:feat|ft|featuring|avec)\b\.?\s*[^-–—|[\]()]*/gi,
  /** "M/V" and "MV": a music-video marker two thirds of K-pop titles carry. */
  /\b(?:m\/v|mv)\b/gi,
  /**
   * Content markers, matched only when they are the whole parenthesis.
   *
   * Deliberately stricter than the patterns above, which allow anything after
   * the keyword. "(Official Video)" can safely swallow its own brackets because
   * no band is called "Official"; "(Clean)" cannot, because Clean Bandit exists
   * and `\(clean[^)]*\)` would quietly delete them from their own song.
   *
   * So this alternation has to reach the closing bracket itself, with at most
   * one trailing noun. It catches "(Explicit)", "(Radio Edit)", "(Album
   * Version)" — the labels a distributor adds and nobody is expected to type —
   * and leaves anything longer alone.
   *
   * Worth more than tidiness: `normalizeAnswer` runs these too, so a stored
   * answer of "The Bad Touch (Explicit)" and a player typing "The Bad Touch"
   * now reduce to the same thing and score. Before, the bracket was part of the
   * answer and the player was simply wrong.
   */
  /\s*[([](?:explicit|clean|radio|album|single|original|extended|visuali[sz]er|restored)(?:\s+(?:edit|version|mix|master|cut))?[)\]]/gi
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
/**
 * Labels people use when they write down what the music was.
 *
 * Kept narrow on purpose. A generic "by" or a bare dash anywhere in a
 * description would find a hundred false positives; a line that *begins* with
 * one of these is somebody deliberately crediting a track, which is a much
 * stronger signal than anything a title can offer.
 */
const CREDIT_LABEL = /^\s*(?:music|musique|song|track|chanson|titre|bgm|audio)\s*[:\-–—]\s*(.+)$/i;
const ARTIST_LABEL = /^\s*(?:artist|artiste|band|groupe|by)\s*[:\-–—]\s*(.+)$/i;
const TITLE_LABEL = /^\s*(?:title|titre|song|track|morceau)\s*[:\-–—]\s*(.+)$/i;

/**
 * What the description says the music was.
 *
 * Some videos are not *about* their music: an AMV, a montage, a compilation, a
 * gameplay clip. Their titles describe the video — "AMV - Nostromo - Pure
 * Thrust" is an editor and an edit — and no amount of splitting on dashes will
 * ever recover the song, because the song is not in the string. It is in the
 * description, written out by hand, in a form people have converged on:
 *
 *     Music: Yuksek – Tonight
 *     Artist: Yuksek
 *     Song: Tonight
 *
 * So this reads that instead. It is preferred over the title when it is found,
 * which is the right precedence: a credit is a statement, a title is a guess.
 *
 * Only the opening of the description, because past the first few lines you are
 * into tracklists, links and thanks — and a compilation's twentieth track is
 * not what this video is.
 */
export function creditFromDescription(description: string): { artist: string; title: string } | null {
  const lines = description.split(/\r?\n/).slice(0, 12);

  // One line carrying both, which is the common shape.
  for (const line of lines) {
    const whole = CREDIT_LABEL.exec(line)?.[1];
    if (!whole) continue;
    const split = splitArtistTitle(whole);
    if (split.artist && split.title) return split;
    // "Music: Tonight" alone names a track and no performer; not enough.
  }

  // Or two lines, each carrying half.
  let artist = '';
  let title = '';
  for (const line of lines) {
    if (!artist) artist = ARTIST_LABEL.exec(line)?.[1]?.trim() ?? '';
    if (!title) title = TITLE_LABEL.exec(line)?.[1]?.trim() ?? '';
  }
  if (artist && title) return { artist, title };

  return null;
}

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
