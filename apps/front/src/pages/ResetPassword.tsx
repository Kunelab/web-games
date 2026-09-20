import { msg } from 'i18n';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { api, ApiError } from '../api/client';
import { useAsync } from '../hooks/useAsync';
import { useT } from '../i18n/locale-context';
import { Button, Field, Input, Loading } from '../ui';
import './home.css';

/** Mirrors resetPasswordSchema on the server, and registerSchema before it. */
const MIN_PASSWORD_LENGTH = 8;

/**
 * The other end of the reset link: choose a new password.
 *
 * The token arrives as a query parameter and is checked before the form is
 * drawn, so somebody following a link from a mail they read a day late is told
 * it has expired instead of composing a password and losing it to a 400.
 *
 * Nothing signs the browser in afterwards. A reset is the one password path
 * where the person at the keyboard is not necessarily the account's owner, so it
 * ends at the login form and lets them prove it there.
 */
export default function ResetPassword() {
  const t = useT();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  // Guarded so an address with no token at all does not spend a request to be
  // told what the absence of the parameter already says.
  const check = useAsync(
    () => (token ? api.checkResetToken(token) : Promise.resolve({ valid: false })),
    [token]
  );

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();

    // Both checked here as well as on the server: the server sees one password
    // and cannot say they differ, and its schema violation names no field.
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t(msg('auth.passwordTooShort', { count: MIN_PASSWORD_LENGTH })));
      return;
    }
    if (password !== confirm) {
      setError(t(msg('auth.passwordMismatch')));
      return;
    }

    setBusy(true);
    setError(null);

    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t(msg('auth.resetFailed')));
    } finally {
      setBusy(false);
    }
  }

  if (check.loading) return <Loading />;

  if (!check.data?.valid) {
    return (
      <div className="auth-page">
        <h1 className="page-title">{t(msg('auth.resetInvalidTitle'))}</h1>
        <p className="field-hint">{t(msg('auth.resetInvalid'))}</p>
        <p className="auth-alt">
          <Link to="/mot-de-passe-oublie">{t(msg('auth.forgotAgain'))}</Link>
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="auth-page">
        <h1 className="page-title">{t(msg('auth.resetDoneTitle'))}</h1>
        <p className="field-hint">{t(msg('auth.resetDone'))}</p>
        <Button variant="primary" block onClick={() => void navigate('/connexion', { replace: true })}>
          {t(msg('auth.doSignIn'))}
        </Button>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <h1 className="page-title">{t(msg('auth.resetTitle'))}</h1>
      <p className="field-hint">{t(msg('auth.resetIntro'))}</p>

      <form onSubmit={(event) => void submit(event)}>
        <Field label={t(msg('auth.newPassword'))} hint={t(msg('auth.passwordHint', { count: MIN_PASSWORD_LENGTH }))}>
          {({ id, describedBy }) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          )}
        </Field>

        <Field label={t(msg('auth.confirmPassword'))} error={error ?? undefined}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          )}
        </Field>

        <Button type="submit" variant="primary" busy={busy} block disabled={!password || !confirm}>
          {t(msg('auth.resetSubmit'))}
        </Button>
      </form>
    </div>
  );
}
