import { creditFromDescription, splitArtistTitle } from 'game-core';
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
  /**
   * Whether this clip will play here, and why not.
   *
   * Returned alongside the metadata rather than behind a second call, because
   * the moment a host pastes a link is the moment they can still pick another
   * one. Telling them at save time would be late; telling them mid-game, which
   * is what happened before this existed, is useless.
   */
  playable: boolean;
  blockers: PlaybackBlocker[];
  allowedRegions?: string[];
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

/**
 * The parts of a `videos.list` item this module reads.
 *
 * `status` and `contentDetails.regionRestriction` are what decide whether a clip
 * will actually play; they cost nothing extra, because the quota is charged per
 * request rather than per part.
 */
const videoItemSchema = z.object({
  id: z.string(),
  snippet: z.object({
    title: z.string(),
    description: z.string().optional(),
    channelTitle: z.string().optional(),
    publishedAt: z.string().optional()
  }),
  contentDetails: z
    .object({
      duration: z.string().optional(),
      regionRestriction: z
        .object({
          allowed: z.array(z.string()).optional(),
          blocked: z.array(z.string()).optional()
        })
        .optional(),
      contentRating: z.object({ ytRating: z.string().optional() }).optional()
    })
    .optional(),
  status: z
    .object({
      uploadStatus: z.string().optional(),
      privacyStatus: z.string().optional(),
      embeddable: z.boolean().optional()
    })
    .optional()
});

type VideoItem = z.infer<typeof videoItemSchema>;

const videoResponseSchema = z.object({ items: z.array(videoItemSchema) });

/** Every part needed to answer both "what is it" and "will it play". */
const VIDEO_PARTS = 'snippet,contentDetails,status';

/** `videos.list` takes up to fifty ids per request, for one quota unit. */
const VIDEO_BATCH = 50;

/** Why a video cannot be played, as catalogue keys the caller can translate. */
export type PlaybackBlocker =
  | 'missing'
  | 'notPublic'
  | 'notProcessed'
  | 'notEmbeddable'
  | 'regionBlocked'
  | 'ageRestricted';

export interface VideoPlayability {
  videoId: string;
  /** True when nothing stands in the way of this clip playing in an embed here. */
  playable: boolean;
  blockers: PlaybackBlocker[];
  /** Real length of the video, which is not the length of the track. */
  durationSeconds: number | null;
  /** Present only when the video carries a territory allow-list. */
  allowedRegions?: string[];
}

/**
 * Everything standing between this video and a round that works.
 *
 * Deliberately a list rather than a boolean: "not embeddable" and "not licensed
 * in this country" are different problems with different fixes, and the second
 * one is usually solved by picking a different upload of the same track rather
 * than a different track.
 *
 * The region rules are the subtle pair. `blocked` is a deny-list and is easy to
 * read; `allowed` is an allow-list, and the trap is that its *absence* means
 * "everywhere" while its presence means "nowhere else". Treating a missing
 * `allowed` as an empty one would reject the entire catalogue.
 */
export function playbackBlockers(item: VideoItem, region: string): PlaybackBlocker[] {
  const blockers: PlaybackBlocker[] = [];
  const status = item.status;
  const restriction = item.contentDetails?.regionRestriction;

  if (status?.uploadStatus && status.uploadStatus !== 'processed') blockers.push('notProcessed');
  if (status?.privacyStatus && status.privacyStatus !== 'public') blockers.push('notPublic');
  if (status?.embeddable === false) blockers.push('notEmbeddable');

  if (restriction?.blocked?.includes(region)) blockers.push('regionBlocked');
  else if (restriction?.allowed && !restriction.allowed.includes(region)) blockers.push('regionBlocked');

  /**
   * An age-restricted video refuses to play inside an embed for a signed-out
   * viewer, and every player in a party game is signed out.
   */
  if (item.contentDetails?.contentRating?.ytRating === 'ytAgeRestricted') blockers.push('ageRestricted');

  return blockers;
}

