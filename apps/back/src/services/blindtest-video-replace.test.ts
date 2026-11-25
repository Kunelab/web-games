import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { eq } from 'drizzle-orm';
import { videoInDoubt, videoProposalOf } from 'game-core';

import { openDb } from '../db/open.js';
import { media } from '../db/schema.js';
import type { Annotation } from './blindtest-llm.js';
import {
  acceptedPayload,
  answerProposal,
  proposeForFlaggedIn,
  proposeReplacement,
  rankCandidates,
  rejectedPayload,
  replacementQueries,
  roundOf,
  screenCandidate,
  type ReplaceDeps,
  type ReplaceRow
} from './blindtest-video-replace.js';
import { genreById } from './blindtest-catalog.js';
import type { VideoFacts } from './youtube-service.js';

const DOUBTED = 'coverCover1';

function facts(videoId: string, title: string, channel: string, extra: Partial<VideoFacts> = {}): VideoFacts {
  return {
    videoId,
    title,
    channel,
    description: '',
    year: 2010,
    views: 1_000_000,
    durationSeconds: 200,
    restriction: { embeddable: true, ageRestricted: false, privacyStatus: 'public', uploadStatus: 'processed' },
    ...extra
  };
}

function filmRow(payload: Record<string, unknown> = {}, id = 1): ReplaceRow {
  return {
    id,
    category: 'films-musique',
    answers: JSON.stringify([{ key: 'work', value: 'Le Parrain', aliases: ['The Godfather'] }]),
    payload: JSON.stringify({
      code: DOUBTED,
      startGuess: 10,
      endGuess: 30,
      startReveal: 29,
      endReveal: 41,
      volume: 100,
      difficulty: 40,
      timingBy: 'human',
      videoDoubt: { reason: 'cover', code: DOUBTED },
      ...payload
    })
  };
}

const songRow: ReplaceRow = {
  id: 2,
  category: 'rap-fr',
  answers: JSON.stringify([
    { key: 'title', value: 'Bande organisée' },
    { key: 'artist', value: 'Jul' }
  ]),
  payload: JSON.stringify({ code: DOUBTED, startGuess: 0, endGuess: 20, startReveal: 20, endReveal: 40 })
};

const film = roundOf(filmRow())!;
const song = roundOf(songRow)!;

describe('the searches for a round', () => {
  it('asks for a song under its artist and title, officially', () => {
    assert.deepEqual(replacementQueries(song), ['Jul Bande organisée official', 'Jul Bande organisée official audio']);
  });

  it("asks for a work's soundtrack, the second time under its other name", () => {
    assert.deepEqual(replacementQueries(film), [
      'Le Parrain original soundtrack main theme',
      'The Godfather OST main theme'
    ]);
  });
});

describe('screening a candidate', () => {
  it('refuses the video in doubt, a refused one, covers, compilations and the wrong length', () => {
    const rejecting = { ...film, rejected: ['refusedOne1'] };
    assert.equal(screenCandidate(facts(DOUBTED, 'The Godfather Theme', 'X'), rejecting, 'FR'), 'the video in doubt');
    assert.equal(
      screenCandidate(facts('refusedOne1', 'The Godfather Theme', 'X'), rejecting, 'FR'),
      'refused by an admin'
    );
    assert.match(screenCandidate(facts('a'.repeat(11), 'The Godfather - Piano Cover', 'X'), film, 'FR') ?? '', /cover/);
    assert.match(screenCandidate(facts('b'.repeat(11), 'Top 10 movie themes', 'X'), film, 'FR') ?? '', /compilation/);
    assert.equal(
      screenCandidate(facts('c'.repeat(11), 'The Godfather Theme', 'X', { durationSeconds: 20 }), film, 'FR'),
      'too short'
    );
    assert.equal(
      screenCandidate(facts('d'.repeat(11), 'The Godfather Theme', 'X', { durationSeconds: 3600 }), film, 'FR'),
      'too long'
    );
    assert.equal(
      screenCandidate(facts('e'.repeat(11), 'The Godfather Theme (Live)', 'X'), film, 'FR'),
      'not the recording'
    );
  });

  it('refuses a video that will not play in the room', () => {
    const blocked = facts('f'.repeat(11), 'The Godfather Theme', 'X', {
      restriction: {
        blocked: ['FR'],
        embeddable: true,
        ageRestricted: false,
        privacyStatus: 'public',
        uploadStatus: 'processed'
      }
    });
    assert.equal(screenCandidate(blocked, film, 'FR'), 'does not play here');
  });

  it("does not take the work's own name for a refusal", () => {
    const mixed = roundOf({ ...filmRow(), answers: JSON.stringify([{ key: 'work', value: 'Mix: Meisei Story' }]) })!;
    assert.equal(
      screenCandidate(facts('g'.repeat(11), 'Mix: Meisei Story Original Soundtrack', 'X'), mixed, 'FR'),
      null
    );
  });

  it("wants a song's title and artist in what the video says", () => {
    assert.equal(screenCandidate(facts('h'.repeat(11), 'Jul - Bande organisée', 'Jul'), song, 'FR'), null);
    assert.equal(screenCandidate(facts('i'.repeat(11), 'Jul - Tchikita', 'Jul'), song, 'FR'), 'another song');
    assert.equal(screenCandidate(facts('j'.repeat(11), 'Bande organisée', 'Someone'), song, 'FR'), 'another artist');
  });
});

