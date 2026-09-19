/**
 * Other names a player might legitimately type.
 *
 * Exists because the language model cannot be trusted with this and the matcher
 * cannot do without it. Asked for alternative titles, the model that got every
 * one of fifteen answers right also offered "L'Arc de l'Écarlate" and "Red Line"
 * as other names for Attack on Titan, and "Can You Feel the Love Tonight" for a
 * clip of "L'histoire de la vie". Those are not typos, they are inventions, and a
 * wrong alias does not merely waste a round: it silently accepts a wrong answer,
 * which is the one failure a blind test cannot survive.
 *
 * So aliases come from catalogues that hold them as facts. AniList publishes the
 * romaji, English, native and community synonyms for every anime; MusicBrainz
 * publishes artist aliases and legal names. Both are free, need no key, and
 * answer in about three hundred milliseconds. Neither can make anything up.
 *
 * Every lookup is best-effort: a source being down leaves the round with fewer
 * accepted spellings, which is a worse round rather than a broken one, so nothing
 * here throws.
 */
import { normalizeAnswer } from 'game-core';
import { z } from 'zod';

const USER_AGENT = 'KuneLabWebGames/0.3 (blind test alias lookup; https://github.com/Kunelab)';

/**
 * Something a French-speaking room could actually type.
 *
 * Expressed as what is wanted rather than as a list of scripts that are not, which
 * was the first attempt and was both longer and wrong: enumerating Cyrillic,
 * Hebrew, Arabic, Devanagari, Thai, kana and Han ranges still missed alphabets,
 * and several of those ranges contain combining marks that make the character
 * class itself misleading.
 *
 * One Latin letter is the whole test. `進撃の巨人` has none and is correct and
 * useless on a phone in a living room; "L'Attaque des Titans" has plenty.
 */
const TYPEABLE = /\p{Script=Latin}/u;

/**
 * Keeps the aliases worth offering.
 *
 * Two filters, both about the room rather than about the data. An alias in a
 * script nobody present can type is correct and useless. And an alias that
 * normalises to the answer itself adds nothing, since the matcher already
 * forgives case, accents and punctuation.
 */
function usable(answer: string, candidates: string[]): string[] {
  const target = normalizeAnswer(answer);
  const seen = new Set([target]);
  const kept: string[] = [];

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.length > 90) continue;
    if (!TYPEABLE.test(trimmed)) continue;

    const normalized = normalizeAnswer(trimmed);
    if (!normalized || seen.has(normalized)) continue;

    seen.add(normalized);
    kept.push(trimmed);
    if (kept.length >= 8) break;
  }

  return kept;
}

const anilistSchema = z.object({
  data: z.object({
    Media: z
      .object({
        title: z.object({
          romaji: z.string().nullable().optional(),
          english: z.string().nullable().optional(),
          native: z.string().nullable().optional()
        }),
        synonyms: z.array(z.string()).nullable().optional(),
        startDate: z.object({ year: z.number().nullable().optional() }).optional()
      })
      .nullable()
  })
});

const ANILIST_QUERY = `query($s:String){Media(search:$s,type:ANIME){title{romaji english native} synonyms startDate{year}}}`;

export interface AliasLookup {
  aliases: string[];
  /** Release year when the source knows it, which the YouTube upload date is not. */
  year: number | null;
}

/**
 * Anime titles, from AniList.
 *
 * The single best alias source in this whole pipeline: one request returns the
 * romaji, the English title, the native title and every community synonym, which
 * for a popular series includes the French title. That is precisely the list a
 * French room will type between them, and it arrives as data rather than as a
 * model's recollection.
 */
export async function anilistAliases(work: string): Promise<AliasLookup | null> {
  let response: Response;
  try {
    response = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query: ANILIST_QUERY, variables: { s: work } }),
      signal: AbortSignal.timeout(8_000)
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  const parsed = anilistSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success || !parsed.data.data.Media) return null;

  const media = parsed.data.data.Media;
  const candidates = [
    media.title.romaji ?? '',
    media.title.english ?? '',
    media.title.native ?? '',
    ...(media.synonyms ?? [])
  ].filter(Boolean);

  return { aliases: usable(work, candidates), year: media.startDate?.year ?? null };
}

const musicbrainzSchema = z.object({
  recordings: z
    .array(
      z.object({
        score: z.number().optional(),
        'first-release-date': z.string().optional(),
        'artist-credit': z
          .array(
            z.object({
              artist: z.object({
                name: z.string(),
                aliases: z.array(z.object({ name: z.string() })).optional()
              })
            })
          )
          .optional()
      })
    )
    .optional()
});

/**
 * Artist aliases and a release year, from MusicBrainz.
 *
 * Narrower than the anime case by design. Track titles are typed as they are
 * printed and rarely need alternatives, whereas artist names genuinely vary:
 * "Orelsan" is also "OrelSan" and "Orel", and a room contains all three spellings.
 * The release year is the other prize here, because a YouTube upload date is the
 * date somebody posted the video, which for a catalogue reissue is decades out
 * and would put every era facet in the wrong decade.
 */
export async function musicbrainzAliases(artist: string, title: string): Promise<AliasLookup | null> {
  const url = new URL('https://musicbrainz.org/ws/2/recording');
  url.searchParams.set('query', `artist:"${artist}" AND recording:"${title}"`);
  url.searchParams.set('fmt', 'json');
  url.searchParams.set('limit', '3');

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(8_000)
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  const parsed = musicbrainzSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return null;

  const best = (parsed.data.recordings ?? []).sort((left, right) => (right.score ?? 0) - (left.score ?? 0))[0];
  if (!best) return null;

  const credited = best['artist-credit']?.[0]?.artist;
  const candidates = [credited?.name ?? '', ...(credited?.aliases ?? []).map((alias) => alias.name)].filter(Boolean);

  const released = best['first-release-date'];
  const year = released ? Number(released.slice(0, 4)) : null;

  return {
    aliases: usable(artist, candidates),
    year: Number.isFinite(year) ? year : null
  };
}
