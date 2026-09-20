import { eq, sql } from 'drizzle-orm';

import { db } from '../db/index.js';
import {
  gameResults,
  gameSessions,
  images,
  mafiaSessions,
  media,
  playlists,
  sessions,
  users,
  videos,
  zombieSessions
} from '../db/schema.js';

/** What the erasure touched, for the operator to read back. */
export type ErasureReport = Record<string, number>;

/**
 * Erases an account, for an RGPD article 17 request.
 *
 * There is no self-service button, so requests arrive by e-mail and are honoured
 * through `admin delete`. This is what makes the promise on the privacy page
 * real: a right nobody can actually exercise is worse than one never claimed,
 * and deleting an account by hand across thirteen foreign keys is exactly how
 * half of it survives its own deletion.
 *
 * Two different treatments, on purpose:
 *
 *  - What they **made** goes: their media, playlists, and the legacy video and
 *    image rows. It is theirs, and no one else's copy depends on it.
 *  - What they **took part in** stays, with their name taken off it. A finished
 *    game is other players' history too, and erasing one participant should not
 *    delete the evening four other people remember. The host column becomes
 *    null, which is what those columns already allow.
 *
 * Careers are keyed by nickname rather than by account and are deliberately left
 * alone: they belong to whatever name was typed at the join screen, which is not
 * this account and may well be somebody else entirely.
 *
 * Cascades cover the rest. `PlaylistItems` and `ContentPlaylists` go with their
 * playlists; `Cosmetics`, `MafiaTemplates` and `PasswordResets` cascade off the
 * user row; `BugReports.user_id` is set to null by its own constraint, so a
 * report survives as a description of a fault with nobody's name on it.
 *
 * One transaction, so a failure halfway leaves the account intact rather than
 * partly erased.
 */
export function eraseAccount(userId: number): ErasureReport {
  return db.transaction((tx) => {
    const counts: ErasureReport = {};

    counts.media = tx.delete(media).where(eq(media.user_id, userId)).run().changes;
    counts.playlists = tx.delete(playlists).where(eq(playlists.user_id, userId)).run().changes;
    counts.videos = tx.delete(videos).where(eq(videos.user_id, userId)).run().changes;
    counts.images = tx.delete(images).where(eq(images.user_id, userId)).run().changes;

    // Other people's evenings. Kept, anonymised.
    counts.gamesHosted = tx
      .update(gameResults)
      .set({ host_user_id: null })
      .where(eq(gameResults.host_user_id, userId))
      .run().changes;

    for (const [name, table, column] of [
      ['liveQuizzes', gameSessions, gameSessions.host_user_id],
      ['liveRaids', zombieSessions, zombieSessions.host_user_id],
      ['liveTables', mafiaSessions, mafiaSessions.host_user_id]
    ] as const) {
      counts[name] = tx.update(table).set({ host_user_id: null }).where(eq(column, userId)).run().changes;
    }

    // Signed out everywhere, then gone.
    counts.sessions = tx
      .delete(sessions)
      .where(sql`json_extract(${sessions.data}, '$.user.id') = ${userId}`)
      .run().changes;

    tx.delete(users).where(eq(users.id, userId)).run();

    return counts;
  });
}
