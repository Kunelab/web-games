import { splitArtistTitle } from 'game-core';
import { z } from 'zod';

import { env } from '../env.js';

export interface YoutubePlaylistItem {
  title: string;
  videoId: string;
}

/** Everything the editor can prefill from a video id. */
export interface YoutubeVideoMetadata {
  videoId: string;
  /** Raw YouTube title, kept so the host can see what it was parsed from. */
  rawTitle: string;
  /** Parsed from "Artist - Title"; either may be empty. */
  title: string;
  artist: string;
  /** Uploading channel, a decent artist fallback for official channels. */
  channel: string;
  /** Publication year, a starting point for the year bonus field. */
  year: string;
  durationSeconds: number | null;
}

/** Only the fields we actually read, so a YouTube API change fails loudly. */
const responseSchema = z.object({
  nextPageToken: z.string().optional(),
  items: z.array(
    z.object({
      snippet: z.object({
        title: z.string(),
        resourceId: z.object({ videoId: z.string() }).optional()
      })
    })
  )
});

/** The API caps `maxResults` at 50; the old code asked for 200 and silently got 50. */
const MAX_RESULTS = 50;

/** Stops a malformed cursor from looping forever. 100 pages is 5000 videos. */
const MAX_PAGES = 100;

export class YoutubeError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'YoutubeError';
    this.statusCode = statusCode;
  }
}

const videoResponseSchema = z.object({
  items: z
    .array(
      z.object({
        snippet: z.object({
          title: z.string(),
          channelTitle: z.string().optional(),
          publishedAt: z.string().optional()
        }),
        contentDetails: z.object({ duration: z.string().optional() }).optional()
      })
    )
    .min(1)
});

/** ISO 8601 duration as the API returns it, e.g. PT4M33S. */
function parseIsoDuration(duration: string | undefined): number | null {
  if (!duration) return null;
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(duration);
  if (!match) return null;

  const [, days, hours, minutes, seconds] = match;
  return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
}

/**
 * Metadata for one video, so adding a blind test is pasting a link rather than
 * typing four fields.
 *
 * The artist/title split is a heuristic over the "Artist - Title" convention, so
 * the caller keeps both editable. The channel comes back separately because for
 * official artist channels it is often a better artist value than anything in the
 * title.
 */
export async function fetchVideoMetadata(videoId: string): Promise<YoutubeVideoMetadata> {
  if (!env.GOOGLE_API_KEY) {
    throw new YoutubeError('GOOGLE_API_KEY is not configured', 503);
  }

  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'snippet,contentDetails');
  url.searchParams.set('id', videoId);
  url.searchParams.set('key', env.GOOGLE_API_KEY);

  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });

  if (!response.ok) {
    const body = await response.text();
    throw new YoutubeError(
      `YouTube API responded ${response.status}: ${body.slice(0, 300)}`,
      response.status === 404 ? 404 : 502
    );
  }

  const parsed = videoResponseSchema.safeParse(await response.json());
  if (!parsed.success || !parsed.data.items[0]) {
    // An empty items array is what the API returns for a private or deleted video.
    throw new YoutubeError('Vidéo introuvable ou indisponible', 404);
  }

  const item = parsed.data.items[0];
  const { artist, title } = splitArtistTitle(item.snippet.title);

  return {
    videoId,
    rawTitle: item.snippet.title,
    title,
    artist,
    channel: item.snippet.channelTitle ?? '',
    year: item.snippet.publishedAt?.slice(0, 4) ?? '',
    durationSeconds: parseIsoDuration(item.contentDetails?.duration)
  };
}

export async function fetchPlaylistItems(playlistId: string): Promise<YoutubePlaylistItem[]> {
  if (!env.GOOGLE_API_KEY) {
    throw new YoutubeError('GOOGLE_API_KEY is not configured', 503);
  }

  const collected: YoutubePlaylistItem[] = [];
  let pageToken: string | undefined;
  let page = 0;

  do {
    const url = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('playlistId', playlistId);
    url.searchParams.set('maxResults', String(MAX_RESULTS));
    url.searchParams.set('key', env.GOOGLE_API_KEY);
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    }

    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });

    if (!response.ok) {
      const body = await response.text();
      throw new YoutubeError(
        `YouTube API responded ${response.status}: ${body.slice(0, 300)}`,
        response.status === 404 ? 404 : 502
      );
    }

    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new YoutubeError('Unexpected response shape from the YouTube API', 502);
    }

    for (const item of parsed.data.items) {
      // Private and deleted videos come back without a resourceId.
      if (item.snippet.resourceId) {
        collected.push({ title: item.snippet.title, videoId: item.snippet.resourceId.videoId });
      }
    }

    pageToken = parsed.data.nextPageToken;
    page += 1;
  } while (pageToken && page < MAX_PAGES);

  return collected;
}
