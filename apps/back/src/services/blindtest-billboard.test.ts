import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  billboardRun,
  buildBillboardIndex,
  loadBillboard,
  refreshBillboard,
  type BillboardCharts
} from './blindtest-billboard.js';

/**
 * The Hot 100 lookup against a few weeks of charts written here, shaped as
 * `all.json` is. Nothing reaches GitHub: `refreshBillboard` is handed the
 * download to make.
 */

function row(song: string, artist: string, position: number) {
  return { song, artist, this_week: position, last_week: null, peak_position: position, weeks_on_chart: 1 };
}

const CHARTS: BillboardCharts = [
  {
    date: '1968-09-14',
    data: [row('Hey Jude', 'The Beatles', 10), row('Satisfaction', 'Otis Redding', 50)]
  },
  {
    date: '1968-09-28',
    data: [row('Hey Jude', 'The Beatles', 1), row("(I Can't Get No) Satisfaction", 'The Rolling Stones', 90)]
  },
  {
    date: '1969-01-04',
    data: [row('Hey Jude', 'The Beatles', 3), row('Hey Jude', 'Wilson Pickett', 23)]
  },
  {
    date: '2012-04-28',
    data: [
      row('Somebody That I Used To Know', 'Gotye Featuring Kimbra', 1),
      row('Crazy In Love', 'Beyonce Featuring Jay Z', 4),
      row('Bicycle Race/Fat Bottomed Girls', 'Queen', 24),
      row('Shining Star', 'Earth, Wind & Fire', 1)
    ]
  },
  {
    date: '2019-05-04',
    data: [row('Old Town Road', 'Lil Nas X x Billy Ray Cyrus', 1), row('Californication', 'Red Hot Chili Peppers', 69)]
  }
];

const index = buildBillboardIndex(CHARTS, new Date('2026-01-01T00:00:00Z'));

describe('billboardRun', () => {
  it('adds up the weeks of a song and keeps its best peak and first year', () => {
    assert.deepEqual(billboardRun(index, 'The Beatles', 'Hey Jude'), { peak: 1, weeks: 3, firstYear: 1968 });
    assert.deepEqual(billboardRun(index, 'Beatles', 'hey jude (Remastered 2015)'), {
      peak: 1,
      weeks: 3,
      firstYear: 1968
    });
  });

  it("never gives a song to another artist who charted the same title", () => {
    assert.deepEqual(billboardRun(index, 'Wilson Pickett', 'Hey Jude'), { peak: 23, weeks: 1, firstYear: 1969 });
    assert.equal(billboardRun(index, 'The Beatles', 'Satisfaction'), null);
    assert.equal(billboardRun(index, 'Elvis Presley', 'Hey Jude'), null);
    assert.equal(billboardRun(index, 'Queen', 'Hey Jude'), null);
  });

  it('finds every performer of a credit, accents or not', () => {
    assert.equal(billboardRun(index, 'Gotye', 'Somebody That I Used to Know')?.peak, 1);
    assert.equal(billboardRun(index, 'Kimbra', 'Somebody That I Used to Know')?.peak, 1);
    assert.equal(billboardRun(index, 'Beyoncé', 'Crazy in Love')?.peak, 4);
    assert.equal(billboardRun(index, 'Jay-Z', 'Crazy in Love')?.peak, 4);
    assert.equal(billboardRun(index, 'Beyoncé feat. Jay-Z', 'Crazy in Love')?.peak, 4);
    assert.equal(billboardRun(index, 'Billy Ray Cyrus', 'Old Town Road')?.peak, 1);
    assert.equal(billboardRun(index, 'Lil Nas X', 'Old Town Road')?.firstYear, 2019);
  });

  it('keeps a group whose name holds a separator whole', () => {
    assert.equal(billboardRun(index, 'Earth, Wind & Fire', 'Shining Star')?.peak, 1);
    assert.equal(billboardRun(index, 'Earth Wind and Fire', 'Shining Star')?.peak, 1);
  });

  it('files a title under its bracketed and double-sided forms', () => {
    assert.equal(billboardRun(index, 'The Rolling Stones', 'Satisfaction')?.peak, 90);
    assert.equal(billboardRun(index, 'The Rolling Stones', "(I Can't Get No) Satisfaction")?.peak, 90);
    assert.equal(billboardRun(index, 'Otis Redding', "(I Can't Get No) Satisfaction")?.peak, 50);
    assert.equal(billboardRun(index, 'Queen', 'Fat Bottomed Girls')?.peak, 24);
    assert.equal(billboardRun(index, 'Queen', 'Bicycle Race')?.peak, 24);
  });

  it('says null for a song that never charted', () => {
    assert.equal(billboardRun(index, 'Red Hot Chili Peppers', 'Under the Bridge'), null);
    assert.equal(billboardRun(index, '', 'Hey Jude'), null);
  });
});

describe('buildBillboardIndex', () => {
  it('records the dates of the history it read', () => {
    assert.equal(index.firstChart, '1968-09-14');
    assert.equal(index.lastChart, '2019-05-04');
    assert.equal(index.builtAt, '2026-01-01T00:00:00.000Z');
  });
});

describe('refreshBillboard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'billboard-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('builds and writes the index when there is none, then reads it back', async () => {
    const file = join(dir, 'fresh', 'billboard.json');
    let downloads = 0;
    const built = await refreshBillboard(file, 7, () => {
      downloads += 1;
      return Promise.resolve(CHARTS);
    });
    assert.equal(downloads, 1);
    assert.equal(built && billboardRun(built, 'Gotye', 'Somebody That I Used To Know')?.peak, 1);
    assert.deepEqual(loadBillboard(file)?.entries, built?.entries);

    const again = await refreshBillboard(file, 7, () => {
      downloads += 1;
      return Promise.resolve(CHARTS);
    });
    assert.equal(downloads, 1, 'a fresh index is not downloaded again');
    assert.equal(again?.lastChart, '2019-05-04');
  });

  it('downloads again once the index is older than allowed', async () => {
    const file = join(dir, 'stale.json');
    await refreshBillboard(file, 7, () => Promise.resolve(CHARTS));
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(file, old, old);
    let downloads = 0;
    await refreshBillboard(file, 7, () => {
      downloads += 1;
      return Promise.resolve(CHARTS);
    });
    assert.equal(downloads, 1);
  });

  it('keeps the old index when the download fails or is not a history', async () => {
    const file = join(dir, 'kept.json');
    await refreshBillboard(file, 7, () => Promise.resolve(CHARTS));
    const failed = await refreshBillboard(file, 0, () => Promise.reject(new Error('offline')));
    assert.equal(failed, null);
    const malformed = await refreshBillboard(file, 0, () =>
      Promise.resolve([{ date: 'yesterday', data: [] }] as unknown as BillboardCharts)
    );
    assert.equal(malformed, null);
    assert.equal(loadBillboard(file)?.lastChart, '2019-05-04');
  });

  it('reads nothing from a file that is not an index', () => {
    const file = join(dir, 'junk.json');
    writeFileSync(file, '{"hello":1}');
    assert.equal(loadBillboard(file), null);
    assert.equal(loadBillboard(join(dir, 'missing.json')), null);
  });
});
