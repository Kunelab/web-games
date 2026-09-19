/**
 * Localisation, decided one way round: **the server sends keys, the client owns
 * the words.**
 *
 * The alternative — rendering prose on the server for each recipient's language —
 * looked cheaper and is not. A Mafia table's narrative lives *inside* the
 * persisted game state: the dawn report, the verdict, every death notice is a
 * chat message that is written once, snapshotted to SQLite, replayed on
 * reconnect, shown on a television and read by the bots. Rendering it per
 * language would mean either storing every locale in that state or re-rendering
 * a historical log against a reader who was not there when it happened.
 *
 * So a system message on the wire is `{ k, p }` — a key and its parameters — and
 * nothing else. One canonical record, whoever reads it, in whatever language.
 * A mixed table works: the TV in the room's language, each phone in its owner's.
 *
 * A client loads exactly two catalogues: its own language and English. English is
 * the fallback for a key a translator has not reached yet, and the reason every
 * key must exist in `en` before it may be used anywhere else.
 *
 * The server keeps a catalogue too, for the two things that are not a reader:
 * the prompts it writes for LLM bots, and the transcript the headless simulator
 * prints. Both want prose in one language and neither is a person's screen.
 */

/** A translatable message: a key, and the values its sentence needs. */
export interface Msg {
  /** Dotted key, e.g. `mafia.death.found`. Present in `en` or it is a bug. */
  k: string;
  /**
   * Interpolation values, referenced as `{name}` in the catalogue.
   *
   * A value may itself be a `Msg`, and the renderer recurses. That is what lets
   * "{name} was found dead — {cause}. {body}" compose three independently
   * translated fragments without the engine ever picking a language: the death
   * line, the cause of it, and how much the reveal policy allows the corpse to
   * say. The alternative was one flat key per combination of those three, which
   * is dozens of near-identical sentences and the exact shape of catalogue that
   * drifts apart between languages.
   */
  p?: Record<string, MsgValue>;
}

export type MsgValue = string | number | Msg;

/** Sugar for building one at a call site without the object noise. */
export function msg(k: string, p?: Record<string, MsgValue>): Msg {
  return p ? { k, p } : { k };
}

function isMsg(value: MsgValue): value is Msg {
  return typeof value === 'object' && value !== null && typeof value.k === 'string';
}

export type Catalogue = Record<string, string>;

/**
 * The languages the product ships. English first because it is the fallback;
 * everything else is a translation of it.
 */
export const LOCALES = ['en', 'fr'] as const;
export type Locale = (typeof LOCALES)[number];

/** Languages the design intends to reach, so a picker can show what is coming. */
export const PLANNED_LOCALES = ['es', 'de', 'zh', 'ko', 'ja', 'ru'] as const;

export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/**
 * Picks the best supported language from a browser's `Accept-Language` or from
 * `navigator.languages`.
 *
 * Region is dropped: `fr-CA` and `fr-BE` both get `fr`, because the difference
 * between them is not worth a second catalogue and a Québécois reading French
 * France is better served than one reading English.
 */
