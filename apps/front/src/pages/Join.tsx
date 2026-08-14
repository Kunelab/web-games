import { useState } from 'react';
import { useNavigate } from 'react-router';

import { api, ApiError } from '../api/client';
import { Button, Field, Input } from '../ui';
import './play.css';

/**
 * Manual code entry, for anyone who cannot scan.
 *
 * Checks the code before asking for a nickname, so a typo is caught here rather than
 * failing silently after the player has committed a name.
 */
export default function Join() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const normalised = code.trim().toUpperCase();

    setBusy(true);
    setError(null);
    try {
      await api.sessionSummary(normalised);
      void navigate(`/rejoindre/${normalised}`);
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 404 ? 'Aucune partie avec ce code.' : 'Vérification impossible.'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="jeu-screen jeu-center">
      <form className="join-form" onSubmit={(event) => void submit(event)}>
        <h1 className="join-title">Rejoindre une partie</h1>

        <Field label="Code de la partie" error={error ?? undefined}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              className="code-input"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder="ABC12"
              maxLength={5}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              autoFocus
            />
          )}
        </Field>

        <Button type="submit" variant="primary" size="lg" block busy={busy} disabled={code.trim().length !== 5}>
          Continuer
        </Button>
      </form>
    </div>
  );
}
