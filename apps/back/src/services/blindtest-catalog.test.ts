import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { openDb } from '../db/open.js';
import { createCatalogue, type CatalogueSources, type PoolEntry } from './blindtest-catalog.js';
import { noFameSources } from './blindtest-fame.js';
import type { Annotation, Candidate } from './blindtest-llm.js';
import type { VideoFacts } from './youtube-service.js';

/**
 * The catalogue, through the interface the rest of the app uses.
 *
 * Every outside service is a fake that answers from a small world written in
 * the test, the database is a fresh one in memory, and time only moves when a
 * test moves it. Nothing here reaches the network: a source the world does not
 * describe answers the way the real one does when it has nothing.
 */

/**
 * And the proof of that: any request at all is recorded and refused, and the
 * run fails at the end if there was one, even one some caller swallowed.
 */
const outgoing: string[] = [];
globalThis.fetch = async (input) => {
  outgoing.push(input instanceof Request ? input.url : String(input));
  throw new Error('the network is not part of this test');
};
after(() => assert.deepEqual(outgoing, []));

/** A video the fake YouTube holds, and how the fake model reads its title. */
interface Clip {
  id: string;
  title: string;
  views?: number;
  /** What the model says about it, over a reading of "Artist - Title". */
  read?: Partial<Annotation>;
  /** Returned by every search, the way a search for rap brings back a pop hit. */
  everywhere?: boolean;
}

/** A track on an editor's playlist, for the music genres. */
interface Track {
  artist: string;
  title: string;
  rank?: number;
}

/** A series in AniList's popularity ranking. */
interface Series {
  title: string;
  synonyms?: string[];
  year?: number;
  popularity?: number;
}

/** A classical work Wikidata knows, with its composer. */
interface Work {
  title: string;
  composer: string;
  links?: number;
}

interface World {
  /** What Deezer's editors file under a playlist search. Nothing, by default. */
  deezer?: (query: string) => Track[];
  anilist?: Series[];
  compositions?: Work[];
  clips?: Clip[];
  /** Whether MusicBrainz knows every recording's release year. */
  years?: boolean;
}

/**
 * Fake sources over a world, counting what was asked of them.
 *
 * YouTube's search returns every clip whose title holds one of the query's
 * quoted names, which is what a seed search is, or everything for a query with
 * none, plus the clips that turn up everywhere. Deezer answers a playlist
 * search with one editor's playlist named after the query, holding whatever
 * the world files under it.
 */
function fakeSources(world: World = {}) {
  const calls = { search: [] as string[], sparql: 0 };
  const clips = world.clips ?? [];
  const playlists: string[] = [];

  const sources: CatalogueSources = {
    youtube: {
      async search(query) {
        calls.search.push(query);
        const names = [...query.matchAll(/"([^"]+)"/g)].map((match) => (match[1] ?? '').toLowerCase());
        return clips
          .filter(
            (clip) =>
              clip.everywhere || names.length === 0 || names.some((name) => clip.title.toLowerCase().includes(name))
          )
          .map((clip) => clip.id);
      },
      async facts(videoIds) {
        return new Map(clips.filter((clip) => videoIds.includes(clip.id)).map((clip) => [clip.id, factsOf(clip)]));
      },
      async playlist() {
        return [];
      }
    },
    seeds: {
      deezer: {
        async searchPlaylists(query, page) {
          if (page.index > 0 || !world.deezer?.(query).length) return { data: [] };
          playlists.push(query);
          return { data: [{ id: playlists.length, title: query, nb_tracks: 50, user: { name: 'Deezer' } }] };
        },
        async userPlaylists() {
          return { data: [] };
        },
        async playlistTracks(playlistId) {
          const tracks = world.deezer?.(playlists[playlistId - 1] ?? '') ?? [];
          return {
            data: tracks.map((track, index) => ({
              id: playlistId * 1000 + index,
              title: track.title,
              rank: track.rank ?? 1000 - index,
              artist: { name: track.artist }
            }))
          };
        }
      },
      async anilist() {
        return {
          data: {
            Page: {
              pageInfo: { hasNextPage: false },
              media: (world.anilist ?? []).map((series, index) => ({
                id: index + 1,
                popularity: series.popularity ?? 1000 - index,
                title: { english: series.title },
                synonyms: series.synonyms ?? [],
                startDate: { year: series.year ?? null }
              }))
            }
          }
        };
      },
      async sparql(_endpoint, query) {
        calls.sparql += 1;
        // Only the classical works are in this world: a film or a game query finds nothing.
        if (!query.includes('wd:Q105543609')) return { results: { bindings: [] } };
        return {
          results: {
            bindings: (world.compositions ?? []).map((work, index) => ({
              item: { value: `http://www.wikidata.org/entity/Q${index + 1}` },
              links: { value: String(work.links ?? 50) },
              en: { value: work.title },
              cen: { value: work.composer }
            }))
          }
        };
      }
    },
    lyrics: async () => null,
    aliases: {
      musicbrainz: async () => (world.years ? { aliases: [], year: 1995 } : null),
      anilist: async () => null
    },
    fame: noFameSources,
    async annotate(candidates) {
      return new Map(candidates.map((candidate) => [candidate.videoId, reading(candidate, clips)]));
    }
  };

  return { sources, calls };
}

