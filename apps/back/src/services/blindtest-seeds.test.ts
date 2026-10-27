import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { eq } from 'drizzle-orm';

import { openDb } from '../db/open.js';
import { blindtestSeeds } from '../db/schema.js';

import {
  albumGenre,
  anilistSeeds,
  buildOracle,
  byArtistOf,
  CHARTS,
  chartGenre,
  chartYear,
  channelsFor,
  compositionSeeds,
  compositionsQuery,
  createSeedStock,
  curatedPlaylists,
  deezerSeeds,
  editorPlaylists,
  fameWeight,
  genreEditors,
  HIT_FAME,
  otherNames,
  planFromSeeds,
  qleverQuery,
  rankFame,
  songKeys,
  songTitle,
  trackOracleKey,
  uploadsFor,
  uploadsPlaylist,
  videoIndex,
  videosFor,
  weightedSample,
  wikidataSeeds,
  type Seed,
  type SeededGenre
} from './blindtest-seeds.js';

function seed(id: number, artist: string, title: string, fame = 0.5, extra: Partial<Seed> = {}): Seed {
  return { id, artist, title, search: '', aliases: [], year: null, fame, ...extra };
}

/** A fixed sequence, so a weighted draw can be asserted on. */
function sequence(...values: number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length] ?? 0.5;
}

describe('rankFame', () => {
  it('ranks by popularity, 1 for the most famous', () => {
    const ranked = rankFame([
      { name: 'b', popularity: 10 },
      { name: 'a', popularity: 900 },
      { name: 'c', popularity: 1 }
    ]);
    assert.deepEqual(
      ranked.map((entry) => [entry.name, entry.fame]),
      [
        ['a', 1],
        ['b', 0.5],
        ['c', 0]
      ]
    );
  });

  it('gives a lone seed the middle', () => {
    assert.equal(rankFame([{ popularity: 3 }])[0]?.fame, 0.5);
  });
});

describe('weightedSample', () => {
  it('never returns an item twice, nor more than asked', () => {
    const picked = weightedSample([1, 2, 3, 4, 5], 3, () => 1);
    assert.equal(picked.length, 3);
    assert.equal(new Set(picked).size, 3);
  });

  it('favours the heavy item on equal luck', () => {
    const picked = weightedSample(['light', 'heavy'], 1, (item) => (item === 'heavy' ? 10 : 0.1), sequence(0.5, 0.5));
    assert.deepEqual(picked, ['heavy']);
  });
});

describe('fameWeight', () => {
  it('favours the famous with no window', () => {
    assert.ok(fameWeight(1) > fameWeight(0));
  });

  it('aims at the window when there is one', () => {
    // Difficulty 80 to 100 is a room asking for deep cuts: low fame.
    const hard = { min: 80, max: 100 };
    assert.ok(fameWeight(0.1, hard) > fameWeight(0.9, hard));
    const easy = { min: 0, max: 20 };
    assert.ok(fameWeight(0.9, easy) > fameWeight(0.1, easy));
  });
});

describe('fameWeight on a full window', () => {
  it('reads the default 0 to 100 as no preference, not as a target of 50', () => {
    const full = { min: 0, max: 100 };
    assert.equal(fameWeight(1, full), fameWeight(1));
    assert.equal(fameWeight(0, full), fameWeight(0));
    assert.ok(fameWeight(1, full) > fameWeight(0.5, full));
  });
});

describe('otherNames', () => {
  it('keeps typeable, distinct names other than the title', () => {
    assert.deepEqual(
      otherNames('Attack on Titan', ['Shingeki no Kyojin', '進撃の巨人', 'attack on titan', 'AoT', null]),
      ['Shingeki no Kyojin', 'AoT']
    );
  });
});

