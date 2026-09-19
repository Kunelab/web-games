import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { api, ApiError, type BlindtestCatalog, type BlindtestGenre } from '../api/client';
import { Button, Loading } from '../ui';
import './blindtest.css';

/**
 * The room for the generated blind test.
 *
 * Everything on this screen exists to answer one question before a room full of
 * people is committed to anything: *is there enough here to play?* Genres and a
 * difficulty window are abstract, and a set of filters that yields eleven clips
 * looks exactly like a set that yields four hundred until the game starts and
 * runs out. So the count is live, it is the loudest thing on the page, and the
 * start button refuses when it is zero.
 *
 * The labels are the server's own French strings rather than translation keys.
 * The catalogue is data — a genre is a row with a name, like a playlist — and
 * running it through the message catalogue would mean a key per genre that has
 * to be added in two places every time somebody adds a source.
 */

/** Long enough that dragging a slider does not fire a request per pixel. */
const COUNT_DEBOUNCE_MS = 400;

/** Below this the room will run dry quickly, and it is worth saying so. */
const THIN_POOL = 25;

/** How often to ask again while pools are still arriving. */
const POOL_POLL_MS = 4000;

/** null for a genre whose pool has not arrived yet. */
type Availability = Record<string, number | null>;

function DifficultySlider({
  min,
  max,
  onChange
}: {
  min: number;
  max: number;
  onChange: (next: { min: number; max: number }) => void;
}) {
  /**
   * Two range inputs stacked, rather than a drag-handle widget.
   *
   * They are keyboard operable and screen-reader labelled for free, which a pair
   * of divs with pointer handlers is not. The thumbs are allowed to cross, and
   * the values are ordered on read instead of being clamped against each other:
   * clamping makes the slider feel stuck at the ends, and the server orders them
   * again anyway.
   */
  return (
    <div className="bt-slider">
      <div className="bt-slider-track" aria-hidden="true">
        <div
          className="bt-slider-fill"
          style={{ left: `${Math.min(min, max)}%`, right: `${100 - Math.max(min, max)}%` }}
        />
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={min}
        aria-label="Difficulté minimale"
        onChange={(event) => onChange({ min: Number(event.target.value), max })}
      />
      <input
        type="range"
        min={0}
        max={100}
        value={max}
        aria-label="Difficulté maximale"
        onChange={(event) => onChange({ min, max: Number(event.target.value) })}
      />
    </div>
  );
}

