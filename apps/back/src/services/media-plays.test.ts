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

const { playCountsOf, playKeyOf, recentPlays, recordPlay } = await import('./media-plays.js');

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

describe('how much something has been heard lately', () => {
  const near = (actual: number | undefined, expected: number) =>
    assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-6, `${actual} ≈ ${expected}`);

  it('forgets five plays a month, and nothing below none', () => {
    const may = new Date('2026-05-10T20:00:00Z');
    for (let play = 0; play < 25; play++) recordPlay(song(7, 'heardinmay'), may);

    near(recentPlays(may).get('yt:heardinmay'), 25);
    near(recentPlays(new Date('2026-06-09T20:00:00Z')).get('yt:heardinmay'), 20);
    near(recentPlays(new Date('2026-11-10T20:00:00Z')).get('yt:heardinmay'), 0);
  });

  it('counts a new play on top of what is left of the old ones', () => {
    for (let play = 0; play < 10; play++) recordPlay(song(8, 'heardagain'), new Date('2026-01-01T00:00:00Z'));
    // Sixty days on, the ten are forgotten.
    const march = new Date('2026-03-02T00:00:00Z');
    recordPlay(song(8, 'heardagain'), march);

    near(recentPlays(march).get('yt:heardagain'), 1);
    assert.equal(playCountsOf([song(8, 'heardagain')]).get(8), 11);
  });
});