function factsOf(clip: Clip): VideoFacts {
  return {
    videoId: clip.id,
    title: clip.title,
    channel: 'Some Channel',
    description: '',
    year: 2015,
    views: clip.views ?? 1000,
    durationSeconds: 200,
    restriction: { embeddable: true, ageRestricted: false, privacyStatus: 'public', uploadStatus: 'processed' }
  };
}

/** The fake model: "Artist - Title" read as music, unless the clip says otherwise. */
function reading(candidate: Candidate, clips: Clip[]): Annotation {
  const [artist = '', answer = ''] = candidate.title.split(' - ');
  return {
    kind: 'music',
    artist,
    answer,
    aliases: [],
    difficulty: 50,
    recognised: true,
    confidence: 0.9,
    hookFraction: null,
    fitsGenre: true,
    song: '',
    songArtist: '',
    ...clips.find((clip) => clip.id === candidate.videoId)?.read
  };
}

/** A clock that only moves when told to. */
function fakeClock(start = Date.parse('2026-10-14T12:00:00Z')) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    }
  };
}

function catalogueOver(world: World = {}, options: { budget?: number } = {}) {
  const { sources, calls } = fakeSources(world);
  const clock = fakeClock();
  const catalogue = createCatalogue({ sources, db: openDb(':memory:').db, clock, budget: options.budget ?? 95 });
  return { catalogue, calls, clock };
}

const MINUTE = 60 * 1000;

const answers = (pool: PoolEntry[]) => pool.map((entry) => `${entry.artist} / ${entry.title}`).sort();

/** Rap tracks Deezer's editors list, and an upload of each. */
const RAP: Track[] = [
  { artist: 'Nas', title: 'N.Y. State of Mind' },
  { artist: 'Mobb Deep', title: 'Shook Ones' },
  { artist: 'Wu-Tang Clan', title: 'C.R.E.A.M.' }
];
const RAP_CLIPS: Clip[] = RAP.map((track, index) => ({ id: `rap${index}`, title: `${track.artist} - ${track.title}` }));

