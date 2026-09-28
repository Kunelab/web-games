import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../db/index.js';
import { media, playlistItems, playlists, users, type Playlist } from '../db/schema.js';
import { EVERYTHING_PLAYLIST_NAME } from './blindtest-library.js';
import { copyName } from './copy-name.js';
import { toMediaView, type MediaView } from './media-service.js';
import type { SessionUser } from '../types/fastify.js';
import { definedOnly, hasUpdates, ownerFilter } from './ownership.js';

/**
 * The most media ids one playlist request may carry.
 *
 * It was five hundred, which no hand-built quiz reaches and the generated-rounds
 * catalogue passes in a few weeks: past it the catalogue could no longer be
 * saved from the editor at all, which is the moment it most needs curating. Set
 * well past anything the catalogue will grow to, so the cap is a guard against
 * a runaway request rather than a size the catalogue can hit.
 */
export const MAX_PLAYLIST_ITEMS = 500_000;

/**
 * The body a request carrying that many ids needs.
 *
 * Fastify refuses anything over 1 MiB by default, and 500,000 ids of up to seven
 * digits are three and a half megabytes, twice that with `baseMediaIds` beside
 * them. Without this the cap above would be unreachable: the request would be
 * turned away as too large before it was ever validated.
 */
export const PLAYLIST_BODY_LIMIT = 16 * 1024 * 1024;

export const playlistInputSchema = z.object({
  name: z.string().min(1, 'Le nom est requis').max(200),
  public: z.boolean().optional(),
  /** Media ids in play order. Absent leaves the contents untouched. */
  mediaIds: z.array(z.coerce.number().int().positive()).max(MAX_PLAYLIST_ITEMS).optional(),
  /**
   * The contents the editor started from, when it sends new ones.
   *
   * Saving replaces the contents, and the catalogue gains rows while an admin
   * has it open: every round a room plays is filed into it. Without this, a
   * save dropped whatever had arrived since the page loaded. With it, anything
   * the editor never saw is kept, after what it sent.
   */
  baseMediaIds: z.array(z.coerce.number().int().positive()).max(MAX_PLAYLIST_ITEMS).optional()
});

export type PlaylistInput = z.infer<typeof playlistInputSchema>;

export interface PlaylistView {
  id: number;
  user_id: number | null;
  name: string | null;
  public: boolean | null;
  created_at: string | null;
  last_modified: string | null;
  owner: { id: number; login: string | null } | null;
  items: MediaView[];
  /** Counts by kind, so the list can show what a playlist is made of. */
  kindCounts: Record<string, number>;
  /** Items that cannot be played yet. Zero means the playlist is ready. */
  notReadyCount: number;
}

/**
 * Loads playlists with their contents.
 *
 * Four flat queries and an in-memory stitch. The polymorphic version needed a
 * multi-way join per media type plus a merge, and duplicated every playlist row
 * once per item; one media table makes it a single `inArray` lookup.
 */
async function attachItems(rows: Playlist[]): Promise<PlaylistView[]> {
  if (rows.length === 0) {
    return [];
  }

  const playlistIds = rows.map((row) => row.id);
  const ownerIds = [...new Set(rows.map((row) => row.user_id).filter((id): id is number => id !== null))];

  const [links, owners] = await Promise.all([
    db
      .select()
      .from(playlistItems)
      .where(inArray(playlistItems.playlist_id, playlistIds))
      .orderBy(asc(playlistItems.order_num)),
    ownerIds.length > 0
      ? db.select({ id: users.id, login: users.login }).from(users).where(inArray(users.id, ownerIds))
      : Promise.resolve([])
  ]);

  /**
   * By subquery, not by the list of ids.
   *
   * The ids themselves were bound one value each, and SQLite caps a statement
   * at a few tens of thousands: the public generated-rounds catalogue is in
   * every member's playlist listing, so the day it outgrew that, the playlists
   * page would have failed for everybody. The subquery binds only the playlist
   * ids, which are a handful.
   */
  const mediaRows =
    links.length > 0
      ? await db
          .select()
          .from(media)
          .where(
            inArray(
              media.id,
              db
                .select({ id: playlistItems.media_id })
                .from(playlistItems)
                .where(inArray(playlistItems.playlist_id, playlistIds))
            )
          )
      : [];

  const mediaById = new Map(mediaRows.map((row) => [row.id, toMediaView(row)]));
  const ownerById = new Map(owners.map((owner) => [owner.id, owner]));

  const itemsByPlaylist = new Map<number, MediaView[]>();
  for (const link of links) {
    const item = mediaById.get(link.media_id);
    if (!item) continue;

    const bucket = itemsByPlaylist.get(link.playlist_id);
    if (bucket) {
      bucket.push(item);
    } else {
      itemsByPlaylist.set(link.playlist_id, [item]);
    }
  }

  return rows.map((row) => {
    const items = itemsByPlaylist.get(row.id) ?? [];
    const kindCounts: Record<string, number> = {};
    let notReadyCount = 0;

    for (const item of items) {
      kindCounts[item.kind] = (kindCounts[item.kind] ?? 0) + 1;
      if (!item.readiness.ready) {
        notReadyCount += 1;
      }
    }

    return {
      id: row.id,
      user_id: row.user_id,
      name: row.name,
      public: row.public,
      created_at: row.created_at,
      last_modified: row.last_modified,
      owner: row.user_id !== null ? (ownerById.get(row.user_id) ?? null) : null,
      items,
      kindCounts,
      notReadyCount
    };
  });
}

