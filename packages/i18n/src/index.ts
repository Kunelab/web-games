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

import type { en } from './locales/en.js';

/**
 * Every key the English catalogue has, as a union of string literals.
 *
 * This is what makes a misspelt key a compile error instead of a raw
 * `mafia.deth.found` on somebody's television. A missing key used to be found by
 * looking at the screen, and only on the path that rendered it; about twelve
 * hundred call sites each named one by hand, with nothing between the typo and
 * the player.
 *
 * Derived from `en` rather than written out because `en` is the definition: a
 * key exists when the reference catalogue has it, and not because a second list
 * says so. A type-only import, so no catalogue is pulled into the runtime of
 * anything that only builds messages.
 */
export type MsgKey = keyof typeof en;

/** A translatable message: a key, and the values its sentence needs. */
export interface Msg {
  /**
   * Dotted key, e.g. `mafia.death.found`. Present in `en` or it is a bug.
   *
   * Deliberately `string` and not `MsgKey`. A `Msg` is also *data*: it arrives
   * over the wire, out of a SQLite snapshot, inside a bot's memory, and none of
   * that can be proven at compile time — narrowing the field would only move the
   * question into a cast at every place a message is received. The check lives
   * where a message is made instead, in `msg()`.
   */
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

/**
 * A list renders as its members, joined.
 *
 * Added for the examiner's shortlist, which is a genuinely variable-length run
 * of independently translated role names. The alternative was a catalogue key
 * per length, or the engine joining pre-rendered words — and the engine picking
 * a language is the one thing this whole design exists to prevent.
 *
 * Joined with a plain comma rather than with a conjunction. "a, b or c" needs to
 * know which member is last and what the reader's language puts in front of it,
 * which is a list formatter; the sentences that take a list here introduce it
 * instead ("could be: ..."), where a comma is what a reader expects.
 */
export type MsgValue = string | number | Msg | readonly MsgValue[];

/**
 * Builds a message at a call site, and checks its key against `en`.
 *
 * A key assembled from a template literal is checked too, when what fills the
 * hole is a union: `mafia.faction.${faction}` compiles exactly when every
 * `Faction` has its line. So a dynamic key is typed by the real source union it
 * is built from — a new role without a catalogue entry fails here, not on a
 * screen — and only a key that genuinely cannot be known goes through `msgOf`.
 */
export function msg<K extends MsgKey>(k: K, p?: Record<string, MsgValue>): Msg {
  return assemble(k, p);
}

/**
 * The one shape every builder hands out: a message built without values
 * carries no `p` at all, rather than `p: undefined`.
 */
function assemble(k: string, p: Record<string, MsgValue> | undefined): Msg {
  return p ? { k, p } : { k };
}

/**
 * One of a numbered set of phrasings: `prefix.1` through `prefix.count`.
 *
 * The bots keep several wordings of almost everything they say (nine ways to
 * cast a vote, three to read out a night) and pick one per speaker and subject,
 * so the key is a prefix plus a number nobody knows until the table is running.
 * That looked like the textbook unknowable key, and it is not: the *set* of keys
 * is fixed by the prefix and the count. So the count is taken as a literal, the
 * compiler enumerates `prefix.1 … prefix.count`, and the call does not build
 * unless every one of them is in `en` — a phrasebook that claims nine variants
 * and has eight fails here rather than in a bot's mouth, one game in nine.
 *
 * `pick` chooses among them (`1 + pick % count`) and must be a non-negative
 * integer; the callers hand it a hash of whatever should keep the choice stable.
 */
export function variant<P extends string, N extends number>(
  prefix: VariantPrefix<P, N>,
  count: N,
  pick: number,
  p?: Record<string, MsgValue>
): Msg {
  // Built directly rather than through `msg`, which cannot see that the number
  // stays inside the range the signature above has already checked.
  return assemble(`${prefix}.${1 + (pick % count)}`, p);
}

/** `prefix`, when every one of its `count` numbered variants is a key; `never` otherwise. */
export type VariantPrefix<P extends string, N extends number> = `${P}.${OneTo<N>}` extends MsgKey ? P : never;

/**
 * `1 | 2 | … | N`, for a literal `N`.
 *
 * A plain `number` comes out as `number`, which `VariantPrefix` then refuses:
 * the count has to be something the compiler can count to.
 */
type OneTo<N extends number, Seen extends unknown[] = [unknown]> = number extends N
  ? number
  : Seen['length'] extends N
    ? N
    : Seen['length'] | OneTo<N, [...Seen, unknown]>;

/**
 * The escape hatch: a message whose key the compiler cannot check.
 *
 * For the few places a key is not a literal and not built from a union either —
 * a key that came from somewhere else as data and is being rewrapped, or a
 * sentence no catalogue has, which renders as itself because a missing key falls
 * through to the key (see `render`). Explicit by name so every such site can be
 * found by searching for it, and so that a cast is never the way round `msg`.
 *
 * Keep it rare. Each use is a place where a typo is back to being found on a
 * screen.
 */
export function msgOf(k: string, p?: Record<string, MsgValue>): Msg {
  return assemble(k, p);
}

function isMsg(value: MsgValue): value is Msg {
  return typeof value === 'object' && value !== null && !isList(value) && typeof value.k === 'string';
}

/**
 * What `render` reads: any key to any pattern.
 *
 * A catalogue is *declared* `satisfies Catalogue`, never `: Catalogue`, so its
 * literal keys survive into its type — that is where `MsgKey` comes from.
 */
export type Catalogue = Record<string, string>;

/**
 * A translation of one English catalogue: its keys exactly, no more and no
 * fewer.
 *
 * Declaring `fr` (and each French sub-catalogue) with this type is what keeps
 * the languages in step. A key English has and French does not is a missing
 * property; a key French has and English does not is an excess one, and that is
 * the worse of the two, because it means a key was renamed and the English
 * fallback now shows raw dotted text to every reader who is not French.
 */
export type TranslationOf<Reference extends Catalogue> = Record<keyof Reference, string>;

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
    flat[name] = renderValue(value, primary, fallback, elide);
  }
  return interpolate(pattern, flat, elide);
}

/**
 * A list, for the narrowing.
 *
 * `Array.isArray` is declared as `arg is any[]`, which does not take a
 * `readonly T[]` out of a union, so the else branch below would still think it
 * might be holding one.
 */
function isList(value: MsgValue): value is readonly MsgValue[] {
  return Array.isArray(value);
}

/** One interpolation value: a fragment, a list of them, or something already flat. */
function renderValue(value: MsgValue, primary: Catalogue, fallback?: Catalogue, elide = false): string | number {
  if (isList(value)) {
    return value.map((item) => renderValue(item, primary, fallback, elide)).join(', ');
  }
  return isMsg(value) ? render(value, primary, fallback, elide) : value;
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