describe('a genre pool', () => {
  it('fills from the seeds the editors list and the uploads a search finds for them', async () => {
    const { catalogue } = catalogueOver({ deezer: () => RAP, clips: RAP_CLIPS });

    const pool = await catalogue.poolFor('rap-us');

    assert.deepEqual(answers(pool), [
      'Mobb Deep / Shook Ones',
      'Nas / N.Y. State of Mind',
      'Wu-Tang Clan / C.R.E.A.M.'
    ]);
  });

  it('takes the artist back out of a title the model repeated it in, and only the artist', async () => {
    // Seen live: both fields right, and the title one unwinnable, because a
    // player who types the actual song name is missing the artist.
    const { catalogue } = catalogueOver({
      clips: [
        { id: 'a', title: 'Action Bronson - Easy Rider', read: { answer: 'Action Bronson – Easy Rider' } },
        { id: 'b', title: 'ORELSAN - Basique', read: { artist: 'OrelSan', answer: 'ORELSAN : Basique' } },
        { id: 'c', title: 'Pink Floyd - Us and Them', read: { answer: 'Us - Them' } },
        { id: 'd', title: 'Queen - Bohemian Rhapsody', read: { answer: 'Bohemian Rhapsody - Remastered' } }
      ]
    });

    assert.deepEqual(answers(await catalogue.poolFor('pop')), [
      'Action Bronson / Easy Rider',
      'OrelSan / Basique',
      'Pink Floyd / Us - Them',
      'Queen / Bohemian Rhapsody - Remastered'
    ]);
  });

  it('deals a track its catalogue ranks famous as easier than the same upload ranked obscure', async () => {
    const upload: Clip = { id: 'nas', title: 'Nas - N.Y. State of Mind' };
    const ranked = (rank: number) => [
      { artist: 'Nas', title: 'N.Y. State of Mind', rank },
      { artist: 'Nas', title: 'Halftime', rank: 500 }
    ];
    const famous = catalogueOver({ deezer: () => ranked(1000), clips: [upload] }).catalogue;
    const obscure = catalogueOver({ deezer: () => ranked(1), clips: [upload] }).catalogue;

    const [easy] = await famous.poolFor('rap-us');
    const [hard] = await obscure.poolFor('rap-us');

    assert.ok(easy && hard && easy.difficulty < hard.difficulty, `${easy?.difficulty} < ${hard?.difficulty}`);
  });
});

describe("a genre's seeds against the model", () => {
  it('keep an artist the editors list even when the model doubts them, and only such an artist', async () => {
    const { catalogue } = catalogueOver({
      deezer: () => [{ artist: 'Nas', title: 'N.Y. State of Mind' }],
      clips: [
        { id: 'nas', title: 'Nas - N.Y. State of Mind', read: { fitsGenre: false } },
        { id: 'pop', title: 'Bruno Mars - Grenade', read: { fitsGenre: false }, everywhere: true }
      ]
    });

    assert.deepEqual(answers(await catalogue.poolFor('rap-us')), ['Nas / N.Y. State of Mind']);
  });

  it('leave the model the last word on an artist they also file under another genre', async () => {
    const { catalogue } = catalogueOver({
      deezer: (query) =>
        /pop/.test(query)
          ? [{ artist: 'Taylor Swift', title: 'Anti-Hero' }]
          : [
              { artist: 'Nas', title: 'N.Y. State of Mind' },
              { artist: 'Taylor Swift', title: 'Shake It Off' }
            ],
      clips: [
        { id: 'nas', title: 'Nas - N.Y. State of Mind', read: { fitsGenre: false } },
        { id: 'swift', title: 'Taylor Swift - Shake It Off', read: { fitsGenre: false } }
      ]
    });

    await catalogue.harvest('pop');

    assert.deepEqual(answers(await catalogue.poolFor('rap-us')), ['Nas / N.Y. State of Mind']);
  });

  it('do not vouch for anybody in classical, where they are not an editor’s list', async () => {
    const { catalogue } = catalogueOver({
      compositions: [
        { title: 'Happy Birthday to You', composer: 'Patty Hill' },
        { title: 'Für Elise', composer: 'Ludwig van Beethoven' }
      ],
      clips: [
        { id: 'birthday', title: 'Patty Hill - Happy Birthday to You', read: { fitsGenre: false } },
        { id: 'elise', title: 'Ludwig van Beethoven - Für Elise' }
      ]
    });

    assert.deepEqual(answers(await catalogue.poolFor('classique')), ['Ludwig van Beethoven / Für Elise']);
  });

  it("give a work they know the catalogue's names and year, and keep out a scene from it", async () => {
    const { catalogue } = catalogueOver({
      anilist: [
        { title: 'Attack on Titan', synonyms: ['Shingeki no Kyojin'], year: 2013 },
        { title: 'The Quintessential Quintuplets 2', year: 2021 }
      ],
      clips: [
        {
          id: 'aot',
          title: 'Attack on Titan Opening 1 - Guren no Yumiya',
          read: { kind: 'work', artist: '', answer: 'Attack on Titan' }
        },
        {
          id: 'scene',
          title: 'Love Confession | The Quintessential Quintuplets 2',
          read: { kind: 'work', artist: '', answer: 'The Quintessential Quintuplets 2', fitsGenre: false },
          everywhere: true
        }
      ]
    });

    const pool = await catalogue.poolFor('anime-op');

    assert.deepEqual(
      pool.map((entry) => [entry.work, entry.workAliases, entry.year, entry.yearVerified]),
      [['Attack on Titan', ['Shingeki no Kyojin'], 2013, true]]
    );
  });
});

