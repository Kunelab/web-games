import { normalizeAnswer } from 'game-core';

import { db } from '../db/index.js';
import { blindtestDuplicateDismissals } from '../db/schema.js';
import { listLibrary } from './blindtest-library.js';

/**
 * Possible duplicates in the generated-rounds catalogue.
 *
 * `rememberPlayedRound` already keeps exact repeats out going forward, but the
 * catalogue predates that guard, admin corrections can merge two rows onto one
 * recording afterwards, and typos never matched anything exactly in the first
 * place. So this scans the whole `Tout (généré)` playlist and flags what looks
 * like the same recording twice, for an admin to settle.
 *
 * Three strengths, strongest first:
 *
 *  - `same-video`: the same YouTube upload saved twice. Unambiguous.
 *  - `same-track`: the same normalised artist + title (or work). Catches the
 *    Topic upload and the music video of one song, accents, case and the
 *    "feat." noise `normalizeAnswer` strips.
 *  - `similar`: one side matches and the other is a typo away. Conservative on
 *    purpose — two fields must agree up to a couple of characters — because a
 *    catalogue full of false alarms is one nobody reads.
 *
 * Deliberately not flagged: the same title by two different artists. That is a
 * cover, a different round with a different artist answer, and calling it a
 * duplicate would be wrong rather than cautious.
 */

/** One catalogue entry, reduced to what a comparison needs. */
export interface DuplicateItem {
  id: number;
  /** The YouTube video id, when the payload carries one. */
  code: string | null;
  /** Raw answer values, normalised at comparison time. */
  artist: string;
  title: string;
}

export type DuplicateReason = 'same-video' | 'same-track' | 'similar';

export interface DuplicatePair {
  a: number;
  b: number;
  reason: DuplicateReason;
}

export interface DuplicateGroup {
  reason: DuplicateReason;
  mediaIds: number[];
}

const REASON_RANK: Record<DuplicateReason, number> = { 'same-video': 0, 'same-track': 1, similar: 2 };

/** Stable key for a pair, whatever order the two ids arrive in. */
export function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Edit distance with an early exit.
 *
 * The full matrix is wasted work here: anything past the cap is already "too
 * far", so a row whose minimum exceeds it stops the computation. The catalogue
 * is a few hundred rows and the comparison is pairwise, which is where the
 * budget matters.
 */
export function levenshtein(a: string, b: string, cap: number): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;

  let previous: number[] = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i++) {
    const current: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const next = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      current.push(next);
      if (next < rowMin) rowMin = next;
    }
    if (rowMin > cap) return cap + 1;
    previous = current;
  }

  return previous[b.length] ?? cap + 1;
}

function normalized(item: DuplicateItem): { artist: string; title: string } {
  return { artist: normalizeAnswer(item.artist), title: normalizeAnswer(item.title) };
}

/** The strongest reason two entries look like one recording, if any. */
export function pairReason(left: DuplicateItem, right: DuplicateItem): DuplicateReason | null {
  if (left.id === right.id) return null;

  if (left.code && right.code && left.code === right.code) return 'same-video';

  const a = normalized(left);
  const b = normalized(right);

  if (a.artist && a.artist === b.artist && a.title && a.title === b.title) return 'same-track';
  // A `work` answer has no artist: the normalised work alone is the key, which
  // is exactly what `trackKeyOf` reduces to in that case.
  if (!a.artist && !b.artist && a.title && a.title === b.title) return 'same-track';

  /**
   * One side agrees, the other is a typo away.
   *
   * Length floors keep short strings honest: a one-character title is a
   * different song when the character differs, not a typo, and the same goes
   * for a two-letter artist. The cap of two is absolute rather than scaled —
   * three wrong letters in a song title is a different title until proven
   * otherwise.
   */
  if (a.title && a.title === b.title && a.artist && b.artist) {
    if (a.artist.length >= 3 && levenshtein(a.artist, b.artist, 2) <= 2) return 'similar';
  }
  if (a.artist && a.artist === b.artist && a.title && b.title) {
    if (a.title.length >= 4 && levenshtein(a.title, b.title, 2) <= 2) return 'similar';
  }
  // Two work answers with no artist: same rule on the work alone, with a
  // higher floor since there is only one field to judge by.
  if (!a.artist && !b.artist && a.title && b.title) {
    if (a.title.length >= 6 && levenshtein(a.title, b.title, 2) <= 2) return 'similar';
  }
  // Both fields off by a little (a typo on each side). Kept to one per side:
  // any more and the two rows simply describe different recordings.
  if (a.artist && b.artist && a.title && b.title) {
    if (
      a.artist.length >= 3 &&
      a.title.length >= 4 &&
      levenshtein(a.artist, b.artist, 1) <= 1 &&
      levenshtein(a.title, b.title, 1) <= 1 &&
      (a.artist !== b.artist || a.title !== b.title)
    ) {
      return 'similar';
    }
  }

  return null;
}

