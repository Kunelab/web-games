import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

/**
 * Light, dark, or whatever the machine says.
 *
 * Two values, deliberately: the *preference* is what the reader chose and what is
 * stored, and the *resolved* theme is the concrete one on the page. They differ
 * exactly when the preference is `system`, and keeping them apart is what lets
 * the toggle show "Système" rather than lying about which one it picked.
 *
 * The element is stamped by an inline script in `index.html` before the first
 * paint; this only keeps it in step afterwards. Reading the choice here instead
 * would draw the page in the wrong palette and correct it a frame later.
 *
 * Stored locally rather than on the account, and that is not a shortcut: phones
 * join a game without ever signing in, so this has to work with no account at
 * all. A preference living only in the database would also mean waiting for
 * `/api/user` before knowing what colour to paint.
 */

export const THEME_STORAGE_KEY = 'kune.theme';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

/** The house look, and what an unreadable storage falls back to. */
const DEFAULT_PREFERENCE: ThemePreference = 'dark';

/**
 * Asked the light way round on purpose: a browser that cannot answer the
 * question at all reports `false`, and false has to mean dark.
 */
const LIGHT_QUERY = '(prefers-color-scheme: light)';

function storedPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : DEFAULT_PREFERENCE;
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

function subscribeToSystem(onChange: () => void): () => void {
  const query = window.matchMedia(LIGHT_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function systemIsLight(): boolean {
  return window.matchMedia(LIGHT_QUERY).matches;
}

export function useTheme(): {
  preference: ThemePreference;
  theme: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
} {
  const [preference, setPreferenceState] = useState<ThemePreference>(storedPreference);

  /**
   * The machine's own setting, as a subscription rather than as state written
   * from an effect. It is somebody else's value that changes on its own, which
   * is precisely what this hook is for — and deriving the theme from it means
   * there is no second copy to keep in step.
   */
  const light = useSyncExternalStore(subscribeToSystem, systemIsLight, () => false);
  const theme: ResolvedTheme = preference === 'system' ? (light ? 'light' : 'dark') : preference;

  // The one genuine side effect: telling the page what it turned out to be.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // A phone with storage disabled simply forgets on the next load.
    }
  }, []);

  return { preference, theme, setPreference };
}