describe('ranking the candidates', () => {
  it("puts a song's VEVO and Topic uploads first, and drops a fan's lyrics upload however watched", () => {
    const ranked = rankCandidates(
      [
        facts('fanUpload11', 'Jul - Bande organisée (lyrics)', 'RapFrLyrics', { views: 5_000_000, description: 'Jul' }),
        facts('topicUpload', 'Bande organisée', 'Jul - Topic', {
          views: 200_000,
          description: 'Jul · Bande organisée'
        }),
        facts('vevoUpload1', 'Jul - Bande organisée (Clip officiel)', 'JulVEVO', { views: 90_000_000 })
      ],
      song,
      new Map([
        ['fanUpload11', 0],
        ['topicUpload', 1],
        ['vevoUpload1', 2]
      ]),
      'FR'
    );
    assert.deepEqual(
      ranked.map((one) => one.facts.videoId),
      ['vevoUpload1', 'topicUpload']
    );
  });

  it("puts a work's official soundtrack before an unofficial upload of it", () => {
    const ranked = rankCandidates(
      [
        facts('randomUp111', 'Godfather music', 'Some Person', { views: 2_000_000 }),
        facts('officialOst', 'The Godfather Waltz (Original Soundtrack)', 'Nino Rota - Topic', {
          views: 800_000,
          description: 'The Godfather (Original Motion Picture Soundtrack)'
        })
      ],
      film,
      new Map([
        ['randomUp111', 0],
        ['officialOst', 1]
      ]),
      'FR'
    );
    assert.equal(ranked[0]?.facts.videoId, 'officialOst');
    assert.match(ranked[0].reasons.join(), /Topic/);
  });

  it('marks an ending down in an openings genre', () => {
    const naruto = roundOf({
      id: 3,
      category: 'anime-op',
      answers: JSON.stringify([{ key: 'work', value: 'Naruto' }]),
      payload: JSON.stringify({ code: DOUBTED })
    })!;
    const ranked = rankCandidates(
      [
        facts('endingOne11', 'Naruto Ending 1 (Creditless)', 'Crunchyroll'),
        facts('openingOne1', 'Naruto Opening 1 (Creditless)', 'Crunchyroll')
      ],
      naruto,
      new Map(),
      'FR'
    );
    assert.equal(ranked[0]?.facts.videoId, 'openingOne1');
  });
});

function reading(answer: string, extra: Partial<Annotation> = {}): Annotation {
  return {
    kind: 'work',
    artist: '',
    answer,
    aliases: [],
    difficulty: 30,
    recognised: true,
    confidence: 0.9,
    hookFraction: null,
    fitsGenre: true,
    song: '',
    songArtist: '',
    fromWork: true,
    ...extra
  };
}

