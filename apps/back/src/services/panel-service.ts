import { normalizeAnswer } from 'game-core';
import { z } from 'zod';

/**
 * Builds a memory panel out of Wikipedia.
 *
 * Authoring a panel by hand is twenty image URLs and twenty answers, which is the
 * one job in the editor nobody will do twice. This produces the same thing from a
 * theme: a grid of subjects with a picture each, ready to review and save.
 *
 * Three things decide whether it is usable, and all three come from how the source
 * is queried rather than from filtering afterwards:
 *
 *  - It has to be recognisable. A random draw from "mammals" yields the cynictis
 *    penicillata; a party game needs the lion. So results come back ranked by page
 *    views and incoming links, which is the closest thing to fame that a wiki
 *    knows, only the head of each ranking is kept, and the window is offset by a
 *    small random amount rather than shuffled globally, so successive panels differ
 *    without ever reaching the obscure tail.
 *  - It has to be fast. One search returns fifty candidates with their thumbnails
 *    in about 250ms, so a panel is one request per source category, run in
 *    parallel, and the results are pooled in memory so a second panel on the same
 *    theme costs nothing.
 *  - The picture has to be a picture of the subject. The API only emits a
 *    thumbnail URL for a file it can actually render, which settles existence; what
 *    it does not settle is whether the file is a placeholder, a signature or a
 *    coat of arms, which is what the shape and filename rules below are for.
 *
 * Existence was checked here at first, with a HEAD request per cell. It was dropped:
 * it re-established what the API had already promised, forty of them at once earns a
 * rate limit from Wikimedia, and it added seconds to a button that has to feel
 * instant. The editor renders every cell as it arrives, so the browser performs the
 * only existence check that actually matters, on the machine that will have to draw
 * the thing, and flags any cell that fails.
 */

/** Wikimedia asks for a descriptive agent, and rate-limits generic ones. */
const USER_AGENT = 'KuneLabWebGames/0.3 (memory panel builder; https://github.com/Kunelab)';

const WIKI_API = 'https://fr.wikipedia.org/w/api.php';

/** Width of the thumbnails a panel is built from. */
const THUMBNAIL_WIDTH = 400;

/** Candidates per search. The API caps this at 50 for anonymous callers. */
const SEARCH_LIMIT = 50;

/**
 * One category to draw from, and how far down it a draw may start.
 *
 * `depth` is the whole quality control, and it has to be per category rather than
 * per theme because the categories differ enormously in how far their fame
 * extends. There are three hundred actresses everyone has heard of, so a window
 * starting at forty is still a party game; there are about twenty famous fruits,
 * and by the fortieth the article is Phyllanthus emblica. Measured by hand against
 * the live source, category by category.
 */
interface PanelSource {
  category: string;
  depth: number;
  /**
   * How many of a window's results to keep. The default takes half of what comes
   * back; a lower number is for a category whose famous head is short, which is
   * most of them: "Outil de jardinage" opens with the wheelbarrow and the watering
   * can and is selling you a rotogriffe by the tenth result.
   */
  keep?: number;
}

/** Kept per window by default, out of the fifty a search returns. */
const DEFAULT_KEEP = 24;

export interface PanelTheme {
  id: string;
  label: string;
  sources: PanelSource[];
  /** True where a drawing rather than a photograph is the norm, i.e. flags. */
  allowVector?: boolean;
  /** Strips a title down to the answer, e.g. "Drapeau du Japon" to "Japon". */
  titlePrefix?: RegExp;
}