describe("the day's search budget", () => {
  it('stops the searches once it is spent, whichever genre asks next', async () => {
    const artists = Array.from({ length: 9 }, (_, index) => ({ artist: `Artist ${index}`, title: `Track ${index}` }));
    const { catalogue, calls } = catalogueOver({ deezer: () => artists }, { budget: 2 });

    await catalogue.poolFor('rap-us');
    await catalogue.poolFor('pop');

    assert.equal(calls.search.length, 2);
    assert.equal(catalogue.searchesToday().used, 2);
  });
});

describe('a fill that found nothing', () => {
  it('is remembered as empty for an hour when it spent searches, then tried again', async () => {
    const clips: Clip[] = [];
    const { catalogue, clock } = catalogueOver({ deezer: () => RAP, clips });

    assert.deepEqual(await catalogue.poolFor('rap-us'), []);
    // YouTube has the uploads now, but the empty pool stands for the hour.
    clips.push(...RAP_CLIPS);
    clock.advance(59 * MINUTE);
    assert.deepEqual(await catalogue.poolFor('rap-us'), []);

    clock.advance(2 * MINUTE);
    assert.equal((await catalogue.poolFor('rap-us')).length, RAP.length);
  });
});

describe('a seed harvest', () => {
  it('runs once for two asks that arrive together, and both get its answer', async () => {
    const { catalogue, calls } = catalogueOver({
      compositions: [
        { title: 'Für Elise', composer: 'Ludwig van Beethoven' },
        { title: 'The Four Seasons', composer: 'Antonio Vivaldi' }
      ]
    });

    const answered = await Promise.all([catalogue.harvest('classique'), catalogue.harvest('classique')]);

    assert.deepEqual(answered, [2, 2]);
    assert.equal(calls.sparql, 1);
  });
});

describe("an era facet's pool", () => {
  it('checks the release year of its most viewed entries first', async () => {
    // A hundred uploads, the most viewed last in the order the search returned them.
    const clips: Clip[] = Array.from({ length: 100 }, (_, index) => ({
      id: `c${index}`,
      title: `Artist ${index} - Song ${index}`,
      views: (index + 1) * 1000,
      everywhere: true
    }));
    const { catalogue } = catalogueOver({ clips, years: true });

    const pool = await catalogue.poolFor('rap-us');
    const mostViewed = [...pool].sort((left, right) => right.views - left.views).slice(0, 10);

    assert.deepEqual(
      mostViewed.filter((entry) => !entry.yearVerified).map((entry) => entry.title),
      [],
      'the famous tracks are the ones an era facet must not misfile'
    );
  });
});
