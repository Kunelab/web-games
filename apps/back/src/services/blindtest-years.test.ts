import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import { earliestYear, musicbrainzYear } from './blindtest-years.js';

/** A captured MusicBrainz search response, trimmed to what the parser reads. */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/years/${name}.json`, import.meta.url), 'utf8')) as unknown;
}

/** A one-recording response, for the cases no captured page shows on its own. */
function recording(credit: string, title: string, date?: string, extra: Record<string, unknown> = {}): unknown {
  return {
    count: 1,
    recordings: [
      {
        title,
        ...(date ? { 'first-release-date': date } : {}),
        'artist-credit': [{ name: credit, artist: { name: credit } }],
        ...extra
      }
    ]
  };
}

describe('earliestYear', () => {
  it('finds the original year on captured responses', () => {
    assert.equal(earliestYear(fixture('somebody-that-i-used-to-know'), 'Gotye', 'Somebody That I Used to Know'), 2011);
    assert.equal(earliestYear(fixture('l-idole-des-jeunes'), 'Johnny Hallyday', "L'idole des jeunes"), 1962);
    assert.equal(earliestYear(fixture('allumer-le-feu'), 'Johnny Hallyday', 'Allumer le feu'), 1998);
    assert.equal(earliestYear(fixture('californication'), 'Red Hot Chili Peppers', 'Californication'), 1999);
    assert.equal(earliestYear(fixture('bohemian-rhapsody'), 'Queen', 'Bohemian Rhapsody'), 1975);
    assert.equal(earliestYear(fixture('scarface'), 'Booba', 'Scarface'), 2011);
  });

  it('reads a page on its own: the first Hey Jude page only holds reissues', () => {
    assert.equal(earliestYear(fixture('hey-jude'), 'The Beatles', 'Hey Jude'), 1978);
    assert.equal(earliestYear(fixture('hey-jude.2'), 'The Beatles', 'Hey Jude'), 1968);
  });

  it('accepts the credit the round gives, featurings included', () => {
    assert.equal(
      earliestYear(fixture('somebody-that-i-used-to-know'), 'Gotye feat. Kimbra', 'Somebody That I Used to Know'),
      2011
    );
    assert.equal(
      earliestYear(
        recording('Bob Marley & The Wailers', 'Could You Be Loved', '1980-05'),
        'Bob Marley',
        'Could You Be Loved'
      ),
      1980
    );
  });

  it('answers null when nothing matches', () => {
    assert.equal(earliestYear(fixture('nonsense'), 'Zorglub Quintet', 'Flibbertigibbet Moonwalk Sandwich'), null);
    assert.equal(earliestYear(fixture('scarface'), 'Booba', 'Ouest Side'), null);
    assert.equal(earliestYear({ error: 'nope' }, 'Queen', 'Bohemian Rhapsody'), null);
    assert.equal(earliestYear(null, 'Queen', 'Bohemian Rhapsody'), null);
  });

  it('ignores covers, tribute acts and features on somebody else’s song', () => {
    assert.equal(earliestYear(recording('Wilson Pickett', 'Hey Jude', '1968-11'), 'The Beatles', 'Hey Jude'), null);
    assert.equal(
      earliestYear(recording('The Beatles Revival Band', 'Hey Jude', '1967'), 'The Beatles', 'Hey Jude'),
      null
    );
    assert.equal(
      earliestYear(
        recording('Red Hot Chili Peppers Revival', 'Californication', '1990'),
        'Red Hot Chili Peppers',
        'Californication'
      ),
      null
    );
    const featured = {
      count: 1,
      recordings: [
        {
          title: 'Somebody That I Used to Know',
          'first-release-date': '2009',
          'artist-credit': [
            { name: 'Gavin Graham', joinphrase: ' ft. ', artist: { name: 'Gavin Graham' } },
            { name: 'Gotye', artist: { name: 'Gotye' } }
          ]
        }
      ]
    };
    assert.equal(earliestYear(featured, 'Gotye', 'Somebody That I Used to Know'), null);
  });

  it('ignores other takes, whether the title or the disambiguation says so', () => {
    assert.equal(
      earliestYear(recording('Queen', 'Bohemian Rhapsody (Live)', '1970'), 'Queen', 'Bohemian Rhapsody'),
      null
    );
    assert.equal(
      earliestYear(
        recording('Queen', 'Bohemian Rhapsody', '1970', { disambiguation: 'live, 1970: Imaginary Hall' }),
        'Queen',
        'Bohemian Rhapsody'
      ),
      null
    );
    assert.equal(
      earliestYear(recording('Queen', 'Bohemian Rhapsody (Remastered 2011)', '1975'), 'Queen', 'Bohemian Rhapsody'),
      1975
    );
  });

  it('ignores impossible years', () => {
    assert.equal(
      earliestYear(recording('Queen', 'Bohemian Rhapsody', '0001-01-01'), 'Queen', 'Bohemian Rhapsody'),
      null
    );
    assert.equal(earliestYear(recording('Queen', 'Bohemian Rhapsody', '1875'), 'Queen', 'Bohemian Rhapsody'), null);
    assert.equal(
      earliestYear(recording('Queen', 'Bohemian Rhapsody', '2999-01-01'), 'Queen', 'Bohemian Rhapsody'),
      null
    );
  });

  it('ignores recordings only ever on bootlegs or demo tapes', () => {
    assert.equal(earliestYear(fixture('billie-jean'), 'Michael Jackson', 'Billie Jean'), 1982);
    assert.equal(earliestYear(fixture('billie-jean.2'), 'Michael Jackson', 'Billie Jean'), null);
    const demo = recording('Bob Marley & The Wailers', 'Could You Be Loved', '1979', { releases: [{}] });
    assert.equal(earliestYear(demo, 'Bob Marley', 'Could You Be Loved'), null);
    const official = recording('Queen', 'Bohemian Rhapsody', '1975-10-31', {
      releases: [{ status: 'Bootleg' }, { status: 'Official' }]
    });
    assert.equal(earliestYear(official, 'Queen', 'Bohemian Rhapsody'), 1975);
  });

  it('falls back on the releases when the recording has no date of its own', () => {
    const undated = recording('Queen', 'Bohemian Rhapsody', undefined, {
      releases: [
        { date: '1981-10-26', status: 'Official' },
        { status: 'Official' },
        { date: '1975-10-31', status: 'Official' },
        { date: '1974' },
        { date: '1970', status: 'Bootleg' }
      ]
    });
    assert.equal(earliestYear(undated, 'Queen', 'Bohemian Rhapsody'), 1975);
  });
});

describe('musicbrainzYear', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Serves the given responses in order and records each request's query and start time. */
  function serve(responses: (() => Response)[]): { queries: string[]; times: number[]; agents: string[] } {
    const seen = { queries: [] as string[], times: [] as number[], agents: [] as string[] };
    globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
      seen.queries.push(new URL(input instanceof Request ? input.url : input).searchParams.get('query') ?? '');
      seen.times.push(Date.now());
      seen.agents.push(new Headers(init?.headers).get('user-agent') ?? '');
      const next = responses.shift();
      return next ? Promise.resolve(next()) : Promise.reject(new Error('unexpected request'));
    };
    return seen;
  }

  const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });

  it('narrows to earlier releases when the first page is not the whole answer', async () => {
    const seen = serve([json(fixture('hey-jude')), json(fixture('hey-jude.2'))]);
    assert.equal(await musicbrainzYear('The Beatles', 'Hey Jude'), 1968);
    assert.equal(seen.queries.length, 2);
    assert.match(seen.queries[0] ?? '', /^recording:"Hey Jude" AND \(artist:"The Beatles"\) AND NOT comment:/);
    assert.match(seen.queries[1] ?? '', /AND firstreleasedate:\[1900 TO 1978\}$/);
    assert.match(seen.agents[0] ?? '', /KuneLabWebGames/);
  });

  it('stops after one request when the page holds every hit', async () => {
    const seen = serve([json(fixture('californication'))]);
    assert.equal(await musicbrainzYear('Red Hot Chili Peppers', 'Californication'), 1999);
    assert.equal(seen.queries.length, 1);
  });

  it('answers null when MusicBrainz knows nothing, undefined when it could not be asked', async () => {
    serve([json(fixture('nonsense'))]);
    assert.equal(await musicbrainzYear('Zorglub Quintet', 'Flibbertigibbet Moonwalk Sandwich'), null);

    serve([() => new Response('slow down', { status: 503 })]);
    assert.equal(await musicbrainzYear('Queen', 'Bohemian Rhapsody'), undefined);

    serve([]);
    assert.equal(await musicbrainzYear('Queen', 'Bohemian Rhapsody'), undefined);
  });

  it('escapes Lucene syntax in names and titles', async () => {
    const seen = serve([json(fixture('nonsense'))]);
    await musicbrainzYear('AC/DC', 'Who Made Who?');
    assert.match(seen.queries[0] ?? '', /^recording:"Who Made Who\\\?" AND \(artist:"AC\\\/DC" OR artist:"AC"\) AND/);
  });

  it('keeps concurrent callers at least 1.1 s apart', async () => {
    const seen = serve([json(fixture('allumer-le-feu')), json(fixture('scarface'))]);
    const [first, second] = await Promise.all([
      musicbrainzYear('Johnny Hallyday', 'Allumer le feu'),
      musicbrainzYear('Booba', 'Scarface')
    ]);
    assert.equal(first, 1998);
    assert.equal(second, 2011);
    const [start = 0, next = 0] = seen.times;
    assert.ok(next - start >= 1_100, `requests were ${next - start} ms apart`);
  });
});
