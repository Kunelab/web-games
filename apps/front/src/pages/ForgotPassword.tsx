import { msg } from 'i18n';
import { useState } from 'react';
import { Link } from 'react-router';

import { api, ApiError } from '../api/client';
import { useT } from '../i18n/locale-context';
import { Button, Field, Input } from '../ui';
import './home.css';

/**
 * "I have forgotten my password": asks for the address and stops there.
 *
 * The screen never says whether the address was known, because the API never
 * says either — an endpoint that answers "no such account" is a way to test a
 * list of addresses against this deployment. So the confirmation below is shown
 * on success and means only that the request was accepted.
 *
 * `link` in the response is the development affordance: there is no mailer yet,
 * so a deployment running with `PASSWORD_RESET_ECHO` hands the link back and it
 * is rendered here rather than left in the server log. It is absent everywhere
 * else, which is why this renders on its presence and not on a build flag.
 */
export default function ForgotPassword() {
  const t = useT();

  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ link?: string } | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const answer = await api.forgotPassword(email);
      setSent({ link: answer.link });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t(msg('auth.forgotFailed')));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="auth-page">
        <h1 className="page-title">{t(msg('auth.forgotSentTitle'))}</h1>
        <p className="field-hint">{t(msg('auth.forgotSent'))}</p>

        {sent.link && (
          <div className="reset-echo">
            <p className="field-hint">{t(msg('auth.forgotEcho'))}</p>
            {/* A plain anchor, not a Link: it carries the token as a query
                parameter and should behave exactly as the one in the mail will. */}
            <a className="reset-echo-link" href={sent.link}>
              {sent.link}
            </a>
          </div>
        )}

        <p className="auth-alt">
          <Link to="/connexion">{t(msg('auth.backToSignIn'))}</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <h1 className="page-title">{t(msg('auth.forgotTitle'))}</h1>
      <p className="field-hint">{t(msg('auth.forgotIntro'))}</p>

      <form onSubmit={(event) => void submit(event)}>
        <Field label={t(msg('auth.email'))} error={error ?? undefined}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="email"
              autoComplete="email"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          )}
        </Field>

        <Button type="submit" variant="primary" busy={busy} block disabled={!email}>
          {t(msg('auth.forgotSubmit'))}
        </Button>
      </form>

      <p className="auth-alt">
        <Link to="/connexion">{t(msg('auth.backToSignIn'))}</Link>
      </p>
    </div>
  );
}
