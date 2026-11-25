/**
 * The year a song first came out.
 *
 * Not the year of the album it is on today. Deezer dates a track by the release
 * it serves it from, and for anything old that is a remaster, a best-of or a
 * box set: "Hey Jude" comes back as 2015, from the "1" compilation. A difficulty
 * that reads that as a recent song is unfair to every room that knows it.
 *
 * MusicBrainz keeps, for each recording, the date of the first release it
 * appeared on, across every single, album, compilation and reissue it knows. So
 * the earliest `first-release-date` among the recordings that really are this
 * artist singing this song is the year the song came out.
 *
 * MusicBrainz is shared and rate-limited (one request a second per client, with
 * a User-Agent saying who is asking), so every request here goes through one
 * module-level queue, however many callers there are.
 */
import { z } from 'zod';

import { mainArtist, sameArtist, sameSong } from './blindtest-fame.js';

const USER_AGENT = 'KuneLabWebGames/0.3 (blind test release year lookup; https://github.com/Kunelab)';

/** A little over the one second MusicBrainz asks for, so clock jitter never makes it two in one second. */
const SPACING_MS = 1_100;

/** The oldest year a recording can plausibly have; earlier dates are data-entry slips. */
const EARLIEST_PLAUSIBLE = 1900;

const recordingSchema = z.object({
  title: z.string(),
  disambiguation: z.string().optional(),
  'first-release-date': z.string().optional(),
  'artist-credit': z
    .array(
      z.object({
        name: z.string().optional(),
        joinphrase: z.string().optional(),
        artist: z.object({ name: z.string() })
      })
    )
    .optional(),
  releases: z.array(z.object({ date: z.string().optional(), status: z.string().optional() })).optional()
});

const searchSchema = z.object({ recordings: z.array(recordingSchema).optional() });

type Recording = z.infer<typeof recordingSchema>;

/** The year of a MusicBrainz date ("1968", "1968-08", "1968-08-26"), when it is a believable one. */
function yearOfDate(date: string | undefined): number | null {
  const match = date?.match(/^(\d{4})/);
  if (!match) return null;
  const year = Number(match[1]);
  return year >= EARLIEST_PLAUSIBLE && year <= new Date().getFullYear() ? year : null;
}

/** The credit as printed: "Jay-Z feat. Alicia Keys", from its parts and their join phrases. */
function creditOf(recording: Recording): string {
  return (recording['artist-credit'] ?? [])
    .map((part) => `${part.name ?? part.artist.name}${part.joinphrase ?? ''}`)
    .join('')
    .trim();
}

/**
 * Acts named after the one they imitate. `sameArtist` reads "The Beatles
 * Revival Band" as The Beatles with their band, the way "Bob Marley & The
 * Wailers" is Bob Marley, and that band's 1977 "Hey Jude" is in MusicBrainz.
 * Only a word the round's own artist name lacks counts, so an act really called
 * "... Orchestra" is still itself.
 */
const TRIBUTE =
  /\b(revival|tribute|covers?|karaoke|made famous|famous by|in the style of|sound-?alikes?|orchestra|quartet|ensemble|piano|lullab(?:y|ies)|for kids|band)\b/gi;

function tributeOf(credit: string, wanted: string): boolean {
  const own = new Set([...wanted.matchAll(TRIBUTE)].map((match) => match[0].toLowerCase()));
  return [...credit.matchAll(TRIBUTE)].some((match) => !own.has(match[0].toLowerCase()));
}

/** Release statuses that mean the artist put the song out: an official release, or a promo of one. */
const RELEASED = new Set(['official', 'promotion']);

function released(release: { status?: string | undefined }): boolean {
  return RELEASED.has(release.status?.toLowerCase() ?? '');
}

/**
 * Whether none of the releases a recording is on is the song coming out: only
 * bootlegs, demo tapes, translation listings. Such a recording's date says
 * nothing about when the public heard the song, and it is not always right about
 * itself: a "Billie Jean (Long Version)" known only from an undated bootleg
 * carries a first release date of 1978, four years before the song existed, and
 * Bob Marley's "Could You Be Loved" has a 1979 recording on a status-less "Dada
 * Demo Tape", a year before Uprising.
 *
 * A recording without any release listed is kept; the search does not always
 * say.
 */
function neverReleased(recording: Recording): boolean {
  const releases = recording.releases ?? [];
  return releases.length > 0 && !releases.some(released);
}

/**
 * Whether a recording is the round's artist performing the round's song.
 *
 * The artist test is what keeps covers out: Wilson Pickett's "Hey Jude" is a
 * real 1968 recording of the song, but a Wilson Pickett one, and a cover released
 * before the original (a radio session, a rival single) would otherwise pull the
 * year back. The credit is matched both as printed and by its first artist, so
 * "Booba feat. Kaaris" still counts as Booba.
 *
 * Recordings only ever on bootlegs or demo tapes are left out (see `neverReleased`).
 *
 * The title test reuses the fame matcher, which already turns away live, remix,
 * karaoke and cover takes. MusicBrainz often keeps that information out of the
 * title, in a disambiguation ("live, 1969-01-30"), so it is read as if it were
 * a bracketed suffix.
 */
