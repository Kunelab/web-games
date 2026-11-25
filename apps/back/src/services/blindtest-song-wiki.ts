/**
 * What Wikipedia and Wikidata say about one song: the year it came out, how
 * many Wikipedias have an article on it, how high it charted in France, the UK
 * and the US, and how far it was certified there.
 *
 * ## Why
 *
 * Streaming counts tell today's hits from album tracks, and say little about
 * 1962: "L'idole des jeunes" was number one in France and streams like a deep
 * cut. A song's own Wikipedia article remembers its chart run whatever its age,
 * and a song with no article anywhere is, almost always, an album track.
 *
 * ## How
 *
 * 1. The song's Wikidata item: a song, single or musical work performed by the
 *    artist (by id when the caller has the artist's item, by name otherwise)
 *    and titled like the song. Of several, the one most Wikipedias cover.
 * 2. Its year is its earliest publication date (P577), its coverage the count
 *    of its Wikipedia sitelinks.
 * 3. Its English and French articles are read for their chart and
 *    certification tables. Only those sections, never the prose, and never a
 *    cover's or a remix's: a wrong peak is worse than none, so whatever cannot
 *    be read safely is left out.
 *
 * Every request goes to Wikimedia, in series, a fifth of a second apart. A
 * request that fails makes the whole lookup `undefined`, so the caller asks
 * again later; a song that is genuinely not there is `{}`.
 */
import { z } from 'zod';

import { sameArtist, sameSong, wikipediaLanguages, type WikidataEntity } from './blindtest-fame.js';
import { mergeSongFacts, type CertificationLevel, type ChartCountry, type SongFacts } from './blindtest-song-facts.js';

/* ------------------------------------------------------------------ HTTP */

const USER_AGENT = 'KuneLabWebGames/0.3 (blind test song facts; https://github.com/Kunelab)';

/** The gap between two requests of one lane. */
const WIKIMEDIA_GAP_MS = 200;

/**
 * One Wikimedia GET: the parsed JSON body, or undefined when the request
 * failed (network error, timeout, 429, 5xx, a body that is not JSON).
 */
export type WikimediaGet = (url: URL) => Promise<unknown>;

/**
 * Three lanes, each one request at a time with the gap between: three songs are
 * read side by side, which takes the whole catalogue from days to about one,
 * and stays well inside what Wikimedia tolerates from a client that identifies
 * itself.
 */
const LANES = 3;
const wikimediaTurns: Promise<unknown>[] = Array.from({ length: LANES }, () => Promise.resolve());
let nextLane = 0;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Requests spread over the lanes, each starting a gap after the previous one of its lane ended. */
function inTurn<T>(run: () => Promise<T>): Promise<T> {
  const lane = nextLane;
  nextLane = (nextLane + 1) % LANES;
  const next = (wikimediaTurns[lane] ?? Promise.resolve()).then(() => pause(WIKIMEDIA_GAP_MS)).then(run);
  wikimediaTurns[lane] = next.catch(() => undefined);
  return next;
}

const liveGet: WikimediaGet = (url) =>
  inTurn(async () => {
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000)
    }).catch(() => null);
    if (!response?.ok) return undefined;
    return await response.json().catch(() => undefined);
  });

function apiUrl(host: string, params: Record<string, string>): URL {
  const url = new URL(`https://${host}/w/api.php`);
  for (const [key, value] of Object.entries({ format: 'json', formatversion: '2', ...params })) {
    url.searchParams.set(key, value);
  }
  return url;
}

/* -------------------------------------------------------------- Wikidata */

/**
 * What a song's item is an instance of (P31): a song, a single, a musical work
 * or composition, or a recorded track. Albums, tours and videos are not songs.
 */
const SONG_TYPES = new Set([
  'Q7366', // song
  'Q134556', // single
  'Q105543609', // musical work/composition
  'Q2188189', // musical work
  'Q207628', // composed musical work
  'Q55850593', // music track with vocals
  'Q55850643' // music track without lyrics
]);

const searchSchema = z.object({
  query: z.object({ search: z.array(z.object({ title: z.string() })) })
});

const snakSchema = z.object({ mainsnak: z.object({ datavalue: z.object({ value: z.unknown() }).optional() }) });

