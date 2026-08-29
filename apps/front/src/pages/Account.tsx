import { useState } from 'react';
import { Link } from 'react-router';

import { LOCALES, type Locale } from 'i18n';

import { api, ApiError } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { useTheme, type ThemePreference } from '../hooks/useTheme';
import { useLocale } from '../i18n/locale-context';
import { Button, Field, Input } from '../ui';
import './home.css';

const THEMES: { value: ThemePreference; label: string; hint: string }[] = [
  { value: 'dark', label: '🌙 Sombre', hint: 'La maison, telle qu’elle a toujours été.' },
  { value: 'light', label: '☀️ Clair', hint: 'Pour préparer une soirée en plein jour.' },
  { value: 'system', label: '💻 Système', hint: 'Ce que dit votre machine, et il suit.' }
];

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
  const { locale, setLocale } = useLocale();

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
        setError('Mot de passe actuel incorrect.');
      } else if (cause instanceof ApiError && cause.status === 429) {
        setError('Trop de tentatives. Réessayez dans quelques minutes.');
      } else {
        setError('La modification a échoué.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <h1 className="page-title">Mon compte</h1>
      {user && <p className="auth-alt">Connecté en tant que {user.login}.</p>}

      <h2 className="auth-section">Apparence</h2>
      <div className="settings-choices">
        {THEMES.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`settings-choice ${preference === option.value ? 'on' : ''}`}
            aria-pressed={preference === option.value}
            onClick={() => setPreference(option.value)}
          >
            <strong>{option.label}</strong>
            <span>{option.hint}</span>
          </button>
        ))}
      </div>
      {preference === 'system' && (
        <p className="auth-alt">
          Actuellement : {theme === 'light' ? 'clair' : 'sombre'}. Les écrans de jeu restent sombres dans tous les cas —
          ils sont conçus pour être lus à quatre mètres.
        </p>
      )}

      <h2 className="auth-section">Langue</h2>
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

      <h2 className="auth-section">Changer de mot de passe</h2>

      <form onSubmit={(event) => void submit(event)}>
        <Field label="Mot de passe actuel">
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

        <Field label="Nouveau mot de passe" error={tooShort ? 'Au moins 8 caractères.' : undefined}>
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
          label="Répéter le nouveau mot de passe"
          error={mismatch ? 'Les deux ne correspondent pas.' : (error ?? undefined)}
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
          Changer le mot de passe
        </Button>
      </form>

      {done && (
        <p className="auth-alt" role="status">
          Mot de passe modifié. Les autres appareils connectés à ce compte devront se reconnecter.
        </p>
      )}

      <p className="auth-alt">
        Mot de passe oublié ? Il n’y a pas encore de réinitialisation automatique —{' '}
        <Link to="/">demandez de l’aide</Link>.
      </p>
    </div>
  );
}