function fakeDeps(overrides: Partial<ReplaceDeps> & { budget?: number } = {}): ReplaceDeps & { searches: string[] } {
  let budget = overrides.budget ?? 10;
  const searches: string[] = [];
  const all = new Map(
    [
      facts('pianoCover1', 'The Godfather Theme - Piano Cover', 'PianoGuy'),
      facts('anotherFilm', 'Scarface Theme (Original Soundtrack)', 'Giorgio Moroder - Topic', {
        description: 'Scarface (Original Motion Picture Soundtrack)'
      }),
      facts('officialOst', 'The Godfather Waltz (Original Soundtrack)', 'Nino Rota - Topic', {
        description: 'The Godfather (Original Motion Picture Soundtrack)'
      })
    ].map((one) => [one.videoId, one])
  );
  return {
    searches,
    spendSearch: () => budget-- > 0,
    search: async (query) => {
      searches.push(query);
      return [...all.keys()];
    },
    videoFacts: async (ids) => new Map(ids.flatMap((id) => (all.has(id) ? [[id, all.get(id)!] as const] : []))),
    annotate: async (candidates) =>
      new Map(
        candidates.map((one) => [
          one.videoId,
          one.videoId === 'anotherFilm' ? reading('Scarface') : reading('The Godfather')
        ])
      ),
    sameWorks: async () => new Map(),
    region: 'FR',
    ...overrides
  };
}

describe('proposing a replacement', () => {
  it('proposes the official soundtrack, read by the model as the same work', async () => {
    const deps = fakeDeps();
    const found = await proposeReplacement(filmRow(), deps);
    assert.equal(found?.code, 'officialOst');
    assert.equal(found?.durationSeconds, 200);
    assert.ok(found?.reason);
    assert.equal(deps.searches.length, 1, 'a convincing first search spares the second');
  });

  it('takes another name for the work only once the narrow question says it is the same', async () => {
    const deps = fakeDeps({
      annotate: async (candidates) => new Map(candidates.map((one) => [one.videoId, reading('Il Padrino')])),
      sameWorks: async (pairs) => new Map(pairs.map((pair) => [pair.id, false]))
    });
    assert.equal(await proposeReplacement(filmRow(), deps), null);
    const confirmed = fakeDeps({
      annotate: async (candidates) => new Map(candidates.map((one) => [one.videoId, reading('Il Padrino')])),
      sameWorks: async (pairs) => new Map(pairs.map((pair) => [pair.id, true]))
    });
    assert.equal((await proposeReplacement(filmRow(), confirmed))?.code, 'officialOst');
  });

  it('drops what the model calls a cover, and never offers a refused video', async () => {
    const deps = fakeDeps({
      annotate: async (candidates) =>
        new Map(candidates.map((one) => [one.videoId, reading('The Godfather', { fromWork: false })]))
    });
    assert.equal(await proposeReplacement(filmRow(), deps), null);
    assert.equal(await proposeReplacement(filmRow({ videoRejected: ['officialOst'] }), fakeDeps()), null);
  });

  it('defers without budget, on a failed search, or when the model does not answer for a work', async () => {
    assert.equal(await proposeReplacement(filmRow(), fakeDeps({ budget: 0 })), undefined);
    assert.equal(
      await proposeReplacement(
        filmRow(),
        fakeDeps({
          search: async () => {
            throw new Error('403');
          }
        })
      ),
      undefined
    );
    assert.equal(await proposeReplacement(filmRow(), fakeDeps({ annotate: async () => new Map() })), undefined);
  });
});

