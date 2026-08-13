/**
 * Edit distance with adjacent transpositions, capped.
 *
 * Transpositions count as one edit, not two. That is the difference between
 * accepting and rejecting "Afirca" for "Africa", and swapping two neighbouring
 * letters is far and away the most common typing mistake, so treating it as two
 * substitutions would reject the single most likely near-miss in the game. This is
 * the restricted Damerau-Levenshtein distance (optimal string alignment).
 *
 * The cap matters for cost: every submission is compared against every alias of
 * every field, and once the distance exceeds the tolerance the exact value is
 * irrelevant. Bailing out early keeps the quadratic case to near-matches only.
 *
 * Three rows rather than a full matrix, so memory is O(min(a,b)).
 */
export function boundedLevenshtein(a: string, b: string, maxDistance: number): number {
  if (a === b) return 0;
  if (maxDistance <= 0) return 1;

  // Length difference alone already exceeds the budget.
  if (Math.abs(a.length - b.length) > maxDistance) {
    return maxDistance + 1;
  }

  // Keep the shorter string as the row, for the smaller allocation.
  if (a.length > b.length) {
    [a, b] = [b, a];
  }

  if (a.length === 0) return b.length;

  const width = a.length + 1;
  // twoBack is needed for the transposition rule, which reaches back two cells.
  let twoBack = new Array<number>(width).fill(0);
  let previous = new Array<number>(width);
  let current = new Array<number>(width);

  for (let i = 0; i < width; i++) {
    previous[i] = i;
  }

  for (let j = 1; j <= b.length; j++) {
    current[0] = j;
    let rowMinimum = j;

    for (let i = 1; i <= a.length; i++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;

      let value = Math.min(
        (current[i - 1] ?? 0) + 1, // insertion
        (previous[i] ?? 0) + 1, // deletion
        (previous[i - 1] ?? 0) + substitutionCost // substitution
      );

      // Adjacent transposition: the two characters are swapped between the words.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (twoBack[i - 2] ?? 0) + 1);
      }

      current[i] = value;
      if (value < rowMinimum) {
        rowMinimum = value;
      }
    }

    // Every remaining path runs through this row, so nothing can beat its minimum.
    if (rowMinimum > maxDistance) {
      return maxDistance + 1;
    }

    const spare = twoBack;
    twoBack = previous;
    previous = current;
    current = spare;
  }

  return previous[a.length] ?? maxDistance + 1;
}
