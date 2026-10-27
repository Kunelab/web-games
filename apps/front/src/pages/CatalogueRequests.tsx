import { msg } from 'i18n';
import { useState, type FormEvent } from 'react';

import { api, type BlindtestGenre } from '../api/client';
import { useAsync } from '../hooks/useAsync';
import { useT } from '../i18n/locale-context';
import { Button, Field, Input, Select } from '../ui';

/** How many of an artist's songs a request asks for unless told otherwise. Matches the server's. */
const DEFAULT_SONGS = 20;
const MAX_SONGS = 50;

/**
 * Asking the next fill for more of an artist, or for a film, series, game or anime.
 *
 * Admin only, on the shared catalogue, beside its other curation tools. A
 * request is seeds the next fill searches before anything else in their genre:
 * a room's, or the night's prefill. Each row says how far that has got, which
 * is the only way to know a request did anything.
 */
export function CatalogueRequests({ genres }: { genres: readonly BlindtestGenre[] }) {
  const t = useT();
  const state = useAsync(() => api.blindtestRequests(), []);
  const [genreId, setGenreId] = useState('');
  const [name, setName] = useState('');
  const [count, setCount] = useState(String(DEFAULT_SONGS));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<number | null>(null);

  const requestable = new Set(state.data?.genres ?? []);
  const options = genres
    .filter((genre) => requestable.has(genre.id))
    .map((genre) => ({ value: genre.id, label: genre.label }));
  const genreById = new Map(genres.map((genre) => [genre.id, genre]));
  const chosen = genreById.get(genreId);
  const byArtist = chosen?.answerShape === 'artist-title';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!chosen || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const songs = Math.min(MAX_SONGS, Math.max(1, Number(count) || DEFAULT_SONGS));
      await api.blindtestRequest(chosen.id, name.trim(), byArtist ? songs : undefined);
      setName('');
      state.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t(msg('ple.request.failed')));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: number) {
    setCancelling(id);
    try {
      await api.blindtestCancelRequest(id);
      state.reload();
    } finally {
      setCancelling(null);
    }
  }

  const requests = state.data?.requests ?? [];

  return (
    <details className="pl-requests">
      <summary className="pl-requests-summary">
        {t(msg('ple.request.title'))}
        {requests.some((entry) => entry.waiting > 0) && (
          <span className="pl-requests-pending">
            {' '}
            · {t(msg('ple.request.pending', { count: requests.filter((entry) => entry.waiting > 0).length }))}
          </span>
        )}
      </summary>

      <p className="pl-requests-explain">{t(msg('ple.request.explain'))}</p>

      <form className="pl-requests-form" onSubmit={(event) => void submit(event)}>
        <Field label={t(msg('ple.request.genre'))}>
          {({ id }) => (
            <Select
              id={id}
              value={genreId}
              onValueChange={setGenreId}
              options={options}
              placeholder={t(msg('ple.request.genrePlaceholder'))}
            />
          )}
        </Field>
        <Field label={t(msg(byArtist || !chosen ? 'ple.request.artist' : 'ple.request.work'))}>
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        {byArtist && (
          <Field label={t(msg('ple.request.count'))}>
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                type="number"
                min={1}
                max={MAX_SONGS}
                value={count}
                onChange={(event) => setCount(event.target.value)}
              />
            )}
          </Field>
        )}
        <Button type="submit" variant="primary" size="sm" busy={busy} disabled={!chosen || !name.trim()}>
          {t(msg('ple.request.submit'))}
        </Button>
      </form>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {state.error && <p className="field-error">{state.error}</p>}

      {requests.length > 0 && (
        <ul className="pl-requests-list">
          {requests.map((entry) => {
            const found = entry.foundAs && entry.foundAs !== entry.name ? entry.foundAs : entry.name;
            return (
              <li key={entry.id} className="pl-requests-row">
                <span className="pl-requests-name">
                  {found}
                  <span className="pl-requests-genre"> · {genreById.get(entry.genreId)?.label ?? entry.genreId}</span>
                </span>
                <span className="pl-requests-status">
                  {t(
                    msg('ple.request.status', {
                      filed: entry.filed,
                      seeds: entry.seeds,
                      waiting: entry.waiting,
                      missed: entry.missed
                    })
                  )}
                </span>
                <Button variant="ghost" size="sm" busy={cancelling === entry.id} onClick={() => void cancel(entry.id)}>
                  {t(msg('ple.request.cancel'))}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}
