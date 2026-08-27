import { DEFAULT_LOCALE, isLocale, negotiate, translator, type Catalogue, type Locale } from 'i18n';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { LOCALE_STORAGE_KEY, LocaleContext, RAW, type LocaleContextValue } from './locale-context';

/**
 * Loads the reader's language and English, and nothing else.
 *
 * Two catalogues, always: the reader's own, and English as the fallback for any
 * key a translator has not reached yet. They arrive as dynamic imports so the
 * bundler splits them — a French phone downloads `fr` and `en` and never sees
 * Japanese, which is the whole reason the catalogues live in separate modules
 * rather than in one object.
 *
 * The server sends `{ k, p }` and nothing else, so *everything* the game says
 * passes through here.
 */

const LOADERS: Record<Locale, () => Promise<{ default: Catalogue }>> = {
  en: () => import('i18n/locales/en'),
  fr: () => import('i18n/locales/fr')
};

interface Loaded {
  locale: Locale;
  primary: Catalogue;
  fallback: Catalogue;
}

/**
 * The reader's choice, then the browser's preference, then English.
 *
 * Stored rather than negotiated every time: somebody who deliberately switched
 * to English on a French machine meant it.
 */
function initialLocale(): Locale {
  const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem(LOCALE_STORAGE_KEY);
  if (stored && isLocale(stored)) return stored;
  return negotiate(typeof navigator === 'undefined' ? undefined : navigator.languages);
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      // English is always fetched: it is the fallback, and for an English reader
      // both promises resolve to the same module anyway.
      const [primary, fallback] = await Promise.all([
        LOADERS[locale]().then((module) => module.default),
        LOADERS[DEFAULT_LOCALE]().then((module) => module.default)
      ]);
      if (live) setLoaded({ locale, primary, fallback });
    })();
    return () => {
      live = false;
    };
  }, [locale]);

  /**
   * Readiness is *derived*, not a second piece of state.
   *
   * Clearing the catalogues on the way into the effect was the first version, and
   * it set state synchronously inside an effect — a cascading render, and a frame
   * of raw keys on every language switch. Comparing the loaded locale to the
   * wanted one answers the same question without the extra write: mid-switch, the
   * previous language keeps rendering until the new one lands.
   */
  const value = useMemo<LocaleContextValue>(() => {
    const current = loaded?.locale === locale ? loaded : null;
    return {
      locale,
      setLocale: (next) => {
        localStorage.setItem(LOCALE_STORAGE_KEY, next);
        setLocaleState(next);
      },
      t: loaded ? translator(loaded.primary, loaded.fallback) : RAW,
      ready: current !== null
    };
  }, [locale, loaded]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}
