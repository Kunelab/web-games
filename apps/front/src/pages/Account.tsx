import { useState } from 'react';
import { Link } from 'react-router';

import { LOCALES, msg, type Locale } from 'i18n';

import { api, ApiError } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { useTheme, type ThemePreference } from '../hooks/useTheme';
import { useLocale } from '../i18n/locale-context';
import { Button, Field, Input } from '../ui';
import './home.css';

/** The theme settings, as catalogue keys — the page explains each one. */
const THEMES: { value: ThemePreference; label: string; hint: string }[] = [
  { value: 'dark', label: 'account.theme.dark', hint: 'account.theme.dark.hint' },
  { value: 'light', label: 'account.theme.light', hint: 'account.theme.light.hint' },
  { value: 'system', label: 'account.theme.system', hint: 'account.theme.system.hint' }
];

/** Each language in its own words; see AccountMenu for why these are not keys. */
const LANGUAGE_NAMES: Record<Locale, string> = { fr: 'Français', en: 'English' };

/**
 * Settings, and the account they belong to.
 *
 * The two dials also live in the menu behind your name, because you flip a theme
 * to see it happen. They are repeated here with their explanations, which is
 * what a page is for and what a menu has no room for.
 *
 * Preferences are kept on the device, not on the account. Phones join a game
 * without ever signing in and need a language too, and a theme that waited for
 * `/api/user` would paint the page twice on every load.
 */
export default function Account() {
  const { user } = useAuth();
  const { preference, theme, setPreference } = useTheme();
  const { locale, setLocale, t } = useLocale();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = again.length > 0 && next !== again;
  const tooShort = next.length > 0 && next.length < 8;
  const ready = current.length > 0 && next.length >= 8 && next === again;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);

    try {
      await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      setAgain('');
      setDone(true);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 400) {
        setError(t(msg('account.wrongCurrent')));
      } else if (cause instanceof ApiError && cause.status === 429) {
        setError(t(msg('account.tooManyTries')));
      } else {
        setError(t(msg('account.changeFailed')));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <h1 className="page-title">{t(msg('account.title'))}</h1>
      {user && <p className="auth-alt">{t(msg('account.signedInAs', { login: user.login }))}</p>}

      <h2 className="auth-section">{t(msg('account.appearance'))}</h2>
      <div className="settings-choices">
        {THEMES.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`settings-choice ${preference === option.value ? 'on' : ''}`}
            aria-pressed={preference === option.value}
            onClick={() => setPreference(option.value)}
          >
            <strong>{t(msg(option.label))}</strong>
            <span>{t(msg(option.hint))}</span>
          </button>
        ))}
      </div>
      {preference === 'system' && (
        <p className="auth-alt">
          {t(
            msg('account.systemNow', {
              mode: msg(theme === 'light' ? 'account.systemNow.light' : 'account.systemNow.dark')
            })
          )}
        </p>
      )}

      <h2 className="auth-section">{t(msg('account.language'))}</h2>
      <div className="settings-choices">
        {LOCALES.map((value) => (
          <button
            key={value}
            type="button"
            className={`settings-choice ${locale === value ? 'on' : ''}`}
            aria-pressed={locale === value}
            onClick={() => setLocale(value)}
          >
            <strong>{LANGUAGE_NAMES[value]}</strong>
          </button>
        ))}
      </div>

      <h2 className="auth-section">{t(msg('account.changePassword'))}</h2>

      <form onSubmit={(event) => void submit(event)}>
        <Field label={t(msg('account.currentPassword'))}>
          {({ id }) => (
            <Input
              id={id}
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
            />
          )}
        </Field>

        <Field label={t(msg('account.newPassword'))} error={tooShort ? t(msg('account.tooShort')) : undefined}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              value={next}
              onChange={(event) => setNext(event.target.value)}
            />
          )}
        </Field>

        <Field
          label={t(msg('account.repeatPassword'))}
          error={mismatch ? t(msg('account.mismatch')) : (error ?? undefined)}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              value={again}
              onChange={(event) => setAgain(event.target.value)}
            />
          )}
        </Field>

        <Button type="submit" variant="primary" busy={busy} block disabled={!ready}>
          {t(msg('account.doChange'))}
        </Button>
      </form>

      {done && (
        <p className="auth-alt" role="status">{t(msg('account.changed'))}</p>
      )}

      <p className="auth-alt">
        {t(msg('account.forgot'))} <Link to="/">{t(msg('account.askForHelp'))}</Link>.
      </p>
    </div>
  );
}