/**
 * Whether these clips will actually play, here, in an iframe.
 *
 * The question the rest of the codebase used to ask was whether a video *exists*,
 * which `oembed` and a successful metadata fetch both answer, and which is not the
 * same question at all: a public, embeddable, perfectly healthy video whose
 * licence names twelve countries plays in none of the other one hundred and
 * eighty. There is no error until the player is already on screen, and the only
 * thing the room sees is silence.
 *
 * Fifty ids per request and one quota unit per request, so checking a whole pool
 * costs about as much as fetching it did. Cheap enough that there is no reason
 * for an unchecked clip to reach a playlist.
 */
export async function fetchPlayability(
  videoIds: string[],
  region: string = env.YOUTUBE_REGION
): Promise<Map<string, VideoPlayability>> {
  if (!env.GOOGLE_API_KEY) {
    throw new YoutubeError('GOOGLE_API_KEY is not configured', 503);
  }

  const results = new Map<string, VideoPlayability>();
  const unique = [...new Set(videoIds.filter((id) => /^[A-Za-z0-9_-]{11}$/.test(id)))];

  for (let offset = 0; offset < unique.length; offset += VIDEO_BATCH) {
    const batch = unique.slice(offset, offset + VIDEO_BATCH);

    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.searchParams.set('part', VIDEO_PARTS);
    url.searchParams.set('id', batch.join(','));
    url.searchParams.set('key', env.GOOGLE_API_KEY);

    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      const body = await response.text();
      throw new YoutubeError(`YouTube API responded ${response.status}: ${body.slice(0, 300)}`, 502);
    }

    const parsed = videoResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new YoutubeError('Unexpected response shape from the YouTube API', 502);
    }

    for (const item of parsed.data.items) {
      const blockers = playbackBlockers(item, region);
      results.set(item.id, {
        videoId: item.id,
        playable: blockers.length === 0,
        blockers,
        durationSeconds: parseIsoDuration(item.contentDetails?.duration),
        ...(item.contentDetails?.regionRestriction?.allowed
          ? { allowedRegions: item.contentDetails.regionRestriction.allowed }
          : {})
      });
    }

    /**
     * An id the API simply does not return is deleted or private. Recorded
     * explicitly, because a caller iterating its own id list would otherwise
     * find a gap and have to guess what it meant.
     */
    for (const id of batch) {
      if (!results.has(id)) {
        results.set(id, { videoId: id, playable: false, blockers: ['missing'], durationSeconds: null });
      }
    }
  }

  return results;
}

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
  url.searchParams.set('part', VIDEO_PARTS);
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

  /**
   * The description wins when it actually credits a track.
   *
   * For anything whose title describes the *video* rather than the music — an
   * AMV, a montage, a fan edit — splitting the title cannot work, because the
   * song is not in it. "AMV - Nostromo - Pure Thrust" is an editor and an edit;
   * the description says "Music: Yuksek – Tonight", which is the answer.
   *
   * Preferred rather than merely used as a fallback, and the precedence is the
   * point: a labelled credit is somebody stating what the music was, while a
   * title split is this code guessing. When somebody has bothered to write it
   * down, believe them.
   */
  const credited = creditFromDescription(item.snippet.description ?? '');
  const { artist, title } = credited ?? splitArtistTitle(item.snippet.title);

  const blockers = playbackBlockers(item, env.YOUTUBE_REGION);
  const allowed = item.contentDetails?.regionRestriction?.allowed;

  return {
    videoId,
    rawTitle: item.snippet.title,
    title,
    artist,
    channel: item.snippet.channelTitle ?? '',
    year: item.snippet.publishedAt?.slice(0, 4) ?? '',
    durationSeconds: parseIsoDuration(item.contentDetails?.duration),
    playable: blockers.length === 0,
    blockers,
    ...(allowed ? { allowedRegions: allowed } : {})
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
