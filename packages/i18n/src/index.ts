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
  return typeof value === 'object' && value !== null && typeof (value).k === 'string';
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
export function render(message: Msg, primary: Catalogue, fallback?: Catalogue): string {
  const pattern = primary[message.k] ?? fallback?.[message.k];
  if (pattern === undefined) return message.k;
  if (!message.p) return pattern;

  // Nested fragments are rendered first, in the same reader's languages.
  const flat: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(message.p)) {
    flat[name] = isMsg(value) ? render(value, primary, fallback) : value;
  }
  return interpolate(pattern, flat);
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
export function interpolate(pattern: string, params?: Record<string, string | number>): string {
  if (!params) return pattern;
  return pattern.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * A ready-to-use renderer bound to one reader's languages.
 *
 * Handed around instead of a catalogue pair so no call site has to remember the
 * fallback order.
 */
export type Translate = (message: Msg) => string;

export function translator(primary: Catalogue, fallback?: Catalogue): Translate {
  return (message) => render(message, primary, fallback);
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