describe('Deezer', () => {
  it('reads only curated playlists of a useful size', () => {
    const found = curatedPlaylists({
      data: [
        { id: 1, title: 'Rap FR', nb_tracks: 80, user: { name: 'Narjes - Deezer Rap & R&B Editrice France' } },
        { id: 2, title: 'ma soirée', nb_tracks: 300, user: { name: 'kevin93' } },
        { id: 3, title: 'Tiny', nb_tracks: 5, user: { name: 'Deezer Best Of' } },
        { id: 4, title: 'Label list', nb_tracks: 90, user: { name: 'Filtr France' } }
      ]
    });
    assert.deepEqual(
      found.map((playlist) => playlist.id),
      [1, 4]
    );
  });

  it('turns tracks into seeds and skips the unreadable', () => {
    const seeds = deezerSeeds({
      data: [
        { id: 10, title: 'Tu connais (Remix)', title_short: 'Tu connais', rank: 973060, artist: { name: 'Werenoi' } },
        { id: 11, title: 'Gone', rank: 5, readable: false, artist: { name: 'Nobody' } },
        { id: 12, title: '', rank: 5, artist: { name: 'Blank' } }
      ]
    });
    assert.deepEqual(seeds, [
      {
        source: 'deezer',
        sourceKey: '10',
        artist: 'Werenoi',
        title: 'Tu connais',
        search: '',
        aliases: [],
        year: null,
        popularity: 973060,
        duration: null
      }
    ]);
  });

  it('reads a playlist only when its title names the genre', () => {
    const raw = {
      data: [
        { id: 1, title: 'Rap Français 2024', nb_tracks: 80, user: { name: 'Deezer Best Of' } },
        { id: 2, title: 'Hits du moment', nb_tracks: 80, user: { name: 'Deezer Best Of' } }
      ]
    };
    assert.deepEqual(
      curatedPlaylists(raw, /rap|hip[- ]?hop/i).map((playlist) => playlist.id),
      [1]
    );
  });

  it('skips an artist whose name normalises to nothing', () => {
    // The planner groups by the normalised name, so "¥$" could never be
    // searched, and one of them kept its genre from ever recycling.
    const seeds = deezerSeeds({
      data: [
        { id: 1, title: 'Carnival', rank: 5, artist: { name: '¥$' } },
        { id: 2, title: 'HUMBLE.', rank: 5, artist: { name: 'Kendrick Lamar' } }
      ]
    });
    assert.deepEqual(
      seeds.map((entry) => entry.artist),
      ['Kendrick Lamar']
    );
  });

  it('skips a release credited as its own artist', () => {
    const seeds = deezerSeeds({
      data: [
        {
          id: 1,
          title: 'Shake Ya Tailfeather',
          rank: 5,
          artist: { name: 'Bad Boys 2 The Original Motion Picture Soundtrack featuring P.Diddy, Nelly and Murphy Lee' }
        },
        { id: 2, title: 'Hot In Herre', rank: 5, artist: { name: 'Nelly' } }
      ]
    });
    assert.deepEqual(
      seeds.map((entry) => entry.artist),
      ['Nelly']
    );
  });

  it("follows only the genre's own editors", () => {
    const raw = {
      data: [
        { id: 1, title: '90s Rap', nb_tracks: 50, user: { id: 10, name: 'Ayoub - Deezer Rap Editor' } },
        { id: 2, title: 'Rap du moment', nb_tracks: 50, user: { id: 20, name: 'Deezer Best Of' } },
        { id: 3, title: 'Rap FR', nb_tracks: 50, user: { id: 30, name: 'Yannick - Deezer Deutschland Editor' } }
      ]
    };
    assert.deepEqual(genreEditors(raw, /rap|hip[- ]?hop/i), [{ id: 10, name: 'Ayoub - Deezer Rap Editor' }]);
  });

  it('reads everything an editor made, and only on-genre titles from anyone else', () => {
    const editor = 'Rudy - Deezer K-Pop Editor';
    const raw = {
      data: [
        { id: 1, title: 'stargirls☆', nb_tracks: 50, creator: { name: editor } },
        { id: 2, title: 'This is BTS', nb_tracks: 40, creator: { name: 'Deezer Artist Editor' } },
        { id: 3, title: 'K-Pop Hits', nb_tracks: 40, creator: { name: 'Deezer Artist Editor' } },
        { id: 4, title: 'Coups de coeur', nb_tracks: 40, creator: { name: editor }, is_loved_track: true }
      ]
    };
    assert.deepEqual(
      editorPlaylists(raw, editor, /k-?pop/i).map((playlist) => playlist.id),
      [1, 3]
    );
  });

  it('survives an error body', () => {
    assert.deepEqual(deezerSeeds({ error: { code: 4 } }), []);
    assert.deepEqual(curatedPlaylists(null), []);
  });
});

