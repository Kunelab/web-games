import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { eq } from 'drizzle-orm';

import { openDb } from '../db/open.js';
import { blindtestSeeds, media } from '../db/schema.js';
import {
  createCatalogue,
  readCalibrations,
  refitCalibrations,
  writeCalibrations,
  type CatalogueSources,
  type PoolEntry
} from './blindtest-catalog.js';
import { noFameSources, type FameSources } from './blindtest-fame.js';
import { createSeedStock } from './blindtest-seeds.js';
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
  /** What the fame catalogues answer. Nothing, by default. */
  fame?: Partial<FameSources>;
  /** The songs Wikidata has a YouTube video for, and the artists it has a channel for. */
  wikidata?: {
    videos?: { artist: string; title: string; video: string }[];
    channels?: { artist: string; channel: string }[];
  };
  /** Playlists by id: a channel's uploads are its id with `UU` for `UC`. */
  uploads?: Record<string, Clip[]>;
}

/**
 * Fake sources over a world, counting what was asked of them.
 *
 * YouTube's search returns every clip whose title holds one of the query's
 * quoted names, punctuation aside as on the real one ("AC/DC Highway to Hell"
 * finds "AC/DC - Highway to Hell"), which is what a seed search is, or
 * everything for a query with none, plus the clips that turn up everywhere. Deezer answers a playlist
 * search with one editor's playlist named after the query, holding whatever
 * the world files under it.
 */
