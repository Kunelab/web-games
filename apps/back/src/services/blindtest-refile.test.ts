import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { MediaView } from './media-service.js';

/**
 * Moving catalogue entries between genres, on a database of its own.
 *
 * The refile module reads the app's database, so the test points that at a
 * temporary file before loading it, the way `blindtest-library.test.ts` does.
 */
const directory = mkdtempSync(join(tmpdir(), 'kune-refile-test-'));
process.env.DATABASE_FILE = join(directory, 'test.db');
process.env.SECRET ??= 'refile-test-secret-that-is-long-enough-to-pass';
process.env.NODE_ENV = 'test';

process.on('exit', () => {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // A leftover temp file is not worth failing a passing run over.
  }
});

const { retagTitle, rescoredForGenre } = await import('./blindtest-refile.js');
const { genreById } = await import('./blindtest-catalog.js');
const { setLibraryGenre } = await import('./blindtest-genres.js');
const { correctLibraryRound, rememberPlayedRound } = await import('./blindtest-library.js');

const rapFr = genreById.get('rap-fr')!;

/** What the draw keeps with a round it scored. */
const looked = { views: 2_000_000, upload: 'video', deezerRank: 800_000, deezerFans: 1_400_000, looked: true };

/** A rap-us round as the draw deals it, by `artist`. */
function dealt(code: string, artist: string, title: string): MediaView {
  return {
    id: -1,
    kind: 'blindtest',
    title: `${artist} - ${title} [rap-us/verse]`,
    category: 'rap-us',
    date: null,
    answers: [
      { key: 'title', label: 'field.title', value: title, aliases: [], points: 3 },
      { key: 'artist', label: 'field.artist', value: artist, aliases: [], points: 2 }
    ],
    payload: {
      code,
      startGuess: 5,
      endGuess: 25,
      startReveal: 24,
      endReveal: 36,
      volume: 100,
      difficulty: 90,
      difficultyBy: 'auto',
      fame: looked
    },
    timing: null
  } as unknown as MediaView;
}

describe('retagTitle', () => {
  it('names the new genre and keeps the part of the song', () => {
    assert.equal(retagTitle('Gradur - Broly [rap-us/verse]', 'rap-fr'), 'Gradur - Broly [rap-fr/verse]');
    assert.equal(retagTitle('Naruto [anime-ed/chorus]', 'anime-op'), 'Naruto [anime-op/chorus]');
  });

  it('leaves a title without a tag alone', () => {
    assert.equal(retagTitle('Gradur - Broly', 'rap-fr'), 'Gradur - Broly');
    assert.equal(retagTitle('Live [2019] - Encore', 'rap-fr'), 'Live [2019] - Encore');
  });
});

describe('rescoredForGenre', () => {
  const filed = { createdAt: '2026-10-24 05:00:00', lastModified: '2026-10-24 05:00:00' };

  it('measures the difficulty again from the figures the draw kept', () => {
    const payload = { code: 'x', difficulty: 90, difficultyBy: 'auto', fame: looked };
    const next = rescoredForGenre(payload, rapFr, filed, new Map());
    assert.equal(typeof next.difficulty, 'number');
    assert.notEqual(next.difficulty, 90);
    assert.equal(next.difficultyBy, 'auto');
  });

  it('keeps a number a person set', () => {
    const payload = { code: 'x', difficulty: 90, difficultyBy: 'human', fame: looked };
    assert.equal(rescoredForGenre(payload, rapFr, filed, new Map()), payload);
  });

  it('does not score from a view count alone', () => {
    const payload = { code: 'x', difficulty: 90, fame: { views: 5_000_000 } };
    assert.equal(rescoredForGenre(payload, rapFr, filed, new Map()), payload);
  });
});

describe('moving an artist', () => {
  it('takes every song by the artist, and files the ones kept later under the same genre', async () => {
    const first = await rememberPlayedRound(dealt('ninhoaaaaa1', 'Ninho', 'Roro'));
    const second = await rememberPlayedRound(dealt('ninhoaaaaa2', 'Ninho', 'Filon'));
    const duet = await rememberPlayedRound(dealt('ninhoaaaaa3', 'Kalash & Ninho', 'Tennessee'));

    const result = await setLibraryGenre(first!.id, 'rap-fr', { allByArtist: true });
    assert.ok(result.ok);
    assert.deepEqual(
      result.moved.map((entry) => entry.id).sort((a, b) => a - b),
      [first!.id, second!.id].sort((a, b) => a - b)
    );
    const moved = result.moved.find((entry) => entry.id === second!.id)!;
    assert.equal(moved.category, 'rap-fr');
    assert.equal(moved.title, 'Ninho - Filon [rap-fr/verse]');
    assert.notEqual((moved.payload as { difficulty: number }).difficulty, 90);
    // Not an edit: a rescoring still treats the round as the draw's.
    assert.equal(moved.last_modified, second!.last_modified);
    assert.ok(!result.moved.some((entry) => entry.id === duet!.id));

    const later = await rememberPlayedRound(dealt('ninhoaaaaa4', 'Ninho', 'Jefe'));
    assert.equal(later?.category, 'rap-fr');
    assert.equal(later?.title, 'Ninho - Jefe [rap-fr/verse]');
  });

  it('moves one song alone without remembering anything', async () => {
    const one = await rememberPlayedRound(dealt('zkraaaaaaa1', 'ZKR', 'Les Mêmes'));
    const result = await setLibraryGenre(one!.id, 'rap-fr');
    assert.ok(result.ok);
    assert.equal(result.moved.length, 1);

    const next = await rememberPlayedRound(dealt('zkraaaaaaa2', 'ZKR', 'Toujours'));
    assert.equal(next?.category, 'rap-us');
  });
});

describe('a genre corrected at a reveal', () => {
  it('retags the title, and is not stamped as an edit when nothing else changed', async () => {
    const kept = await rememberPlayedRound(dealt('hostaaaaaa1', 'Gazo', 'Die'));
    assert.ok(await correctLibraryRound('hostaaaaaa1', [], {}, rapFr));

    const result = await setLibraryGenre(kept!.id, 'rap-fr');
    assert.ok(result.ok);
    assert.equal(result.item.title, 'Gazo - Die [rap-fr/verse]');
    assert.equal(result.item.last_modified, kept!.last_modified);
  });
});
