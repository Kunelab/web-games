import { createContext, useContext } from 'react';
import { DEFAULT_LOCALE, type Locale, type Msg, type Translate } from 'i18n';

/**
 * The reader's language, and the renderer bound to it.
 *
 * Split from the provider component so this module exports no components — which
 * keeps Vite's fast refresh working on both files, and means a screen that only
 * needs `t` imports one small thing.
 */

/** Until a catalogue is in, render the key: loud beats invisible. */
export const RAW: Translate = (message: Msg) => message.k;

export interface LocaleContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  /** Renders a server message in the reader's language, English as fallback. */
  t: Translate;
  /** False until both catalogues have loaded. */
  ready: boolean;
}

export const LocaleContext = createContext<LocaleContextValue>({
  locale: DEFAULT_LOCALE,
  setLocale: () => undefined,
  t: RAW,
  ready: false
});

export const LOCALE_STORAGE_KEY = 'kune.locale';

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}

/** Shorthand for the common case: just the renderer. */
export function useT(): Translate {
  return useContext(LocaleContext).t;
}