const entitiesSchema = z.object({
  entities: z.record(
    z.string(),
    z.object({
      id: z.string().optional(),
      missing: z.string().optional(),
      labels: z.record(z.string(), z.object({ value: z.string() })).optional(),
      sitelinks: z.record(z.string(), z.object({ title: z.string() })).optional(),
      claims: z.record(z.string(), z.array(snakSchema)).optional()
    })
  )
});

/** A Wikidata item as this module reads it: the shared shape, plus its publication years. */
interface SongItem extends WikidataEntity {
  /** The years of its P577 publication dates. */
  years: number[];
}

function itemId(value: unknown): string | null {
  const id = (value as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : null;
}

/** The year of a Wikidata time value ("+1968-00-00T00:00:00Z"), when it has one. */
function timeYear(value: unknown): number | null {
  const time = (value as { time?: unknown } | null)?.time;
  const precision = (value as { precision?: unknown } | null)?.precision;
  if (typeof time !== 'string' || (typeof precision === 'number' && precision < 9)) return null;
  const match = /^\+(\d{4})-/.exec(time);
  return match ? Number(match[1]) : null;
}

/** A `wbgetentities` answer, by id; null when it is not one. */
function parseItems(body: unknown): Map<string, SongItem> | null {
  const parsed = entitiesSchema.safeParse(body);
  if (!parsed.success) return null;
  const items = new Map<string, SongItem>();
  for (const [key, raw] of Object.entries(parsed.data.entities)) {
    if (raw.missing !== undefined) continue;
    const claims: Record<string, string[]> = {};
    for (const [property, statements] of Object.entries(raw.claims ?? {})) {
      claims[property] = statements
        .map((statement) => itemId(statement.mainsnak.datavalue?.value))
        .filter((id): id is string => id !== null);
    }
    const years = (raw.claims?.P577 ?? [])
      .map((statement) => timeYear(statement.mainsnak.datavalue?.value))
      .filter((year): year is number => year !== null);
    const id = raw.id ?? key;
    items.set(id, {
      id,
      labels: Object.fromEntries(Object.entries(raw.labels ?? {}).map(([language, label]) => [language, label.value])),
      sitelinks: Object.fromEntries(Object.entries(raw.sitelinks ?? {}).map(([site, link]) => [site, link.title])),
      claims,
      years
    });
  }
  return items;
}

/** Item ids from a `list=search`; null when the answer is not one. */
async function searchItems(get: WikimediaGet, query: string, limit: number): Promise<string[] | null> {
  const body = await get(
    apiUrl('www.wikidata.org', {
      action: 'query',
      list: 'search',
      srsearch: query,
      srlimit: String(limit),
      srnamespace: '0'
    })
  );
  const parsed = searchSchema.safeParse(body);
  return parsed.success ? parsed.data.query.search.map((hit) => hit.title).filter((id) => /^Q\d+$/.test(id)) : null;
}

async function fetchItems(get: WikimediaGet, ids: string[], props: string): Promise<Map<string, SongItem> | null> {
  if (ids.length === 0) return new Map();
  return parseItems(
    await get(
      apiUrl('www.wikidata.org', { action: 'wbgetentities', ids: ids.join('|'), props, languages: 'mul|en|fr' })
    )
  );
}

/**
 * Words CirrusSearch can take as they are: letters, digits, apostrophes.
 * Quotes, dashes and stars are its own syntax.
 */
function searchWords(text: string): string {
  return text
    .replace(/[^\p{L}\p{N}'’]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The words of a title worth searching for: without what a catalogue adds in
 * brackets ("(Remastered 2009)", "(feat. Kimbra)"), apostrophes kept, since
 * the search finds "L'idole" and not "Lidole".
 */
function titleWords(title: string): string {
  return searchWords(title.replace(/\s*[([].*?[)\]]/g, '')) || searchWords(title);
}

/** An article title without its disambiguation: "Californication (song)" is "Californication". */
function articleName(title: string): string {
  return title.replace(/\s*\([^)]*\)\s*$/, '');
}

/** Whether the item is titled like the song, in any of its labels or its English or French article. */
function titledLike(item: SongItem, title: string): boolean {
  const names = [
    ...Object.values(item.labels),
    ...['enwiki', 'frwiki'].flatMap((site) => (item.sitelinks[site] ? [articleName(item.sitelinks[site])] : []))
  ];
  return names.some((name) => sameSong(name, title));
}

const isSong = (item: SongItem) => (item.claims.P31 ?? []).some((type) => SONG_TYPES.has(type));

/** The best of the matching items: the most Wikipedias, then the lowest id (the older item). */
function best(items: { item: SongItem; rank: number }[]): SongItem | null {
  const sorted = [...items].sort(
    (a, b) =>
      b.rank - a.rank ||
      wikipediaLanguages(b.item) - wikipediaLanguages(a.item) ||
      Number(a.item.id.slice(1)) - Number(b.item.id.slice(1))
  );
  return sorted[0]?.item ?? null;
}

/**
 * The song's item when the artist's item is known: performed by them (P175),
 * or failing that composed or written by them (P86, P676).
 */
async function songItemByArtistId(
  get: WikimediaGet,
  artistQid: string,
  title: string
): Promise<SongItem | null | undefined> {
  const ids = await searchItems(
    get,
    `haswbstatement:P175=${artistQid}|P86=${artistQid}|P676=${artistQid} ${titleWords(title)}`,
    20
  );
  if (ids === null) return undefined;
  const items = await fetchItems(get, ids, 'claims|sitelinks|labels');
  if (items === null) return undefined;
  const matching = [...items.values()]
    .filter((item) => isSong(item) && titledLike(item, title))
    .map((item) => ({
      item,
      rank: (item.claims.P175 ?? []).includes(artistQid)
        ? 2
        : [...(item.claims.P86 ?? []), ...(item.claims.P676 ?? [])].includes(artistQid)
          ? 1
          : 0
    }))
    .filter(({ rank }) => rank > 0);
  return best(matching);
}

/**
 * The song's item by the artist's name: a song titled like it whose performer
 * is named like the artist. Searched with the artist's name first, which finds
 * "2011 song by Gotye" by its description, then by the title alone.
 */
async function songItemByArtistName(
  get: WikimediaGet,
  artist: string,
  title: string
): Promise<SongItem | null | undefined> {
  const words = titleWords(title);
  for (const query of [`${words} ${searchWords(artist)} haswbstatement:P175`, `${words} haswbstatement:P175`]) {
    const ids = await searchItems(get, query, 20);
    if (ids === null) return undefined;
    const items = await fetchItems(get, ids, 'claims|sitelinks|labels');
    if (items === null) return undefined;
    const candidates = [...items.values()].filter((item) => isSong(item) && titledLike(item, title));
    const performerIds = [...new Set(candidates.flatMap((item) => item.claims.P175 ?? []))];
    const performers = await fetchItems(get, performerIds, 'labels');
    if (performers === null) return undefined;
    const named = (id: string) =>
      Object.values(performers.get(id)?.labels ?? {}).some((label) => sameArtist(label, artist));
    const found = best(
      candidates.filter((item) => (item.claims.P175 ?? []).some(named)).map((item) => ({ item, rank: 1 }))
    );
    if (found) return found;
  }
  return null;
}

/* ------------------------------------------------------------- Wikipedia */

const parseSchema = z.object({ parse: z.object({ wikitext: z.string() }) });
const parseErrorSchema = z.object({ error: z.object({ code: z.string() }) });

/** An article's wikitext; null when there is no such article, undefined when the request failed. */
async function articleWikitext(
  get: WikimediaGet,
  language: 'en' | 'fr',
  title: string
): Promise<string | null | undefined> {
  const body = await get(
    apiUrl(`${language}.wikipedia.org`, { action: 'parse', page: title, prop: 'wikitext', redirects: '1' })
  );
  const parsed = parseSchema.safeParse(body);
  if (parsed.success) return parsed.data.parse.wikitext;
  const error = parseErrorSchema.safeParse(body);
  return error.success && error.data.error.code === 'missingtitle' ? null : undefined;
}

/* --------------------------------------------------------- wikitext tools */

/** `{{...}}` templates whose name matches, with their full text, nesting respected. */
function templates(wikitext: string, name: RegExp): string[] {
  const found: string[] = [];
  for (let index = wikitext.indexOf('{{'); index !== -1; index = wikitext.indexOf('{{', index + 2)) {
    const head = /^\{\{\s*([^|}]+?)\s*[|}]/.exec(wikitext.slice(index, index + 80));
    if (!head?.[1] || !name.test(head[1])) continue;
    const end = closing(wikitext, index);
    if (end === -1) continue;
    found.push(wikitext.slice(index, end));
    index = end - 2;
  }
  return found;
}

/** Where the template or link opened at `start` ends (just past its closing braces), or -1. */
function closing(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length - 1; index++) {
    const pair = text.slice(index, index + 2);
    if (pair === '{{' || pair === '[[') {
      depth++;
      index++;
    } else if (pair === '}}' || pair === ']]') {
      depth--;
      index++;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/** Splits at `separator` where it is not inside a template or a link. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let index = 0; index < text.length; index++) {
    const pair = text.slice(index, index + 2);
    if (pair === '{{' || pair === '[[') {
      depth++;
      index++;
    } else if ((pair === '}}' || pair === ']]') && depth > 0) {
      depth--;
      index++;
    } else if (depth === 0 && text.startsWith(separator, index)) {
      parts.push(text.slice(from, index));
      from = index + separator.length;
      index += separator.length - 1;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

interface TemplateArgs {
  positional: string[];
  named: Record<string, string>;
}

/** A template's arguments: `{{single chart|UK|1|date=19680914}}` is ["UK", "1"] and {date}. */
function templateArgs(template: string): TemplateArgs {
  const [, ...parts] = splitTopLevel(template.slice(2, -2), '|');
  const args: TemplateArgs = { positional: [], named: {} };
  for (const part of parts) {
    const named = /^\s*([^=[\]{}]+?)\s*=([\s\S]*)$/.exec(part);
    if (named?.[1]) args.named[named[1].toLowerCase()] = (named[2] ?? '').trim();
    else args.positional.push(part.trim());
  }
  return args;
}

/** Wikitext without comments, references and `<br>`s, which carry `|`s and numbers of their own. */
function withoutRefs(wikitext: string): string {
  return wikitext
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref[^>/]*\/>/gi, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ');
}

/** Flag templates, which name the country they show: `{{drapeau|France}}`, `{{flagicon|UK}}`. */
const FLAG_TEMPLATE = /^(?:drapeau\d?|drapeau-?\w*|flag\w*|flagicon|flagcountry|flagu)$/i;

/**
 * A table cell as plain words, lowercased and unaccented: links to their text,
 * flags and bare country templates (`{{France}}`) to the country, other
 * templates dropped, formatting gone.
 */
function plainText(cell: string): string {
  let text = cell;
  for (let pass = 0; pass < 3 && text.includes('{{'); pass++) {
    text = text.replace(/\{\{([^{}]*)\}\}/g, (_, inner: string) => {
      const [name = '', ...args] = inner.split('|').map((part) => part.trim());
      if (FLAG_TEMPLATE.test(name)) return ` ${args.find((arg) => !arg.includes('=')) ?? ''} `;
      if (args.length === 0 && /^[\p{L} -]+$/u.test(name)) return ` ${name} `;
      if (/^(nts|nowrap|sort|center)$/i.test(name)) return ` ${args.at(-1) ?? ''} `;
      return ' ';
    });
  }
  return text
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/\[https?:\S+\s*([^\]]*)\]/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/'{2,}/g, '')
    .replace(/&nbsp;/g, ' ')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** A cell's content without its attributes: `style="text-align:center"|1` is "1". */
function cellContent(cell: string): string {
  const parts = splitTopLevel(cell, '|');
  if (parts.length > 1 && /=/.test(parts[0] ?? '')) return parts.slice(1).join('|');
  return cell;
}

/** A chart position: a whole number from 1 to 300, nothing else in the cell. */
function position(text: string): number | null {
  const match = /^(\d{1,3})$/.exec(plainText(text).replace(/[.\s]/g, ''));
  const value = match ? Number(match[1]) : NaN;
  return value >= 1 && value <= 300 ? value : null;
}

/* -------------------------------------------------------------- sections */

interface SectionRules {
  /** A section the facts are in, or a parent of one. */
  wanted: RegExp;
  /** A section that is about something else: a year-end ranking, a cover, a remix. */
  unwanted: RegExp;
}

const EN_SECTIONS: SectionRules = {
  wanted: /\bcharts?\b|chart performance|certification|\bsales\b/i,
  unwanted:
    /year[- ]?end|decade|all[- ]time|monthly|annual|cover|remix|(?<!original )version|release history|track ?list|personnel|other /i
};

const FR_SECTIONS: SectionRules = {
  wanted: /classement|certification|ventes|hit-parade|\bcharts?\b/i,
  unwanted:
    /fin d'ann[ée]e|annuel|d[ée]cennie|tous les temps|mensuel|reprise|remix|(?<!originale? )version|succession|historique|liste des pistes|cr[ée]dits/i
};

/**
 * The parts of an article the facts are read from: under a charts or
 * certifications heading and under nothing that is about another ranking or
 * another recording.
 *
 * And only the article's own song: a second song infobox starts a cover's
 * section (frwiki puts Walk off the Earth's "Somebody That I Used to Know" after
 * Gotye's with no heading of its own), so everything from there on is dropped.
 * Infoboxes above the first heading are the song's own (a single and its
 * album version, say) and cut nothing.
 */
function factSections(wikitext: string, rules: SectionRules): string {
  const firstHeading = wikitext.search(/^==/m);
  const other =
    firstHeading === -1
      ? undefined
      : [...wikitext.matchAll(/\{\{\s*Infobox (?:song|single|musique)/gi)].find(
          (infobox) => infobox.index > firstHeading
        );
  const own = other ? wikitext.slice(0, other.index) : wikitext;
  const kept: string[] = [];
  const headings: { level: number; title: string }[] = [];
  for (const line of own.split('\n')) {
    const heading = /^(={2,6})\s*(.*?)\s*\1\s*$/.exec(line);
    if (heading?.[1]) {
      const level = heading[1].length;
      while (headings.length > 0 && (headings.at(-1)?.level ?? 0) >= level) headings.pop();
      headings.push({ level, title: plainText(heading[2] ?? '') });
      continue;
    }
    if (
      headings.some((heading) => rules.wanted.test(heading.title)) &&
      !headings.some((heading) => rules.unwanted.test(heading.title))
    ) {
      kept.push(line);
    }
  }
  return kept.join('\n');
}

/* ---------------------------------------------------------------- tables */

interface TableRow {
  cells: string[];
  /** The header cells of the table this row is in, in order. */
  columns: string[];
}

/**
 * The rows of every wikitable in the text, as their cells' raw contents.
 * References and chart templates are gone first: a reference's `|`s are not
 * cells, and a chart template is a row of its own, read elsewhere.
 */
function tableRows(wikitext: string, skip: RegExp): TableRow[] {
  let text = withoutRefs(wikitext);
  for (const template of templates(text, skip)) text = text.replace(template, '');
  const rows: TableRow[] = [];
  let columns: string[] = [];
  let cells: string[] = [];
  let header = true;
  const flush = () => {
    if (cells.length > 0) {
      if (header && cells.every((cell) => cell.startsWith('!'))) {
        columns = cells.map((cell) => plainText(cellContent(cell.slice(1))));
      } else {
        rows.push({ cells: cells.map((cell) => cellContent(cell.slice(1))), columns });
      }
    }
    if (cells.length > 0) header = false;
    cells = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('{|')) {
      flush();
      columns = [];
      header = true;
    } else if (line.startsWith('|}')) {
      flush();
    } else if (line.startsWith('|-')) {
      flush();
    } else if (line.startsWith('|+')) {
      continue;
    } else if (line.startsWith('!') || line.startsWith('|')) {
      const marker = line[0] ?? '|';
      for (const part of splitTopLevel(line.slice(1), marker === '!' ? '!!' : '||')) {
        for (const inner of marker === '!' ? splitTopLevel(part, '||') : [part]) cells.push(`${marker}${inner.trim()}`);
      }
    } else if (cells.length > 0 && line) {
      cells[cells.length - 1] += ` ${line}`;
    }
  }
  flush();
  return rows;
}

/* ---------------------------------------------------------------- charts */

export type Charts = NonNullable<SongFacts['charts']>;

/** Words a chart's name has when it is not the country's main singles chart. */
const NOT_MAIN_CHART =
  /airplay|radio|club|dance|download|digital|t[ée]l[ée]chargement|streaming|physical|vinyl|indie|independent|rock|r ?& ?b|r and b|hip ?hop|rap\b|latin|country|adult|pop songs|mainstream|alternative|bubbling|recurrent|heatseekers|christian|gospel|jazz|catalog|budget|compilation|album|rhythmic|tropical|cash ?box|record world|year|ringtone|video|afrobeats|asian|scottish|megafusion|club 40|merchandise|sales chart|singles sales|hot 100 airplay|songs/i;

/** The names a row starts with, by country, plain (see `plainText`). */
const COUNTRY_NAMES: [RegExp, ChartCountry][] = [
  [/^(?:us|u\.s\.|usa|united states|etats-unis)(?![\p{L}])/u, 'us'],
  [/^(?:uk|u\.k\.|united kingdom|royaume-uni|great britain|britain)(?![\p{L}])/u, 'uk'],
  [/^(?:france|french)(?![\p{L}])/u, 'fr']
];

/** The country of a chart's or a certification's row, by the name it starts with, and the rest of its name. */
function rowCountry(label: string): { country: ChartCountry; rest: string } | null {
  for (const [name, country] of COUNTRY_NAMES) {
    const match = name.exec(label);
    if (match) return { country, rest: label.slice(match[0].length) };
  }
  return null;
}

/**
 * Which country's main singles chart a table row's name is, if any: the
 * Billboard Hot 100, the UK Singles Chart (Official Charts, or Record Retailer
 * before it), the French singles chart (SNEP, the Top 50, or the hit parades
 * before them). An airplay, download, genre or year-end chart is none of them.
 */
export function mainChartCountry(name: string): ChartCountry | null {
  const label = plainText(name);
  const found = rowCountry(label);
  if (!found || NOT_MAIN_CHART.test(label)) return null;
  const { country, rest } = found;
  if (country === 'us') return /hot 100/.test(rest) ? 'us' : null;
  if (country === 'uk') {
    return !/[a-z]/.test(rest) || /single|occ|official chart|record retailer|top (40|50|75|100)|uk chart/.test(rest)
      ? 'uk'
      : null;
  }
  return !/[a-z]/.test(rest) ||
    /snep|top (50|100|200)|single|ifop|hit[- ]parade|snicop|classement|infinity|charts in france/.test(rest)
    ? 'fr'
    : null;
}

/** Chart template ids for the main singles charts, enwiki's and frwiki's (which ignores case). */
const CHART_IDS: Record<string, ChartCountry> = {
  france: 'fr',
  uk: 'uk',
  uk2: 'uk',
  uksinglesbyname: 'uk',
  uksinglesbydate: 'uk',
  ukchartstats: 'uk',
  ukzobbel: 'uk',
  ukchartarchive: 'uk',
  'royaume-uni': 'uk',
  billboardhot100: 'us'
};

/** A note on a chart row that makes it another recording's run. */
const OTHER_RECORDING = /remix|version|live|cover|acoustic|re-?recording|\bmix\b|\bedit\b|taylor's/i;

const CHART_TEMPLATE = /^single ?chart$/i;

function keepBest(charts: Charts, country: ChartCountry, peak: number, weeks?: number): void {
  const before = charts[country];
  const bestWeeks = Math.max(weeks ?? 0, before?.weeks ?? 0);
  charts[country] = { peak: Math.min(peak, before?.peak ?? Infinity), ...(bestWeeks > 0 ? { weeks: bestWeeks } : {}) };
}

/**
 * Peaks from chart templates: `{{single chart|UK|1|date=19680914}}`, and
 * frwiki's `{{singlechart|France|39|...}}`.
 */
function templateCharts(wikitext: string, charts: Charts): void {
  for (const template of templates(withoutRefs(wikitext), CHART_TEMPLATE)) {
    const { positional, named } = templateArgs(template);
    const country = CHART_IDS[(positional[0] ?? '').trim().toLowerCase()];
    const peak = position(positional[1] ?? '');
    if (!country || peak === null || OTHER_RECORDING.test(named.note ?? '')) continue;
    keepBest(charts, country, peak);
  }
}

/**
 * Peaks from table rows: a chart's name, then its peak, as in
 * `!scope="row"|US Billboard Hot 100 | 1` or `|{{France}} (SNEP) || 10`. Weeks
 * too, when the table has a column for them.
 */
function tableCharts(wikitext: string, charts: Charts): void {
  for (const { cells, columns } of tableRows(wikitext, CHART_TEMPLATE)) {
    const labelAt = cells.findIndex((cell) => /\p{L}/u.test(plainText(cell)));
    const country = labelAt === -1 ? null : mainChartCountry(cells[labelAt] ?? '');
    if (!country) continue;
    const peakAt = cells.findIndex((cell, index) => index > labelAt && position(cell) !== null);
    const peak = peakAt === -1 ? null : position(cells[peakAt] ?? '');
    if (peak === null) continue;
    const weeksColumn = columns.findIndex((column) => /weeks|semaines/.test(column));
    const peakColumn = columns.findIndex((column) => /peak|position|meilleur/.test(column));
    const weeks =
      weeksColumn !== -1 && peakColumn !== -1 && cells.length === columns.length && peakAt === peakColumn
        ? (position(cells[weeksColumn] ?? '') ?? undefined)
        : undefined;
    keepBest(charts, country, peak, weeks);
  }
}

/** Peaks in the UK, the US and France from an English Wikipedia article. */
export function parseEnwikiCharts(wikitext: string): Charts {
  const sections = factSections(wikitext, EN_SECTIONS);
  const charts: Charts = {};
  templateCharts(sections, charts);
  tableCharts(sections, charts);
  return charts;
}

/** Peaks in France, the UK and the US from a French Wikipedia article. */
export function parseFrwikiCharts(wikitext: string): Charts {
  const sections = factSections(wikitext, FR_SECTIONS);
  const charts: Charts = {};
  templateCharts(sections, charts);
  tableCharts(sections, charts);
  return charts;
}

/* -------------------------------------------------------- certifications */

export type Certifications = NonNullable<SongFacts['certifications']>;

const REGIONS: Record<string, ChartCountry> = { france: 'fr', 'united kingdom': 'uk', 'united states': 'us' };

/**
 * A certification as a multiple of gold (see `CertificationLevel`): silver
 * half, gold 1, platinum 2, diamond 10, each times how many.
 */
export function certificationLevel(award: string, count = 1): CertificationLevel | null {
  const name = plainText(award);
  const times = Number.isFinite(count) && count >= 1 ? count : 1;
  if (/diamond|diamant/.test(name)) return 10 * times;
  if (/platinum|platine/.test(name)) return 2 * times;
  if (/gold|\bor\b/.test(name)) return times;
  if (/silver|argent/.test(name)) return 0.5 * times;
  return null;
}

/** "Double", "triple"... in front of an award, as a number. */
function spelledCount(text: string): number | null {
  const words: Record<string, number> = { double: 2, triple: 3, quadruple: 4, quintuple: 5 };
  const match = /\b(double|triple|quadruple|quintuple)\b/.exec(text);
  if (match?.[1]) return words[match[1]] ?? null;
  const times = /(\d+)\s*(?:x|×|&#215;)/.exec(text);
  return times?.[1] ? Number(times[1]) : null;
}

function keepHighest(certifications: Certifications, country: ChartCountry, level: number): void {
  certifications[country] = Math.max(level, certifications[country] ?? 0);
}

/** Certifications a release that is not the single gets: an album, a video, a ringtone. */
const NOT_A_SINGLE = /album|video|ringtone|mastertone|\bep\b/i;

/**
 * `{{Certification Table Entry|region=United Kingdom|type=single|award=Platinum|number=2}}`:
 * the form enwiki uses, which some frwiki articles borrow.
 */
function templateCertifications(wikitext: string, certifications: Certifications): void {
  for (const template of templates(withoutRefs(wikitext), /^certification table entry$/i)) {
    const { named } = templateArgs(template);
    const country = REGIONS[(named.region ?? '').toLowerCase()];
    if (!country || named.nocert || NOT_A_SINGLE.test(named.type ?? '') || !named.award) continue;
    const level = certificationLevel(named.award, Number(named.number ?? 1) || 1);
    if (level !== null) keepHighest(certifications, country, level);
  }
}

/** Countries by their certifying body, for rows that name only that. */
const CERTIFIERS: [RegExp, ChartCountry][] = [
  [/\bsnep\b/, 'fr'],
  [/\bbpi\b/, 'uk'],
  [/\briaa\b/, 'us']
];

/**
 * Certification table rows: a country, then its award, as
 * `| France (SNEP) | {{Certification|platine|2}}` or `| États-Unis (RIAA) | Disque d'or`.
 */
function tableCertifications(wikitext: string, certifications: Certifications): void {
  for (const { cells } of tableRows(wikitext, /^certification table entry$/i)) {
    const labelAt = cells.findIndex((cell) => /\p{L}/u.test(plainText(cell)));
    if (labelAt === -1) continue;
    const label = plainText(cells[labelAt] ?? '');
    const country = rowCountry(label)?.country ?? CERTIFIERS.find(([body]) => body.test(label))?.[1] ?? null;
    if (!country) continue;
    for (const cell of cells.slice(labelAt + 1)) {
      const template = templates(cell, /^certification$/i)[0];
      let level: number | null = null;
      if (template) {
        const { positional } = templateArgs(template);
        level = certificationLevel(positional[0] ?? '', Number(positional[1] ?? 1) || 1);
      } else {
        const text = plainText(cell);
        if (/disque|platinum|platine|gold|diamond|diamant|silver|argent|\bor\b/.test(text)) {
          level = certificationLevel(text, spelledCount(text) ?? 1);
        }
      }
      if (level !== null) {
        keepHighest(certifications, country, level);
        break;
      }
    }
  }
}

/** Certification levels in France, the UK and the US from an English Wikipedia article. */
export function parseEnwikiCertifications(wikitext: string): Certifications {
  const certifications: Certifications = {};
  templateCertifications(factSections(wikitext, EN_SECTIONS), certifications);
  return certifications;
}

/** Certification levels in France, the UK and the US from a French Wikipedia article. */
export function parseFrwikiCertifications(wikitext: string): Certifications {
  const sections = factSections(wikitext, FR_SECTIONS);
  const certifications: Certifications = {};
  templateCertifications(sections, certifications);
  tableCertifications(sections, certifications);
  return certifications;
}

/* ------------------------------------------------------------------ main */

/**
 * The facts from one article, when its title is the song's. An item can cover
 * a song and its adaptation: "L'idole des jeunes" and Ricky Nelson's "Teen Age
 * Idol" are one item, and the English article's chart run is Ricky Nelson's.
 */
async function articleFacts(
  get: WikimediaGet,
  language: 'en' | 'fr',
  item: SongItem,
  title: string
): Promise<SongFacts | undefined> {
  const article = item.sitelinks[`${language}wiki`];
  if (!article || !sameSong(articleName(article), title)) return {};
  const wikitext = await articleWikitext(get, language, article);
  if (wikitext === undefined) return undefined;
  if (wikitext === null) return {};
  const charts = language === 'en' ? parseEnwikiCharts(wikitext) : parseFrwikiCharts(wikitext);
  const certifications = language === 'en' ? parseEnwikiCertifications(wikitext) : parseFrwikiCertifications(wikitext);
  return {
    ...(Object.keys(charts).length > 0 ? { charts } : {}),
    ...(Object.keys(certifications).length > 0 ? { certifications } : {})
  };
}

/**
 * `wikipediaSongFacts` against any Wikimedia: the live one in production, a
 * fixture in the tests.
 */
export async function songFactsFrom(
  get: WikimediaGet,
  artist: string,
  title: string,
  artistQid?: string | null
): Promise<SongFacts | undefined> {
  const item = artistQid
    ? await songItemByArtistId(get, artistQid, title)
    : await songItemByArtistName(get, artist, title);
  if (item === undefined) return undefined;
  if (item === null) return {};
  const languages = wikipediaLanguages(item);
  // An item no Wikipedia has an article on is an album track's: nothing to say.
  if (languages === 0) return {};

  let facts: SongFacts = { wikidata: item.id, songWikiLanguages: languages };
  const year = Math.min(...item.years);
  if (Number.isFinite(year)) facts = { ...facts, year, yearSource: 'wikidata' };
  for (const language of ['en', 'fr'] as const) {
    const found = await articleFacts(get, language, item, title);
    if (found === undefined) return undefined;
    facts = mergeSongFacts(facts, found);
  }
  return facts;
}

/**
 * What Wikipedia and Wikidata say about a song (see the module comment).
 * `undefined` when a request failed, so the caller asks again later; `{}` when
 * the song has no item or no article.
 */
export async function wikipediaSongFacts(
  artist: string,
  title: string,
  artistQid?: string | null
): Promise<SongFacts | undefined> {
  return songFactsFrom(liveGet, artist, title, artistQid);
}
