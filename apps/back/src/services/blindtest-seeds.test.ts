import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  anilistSeeds,
  buildOracle,
  compositionSeeds,
  compositionsQuery,
  curatedPlaylists,
  deezerSeeds,
  editorPlaylists,
  fameWeight,
  genreEditors,
  otherNames,
  planFromSeeds,
  qleverQuery,
  rankFame,
  trackOracleKey,
  weightedSample,
  wikidataSeeds,
  type Seed
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
        popularity: 973060
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

describe('buildOracle', () => {
  it('knows artists, tracks and every name of a work', () => {
    const oracle = buildOracle([
      { artist: 'Orelsan', title: 'Basique', aliases: [], fame: 0.9, year: null },
      { artist: '', title: 'Attack on Titan', aliases: ['Shingeki no Kyojin'], fame: 0.8, year: 2013 }
    ]);
    assert.equal(oracle.artists.get('orelsan'), 0.9);
    assert.equal(oracle.tracks.get(trackOracleKey('OrelSan', 'Basique')), 0.9);
    assert.equal(oracle.works.get('shingeki no kyojin')?.year, 2013);
    assert.deepEqual(oracle.works.get('attack on titan')?.names, ['Attack on Titan', 'Shingeki no Kyojin']);
  });
});