describe('AniList', () => {
  it('names the work in English when it can, with the rest as aliases', () => {
    const { seeds, more } = anilistSeeds({
      data: {
        Page: {
          pageInfo: { hasNextPage: true },
          media: [
            {
              id: 16498,
              popularity: 900000,
              title: { romaji: 'Shingeki no Kyojin', english: 'Attack on Titan', native: '進撃の巨人' },
              synonyms: ["L'Attaque des Titans"],
              startDate: { year: 2013 }
            }
          ]
        }
      }
    });
    assert.equal(more, true);
    assert.equal(seeds[0]?.title, 'Attack on Titan');
    assert.deepEqual(seeds[0]?.aliases, ['Shingeki no Kyojin', "L'Attaque des Titans"]);
    assert.equal(seeds[0]?.year, 2013);
  });
});

describe('Wikidata', () => {
  it('shows the French name and searches the English one', () => {
    const seeds = wikidataSeeds({
      results: {
        bindings: [
          {
            item: { value: 'http://www.wikidata.org/entity/Q47703' },
            links: { value: '132' },
            year: { value: '1972' },
            fr: { value: 'Le Parrain' },
            en: { value: 'The Godfather' }
          },
          // A name every language shares lives under `mul` only now.
          {
            item: { value: 'http://www.wikidata.org/entity/Q49740' },
            links: { value: '156' },
            year: { value: '2011' },
            mul: { value: 'Minecraft' }
          },
          { item: { value: 'http://www.wikidata.org/entity/Q1' }, links: { value: '10' } }
        ]
      }
    });
    assert.equal(seeds.length, 2);
    assert.deepEqual(
      { title: seeds[0]?.title, search: seeds[0]?.search, aliases: seeds[0]?.aliases, year: seeds[0]?.year },
      { title: 'Le Parrain', search: 'The Godfather', aliases: ['The Godfather'], year: 1972 }
    );
    assert.equal(seeds[1]?.title, 'Minecraft');
    assert.equal(seeds[1]?.popularity, 156);
  });

  it('asks for a composer only where the genre wants one', () => {
    const films = qleverQuery({
      kind: 'wikidata',
      types: ['Q11424'],
      minLinks: 30,
      dateProperty: 'P577',
      requireComposer: true
    });
    const games = qleverQuery({ kind: 'wikidata', types: ['Q7889'], minLinks: 20, dateProperty: 'P577' });
    assert.match(films, /wdt:P86/);
    assert.doesNotMatch(games, /wdt:P86/);
    assert.match(games, />= 20/);
  });
});

describe('classical works', () => {
  it('files a work under its composer, shown in French and searched in English', () => {
    const seeds = compositionSeeds({
      results: {
        bindings: [
          {
            item: { value: 'http://www.wikidata.org/entity/Q1' },
            links: { value: '63' },
            fr: { value: 'Le Lac des cygnes' },
            en: { value: 'Swan Lake' },
            cfr: { value: 'Piotr Ilitch Tchaïkovski' },
            cen: { value: 'Pyotr Ilyich Tchaikovsky' }
          },
          // The same work again with a second composer: the first one stays.
          {
            item: { value: 'http://www.wikidata.org/entity/Q1' },
            links: { value: '63' },
            fr: { value: 'Le Lac des cygnes' },
            cfr: { value: 'Quelqu’un d’autre' }
          },
          // No composer name at all: nothing to ask for.
          { item: { value: 'http://www.wikidata.org/entity/Q2' }, links: { value: '20' }, fr: { value: 'Anonyme' } }
        ]
      }
    });
    assert.equal(seeds.length, 1);
    assert.deepEqual(
      { artist: seeds[0]?.artist, title: seeds[0]?.title, search: seeds[0]?.search, aliases: seeds[0]?.aliases },
      {
        artist: 'Piotr Ilitch Tchaïkovski',
        title: 'Le Lac des cygnes',
        search: 'Pyotr Ilyich Tchaikovsky',
        aliases: ['Swan Lake']
      }
    );
  });

  it('leaves anthems and songs out of the query', () => {
    const query = compositionsQuery({ kind: 'wikidata-compositions', minLinks: 8, bornBefore: 1915 });
    assert.match(query, /wd:Q23691/);
    assert.match(query, /< 1915/);
  });

  it('searches a composer under the name YouTube uses', () => {
    const classical = { id: 'classique', answerShape: 'artist-title' as const };
    const [search] = planFromSeeds(
      classical,
      [seed(1, 'Piotr Ilitch Tchaïkovski', 'Le Lac des cygnes', 0.9, { search: 'Pyotr Ilyich Tchaikovsky' })],
      1
    );
    assert.equal(search?.query, '"Pyotr Ilyich Tchaikovsky"');
    assert.equal(search?.hint, 'Piotr Ilitch Tchaïkovski');
  });
});

