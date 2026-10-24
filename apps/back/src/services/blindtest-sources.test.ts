import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { bulkFameSources, httpSources } from './blindtest-sources.js';

/**
 * The real requests, against a Deezer that answers what the test says.
 *
 * Only `fetch` is replaced: everything between it and the port is the
 * production code, which is where a response's shape is read.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function deezerAnswers(body: unknown): void {
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
}

describe('Wikidata, under load', () => {
  it('waits and asks again when it is told to slow down, instead of giving up', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return calls === 1
        ? new Response('slow down', { status: 429, headers: { 'retry-after': '0' } })
        : new Response(JSON.stringify({ query: { search: [{ title: 'Q1340' }] } }), { status: 200 });
    };
    assert.deepEqual(await httpSources.fame.wikidataByClaim('P2722', '4081'), ['Q1340']);
  });

  it('sends one request at a time, as Wikimedia asks of its clients', async () => {
    let inFlight = 0;
    let most = 0;
    globalThis.fetch = async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      // Slower than the spacing between starts, as an answer under load is.
      await new Promise((resolve) => setTimeout(resolve, 300));
      inFlight -= 1;
      return new Response(JSON.stringify({ search: [] }), { status: 200 });
    };
    await Promise.all([
      httpSources.fame.wikidataSearch('Vivaldi', 'en'),
      httpSources.fame.wikidataSearch('Vivaldi', 'fr'),
      httpSources.fame.wikidataSearch('Bach', 'en')
    ]);
    assert.equal(most, 1);
  });
});

describe('Deezer, for how famous an artist is', () => {
  it('reads an error body as a failed request, not as "no such artist"', async () => {
    // HTTP 200 carrying an error, which is how Deezer says it is busy.
    deezerAnswers({ error: { type: 'Exception', message: 'Service busy', code: 700 } });
    assert.equal(await httpSources.fame.deezerArtists('Bob Marley'), undefined);
  });

  it('reads "no data" as an artist it does not have', async () => {
    deezerAnswers({ error: { type: 'DataException', message: 'no data', code: 800 } });
    assert.equal(await httpSources.fame.deezerArtist(123), null);
  });

  it('reads an empty search as an artist it does not have', async () => {
    deezerAnswers({ data: [], total: 0 });
    assert.deepEqual(await httpSources.fame.deezerArtists('Nobody At All'), []);
  });
});

/** The URL a faked `fetch` was called with. */
function urlOf(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input);
}

describe('the fame sources in bulk', () => {
  it('asks Wikipedia for many titles in one request, following its renames', async () => {
    const urls: URL[] = [];
    globalThis.fetch = async (input) => {
      urls.push(urlOf(input));
      return new Response(
        JSON.stringify({
          query: {
            normalized: [{ from: 'booba', to: 'Booba' }],
            redirects: [{ from: 'Kaaris (rappeur)', to: 'Kaaris' }],
            pages: [
              { title: 'Booba', pageviews: { '2026-10-01': 10, '2026-10-02': 5 } },
              { title: 'Kaaris', pageviews: { '2026-10-01': 3, '2026-10-02': null } },
              { title: 'Personne', missing: true }
            ]
          }
        }),
        { status: 200 }
      );
    };
    const sources = bulkFameSources();
    const views = await Promise.all([
      sources.pageviews('fr', 'booba'),
      sources.pageviews('fr', 'Kaaris (rappeur)'),
      sources.pageviews('fr', 'Personne')
    ]);
    assert.deepEqual(views, [15, 3, 0]);
    assert.equal(urls.length, 1);
    assert.equal(urls[0]?.searchParams.get('titles'), 'booba|Kaaris (rappeur)|Personne');
  });

  it('asks each question once, however many songs share it', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ id: 5, name: 'Jul', nb_fan: 100 }), { status: 200 });
    };
    const sources = bulkFameSources();
    const answers = await Promise.all([sources.deezerArtist(5), sources.deezerArtist(5), sources.deezerArtist(5)]);
    assert.equal(calls, 1);
    assert.equal(answers[2]?.fans, 100);
  });

  it('finds artists by their Deezer ids a few hundred to a query, oldest item first', async () => {
    const urls: URL[] = [];
    globalThis.fetch = async (input) => {
      urls.push(urlOf(input));
      return new Response(
        JSON.stringify({
          results: {
            bindings: [
              { v: { value: '1' }, item: { value: 'http://www.wikidata.org/entity/Q20' } },
              { v: { value: '1' }, item: { value: 'http://www.wikidata.org/entity/Q3' } },
              { v: { value: '2' }, item: { value: 'http://www.wikidata.org/entity/Q7' } }
            ]
          }
        }),
        { status: 200 }
      );
    };
    const sources = bulkFameSources();
    const found = await Promise.all(['1', '2', '3'].map((id) => sources.wikidataByClaim('P2722', id)));
    assert.deepEqual(found, [['Q3', 'Q20'], ['Q7'], []]);
    assert.equal(urls.length, 1);
    assert.equal(urls[0]?.host, 'qlever.dev');
  });

  it('fetches Wikidata items in one request, each caller getting them in the order it asked', async () => {
    const asked: string[] = [];
    globalThis.fetch = async (input) => {
      const ids = urlOf(input).searchParams.get('ids') ?? '';
      asked.push(ids);
      const entities = Object.fromEntries(
        ids
          .split('|')
          .map((id) => [id, id === 'Q404' ? { id, missing: '' } : { id, sitelinks: { frwiki: { title: id } } }])
      );
      return new Response(JSON.stringify({ entities }), { status: 200 });
    };
    const sources = bulkFameSources();
    const [first, second] = await Promise.all([
      sources.wikidataEntities(['Q2', 'Q1', 'Q404']),
      sources.wikidataEntities(['Q3'])
    ]);
    assert.equal(asked.length, 1);
    assert.deepEqual(
      first?.map((entity) => entity.id),
      ['Q2', 'Q1']
    );
    assert.deepEqual(
      second?.map((entity) => entity.id),
      ['Q3']
    );
  });

  it('reads a request that failed as unknown, not as nothing', async () => {
    globalThis.fetch = async () => new Response('down', { status: 500 });
    const sources = bulkFameSources();
    assert.equal(await sources.pageviews('en', 'Booba'), undefined);
  });
});
