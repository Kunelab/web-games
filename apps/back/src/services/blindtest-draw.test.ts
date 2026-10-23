import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { PoolEntry } from './blindtest-catalog.js';

/**
 * Where the next round comes from when the pools are not there yet.
 *
 * The pools live in memory and every restart empties them, so "the pools are
 * still being built" is the state of the first game of every deployment. The
 * draw used to wait them out — a minute or two of searches and model calls —
 * in front of a host who had pressed start. These cases pin down that it no
 * longer does whenever the shared catalogue can deal instead.
 *
 * The catalogue's pool methods are stubbed, so nothing here searches anything:
 * a cold pool is one that never arrives, and a test that waited for it would
 * time out rather than pass slowly. The shared catalogue is a real database,
 * opened the way the smoke runner opens one; see `results-service.test.ts`.
 */
const directory = mkdtempSync(join(tmpdir(), 'kune-draw-test-'));
process.env.DATABASE_FILE = join(directory, 'test.db');
process.env.SECRET ??= 'draw-test-secret-that-is-long-enough-to-pass';
process.env.NODE_ENV = 'test';

process.on('exit', () => {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // A leftover temp file is not worth failing a passing run over.
  }
});

const { db } = await import('../db/index.js');
const { media } = await import('../db/schema.js');
const { dealRounds, emptyHistory } = await import('./blindtest-draw.js');
const { catalogue } = await import('./catalogue-service.js');

const GENRE = 'rap-us';
const EMPTY_GENRE = 'rock';

/**
 * Names nothing would take for one another. "Artist 1 - Song 1" and "Artist 2 -
 * Song 2" are a character apart in both fields, which the duplicate check
 * rightly reads as one song typed twice, and a game leaves such twins out.
 */
const ARTISTS = ['Northern Lights', 'Paper Moons', 'Velvet Harbour'];
const SONGS = ['Glass Garden', 'Midnight Ferry', 'Copper Sky'];

/** A row of the shared catalogue: ownerless, playable, filed under `genre`. */
function catalogueRow(index: number, genre = GENRE) {
  const artist = ARTISTS[index - 1] ?? `Band ${index}`;
  const song = SONGS[index - 1] ?? `Tune ${index}`;
  return {
    user_id: null,
    kind: 'blindtest',
    title: `${artist} - ${song}`,
    category: genre,
    date: null,
    answers: JSON.stringify([
      { key: 'title', label: 'field.title', value: song, points: 3 },
      { key: 'artist', label: 'field.artist', value: artist, points: 2 }
    ]),
    // A real-shaped video id: the kind refuses anything else, and a refused row is not playable.
    payload: JSON.stringify({
      code: `video${String(index).padStart(6, '0')}`,
      startGuess: 40,
      endGuess: 60,
      startReveal: 30,
      endReveal: 50
    }),
    timing: null
  };
}

db.insert(media)
  .values([1, 2, 3].map((index) => catalogueRow(index)))
  .run();

function settings(overrides: { genreIds?: string[]; replayShare?: number } = {}) {
  return {
    genreIds: [GENRE],
    difficultyMin: 0,
    difficultyMax: 100,
    region: 'FR',
    replayShare: 0.5,
    ...overrides
  };
}

