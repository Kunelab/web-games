import { msg } from 'i18n';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

import { api, ApiError } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { useT } from '../i18n/locale-context';
import { Button, Field, Input } from '../ui';
import './home.css';

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { setUser } = useAuth();
  const t = useT();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Set by the auth guard, so logging in returns you where you were headed
  // instead of dumping you on the home page.
  const from = (location.state as { from?: string } | null)?.from ?? '/playlists';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const user = await api.login(username, password);
      setUser(user);
      void navigate(from, { replace: true });
    } catch (cause) {
      setError(
        t(msg(cause instanceof ApiError && cause.status === 400 ? 'auth.badCredentials' : 'auth.signInFailed'))
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <h1 className="page-title">{t(msg('auth.signIn'))}</h1>

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

        <Field label={t(msg('auth.password'))} error={error ?? undefined}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="password"
              autoComplete="current-password"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          )}
        </Field>

        <Button type="submit" variant="primary" busy={busy} block disabled={!username || !password}>
          {t(msg('auth.doSignIn'))}
        </Button>
      </form>

      <p className="auth-alt">
        {t(msg('auth.noAccount'))} <Link to="/inscription">{t(msg('auth.signUp'))}</Link>
      </p>
      <p className="auth-alt">
        {t(msg('auth.justPlaying'))} <Link to="/rejoindre">{t(msg('auth.joinGame'))}</Link>
      </p>
    </div>
  );
}