describe('planFromSeeds', () => {
  const music = { id: 'rap-fr', answerShape: 'artist-title' as const, seeds: [] };

  it('searches music by artist, several to a search, with all their tracks riding along', () => {
    const seeds = [
      seed(1, 'Booba', 'DKR', 0.9),
      seed(2, 'Booba', 'Validée', 0.8),
      seed(3, 'Nekfeu', 'On verra', 0.7),
      seed(4, 'PNL', 'Au DD', 0.95)
    ];
    const plan = planFromSeeds(music, seeds, 1, undefined, () => 0.5);
    assert.equal(plan.length, 1);
    const [search] = plan;
    assert.equal(search?.limit, 50);
    // One phrase per artist, joined by YouTube's OR.
    assert.equal(search?.query.split('|').length, 3);
    assert.match(search?.query ?? '', /"Booba"/);
    // Both Booba tracks are spent with the artist.
    assert.deepEqual(search?.seeds.map((entry) => entry.id).sort(), [1, 2, 3, 4]);
  });

  it('searches works by name with the genre suffix', () => {
    const anime = { id: 'anime-op', answerShape: 'work' as const, seeds: [], seedSuffix: 'opening' };
    const seeds = [seed(1, '', 'Naruto', 0.9, { search: 'Naruto' }), seed(2, '', 'Bleach', 0.8, { search: 'Bleach' })];
    const [search] = planFromSeeds(anime, seeds, 1, undefined, () => 0.5);
    assert.match(search?.query ?? '', /^"(Naruto|Bleach)"\|"(Naruto|Bleach)" opening$/);
    assert.equal(search?.hint.split(', ').length, 2);
  });

  it('puts the suffix inside each phrase when the genre asks for it', () => {
    // The shape that came back as openings rather than scene clips on the live API.
    const anime = { id: 'anime-op', answerShape: 'work' as const, seedSuffix: 'opening', seedSuffixInPhrase: true };
    const seeds = [seed(1, '', 'Naruto', 0.9, { search: 'Naruto' }), seed(2, '', 'Bleach', 0.8, { search: 'Bleach' })];
    const [search] = planFromSeeds(anime, seeds, 1, undefined, () => 0.5);
    assert.equal(search?.query, '"Naruto opening"|"Bleach opening"');
  });

  it('keeps quotes in a name from ending the phrase', () => {
    const [search] = planFromSeeds(music, [seed(1, 'The "Real" Band', 'Song')], 1);
    assert.equal(search?.query, '"The Real Band"');
  });

  it('plans nothing from nothing', () => {
    assert.deepEqual(planFromSeeds(music, [], 3), []);
    assert.deepEqual(planFromSeeds(music, [seed(1, 'A', 'B')], 0), []);
  });
});

