import { and, eq, isNull } from 'drizzle-orm';
import { alsoInOf } from 'game-core';

import { db } from '../db/index.js';
import { media } from '../db/schema.js';
import { GENRES } from './blindtest-catalog.js';

/**
 * A catalogue round filed in the eras its year falls in, without anybody
 * tagging it.
 *
 * An era ("Pop 90s", "Rap FR 2000s") is a facet over a genre: that genre's
 * songs of those years. The endless mode filters its pools by year for it;
 * the catalogue had nothing, since a round's genre is the one it was found in.
 * So a round lists, among the other genres it plays in (`alsoIn`), every era
 * of its own genre and of those others that its year is in, and a room or a
 * playlist launched on an era hears it.
 *
 * Derived, so kept in step: a round moved out of a genre leaves that genre's
 * eras, and an era a round's year is not in is not kept. What an admin ticked
 * in the genre dialog is theirs, and saved as they ticked it; see
 * `setLibraryGenre`.
 */

/** The part of a genre this reads. The catalogue's `Genre` fits it. */
export interface EraGenre {
  id: string;
  facetOf?: string;
  yearRange?: { from: number; to: number };
}

/** A `YYYY-MM-DD` date's year, or null. */
export function yearOf(date: string | null | undefined): number | null {
  const year = Number(date?.slice(0, 4));
  return Number.isInteger(year) && year > 1000 ? year : null;
}

/**
 * The payload with its eras brought up to date, or the same object when they
 * already are. Pure, for the tests.
 */
export function withEras<P extends Record<string, unknown>>(
  payload: P,
  category: string | null,
  date: string | null | undefined,
  genres: readonly EraGenre[] = GENRES
): P {
  // Set by hand in the genre dialog: theirs, eras and all.
  if (payload.alsoInBy === 'human') return payload;
  const byId = new Map(genres.map((genre) => [genre.id, genre]));
  const listed = alsoInOf(payload);
  // The genres it is really in: its own and the others that are not eras.
  const parents = new Set([category ?? '', ...listed.filter((id) => !byId.get(id)?.facetOf)]);
  const year = yearOf(date);
  const eras = genres
    .filter(
      (genre) =>
        genre.facetOf &&
        genre.yearRange &&
        parents.has(genre.facetOf) &&
        year !== null &&
        year >= genre.yearRange.from &&
        year <= genre.yearRange.to
    )
    .map((genre) => genre.id);
  const next = [...listed.filter((id) => !byId.get(id)?.facetOf), ...eras].filter((id) => id !== category);

  if (next.length === listed.length && next.every((id, index) => id === listed[index])) return payload;
  const updated: Record<string, unknown> = { ...payload };
  if (next.length > 0) updated.alsoIn = next;
  else delete updated.alsoIn;
  return updated as P;
}

/**
 * Brings every catalogue round's eras up to date. Run at boot: the first time
 * it files the whole catalogue in its eras, afterwards it finds next to nothing.
 * Not an edit: `last_modified` stays, since a rescoring reads it.
 */
export function tagEras(): number {
  const rows = db
    .select({ id: media.id, category: media.category, date: media.date, payload: media.payload })
    .from(media)
    .where(and(isNull(media.user_id), eq(media.kind, 'blindtest')))
    .all();
  let tagged = 0;
  db.transaction((tx) => {
    for (const row of rows) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!payload || typeof payload !== 'object') continue;
      const next = withEras(payload, row.category, row.date);
      if (next === payload) continue;
      tx.update(media)
        .set({ payload: JSON.stringify(next) })
        .where(eq(media.id, row.id))
        .run();
      tagged += 1;
    }
  });
  return tagged;
}