export const PANEL_THEMES: PanelTheme[] = [
  {
    id: 'celebrites',
    label: 'Célébrités',
    sources: [
      { category: 'Actrice américaine de cinéma', depth: 20 },
      { category: 'Acteur américain de cinéma', depth: 20 },
      { category: 'Actrice française de cinéma', depth: 20 },
      { category: 'Acteur français de cinéma', depth: 20 },
      { category: 'Chanteuse américaine', depth: 0, keep: 12 },
      { category: 'Chanteur américain', depth: 0, keep: 12 }
    ]
  },
  {
    id: 'animaux',
    label: 'Animaux',
    sources: [
      { category: 'Mammifère (nom vernaculaire)', depth: 20 },
      { category: 'Oiseau (nom vernaculaire)', depth: 20, keep: 16 }
      // Neither fish nor insects are in the theme: their most popular articles are
      // the baudroie, the cladistians and the strawberry tortrix, and a category
      // small enough to be kept in full contributes its tail to every single draw.
    ]
  },
  {
    id: 'drapeaux',
    label: 'Drapeaux',
    // Every country is a fair answer, so this one is drawn from end to end.
    sources: [{ category: 'Drapeau national', depth: 100, keep: 50 }],
    allowVector: true,
    // The article is "Drapeau du Japon"; the answer is "Japon".
    titlePrefix: /^drapeau\s+(?:de\s+la\s+|de\s+l['’]|de\s+|du\s+|des\s+|d['’])?/i
  },
  {
    id: 'nourriture',
    label: 'Nourriture',
    sources: [
      { category: 'Fruit alimentaire', depth: 0, keep: 14 },
      { category: 'Pâtisserie', depth: 20, keep: 16 },
      { category: 'Épice', depth: 0, keep: 16 },
      { category: 'Dessert', depth: 0, keep: 16 },
      { category: 'Confiserie', depth: 0, keep: 16 },
      { category: 'Cuisine italienne', depth: 0, keep: 16 },
      { category: 'Cuisine japonaise', depth: 0, keep: 12 },
      { category: 'Légume', depth: 0, keep: 12 }
    ]
  },
  {
    id: 'objets',
    label: 'Objets',
    sources: [
      { category: 'Ustensile de cuisine', depth: 20 },
      { category: 'Appareil électroménager', depth: 0 },
      { category: 'Vaisselle', depth: 0, keep: 12 },
      { category: 'Siège (meuble)', depth: 0, keep: 12 },
      { category: 'Jouet', depth: 0, keep: 8 },
      { category: 'Outil', depth: 0, keep: 12 },
      { category: 'Arme blanche', depth: 0, keep: 6 },
      { category: 'Outil de jardinage', depth: 0, keep: 8 }
    ]
  }
];

export const panelThemeIds = PANEL_THEMES.map((theme) => theme.id);

export interface PanelItem {
  /** The answer, cleaned of qualifiers and prefixes. */
  label: string;
  /** Other accepted spellings, e.g. the full article title for a flag. */
  aliases: string[];
  imageUrl: string;
  /** Where it came from, so a host can check a doubtful one. */
  pageUrl: string;
  theme: string;
}

export class PanelError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'PanelError';
    this.statusCode = statusCode;
  }
}

/* ------------------------------------------------------------------- fetching */

/** Only what is read, so a MediaWiki change fails loudly rather than silently. */
const searchResponseSchema = z.object({
  query: z
    .object({
      pages: z
        .array(
          z.object({
            title: z.string(),
            thumbnail: z
              .object({ source: z.string(), width: z.number(), height: z.number() })
              .optional()
          })
        )
        .default([])
    })
    .optional()
});

/**
 * One window of a category, most recognisable first.
 *
 * `incategory` is a search filter rather than a category listing, which is what
 * makes the ordering possible at all: a plain category listing is alphabetical, so
 * it would hand back the same Aaliyah every time. The ranking then comes from
 * `popular_inclinks_pv`, which weighs page views as well as incoming links.
 * Incoming links alone were tried first and are not enough: species articles cite
 * each other relentlessly, so ranking a taxonomy by links promotes the dhole and
 * the grunion over the lion.
 */
