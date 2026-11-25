import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { openDb } from '../db/open.js';
import { blindtestSongFacts } from '../db/schema.js';
import { buildBillboardIndex } from './blindtest-billboard.js';
import { mergeSongFacts } from './blindtest-song-facts.js';
import { applyBillboard, queueStatus, songFacts, songFame, songKey } from './blindtest-song-queue.js';

describe('a song’s slow facts', () => {
  it('keeps the earliest year, the best peak and the highest certification of every source', () => {
    const merged = mergeSongFacts(
      { year: 2015, yearSource: 'deezer', charts: { us: { peak: 3, weeks: 10 } }, certifications: { fr: 1 } },
      { year: 1968, yearSource: 'musicbrainz', charts: { us: { peak: 1, weeks: 19 }, uk: { peak: 1 } }, certifications: { fr: 2 } }
    );
    assert.equal(merged.year, 1968);
    assert.equal(merged.yearSource, 'musicbrainz');
    assert.deepEqual(merged.charts, { us: { peak: 1, weeks: 19 }, uk: { peak: 1 } });
    assert.equal(merged.certifications?.fr, 2);
    // A later year never replaces an earlier one.
    assert.equal(mergeSongFacts({ year: 1962 }, { year: 2020 }).year, 1962);
  });

  it('reads as the best chart run and certification of any country', () => {
    assert.deepEqual(
      songFame({ year: 1962, charts: { fr: { peak: 4 }, us: { peak: 40, weeks: 12 } }, certifications: { fr: 1, uk: 2 }, songWikiLanguages: 9 }),
      { year: 1962, chartPeak: 4, chartWeeks: 12, certLevel: 2, songWikiLanguages: 9 }
    );
    assert.deepEqual(songFame({}), {});
  });

  it('reads every queued song against the Billboard history once', () => {
    const { db } = openDb();
    const stamp = new Date().toISOString();
    for (const [artist, title] of [
      ['The Beatles', 'Hey Jude'],
      ['Red Hot Chili Peppers', 'Veronica']
    ]) {
      db.insert(blindtestSongFacts).values({ key: songKey(artist, title), artist, title, updated_at: stamp }).run();
    }
    const index = buildBillboardIndex([
      {
        date: '1968-09-28',
        data: [{ song: 'Hey Jude', artist: 'The Beatles', this_week: 1 }]
      }
    ]);
    assert.equal(applyBillboard(db, index), 2);
    assert.equal(applyBillboard(db, index), 0);
    const jude = songFacts(db, songKey('The Beatles', 'Hey Jude'));
    assert.equal(jude.charts?.us?.peak, 1);
    assert.equal(jude.year, 1968);
    assert.deepEqual(songFacts(db, songKey('Red Hot Chili Peppers', 'Veronica')), {});
    assert.equal(queueStatus(db).billboard, 2);
  });
});
