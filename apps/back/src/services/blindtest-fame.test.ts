import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sql } from 'drizzle-orm';

import { openDb } from '../db/open.js';
import {
  animeThemeFor,
  lookupFame,
  noFameSources,
  themeSlotOf,
  workNameVariants,
  type FameSources,
  type WikidataEntity
} from './blindtest-fame.js';

/**
 * The fame lookups against a small world written here.
 *
 * Every catalogue is a fake that answers from the world, and counts what it was
 * asked, so a test can say both what was found and how: by id where an id was
 * there to follow, never by a guessed name where it was not.
 */

const DAY = 24 * 60 * 60 * 1000;

function entity(id: string, fields: Partial<WikidataEntity> = {}): WikidataEntity {
  return { id, sitelinks: {}, claims: {}, labels: {}, ...fields };
}

/** Sitelinks for this many Wikipedias, French and English among them when asked. */
function wikipedias(count: number, titles: { fr?: string; en?: string } = {}): Record<string, string> {
  const links: Record<string, string> = { commonswiki: 'Category:x', enwikiquote: 'x' };
  // Letters only, like real language codes: xaa, xab... never fr or en.
  const code = (index: number) =>
    `x${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`;
  for (let index = 0; index < count; index++) links[`${code(index)}wiki`] = 'x';
  if (titles.fr) links.frwiki = titles.fr;
  if (titles.en) links.enwiki = titles.en;
  return links;
}

function world(overrides: Partial<FameSources> = {}) {
  const asked: string[] = [];
  const counted =
    <A extends unknown[], R>(name: string, run: (...args: A) => Promise<R>) =>
    (...args: A) => {
      asked.push(`${name}:${args.map((arg) => JSON.stringify(arg)).join(',')}`);
      return run(...args);
    };
  const base: FameSources = {
    ...noFameSources,
    deezerTracks: async () => [],
    deezerArtists: async () => [],
    deezerArtist: async () => null,
    wikidataByClaim: async () => [],
    wikidataSearch: async () => [],
    wikidataEntities: async () => [],
    pageviews: async () => 0,
    lastfmListeners: async () => null,
    anilist: async () => [],
    tmdbVotes: async () => null,
    animeThemes: async () => null,
    ...overrides
  };
  // Every request is counted; `configured` reads the settings and is not one.
  const sources = Object.fromEntries(
    Object.entries(base).map(([name, run]) => [
      name,
      name === 'configured' ? run : counted(name, run as (...args: unknown[]) => Promise<unknown>)
    ])
  ) as unknown as FameSources;
  return { sources, asked };
}