export function negotiate(preferences: readonly string[] | string | undefined): Locale {
  const list =
    typeof preferences === 'string'
      ? preferences.split(',').map((part) => part.split(';')[0]?.trim() ?? '')
      : (preferences ?? []);

  for (const preference of list) {
    const base = preference.toLowerCase().split('-')[0];
    if (base && isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}

/**
 * Renders one message.
 *
 * Falls through `primary` → `fallback` → the key itself. Returning the key is
 * deliberate: a missing string should look obviously broken in a screenshot
 * rather than quietly render as an empty span that nobody notices for a month.
 */
export function render(
  message: Msg,
  primary: Catalogue,
  fallback?: Catalogue,
  elide = false
): string {
  const pattern = primary[message.k] ?? fallback?.[message.k];
  if (pattern === undefined) return message.k;
  if (!message.p) return pattern;

  // Nested fragments are rendered first, in the same reader's languages.
  const flat: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(message.p)) {
    flat[name] = isMsg(value) ? render(value, primary, fallback, elide) : value;
  }
  return interpolate(pattern, flat, elide);
}

/**
 * `{name}` substitution, and nothing more.
 *
 * No pluralisation engine, on purpose: this game's strings are announcements
 * about named people, and the two places a count appears read fine with a bare
 * number in both shipped languages. When that stops being true — and Russian
 * will make it stop being true — the honest move is an ICU library, not a
 * home-grown plural rule quietly guessing.
 */
export function interpolate(
  pattern: string,
  params?: Record<string, string | number>,
  elide = false
): string {
  if (!params) return pattern;

  let out = '';
  let cursor = 0;
  const holes = /\{(\w+)\}/g;
  for (let hole = holes.exec(pattern); hole !== null; hole = holes.exec(pattern)) {
    out += pattern.slice(cursor, hole.index);
    cursor = hole.index + hole[0].length;

    const value = params[hole[1]];
    if (value === undefined) {
      out += hole[0];
      continue;
    }

    const text = String(value);
    // The seam, and the only place the article and its word are ever adjacent:
    // the article is the tail of `out`, the word it belongs to is `text`.
    if (elide) {
      const article = ELIDABLE_ARTICLE.exec(out);
      if (article) {
        const word = article[2];
        if (elides(text)) out = `${out.slice(0, out.length - word.length - 1)}${word[0]}’`;
      }
    }
    out += text;
  }
  return out + pattern.slice(cursor);
}

/**
 * A ready-to-use renderer bound to one reader's languages.
 *
 * Handed around instead of a catalogue pair so no call site has to remember the
 * fallback order.
 */
export type Translate = (message: Msg) => string;

/**
 * French elision, applied at the seam between a catalogue's article and the
 * value substituted after it, which is the only place the two ever meet.
 *
 * A catalogue entry can only write "le {role}", and the role arriving in it is
 * one of sixty-three names, eighteen of which begin with a vowel or a mute h:
 * Hôtesse, Escorte, Amoureux, Espion, Incendiaire, Actrice. So the French table
 * has been saying "Je suis le Hôtesse" and "le Actrice" for as long as those
 * roles have been in it, which no French speaker has ever typed and which
 * labels the line as machine-made to anybody reading.
 *
 * It cannot be fixed in the catalogue: the entry does not know which of the
 * sixty-three it is about. It cannot be fixed at the call site either, because
 * the call site does not know which language it is rendering into. Here it can,
 * and it is one rule rather than eighteen special cases.
 *
 * Scoped to that seam rather than run over the finished sentence, because the
 * finished sentence is mostly prose a translator wrote and got right. Run over
 * it, the rule rewrote "la horde" as "l’horde" twenty-four times in the Coronaz
 * catalogue, and — JavaScript's `\b` being ASCII-only, so that it fires between
 * `ô` and `le` — turned "le rôle exact" into "le rôl’exact". Neither is a
 * substitution, and neither is any of the business of a rule about articles.
 *
 * Deliberately only `le`/`la`/`de`. `du`, `au` and the rest contract instead of
 * eliding, which is a different rule with different exceptions, and no entry in
 * either catalogue puts one in front of a `{role}`.
 */
const ELIDABLE_ARTICLE = /(^|[^\p{L}\p{N}’'-])([Ll]e|[Ll]a|[Dd]e) $/u;

const STARTS_ELIDABLE = /^[aeiouâàäéèêëîïôöûùüAEIOUÂÀÄÉÈÊËÎÏÔÖÛÙÜhH]/;

/**
 * The h aspiré list: a word spelt with h that takes no elision. None of the
 * sixty-three role names is one — Hôtesse is a mute h and elides — so this
 * catches nothing today. It is here because the next role name, or the first
 * common noun somebody interpolates, is one exception away from "l’héros", and
 * an exception list is where that belongs rather than in a string.
 */
const H_ASPIRE = new Set([
  'hache', 'haie', 'haine', 'hall', 'halte', 'hameau', 'hanche', 'hangar', 'hantise',
  'harde', 'hareng', 'haricot', 'hasard', 'hate', 'haut', 'haute', 'hauteur', 'havre',
  'hameçon', 'hamster', 'harpe', 'hernie', 'heron', 'heros', 'hetre', 'hibou', 'hierarchie',
  'homard', 'honte', 'hoquet', 'horde', 'hors', 'houle', 'housse', 'hublot', 'huche',
  'huit', 'hurlement', 'hutte'
]);

function elides(word: string): boolean {
  if (!STARTS_ELIDABLE.test(word)) return false;
  if (word[0] !== 'h' && word[0] !== 'H') return true;
  const bare = word
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z]/)[0];
  return !H_ASPIRE.has(bare);
}

/**
 * @param locale The reader's language. Only `fr` changes anything: see `elides`.
 */
export function translator(primary: Catalogue, fallback?: Catalogue, locale?: string): Translate {
  const french = locale === 'fr';
  return (message) => render(message, primary, fallback, french);
}

/**
 * Every key in `en` that is missing from another catalogue, and every key the
 * other catalogue has that `en` does not.
 *
 * Used by the test that keeps translations honest. A key present only in `fr` is
 * as much of a bug as one missing from it: it means a string was translated and
 * then renamed, and the English fallback now shows a raw key.
 */
export function catalogueDiff(
  reference: Catalogue,
  other: Catalogue
): { missing: string[]; extra: string[] } {
  const referenceKeys = Object.keys(reference);
  const otherKeys = new Set(Object.keys(other));
  return {
    missing: referenceKeys.filter((key) => !otherKeys.has(key)),
    extra: [...otherKeys].filter((key) => !(key in reference))
  };
}