function isTheSong(recording: Recording, artist: string, title: string): boolean {
  const credit = creditOf(recording);
  const first = recording['artist-credit']?.[0];
  const artistMatches =
    credit !== '' &&
    wantedArtists(artist).some(
      (wanted) =>
        sameArtist(credit, wanted) ||
        sameArtist(first?.name ?? '', wanted) ||
        sameArtist(first?.artist.name ?? '', wanted)
    );
  if (!artistMatches || tributeOf(credit, artist) || neverReleased(recording)) return false;

  const catalogued = recording.disambiguation ? `${recording.title} (${recording.disambiguation})` : recording.title;
  return sameSong(catalogued, title);
}

/**
 * The names the round's artist may be credited under: as given, and its main
 * artist. Both, because `mainArtist` splits on a slash and reads "AC/DC" as
 * "AC", while a round crediting "Booba feat. Kaaris" needs "Booba".
 */
function wantedArtists(artist: string): string[] {
  const main = mainArtist(artist);
  return main === artist ? [artist] : [artist, main];
}

/** When a recording first came out: its own first release date, else the earliest of its releases. */
function recordingYear(recording: Recording): number | null {
  const own = yearOfDate(recording['first-release-date']);
  if (own !== null) return own;
  const years = (recording.releases ?? [])
    .filter(released)
    .map((release) => yearOfDate(release.date))
    .filter((year) => year !== null);
  return years.length > 0 ? Math.min(...years) : null;
}

/**
 * The earliest year among the recordings of a MusicBrainz search that are this
 * artist's take on this song, or null when none is.
 *
 * Pure, so it can be tested on captured responses. A response that does not
 * parse is treated as one without a match: it answered, it just said nothing
 * usable.
 */
export function earliestYear(response: unknown, artist: string, title: string): number | null {
  const parsed = searchSchema.safeParse(response);
  if (!parsed.success) return null;

  const years = (parsed.data.recordings ?? [])
    .filter((recording) => isTheSong(recording, artist, title))
    .map(recordingYear)
    .filter((year) => year !== null);

  return years.length > 0 ? Math.min(...years) : null;
}

/** Lucene's special characters, backslashed so a title like "What's Up?" stays a phrase. */
function escapeLucene(text: string): string {
  return text.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&');
}

/* ---------------------------------------------------------------- pacing */

/** The tail of the queue: every request waits for the one before it, then for the spacing. */
let queue: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

/**
 * Runs `task` when the queue reaches it, at least `SPACING_MS` after the
 * previous request started. A failing task does not stall the ones behind it.
 */
function paced<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastRequestAt + SPACING_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    return task();
  });
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Disambiguations that mark a recording as a take the matcher would turn away
 * anyway. Excluding them in the query is what lets the studio recording fit in
 * one page: Queen has 237 recordings titled "Bohemian Rhapsody", most of them
 * concerts, and the 1975 single was not among the first fifty.
 */
const NOT_A_TAKE = 'NOT comment:(live OR karaoke OR remix OR instrumental OR demo OR cover)';

/** How many requests one lookup may spend: the first page, then at most two narrower ones. */
const MAX_REQUESTS = 3;

const pageSchema = z.object({ count: z.number().optional(), recordings: z.array(z.unknown()).optional() });

/** One search request, through the queue. Undefined when it failed in any way. */
function search(query: string): Promise<unknown> {
  const url = new URL('https://musicbrainz.org/ws/2/recording');
  url.searchParams.set('query', query);
  url.searchParams.set('fmt', 'json');
  url.searchParams.set('limit', '50');

  return paced(async () => {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) return undefined;
      const body: unknown = await response.json();
      return body;
    } catch {
      return undefined;
    }
  });
}

/**
 * The year a song first came out, according to MusicBrainz.
 *
 * Three answers, because the caller treats them differently: a number is the
 * year; null means MusicBrainz answered and has no recording of this artist
 * performing this song, which is worth remembering; undefined means a request
 * failed (rate limit, outage, timeout), which is worth trying again later.
 *
 * MusicBrainz's search cannot sort by date, and a famous song has more
 * recordings than a page holds. So when the first page is not the whole answer,
 * the search is repeated for recordings released strictly before the earliest
 * year found so far (`firstreleasedate:[1900 TO 1976}`): whatever that returns
 * can only lower the year, and it is usually a handful of recordings. A failure
 * on that follow-up is a failure of the lookup, since the year in hand may be
 * a reissue's.
 */
export async function musicbrainzYear(artist: string, title: string): Promise<number | null | undefined> {
  const artists = wantedArtists(artist)
    .map((name) => `artist:"${escapeLucene(name)}"`)
    .join(' OR ');
  const base = `recording:"${escapeLucene(title)}" AND (${artists}) AND ${NOT_A_TAKE}`;

  let year: number | null = null;
  let query = base;
  for (let request = 0; request < MAX_REQUESTS; request += 1) {
    const body = await search(query);
    const page = pageSchema.safeParse(body);
    if (!page.success) return undefined;

    const found = earliestYear(body, artist, title);
    const lowered = found !== null && (year === null || found < year);
    if (lowered) year = found;

    // Stop once a page held every hit, or when it moved nothing: asking again
    // with the same bound would return the same page.
    const complete = (page.data.recordings?.length ?? 0) >= (page.data.count ?? 0);
    if (complete || !lowered) break;
    query = `${base} AND firstreleasedate:[1900 TO ${year}}`;
  }

  return year;
}