describe("planFromSeeds on an editor's genre", () => {
  const rock = {
    id: 'rock',
    answerShape: 'artist-title' as const,
    seeds: [{ kind: 'deezer' as const, playlistQueries: [], titleMatch: /rock/i }]
  };
  const seeds = [
    seed(1, 'AC/DC', 'Highway to Hell', 0.99),
    seed(2, 'AC/DC', 'Highway to Hell', 0.95),
    seed(3, 'The Rolling Stones', 'Paint It, Black', 0.97),
    seed(4, 'Queen', 'Under Pressure (feat. David Bowie)', 0.93),
    seed(5, 'AC/DC', 'Realize', 0.5),
    seed(6, 'Clairo', 'Sofia', 0.8)
  ];

  it('searches the famous songs as themselves first, and the rest by artist without them', () => {
    const [hits, artists, ...more] = planFromSeeds(rock, seeds, 2, undefined, () => 0.5);

    assert.equal(hits?.aim, 'hits');
    assert.deepEqual(hits?.query.split('|').sort(), [
      '"AC/DC Highway to Hell"',
      '"Queen Under Pressure"',
      '"The Rolling Stones Paint It, Black"'
    ]);
    // One song under two Deezer ids is searched once and spent together.
    assert.deepEqual(hits?.seeds.map((entry) => entry.id).sort(), [1, 2, 3, 4]);

    assert.equal(artists?.aim, 'artists');
    assert.deepEqual(artists?.seeds.map((entry) => entry.id).sort(), [5, 6]);
    assert.deepEqual(more, []);
  });

  it('leaves the hits out of a search for a room that only wants hard rounds', () => {
    const plan = planFromSeeds(rock, seeds, 2, { min: 60, max: 100 }, () => 0.5);

    assert.deepEqual(
      plan.map((search) => search.aim),
      ['artists']
    );
    assert.deepEqual(plan[0]?.seeds.map((entry) => entry.id).sort(), [5, 6]);
  });
});

describe('songKeys', () => {
  const same = (left: [string, string], right: [string, string]) =>
    songKeys(...left).some((key) => songKeys(...right).includes(key));

  it('knows one song under the spellings a catalogue and a model give it', () => {
    assert.ok(same(['The Rolling Stones', "(I Can't Get No) Satisfaction"], ['Rolling Stones', 'Satisfaction']));
    assert.ok(same(['The Rolling Stones', 'Paint It, Black'], ['The Rolling Stones', 'Paint It Black']));
    assert.ok(same(['Queen', 'Under Pressure'], ['Queen & David Bowie', 'Under Pressure - Remastered 2011']));
    assert.ok(!same(['Queen', 'Under Pressure'], ['Queen', 'Radio Ga Ga']));
    assert.ok(!same(['Queen', 'Under Pressure'], ['Pentatonix', 'Under Pressure']));
  });

  it('has nothing to say about a work', () => {
    assert.deepEqual(songKeys('', 'Naruto'), []);
  });
});

describe("planFromSeeds with hits' videos known", () => {
  const rock = {
    id: 'rock',
    answerShape: 'artist-title' as const,
    seeds: [{ kind: 'deezer' as const, playlistQueries: [], titleMatch: /rock/i }]
  };

  it('looks the known ones up first, without a query, and searches the rest', () => {
    const seeds = [
      seed(1, 'AC/DC', 'Highway to Hell', 0.99, { videos: ['l482T0yNkeo'] }),
      seed(2, 'Queen', 'Bohemian Rhapsody', 0.98, { videos: ['fJ9rUzIMcZQ', 'bohemian002'] }),
      seed(3, 'The Rolling Stones', 'Paint It, Black', 0.97, { videos: [] })
    ];

    const [looked, searched, ...more] = planFromSeeds(rock, seeds, 2, undefined, () => 0.5);

    assert.equal(looked?.query, '');
    assert.deepEqual(looked?.videoIds?.sort(), ['bohemian002', 'fJ9rUzIMcZQ', 'l482T0yNkeo']);
    assert.deepEqual(looked?.seeds.map((entry) => entry.id).sort(), [1, 2]);
    assert.equal(searched?.query, '"The Rolling Stones Paint It, Black"');
    assert.equal(searched?.videoIds, undefined);
    assert.deepEqual(more, []);
  });
});