describe('a song’s fame', () => {
  it('follows Deezer’s artist id into Wikidata, and prefers the answer’s own artist to the band', async () => {
    // As Deezer has it: under the band's name, beside covers by other people.
    const { sources } = world({
      deezerTracks: async () => [
        { id: 9, title: 'Could You Be Loved', rank: 300_000, artist: { id: 77, name: 'Reggae Cover Band' } },
        {
          id: 8,
          title: 'Could You Be Loved (Live)',
          rank: 420_000,
          artist: { id: 719, name: 'Bob Marley & The Wailers' }
        },
        { id: 7, title: 'Could You Be Loved', rank: 910_000, artist: { id: 719, name: 'Bob Marley & The Wailers' } }
      ],
      deezerArtist: async (id) => (id === 719 ? { id, name: 'Bob Marley & The Wailers', fans: 12_303_381 } : null),
      // Deezer's id leads to the band's item; the man has his own, far better covered.
      wikidataByClaim: async (property, value) => (property === 'P2722' && value === '719' ? ['Q2525354'] : []),
      wikidataSearch: async (name) => (name === 'Bob Marley' ? ['Q409'] : []),
      wikidataEntities: async (ids) =>
        ids.flatMap((id) =>
          id === 'Q409'
            ? [
                entity('Q409', {
                  labels: { en: 'Bob Marley' },
                  claims: { P434: ['ed2ac1e9'] },
                  sitelinks: wikipedias(150, { fr: 'Bob Marley', en: 'Bob Marley' })
                })
              ]
            : id === 'Q2525354'
              ? [entity('Q2525354', { sitelinks: wikipedias(22, { en: 'Bob Marley and the Wailers' }) })]
              : []
        ),
      pageviews: async (language) => (language === 'fr' ? 80_000 : 600_000),
      lastfmListeners: async () => 2_000_000
    });

    const facts = await lookupFame(openDb().db, sources, {
      shape: 'artist-title',
      artist: 'Bob Marley',
      title: 'Could You Be Loved'
    });

    assert.equal(facts.deezerRank, 910_000, 'the best-ranked version, by the artist and band');
    assert.equal(facts.deezerFans, 12_303_381);
    assert.equal(facts.ids.wikidata, 'Q409');
    // Wikipedias only: not Commons, not Wikiquote.
    assert.equal(facts.wikiLanguages, 152);
    assert.deepEqual([facts.frPageviews, facts.enPageviews, facts.lastfmListeners], [80_000, 600_000, 2_000_000]);
  });

  it('never searches Wikidata by name when Deezer credits the answer’s own artist', async () => {
    const { sources, asked } = world({
      deezerTracks: async () => [
        { id: 1, title: 'Enter Sandman (Remastered 2021)', rank: 927_758, artist: { id: 119, name: 'Metallica' } }
      ],
      deezerArtist: async (id) => ({ id, name: 'Metallica', fans: 8_173_693 }),
      wikidataByClaim: async () => ['Q15920'],
      wikidataEntities: async () => [
        entity('Q15920', { sitelinks: wikipedias(121, { fr: 'Metallica', en: 'Metallica' }) })
      ]
    });
    const facts = await lookupFame(openDb().db, sources, {
      shape: 'artist-title',
      artist: 'Metallica',
      title: 'Enter Sandman'
    });
    assert.equal(facts.deezerRank, 927_758, 'a remaster is the same song');
    assert.ok(!asked.some((call) => call.startsWith('wikidataSearch')), 'found by id, never by name');
  });

  it('finds the main artist of a credit that names several', async () => {
    const { sources } = world({
      deezerArtists: async (name) =>
        name === 'QQ'
          ? [
              { id: 13904761, name: 'Q.Q', fans: 20 },
              { id: 63934, name: 'QQ', fans: 7_437 }
            ]
          : [{ id: 5, name: 'IQ', fans: 50_000 }]
    });
    const facts = await lookupFame(openDb().db, sources, { shape: 'artist-title', artist: 'QQ, IQ', title: 'Movie' });
    assert.equal(facts.deezerFans, 7_437);
  });

  it('takes the most followed of two artists with the very same name', async () => {
    // As Deezer has it: a two-fan namesake listed before the composer himself.
    const { sources } = world({
      deezerArtists: async () => [
        { id: 419864812, name: 'Antonio Vivaldi', fans: 2 },
        { id: 4081, name: 'Antonio Vivaldi', fans: 819_482 }
      ]
    });
    const facts = await lookupFame(openDb().db, sources, {
      shape: 'artist-title',
      artist: 'Antonio Vivaldi',
      title: "L'Été"
    });
    assert.equal(facts.deezerFans, 819_482);
  });

  it('reads a classical piece’s own Wikipedias, not its composer’s', async () => {
    const { sources } = world({
      deezerArtists: async () => [{ id: 4081, name: 'Antonio Vivaldi', fans: 819_482 }],
      wikidataByClaim: async (property, value) => (property === 'P2722' && value === '4081' ? ['Q1340'] : []),
      wikidataSearch: async (name) => (name === "L'Été" ? ['Q50', 'Q51'] : []),
      wikidataEntities: async (ids) =>
        ids.flatMap((id) => {
          if (id === 'Q1340') return [entity('Q1340', { sitelinks: wikipedias(154, { fr: 'Antonio Vivaldi' }) })];
          // A painting of that name, and the concerto, whose composer is Vivaldi.
          if (id === 'Q50') return [entity('Q50', { claims: { P31: ['Q3305213'] }, sitelinks: wikipedias(80) })];
          if (id === 'Q51') {
            return [
              entity('Q51', { claims: { P86: ['Q1340'] }, sitelinks: wikipedias(40, { fr: "L'Été (Vivaldi)" }) })
            ];
          }
          return [];
        }),
      pageviews: async (_language, title) => (title === "L'Été (Vivaldi)" ? 9_000 : 70_000)
    });

    const facts = await lookupFame(openDb().db, sources, {
      shape: 'artist-title',
      artist: 'Antonio Vivaldi',
      title: "L'Été",
      piece: true
    });

    // Forty Wikipedias and the French one: the concerto's, not the composer's 155.
    assert.deepEqual([facts.wikiLanguages, facts.frPageviews], [41, 9_000]);
    assert.equal(facts.deezerFans, 819_482, 'the composer’s following still counts');
  });

  it('knows a composer credited by surname, as a classical round credits them', async () => {
    const { sources } = world({
      deezerTracks: async () => [
        { id: 4, title: 'Für Elise', rank: 820_000, artist: { id: 2049, name: 'Ludwig van Beethoven' } }
      ],
      deezerArtist: async (id) => ({ id, name: 'Ludwig van Beethoven', fans: 2_900_000 })
    });
    const facts = await lookupFame(openDb().db, sources, {
      shape: 'artist-title',
      artist: 'Beethoven',
      title: 'Für Elise'
    });
    assert.deepEqual([facts.deezerRank, facts.deezerFans], [820_000, 2_900_000]);
  });

  it('leaves the Wikipedias unknown when a name search found only other names', async () => {
    const { sources } = world({
      deezerArtists: async () => [{ id: 3, name: 'Somebody Else', fans: 5_000 }],
      wikidataSearch: async () => ['Q7'],
      wikidataEntities: async () => [
        entity('Q7', { labels: { en: 'Somebody Else' }, claims: { P434: ['x'] }, sitelinks: wikipedias(40) })
      ]
    });
    const facts = await lookupFame(openDb().db, sources, { shape: 'artist-title', artist: 'Mystery', title: 'Song' });
    assert.deepEqual([facts.wikiLanguages, facts.frPageviews, facts.enPageviews], [null, null, null]);
  });

  it('leaves the fans unknown when a search found only other names', async () => {
    const { sources } = world({ deezerArtists: async () => [{ id: 1, name: 'Somebody Else', fans: 900 }] });
    const facts = await lookupFame(openDb().db, sources, { shape: 'artist-title', artist: 'Mystery', title: 'Song' });
    assert.equal(facts.deezerFans, null);
  });

  it('reads an artist nobody has heard of as zeros, not as unknown', async () => {
    const { sources } = world();
    const facts = await lookupFame(openDb().db, sources, {
      shape: 'artist-title',
      artist: 'The Garage Band',
      title: 'Demo'
    });
    assert.deepEqual(
      [facts.deezerRank, facts.deezerFans, facts.wikiLanguages, facts.frPageviews, facts.enPageviews],
      [0, 0, 0, 0, 0]
    );
  });

  it('will not settle a name search on something that is not a musician', async () => {
    const { sources } = world({
      deezerArtists: async () => [{ id: 9, name: 'QQ', fans: 30_000 }],
      wikidataSearch: async () => ['Q1', 'Q2'],
      wikidataEntities: async (ids) =>
        ids.length > 1
          ? [
              // The messaging app, famous in thirty languages.
              entity('Q1', { labels: { en: 'QQ' }, sitelinks: wikipedias(30, { fr: 'QQ', en: 'Tencent QQ' }) }),
              entity('Q2', { labels: { en: 'QQ (singer)' }, claims: { P434: ['mbid'] } })
            ]
          : []
    });
    const facts = await lookupFame(openDb().db, sources, { shape: 'artist-title', artist: 'QQ', title: 'Movie' });
    assert.equal(facts.deezerFans, 30_000);
    // Not the app's thirty Wikipedias, and not a zero either: a spelling may simply have been missed.
    assert.equal(facts.wikiLanguages, null);
  });

  it('leaves a figure unknown when its request failed, and asks again the next day', async () => {
    let up = false;
    const { sources, asked } = world({
      deezerTracks: async () => (up ? [] : undefined),
      deezerArtists: async () => (up ? [] : undefined)
    });
    const db = openDb().db;
    const target = { shape: 'artist-title', artist: 'Somebody', title: 'Something' } as const;

    const failed = await lookupFame(db, sources, target, { now: 0 });
    assert.equal(failed.deezerFans, null);
    assert.equal(failed.wikiLanguages, null, 'not "no Wikipedia": nothing could be checked');

    up = true;
    const calls = asked.length;
    await lookupFame(db, sources, target, { now: DAY / 2 });
    assert.equal(asked.length, calls, 'kept for the day');
    const later = await lookupFame(db, sources, target, { now: DAY + 1 });
    assert.ok(asked.length > calls);
    assert.equal(later.deezerFans, 0);
  });

  it('asks again once a Last.fm key is configured, rather than keep the keyless answer for months', async () => {
    let keyed = false;
    const { sources } = world({
      configured: () => ({ lastfm: keyed, tmdb: false }),
      lastfmListeners: async () => (keyed ? 50_000 : null)
    });
    const db = openDb().db;
    const target = { shape: 'artist-title', artist: 'Somebody', title: 'Something' } as const;

    await lookupFame(db, sources, target, { now: 0 });
    keyed = true;
    const later = await lookupFame(db, sources, target, { now: DAY });
    assert.equal(later.lastfmListeners, 50_000);
  });

  it('keeps a whole answer for months', async () => {
    const { sources, asked } = world();
    const db = openDb().db;
    const target = { shape: 'artist-title', artist: 'Somebody', title: 'Something' } as const;
    await lookupFame(db, sources, target, { now: 0 });
    const calls = asked.length;
    await lookupFame(db, sources, target, { now: 60 * DAY });
    assert.equal(asked.length, calls);
  });
});

