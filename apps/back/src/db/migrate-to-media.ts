import type { Database } from 'better-sqlite3';
import type { AnswerField } from 'game-core';

/**
 * One-time data migration: Videos and Images become Media, ContentPlaylists
 * becomes PlaylistItems.
 *
 * Idempotent and non-destructive. The legacy tables are left in place, and a
 * marker row records that the copy has run so a restart does not duplicate
 * anything. Nothing is dropped: if this migration turns out to have mapped
 * something badly, the original rows are still there to re-read.
 */

const MARKER_KEY = 'media_migration_v1';

function alreadyMigrated(sqlite: Database): boolean {
  const row = sqlite.prepare(`SELECT value FROM MetaData WHERE content_id = 0 AND key = ?`).get(MARKER_KEY) as
    { value: string } | undefined;
  return row?.value === 'done';
}

function markMigrated(sqlite: Database): void {
  const timestamp = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO MetaData (content_id, key, value, type, createdAt, updatedAt)
       VALUES (0, ?, 'done', 'migration', ?, ?)
       ON CONFLICT (content_id, key) DO UPDATE SET value = 'done', updatedAt = excluded.updatedAt`
    )
    .run(MARKER_KEY, timestamp, timestamp);
}

interface LegacyVideo {
  id: number;
  user_id: number | null;
  title: string | null;
  artist: string | null;
  code: string | null;
  startGuess: number | null;
  endGuess: number | null;
  startReveal: number | null;
  endReveal: number | null;
  type: string | null;
  date: string | null;
  created_at: string | null;
  last_modified: string | null;
}

interface LegacyImage {
  id: number;
  user_id: number | null;
  name: string | null;
  description: string | null;
  type: string | null;
  date: string | null;
}

export interface MigrationReport {
  ran: boolean;
  videos: number;
  images: number;
  playlistItems: number;
  /** Items that came across but cannot be played until the host completes them. */
  incomplete: { mediaId: number; title: string; reason: string }[];
}

/** Only a real `YYYY-MM-DD` survives; the old column also held full timestamps. */
function normalizeDate(value: string | null): string | null {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? (match[1] ?? null) : null;
}

function clampSeconds(value: number | null, fallback: number): number {
  if (value === null || !Number.isFinite(value) || value < 0) return fallback;
  return Math.min(Math.trunc(value), 86_400);
}

export function migrateToMedia(sqlite: Database): MigrationReport {
  const report: MigrationReport = { ran: false, videos: 0, images: 0, playlistItems: 0, incomplete: [] };

  if (alreadyMigrated(sqlite)) {
    return report;
  }

  const videos = sqlite.prepare(`SELECT * FROM Videos`).all() as LegacyVideo[];
  const images = sqlite.prepare(`SELECT * FROM Images`).all() as LegacyImage[];
  const links = sqlite.prepare(`SELECT * FROM ContentPlaylists`).all() as {
    content_type: string;
    content_id: number;
    playlist_id: number;
    order_num: number | null;
  }[];

  // Nothing to do on a fresh database, but still mark it so this never re-runs.
  if (videos.length === 0 && images.length === 0 && links.length === 0) {
    markMigrated(sqlite);
    report.ran = true;
    return report;
  }

  const insertMedia = sqlite.prepare(
    `INSERT INTO Media (user_id, kind, title, category, date, answers, payload, timing, created_at, last_modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  );
  const insertItem = sqlite.prepare(
    `INSERT OR IGNORE INTO PlaylistItems (playlist_id, media_id, order_num) VALUES (?, ?, ?)`
  );

  // Old ids are not reused, so remember where each legacy row landed.
  const videoIdToMediaId = new Map<number, number>();
  const imageIdToMediaId = new Map<number, number>();

  const run = sqlite.transaction(() => {
    for (const video of videos) {
      // Title and artist become two independently scorable answers, which is what
      // makes per-field bonuses work. Empty ones are dropped rather than kept as
      // unwinnable fields.
      const answers: AnswerField[] = [];
      if (video.title?.trim()) {
        answers.push({
          key: 'title',
          label: 'Titre',
          value: video.title.trim(),
          aliases: [],
          points: 3,
          tolerance: 0.17,
          directBonus: 0
        });
      }
      if (video.artist?.trim()) {
        answers.push({
          key: 'artist',
          label: 'Artiste',
          value: video.artist.trim(),
          aliases: [],
          points: 2,
          tolerance: 0.17,
          directBonus: 0
        });
      }

      const startGuess = clampSeconds(video.startGuess, 0);
      const startReveal = clampSeconds(video.startReveal, startGuess);
      const payload = {
        code: video.code?.trim() ?? '',
        startGuess,
        // The old data has no guarantee end > start, which the schema now requires.
        endGuess: Math.max(clampSeconds(video.endGuess, startGuess + 20), startGuess + 1),
        startReveal,
        endReveal: Math.max(clampSeconds(video.endReveal, startReveal + 20), startReveal + 1)
      };

      const title = video.title?.trim() || video.artist?.trim() || `Vidéo ${video.id}`;

      const result = insertMedia.run(
        video.user_id,
        'blindtest',
        title,
        video.type?.trim() || null,
        normalizeDate(video.date),
        JSON.stringify(answers),
        JSON.stringify(payload),
        video.created_at,
        video.last_modified
      );

      const mediaId = Number(result.lastInsertRowid);
      videoIdToMediaId.set(video.id, mediaId);
      report.videos += 1;

      if (!payload.code) {
        report.incomplete.push({ mediaId, title, reason: 'aucune vidéo YouTube' });
      } else if (answers.length === 0) {
        report.incomplete.push({ mediaId, title, reason: 'aucune réponse' });
      }
    }

    for (const image of images) {
      const answers: AnswerField[] = [];
      if (image.name?.trim()) {
        answers.push({
          key: 'subject',
          label: 'Qui / quoi ?',
          value: image.name.trim(),
          aliases: [],
          points: 3,
          tolerance: 0.17,
          directBonus: 0
        });
      }

      // The legacy Images table had no column for the image itself, only a name
      // and a description, so nothing that can be shown comes across. The
      // metadata is preserved and the host supplies the picture.
      const payload = { src: '', mode: 'pixelate' as const, intensity: 40, startZoom: 2 };
      const title = image.name?.trim() || `Image ${image.id}`;

      const result = insertMedia.run(
        image.user_id,
        'image-reveal',
        title,
        image.type?.trim() || null,
        normalizeDate(image.date),
        JSON.stringify(answers),
        JSON.stringify(payload),
        null,
        null
      );

      const mediaId = Number(result.lastInsertRowid);
      imageIdToMediaId.set(image.id, mediaId);
      report.images += 1;
      report.incomplete.push({
        mediaId,
        title,
        reason: "aucune image (l'ancienne table n'en stockait pas)"
      });
    }

    // Re-sequence positions per playlist. The old `order_num` was mostly NULL,
    // because the code that should have written it used a column name that did not
    // exist, so falling back to the legacy id at least preserves insertion order.
    const byPlaylist = new Map<number, typeof links>();
    for (const link of links) {
      const bucket = byPlaylist.get(link.playlist_id);
      if (bucket) {
        bucket.push(link);
      } else {
        byPlaylist.set(link.playlist_id, [link]);
      }
    }

    for (const [playlistId, entries] of byPlaylist) {
      entries.sort((a, b) => (a.order_num ?? a.content_id) - (b.order_num ?? b.content_id));

      let position = 0;
      for (const entry of entries) {
        const mediaId =
          entry.content_type === 'video'
            ? videoIdToMediaId.get(entry.content_id)
            : imageIdToMediaId.get(entry.content_id);

        // A dangling link: the polymorphic table had no foreign key to stop one.
        if (mediaId === undefined) {
          continue;
        }

        insertItem.run(playlistId, mediaId, position);
        position += 1;
        report.playlistItems += 1;
      }
    }

    markMigrated(sqlite);
  });

  run();
  report.ran = true;
  return report;
}