/** Settles with `fallback` if `promise` has not settled within `ms`. */
function within<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  return Promise.race([promise, new Promise<F>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

const STALLED = Symbol('stalled');

describe('dealing while the pools are cold', () => {
  let warmed: string[];
  let waitedFor: string[];

  beforeEach(() => {
    warmed = [];
    waitedFor = [];
    mock.method(catalogue, 'cachedPool', () => null);
    mock.method(catalogue, 'warm', (genreId: string) => {
      warmed.push(genreId);
    });
    // A pool that is still being built, and stays that way for the whole test.
    mock.method(catalogue, 'poolFor', (genreId: string) => {
      waitedFor.push(genreId);
      return new Promise(() => undefined);
    });
    // Rescoring asks the outside world too; these rounds are dealt as they are.
    mock.method(catalogue, 'rescoreForPlay', async <T>(item: T) => item);
  });

  afterEach(() => {
    mock.restoreAll();
  });

  // Either side of the replay toss: a roll under the share replays first, one
  // over it searches first.
  for (const [side, roll] of [
    ['replay', 0],
    ['search', 0.99]
  ] as const) {
    it(`deals from the catalogue instead of waiting for them, when the toss says ${side}`, async () => {
      mock.method(Math, 'random', () => roll);
      const dealt = await within(dealRounds(settings(), emptyHistory(), 1), 1_000, STALLED);

      assert.ok(dealt !== STALLED, 'the deal waited on a pool still being built');
      assert.equal(dealt.length, 1);
      assert.equal(dealt[0]?.category, GENRE);
      assert.deepEqual(waitedFor, [], 'nothing waited on a cold pool');
    });
  }

  it('still asks for the pools, so a later round can search', async () => {
    mock.method(Math, 'random', () => 0.99);
    await within(dealRounds(settings(), emptyHistory(), 1), 1_000, STALLED);
    assert.deepEqual(warmed, [GENRE]);
  });

  it('records what it dealt, so the session does not deal it twice', async () => {
    const history = emptyHistory();
    const first = await dealRounds(settings({ replayShare: 1 }), history, 1);
    const second = await dealRounds(settings({ replayShare: 1 }), history, 1, new Set(first.map((item) => item.id)));

    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.notEqual(first[0]?.id, second[0]?.id);
    assert.equal(history.playedTracks.size, 2);
  });

  it('deals a replayed round rescored, the way the catalogue now scores it', async () => {
    mock.method(catalogue, 'rescoreForPlay', async <T extends { payload: unknown }>(item: T) => ({
      ...item,
      payload: { ...(item.payload as object), difficulty: 12, difficultyBy: 'auto' }
    }));
    const [dealt] = await dealRounds(settings({ replayShare: 1 }), emptyHistory(), 1);
    assert.equal((dealt?.payload as { difficultyBy?: string }).difficultyBy, 'auto');
  });

  it('waits for them when the room asked for nothing but new songs', async () => {
    const dealt = await within(dealRounds(settings({ replayShare: 0 }), emptyHistory(), 1), 200, STALLED);

    assert.equal(dealt, STALLED, 'with replays off, the pool is the only source');
    assert.deepEqual(waitedFor, [GENRE]);
  });

  it('waits for them when the catalogue has nothing in these genres either', async () => {
    const dealt = await within(dealRounds(settings({ genreIds: [EMPTY_GENRE] }), emptyHistory(), 1), 200, STALLED);

    assert.equal(dealt, STALLED);
    assert.deepEqual(waitedFor, [EMPTY_GENRE]);
  });
});

/** A metal track in a pool, scored 50 until enriched. */
function poolEntry(index: number): PoolEntry {
  return {
    videoId: `metal${String(index).padStart(6, '0')}`,
    trackKey: `band ${index}::song ${index}`,
    title: `Song ${index}`,
    artist: `Band ${index}`,
    work: '',
    titleAliases: [],
    artistAliases: [],
    workAliases: [],
    year: 2001,
    yearVerified: false,
    views: 100_000,
    durationSeconds: 200,
    channel: 'Band - Topic',
    restriction: { embeddable: true, ageRestricted: false, privacyStatus: 'public', uploadStatus: 'processed' },
    difficulty: 50,
    modelDifficulty: 50,
    recognised: true,
    seedFame: null,
    fame: null,
    seedWikidataId: null,
    song: '',
    songArtist: '',
    videoTitle: `Band ${index} - Song ${index}`,
    trackSeconds: null,
    upload: 'topic',
    hintFraction: null,
    chorus: null,
    enriched: false,
    genreId: 'metal',
    answerShape: 'artist-title'
  };
}

describe('dealing from a pool whose difficulties move once enriched', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('keeps looking while there is something left, after several picks turn out too hard', async () => {
    const pool = Array.from({ length: 8 }, (_, index) => poolEntry(index));
    let enriched = 0;
    mock.method(catalogue, 'cachedPool', () => pool);
    mock.method(catalogue, 'warm', () => undefined);
    mock.method(catalogue, 'extend', () => undefined);
    // The first five the draw enriches turn out to be deep cuts, far outside 0 to 60.
    mock.method(catalogue, 'enrich', async (entries: PoolEntry[]) => {
      for (const entry of entries) {
        if (entry.enriched) continue;
        entry.enriched = true;
        enriched += 1;
        if (enriched <= 5) entry.difficulty = 97;
      }
    });

    const dealt = await dealRounds(
      { genreIds: ['metal'], difficultyMin: 0, difficultyMax: 60, region: 'FR', replayShare: 0 },
      emptyHistory(),
      1
    );

    assert.equal(dealt.length, 1);
    assert.ok(((dealt[0]?.payload as { difficulty?: number }).difficulty ?? 100) <= 60);
  });
});
