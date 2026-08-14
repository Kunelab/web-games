import { and, desc, eq, inArray, like, or, type SQL } from 'drizzle-orm';
import {
  answerFieldSchema,
  getMediaKind,
  mediaReadiness,
  resolveTiming,
  timingSchema,
  type AnswerField,
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
 * Rows are parsed defensively.
 *
 * A row can predate a schema change or come from the legacy migration, and one bad
 * row must not take down the whole list endpoint. An unparseable payload degrades
 * to the kind's default and surfaces as not-ready, which is visible in the editor
 * rather than a 500.
 */
export function toMediaView(row: MediaRow): MediaView {
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
    const parsedPayload = definition.payloadSchema.safeParse(payload);
    if (!parsedPayload.success) {
      payload = definition.defaultPayload;
    }
    readiness = mediaReadiness({ kind: row.kind, answers, payload });
    effectiveTiming = resolveTiming({ kind: row.kind, timing, payload });
  } catch {
    readiness = { ready: false, missing: [`type de média inconnu : ${row.kind}`] };
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
}

export const mediaQuerySchema = z.object({
  kind: z.string().max(40).optional(),
  category: z.string().max(80).optional(),
  search: z.string().max(120).optional()
});

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
    await db
      .update(media)
      .set({
        kind: input.kind,
        title: input.title,
        category: input.category ?? null,
        date: input.date ?? null,
        answers: JSON.stringify(input.answers),
        payload: JSON.stringify(input.payload),
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