/** Visible to its owner, and to anyone if marked public. */
function visibleTo(userId: number) {
  return or(eq(playlists.user_id, userId), eq(playlists.public, true));
}

export const playlistService = {
  async list(userId: number): Promise<PlaylistView[]> {
    const rows = await db.select().from(playlists).where(visibleTo(userId));
    return attachItems(rows);
  },

  async getById(id: number, userId: number): Promise<PlaylistView | undefined> {
    const rows = await db
      .select()
      .from(playlists)
      .where(and(eq(playlists.id, id), visibleTo(userId)))
      .limit(1);
    const [view] = await attachItems(rows);
    return view;
  },

  /**
   * The published shelf: public playlists with something playable in them.
   *
   * This is what a quick match draws from, and the readiness filter is the whole
   * point of it — a hostless room that rolls a playlist of three broken YouTube
   * links has no host to notice and no way to recover. Contents come back with it
   * because the caller needs the count and the owner, not because it needs the
   * items; `getById` is still the way to actually play one.
   */
  async listPublic(): Promise<PlaylistView[]> {
    const rows = await db.select().from(playlists).where(eq(playlists.public, true));
    const views = await attachItems(rows);
    return views.filter((view) => view.items.length - view.notReadyCount > 0);
  },

  /**
   * May this account change this playlist? Separate from visibility: public does
   * not mean editable.
   *
   * `ownerFilter` rather than a bare owner test, so an admin may edit any of them.
   * That is what makes the shared generated-rounds catalogue maintainable at all:
   * it is written with no owner, so no member's id matches it and no member can
   * touch it, and without the admin widening here nobody could correct it either.
   */
  /**
   * Whether this is the shared generated-rounds catalogue.
   *
   * The endless blind test finds it by name (see `everythingPlaylistId`), so
   * renaming it or deleting it does not retire it: the next round played
   * creates a fresh, empty one, and every row already kept falls out of the
   * catalogue's duplicate and genre checks with no way back in.
   */
  async isCatalogue(id: number): Promise<boolean> {
    const [row] = await db
      .select({ user_id: playlists.user_id, name: playlists.name })
      .from(playlists)
      .where(eq(playlists.id, id))
      .limit(1);
    return Boolean(row && row.user_id === null && row.name === EVERYTHING_PLAYLIST_NAME);
  },

  async mayEdit(id: number, user: SessionUser): Promise<boolean> {
    const [row] = await db
      .select({ id: playlists.id })
      .from(playlists)
      .where(and(eq(playlists.id, id), ownerFilter(playlists.user_id, user)))
      .limit(1);
    return Boolean(row);
  },

  async create(input: PlaylistInput, user: SessionUser): Promise<PlaylistView> {
    const created = db.transaction((tx) => {
      const [row] = tx
        .insert(playlists)
        .values({
          user_id: user.id,
          name: input.name,
          type: 'default',
          public: input.public ?? false
        })
        .returning()
        .all();

      if (!row) {
        throw new Error('playlist insert returned no row');
      }

      if (input.mediaIds?.length) {
        replaceItemsSync(tx, row.id, input.mediaIds, user);
      }

      return row;
    });

    const view = await this.getById(created.id, user.id);
    if (!view) {
      throw new Error('playlist vanished immediately after creation');
    }
    return view;
  },

  async update(id: number, input: Partial<PlaylistInput>, user: SessionUser): Promise<PlaylistView | undefined> {
    const patch = definedOnly({ name: input.name, public: input.public });

    db.transaction((tx) => {
      if (hasUpdates(patch)) {
        tx.update(playlists)
          .set({ ...patch, last_modified: new Date().toISOString() })
          .where(and(eq(playlists.id, id), ownerFilter(playlists.user_id, user)))
          .run();
      }

      // Absent means "leave the contents alone"; an empty array clears them.
      if (input.mediaIds !== undefined) {
        let ids = input.mediaIds;
        if (input.baseMediaIds) {
          // What arrived after the editor loaded: neither sent nor seen.
          const base = new Set(input.baseMediaIds);
          const sent = new Set(ids);
          const arrived = tx
            .select({ media_id: playlistItems.media_id })
            .from(playlistItems)
            .where(eq(playlistItems.playlist_id, id))
            .orderBy(asc(playlistItems.order_num))
            .all()
            .map((row) => row.media_id)
            .filter((mediaId) => !base.has(mediaId) && !sent.has(mediaId));
          ids = [...ids, ...arrived];
        }
        replaceItemsSync(tx, id, ids, user);
      }
    });

    return this.getById(id, user.id);
  },

  /**
   * Copies a playlist, keeping its order.
   *
   * The media itself is not copied: a playlist is an arrangement of items, and
   * duplicating one to reorder it or swap a few entries should not fork the whole
   * library. `create` links only media the caller may reference, so duplicating a
   * public playlist belonging to someone else yields the arrangement without the
   * items, which is why `dropped` is reported rather than passed over in silence.
   *
   * The copy is always private, whatever the original was. Publishing is a
   * decision, and inheriting it from something you merely copied is not one you made.
   */
  async duplicate(id: number, user: SessionUser): Promise<{ playlist: PlaylistView; dropped: number } | undefined> {
    const source = await this.getById(id, user.id);
    if (!source) {
      return undefined;
    }

    const existing = await db.select({ name: playlists.name }).from(playlists).where(eq(playlists.user_id, user.id));

    const mediaIds = source.items.map((item) => item.id);

    const playlist = await this.create(
      {
        name: copyName(
          source.name ?? 'Playlist',
          existing.map((row) => row.name ?? '')
        ),
        public: false,
        mediaIds
      },
      user
    );

    return { playlist, dropped: mediaIds.length - playlist.items.length };
  },

  async remove(id: number, user: SessionUser): Promise<boolean> {
    return db.transaction((tx) => {
      // PlaylistItems cascades from the foreign key.
      const result = tx
        .delete(playlists)
        .where(and(eq(playlists.id, id), ownerFilter(playlists.user_id, user)))
        .run();
      return result.changes > 0;
    });
  }
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Replaces a playlist's contents in one transaction.
 *
 * Only media the user may reference is linked, so a crafted request cannot pull
 * another user's items into a playlist. Duplicates are dropped because the primary
 * key is (playlist_id, media_id) and a repeat would abort the insert.
 */
function replaceItemsSync(tx: Tx, playlistId: number, mediaIds: number[], user: SessionUser): void {
  tx.delete(playlistItems).where(eq(playlistItems.playlist_id, playlistId)).run();

  if (mediaIds.length === 0) {
    return;
  }

  const seen = new Set<number>();
  const ordered = mediaIds.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  /**
   * In batches, because SQLite caps how many values one statement may bind.
   *
   * Both of these used to be a single statement: one `IN (...)` with every id,
   * and one insert with three values per row. A playlist of five thousand saved
   * in a quarter of a second; one of twenty thousand failed outright with "too
   * many SQL variables", so the item cap was a promise the database could not
   * keep. The sizes stay under 999, the oldest limit SQLite has shipped with.
   */
  const allowedIds = new Set<number>();
  for (let start = 0; start < ordered.length; start += LOOKUP_BATCH) {
    const batch = ordered.slice(start, start + LOOKUP_BATCH);
    const allowed = tx
      .select({ id: media.id })
      .from(media)
      .where(and(inArray(media.id, batch), ownerFilter(media.user_id, user)))
      .all();
    for (const row of allowed) allowedIds.add(row.id);
  }

  const rows = ordered
    .filter((id) => allowedIds.has(id))
    .map((id, index) => ({ playlist_id: playlistId, media_id: id, order_num: index }));

  for (let start = 0; start < rows.length; start += INSERT_BATCH) {
    tx.insert(playlistItems)
      .values(rows.slice(start, start + INSERT_BATCH))
      .run();
  }
}

/** Ids per ownership lookup: one bound value each. */
const LOOKUP_BATCH = 900;
/** Rows per insert: three bound values each. */
const INSERT_BATCH = 300;
