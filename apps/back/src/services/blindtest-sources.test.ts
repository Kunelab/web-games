import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { httpSources } from './blindtest-sources.js';

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
