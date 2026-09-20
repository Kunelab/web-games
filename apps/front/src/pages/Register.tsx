import { msg } from 'i18n';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { api, ApiError } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { useT } from '../i18n/locale-context';
import { Button, Field, Input } from '../ui';
import './home.css';

/** The hub, which carries the legal pages. Mirrors the constant in shells.tsx. */
const HUB_URL = 'https://kunelab.duckdns.org';

/** Mirrors registerSchema on the server. */
const MIN_PASSWORD_LENGTH = 8;

export default function Register() {
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const t = useT();

  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();

    // Checked here as well as on the server, because the server's answer to a
    // schema violation is a generic "Invalid request" that names no field.
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t(msg('auth.passwordTooShort', { count: MIN_PASSWORD_LENGTH })));
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const user = await api.register(username, password, email);
      setUser(user);
      void navigate('/playlists', { replace: true });
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 409
          ? t(msg('auth.nameTaken'))
          : cause instanceof ApiError
            ? cause.message
            : t(msg('auth.signUpFailed'))
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <h1 className="page-title">{t(msg('auth.signUp'))}</h1>

      <form onSubmit={(event) => void submit(event)}>
        <Field label={t(msg('auth.username'))}>
          {({ id }) => (
            <Input
              id={id}
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          )}
        </Field>

        <Field label={t(msg('auth.email'))}>
          {({ id }) => (
            <Input
              id={id}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          )}
        </Field>

        <Field
          label={t(msg('auth.password'))}
          hint={t(msg('auth.passwordHint', { count: MIN_PASSWORD_LENGTH }))}
          error={error ?? undefined}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setError(null);
              }}
            />
          )}
        </Field>

        {/*
          The RGPD notice, at the moment the data is actually handed over.
          Article 13 wants people told who is taking what and why as they give it,
          not on a page they might come across later, so this sits above the
          button that submits rather than only in the footer.

          No tick box, deliberately. The legal basis for an account is the
          contract, not consent, and a checkbox asking permission for something
          that does not need it teaches people that the boxes mean nothing.
        */}
        <p className="field-hint">
          {t(msg('auth.privacyNotice'))}{' '}
          <a href={`${HUB_URL}/confidentialite.html`} target="_blank" rel="noreferrer">
            {t(msg('auth.privacyLink'))}
          </a>
        </p>

        <Button type="submit" variant="primary" busy={busy} block disabled={!username || !password || !email}>
          {t(msg('auth.createAccount'))}
        </Button>
      </form>

      <p className="auth-alt">
        {t(msg('auth.haveAccount'))} <Link to="/connexion">{t(msg('auth.doSignIn'))}</Link>
      </p>
    </div>
  );
}
