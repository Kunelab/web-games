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
    .optional(),
  statistics: z.object({ viewCount: z.string().optional() }).optional()
});

type VideoItem = z.infer<typeof videoItemSchema>;

const videoResponseSchema = z.object({ items: z.array(videoItemSchema) });

/**
 * Every part needed to answer "what is it", "will it play" and "how famous is it".
 *
 * All four in one request because the quota is charged per request, not per part:
 * asking for statistics separately would double the cost of filling a pool for
 * information that rides along free.
 */
const VIDEO_PARTS = 'snippet,contentDetails,status,statistics';

/** `videos.list` takes up to fifty ids per request, for one quota unit. */
const VIDEO_BATCH = 50;

/** Why a video cannot be played, as catalogue keys the caller can translate. */
export type PlaybackBlocker =
  'missing' | 'notPublic' | 'notProcessed' | 'notEmbeddable' | 'regionBlocked' | 'ageRestricted';

/**
 * The territory and embedding rules, kept raw.
 *
 * Raw is the point, and it is the central decision of the blind test catalogue. A
 * pool of clips is shared between rooms; whether a clip is playable depends on the
 * room's country; so a pooled entry cannot store a yes/no without becoming one
 * pool per country. It stores the rules, and each room applies them.
 */
export interface RegionRules {
  allowed?: string[];
  blocked?: string[];
  embeddable: boolean;
  ageRestricted: boolean;
  privacyStatus: string;
  uploadStatus: string;
}

/** Everything one `videos.list` call can tell us about a video. */
export interface VideoFacts {
  videoId: string;
  title: string;
  channel: string;
  description: string;
  /** Publication year, which for a Topic upload is not the release year. */
  year: number | null;
  views: number;
  durationSeconds: number | null;
  restriction: RegionRules;
}

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
export function playbackBlockers(rules: RegionRules, region: string): PlaybackBlocker[] {
  const blockers: PlaybackBlocker[] = [];

  if (rules.uploadStatus && rules.uploadStatus !== 'processed') blockers.push('notProcessed');
  if (rules.privacyStatus && rules.privacyStatus !== 'public') blockers.push('notPublic');
  if (!rules.embeddable) blockers.push('notEmbeddable');

  if (rules.blocked?.includes(region)) blockers.push('regionBlocked');
  else if (rules.allowed && !rules.allowed.includes(region)) blockers.push('regionBlocked');

  /**
   * An age-restricted video refuses to play inside an embed for a signed-out
   * viewer, and every player in a party game is signed out.
   */
  if (rules.ageRestricted) blockers.push('ageRestricted');

  return blockers;
}

/** True when this clip will play, in an embed, in this country. */
export function playableIn(rules: RegionRules, region: string): boolean {
  return playbackBlockers(rules, region).length === 0;
}

function toFacts(item: VideoItem): VideoFacts {
  const restriction = item.contentDetails?.regionRestriction;
  return {
    videoId: item.id,
    title: item.snippet.title,
    channel: item.snippet.channelTitle ?? '',
    description: item.snippet.description ?? '',
    year: item.snippet.publishedAt ? Number(item.snippet.publishedAt.slice(0, 4)) : null,
    views: Number(item.statistics?.viewCount ?? 0),
    durationSeconds: parseIsoDuration(item.contentDetails?.duration),
    restriction: {
      ...(restriction?.allowed ? { allowed: restriction.allowed } : {}),
      ...(restriction?.blocked ? { blocked: restriction.blocked } : {}),
      // Absent means embeddable: the API omits the field rather than sending true.
      embeddable: item.status?.embeddable !== false,
      ageRestricted: item.contentDetails?.contentRating?.ytRating === 'ytAgeRestricted',
      privacyStatus: item.status?.privacyStatus ?? 'public',
      uploadStatus: item.status?.uploadStatus ?? 'processed'
    }
  };
}

/**
 * Everything about a batch of videos, in as few requests as possible.
 *
 * The primitive the rest of this module is built on. Fifty ids per request and one
 * quota unit per request, so establishing the facts about an entire pool costs
 * about as much as harvesting it did.
 *
 * Ids the API does not return are simply absent from the result: they are deleted,
 * private, or never existed, and there are no facts to report about them. Callers
 * iterate the returned map rather than their own id list.
 */
