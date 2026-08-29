import { useState } from 'react';
import { Link } from 'react-router';

import { api, ApiError } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { Button, Field, Input } from '../ui';
import './home.css';

/**
 * The account screen, which for now is one form.
 *
 * Changing a password is the only thing here because it is the only thing that
 * works without mail leaving the box: a reset needs an address it can trust, and
 * this deployment has no SMTP path yet. Knowing the old password is the proof
 * until it does.
 */
export default function Account() {
  const { user } = useAuth();

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