describe('videoIndex', () => {
  const index = videoIndex(
    {
      results: {
        bindings: [
          { vid: { value: 'fJ9rUzIMcZQ' }, title: { value: 'Bohemian Rhapsody' }, artist: { value: 'Queen' } },
          { vid: { value: 'not a video id' }, title: { value: 'Radio Ga Ga' }, artist: { value: 'Queen' } }
        ]
      }
    },
    { results: { bindings: [{ channel: { value: 'UCiMhD4jzUqG-IgPzUmmytRQ' }, name: { value: 'Queen' } }] } }
  );

  it("finds a song's video under the names a catalogue gives it", () => {
    assert.ok(index);
    assert.deepEqual(videosFor(index, 'Queen', 'Bohemian Rhapsody (Remastered 2011)'), ['fJ9rUzIMcZQ']);
    assert.deepEqual(videosFor(index, 'Queen', 'Radio Ga Ga'), []);
  });

  it("finds an artist's channel by their whole name only", () => {
    assert.ok(index);
    assert.deepEqual(channelsFor(index, 'Queen'), ['UCiMhD4jzUqG-IgPzUmmytRQ']);
    assert.deepEqual(channelsFor(index, 'Queen & David Bowie'), []);
  });

  it('is nothing when an answer is not one', () => {
    assert.equal(videoIndex(null, { results: { bindings: [] } }), null);
  });
});

describe('uploadsFor', () => {
  it('keeps the uploads that are the song, the official one first, and no live take of it', () => {
    const uploads = [
      { videoId: 'knebworth01', title: 'Oasis - Live Forever (Live at Knebworth)' },
      { videoId: 'teaser00001', title: 'Live Forever - teaser' },
      { videoId: 'wonderwall1', title: 'Oasis - Wonderwall' },
      { videoId: 'lyrics00001', title: 'Oasis - Live Forever (Lyrics)' },
      { videoId: 'official001', title: 'Oasis - Live Forever (Official Video)' }
    ];

    assert.deepEqual(uploadsFor(uploads, 'Live Forever'), ['official001', 'lyrics00001']);
  });

  it("answers with the song's own name, without what the release added", () => {
    assert.equal(songTitle('Under Pressure (feat. David Bowie)'), 'Under Pressure');
    assert.equal(songTitle("(I Can't Get No) Satisfaction"), "(I Can't Get No) Satisfaction");
  });

  it('reads a channel as its uploads playlist', () => {
    assert.equal(uploadsPlaylist('UCiMhD4jzUqG-IgPzUmmytRQ'), 'UUiMhD4jzUqG-IgPzUmmytRQ');
  });
});

describe('byArtistOf', () => {
  it('reads a duet as its lead artist', () => {
    const searched = [{ artist: 'Queen' }, { artist: 'The Rolling Stones' }];
    assert.ok(byArtistOf('Queen & David Bowie', searched));
    assert.ok(byArtistOf('Rolling Stones', searched));
    assert.ok(!byArtistOf('Pentatonix', searched));
  });
});

describe('buildOracle', () => {
  it('knows artists, tracks and every name of a work', () => {
    const oracle = buildOracle([
      { artist: 'Orelsan', title: 'Basique', aliases: [], fame: 0.9, year: null },
      { artist: '', title: 'Attack on Titan', aliases: ['Shingeki no Kyojin'], fame: 0.8, year: 2013 }
    ]);
    assert.equal(oracle.artists.get('orelsan'), 0.9);
    assert.deepEqual(oracle.tracks.get(trackOracleKey('OrelSan', 'Basique')), { fame: 0.9, duration: null });
    assert.equal(oracle.works.get('shingeki no kyojin')?.year, 2013);
    assert.deepEqual(oracle.works.get('attack on titan')?.names, ['Attack on Titan', 'Shingeki no Kyojin']);
  });
});