export async function fetchVideoFacts(videoIds: string[]): Promise<Map<string, VideoFacts>> {
  if (!env.GOOGLE_API_KEY) {
    throw new YoutubeError('GOOGLE_API_KEY is not configured', 503);
  }

  const results = new Map<string, VideoFacts>();
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
      results.set(item.id, toFacts(item));
    }
  }

  return results;
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
 */
export async function fetchPlayability(
  videoIds: string[],
  region: string = env.YOUTUBE_REGION
): Promise<Map<string, VideoPlayability>> {
  const facts = await fetchVideoFacts(videoIds);
  const results = new Map<string, VideoPlayability>();

  for (const [id, fact] of facts) {
    const blockers = playbackBlockers(fact.restriction, region);
    results.set(id, {
      videoId: id,
      playable: blockers.length === 0,
      blockers,
      durationSeconds: fact.durationSeconds,
      ...(fact.restriction.allowed ? { allowedRegions: fact.restriction.allowed } : {})
    });
  }

  /**
   * An id the API simply does not return is deleted or private. Recorded
   * explicitly here, because unlike `fetchVideoFacts` this function answers a
   * question *about the caller's list*, and a silent gap would make "not playable"
   * indistinguishable from "not asked about".
   */
  for (const id of new Set(videoIds.filter((value) => /^[A-Za-z0-9_-]{11}$/.test(value)))) {
    if (!results.has(id)) {
      results.set(id, { videoId: id, playable: false, blockers: ['missing'], durationSeconds: null });
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

  const { restriction } = toFacts(item);
  const blockers = playbackBlockers(restriction, env.YOUTUBE_REGION);
  const allowed = restriction.allowed;

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

/* ------------------------------------------------------------------ search */

const searchResponseSchema = z.object({
  items: z.array(z.object({ id: z.object({ videoId: z.string().optional() }).optional() }))
});

/**
 * The expensive call, and the only one that actually searches YouTube.
 *
 * A hundred quota units against a daily ten thousand, which is a hundred a day
 * for the whole deployment and is why nothing in this codebase searches per
 * round. It buys up to fifty video ids, so a pool filled from a few searches and
 * cached for a day costs a few hundred units and serves an evening.
 *
 * Worth the price over a hand-curated playlist for one reason: playlists rot. A
 * list of ids written down once goes private, gets deleted, or quietly stops
 * being maintained, and the failure is silent — the genre simply starts coming
 * back empty. A query is evaluated against the live catalogue every time.
 *
 * The three filters below are the useful part and they are applied by YouTube
 * rather than by us, so they cost nothing and shrink what has to be checked
 * afterwards. They are not sufficient: `videos.list` still has the final word,
 * because `videoEmbeddable` does not account for territory licensing, which is
 * the restriction that actually bites.
 */
export async function searchVideos(
  query: string,
  options: { region?: string; musicOnly?: boolean; limit?: number } = {}
): Promise<string[]> {
  if (!env.GOOGLE_API_KEY) {
    throw new YoutubeError('GOOGLE_API_KEY is not configured', 503);
  }

  const url = new URL('https://www.googleapis.com/youtube/v3/search');
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('type', 'video');
  url.searchParams.set('q', query);
  url.searchParams.set('maxResults', String(Math.min(options.limit ?? 50, 50)));
  url.searchParams.set('regionCode', options.region ?? env.YOUTUBE_REGION);
  url.searchParams.set('videoEmbeddable', 'true');
  // Playable outside youtube.com, which is what an iframe on another origin is.
  url.searchParams.set('videoSyndicated', 'true');
  // Category 10 is Music. Keeps a query like "rock" from returning documentaries.
  if (options.musicOnly) url.searchParams.set('videoCategoryId', '10');
  url.searchParams.set('key', env.GOOGLE_API_KEY);

  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    const body = await response.text();
    throw new YoutubeError(`YouTube API responded ${response.status}: ${body.slice(0, 300)}`, 502);
  }

  const parsed = searchResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new YoutubeError('Unexpected response shape from the YouTube search API', 502);
  }

  return parsed.data.items.map((item) => item.id?.videoId).filter((id): id is string => Boolean(id));
}
