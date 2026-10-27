import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { normalizeAnswer } from 'game-core';

import { db } from '../db/index.js';
import { blindtestDuplicateDismissals, blindtestDuplicateIndex, blindtestDuplicatePairs, media } from '../db/schema.js';
import { listLibrary } from './blindtest-library.js';
import { fetchVideoFacts } from './youtube-service.js';

/**
 * Possible duplicates in the generated-rounds catalogue.
 *
 * `rememberPlayedRound` already keeps exact repeats out going forward, but the
 * catalogue predates that guard, admin corrections can merge two rows onto one
 * recording afterwards, and typos never matched anything exactly in the first
 * place. So this flags what looks like the same recording twice across the
 * whole `Tout (généré)` playlist, for an admin to settle, comparing each entry
 * once rather than every pair on every look (see "the index" below).
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

/**
 * An entry with its answers already normalised.
 *
 * Normalising inside the pairwise loop ran `normalizeAnswer` four times per
 * pair, so a catalogue of two thousand rows paid eight million of them for one
 * look at the flags. Once per entry is all the comparison needs.
 */
interface NormalizedItem {
  id: number;
  code: string | null;
  artist: string;
  title: string;
}

function normalized(item: DuplicateItem): NormalizedItem {
  return { id: item.id, code: item.code, artist: normalizeAnswer(item.artist), title: normalizeAnswer(item.title) };
}

/** The strongest reason two entries look like one recording, if any. */
export function pairReason(left: DuplicateItem, right: DuplicateItem): DuplicateReason | null {
  return normalizedPairReason(normalized(left), normalized(right));
}

function normalizedPairReason(a: NormalizedItem, b: NormalizedItem): DuplicateReason | null {
  if (a.id === b.id) return null;

  if (a.code && b.code && a.code === b.code) return 'same-video';

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
   *
   * The floors apply to the shorter side. Testing only the left one made the
   * verdict depend on argument order: "ABC" against "AB" flagged, "AB" against
   * "ABC" did not.
   */
  const artistFloor = Math.min(a.artist.length, b.artist.length);
  const titleFloor = Math.min(a.title.length, b.title.length);
  if (a.title && a.title === b.title && a.artist && b.artist) {
    if (artistFloor >= 3 && levenshtein(a.artist, b.artist, 2) <= 2) return 'similar';
  }
  if (a.artist && a.artist === b.artist && a.title && b.title) {
    if (titleFloor >= 4 && levenshtein(a.title, b.title, 2) <= 2) return 'similar';
  }
  // Two work answers with no artist: same rule on the work alone, with a
  // higher floor since there is only one field to judge by.
  if (!a.artist && !b.artist && a.title && b.title) {
    if (titleFloor >= 6 && levenshtein(a.title, b.title, 2) <= 2) return 'similar';
  }
  // Both fields off by a little (a typo on each side). Kept to one per side:
  // any more and the two rows simply describe different recordings.
  if (a.artist && b.artist && a.title && b.title) {
    if (
      artistFloor >= 3 &&
      titleFloor >= 4 &&
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
  const prepared = items.map(normalized);
  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      const left = prepared[i];
      const right = prepared[j];
      if (!left || !right) continue;
      const reason = normalizedPairReason(left, right);
      if (reason) pairs.push({ a: left.id, b: right.id, reason });
    }
  }
  return pairs.sort((x, y) => REASON_RANK[x.reason] - REASON_RANK[y.reason]);
}

/**
 * The pairs one entry is part of, compared against the rest only.
 *
 * Settling one row's flags used to rebuild every pair in the catalogue and
 * then keep the handful that mention it: quadratic work for a linear question.
 */
export function findDuplicatePairsFor(targetId: number, items: DuplicateItem[]): DuplicatePair[] {
  const target = items.find((item) => item.id === targetId);
  if (!target) return [];
  return pairsAgainst(normalized(target), items.map(normalized));
}