function fakeSources(world: World = {}) {
  const calls = { search: [] as string[], sparql: 0, playlist: [] as string[], read: [] as string[] };
  const clips = world.clips ?? [];
  const playlists: string[] = [];

  const sources: CatalogueSources = {
    youtube: {
      async search(query) {
        calls.search.push(query);
        const words = (text: string) =>
          text
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, ' ')
            .trim();
        const names = [...query.matchAll(/"([^"]+)"/g)].map((match) => words(match[1] ?? ''));
        return clips
          .filter(
            (clip) => clip.everywhere || names.length === 0 || names.some((name) => words(clip.title).includes(name))
          )
          .map((clip) => clip.id);
      },
      async facts(videoIds) {
        return new Map(clips.filter((clip) => videoIds.includes(clip.id)).map((clip) => [clip.id, factsOf(clip)]));
      },
      async playlist(playlistId) {
        calls.playlist.push(playlistId);
        return (world.uploads?.[playlistId] ?? []).map((clip) => ({ title: clip.title, videoId: clip.id }));
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
        if (query.includes('wdt:P1651')) {
          const videos = world.wikidata?.videos ?? [];
          return {
            results: {
              bindings: videos.map((song) => ({
                vid: { value: song.video },
                title: { value: song.title },
                artist: { value: song.artist }
              }))
            }
          };
        }
        if (query.includes('wdt:P2397')) {
          const channels = world.wikidata?.channels ?? [];
          return {
            results: {
              bindings: channels.map((entry) => ({ channel: { value: entry.channel }, name: { value: entry.artist } }))
            }
          };
        }
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
    fame: { ...noFameSources, ...world.fame },
    async annotate(candidates) {
      calls.read.push(...candidates.map((candidate) => candidate.videoId));
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
  const db = openDb(':memory:').db;
  const catalogue = createCatalogue({ sources, db, clock, budget: options.budget ?? 95 });
  return { catalogue, calls, clock, db };
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

/**
 * One rock editor's list: these famous songs, and nine nobody knows for each.
 *
 * So that exactly the famous ones are the genre's top tenth, its hits.
 */
function rockList(...famous: Track[]): (query: string) => Track[] {
  const unknown = Array.from({ length: famous.length * 9 }, (_, index) => ({
    artist: `Garage ${String.fromCharCode(65 + index)}`,
    title: `Demo ${index}`,
    rank: 100 - index
  }));
  const list = [...famous.map((track, index) => ({ ...track, rank: 1_000_000 - index })), ...unknown];
  return (query) => (query === 'rock essentials' ? list : []);
}

const QUEEN: Track = { artist: 'Queen', title: 'Bohemian Rhapsody' };
const ACDC: Track = { artist: 'AC/DC', title: 'Highway to Hell' };
const DAY = 24 * 60 * MINUTE;

/** A song in the shared catalogue, filed the way the prefill files one. */
async function fileInCatalogue(db: ReturnType<typeof catalogueOver>['db'], artist: string, title: string) {
  await db.insert(media).values({
    user_id: null,
    kind: 'blindtest',
    title: `${artist} - ${title}`,
    category: 'rock',
    answers: JSON.stringify([
      { key: 'title', value: title },
      { key: 'artist', value: artist }
    ]),
    payload: JSON.stringify({ code: `${artist}${title}`.replace(/\W/g, '') })
  });
}

describe("a genre's famous songs", () => {
  const seedsBy = (db: ReturnType<typeof catalogueOver>['db'], artist: string) =>
    db.select().from(blindtestSeeds).where(eq(blindtestSeeds.artist, artist)).all();

  it('are searched as themselves before anything else, and their covers are left out', async () => {
    const { catalogue, calls } = catalogueOver({
      deezer: rockList(QUEEN),
      clips: [
        { id: 'queen', title: 'Queen - Bohemian Rhapsody' },
        { id: 'cover', title: 'Pentatonix - Queen Bohemian Rhapsody' }
      ]
    });

    const result = await catalogue.searchForCatalogue('rock', 95);

    assert.equal(calls.search[0], '"Queen Bohemian Rhapsody"');
    assert.deepEqual(answers(result?.entries ?? []), ['Queen / Bohemian Rhapsody']);
  });

  it("wait for Wikidata's list before a room's fill searches them, without the room waiting", async () => {
    const { catalogue, calls } = catalogueOver({ deezer: rockList(QUEEN) });

    await catalogue.poolFor('rock');

    // The list was not loaded: the room's fill went on without the hit, which is not searched blind.
    assert.ok(!calls.search.some((query) => query.includes('Queen')));
  });

  it('are spent once their song is in the catalogue, and not before', async () => {
    const { catalogue, calls, db } = catalogueOver({
      deezer: rockList(QUEEN),
      clips: [{ id: 'queen', title: 'Queen - Bohemian Rhapsody' }]
    });

    await catalogue.searchForCatalogue('rock', 95);
    assert.equal(calls.search[0], '"Queen Bohemian Rhapsody"');
    assert.ok(seedsBy(db, 'Queen').every((seed) => seed.searched_at === null && seed.tries === 1));

    await fileInCatalogue(db, 'Queen', 'Bohemian Rhapsody');
    await catalogue.searchForCatalogue('rock', 95);

    assert.ok(seedsBy(db, 'Queen').every((seed) => seed.searched_at !== null && seed.found === 1));
    assert.equal(calls.search.filter((query) => query.includes('Queen')).length, 1);
  });

  it('are given up on once the prefill has tried twice and filed nothing, under any id', async () => {
    // YouTube has no upload of it to find. And every harvest here hands the song
    // a new Deezer id, the way a new editor's list does: a new seed of a song
    // given up on is given up on too.
    const { catalogue, calls, clock, db } = catalogueOver({ deezer: rockList(QUEEN) });

    await catalogue.searchForCatalogue('rock', 95);
    // Resting a week, so the night after searches something else.
    await catalogue.searchForCatalogue('rock', 95);
    clock.advance(8 * DAY);
    await catalogue.searchForCatalogue('rock', 95);
    clock.advance(8 * DAY);
    await catalogue.searchForCatalogue('rock', 95);
    await catalogue.searchForCatalogue('rock', 95);

    assert.equal(calls.search.filter((query) => query.includes('Queen')).length, 2);
    assert.ok(seedsBy(db, 'Queen').length > 1);
    assert.ok(seedsBy(db, 'Queen').every((seed) => seed.searched_at !== null && seed.found === 0));
  });

  it('are put back when an artist search spent them without filing their song', async () => {
    const { catalogue, db } = catalogueOver({ deezer: rockList(QUEEN, ACDC) });
    await catalogue.harvest('rock');
    // Spent the old way: every seed, whatever its search came back with.
    db.update(blindtestSeeds).set({ searched_at: '2026-10-01T00:00:00.000Z', found: 50 }).run();
    await fileInCatalogue(db, 'AC/DC', 'Highway To Hell');

    assert.equal((await catalogue.reopenHits()).rock, 1);
    assert.ok(seedsBy(db, 'Queen').every((seed) => seed.searched_at === null));
    assert.ok(seedsBy(db, 'AC/DC').every((seed) => seed.searched_at !== null));
    assert.ok(seedsBy(db, 'Garage A').every((seed) => seed.searched_at !== null));
  });
});

describe("a famous song's video, found without a search", () => {
  const QUEEN_CHANNEL = 'UCiMhD4jzUqG-IgPzUmmytRQ';

  it('is the one Wikidata gives the song', async () => {
    const { catalogue, calls } = catalogueOver({
      deezer: rockList(QUEEN),
      wikidata: { videos: [{ artist: 'Queen', title: 'Bohemian Rhapsody', video: 'fJ9rUzIMcZQ' }] },
      clips: [{ id: 'fJ9rUzIMcZQ', title: 'Queen - Bohemian Rhapsody' }]
    });

    const result = await catalogue.searchForCatalogue('rock', 95);

    assert.deepEqual(calls.search, []);
    assert.equal(result?.free, 1);
    assert.equal(result?.spent, 0);
    assert.deepEqual(answers(result?.entries ?? []), ['Queen / Bohemian Rhapsody']);
    // The answer is Wikidata's and Deezer's: nothing for the model to read.
    assert.deepEqual(calls.read, []);
  });

  it('is read by the model after all when its own title says it is something else', async () => {
    const { catalogue, calls } = catalogueOver({
      deezer: rockList(QUEEN),
      wikidata: { videos: [{ artist: 'Queen', title: 'Bohemian Rhapsody', video: 'liveaid1985' }] },
      clips: [{ id: 'liveaid1985', title: 'Queen - Bohemian Rhapsody (Live Aid 1985)', read: { kind: 'reject' } }]
    });

    const result = await catalogue.searchForCatalogue('rock', 95);

    assert.deepEqual(calls.read, ['liveaid1985']);
    assert.deepEqual(result?.entries, []);
  });

  it("is on the artist's channel when Wikidata has none, for a unit and not a search", async () => {
    const { catalogue, calls } = catalogueOver({
      deezer: rockList(QUEEN),
      wikidata: { channels: [{ artist: 'Queen', channel: QUEEN_CHANNEL }] },
      uploads: {
        [`UU${QUEEN_CHANNEL.slice(2)}`]: [
          { id: 'queenlive01', title: 'Queen - Bohemian Rhapsody (Live Aid 1985)' },
          { id: 'queenvideo1', title: 'Queen - Bohemian Rhapsody (Official Video Remastered)' },
          { id: 'queenother1', title: 'Queen - Radio Ga Ga' }
        ]
      },
      clips: [{ id: 'queenvideo1', title: 'Queen - Bohemian Rhapsody' }]
    });

    const result = await catalogue.searchForCatalogue('rock', 95);

    assert.deepEqual(calls.search, []);
    assert.deepEqual(calls.playlist, [`UU${QUEEN_CHANNEL.slice(2)}`]);
    // A title matched on a channel is a guess, which the model still checks.
    assert.deepEqual(calls.read, ['queenvideo1']);
    assert.deepEqual(answers(result?.entries ?? []), ['Queen / Bohemian Rhapsody']);
    // One page read: one unit, which the day counts as a search's worth begun.
    assert.equal(catalogue.searchesToday().used, 1);
  });

  it('is searched for the next time, when the one found filed nothing', async () => {
    // Wikidata's video is gone from YouTube.
    const { catalogue, calls, clock } = catalogueOver({
      deezer: rockList(QUEEN),
      wikidata: { videos: [{ artist: 'Queen', title: 'Bohemian Rhapsody', video: 'deadvideo01' }] }
    });

    const looked = await catalogue.searchForCatalogue('rock', 95);
    assert.equal(looked?.free, 1);
    clock.advance(8 * DAY);
    await catalogue.searchForCatalogue('rock', 95);

    assert.deepEqual(
      calls.search.filter((query) => query.includes('Queen')),
      ['"Queen Bohemian Rhapsody"']
    );
  });
});

describe('a run that spends no search', () => {
  const QUEEN_CHANNEL = 'UCiMhD4jzUqG-IgPzUmmytRQ';

  it('looks up the videos it knows and searches nothing else', async () => {
    const { catalogue, calls } = catalogueOver({
      deezer: rockList(QUEEN),
      wikidata: { videos: [{ artist: 'Queen', title: 'Bohemian Rhapsody', video: 'fJ9rUzIMcZQ' }] },
      clips: [{ id: 'fJ9rUzIMcZQ', title: 'Queen - Bohemian Rhapsody' }]
    });

    const looked = await catalogue.searchForCatalogue('rock', 95, { searches: false });
    // The hit rests a week once looked up: what is left would need a search.
    const after = await catalogue.searchForCatalogue('rock', 95, { searches: false });

    assert.deepEqual(answers(looked?.entries ?? []), ['Queen / Bohemian Rhapsody']);
    assert.equal(after, null);
    assert.deepEqual(calls.search, []);
  });

  it('counts a channel read as a step, though it held none of the songs', async () => {
    const { catalogue, calls } = catalogueOver({
      deezer: rockList(QUEEN),
      wikidata: { channels: [{ artist: 'Queen', channel: QUEEN_CHANNEL }] },
      uploads: { [`UU${QUEEN_CHANNEL.slice(2)}`]: [{ id: 'queenother1', title: 'Queen - Radio Ga Ga' }] }
    });

    const result = await catalogue.searchForCatalogue('rock', 95, { searches: false });

    assert.equal(result?.channels, 1);
    assert.deepEqual(result?.entries, []);
    assert.deepEqual(calls.search, []);
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

describe('a catalogue round about to be played', () => {
  /** A round filed before difficulties were rescored: no marker, the database's own stamps. */
  function fileRound(db: ReturnType<typeof openDb>['db'], payload: Record<string, unknown> = {}, stamps = {}) {
    const [row] = db
      .insert(media)
      .values({
        user_id: null,
        kind: 'blindtest',
        title: 'Bob Marley - Could You Be Loved',
        category: 'reggae',
        answers: JSON.stringify([
          { key: 'title', label: 'field.title', value: 'Could You Be Loved', aliases: [], points: 3 },
          { key: 'artist', label: 'field.artist', value: 'Bob Marley', aliases: [], points: 2 }
        ]),
        payload: JSON.stringify({
          code: 'marley00001',
          startGuess: 40,
          endGuess: 60,
          startReveal: 59,
          endReveal: 71,
          difficulty: 40,
          ...payload
        }),
        ...stamps
      })
      .returning()
      .all();
    const stored = row;
    return {
      id: stored.id,
      kind: stored.kind,
      user_id: stored.user_id,
      category: stored.category,
      timing: null,
      answers: JSON.parse(stored.answers) as { key: string; label: string; value: string; aliases: string[] }[],
      payload: JSON.parse(stored.payload) as Record<string, unknown>,
      created_at: stored.created_at,
      last_modified: stored.last_modified
    };
  }

  /** Bob Marley as the catalogues know him. */
  const marley: Partial<FameSources> = {
    deezerTracks: async () => [
      { id: 7, title: 'Could You Be Loved', rank: 910_000, artist: { id: 719, name: 'Bob Marley & The Wailers' } }
    ],
    deezerArtist: async (id) => ({ id, name: 'Bob Marley & The Wailers', fans: 12_303_381 }),
    wikidataByClaim: async () => [],
    wikidataSearch: async () => ['Q409'],
    wikidataEntities: async () => [
      {
        id: 'Q409',
        labels: { en: 'Bob Marley' },
        claims: { P434: ['x'] },
        sitelinks: Object.fromEntries(
          Array.from({ length: 150 }, (_, index) => [
            `x${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}wiki`,
            'x'
          ])
        )
      }
    ],
    pageviews: async () => 80_000,
    // No Last.fm key: no figure, which is an answer and not a failed request.
    lastfmListeners: async () => null
  };

  it('is rescored, marked, and kept so, when it never was', async () => {
    const { catalogue, db } = catalogueOver({ fame: marley });
    const round = fileRound(db);

    const played = await catalogue.rescoreForPlay(round);

    assert.equal(played.payload.difficultyBy, 'auto');
    assert.ok((played.payload.difficulty as number) <= 20, String(played.payload.difficulty));
    const [saved] = db.select().from(media).where(eq(media.id, round.id)).all();
    assert.deepEqual(JSON.parse(saved.payload), played.payload);
  });

  it('is played as it is, and tried again next time, when a lookup failed', async () => {
    const { catalogue, db } = catalogueOver({ fame: { ...marley, deezerTracks: async () => undefined } });
    const round = fileRound(db);
    const played = await catalogue.rescoreForPlay(round);
    assert.deepEqual([played.payload.difficulty, played.payload.difficultyBy], [40, undefined]);
  });

  it('is left as it is when a person set its difficulty', async () => {
    const { catalogue, db } = catalogueOver({ fame: marley });
    const round = fileRound(db, { difficulty: 70, difficultyBy: 'human' });
    assert.equal((await catalogue.rescoreForPlay(round)).payload.difficulty, 70);
  });

  it('is left as it is when it was edited before hand edits were marked', async () => {
    const { catalogue, db } = catalogueOver({ fame: marley });
    const round = fileRound(db, {}, { created_at: '2026-10-01 20:00:00', last_modified: '2026-10-01T20:00:05.000Z' });
    assert.equal((await catalogue.rescoreForPlay(round)).payload.difficulty, 40);
  });
});

describe("each genre's spread, refitted from the rounds already rescored", () => {
  /** A metal round rescored the current way, its evidence on it. */
  function rescored(db: ReturnType<typeof openDb>['db'], index: number) {
    db.insert(media)
      .values({
        user_id: null,
        kind: 'blindtest',
        title: `Band ${index} - Song ${index}`,
        category: 'metal',
        answers: '[]',
        payload: JSON.stringify({
          code: `metal${String(index).padStart(6, '0')}`,
          startGuess: 40,
          endGuess: 60,
          startReveal: 59,
          endReveal: 71,
          difficulty: 50,
          difficultyBy: 'auto',
          fame: { looked: true, deezerFans: 1_000 * (index + 1), deezerRank: 100_000 + 10_000 * index, model: 50 }
        })
      })
      .run();
  }

  it('fits a genre with enough of them, and keeps what it cannot fit as it was', () => {
    const db = openDb(':memory:').db;
    for (let index = 0; index < 40; index++) rescored(db, index);
    // Saved earlier by a whole run of the script; no reggae round is rescored yet.
    writeCalibrations(db, new Map([['reggae', { composite: { mean: -1, sd: 1 } }]]));

    refitCalibrations(db);

    const stored = readCalibrations(db);
    assert.ok(stored.get('metal')?.composite, 'metal fitted');
    assert.deepEqual(stored.get('reggae')?.composite, { mean: -1, sd: 1 });
  });
});

describe("Wikidata's list of song videos", () => {
  const SONGS = {
    results: {
      bindings: [{ vid: { value: 'fJ9rUzIMcZQ' }, title: { value: 'Bohemian Rhapsody' }, artist: { value: 'Queen' } }]
    }
  };
  const CHANNELS = { results: { bindings: [] } };

  /** A stock whose QLever refuses the first `refusals` queries, and which records its waits. */
  function stockOver(db: ReturnType<typeof openDb>['db'], refusals: number) {
    const waits: number[] = [];
    let asked = 0;
    const { sources } = fakeSources();
    const stock = createSeedStock({
      sources: {
        ...sources.seeds,
        async sparql(_endpoint, query) {
          asked += 1;
          if (asked <= refusals) return null;
          return query.includes('wdt:P1651') ? SONGS : CHANNELS;
        }
      },
      db,
      clock: fakeClock(),
      wait: async (ms) => {
        waits.push(ms);
      }
    });
    return { stock, waits, asked: () => asked };
  }

  it('is asked again, after longer and longer waits, when QLever refuses', async () => {
    const { db } = openDb(':memory:');
    const { stock, waits } = stockOver(db, 3);

    const index = await stock.videoIndex();

    assert.equal(index?.songs.size, 1);
    assert.deepEqual(waits, [0, 30_000, 60_000]);
    assert.equal(stock.videoIndexStatus().songs, 1);
  });

  it('is kept across a restart, and not fetched again', async () => {
    const { db } = openDb(':memory:');
    await stockOver(db, 0).stock.videoIndex();

    const restarted = stockOver(db, 1_000);
    const index = await restarted.stock.videoIndex();

    assert.equal(index?.songs.size, 1);
    assert.equal(restarted.asked(), 0);
  });

  it('says when it would not come, after six tries over some eighteen minutes', async () => {
    const { db } = openDb(':memory:');
    const { stock, waits } = stockOver(db, 1_000);

    assert.equal(await stock.videoIndex(), null);
    assert.equal(waits.length, 6);
    assert.equal(waits.at(-1), 10 * 60_000);
    assert.ok(stock.videoIndexStatus().failedAt);
  });

  it('is not waited for by a room: it comes back empty at once and loads behind', async () => {
    const { db } = openDb(':memory:');
    const { stock } = stockOver(db, 0);

    assert.equal(await stock.videoIndex(false), null);
    // The fetch it started has landed by the next ask.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal((await stock.videoIndex(false))?.songs.size, 1);
  });
});

describe("Wikidata's list, asked for by force", () => {
  it('is fetched again at once, though the last try failed a minute ago', async () => {
    const { db } = openDb(':memory:');
    let refuse = true;
    let asked = 0;
    const { sources } = fakeSources();
    const stock = createSeedStock({
      sources: {
        ...sources.seeds,
        async sparql(_endpoint, query) {
          asked += 1;
          if (refuse) return null;
          return query.includes('wdt:P1651') ? { results: { bindings: [] } } : { results: { bindings: [] } };
        }
      },
      db,
      clock: fakeClock(),
      wait: async () => {}
    });

    assert.equal(await stock.videoIndex(), null);
    refuse = false;
    const before = asked;

    // Without force, the failure stands for the hour; with it, QLever is asked again.
    assert.equal(await stock.videoIndex(), null);
    assert.equal(asked, before);
    assert.notEqual(await stock.videoIndex(true, true), null);
  });
});
