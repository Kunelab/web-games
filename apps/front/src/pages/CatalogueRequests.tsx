import { msg } from 'i18n';
import { useEffect, useState, type FormEvent } from 'react';

import {
  api,
  type BlindtestArtistCandidate,
  type BlindtestGaps,
  type BlindtestGenre,
  type BlindtestPrefillStatus
} from '../api/client';
import { useAsync } from '../hooks/useAsync';
import { useT } from '../i18n/locale-context';
import { Button, Field, Input, Select } from '../ui';

/** How many of an artist's songs a request asks for unless told otherwise. Matches the server's. */
const DEFAULT_SONGS = 20;
const MAX_SONGS = 50;
/** How often the fill's progress is read while one runs. */
const FILL_POLL_MS = 15_000;

/**
 * Asking the next fill for more of an artist, or for a film, series, game or anime.
 *
 * Admin only, on the shared catalogue, beside its other curation tools. A
 * request is seeds the next fill searches before anything else in their genre:
 * a room's, or the night's prefill. Each row says how far that has got, which
 * is the only way to know a request did anything.
 *
 * An artist is picked from Deezer's answers before anything is stored: a name
 * is not an artist, and "Korn" is a Thai singer before it is KoЯn.
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
  /** Deezer's answers to the name, while the admin picks one. */
  const [candidates, setCandidates] = useState<BlindtestArtistCandidate[] | null>(null);
  const [running, setRunning] = useState(false);

  const requestable = new Set(state.data?.genres ?? []);
  const options = genres
    .filter((genre) => requestable.has(genre.id))
    .map((genre) => ({ value: genre.id, label: genre.label }));
  const genreById = new Map(genres.map((genre) => [genre.id, genre]));
  const chosen = genreById.get(genreId);
  const byArtist = chosen?.answerShape === 'artist-title';

  async function ask(artistId?: number) {
    if (!chosen || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const songs = Math.min(MAX_SONGS, Math.max(1, Number(count) || DEFAULT_SONGS));
      await api.blindtestRequest(chosen.id, name.trim(), byArtist ? songs : undefined, artistId);
      setName('');
      setCandidates(null);
      state.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t(msg('ple.request.failed')));
    } finally {
      setBusy(false);
    }
  }

  /** A work is asked for as typed; an artist is looked up first, to be picked. */
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!chosen || !name.trim()) return;
    if (!byArtist) return ask();
    setBusy(true);
    setError(null);
    try {
      const { artists } = await api.blindtestArtistCandidates(name.trim());
      if (artists.length === 0) setError(t(msg('ple.request.noArtist')));
      else setCandidates(artists);
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
  const needSearch = requests.reduce((sum, entry) => sum + entry.needSearch, 0);

  /** A fill now, with just enough searches for what only a search can file. */
  async function runNow() {
    setRunning(true);
    setError(null);
    try {
      await api.blindtestRunPrefill(needSearch);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t(msg('ple.request.failed')));
    } finally {
      setRunning(false);
    }
  }

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

      <FillProgress genres={genreById} onFinished={state.reload} />

      <form className="pl-requests-form" onSubmit={(event) => void submit(event)}>
        <Field label={t(msg('ple.request.genre'))}>
          {({ id }) => (
            <Select
              id={id}
              value={genreId}
              onValueChange={(next) => {
                setGenreId(next);
                setCandidates(null);
              }}
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
              onChange={(event) => {
                setName(event.target.value);
                setCandidates(null);
              }}
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

      {candidates && (
        <div className="pl-requests-pick">
          <p className="pl-requests-explain">{t(msg('ple.request.pick'))}</p>
          <ul className="pl-requests-candidates">
            {candidates.map((artist) => (
              <li key={artist.id}>
                <button
                  type="button"
                  className="pl-requests-candidate"
                  disabled={busy}
                  onClick={() => void ask(artist.id)}
                >
                  {artist.picture ? (
                    <img src={artist.picture} alt="" width={32} height={32} />
                  ) : (
                    <span aria-hidden="true" />
                  )}
                  <span className="pl-requests-name">{artist.name}</span>
                  <span className="pl-requests-genre">
                    {t(msg('ple.request.fans', { count: artist.fans.toLocaleString() }))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <Button variant="ghost" size="sm" onClick={() => setCandidates(null)}>
            {t(msg('ple.request.back'))}
          </Button>
        </div>
      )}

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {state.error && <p className="field-error">{state.error}</p>}

      {needSearch > 0 && (
        <Button variant="secondary" size="sm" busy={running} onClick={() => void runNow()}>
          {t(msg('ple.request.runNow', { count: needSearch }))}
        </Button>
      )}

      <CatalogueGaps genres={genreById} onAsked={state.reload} />

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
                  {entry.needSearch > 0 && ` · ${t(msg('ple.request.needSearch', { count: entry.needSearch }))}`}
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

/**
 * Where the catalogue fill stands: the genre it is on, what it has added,
 * what it has left, and roughly when it ends. The last one's result when none
 * runs. Read again every few seconds while one runs, and once when it ends.
 */
function FillProgress({ genres, onFinished }: { genres: ReadonlyMap<string, BlindtestGenre>; onFinished: () => void }) {
  const t = useT();
  const [status, setStatus] = useState<BlindtestPrefillStatus | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wasRunning = false;
    async function read() {
      const next = await api.blindtestPrefill().catch(() => null);
      if (stopped) return;
      setStatus(next);
      if (wasRunning && next && !next.running) onFinished();
      wasRunning = next?.running ?? false;
      timer = setTimeout(() => void read(), FILL_POLL_MS);
    }
    void read();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // `onFinished` is a reload, the same function every render that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const report = status?.report;
  if (!report) return null;
  const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (!status.running) {
    if (!report.finishedAt) return null;
    return (
      <p className="pl-fill">{t(msg('ple.fill.last', { saved: report.saved, time: clock(report.finishedAt) }))}</p>
    );
  }
  if (report.phase === 'loading') return <p className="pl-fill pl-fill-live">{t(msg('ple.fill.loading'))}</p>;

  const progress = status.progress;
  const parts = [
    t(
      msg('ple.fill.running', {
        genre: (report.genre && genres.get(report.genre)?.label) ?? report.genre ?? '…',
        saved: report.saved
      })
    )
  ];
  if (progress) {
    parts.push(
      progress.searchesLeft === null
        ? t(msg('ple.fill.leftFree', { videos: progress.knownVideosLeft }))
        : t(msg('ple.fill.left', { videos: progress.knownVideosLeft, searches: progress.searchesLeft }))
    );
    if (progress.expectedEnd) parts.push(t(msg('ple.fill.end', { time: clock(progress.expectedEnd) })));
  }
  return (
    <p className="pl-fill pl-fill-live" role="status">
      {parts.join(' · ')}
    </p>
  );
}

/**
 * Famous artists the catalogue has few songs of, and famous works it has none
 * of, each one press from a request. Read when opened: it goes through every
 * row of the catalogue and every seed.
 */
function CatalogueGaps({ genres, onAsked }: { genres: ReadonlyMap<string, BlindtestGenre>; onAsked: () => void }) {
  const t = useT();
  const [gaps, setGaps] = useState<BlindtestGaps | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Names asked for from here, by `genre::name`, and the one being asked. */
  const [asked, setAsked] = useState<ReadonlySet<string>>(() => new Set());
  const [asking, setAsking] = useState<string | null>(null);

  async function load() {
    if (gaps || loading) return;
    setLoading(true);
    try {
      setGaps(await api.blindtestGaps());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t(msg('ple.request.failed')));
    } finally {
      setLoading(false);
    }
  }

  async function ask(genreId: string, name: string) {
    const key = `${genreId}::${name}`;
    setAsking(key);
    setError(null);
    try {
      await api.blindtestRequest(genreId, name);
      setAsked((current) => new Set(current).add(key));
      onAsked();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t(msg('ple.request.failed')));
    } finally {
      setAsking(null);
    }
  }

  const label = (genreId: string) => genres.get(genreId)?.label ?? genreId;
  const row = (key: string, name: string, genreId: string, detail: string) => (
    <li key={key} className="pl-requests-row">
      <span className="pl-requests-name">
        {name}
        <span className="pl-requests-genre"> · {label(genreId)}</span>
      </span>
      <span className="pl-requests-status">{detail}</span>
      {asked.has(`${genreId}::${name}`) ? (
        <span className="pl-requests-status">{t(msg('ple.gaps.asked'))}</span>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          busy={asking === `${genreId}::${name}`}
          disabled={asking !== null}
          onClick={() => void ask(genreId, name)}
        >
          {t(msg('ple.request.submit'))}
        </Button>
      )}
    </li>
  );

  return (
    <details
      className="pl-gaps"
      onToggle={(event) => {
        if (event.currentTarget.open) void load();
      }}
    >
      <summary className="pl-requests-summary">{t(msg('ple.gaps.title'))}</summary>
      <p className="pl-requests-explain">{t(msg('ple.gaps.explain'))}</p>
      {loading && <p className="pl-fill">{t(msg('ple.gaps.loading'))}</p>}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {gaps && (
        <>
          <h4 className="pl-gaps-heading">{t(msg('ple.gaps.artists'))}</h4>
          <ul className="pl-requests-list">
            {gaps.artists.map((gap) =>
              row(
                `a:${gap.artist}`,
                gap.artist,
                gap.genreId,
                t(msg('ple.gaps.artistDetail', { rounds: gap.rounds, charts: gap.charts }))
              )
            )}
          </ul>
          <h4 className="pl-gaps-heading">{t(msg('ple.gaps.works'))}</h4>
          <ul className="pl-requests-list">
            {gaps.works.map((gap) =>
              row(
                `w:${gap.genreId}:${gap.work}`,
                gap.work,
                gap.genreId,
                t(msg(gap.searched ? 'ple.gaps.workSearched' : 'ple.gaps.workWaiting'))
              )
            )}
          </ul>
        </>
      )}
    </details>
  );
}