/** One entry against the rest: the unit of work everything below is made of. */
function pairsAgainst(left: NormalizedItem, others: readonly NormalizedItem[]): DuplicatePair[] {
  const pairs: DuplicatePair[] = [];
  for (const other of others) {
    if (other.id === left.id) continue;
    const reason = normalizedPairReason(left, other);
    if (reason) pairs.push({ a: Math.min(left.id, other.id), b: Math.max(left.id, other.id), reason });
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

export function toDuplicateItem(view: {
  id: number;
  answers: { key: string; value: string }[];
  payload: unknown;
}): DuplicateItem {
  const value = (key: string): string => view.answers.find((answer) => answer.key === key)?.value ?? '';
  return {
    id: view.id,
    code: codeOf(view.payload),
    artist: value('artist'),
    title: value('title') || value('work')
  };
}

/** The YouTube video id a payload carries, if any. */
function codeOf(payload: unknown): string | null {
  const code = ((payload ?? {}) as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

/**
 * The YouTube views an entry's upload had when somebody looked, or null.
 *
 * Read from the fame figures the draw keeps with a round, and written there by
 * `lookUpMissingViews` for the entries kept before it did.
 */
export function viewsOf(payload: unknown): number | null {
  const views = ((payload ?? {}) as { fame?: { views?: unknown } | null }).fame?.views;
  return typeof views === 'number' && Number.isFinite(views) ? views : null;
}

/** The known view counts among these entries, by id. */
function viewCounts(items: readonly { id: number; payload: unknown }[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const item of items) {
    const views = viewsOf(item.payload);
    if (views !== null) counts.set(item.id, views);
  }
  return counts;
}

async function dismissedPairKeys(): Promise<Set<string>> {
  const rows = await db.select().from(blindtestDuplicateDismissals);
  return new Set(rows.map((row) => pairKey(row.media_a, row.media_b)));
}

/* ------------------------------------------------------------ the index */

/**
 * Comparing one entry at a time, and keeping what was found.
 *
 * The flags used to be every pair of the catalogue, recomputed on every look:
 * a few hundred thousand comparisons at a thousand rows, a hundred and twenty
 * five billion at half a million. But a pair's verdict can only change when
 * one of its two entries does, and entries arrive one at a time. So each entry
 * is compared against the rest once, when it is kept, and the pairs it forms
 * are stored; an entry is compared again only if its answers change.
 *
 * Correctness does not rest on every write path remembering to call this.
 * `BlindtestDuplicateIndex` holds the normalised values each entry was compared
 * with, and anything that no longer matches (an entry corrected at a reveal,
 * edited in the media editor, or never indexed at all) is simply compared
 * again the next time the flags are read. The first read after this shipped
 * does the whole catalogue once; every read after it does only what changed.
 */

type IndexRow = typeof blindtestDuplicateIndex.$inferSelect;

function indexMatches(row: IndexRow | undefined, item: NormalizedItem): boolean {
  return Boolean(row && row.code === (item.code ?? '') && row.artist === item.artist && row.title === item.title);
}

function asNormalized(row: IndexRow): NormalizedItem {
  return { id: row.media_id, code: row.code || null, artist: row.artist, title: row.title };
}

/** Replaces one entry's pairs with a fresh comparison, and records what it was compared as. */
function reindex(tx: Tx, item: NormalizedItem, others: readonly NormalizedItem[]): void {
  tx.delete(blindtestDuplicatePairs)
    .where(or(eq(blindtestDuplicatePairs.media_a, item.id), eq(blindtestDuplicatePairs.media_b, item.id)))
    .run();
  for (const pair of pairsAgainst(item, others)) {
    tx.insert(blindtestDuplicatePairs)
      .values({ media_a: pair.a, media_b: pair.b, reason: pair.reason })
      .onConflictDoUpdate({
        target: [blindtestDuplicatePairs.media_a, blindtestDuplicatePairs.media_b],
        set: { reason: pair.reason }
      })
      .run();
  }
  const fields = { code: item.code ?? '', artist: item.artist, title: item.title };
  tx.insert(blindtestDuplicateIndex)
    .values({ media_id: item.id, ...fields })
    .onConflictDoUpdate({ target: blindtestDuplicateIndex.media_id, set: fields })
    .run();
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Brings the stored pairs up to date with the catalogue as it stands.
 *
 * Compares only the entries whose values differ from what they were last
 * compared as, each against the whole current catalogue; forgets the entries
 * that have left it. Returns how many were compared, which is zero on the
 * ordinary read.
 */
export function syncDuplicateIndex(items: readonly DuplicateItem[]): number {
  const prepared = items.map(normalized);
  const indexed = new Map(
    db
      .select()
      .from(blindtestDuplicateIndex)
      .all()
      .map((row) => [row.media_id, row])
  );
  const present = new Set(prepared.map((item) => item.id));

  const stale = prepared.filter((item) => !indexMatches(indexed.get(item.id), item));
  // Taken out of the playlist without being deleted: no longer the catalogue's
  // to flag, and compared afresh if it is ever put back.
  const gone = [...indexed.keys()].filter((mediaId) => !present.has(mediaId));
  if (stale.length === 0 && gone.length === 0) return 0;

  db.transaction((tx) => {
    for (const mediaId of gone) {
      tx.delete(blindtestDuplicatePairs)
        .where(or(eq(blindtestDuplicatePairs.media_a, mediaId), eq(blindtestDuplicatePairs.media_b, mediaId)))
        .run();
      tx.delete(blindtestDuplicateIndex).where(eq(blindtestDuplicateIndex.media_id, mediaId)).run();
    }
    for (const item of stale) reindex(tx, item, prepared);
  });
  return stale.length;
}

/**
 * Compares one newly kept entry against the catalogue, as it is kept.
 *
 * Against the index rather than against the rows, so the cost is one pass over
 * a narrow table of short strings instead of reading and parsing every row.
 * An entry the index does not know yet is not missed: it is compared against
 * everything, this one included, the moment `syncDuplicateIndex` finds it.
 * A no-op for an entry already indexed as it is, which is every call but the
 * first for a round that is kept once and revealed several times.
 */
export function indexCatalogueEntry(view: {
  id: number;
  answers: { key: string; value: string }[];
  payload: unknown;
}): void {
  const item = normalized(toDuplicateItem(view));
  const current = db.select().from(blindtestDuplicateIndex).where(eq(blindtestDuplicateIndex.media_id, item.id)).get();
  if (indexMatches(current, item)) return;

  const others = db.select().from(blindtestDuplicateIndex).all().map(asNormalized);
  db.transaction((tx) => reindex(tx, item, others));
}

/** The stored pairs among these entries, dismissals honoured, strongest first. */
function livePairs(present: ReadonlySet<number>, dismissed: ReadonlySet<string>): DuplicatePair[] {
  return db
    .select()
    .from(blindtestDuplicatePairs)
    .all()
    .filter(
      (row) => present.has(row.media_a) && present.has(row.media_b) && !dismissed.has(pairKey(row.media_a, row.media_b))
    )
    .map((row) => ({ a: row.media_a, b: row.media_b, reason: row.reason as DuplicateReason }))
    .sort((x, y) => REASON_RANK[x.reason] - REASON_RANK[y.reason]);
}

/**
 * The catalogue's duplicates as they stand, dismissals honoured.
 *
 * For the admin's editing screen: each group is a set of entries to look at
 * together, with the strongest reason found between them. The pairs travel as
 * well, because a group is transitive and a dialog is not: in a chain A≈B≈C,
 * A and C may share nothing, and naming C as A's duplicate with the group's
 * headline reason would be a claim no comparison made.
 */
export async function findLibraryDuplicates(): Promise<{
  groups: DuplicateGroup[];
  pairs: DuplicatePair[];
  /** The entries a game leaves out until their flags are settled. See `duplicatesToHide`. */
  hidden: number[];
  /** The copies that exact pairs alone leave out: what `deleteRedundantDuplicates` would delete. */
  redundant: number[];
}> {
  const { ids, live, views } = await settledFlags();
  return {
    groups: groupPairs(live),
    pairs: live,
    hidden: [...duplicatesToHide(ids, live, views)],
    redundant: [...redundantCopies(ids, live, views)]
  };
}

/** The flags brought up to date, dismissals honoured, with the views to choose between twins by. */
async function settledFlags(): Promise<{ ids: number[]; live: DuplicatePair[]; views: Map<number, number> }> {
  const library = await listLibrary();
  const items = library.map(toDuplicateItem);
  syncDuplicateIndex(items);
  const ids = items.map((item) => item.id);
  const live = livePairs(new Set(ids), await dismissedPairKeys());
  const views = viewCounts(library);
  await lookUpMissingViews(library, live, views).catch(() => undefined);
  return { ids, live, views };
}

/**
 * The copies an exact duplicate leaves out of games, and nothing a typo away.
 *
 * The same walk as `duplicatesToHide`, over the same-upload and same-track
 * pairs only. A "similar" pair is a question; these two are answers, and the
 * copy a game already skips for them is the one nobody needs.
 */
function redundantCopies(
  ids: readonly number[],
  pairs: readonly DuplicatePair[],
  views: ReadonlyMap<number, number>
): Set<number> {
  return duplicatesToHide(
    ids,
    pairs.filter((pair) => pair.reason !== 'similar'),
    views
  );
}

/**
 * Deletes the redundant copies at once, every one or those listed. Returns their ids.
 *
 * Worked out again here rather than taken from the client, so what is deleted
 * is what the flags say now, not what they said when the page loaded. The
 * playlist links go with the rows, by the foreign key's cascade, and the pairs
 * and index rows are forgotten at the next read, as for any deletion.
 */
export async function deleteRedundantDuplicates(
  /** Only these, of the redundant copies: the ones the admin left ticked. Anything else sent is ignored. */
  only?: readonly number[]
): Promise<number[]> {
  const { ids, live, views } = await settledFlags();
  const wanted = only && new Set(only);
  const redundant = [...redundantCopies(ids, live, views)].filter((id) => !wanted || wanted.has(id));
  if (redundant.length === 0) return [];
  const deleted = db
    .delete(media)
    .where(and(inArray(media.id, redundant), isNull(media.user_id), eq(media.kind, 'blindtest')))
    .returning({ id: media.id })
    .all();
  return deleted.map((row) => row.id);
}

/**
 * Asks YouTube for the views of the flagged entries kept without them.
 *
 * Most of the catalogue predates the fame figures, so most twins have no count
 * to compare, and a rule that falls back on age for nearly every pair is not
 * the rule. Asked only for entries in a pair, at fifty to a request and one
 * quota unit each, and only once: the count goes into the entry's `fame`, where
 * every game reads it from afterwards. `last_modified` is left alone, since
 * nobody edited the round. A video YouTube no longer returns stays unknown,
 * which is where it belongs: it will not play either.
 *
 * Here rather than in `hiddenDuplicates`, which runs as a game starts and has
 * no business waiting on the network. Fills `views` with what it learns.
 */
async function lookUpMissingViews(
  entries: readonly { id: number; payload: unknown }[],
  pairs: readonly DuplicatePair[],
  views: Map<number, number>
): Promise<void> {
  const flagged = new Set(pairs.flatMap((pair) => [pair.a, pair.b]));
  const missing = new Map<string, number[]>();
  for (const entry of entries) {
    const code = codeOf(entry.payload);
    if (!code || !flagged.has(entry.id) || views.has(entry.id)) continue;
    missing.set(code, [...(missing.get(code) ?? []), entry.id]);
  }
  if (missing.size === 0) return;

  const facts = await fetchVideoFacts([...missing.keys()]);
  db.transaction((tx) => {
    for (const [code, fact] of facts) {
      for (const mediaId of missing.get(code) ?? []) {
        const row = tx.select({ payload: media.payload }).from(media).where(eq(media.id, mediaId)).get();
        if (!row) continue;
        const payload = JSON.parse(row.payload) as Record<string, unknown>;
        // Corrected onto another upload while YouTube was being asked.
        if (codeOf(payload) !== code) continue;
        const fame = { ...((payload.fame ?? {}) as Record<string, unknown>), views: fact.views };
        tx.update(media)
          .set({ payload: JSON.stringify({ ...payload, fame }) })
          .where(eq(media.id, mediaId))
          .run();
        views.set(mediaId, fact.views);
      }
    }
  });
}

/* -------------------------------------------------- hidden until reviewed */

/**
 * Which entries a game leaves out while their duplicate flags are unsettled.
 *
 * A flag waiting for an admin is a song the room may hear twice in one
 * evening, so until somebody has looked, one entry of each is played and its
 * twins are not. Settling the flag either way is what brings an entry back:
 * "these are not duplicates" dismisses the pair, and deleting one removes it.
 * Nothing else is stored.
 *
 * Walked most viewed first, keeping an entry unless it pairs with one already
 * kept. The upload more people have watched is the one a room is likelier to
 * recognise, and usually the official one. An entry whose views nobody looked
 * up comes after every entry whose views are known, and a tie falls back on the
 * oldest, the one rooms have played and admins have corrected. And it is
 * walked over the direct pairs, not the groups: in a chain A≈B≈C where only the
 * neighbours look alike, A and C are both kept, because nothing says C is a
 * second A.
 */
export function duplicatesToHide(
  ids: Iterable<number>,
  pairs: readonly DuplicatePair[],
  views: ReadonlyMap<number, number> = new Map()
): Set<number> {
  const partners = new Map<number, number[]>();
  for (const pair of pairs) {
    partners.set(pair.a, [...(partners.get(pair.a) ?? []), pair.b]);
    partners.set(pair.b, [...(partners.get(pair.b) ?? []), pair.a]);
  }

  const order = [...new Set(ids)].sort((left, right) => {
    const byViews = (views.get(right) ?? -1) - (views.get(left) ?? -1);
    return byViews !== 0 ? byViews : left - right;
  });
  const kept = new Set<number>();
  const hidden = new Set<number>();
  for (const id of order) {
    if ((partners.get(id) ?? []).some((other) => kept.has(other))) hidden.add(id);
    else kept.add(id);
  }
  return hidden;
}

/** What hiding needs of an item: enough to tell a catalogue entry, and to compare it again. */
export interface HideableItem {
  id: number;
  kind: string;
  user_id: number | null;
  answers: { key: string; value: string }[];
  payload: unknown;
}

/**
 * Compares again the catalogue entries among these whose answers changed since
 * they were last compared, before anything is hidden.
 *
 * The flags are otherwise brought up to date only when an admin opens the
 * catalogue, so an entry corrected out of a pair at a reveal sat out every game
 * until then, and one corrected into a pair played on. Unlike
 * `syncDuplicateIndex` this forgets nothing: these may be one playlist's rows,
 * not the whole catalogue.
 */
function refreshIndexFor(items: readonly HideableItem[]): void {
  const entries = items
    .filter((item) => item.user_id === null && item.kind === 'blindtest')
    .map((item) => normalized(toDuplicateItem(item)));
  if (entries.length === 0) return;

  const indexed = new Map(
    db
      .select()
      .from(blindtestDuplicateIndex)
      .all()
      .map((row) => [row.media_id, row])
  );
  const stale = entries.filter((entry) => !indexMatches(indexed.get(entry.id), entry));
  if (stale.length === 0) return;

  const staleIds = new Set(stale.map((entry) => entry.id));
  const others = [...[...indexed.values()].map(asNormalized).filter((entry) => !staleIds.has(entry.id)), ...stale];
  db.transaction((tx) => {
    for (const entry of stale) reindex(tx, entry, others);
  });
}

/** The entries among these that a game leaves out, from the flags compared afresh where they changed. */
export async function hiddenDuplicates(items: readonly HideableItem[]): Promise<Set<number>> {
  const present = new Set(items.map((item) => item.id));
  if (present.size < 2) return new Set();
  refreshIndexFor(items);
  return duplicatesToHide(present, livePairs(present, await dismissedPairKeys()), viewCounts(items));
}

/**
 * These items, less the duplicates a game leaves out.
 *
 * Best-effort: flags that cannot be read are a reason to play a possible twin,
 * never a reason to refuse to start a game.
 */
export async function withoutHiddenDuplicates<T extends HideableItem>(items: readonly T[]): Promise<T[]> {
  const hidden = await hiddenDuplicates(items).catch(() => new Set<number>());
  return hidden.size === 0 ? [...items] : items.filter((item) => !hidden.has(item.id));
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
  syncDuplicateIndex(items);
  const pairs = livePairs(new Set(items.map((item) => item.id)), new Set()).filter(
    (pair) => pair.a === mediaId || pair.b === mediaId
  );
  for (const pair of pairs) {
    await db.insert(blindtestDuplicateDismissals).values({ media_a: pair.a, media_b: pair.b }).onConflictDoNothing();
  }
  return pairs.length;
}
