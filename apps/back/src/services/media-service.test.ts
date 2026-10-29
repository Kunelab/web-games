import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { MediaRow } from '../db/schema.js';

/**
 * The parse cache behind `toMediaView`.
 *
 * The module opens the app's database on import, so the test points that at a
 * temporary file first, the way the library's tests do. Nothing is written to it.
 */
const directory = mkdtempSync(join(tmpdir(), 'kune-media-test-'));
process.env.DATABASE_FILE = join(directory, 'test.db');
process.env.SECRET ??= 'media-test-secret-that-is-long-enough-to-pass';
process.env.NODE_ENV = 'test';

process.on('exit', () => {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // A leftover temp file is not worth failing a passing run over.
  }
});

const { toMediaView } = await import('./media-service.js');

function row(overrides: Partial<MediaRow> = {}): MediaRow {
  return {
    id: 7,
    user_id: null,
    kind: 'blindtest',
    title: 'Toto - Africa',
    category: 'pop',
    date: null,
    answers: JSON.stringify([
      { key: 'title', label: 'Titre', value: 'Africa', points: 3 },
      { key: 'artist', label: 'Artiste', value: 'Toto', points: 2 }
    ]),
    payload: JSON.stringify({ code: 'FTQbiNvZqaY', startGuess: 80, endGuess: 100, startReveal: 99, endReveal: 109 }),
    timing: null,
    created_at: null,
    last_modified: null,
    ...overrides
  };
}

describe('a parsed row', () => {
  it('is parsed again when the row changed, whatever its date says', () => {
    assert.equal(toMediaView(row()).category, 'pop');
    assert.equal(toMediaView(row({ category: 'rock' })).category, 'rock');
  });

  it('is handed to each caller as a copy of its own', () => {
    const first = toMediaView(row());
    first.answers[0].value = 'Rosanna';
    (first.payload as { difficulty?: number }).difficulty = 99;

    const second = toMediaView(row());
    assert.equal(second.answers[0]?.value, 'Africa');
    assert.equal((second.payload as { difficulty?: number }).difficulty, undefined);
    assert.notEqual(first, second);
  });
});