/** Every suspicious pair in the list, strongest reason first. */
export function findDuplicatePairs(items: DuplicateItem[]): DuplicatePair[] {
  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const left = items[i];
      const right = items[j];
      if (!left || !right) continue;
      const reason = pairReason(left, right);
      if (reason) pairs.push({ a: left.id, b: right.id, reason });
    }
  }
  return pairs.sort((x, y) => REASON_RANK[x.reason] - REASON_RANK[y.reason]);
}

/**
 * Pairs regrouped for display: entries linked transitively belong together.
 *
 * A chain (A≈B, B≈C) reads as one group of three rather than two overlapping
 * pairs, which is what the admin settles in one go. The group's reason is the
 * strongest of its pairs.
 */
export function groupPairs(pairs: DuplicatePair[]): DuplicateGroup[] {
  const parent = new Map<number, number>();
  const find = (id: number): number => {
    let root = parent.get(id);
    if (root === undefined) {
      parent.set(id, id);
      return id;
    }
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path halving, so a long chain stays flat.
    let node = id;
    while (parent.get(node) !== root) {
      const next = parent.get(node)!;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    parent.set(find(a), find(b));
  };

  for (const pair of pairs) union(pair.a, pair.b);

  const members = new Map<number, number[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    const bucket = members.get(root);
    if (bucket) bucket.push(id);
    else members.set(root, [id]);
  }

  const strongest = new Map<number, DuplicateReason>();
  for (const pair of pairs) {
    const root = find(pair.a);
    const current = strongest.get(root);
    if (!current || REASON_RANK[pair.reason] < REASON_RANK[current]) strongest.set(root, pair.reason);
  }

  const groups: DuplicateGroup[] = [];
  for (const [root, ids] of members) {
    if (ids.length < 2) continue;
    groups.push({ reason: strongest.get(root) ?? 'similar', mediaIds: ids.sort((x, y) => x - y) });
  }
  return groups.sort((x, y) => REASON_RANK[x.reason] - REASON_RANK[y.reason]);
}

function toDuplicateItem(view: {
  id: number;
  answers: { key: string; value: string }[];
  payload: unknown;
}): DuplicateItem {
  const value = (key: string): string => view.answers.find((answer) => answer.key === key)?.value ?? '';
  const payload = (view.payload ?? {}) as { code?: unknown };
  return {
    id: view.id,
    code: typeof payload.code === 'string' && payload.code.length > 0 ? payload.code : null,
    artist: value('artist'),
    title: value('title') || value('work')
  };
}

async function dismissedPairKeys(): Promise<Set<string>> {
  const rows = await db.select().from(blindtestDuplicateDismissals);
  return new Set(rows.map((row) => pairKey(row.media_a, row.media_b)));
}

/**
 * The catalogue's duplicates as they stand, dismissals honoured.
 *
 * For the admin's editing screen: each group is a set of entries to look at
 * together, with the strongest reason found between them.
 */
export async function findLibraryDuplicateGroups(): Promise<DuplicateGroup[]> {
  const items = (await listLibrary()).map(toDuplicateItem);
  const dismissed = await dismissedPairKeys();
  const live = findDuplicatePairs(items).filter((pair) => !dismissed.has(pairKey(pair.a, pair.b)));
  return groupPairs(live);
}

/**
 * Settles every flag raised against one entry: "these are not duplicates".
 *
 * Stores the entry's current pairs, not the entry itself, so a genuinely new
 * collision later still flags — the dismissal settles the comparisons the
 * admin reviewed, and nothing else. Idempotent: re-clearing inserts nothing.
 */
export async function dismissDuplicateFlags(mediaId: number): Promise<number> {
  const items = (await listLibrary()).map(toDuplicateItem);
  if (!items.some((item) => item.id === mediaId)) return 0;

  const pairs = findDuplicatePairs(items).filter((pair) => pair.a === mediaId || pair.b === mediaId);
  for (const pair of pairs) {
    const a = Math.min(pair.a, pair.b);
    const b = Math.max(pair.a, pair.b);
    await db.insert(blindtestDuplicateDismissals).values({ media_a: a, media_b: b }).onConflictDoNothing();
  }
  return pairs.length;
}
