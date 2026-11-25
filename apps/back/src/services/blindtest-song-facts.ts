/**
 * What the slow catalogues say about one song: its year, its chart runs and its
 * certifications. The shared shape every source writes into, and the queue that
 * hands each source its next song at the pace that source allows.
 *
 * ## Why apart from `BlindtestFame`
 *
 * Deezer and Last.fm answer several times a second, so a song's fame is looked
 * up while the catalogue is scored. MusicBrainz answers once a second, and the
 * Wikipedia articles a chart run is read from need finding first: thirty-five
 * thousand songs are a night's work. So these facts are gathered in the
 * background, a song at a time, into `BlindtestSongFacts`, and a round is scored
 * with whatever has arrived so far and scored again when more does.
 *
 * Keyed like the fame cache (`fameKey`): two uploads of one song are one song.
 */

/** Which country a chart run or a certification is from. */
export type ChartCountry = 'fr' | 'uk' | 'us';

/**
 * A certification, as a multiple of the country's gold threshold at the time:
 * gold 1, platinum 2, double platinum 4, diamond 10 in France and the US. What
 * matters is that the song was certified and how far past gold, not the units,
 * which changed over the decades (a US gold single was a million sales before
 * 1989 and half that since).
 */
export type CertificationLevel = number;

export interface ChartRun {
  /** Best position reached, 1 being the top. */
  peak: number;
  /** Weeks on the chart, when the source says. */
  weeks?: number;
}

export interface SongFacts {
  /** The year the song first came out, not the compilation or remaster it is on now. */
  year?: number | null;
  yearSource?: 'musicbrainz' | 'wikidata' | 'billboard' | 'deezer';
  /** The song's own Wikidata item, when it has one. */
  wikidata?: string | null;
  /** How many Wikipedias have an article on the song itself (not its artist). */
  songWikiLanguages?: number | null;
  /** Chart runs by country, from the song's Wikipedia article or the Billboard history. */
  charts?: Partial<Record<ChartCountry, ChartRun>>;
  /** Certification levels by country. See `CertificationLevel`. */
  certifications?: Partial<Record<ChartCountry, CertificationLevel>>;
}

/** The slow sources, each drained at its own pace. */
export type SongFactsSource = 'musicbrainz' | 'wikipedia' | 'billboard';

/**
 * Merges what one source found into what is already known.
 *
 * The earliest year wins: a remaster or a compilation is always later than the
 * original, never earlier. A chart run keeps its best peak and longest stay, and
 * a certification its highest level, whichever source reported them.
 */
export function mergeSongFacts(known: SongFacts, found: SongFacts): SongFacts {
  const merged: SongFacts = { ...known };
  if (typeof found.year === 'number' && (typeof known.year !== 'number' || found.year < known.year)) {
    merged.year = found.year;
    if (found.yearSource) merged.yearSource = found.yearSource;
  }
  if (found.wikidata && !known.wikidata) merged.wikidata = found.wikidata;
  if (typeof found.songWikiLanguages === 'number') {
    merged.songWikiLanguages = Math.max(found.songWikiLanguages, known.songWikiLanguages ?? 0);
  }
  for (const [country, run] of Object.entries(found.charts ?? {}) as [ChartCountry, ChartRun][]) {
    const before = merged.charts?.[country];
    const weeks = Math.max(run.weeks ?? 0, before?.weeks ?? 0);
    merged.charts = {
      ...merged.charts,
      [country]: { peak: Math.min(run.peak, before?.peak ?? Infinity), ...(weeks > 0 ? { weeks } : {}) }
    };
  }
  for (const [country, level] of Object.entries(found.certifications ?? {}) as [ChartCountry, number][]) {
    merged.certifications = {
      ...merged.certifications,
      [country]: Math.max(level, merged.certifications?.[country] ?? 0)
    };
  }
  return merged;
}
