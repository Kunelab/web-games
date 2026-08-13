import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

import { api, ApiError } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { Button, Field, Input } from '../ui';
import './home.css';

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { setUser } = useAuth();

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
        cause instanceof ApiError && cause.status === 400
          ? 'Pseudo ou mot de passe incorrect.'
          : 'La connexion a échoué.'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <h1 className="page-title">Connexion</h1>

      <form onSubmit={(event) => void submit(event)}>
        <Field label="Pseudo">
          {({ id }) => (
            <Input
              id={id}
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          )}
        </Field>

        <Field label="Mot de passe" error={error ?? undefined}>
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
          Se connecter
        </Button>
      </form>

      <p className="auth-alt">
        Pas de compte ? <Link to="/inscription">S’inscrire</Link>
      </p>
      <p className="auth-alt">
        Vous venez jouer ? <Link to="/rejoindre">Rejoindre une partie</Link>
      </p>
    </div>
  );
}
