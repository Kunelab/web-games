import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { api, ApiError } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { Button, Field, Input } from '../ui';
import './home.css';

/** Mirrors registerSchema on the server. */
const MIN_PASSWORD_LENGTH = 8;

export default function Register() {
  const navigate = useNavigate();
  const { setUser } = useAuth();

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
      setError(`Le mot de passe doit faire au moins ${MIN_PASSWORD_LENGTH} caractères.`);
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
          ? 'Ce pseudo est déjà pris.'
          : cause instanceof ApiError
            ? cause.message
            : "L'inscription a échoué."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <h1 className="page-title">S’inscrire</h1>

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

        <Field label="Email">
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
          label="Mot de passe"
          hint={`${MIN_PASSWORD_LENGTH} caractères minimum`}
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

        <Button type="submit" variant="primary" busy={busy} block disabled={!username || !password || !email}>
          Créer le compte
        </Button>
      </form>

      <p className="auth-alt">
        Déjà un compte ? <Link to="/connexion">Se connecter</Link>
      </p>
    </div>
  );
}
