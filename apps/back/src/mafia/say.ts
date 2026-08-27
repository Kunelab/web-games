import { translator, type Locale, type Translate } from 'i18n';
import { en } from 'i18n/locales/en';
import { fr } from 'i18n/locales/fr';

/**
 * The server's own renderer, for the two consumers that are not a reader.
 *
 * Everything the game says goes out as a key, which is right for phones and
 * televisions — each renders in its owner's language. But two things on this side
 * need actual prose:
 *
 *  - the briefing an LLM bot is given, which has to be in the language the table
 *    is spoken in, because the bot answers into a shared channel;
 *  - the transcript the headless simulator prints, which is for a person reading
 *    a terminal.
 *
 * Both load every catalogue eagerly, unlike the client. A server has no bundle to
 * split and hosts tables in several languages at once, so lazy-loading here would
 * buy nothing and cost a promise on a hot path.
 */
const CATALOGUES = { en, fr } as const;

const cache = new Map<Locale, Translate>();

export function say(locale: Locale): Translate {
  let bound = cache.get(locale);
  if (!bound) {
    bound = translator(CATALOGUES[locale] ?? en, en);
    cache.set(locale, bound);
  }
  return bound;
}
