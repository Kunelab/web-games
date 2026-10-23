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
