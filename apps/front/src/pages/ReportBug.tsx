import { msg } from 'i18n';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import { api, ApiError } from '../api/client';
import { useT } from '../i18n/locale-context';
import { Button, Field, Select, Textarea } from '../ui';
import './home.css';

/** Mirrors BUG_AREAS in the API's bug-report-service. */
const AREAS = ['quiz', 'blindtest', 'coronaz', 'mafia', 'library', 'account', 'other'] as const;

/** Mirrors bugReportSchema's floor, so the form says so before the server does. */
const MIN_MESSAGE = 10;

/**
 * "Something is broken": a form, and nothing clever.
 *
 * Open to anyone, signed in or not, because the moment somebody meets a bug is
 * usually halfway through a game and the players in a game joined with a
 * nickname. Requiring an account here would lose precisely the reports that
 * cannot be reproduced afterwards.
 *
 * Nothing is mailed, because there is no mail out of this deployment. The report
 * lands in a table the operator reads. That is said on the confirmation rather
 * than implied, so nobody sits waiting for a reply that was never going to come.
 *
 * `?code=` is filled in by the link on the game screens, so a report sent from a
 * table carries the join code without anybody having to copy it.
 */
export default function ReportBug() {
  const t = useT();
  const [params] = useSearchParams();

  const [area, setArea] = useState<string>(params.get('area') ?? 'other');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const gameCode = params.get('code') ?? undefined;

  async function submit(event: React.FormEvent) {
    event.preventDefault();

    if (message.trim().length < MIN_MESSAGE) {
      setError(t(msg('bug.tooShort', { count: MIN_MESSAGE })));
      return;
    }

    setBusy(true);
    setError(null);

    try {
      await api.reportBug({
        area,
        message: message.trim(),
        /**
         * Where they came from, not where they are. `document.referrer` would be
         * the honest answer and is empty as often as not; the link that reaches
         * this page carries the page it came from instead, and when it does not,
         * this one is at least true.
         */
        page: params.get('from') ?? undefined,
        gameCode
      });
      setSent(true);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t(msg('bug.failed')));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="auth-page">
        <h1 className="page-title">{t(msg('bug.thanksTitle'))}</h1>
        <p className="field-hint">{t(msg('bug.thanks'))}</p>
        <p className="auth-alt">
          <Link to="/">{t(msg('bug.backHome'))}</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <h1 className="page-title">{t(msg('bug.title'))}</h1>
      <p className="field-hint">{t(msg('bug.intro'))}</p>

      <form onSubmit={(event) => void submit(event)}>
        <Field label={t(msg('bug.area'))}>
          {({ id }) => (
            <Select
              id={id}
              value={area}
              onValueChange={setArea}
              options={AREAS.map((value) => ({ value, label: t(msg(`bug.area.${value}`)) }))}
            />
          )}
        </Field>

        <Field label={t(msg('bug.what'))} hint={t(msg('bug.whatHint'))} error={error ?? undefined}>
          {({ id, describedBy, invalid }) => (
            <Textarea
              id={id}
              rows={8}
              maxLength={4000}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
          )}
        </Field>

        {gameCode && <p className="field-hint">{t(msg('bug.withCode', { code: gameCode }))}</p>}

        {/* Said before the send, not after: what leaves the browser is the one
            thing somebody filling in a bug report cannot see for themselves. */}
        <p className="field-hint">{t(msg('bug.whatIsSent'))}</p>

        <Button type="submit" variant="primary" busy={busy} block disabled={!message.trim()}>
          {t(msg('bug.send'))}
        </Button>
      </form>

      <p className="auth-alt">
        {t(msg('bug.preferGithub'))}{' '}
        <a href="https://github.com/Kunelab/web-games/issues" target="_blank" rel="noreferrer">
          {t(msg('bug.github'))}
        </a>
      </p>
    </div>
  );
}