describe('the charts', () => {
  it('reads the yearly lists from 1990 on', () => {
    assert.equal(chartYear('Top Hits 1995'), 1995);
    assert.equal(chartYear('Top Hits 2023'), 2023);
    assert.equal(chartYear('Top Hits 1985'), null);
    assert.equal(chartYear('Best of Hits 2016'), null);
  });

  it('reads the French decade lists, and not the American ones or the eighties', () => {
    const french = [
      'Variété Française des années 90',
      'Années 90 : variété française | Tubes 90s',
      'Bleu blanc hits 90',
      'Musique française années 90',
      'Tubes français des années 70 80 90 2000 2010 2020'
    ];
    for (const title of french) assert.ok(CHARTS.frenchTitle.test(title), title);
    for (const title of ['Le Rap US des années 90', 'Variété française années 80', 'Les tubes des années 90']) {
      assert.ok(!CHARTS.frenchTitle.test(title), title);
    }
  });

  it("reads an album's genre", () => {
    assert.equal(albumGenre({ genre_id: 116 }), 116);
    assert.equal(albumGenre({ genre_id: -1 }), null);
    assert.equal(albumGenre({ error: { code: 800 } }), null);
  });

  const genres = new Set(['pop', 'rock', 'metal', 'electro', 'chanson-fr', 'rap-fr', 'rap-us']);

  it("files a song where most of its artist's seeds are", () => {
    const artists = new Map([
      [
        'guns n roses',
        new Map([
          ['rock', 11],
          ['pop', 5],
          ['metal', 4]
        ])
      ]
    ]);
    assert.equal(chartGenre("Guns N' Roses", 'world', artists, 152, genres), 'rock');
  });

  it("ignores a genre that takes no hits, where most of the artist's seeds may be", () => {
    const artists = new Map([['beethoven', new Map([['classique', 40]])]]);
    assert.equal(chartGenre('Beethoven', 'world', artists, null, genres), 'pop');
  });

  it("goes by the album's genre for an artist no genre knows, rap by the list's side", () => {
    const none = new Map<string, Map<string, number>>();
    assert.equal(chartGenre('Mousse T.', 'world', none, 113, genres), 'electro');
    assert.equal(chartGenre('MC Solaar', 'france', none, 116, genres), 'rap-fr');
    assert.equal(chartGenre('Coolio', 'world', none, 116, genres), 'rap-us');
  });

  it('falls back on pop, or French chanson for a French list', () => {
    const none = new Map<string, Map<string, number>>();
    assert.equal(chartGenre('Enigma', 'world', none, 132, genres), 'pop');
    assert.equal(chartGenre('Lorie', 'france', none, null, genres), 'chanson-fr');
    assert.equal(chartGenre('Lorie', 'france', none, null, new Set(['rock'])), null);
  });
});

