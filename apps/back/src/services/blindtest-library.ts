import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';

import { db } from '../db/index.js';
import { media, playlistItems, playlists } from '../db/schema.js';
import { toMediaView, type MediaView } from './media-service.js';

/**
 * The library the endless blind test writes into.
 *
 * Generated rounds used to exist only inside one session's state: drawn from a
 * pool, played once, and gone the moment the game was swept. Every one of them had
 * cost a YouTube search, a facts lookup and a share of a model call to work out
 * what the video actually was, and all of that was thrown away nightly.
 *
 * So a round that was genuinely played is kept. Two things follow from that and
 * both are the point:
 *
 *  - it can be corrected. A model's reading of a title is right most of the time
 *    and wrong some of the time, and until now a wrong answer was unfixable
 *    because there was nothing to fix — the round did not exist anywhere by the
 *    time anybody noticed. A row can be edited.
 *  - it accumulates. The playlist below grows by whatever the room played, so an
 *    evening of endless mode leaves a catalogue behind rather than only a
 *    scoreboard, and that catalogue is public: anybody can play it.
 *
 * ## Only what was played
 *
 * Deliberately not everything the model annotated. A pool fill annotates hundreds
 * of candidates per genre and a session plays a few dozen, so saving the pool
 * would fill the table with thousands of rows nobody has ever heard, most of them
 * never to be played and none of them checked by a human. A round that reached a
 * room is one a room can vouch for, which is exactly the property that makes the
 * catalogue worth curating rather than worth ignoring.
 *
 * ## Who owns it
 *
 * Nobody, and that is load-bearing. Both the playlist and its rows are written
 * with a null `user_id`, and every ownership test in this codebase is
 * `user_id = :me` — which no number ever matches against null. So a member can
 * see the playlist (it is public) and play it, and can edit neither it nor
 * anything in it. `ownerFilter` drops the restriction entirely for an admin, so
 * an admin can do both. That is the whole of the permission model and it needed
 * no new column.
 */

/** The name the shared catalogue is created under, and found again by. */
export const EVERYTHING_PLAYLIST_NAME = 'Tout (généré)';

/** Which field of a blind test payload identifies the recording. */
function videoCodeOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const code = (payload as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

/**
 * The shared playlist's id, created on first use.
 *
 * Looked up by name among the ownerless public playlists rather than kept in a
 * settings table: there is exactly one of these, it is identified by what it is,
 * and a config row to point at it would be a second thing that can be wrong.
 */
async function everythingPlaylistId(): Promise<number> {
  const [existing] = await db
    .select({ id: playlists.id })
    .from(playlists)
    .where(and(isNull(playlists.user_id), eq(playlists.name, EVERYTHING_PLAYLIST_NAME)))
    .limit(1);

  if (existing) return existing.id;

  const [created] = await db
    .insert(playlists)
    .values({ user_id: null, name: EVERYTHING_PLAYLIST_NAME, type: 'default', public: true })
    .returning({ id: playlists.id });

  if (!created) throw new Error('could not create the generated-rounds playlist');
  return created.id;
}

/**
 * Keeps a generated round, once.
 *
 * Deduplicated on the video code rather than on the title or the answers, because
 * the same recording is drawn under a different ephemeral id in every session that
 * plays it, and because the answers are the very thing that may be corrected later
 * — matching on them would let a fixed row be shadowed by a fresh wrong one the
 * next time the track came round.
 *
 * Returns the library row, existing or new, so the caller can tell the screens
 * which entry the round in front of them belongs to.
 */
export async function rememberPlayedRound(item: MediaView): Promise<MediaView | null> {
  const code = videoCodeOf(item.payload);
  if (item.kind !== 'blindtest' || !code) return null;

  /**
   * Library rows only, which is what the null owner selects for.
   *
   * Without it a host who had saved this very track into their own library by
   * hand would have their row found here, and the round would be filed against
   * something they own and can edit — quietly making one person's private item
   * the public catalogue's entry for that song.
   */
  const [existing] = await db
    .select()
    .from(media)
    .where(
      and(
        isNull(media.user_id),
        eq(media.kind, 'blindtest'),
        sql`json_extract(${media.payload}, '$.code') = ${code}`
      )
    )
    .limit(1);

  if (existing) return toMediaView(existing);

  const [row] = await db
    .insert(media)
    .values({
      user_id: null,
      kind: item.kind,
      title: item.title,
      category: item.category,
      date: item.date,
      answers: JSON.stringify(item.answers),
      payload: JSON.stringify(item.payload),
      timing: item.timing ? JSON.stringify(item.timing) : null
    })
    .returning();

  if (!row) return null;

  const playlistId = await everythingPlaylistId();
  const [last] = await db
    .select({ order_num: playlistItems.order_num })
    .from(playlistItems)
    .where(eq(playlistItems.playlist_id, playlistId))
    .orderBy(desc(playlistItems.order_num))
    .limit(1);

  await db
    .insert(playlistItems)
    .values({ playlist_id: playlistId, media_id: row.id, order_num: (last?.order_num ?? -1) + 1 })
    .onConflictDoNothing();

  return toMediaView(row);
}

/**
 * Throws away the library's entry for a recording.
 *
 * The room is the only thing that can tell a good round from a plausible-looking
 * wrong one, and it can only tell at the reveal — which is a moment that used to
 * pass with nowhere to put the observation. The link in the playlist goes with the
 * row, by the foreign key's cascade.
 *
 * Deleting rather than flagging: the catalogue's value is that everything in it
 * can be played, and a row kept under suspicion is a round that will be dealt to
 * somebody else before anybody gets round to judging it. What was learned is not
 * lost either way — the pool will offer the track again, and whoever keeps it the
 * next time can correct it instead.
 */
export async function purgeLibraryRound(code: string): Promise<boolean> {
  const rows = await db
    .delete(media)
    .where(
      and(
        isNull(media.user_id),
        eq(media.kind, 'blindtest'),
        sql`json_extract(${media.payload}, '$.code') = ${code}`
      )
    )
    .returning({ id: media.id });

  return rows.length > 0;
}

/** The catalogue as it stands, oldest first. For the admin's editing screen. */
export async function listLibrary(): Promise<MediaView[]> {
  const playlistId = await everythingPlaylistId();

  const rows = await db
    .select({ row: media })
    .from(playlistItems)
    .innerJoin(media, eq(media.id, playlistItems.media_id))
    .where(eq(playlistItems.playlist_id, playlistId))
    .orderBy(asc(playlistItems.order_num));

  return rows.map((entry) => toMediaView(entry.row));
}
