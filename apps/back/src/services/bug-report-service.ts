import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../db/index.js';
import { bugReports, type BugReportRow } from '../db/schema.js';
import type { SessionUser } from '../types/fastify.js';

/**
 * The areas a report can be filed against.
 *
 * A closed list rather than free text, because the first thing the operator does
 * with a report is decide whether it is about the quiz engine, a game, or the
 * library screens, and a field people type into answers that question in forty
 * different spellings. The frontend renders these as a select and the server
 * refuses anything else, so the two cannot drift.
 */
export const BUG_AREAS = ['quiz', 'blindtest', 'coronaz', 'mafia', 'library', 'account', 'other'] as const;

export const bugReportSchema = z.object({
  area: z.enum(BUG_AREAS),
  /**
   * Long enough to say something, short enough not to be a payload.
   *
   * Ten characters is not a quality bar, it is a way of catching the empty
   * submit. Four thousand is roughly two pages, which is more than anybody has
   * ever needed to describe a bug and well under what would make the table a
   * place to store things.
   */
  message: z.string().trim().min(10, 'Décrivez le problème en quelques mots').max(4000),
  /** Where they were when it happened. Sent by the form, never guessed. */
  page: z.string().max(512).optional(),
  /** The join code, when the report is about a game in progress. */
  gameCode: z.string().max(16).optional()
});

export type BugReportInput = z.infer<typeof bugReportSchema>;

/** What the operator's listing shows. The same row, named for reading. */
export interface BugReportView {
  id: number;
  login: string | null;
  area: string;
  message: string;
  page: string | null;
  userAgent: string | null;
  gameCode: string | null;
  status: string;
  createdAt: string | null;
}

function toView(row: BugReportRow): BugReportView {
  return {
    id: row.id,
    login: row.login,
    area: row.area,
    message: row.message,
    page: row.page,
    userAgent: row.user_agent,
    gameCode: row.game_code,
    status: row.status,
    createdAt: row.created_at
  };
}

export const bugReportService = {
  /**
   * Files a report.
   *
   * The user is optional because the commonest moment to hit a bug is in the
   * middle of a game, and a player who joined with a nickname has no account at
   * all. Refusing those would lose exactly the reports that are hardest to
   * reproduce afterwards.
   *
   * The user agent comes from the request header rather than from the body: it
   * is the one piece of context that is genuinely useful for a rendering or
   * playback bug, and the one a reporter cannot be expected to know.
   */
  async create(
    input: BugReportInput,
    context: { user: SessionUser | null; userAgent: string | undefined }
  ): Promise<number> {
    const [row] = await db
      .insert(bugReports)
      .values({
        user_id: context.user?.id ?? null,
        login: context.user?.login ?? null,
        area: input.area,
        message: input.message,
        page: input.page ?? null,
        user_agent: context.userAgent?.slice(0, 512) ?? null,
        game_code: input.gameCode ?? null
      })
      .returning();

    if (!row) {
      throw new Error('bug report insert returned no row');
    }
    return row.id;
  },

  /** Newest first, which is the order anybody triaging actually wants. */
  async list(status?: string): Promise<BugReportView[]> {
    const rows = status
      ? await db.select().from(bugReports).where(eq(bugReports.status, status)).orderBy(desc(bugReports.id))
      : await db.select().from(bugReports).orderBy(desc(bugReports.id));

    return rows.map(toView);
  },

  async setStatus(id: number, status: 'new' | 'seen' | 'closed'): Promise<boolean> {
    const result = await db.update(bugReports).set({ status }).where(eq(bugReports.id, id));
    return result.changes > 0;
  },

  /**
   * Deletes a report for good.
   *
   * Present because a report is free text somebody else wrote, and the answer to
   * "please remove what I sent you" has to be something better than editing the
   * database by hand. See the erasure right on the privacy page.
   */
  async remove(id: number): Promise<boolean> {
    const result = await db.delete(bugReports).where(eq(bugReports.id, id));
    return result.changes > 0;
  }
};