export default function BlindtestSetup() {
  const navigate = useNavigate();

  const [catalog, setCatalog] = useState<BlindtestCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [difficulty, setDifficulty] = useState({ min: 0, max: 100 });
  const [region, setRegion] = useState('FR');
  const [maxRounds, setMaxRounds] = useState<number | null>(null);
  /**
   * How much of the evening is replayed from the shared catalogue.
   *
   * The two ends are genuinely different evenings rather than a performance
   * dial, which is why it is a choice and not a constant: a room that wants to
   * hear things nobody has heard turns it down and pays for it in quota, and a
   * room that would rather play what other rooms have already vetted and
   * corrected turns it up and pays nothing.
   */
  const [replayShare, setReplayShare] = useState(0.5);

  /**
   * The last count, tagged with the settings that produced it.
   *
   * Tagged rather than cleared, so "is this number still about what is on screen"
   * is derived at render instead of being a second piece of state that an effect
   * has to remember to reset. Cascading `setState` out of an effect body is both
   * a lint error here and the usual way a counter ends up briefly showing the
   * wrong total for the wrong genres.
   */
  const [result, setResult] = useState<{
    key: string;
    total: number;
    pending: number;
    perGenre: Availability;
  } | null>(null);
  /** Bumped to ask again while pools are still being fetched. */
  const [poll, setPoll] = useState(0);
  /** Tagged like the result, so a stale failure ages out instead of being cleared. */
  const [countError, setCountError] = useState<{ key: string; message: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .blindtestCatalog()
      .then((loaded) => {
        if (cancelled) return;
        setCatalog(loaded);
        setRegion(loaded.region);
      })
      .catch(() => {
        if (!cancelled) setLoadError('Impossible de charger le catalogue.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const genresBySection = useMemo(() => {
    const grouped = new Map<string, BlindtestGenre[]>();
    for (const genre of catalog?.genres ?? []) {
      const bucket = grouped.get(genre.section);
      if (bucket) bucket.push(genre);
      else grouped.set(genre.section, [genre]);
    }
    return grouped;
  }, [catalog]);

  /**
   * Counts whenever the settings settle.
   *
   * The first call for a genre is also what fills its pool on the server, which
   * takes tens of seconds and several searches. That is deliberate and it is why
   * this runs while the host is still choosing: by the time they press start the
   * catalogue is usually already in memory and the first round is instant.
   */
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /** Identity of the current settings. Also what tags a result as still current. */
  const settingsKey = useMemo(
    () =>
      JSON.stringify({
        genres: [...selected].sort(),
        min: Math.min(difficulty.min, difficulty.max),
        max: Math.max(difficulty.min, difficulty.max),
        region
      }),
    [selected, difficulty, region]
  );

  useEffect(() => {
    clearTimeout(timer.current);
    if (selected.size === 0) return;
    // A half-typed country is not a country; asking would only earn a 400.
    if (region.length !== 2) return;

    const settings = JSON.parse(settingsKey) as { genres: string[]; min: number; max: number; region: string };

    timer.current = setTimeout(() => {
      api
        .blindtestCount({
          genreIds: settings.genres,
          difficultyMin: settings.min,
          difficultyMax: settings.max,
          region: settings.region
        })
        .then((counted) => {
          // Tagged with the settings it answers, so an earlier slow reply cannot
          // overwrite a later one: a stale tag simply never matches again.
          setResult({
            key: settingsKey,
            total: counted.total,
            pending: counted.pending,
            perGenre: Object.fromEntries(counted.perGenre.map((entry) => [entry.genreId, entry.available]))
          });

          /**
           * Pools are fetched in the background, so the first answer for a cold
           * genre is "not yet". Asking again a few seconds later is what turns
           * that into a number without making the host press anything, and it
           * stops as soon as everything has landed.
           */
          if (counted.pending > 0) {
            timer.current = setTimeout(() => setPoll((value) => value + 1), POOL_POLL_MS);
          }
        })
        .catch((error: unknown) => {
          setCountError({
            key: settingsKey,
            message: error instanceof ApiError ? error.message : 'Le comptage a échoué. Vérifiez le pays et réessayez.'
          });
        });
    }, COUNT_DEBOUNCE_MS);

    return () => clearTimeout(timer.current);
  }, [selected, settingsKey, region, poll]);

  const fresh = result?.key === settingsKey ? result : null;
  const total = fresh?.total ?? null;
  const pending = fresh?.pending ?? 0;
  const available: Availability = fresh?.perGenre ?? {};
  const failure = countError?.key === settingsKey ? countError.message : null;

  /**
   * Which genres are still being built, by name.
   *
   * "3 genre(s) en cours de chargement…" is a number, and a number does not say
   * whether the wait is nearly over or has not started. Building one pool is
   * several searches, every playlist behind it and a model pass over what
   * survives, so it is the slowest thing on this screen by a wide margin and the
   * only one worth narrating. Naming them turns a spinner into progress: the
   * list shortens, and the host can see which choice is the expensive one.
   *
   * Capped at three names so a host who ticked everything gets a sentence rather
   * than a paragraph; the count carries the rest.
   */
  const loading = (catalog?.genres ?? [])
    .filter((genre) => selected.has(genre.id) && available[genre.id] === null)
    .map((genre) => genre.label);
  const loadingLabel =
    loading.length === 0
      ? ''
      : loading.length <= 3
        ? loading.join(', ')
        : `${loading.slice(0, 3).join(', ')} +${loading.length - 3}`;

  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSection = useCallback(
    (sectionId: string) => {
      const ids = (genresBySection.get(sectionId) ?? []).map((genre) => genre.id);
      setSelected((current) => {
        const next = new Set(current);
        // Tri-state: anything unselected means "select the rest", everything
        // selected means "clear them". So the second press always undoes the first.
        const allOn = ids.every((id) => next.has(id));
        for (const id of ids) {
          if (allOn) next.delete(id);
          else next.add(id);
        }
        return next;
      });
    },
    [genresBySection]
  );

  const toggleAll = useCallback(() => {
    setSelected((current) => {
      const every = catalog?.genres.map((genre) => genre.id) ?? [];
      return current.size === every.length ? new Set() : new Set(every);
    });
  }, [catalog]);

  async function start() {
    setStarting(true);
    setStartError(null);
    try {
      const created = await api.blindtestCreate({
        genreIds: [...selected],
        difficultyMin: Math.min(difficulty.min, difficulty.max),
        difficultyMax: Math.max(difficulty.min, difficulty.max),
        region,
        maxRounds,
        replayShare
      });
      /**
       * The host token proves ownership over the socket, and the host screen
       * reads it from `sessionStorage` keyed by the join code — not from router
       * state, which does not survive the refresh a television inevitably gets.
       * Same handshake every other way of starting a game uses; see Launch.tsx.
       */
      sessionStorage.setItem(`kune.host.${created.code}`, created.hostToken);
      void navigate(`/partie/${created.code}`);
    } catch (error) {
      setStartError(
        error instanceof ApiError ? error.message : "La partie n'a pas pu démarrer. Réessayez dans un instant."
      );
      setStarting(false);
    }
  }

  if (loadError) return <p className="bt-error">{loadError}</p>;
  if (!catalog) return <Loading />;

  if (!catalog.available) {
    return (
      <div className="bt-setup">
        <h1>Blind test infini</h1>
        <p className="bt-error">
          Ce serveur n&apos;a pas de clé YouTube configurée, donc il ne peut pas constituer de catalogue. Renseignez
          <code> GOOGLE_API_KEY</code> puis redémarrez.
        </p>
      </div>
    );
  }

  const everySelected = selected.size === catalog.genres.length;
  const canStart = selected.size > 0 && total !== null && total > 0 && !starting;

  return (
    <div className="bt-setup">
      <header className="bt-head">
        <div>
          <h1>Blind test infini</h1>
          <p className="bt-lede">
            Les extraits sont trouvés au fur et à mesure : pendant qu&apos;un titre passe, le suivant se prépare. Rien
            n&apos;est enregistré dans votre bibliothèque.
          </p>
        </div>
        <div className={`bt-count ${total === 0 ? 'is-empty' : ''}`} aria-live="polite">
          {selected.size === 0 ? (
            <span className="bt-count-hint">Choisissez au moins un genre</span>
          ) : total === null ? (
            <span className="bt-count-hint">Comptage…</span>
          ) : (
            <>
              <strong>{total}</strong>
              <span className="bt-count-hint">
                {pending > 0
                  ? `extraits · préparation de ${loadingLabel}…`
                  : `extraits jouables en ${region}`}
              </span>
            </>
          )}
        </div>
      </header>

      <section className="bt-section-head">
        <h2>Genres</h2>
        <button type="button" className="bt-link" onClick={toggleAll}>
          {everySelected ? 'Tout désélectionner' : 'Tout sélectionner'}
        </button>
      </section>

      <div className="bt-sections">
        {catalog.sections.map((section) => {
          const genres = genresBySection.get(section.id) ?? [];
          if (genres.length === 0) return null;
          const chosen = genres.filter((genre) => selected.has(genre.id)).length;

          return (
            <div key={section.id} className="bt-section">
              <button
                type="button"
                className={`bt-section-title ${chosen === genres.length ? 'is-full' : chosen > 0 ? 'is-part' : ''}`}
                onClick={() => toggleSection(section.id)}
              >
                <span className="bt-check" aria-hidden="true">
                  {chosen === genres.length ? '✓' : chosen > 0 ? '–' : ''}
                </span>
                {section.label}
              </button>

              <div className="bt-genres">
                {genres.map((genre) => {
                  const count = available[genre.id];
                  const isOn = selected.has(genre.id);
                  return (
                    <button
                      key={genre.id}
                      type="button"
                      className={`bt-genre ${isOn ? 'is-on' : ''}`}
                      onClick={() => toggle(genre.id)}
                      aria-pressed={isOn}
                    >
                      <span className="bt-genre-label">{genre.label}</span>
                      {genre.facet && <span className="bt-tag">époque</span>}
                      {isOn && count !== undefined && (
                        <span className={`bt-genre-count ${count !== null && count < THIN_POOL ? 'is-thin' : ''}`}>
                          {count === null ? '…' : count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <section className="bt-controls">
        <div className="bt-control">
          <label htmlFor="bt-difficulty">
            Difficulté{' '}
            <span className="bt-range">
              {Math.min(difficulty.min, difficulty.max)} – {Math.max(difficulty.min, difficulty.max)}
            </span>
          </label>
          <DifficultySlider min={difficulty.min} max={difficulty.max} onChange={setDifficulty} />
          <p className="bt-hint">
            Le niveau est tiré au hasard dans cette fourchette à chaque manche. Il décide du titre choisi et aussi de
            l&apos;extrait : une intro connue pour une manche facile, un couplet pour une difficile.
          </p>
        </div>

        <div className="bt-control bt-control-row">
          <div>
            <label htmlFor="bt-region">Pays</label>
            <input
              id="bt-region"
              className="bt-input"
              value={region}
              maxLength={2}
              onChange={(event) => setRegion(event.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
            />
            <p className="bt-hint">
              Celui de l&apos;écran qui diffuse. Beaucoup de clips ne sont sous licence que dans certains pays.
            </p>
          </div>

          <div>
            <label htmlFor="bt-rounds">Longueur</label>
            <select
              id="bt-rounds"
              className="bt-input"
              value={maxRounds ?? 'infini'}
              onChange={(event) => setMaxRounds(event.target.value === 'infini' ? null : Number(event.target.value))}
            >
              <option value="infini">Infinie</option>
              <option value="10">10 manches</option>
              <option value="20">20 manches</option>
              <option value="50">50 manches</option>
            </select>
            <p className="bt-hint">
              Une partie infinie se termine quand vous le décidez, depuis l&apos;écran d&apos;animation.
            </p>
          </div>

          <div>
            <label htmlFor="bt-replay">Source des manches</label>
            <select
              id="bt-replay"
              className="bt-input"
              value={String(replayShare)}
              onChange={(event) => setReplayShare(Number(event.target.value))}
            >
              <option value="0">Que des nouveautés</option>
              <option value="0.25">Surtout des nouveautés</option>
              <option value="0.5">Moitié-moitié</option>
              <option value="0.75">Surtout le catalogue</option>
              <option value="1">Que le catalogue</option>
            </select>
            <p className="bt-hint">
              Le catalogue, c&apos;est ce que les autres salles ont déjà joué : gratuit, et déjà vérifié. Une nouveauté
              coûte une recherche. Jamais deux fois le même morceau dans une partie, quel que soit le réglage.
            </p>
          </div>
        </div>
      </section>

      {total === 0 && pending === 0 && selected.size > 0 && (
        <p className="bt-error">
          Aucun extrait jouable avec ces réglages. Élargissez la difficulté, ajoutez des genres, ou vérifiez le pays.
        </p>
      )}
      {failure && <p className="bt-error">{failure}</p>}
      {startError && <p className="bt-error">{startError}</p>}

      <div className="page-actions">
        <Button variant="primary" size="lg" disabled={!canStart} onClick={() => void start()}>
          {starting ? 'Préparation…' : 'Lancer'}
        </Button>
      </div>
    </div>
  );
}
