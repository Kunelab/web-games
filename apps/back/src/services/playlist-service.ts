import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../db/index.js';
import { media, playlistItems, playlists, users, type Playlist } from '../db/schema.js';
import { copyName } from './copy-name.js';
import { toMediaView, type MediaView } from './media-service.js';
import { definedOnly, hasUpdates } from './ownership.js';

export const playlistInputSchema = z.object({
  name: z.string().min(1, 'Le nom est requis').max(200),
  public: z.boolean().optional(),
  /** Media ids in play order. Absent leaves the contents untouched. */
  mediaIds: z.array(z.coerce.number().int().positive()).max(500).optional()
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

  const mediaIds = [...new Set(links.map((link) => link.media_id))];
  const mediaRows = mediaIds.length > 0 ? await db.select().from(media).where(inArray(media.id, mediaIds)) : [];

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

  /** Ownership check, separate from visibility: public does not mean editable. */
  async isOwnedBy(id: number, userId: number): Promise<boolean> {
    const [row] = await db
      .select({ id: playlists.id })
      .from(playlists)
      .where(and(eq(playlists.id, id), eq(playlists.user_id, userId)))
      .limit(1);
    return Boolean(row);
  },

  async create(input: PlaylistInput, userId: number): Promise<PlaylistView> {
    const created = db.transaction((tx) => {
      const [row] = tx
        .insert(playlists)
        .values({
          user_id: userId,
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
        replaceItemsSync(tx, row.id, input.mediaIds, userId);
      }

      return row;
    });

    const view = await this.getById(created.id, userId);
    if (!view) {
      throw new Error('playlist vanished immediately after creation');
    }
    return view;
  },

  async update(id: number, input: Partial<PlaylistInput>, userId: number): Promise<PlaylistView | undefined> {
    const patch = definedOnly({ name: input.name, public: input.public });

    db.transaction((tx) => {
      if (hasUpdates(patch)) {
        tx.update(playlists)
          .set({ ...patch, last_modified: new Date().toISOString() })
          .where(and(eq(playlists.id, id), eq(playlists.user_id, userId)))
          .run();
      }

      // Absent means "leave the contents alone"; an empty array clears them.
      if (input.mediaIds !== undefined) {
        replaceItemsSync(tx, id, input.mediaIds, userId);
      }
    });

    return this.getById(id, userId);
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
  async duplicate(
    id: number,
    userId: number
  ): Promise<{ playlist: PlaylistView; dropped: number } | undefined> {
    const source = await this.getById(id, userId);
    if (!source) {
      return undefined;
    }

    const existing = await db
      .select({ name: playlists.name })
      .from(playlists)
      .where(eq(playlists.user_id, userId));

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
      userId
    );

    return { playlist, dropped: mediaIds.length - playlist.items.length };
  },

  async remove(id: number, userId: number): Promise<boolean> {
    return db.transaction((tx) => {
      // PlaylistItems cascades from the foreign key.
      const result = tx
        .delete(playlists)
        .where(and(eq(playlists.id, id), eq(playlists.user_id, userId)))
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
function replaceItemsSync(tx: Tx, playlistId: number, mediaIds: number[], userId: number): void {
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

  const allowed = tx
    .select({ id: media.id })
    .from(media)
    .where(and(inArray(media.id, ordered), eq(media.user_id, userId)))
    .all();

  const allowedIds = new Set(allowed.map((row) => row.id));
  const rows = ordered
    .filter((id) => allowedIds.has(id))
    .map((id, index) => ({ playlist_id: playlistId, media_id: id, order_num: index }));

  if (rows.length > 0) {
    tx.insert(playlistItems).values(rows).run();
  }
}
