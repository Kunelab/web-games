import { msg } from 'i18n';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NavLink } from 'react-router';

import { useLocale } from '../i18n/locale-context';
import { useTheme, type ThemePreference } from '../hooks/useTheme';

/**
 * What sits behind your own name in the bar.
 *
 * The two dials people actually flip are here rather than only on the settings
 * page, because you flip a theme to *see* it: two clicks away and a page change
 * between the switch and its effect makes it feel like a form submission. The
 * page is one item down for everything else, so this menu never has to grow.
 *
 * Portalled for the same reason the games menu is: `.topbar` opens a stacking
 * context of its own, and a panel anchored inside it cannot rise above what the
 * games mount over the page.
 */

/** The three theme settings, as catalogue keys. */
const THEMES: { value: ThemePreference; key: string; emoji: string }[] = [
  { value: 'dark', key: 'site.account.theme.dark', emoji: '🌙' },
  { value: 'light', key: 'site.account.theme.light', emoji: '☀️' },
  { value: 'system', key: 'site.account.theme.system', emoji: '💻' }
];

/**
 * Every language, written in itself.
 *
 * Not translated and never should be: somebody looking for their own language
 * in a list is looking for the word they would use, not for the word the
 * language they cannot read uses for it.
 */
const LANGUAGES = [
  { value: 'fr', label: 'Français' },
  { value: 'en', label: 'English' }
] as const;

export default function AccountMenu({
  login,
  container,
  onLogout
}: {
  login: string;
  container: HTMLElement | null;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);

  const { preference, setPreference } = useTheme();
  const { locale, setLocale, t } = useLocale();

  useEffect(() => {
    if (!open) return;

    function place() {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      // Anchored by its right edge: this lives at the end of the bar, so it
      // grows inwards rather than off the screen.
      setAt({ top: rect.bottom + 8, right: Math.max(8, window.innerWidth - rect.right) });
    }

    place();

    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (trigger.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  const menu = (
    <div
      className="accountmenu-panel"
      role="menu"
      ref={panel}
      style={at ? { top: at.top, right: at.right } : { visibility: 'hidden' }}
    >
      <p className="accountmenu-group">{t(msg('site.account.theme'))}</p>
      <div className="accountmenu-choices">
        {THEMES.map((option) => (
          <button
            key={option.value}
            type="button"
            role="menuitemradio"
            aria-checked={preference === option.value}
            className={`accountmenu-choice ${preference === option.value ? 'on' : ''}`}
            onClick={() => setPreference(option.value)}
          >
            <span aria-hidden="true">{option.emoji}</span> {t(msg(option.key))}
          </button>
        ))}
      </div>

      <p className="accountmenu-group">{t(msg('site.account.language'))}</p>
      <div className="accountmenu-choices">
        {LANGUAGES.map((option) => (
          <button
            key={option.value}
            type="button"
            role="menuitemradio"
            aria-checked={locale === option.value}
            className={`accountmenu-choice ${locale === option.value ? 'on' : ''}`}
            onClick={() => setLocale(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <NavLink to="/compte" role="menuitem" className="accountmenu-item" onClick={() => setOpen(false)}>
        {t(msg('site.account.settings'))}
      </NavLink>
      <button type="button" role="menuitem" className="accountmenu-item" onClick={onLogout}>
        {t(msg('site.account.signOut'))}
      </button>
    </div>
  );

  return (
    <div className="accountmenu">
      <button
        type="button"
        ref={trigger}
        className="whoami"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        {login}
      </button>

      {open && (container ? createPortal(menu, container) : menu)}
    </div>
  );
}
