import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * The shared catalogue's own bookkeeping, on a database of its own.
 *
 * The library module reads the app's database, so the test points that at a
 * temporary file before loading it, the way `blindtest-draw.test.ts` does.
 */
const directory = mkdtempSync(join(tmpdir(), 'kune-library-test-'));
process.env.DATABASE_FILE = join(directory, 'test.db');
process.env.SECRET ??= 'library-test-secret-that-is-long-enough-to-pass';
process.env.NODE_ENV = 'test';

process.on('exit', () => {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // A leftover temp file is not worth failing a passing run over.
  }
});

const { correctLibraryRound, findReviewFlags, rememberPlayedRound } = await import('./blindtest-library.js');
const { recordRoundOutcome } = await import('./blindtest-stats.js');
const { mediaService } = await import('./media-service.js');
const { findLibraryDuplicates, withoutHiddenDuplicates } = await import('./blindtest-duplicates.js');
const { listLibrary } = await import('./blindtest-library.js');
type SessionUser = import('../types/fastify.js').SessionUser;
type MediaView = import('./media-service.js').MediaView;

/** Whether this catalogue entry is among the admin's flags. */
async function flagged(mediaId: number | undefined): Promise<boolean> {
  return (await findReviewFlags()).some((flag) => flag.mediaId === mediaId);
}

/** A generated round as the draw deals it: rated easy. */
function dealtRound(code: string): MediaView {
  return {
    id: -1,
    kind: 'blindtest',
    title: `Some Band - Some Song [${code}]`,
    category: 'rock',
    date: null,
    answers: [
      { key: 'title', label: 'field.title', value: `Some Song ${code}`, aliases: [], points: 3 },
      { key: 'artist', label: 'field.artist', value: 'Some Band', aliases: [], points: 2 }
    ],
    payload: { code, startGuess: 5, endGuess: 25, startReveal: 24, endReveal: 36, volume: 100, difficulty: 20 },
    timing: null
  } as unknown as MediaView;
}

describe('a round rated easy that nobody finds', () => {
  it('is flagged, and the flag clears once its clip is fixed', async () => {
    const code = 'abcdefghij1';
    const kept = await rememberPlayedRound(dealtRound(code));
    await recordRoundOutcome(code, false);
    await recordRoundOutcome(code, false);
    assert.equal(await flagged(kept?.id), true);

    // The window opened on a spoken intro; an admin moves it onto the chorus.
    await correctLibraryRound(code, [], { startGuess: 62, endGuess: 82 });

    assert.equal(await flagged(kept?.id), false);
  });

  it('clears too once an admin has set its difficulty, even to one still easy', async () => {
    const code = 'abcdefghij2';
    const kept = await rememberPlayedRound(dealtRound(code));
    await recordRoundOutcome(code, false);
    await recordRoundOutcome(code, false);

    // Looked at and judged: the misses so far were against the old number.
    await correctLibraryRound(code, [], { difficulty: 35 });

    assert.equal(await flagged(kept?.id), false);
  });

  it('clears once an admin moves its clip in the media editor, where the flag sends them', async () => {
    const code = 'abcdefghij4';
    const kept = await rememberPlayedRound(dealtRound(code));
    await recordRoundOutcome(code, false);
    await recordRoundOutcome(code, false);
    const admin: SessionUser = { id: 1, login: 'admin', role: 'admin' };

    await mediaService.update(
      kept!.id,
      {
        kind: 'blindtest',
        title: kept!.title,
        category: kept!.category,
        answers: kept!.answers,
        payload: { ...(kept!.payload as Record<string, unknown>), startGuess: 62, endGuess: 82 }
      },
      admin
    );

    assert.equal(await flagged(kept?.id), false);
  });

  it('stays flagged when only the answer was corrected', async () => {
    const code = 'abcdefghij3';
    const kept = await rememberPlayedRound(dealtRound(code));
    await recordRoundOutcome(code, false);
    await recordRoundOutcome(code, false);

    await correctLibraryRound(code, [{ key: 'artist', value: 'Some Other Band' }]);

    assert.equal(await flagged(kept?.id), true);
  });
});

describe('a possible duplicate in a game', () => {
  /** A round of `artist - title`, filed in the catalogue. */
  async function filed(code: string, artist: string, title: string) {
    const round = dealtRound(code);
    round.answers = [
      { key: 'title', label: 'field.title', value: title, aliases: [], points: 3, tolerance: 0.17, directBonus: 0 },
      { key: 'artist', label: 'field.artist', value: artist, aliases: [], points: 2, tolerance: 0.17, directBonus: 0 }
    ];
    return (await rememberPlayedRound(round))!;
  }

  /** What a game would deal of these entries, as the catalogue holds them now. */
  async function playable(...ids: number[]): Promise<number[]> {
    const rows = (await listLibrary()).filter((row) => ids.includes(row.id));
    return (await withoutHiddenDuplicates(rows)).map((row) => row.id).sort((a, b) => a - b);
  }

  it('plays an entry again as soon as it is corrected out of the pair', async () => {
    const first = await filed('dupcode0001', 'The Twins', 'One Song');
    const second = await filed('dupcode0002', 'The Twins', 'Some B-Side');
    // Mistaken for the first at a reveal, and flagged as its twin once an admin looked.
    await correctLibraryRound('dupcode0002', [{ key: 'title', value: 'One Song' }]);
    await findLibraryDuplicates();
    assert.deepEqual(await playable(first.id, second.id), [first.id]);

    // It was a different song all along.
    await correctLibraryRound('dupcode0002', [{ key: 'title', value: 'Another Song Entirely' }]);

    assert.deepEqual(await playable(first.id, second.id), [first.id, second.id]);
  });

  it('holds an entry back as soon as it is corrected into a pair', async () => {
    const first = await filed('dupcode0003', 'The Echoes', 'Same Old Tune');
    const second = await filed('dupcode0004', 'The Echoes', 'A Different Tune');
    await findLibraryDuplicates();

    await correctLibraryRound('dupcode0004', [{ key: 'title', value: 'Same Old Tune' }]);

    assert.deepEqual(await playable(first.id, second.id), [first.id]);
  });
});