describe('the chart harvest', () => {
  const GENRES: SeededGenre[] = ['pop', 'rock', 'metal', 'electro', 'chanson-fr', 'rap-fr', 'rap-us'].map((id) => ({
    id,
    answerShape: 'artist-title',
    seeds: [{ kind: 'deezer', playlistQueries: [], titleMatch: /x/ }]
  }));

  const LISTS: Record<number, { artist: string; title: string; album: number }[]> = {
    1: [
      { artist: "Guns N' Roses", title: 'November Rain', album: 100 },
      { artist: 'Enigma', title: 'Sadeness', album: 200 },
      { artist: 'Mousse T.', title: 'Horny', album: 300 }
    ],
    2: [{ artist: 'Kim Wilde', title: 'Cambodia', album: 600 }],
    10: [
      { artist: 'Lorie', title: 'Près de moi', album: 400 },
      { artist: 'MC Solaar', title: 'Bouge de là', album: 500 },
      { artist: "Guns N' Roses", title: 'November Rain', album: 100 }
    ]
  };
  const ALBUMS: Record<number, number> = { 200: 132, 300: 113, 500: 116 };

  function stockOver(db: ReturnType<typeof openDb>['db']) {
    const albums: number[] = [];
    const stock = createSeedStock({
      sources: {
        deezer: {
          async searchPlaylists(query) {
            if (query !== CHARTS.frenchQueries[0]) return { data: [] };
            return {
              data: [
                { id: 10, title: 'Variété Française des années 90', nb_tracks: 99, user: { name: 'Filtr France' } },
                { id: 11, title: 'Le Rap US des années 90', nb_tracks: 99, user: { name: 'Digster France' } }
              ]
            };
          },
          async userPlaylists(userId) {
            if (userId !== CHARTS.yearlyEditor) return { data: [] };
            return {
              data: [
                { id: 1, title: 'Top Hits 1995', nb_tracks: 50, creator: { name: 'Deezer Best Of' } },
                { id: 2, title: 'Top Hits 1985', nb_tracks: 50, creator: { name: 'Deezer Best Of' } }
              ]
            };
          },
          async playlistTracks(playlistId) {
            return {
              data: (LISTS[playlistId] ?? []).map((track, index) => ({
                id: playlistId * 100 + index,
                title: track.title,
                rank: 900_000 - index,
                artist: { name: track.artist },
                album: { id: track.album }
              }))
            };
          },
          async album(albumId) {
            albums.push(albumId);
            return { genre_id: ALBUMS[albumId] ?? 0 };
          }
        },
        anilist: async () => null,
        sparql: async () => null
      },
      db,
      clock: { now: () => Date.parse('2026-10-27T12:00:00Z') }
    });
    return { stock, albums };
  }

  function seedOf(db: ReturnType<typeof openDb>['db'], genreId: string, artist: string, count: number) {
    for (let index = 0; index < count; index++) {
      db.insert(blindtestSeeds)
        .values({
          genre_id: genreId,
          source: 'deezer',
          source_key: `${artist}-${genreId}-${index}`,
          artist,
          title: `${index}`
        })
        .run();
    }
  }

  function charted(db: ReturnType<typeof openDb>['db']) {
    return db
      .select()
      .from(blindtestSeeds)
      .where(eq(blindtestSeeds.source, 'chart'))
      .all()
      .map((row) => [row.artist, row.genre_id, row.fame >= HIT_FAME] as const)
      .sort();
  }

  it('files every song once, as a hit, where its artist is or by its album', async () => {
    const { db } = openDb(':memory:');
    seedOf(db, 'rock', "Guns N' Roses", 3);
    seedOf(db, 'pop', "Guns N' Roses", 1);
    const { stock, albums } = stockOver(db);

    assert.equal(await stock.harvestCharts(GENRES), 5);

    assert.deepEqual(charted(db), [
      ['Enigma', 'pop', true],
      ["Guns N' Roses", 'rock', true],
      ['Lorie', 'chanson-fr', true],
      ['MC Solaar', 'rap-fr', true],
      ['Mousse T.', 'electro', true]
    ]);
    // Not for an artist the seeds already place, and nothing from 1985 or the American list.
    assert.deepEqual(albums.sort(), [200, 300, 400, 500]);
  });

  it('is fetched again a month later, not the next day', async () => {
    const { db } = openDb(':memory:');
    let now = Date.parse('2026-10-27T12:00:00Z');
    let asked = 0;
    const { stock } = stockOver(db);
    const counting = createSeedStock({
      sources: {
        deezer: {
          searchPlaylists: async () => ({ data: [] }),
          playlistTracks: async () => ({ data: [] }),
          album: async () => ({}),
          async userPlaylists() {
            asked += 1;
            return { data: [] };
          }
        },
        anilist: async () => null,
        sparql: async () => null
      },
      db,
      clock: { now: () => now }
    });
    await stock.harvestCharts(GENRES);

    now += 2 * 24 * 60 * 60 * 1000;
    // A genre the warm did not start queues behind everything it did.
    const LAST: SeededGenre = { ...GENRES[0]!, id: 'last' };
    counting.warm(GENRES);
    await counting.harvest(LAST);
    assert.equal(asked, 0);

    now += 30 * 24 * 60 * 60 * 1000;
    counting.warm(GENRES);
    await counting.harvest(LAST);
    assert.equal(asked, 1);
  });

  it('moves a song whose artist has since gone to another genre', async () => {
    const { db } = openDb(':memory:');
    seedOf(db, 'rock', "Guns N' Roses", 3);
    await stockOver(db).stock.harvestCharts(GENRES);

    seedOf(db, 'metal', "Guns N' Roses", 5);
    await stockOver(db).stock.harvestCharts(GENRES);

    assert.deepEqual(
      charted(db).filter(([artist]) => artist === "Guns N' Roses"),
      [["Guns N' Roses", 'metal', true]]
    );
  });
});
