import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/** The counter reads the app's database, so the test points that at a temporary file first. */
const directory = mkdtempSync(join(tmpdir(), 'kune-plays-test-'));
process.env.DATABASE_FILE = join(directory, 'test.db');
process.env.SECRET ??= 'plays-test-secret-that-is-long-enough-to-pass';
process.env.NODE_ENV = 'test';

process.on('exit', () => {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // A leftover temp file is not worth failing a passing run over.
  }
});

const { playCountsOf, playKeyOf, recordPlay } = await import('./media-plays.js');

const song = (id: number, code: string) => ({ id, kind: 'blindtest', payload: { code } });

describe('how often something has been heard', () => {
  it('knows a song by its recording, and anything else by its item', () => {
    assert.equal(playKeyOf(song(4, 'abcdefghijk')), 'yt:abcdefghijk');
    assert.equal(playKeyOf(song(-2, 'abcdefghijk')), 'yt:abcdefghijk');
    assert.equal(playKeyOf({ id: 9, kind: 'image-reveal', payload: {} }), 'media:9');
    assert.equal(playKeyOf({ id: -9, kind: 'image-reveal', payload: {} }), null);
  });

  it('counts each play, and one song saved twice as one song heard', () => {
    recordPlay(song(-1, 'playedtwice'));
    recordPlay(song(1, 'playedtwice'));
    recordPlay({ id: 3, kind: 'image-reveal', payload: {} });

    const counts = playCountsOf([
      song(1, 'playedtwice'),
      song(2, 'playedtwice'),
      song(5, 'neverplayed'),
      { id: 3, kind: 'image-reveal', payload: {} }
    ]);
    assert.equal(counts.get(1), 2);
    assert.equal(counts.get(2), 2);
    assert.equal(counts.get(3), 1);
    assert.equal(counts.has(5), false);
  });
});