describe("an admin's answer to a proposal", () => {
  const proposal = {
    code: 'officialOst',
    title: 'The Godfather Waltz (Original Soundtrack)',
    channel: 'Nino Rota - Topic',
    for: DOUBTED,
    foundAt: '2026-11-24T00:00:00.000Z',
    durationSeconds: 200
  };
  const payload = JSON.parse(filmRow({ videoProposal: proposal, videoRejected: ['oldRefused1'] }).payload) as Record<
    string,
    unknown
  >;

  it('accepting puts the video in, lifts the doubt and places the clip again, automatically', () => {
    const next = acceptedPayload(payload, genreById.get('films-musique'), () => 0.5)!;
    assert.equal(next.code, 'officialOst');
    assert.equal(next.videoDoubt, undefined);
    assert.equal(next.videoProposal, undefined);
    assert.equal(next.timingBy, 'auto');
    assert.deepEqual(next.videoRejected, ['oldRefused1']);
    assert.ok((next.endGuess as number) > (next.startGuess as number));
    assert.ok((next.endReveal as number) <= 200);
    assert.equal(videoInDoubt(next), false);
  });

  it('refusing drops the proposal and remembers its video, keeping the doubt', () => {
    const next = rejectedPayload(payload)!;
    assert.equal(next.videoProposal, undefined);
    assert.deepEqual(next.videoRejected, ['oldRefused1', 'officialOst']);
    assert.equal(videoInDoubt(next), true);
    const full = rejectedPayload({ ...payload, videoRejected: Array.from({ length: 20 }, (_, index) => `r${index}`) })!;
    assert.equal((full.videoRejected as string[]).length, 20);
    assert.equal((full.videoRejected as string[]).at(-1), 'officialOst');
  });

  it('neither does anything without a live proposal', () => {
    assert.equal(acceptedPayload({ ...payload, code: 'elsewhere11' }, undefined), null);
    assert.equal(rejectedPayload({ ...payload, videoProposal: undefined }), null);
  });
});

describe('walking the rounds in doubt', () => {
  function seeded() {
    const { db } = openDb(':memory:');
    const insert = (row: ReplaceRow) =>
      db
        .insert(media)
        .values({
          user_id: null,
          kind: 'blindtest',
          title: `#${row.id}`,
          category: row.category,
          answers: row.answers,
          payload: row.payload
        })
        .returning({ id: media.id })
        .all()[0].id;
    const doubted = insert(filmRow());
    const fine = insert(filmRow({ videoDoubt: undefined }));
    const doubtedToo = insert(filmRow());
    return { db, doubted, fine, doubtedToo };
  }
  const payloadOf = (db: ReturnType<typeof openDb>['db'], id: number) =>
    JSON.parse(db.select({ payload: media.payload }).from(media).where(eq(media.id, id)).all()[0].payload) as Record<
      string,
      unknown
    >;

  it('writes a proposal on each round in doubt, and leaves the rest', async () => {
    const { db, doubted, fine, doubtedToo } = seeded();
    const report = await proposeForFlaggedIn(db, fakeDeps(), { limit: 10, write: true });
    assert.deepEqual([report.tried, report.proposed, report.none, report.deferred], [2, 2, 0, 0]);
    assert.equal(videoProposalOf(payloadOf(db, doubted))?.code, 'officialOst');
    assert.equal(videoProposalOf(payloadOf(db, doubtedToo))?.code, 'officialOst');
    assert.equal(payloadOf(db, fine).videoProposal, undefined);

    // A round with a live proposal is not searched again.
    const again = await proposeForFlaggedIn(db, fakeDeps(), { limit: 10, write: true });
    assert.equal(again.tried, 0);

    // Accepted through the database: the row plays again.
    assert.deepEqual(answerProposal(db, doubted, 'accept'), { ok: true });
    assert.equal(payloadOf(db, doubted).code, 'officialOst');
    assert.deepEqual(answerProposal(db, doubted, 'accept'), { ok: false, reason: 'no-proposal' });
    assert.deepEqual(answerProposal(db, doubtedToo, 'reject'), { ok: true });
    assert.deepEqual(payloadOf(db, doubtedToo).videoRejected, ['officialOst']);
  });

  it('stops when the budget is spent, and writes nothing on a dry run', async () => {
    const { db, doubted } = seeded();
    const report = await proposeForFlaggedIn(db, fakeDeps({ budget: 1 }), { limit: 10, write: false });
    assert.deepEqual([report.tried, report.proposed, report.deferred], [2, 1, 1]);
    assert.equal(payloadOf(db, doubted).videoProposal, undefined);
  });

  it('leaves a round searched in vain alone for a while', async () => {
    const { db, doubted } = seeded();
    const nothing = fakeDeps({ search: async () => [] });
    const report = await proposeForFlaggedIn(db, nothing, { limit: 10, write: true });
    assert.equal(report.none, 2);
    assert.equal((payloadOf(db, doubted).videoSearched as { for: string }).for, DOUBTED);
    assert.equal((await proposeForFlaggedIn(db, nothing, { limit: 10, write: true })).tried, 0);
  });
});
