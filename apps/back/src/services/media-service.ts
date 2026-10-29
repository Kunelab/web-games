import { and, desc, eq, inArray, isNull, like, not, or, type SQL } from 'drizzle-orm';
import {
  answerFieldSchema,
  getMediaKind,
  mediaReadiness,
  resolveTiming,
  timingSchema,
  withHandEdits,
  type AnswerField,
  type BlindtestPayload,
  type KindTiming,
  type MediaInput,
  type Readiness
} from 'game-core';
import { z } from 'zod';

import { db } from '../db/index.js';
import { media, playlistItems, type MediaRow } from '../db/schema.js';
import type { SessionUser } from '../types/fastify.js';
import { copyName } from './copy-name.js';
import { ownerFilter } from './ownership.js';

/**
 * A media item with its JSON columns parsed and its readiness computed.
 *
 * The API always returns this shape rather than the raw row, so no client ever has
 * to know that `answers`, `payload` and `timing` are stored as text.
 */
export interface MediaView {
  id: number;
  user_id: number | null;
  kind: string;
  title: string;
  category: string | null;
  date: string | null;
  answers: AnswerField[];
  payload: unknown;
  timing: KindTiming | null;
  /** Timing actually in force: the item's overrides on the kind's defaults. */
  effectiveTiming: KindTiming;
  readiness: Readiness;
  created_at: string | null;
  last_modified: string | null;
}

const answersSchema = z.array(answerFieldSchema);

/**
 * Rows already parsed, by id, each beside the row it was parsed from.
 *
 * Every look at the shared catalogue parsed every one of its rows through
 * Zod: the playlists list, the launch screen, the endless mode's counts, each
 * of them a hundred milliseconds of a single-threaded server at ten thousand
 * rounds, spent re-checking rows that had not changed since the last look.
 *
 * Kept by content, not by date: a cached view is used only when every column
 * of the row read now is identical to the one it was parsed from, so a row
 * written by any path at all, with or without touching `last_modified`, is
 * parsed afresh. Comparing a row's strings costs microseconds; parsing it is
 * what cost the time.
 */
const parsedRows = new Map<number, { row: MediaRow; columns: number; view: MediaView }>();

/**
 * How many parsed rows to keep before starting over.
 *
 * Well above the catalogue's size, so a full read of it stays cached, and low
 * enough that the map cannot grow without end on a server that keeps running.
 */
const MAX_PARSED_ROWS = 60_000;

/**
 * A media row as the API returns it, parsed once per version of the row.
 *
 * Each caller gets its own copy. Views are changed after they are handed out
 * (a session relabels its round's answers, a correction rewrites a payload),
 * and a change made to the cached object would reach every later reader of
 * the row. Copying plain JSON is a tenth of the cost of parsing it.
 */
export function toMediaView(row: MediaRow): MediaView {
  const cached = parsedRows.get(row.id);
  if (cached && sameRow(cached, row)) return copied(cached.view);

  const view = parseRow(row);
  if (parsedRows.size >= MAX_PARSED_ROWS) parsedRows.clear();
  parsedRows.set(row.id, { row: { ...row }, columns: Object.keys(row).length, view });
  return copied(view);
}

// Plain loops in the two below: they run once per row and per value on every
// read, and the iterator forms measured several times slower here.

function sameRow(cached: { row: MediaRow; columns: number }, row: MediaRow): boolean {
  let columns = 0;
  for (const key in row) {
    columns += 1;
    if (cached.row[key as keyof MediaRow] !== row[key as keyof MediaRow]) return false;
  }
  return columns === cached.columns;
}

/** A deep copy of parsed JSON: plain objects, arrays and primitives only. */
function copied<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const copy: unknown[] = new Array(value.length);
    for (let index = 0; index < value.length; index++) copy[index] = copied(value[index]);
    return copy as T;
  }
  const copy: Record<string, unknown> = {};
  for (const key in value) copy[key] = copied((value as Record<string, unknown>)[key]);
  return copy as T;
}

/**
 * Rows are parsed defensively.
 *
 * A row can predate a schema change or come from the legacy migration, and one bad
 * row must not take down the whole list endpoint. An unparseable payload degrades
 * to the kind's default and surfaces as not-ready, which is visible in the editor
 * rather than a 500.
 */