async function searchCategory(category: string, offset: number): Promise<PanelCandidate[]> {
  const url = new URL(WIKI_API);
  const params: Record<string, string> = {
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrsearch: `incategory:"${category}"`,
    gsrnamespace: '0',
    gsrlimit: String(SEARCH_LIMIT),
    gsrsort: 'relevance',
    gsrqiprofile: 'popular_inclinks_pv',
    gsroffset: String(offset),
    prop: 'pageimages',
    piprop: 'thumbnail',
    pithumbsize: String(THUMBNAIL_WIDTH),
    pilimit: String(SEARCH_LIMIT),
    // Free licences only: a panel is shown to a room full of people.
    pilicense: 'free'
  };
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(8_000)
  });

  if (!response.ok) {
    throw new PanelError(`Wikipedia a répondu ${response.status}`, 502);
  }

  const parsed = searchResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new PanelError('Réponse inattendue de Wikipedia', 502);
  }

  const candidates: PanelCandidate[] = [];
  for (const page of parsed.data.query?.pages ?? []) {
    if (!page.thumbnail) continue;
    candidates.push({
      title: page.title,
      // The API tags thumbnails with utm_* parameters. Dropped so the stored URL
      // is the image and nothing else, and so the same picture always yields the
      // same per-round asset token.
      source: page.thumbnail.source.split('?')[0] ?? page.thumbnail.source,
      width: page.thumbnail.width,
      height: page.thumbnail.height
    });
  }

  return candidates;
}

interface PanelCandidate {
  title: string;
  source: string;
  width: number;
  height: number;
}

/* -------------------------------------------------------------------- filters */

/** Article titles that are about a subject rather than being one. */
const META_PREFIXES = [
  'liste ',
  'histoire ',
  'type ',
  'types ',
  'classification',
  'glossaire',
  'lexique',
  'chronologie',
  'droit ',
  'culture ',
  'economie ',
  'entretien ',
  'materiaux',
  'production ',
  'fabrication '
];

/** Reads as prose about a subject: "Mobilier dans l'Égypte antique". */
const META_INFIXES = [' dans ', ' par '];

/**
 * Titles that survive every rule above and are still not panel material.
 *
 * A hand-written list is unsatisfying but it is the honest shape of the problem: a
 * wiki category holds the practice as well as the thing, and "maraîchage" shares no
 * word with "Légume" and is four letters long, so nothing general catches it. Every
 * entry here was seen in an actual draw. Normalised, so accents and case are moot.
 */
const EXCLUDED_TITLES = new Set([
  'maraichage',
  'jardin potager',
  'brunoise',
  'legume vert',
  'legume fruit',
  'confiseur',
  'pizzeria',
  'pizzaiolo',
  'trattoria',
  'ludotheque',
  'entartage',
  'etiquette energie',
  'cladistiens',
  'poisson de fond',
  'pate',
  'glacage',
  'mixologue',
  'sculpture sur fruits',
  'micropousse',
  'electromenager',
  'vaisselle',
  'outil',
  'jouet',
  'vetement',
  'oiseau',
  'fromage rape'
]);

/** Words too small to carry meaning when comparing a title to its category. */
const SMALL_WORDS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'a', 'au', 'aux', 'en', 'et', 'l', 'd']);

/** Beyond this a title is a sentence, and a sentence is never a panel answer. */
const MAX_TITLE_WORDS = 4;

/** A thumbnail this small is an icon, a signature or a placeholder. */
const MIN_THUMBNAIL_SIDE = 160;

/** Portraits run to about 0.6, flags to about 2; outside this it is not a subject. */
const MIN_ASPECT = 0.4;
const MAX_ASPECT = 2.6;

/** Filenames that are placeholders rather than pictures of anything. */
const FILLER_FILE = /replace[_ -]?this|no[_ -]?(free[_ -]?)?image|placeholder|question[_ -]?mark|disambig|^blank|signature|coat[_ -]?of[_ -]?arms|armoiries|blason|locator|location[_ -]?map|\.ogg$|\.webm$/i;

function significantWords(text: string): string[] {
  return normalizeAnswer(text)
    .split(' ')
    .filter((word) => word.length > 1 && !SMALL_WORDS.has(word));
}

