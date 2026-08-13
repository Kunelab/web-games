import { createHmac } from 'node:crypto';

import { env } from '../env.js';

/**
 * Opaque per-round URLs for images.
 *
 * A reveal round is only cheat-resistant if the client cannot see the source path:
 * `/guess_img/Arnold.jpg` in a network tab is the answer, and so is a redirect whose
 * Location header carries the same filename. So the token has to be unguessable and
 * non-reversible, and the bytes have to be proxied rather than redirected to.
 *
 * The token is a keyed hash of (roundId, source): deterministic, so rebuilding a
 * view yields the same URL and the browser can cache it, while revealing nothing
 * about the source. Lookup is by exact map key, so there is no comparison to
 * harden — an attacker either has the exact token or gets nothing.
 */

interface AssetEntry {
  source: string;
  expiresAt: number;
}

const registry = new Map<string, AssetEntry>();

/** Long enough to outlive a round with slack, short enough that tokens expire. */
const ASSET_TTL_MS = 30 * 60 * 1000;

function sign(roundId: string, source: string): string {
  return createHmac('sha256', env.SECRET).update(`${roundId}|${source}`).digest('hex').slice(0, 32);
}

/** Registers a source and returns the path players should request. */
export function assetUrlFor(roundId: string, source: string): string {
  if (!source) {
    return '';
  }

  const token = sign(roundId, source);
  registry.set(token, { source, expiresAt: Date.now() + ASSET_TTL_MS });
  return `/api/play/asset/${token}`;
}

export function resolveAsset(token: string, now = Date.now()): string | null {
  const entry = registry.get(token);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= now) {
    registry.delete(token);
    return null;
  }

  return entry.source;
}

/* ---------------------------------------------------------------- byte cache */

interface CachedBytes {
  contentType: string;
  body: Buffer;
  expiresAt: number;
}

/**
 * Bytes already fetched from upstream, keyed by source.
 *
 * A generated panel is twenty or forty images, and every player's browser asks for
 * all of them at once through this proxy. Fetching each one per player means hundreds
 * of requests to the same host in a few seconds, and Wikimedia answers a good share of
 * them with 429, which reaches the phone as a broken cell. Measured, not assumed: two
 * of six panel images failed that way on the first try.
 *
 * So the first request for a source pays for it and everyone else is served from
 * here. Two players asking simultaneously share one upstream fetch through
 * `inFlight`, which is what actually prevents the burst.
 */
const cache = new Map<string, CachedBytes>();
const inFlight = new Map<string, Promise<CachedBytes>>();

/** Half an hour, matching the token lifetime: a round outlives neither. */
const BYTES_TTL_MS = 30 * 60 * 1000;

/** Enough for several panels at once; a thumbnail is tens of kilobytes. */
const MAX_CACHE_BYTES = 64 * 1024 * 1024;

let cachedBytes = 0;

export function readCachedAsset(source: string, now = Date.now()): CachedBytes | null {
  const entry = cache.get(source);
  if (!entry) return null;

  if (entry.expiresAt <= now) {
    cache.delete(source);
    cachedBytes -= entry.body.byteLength;
    return null;
  }

  return entry;
}

/**
 * Fetches a source once, however many callers ask for it at the same moment.
 *
 * The loader is passed in so this file stays free of HTTP concerns and the route
 * keeps its own validation of type and size.
 */
export async function loadAssetOnce(
  source: string,
  load: () => Promise<{ contentType: string; body: Buffer }>,
  now = Date.now()
): Promise<CachedBytes> {
  const cached = readCachedAsset(source, now);
  if (cached) return cached;

  const pending = inFlight.get(source);
  if (pending) return pending;

  const fetching = load()
    .then(({ contentType, body }) => {
      const entry: CachedBytes = { contentType, body, expiresAt: now + BYTES_TTL_MS };

      // Oldest out first, which for a game means the previous round's images.
      while (cachedBytes + body.byteLength > MAX_CACHE_BYTES && cache.size > 0) {
        const [oldest, evicted] = [...cache.entries()].reduce((least, current) =>
          current[1].expiresAt < least[1].expiresAt ? current : least
        );
        cache.delete(oldest);
        cachedBytes -= evicted.body.byteLength;
      }

      if (body.byteLength <= MAX_CACHE_BYTES) {
        cache.set(source, entry);
        cachedBytes += body.byteLength;
      }

      return entry;
    })
    .finally(() => {
      inFlight.delete(source);
    });

  inFlight.set(source, fetching);
  return fetching;
}

export function sweepAssets(now = Date.now()): number {
  let removed = 0;
  for (const [token, entry] of registry) {
    if (entry.expiresAt <= now) {
      registry.delete(token);
      removed += 1;
    }
  }

  // The bytes expire on the same clock; without this they would only ever be
  // dropped by the size cap.
  for (const [source, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(source);
      cachedBytes -= entry.body.byteLength;
    }
  }

  return removed;
}

/** Test seam: the registry is module state, so cases need to reset it. */
export function clearAssets(): void {
  registry.clear();
  cache.clear();
  inFlight.clear();
  cachedBytes = 0;
}

export function assetCount(): number {
  return registry.size;
}