describe('a work’s fame', () => {
  it('tries an anime’s other names, and reads its themes and its Wikipedias by its AniList id', async () => {
    const { sources } = world({
      // The French name finds the final season; the English one is the series' own title.
      anilist: async (name) =>
        name === 'Attack on Titan'
          ? [
              { id: 110277, popularity: 650_000, titles: ['Attack on Titan Final Season'] },
              { id: 16498, popularity: 900_000, titles: ['Shingeki no Kyojin', 'Attack on Titan'] }
            ]
          : [{ id: 110277, popularity: 650_000, titles: ['Attack on Titan Final Season'] }],
      animeThemes: async () => [{ type: 'OP', sequence: 1, song: 'Guren no Yumiya', artists: ['Linked Horizon'] }],
      wikidataByClaim: async (property, value) => (property === 'P8729' && value === '16498' ? ['Q3'] : []),
      wikidataEntities: async () => [entity('Q3', { sitelinks: wikipedias(60, { fr: "L'Attaque des Titans" }) })],
      pageviews: async (language) => (language === 'fr' ? 50_000 : 0)
    });
    const facts = await lookupFame(openDb().db, sources, {
      shape: 'work',
      kind: 'anime',
      work: "L'Attaque des Titans",
      names: ['Attack on Titan']
    });
    assert.equal(facts.anilistMembers, 900_000);
    assert.equal(facts.frPageviews, 50_000);
    assert.equal(facts.enPageviews, 0, 'no English article is a zero');
    assert.equal(facts.themes?.[0]?.song, 'Guren no Yumiya');
  });

  it('finds an anime under a season and a translation in brackets', async () => {
    const { sources } = world({
      anilist: async (name) =>
        name === 'My Hero Academia'
          ? [{ id: 21459, popularity: 700_000, titles: ['Boku no Hero Academia', 'My Hero Academia'] }]
          : []
    });
    const facts = await lookupFame(openDb().db, sources, {
      shape: 'work',
      kind: 'anime',
      work: 'My Hero Academia (Boku no Hīrō Akademia) - Final Season'
    });
    assert.equal(facts.anilistMembers, 700_000);
  });

  it('will not score an answer with whichever anime AniList found nearest to it', async () => {
    // A singer read off a Japanese video title as the anime: AniList still answers something.
    const { sources } = world({ anilist: async () => [{ id: 9, popularity: 300_000, titles: ['Blue Lock'] }] });
    const facts = await lookupFame(openDb().db, sources, { shape: 'work', kind: 'anime', work: 'Vicke Blanka' });
    assert.equal(facts.anilistMembers, null, 'an answer AniList matched nothing to is unknown, not that anime');
  });

  it('follows a season no Wikipedia covers to the series every Wikipedia does', async () => {
    const { sources } = world({
      anilist: async () => [{ id: 329, popularity: 65_000, titles: ['Planetes'] }],
      wikidataByClaim: async (property) => (property === 'P8729' ? ['Q900'] : []),
      wikidataEntities: async (ids) =>
        ids.map((id) =>
          id === 'Q900'
            ? entity('Q900', { claims: { P179: ['Q901'] } })
            : entity(id, { sitelinks: wikipedias(25, { fr: 'Planetes' }) })
        ),
      pageviews: async () => 4_000
    });
    const facts = await lookupFame(openDb().db, sources, { shape: 'work', kind: 'anime', work: 'Planetes' });
    assert.ok((facts.wikiLanguages ?? 0) >= 25, String(facts.wikiLanguages));
    assert.equal(facts.ids.wikidata, 'Q901');
  });

  it('leaves the Wikipedias unknown, not zero, when nothing above the season is covered either', async () => {
    const { sources } = world({
      anilist: async () => [{ id: 1, popularity: 50_000, titles: ['Some Show'] }],
      wikidataByClaim: async () => ['Q900'],
      wikidataEntities: async (ids) => ids.map((id) => entity(id))
    });
    const facts = await lookupFame(openDb().db, sources, { shape: 'work', kind: 'anime', work: 'Some Show' });
    assert.equal(facts.wikiLanguages, null);
  });

  it('asks again about a work looked up before it knew to try its other names', async () => {
    const db = openDb().db;
    let asked = 0;
    const { sources } = world({
      anilist: async () => {
        asked += 1;
        return [{ id: 2, popularity: 10_000, titles: ['Some Show'] }];
      }
    });
    const target = { shape: 'work' as const, kind: 'anime' as const, work: 'Some Show' };
    await lookupFame(db, sources, target);
    db.run(sql`UPDATE BlindtestFame SET facts = json_remove(facts, '$.revision')`);
    await lookupFame(db, sources, target);
    await lookupFame(db, sources, target);
    assert.equal(asked, 2);
  });

  it('picks a film out of a name search by what it is, and asks TMDB by the id Wikidata has', async () => {
    const tmdbAsked: unknown[] = [];
    const { sources } = world({
      wikidataSearch: async (_name, language) => (language === 'fr' ? ['Q10', 'Q11'] : []),
      wikidataEntities: async () => [
        entity('Q10', { claims: { P31: ['Q5'] } }),
        entity('Q11', { claims: { P31: ['Q11424'], P4947: ['11'] }, sitelinks: wikipedias(100, { fr: 'Star Wars' }) })
      ],
      pageviews: async () => 40_000,
      tmdbVotes: async (kind, ref) => {
        tmdbAsked.push([kind, ref]);
        return { id: '11', votes: 21_000 };
      }
    });
    const facts = await lookupFame(openDb().db, sources, { shape: 'work', kind: 'film', work: 'Star Wars' });
    assert.equal(facts.ids.wikidata, 'Q11');
    assert.equal(facts.tmdbVotes, 21_000);
    assert.deepEqual(tmdbAsked, [['movie', { id: '11' }]]);
  });

  it('takes the film, not the person it is named after, though both have an IMDb id', async () => {
    const { sources } = world({
      wikidataSearch: async () => ['Q303', 'Q98'],
      wikidataEntities: async () => [
        entity('Q303', { claims: { P31: ['Q5'], P345: ['nm0000062'] }, sitelinks: wikipedias(200) }),
        entity('Q98', { claims: { P31: ['Q11424'], P345: ['tt3704428'] }, sitelinks: wikipedias(40) })
      ]
    });
    const facts = await lookupFame(openDb().db, sources, { shape: 'work', kind: 'film', work: 'Elvis' });
    assert.equal(facts.ids.wikidata, 'Q98');
  });

  it('leaves an anime’s Wikipedias unknown when Wikidata does not link it to AniList', async () => {
    const { sources } = world({ anilist: async () => [{ id: 5, popularity: 40_000, titles: ['Some Show'] }] });
    const facts = await lookupFame(openDb().db, sources, { shape: 'work', kind: 'anime', work: 'Some Show' });
    assert.equal(facts.anilistMembers, 40_000);
    assert.equal(facts.wikiLanguages, null);
  });

  it('leaves a film’s Wikipedias unknown when its name only finds other things', async () => {
    const { sources } = world({
      wikidataSearch: async () => ['Q303'],
      wikidataEntities: async () => [entity('Q303', { claims: { P31: ['Q5'] }, sitelinks: wikipedias(200) })]
    });
    const facts = await lookupFame(openDb().db, sources, { shape: 'work', kind: 'film', work: 'Elvis' });
    assert.equal(facts.wikiLanguages, null);
  });

  it('finds a series’ theme song and its performer', async () => {
    const entities: Record<string, WikidataEntity> = {
      Q20: entity('Q20', { claims: { P31: ['Q5398426'], P942: ['Q21'] }, sitelinks: wikipedias(40) }),
      Q21: entity('Q21', { labels: { en: "I'll Be There for You" }, claims: { P175: ['Q22'] } }),
      Q22: entity('Q22', { labels: { en: 'The Rembrandts' } })
    };
    const { sources } = world({
      wikidataEntities: async (ids) => ids.map((id) => entities[id]).filter((found) => found !== undefined)
    });
    const facts = await lookupFame(openDb().db, sources, {
      shape: 'work',
      kind: 'series',
      work: 'Friends',
      wikidataId: 'Q20'
    });
    assert.deepEqual(facts.themeSong, { title: "I'll Be There for You", artist: 'The Rembrandts' });
  });
});

