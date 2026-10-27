import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import Database from 'better-sqlite3';

import { bootstrapSchema, untagRoundTitles } from './bootstrap.js';

function withRounds(titles: string[]): Database.Database {
  const sqlite = new Database(':memory:');
  bootstrapSchema(sqlite, () => {});
  const insert = sqlite.prepare(`INSERT INTO "Media" ("kind", "title", "payload") VALUES (?, ?, ?)`);
  for (const title of titles) insert.run(title.startsWith('quiz:') ? 'quiz' : 'blindtest', title, '{"code":"x"}');
  return sqlite;
}

function rows(sqlite: Database.Database) {
  return sqlite.prepare(`SELECT "title", "payload", "last_modified" FROM "Media" ORDER BY "id"`).all() as {
    title: string;
    payload: string;
    last_modified: string;
  }[];
}

describe('untagRoundTitles', () => {
  it('moves the part of the song off the title into the payload, once', () => {
    const sqlite = withRounds([
      'Gradur - Broly [rap-us/verse]',
      'Naruto [anime-op/intro]',
      'Live [2019] - Encore',
      'AC/DC - Thunderstruck [Live]',
      'quiz: [rap-us/verse]'
    ]);
    const before = rows(sqlite);

    assert.equal(untagRoundTitles(sqlite), 2);
    const after = rows(sqlite);
    assert.deepEqual(
      after.map((row) => row.title),
      ['Gradur - Broly', 'Naruto', 'Live [2019] - Encore', 'AC/DC - Thunderstruck [Live]', 'quiz: [rap-us/verse]']
    );
    assert.deepEqual(JSON.parse(after[0].payload), { code: 'x', angle: 'verse' });
    assert.deepEqual(JSON.parse(after[1].payload), { code: 'x', angle: 'intro' });
    // Not an edit: a rescoring reads this to tell a person's change from the draw's.
    assert.equal(after[0].last_modified, before[0].last_modified);

    assert.equal(untagRoundTitles(sqlite), 0);
  });
});