/**
 * Turns an article title into an answer, or rejects it.
 *
 * The rejections are all about the same thing: a category contains articles about
 * its own subject matter as well as instances of it, and "Ustensile de cuisine",
 * "Liste de fromages français" and "Classification des instruments de musique" are
 * not things you can point at in a photograph. The test that catches most of them
 * is whether the title says anything the category does not: if every meaningful
 * word of the title already appears in the category name, the article is about the
 * category. That keeps "Fruit de la passion" while dropping "Fruit alimentaire".
 */
function toAnswerLabel(title: string, theme: PanelTheme, category: string): string | null {
  // A trailing qualifier disambiguates the article, it is not part of the answer:
  // "Gendarme (insecte)" is answered "Gendarme".
  let label = title.replace(/\s*\([^)]*\)\s*$/, '').trim();

  if (theme.titlePrefix) {
    label = label.replace(theme.titlePrefix, '').trim();
    // "Drapeau de la République populaire de Chine" leaves a lowercase start.
    label = label.charAt(0).toUpperCase() + label.slice(1);
  }

  if (!label || label.length > 60) return null;
  // Digits, commas and colons all mean a list, a year or an edition.
  if (/[\d,:;]/.test(label)) return null;

  const normalized = normalizeAnswer(label);
  if (!normalized) return null;
  if (EXCLUDED_TITLES.has(normalized)) return null;
  if (normalized.split(' ').length > MAX_TITLE_WORDS) return null;
  if (META_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return null;
  if (META_INFIXES.some((infix) => normalized.includes(infix))) return null;

  const categoryWords = new Set(significantWords(category));
  const titleWords = significantWords(label);
  const saysSomethingNew = titleWords.some(
    (word) => ![...categoryWords].some((other) => word.startsWith(other) || other.startsWith(word))
  );
  if (titleWords.length > 0 && !saysSomethingNew) return null;

  return label;
}