describe('the names a work is looked up under', () => {
  it('tries the answer, then without its brackets, its season, and the names in its brackets', () => {
    assert.deepEqual(workNameVariants('My Hero Academia (Boku no Hīrō Akademia) - Final Season'), [
      'My Hero Academia (Boku no Hīrō Akademia) - Final Season',
      'My Hero Academia - Final Season',
      'My Hero Academia',
      'Boku no Hīrō Akademia'
    ]);
    assert.deepEqual(workNameVariants('Drive (film, 2011)'), ['Drive (film, 2011)', 'Drive']);
    assert.deepEqual(workNameVariants('Akuma no Ko (悪魔の子)'), ['Akuma no Ko (悪魔の子)', 'Akuma no Ko', '悪魔の子']);
  });

  it('tries each side of an "ou", and never a season or an arc as a name of its own', () => {
    assert.ok(workNameVariants('Superman (film, 1978) ou Superman (série animée, 1996)').includes('Superman'));
    assert.deepEqual(workNameVariants('Jujutsu Kaisen (Shibuya Incident Arc)'), [
      'Jujutsu Kaisen (Shibuya Incident Arc)',
      'Jujutsu Kaisen'
    ]);
  });
});

describe('which theme a clip plays', () => {
  const themes = [
    { type: 'OP' as const, sequence: 1, song: 'First', artists: ['A'] },
    { type: 'OP' as const, sequence: 2, song: 'Second', artists: ['B'] },
    { type: 'ED' as const, sequence: null, song: 'Only ending', artists: ['C'] }
  ];

  it('reads the slot off the video’s title', () => {
    assert.deepEqual(themeSlotOf('Shingeki no Kyojin Opening 2 | Creditless'), { type: 'OP', sequence: 2 });
    assert.deepEqual(themeSlotOf('Naruto Shippuden ED 16'), { type: 'ED', sequence: 16 });
    assert.equal(themeSlotOf('Gurenge - LiSA (Official MV)'), null);
  });

  it('takes the named one, or the only one of its kind, and refuses to guess between several', () => {
    assert.equal(animeThemeFor(themes, { type: 'OP', sequence: 2 }, 'OP')?.song, 'Second');
    assert.equal(animeThemeFor(themes, null, 'ED')?.song, 'Only ending');
    assert.equal(animeThemeFor(themes, null, 'OP'), null);
  });
});