function parseRow(row: MediaRow): MediaView {
  let answers: AnswerField[] = [];
  const parsedAnswers = answersSchema.safeParse(safeJson(row.answers));
  if (parsedAnswers.success) {
    answers = parsedAnswers.data;
  }

  let payload: unknown = safeJson(row.payload);
  let timing: KindTiming | null = null;

  if (row.timing) {
    const parsedTiming = timingSchema.safeParse(safeJson(row.timing));
    if (parsedTiming.success) {
      timing = parsedTiming.data;
    }
  }

  // An unknown kind would throw from getMediaKind; report it as unplayable
  // instead, so a single stale row cannot break the library screen.
  let readiness: Readiness;
  let effectiveTiming: KindTiming;
  try {
    const definition = getMediaKind(row.kind);
    /**
     * The parsed payload replaces the stored one, rather than only being tested.
     *
     * This used to parse and throw the result away, which is how a schema
     * default became a field that was declared, ignored, and then rendered as an
     * empty box: a blind test saved before it had a volume has no volume in its
     * row, and only the parse puts the 100 there. Zod strips unknown keys, which
     * is the same thing a save does, so nothing is lost that a save would keep.
     */
    const parsedPayload = definition.payloadSchema.safeParse(payload);
    payload = parsedPayload.success ? parsedPayload.data : definition.defaultPayload;
    readiness = mediaReadiness({ kind: row.kind, answers, payload });
    effectiveTiming = resolveTiming({ kind: row.kind, timing, payload });
  } catch {
    readiness = { ready: false, missing: ['miss.unknownKind'] };
    effectiveTiming = { answerMs: 30_000, revealMs: 10_000 };
  }

  return {
    id: row.id,
    user_id: row.user_id,
    kind: row.kind,
    title: row.title,
    category: row.category,
    date: row.date,
    answers,
    payload,
    timing,
    effectiveTiming,
    readiness,
    created_at: row.created_at,
    last_modified: row.last_modified
  };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export interface MediaQuery {
  kind?: string;
  category?: string;
  search?: string;
  /** What to do with the rows the endless blind test generated. See `generatedRows`. */
  generated?: 'include' | 'exclude' | 'only';
}

export const mediaQuerySchema = z.object({
  kind: z.string().max(40).optional(),
  category: z.string().max(80).optional(),
  search: z.string().max(120).optional(),
  generated: z.enum(['include', 'exclude', 'only']).optional()
});

/**
 * The rows the endless blind test generated: ownerless blind tests.
 *
 * The same test `blindtest-library` reads its catalogue with, and for the same
 * reason: nobody owns those rows, which is the whole of their permission model.
 * Only an admin's library lists them at all, and there they arrive by the
 * thousand, so this is what lets the admin set them aside or look at nothing else.
 */
function generatedRows(): SQL | undefined {
  return and(isNull(media.user_id), eq(media.kind, 'blindtest'));
}

export const mediaService = {
  async list(user: SessionUser, query: MediaQuery = {}): Promise<MediaView[]> {
    const filters: (SQL | undefined)[] = [ownerFilter(media.user_id, user)];

    if (query.kind) {
      filters.push(eq(media.kind, query.kind));
    }
    if (query.category) {
      filters.push(eq(media.category, query.category));
    }
    if (query.search) {
      // Escaped so a literal % or _ in the search box is not a wildcard.
      const needle = `%${query.search.replace(/[%_\\]/g, (match) => `\\${match}`)}%`;
      filters.push(or(like(media.title, needle), like(media.category, needle)));
    }
    if (query.generated === 'exclude') {
      const generated = generatedRows();
      if (generated) filters.push(not(generated));
    } else if (query.generated === 'only') {
      filters.push(generatedRows());
    }

    const rows = await db
      .select()
      .from(media)
      .where(and(...filters))
      .orderBy(desc(media.id));

    return rows.map(toMediaView);
  },

  async getById(id: number, user: SessionUser): Promise<MediaView | undefined> {
    const [row] = await db
      .select()
      .from(media)
      .where(and(eq(media.id, id), ownerFilter(media.user_id, user)))
      .limit(1);
    return row ? toMediaView(row) : undefined;
  },

  /** Raw rows for a set of ids, used by the game engine which needs answers. */
  async getManyByIds(ids: number[]): Promise<MediaView[]> {
    if (ids.length === 0) return [];
    const rows = await db.select().from(media).where(inArray(media.id, ids));
    return rows.map(toMediaView);
  },

  /** Distinct categories the user has used, for the filter dropdown. */
  async categories(user: SessionUser): Promise<string[]> {
    const rows = await db
      .selectDistinct({ category: media.category })
      .from(media)
      .where(ownerFilter(media.user_id, user));

    return rows
      .map((row) => row.category)
      .filter((category): category is string => Boolean(category))
      .sort((a, b) => a.localeCompare(b, 'fr'));
  },

  async create(input: MediaInput, user: SessionUser): Promise<MediaView> {
    const [row] = await db
      .insert(media)
      .values({
        user_id: user.id,
        kind: input.kind,
        title: input.title,
        category: input.category ?? null,
        date: input.date ?? null,
        answers: JSON.stringify(input.answers),
        payload: JSON.stringify(input.payload),
        timing: input.timing ? JSON.stringify(input.timing) : null
      })
      .returning();

    if (!row) {
      throw new Error('media insert returned no row');
    }
    return toMediaView(row);
  },

  /** Bulk create, used by the YouTube playlist import. */
  async createMany(inputs: MediaInput[], user: SessionUser): Promise<MediaView[]> {
    if (inputs.length === 0) return [];

    const rows = await db
      .insert(media)
      .values(
        inputs.map((input) => ({
          user_id: user.id,
          kind: input.kind,
          title: input.title,
          category: input.category ?? null,
          date: input.date ?? null,
          answers: JSON.stringify(input.answers),
          payload: JSON.stringify(input.payload),
          timing: input.timing ? JSON.stringify(input.timing) : null
        }))
      )
      .returning();

    return rows.map(toMediaView);
  },

  /**
   * Copies an item into the caller's library.
   *
   * The copy is owned by whoever asked for it, not by the original's owner, which
   * is what makes this safe for an admin duplicating someone else's item. Only the
   * authored content travels: the new row gets its own id and timestamps, and its
   * playlist memberships are deliberately not copied, since a duplicate is made to
   * be changed and would otherwise silently join every game the original is in.
   */
  async duplicate(id: number, user: SessionUser): Promise<MediaView | undefined> {
    const source = await this.getById(id, user);
    if (!source) {
      return undefined;
    }

    const existing = await db.select({ title: media.title }).from(media).where(ownerFilter(media.user_id, user));

    return this.create(
      {
        kind: source.kind,
        title: copyName(
          source.title,
          existing.map((row) => row.title)
        ),
        category: source.category,
        date: source.date,
        answers: source.answers,
        payload: source.payload,
        timing: source.timing
      },
      user
    );
  },

  async update(id: number, input: MediaInput, user: SessionUser): Promise<MediaView | undefined> {
    /**
     * A blind test's difficulty or clip moved by hand is marked as a person's,
     * so the rescoring leaves it alone. See `withHandEdits`.
     */
    let payload = input.payload;
    if (input.kind === 'blindtest') {
      const [current] = await db
        .select({ kind: media.kind, payload: media.payload })
        .from(media)
        .where(and(eq(media.id, id), ownerFilter(media.user_id, user)))
        .limit(1);
      if (current?.kind === 'blindtest') {
        payload = withHandEdits(safeJson(current.payload), input.payload as BlindtestPayload);
      }
    }

    await db
      .update(media)
      .set({
        kind: input.kind,
        title: input.title,
        category: input.category ?? null,
        date: input.date ?? null,
        answers: JSON.stringify(input.answers),
        payload: JSON.stringify(payload),
        timing: input.timing ? JSON.stringify(input.timing) : null,
        last_modified: new Date().toISOString()
      })
      .where(and(eq(media.id, id), ownerFilter(media.user_id, user)));

    return this.getById(id, user);
  },

  async remove(id: number, user: SessionUser): Promise<boolean> {
    // PlaylistItems cascades on the foreign key, so unlike the old polymorphic
    // join table there is nothing to clean up by hand.
    return db.transaction((tx) => {
      const result = tx
        .delete(media)
        .where(and(eq(media.id, id), ownerFilter(media.user_id, user)))
        .run();
      return result.changes > 0;
    });
  },

  /** How many playlists reference an item, so the UI can warn before deleting. */
  async usageCount(id: number): Promise<number> {
    const rows = await db.select().from(playlistItems).where(eq(playlistItems.media_id, id));
    return rows.length;
  }
};