function looksLikeAPicture(candidate: PanelCandidate, theme: PanelTheme): boolean {
  const file = decodeURIComponent(candidate.source);

  if (FILLER_FILE.test(file)) return false;
  // A vector is a diagram or an icon, except where the subject is itself a design.
  if (!theme.allowVector && /\.svg\//i.test(file)) return false;

  if (candidate.width < MIN_THUMBNAIL_SIDE || candidate.height < MIN_THUMBNAIL_SIDE) return false;

  const aspect = candidate.width / candidate.height;
  return aspect >= MIN_ASPECT && aspect <= MAX_ASPECT;
}

/* ---------------------------------------------------------------------- pools */

/**
 * A pooled candidate keeps where it stood in the ranking.
 *
 * Which matters when a panel is bigger than one category's good head: a draw of
 * forty foods has to come from most of the categories, and picking those forty
 * uniformly at random mixes the raisin and the goyave with the oxycoccos.
 *
 * Held as a fraction of what that category keeps, never as the raw position: 0 is
 * the head of a category and 1 the last item worth having from it. Absolute
 * positions are not comparable across categories, and using them put the tail of a
 * category of eight insects ahead of the famous half of a category of two hundred
 * mammals, which is how a memory panel ends up opening with a strawberry tortrix.
 *
 * Not part of `PanelItem`: it is a fact about the source, not about the panel.
 */
interface PooledItem extends PanelItem {
  rank: number;
}

interface Pool {
  items: PooledItem[];
  fetchedAt: number;
}

/** Long enough that a session of authoring costs one fetch per category. */
const POOL_TTL_MS = 6 * 60 * 60 * 1000;

/** Bounds memory: five themes of a few hundred items each is nothing, but it grows. */
const MAX_POOL_SIZE = 400;

const pools = new Map<string, Pool>();

function poolKey(theme: PanelTheme, source: PanelSource): string {
  return `${theme.id}|${source.category}`;
}

function cachedPool(theme: PanelTheme, source: PanelSource, now: number): PooledItem[] | null {
  const pool = pools.get(poolKey(theme, source));
  if (!pool || now - pool.fetchedAt >= POOL_TTL_MS) {
    return null;
  }
  return pool.items;
}

/**
 * Draws from one category, merging into whatever has been drawn before.
 *
 * The pool grows across calls rather than being replaced, so a host generating
 * several panels in a row keeps widening the choice instead of re-fetching the same
 * window, and only the first panel of a session pays for a round trip.
 */
async function fillPool(theme: PanelTheme, source: PanelSource, now: number): Promise<PooledItem[]> {
  const key = poolKey(theme, source);
  const existing = pools.get(key);
  const pool: Pool =
    existing && now - existing.fetchedAt < POOL_TTL_MS ? existing : { items: [], fetchedAt: now };

  // Windows start on a round number so that repeated draws reuse the same few
  // windows, which keeps the cache useful instead of fetching a new offset forever.
  const windows = Math.floor(source.depth / 20) + 1;
  const offset = Math.floor(Math.random() * windows) * 20;

  let candidates = await searchCategory(source.category, offset);

  // A window past the end of a thin category comes back short; the top of it never
  // does, and is the better material anyway.
  if (candidates.length < 10 && offset > 0) {
    candidates = await searchCategory(source.category, 0);
  }

  const known = new Set(pool.items.map((item) => item.label));
  const fresh: PooledItem[] = [];
  const keep = source.keep ?? DEFAULT_KEEP;

  for (const candidate of candidates) {
    // The order the search returned is the order of fame, so the cut has to happen
    // here, on this window, and not after everything has been pooled and shuffled.
    if (fresh.length >= keep) break;
    if (!looksLikeAPicture(candidate, theme)) continue;

    const label = toAnswerLabel(candidate.title, theme, source.category);
    if (!label || known.has(label)) continue;
    known.add(label);

    fresh.push({
      label,
      aliases: label === candidate.title ? [] : [candidate.title],
      imageUrl: candidate.source,
      pageUrl: `https://fr.wikipedia.org/wiki/${encodeURIComponent(candidate.title.replace(/ /g, '_'))}`,
      theme: theme.id,
      // Relative to this category's head, and counting the window offset, so an
      // item drawn from deeper down ranks below the same category's top.
      rank: (offset + fresh.length) / keep
    });
  }

  pool.items.push(...fresh);

  if (pool.items.length > MAX_POOL_SIZE) {
    pool.items = pool.items.slice(-MAX_POOL_SIZE);
  }

  pool.fetchedAt = now;
  pools.set(key, pool);
  return pool.items;
}

/** Usable items a category is expected to yield, for deciding how many to fetch. */
const YIELD_PER_CATEGORY = 12;

/**
 * Never draw a theme from a single category.
 *
 * One category can supply a whole panel on its own, and that is the problem: a
 * twelve-cell animal panel drawn from the fish category alone is a panel of fish,
 * and the weakest category in a theme is exactly the one that must not be allowed
 * to fill it. The second fetch is paid once and cached.
 */
const MIN_CATEGORIES_PER_DRAW = 2;

/**
 * Enough candidates from one theme, fetching as little as possible.
 *
 * Cached categories are counted first and cost nothing, so the second panel of a
 * session usually needs no network at all. Only if they fall short are further
 * categories drawn, and only as many as the shortfall needs: a theme with nine
 * categories must not fire nine requests to build a panel of twenty.
 */
async function themeCandidates(theme: PanelTheme, needed: number, now: number): Promise<PooledItem[]> {
  const sources = shuffle(theme.sources);
  const collected: PooledItem[] = [];
  const unused: PanelSource[] = [];

  for (const source of sources) {
    const cached = cachedPool(theme, source, now);
    if (cached) {
      collected.push(...cached);
    } else {
      unused.push(source);
    }
  }

  const fetchedCategories = theme.sources.length - unused.length;
  const shortfall = needed - collected.length;

  if (unused.length > 0 && (shortfall > 0 || fetchedCategories < MIN_CATEGORIES_PER_DRAW)) {
    const forShortfall = shortfall > 0 ? Math.ceil(shortfall / YIELD_PER_CATEGORY) : 0;
    const wanted = Math.min(
      unused.length,
      Math.max(forShortfall, MIN_CATEGORIES_PER_DRAW - fetchedCategories)
    );
    const fetched = await Promise.all(
      unused.slice(0, wanted).map((source) => fillPool(theme, source, now))
    );
    collected.push(...fetched.flat());
  }

  return shuffle(collected);
}

/* ----------------------------------------------------------------------- draw */

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

/** Drawn per theme beyond what is needed, so the mix is not a straight prefix. */
function withSlack(count: number): number {
  return count + Math.ceil(count / 4) + 4;
}

export const MAX_PANEL_SIZE = 50;

/**
 * A panel of `count` subjects drawn from the given themes.
 *
 * Several themes mix evenly rather than by pool size, so "everything" does not
 * become "mostly whichever category is biggest".
 */
export async function buildPanel(themeIds: string[], count: number): Promise<PanelItem[]> {
  const themes = PANEL_THEMES.filter((theme) => themeIds.includes(theme.id));
  if (themes.length === 0) {
    throw new PanelError('Aucun thème connu demandé', 400);
  }
  if (count < 1 || count > MAX_PANEL_SIZE) {
    throw new PanelError(`Un panel va de 1 à ${MAX_PANEL_SIZE} éléments`, 400);
  }

  const now = Date.now();
  const perTheme = withSlack(Math.ceil(count / themes.length));

  const byTheme = await Promise.all(themes.map((theme) => themeCandidates(theme, perTheme, now)));

  const drawn: PooledItem[] = [];
  for (const themeItems of byTheme) {
    drawn.push(...themeItems.slice(0, perTheme));
  }

  const panel = dedupe(byJitteredRank(drawn)).slice(0, count);

  if (panel.length === 0) {
    throw new PanelError('Aucune image utilisable trouvée, réessayez', 502);
  }

  // `rank` is internal: what the editor receives is a panel, not a ranking.
  return panel.map(({ rank: _rank, ...item }) => item);
}

/** How far a candidate can jump, as a share of its category's head. */
const RANK_JITTER = 0.6;

/**
 * Orders a draw by fame, loosely.
 *
 * A straight shuffle treats the raisin and the oxycoccos as equals, which shows the
 * moment a panel is larger than a category's good head. Sorting strictly by rank
 * would instead return the same forty subjects every time. Adding noise of about a
 * window's width to each rank before sorting gives both: the well-known end is
 * heavily favoured, and which of them turn up still changes on every draw.
 */
function byJitteredRank(items: PooledItem[]): PooledItem[] {
  return [...items].sort(
    (left, right) =>
      left.rank + Math.random() * RANK_JITTER - (right.rank + Math.random() * RANK_JITTER)
  );
}

/**
 * One subject per panel, however many categories it belongs to.
 *
 * Pools are deduplicated per category, which is not enough: "Pastel de nata" is
 * both a pastry and a dessert, and two cells sharing an answer is not a cosmetic
 * problem. It is worth double points, because naming it once credits the first
 * field and naming it again credits the second.
 */
function dedupe(items: PooledItem[]): PooledItem[] {
  const seenAnswers = new Set<string>();
  const seenImages = new Set<string>();
  const unique: PooledItem[] = [];

  for (const item of items) {
    const answer = normalizeAnswer(item.label);
    if (seenAnswers.has(answer) || seenImages.has(item.imageUrl)) {
      continue;
    }
    seenAnswers.add(answer);
    seenImages.add(item.imageUrl);
    unique.push(item);
  }

  return unique;
}

/** Test seam, and a way to force a fresh draw. */
export function clearPanelPools(): void {
  pools.clear();
}
