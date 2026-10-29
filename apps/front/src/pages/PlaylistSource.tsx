import { genreKeysOf, mediaDifficulty } from 'game-core';
import { msg } from 'i18n';
import { useMemo } from 'react';

import { api } from '../api/client';
import { useAsync } from '../hooks/useAsync';
import { useT } from '../i18n/locale-context';
import { Field, Select, Switch } from '../ui';
import { DifficultySlider } from './BlindtestSource';
import {
  LENGTHS,
  ordered,
  playlistSelection,
  windowOf,
  type PlaylistFilter,
  type Selectable
} from './playlist-selection';
import './blindtest.css';

/**
 * What of a playlist a room plays: the launch screen's answer to "all of it?".
 *
 * A hand-built quiz of twenty is played whole and never needed asking. The
 * shared catalogue is thousands of clips across every genre the endless mode
 * knows, and launching it meant a rap night got opera, at every difficulty, for
 * as long as anybody could stand. So a playlist gets the endless mode's own
 * choices: which genres, how hard, how long. The genres are the playlist's
 * categories, and on the catalogue those are the endless mode's genres, named
 * and grouped the way its setup screen groups them.
 *
 * Controlled by the launch screen, because the start button belongs to the
 * room and is what sends the choice; see `playlist-selection` for the request.
 */

interface GenreGroup {
  id: string;
  label: string;
  keys: string[];
}

export function PlaylistSource({
  items,
  value,
  onChange
}: {
  items: readonly Selectable[];
  value: PlaylistFilter;
  onChange: (next: PlaylistFilter) => void;
}) {
  const t = useT();
  // The endless mode's genre names. A playlist of free-text categories needs
  // none of it, and a failure only costs the catalogue's ids their labels.
  const catalog = useAsync(() => api.blindtestCatalog().catch(() => null), []);

  const ready = useMemo(() => items.filter((item) => item.readiness.ready), [items]);
  // A round listed in more than one genre is offered under each of them.
  const keys = useMemo(() => [...new Set(ready.flatMap(genreKeysOf))], [ready]);
  /** Genres with at least one rated media: the only ones a window can narrow. */
  const rated = useMemo(
    () => new Set(ready.filter((item) => mediaDifficulty(item) !== null).flatMap(genreKeysOf)),
    [ready]
  );

  /**
   * The playlist's genres, grouped: the endless mode's sections first, in its
   * order, then every free-text category, then the media with none.
   */
  const groups = useMemo((): GenreGroup[] => {
    const present = new Set(keys);
    const genres = catalog.data?.genres ?? [];
    const known = new Set(genres.map((genre) => genre.id));
    const result: GenreGroup[] = [];
    for (const section of catalog.data?.sections ?? []) {
      const sectionKeys = genres
        .filter((genre) => genre.section === section.id && present.has(genre.id))
        .map((genre) => genre.id);
      if (sectionKeys.length > 0) result.push({ id: section.id, label: section.label, keys: sectionKeys });
    }
    const others = keys.filter((key) => key !== '' && !known.has(key)).sort((a, b) => a.localeCompare(b, 'fr'));
    if (present.has('')) others.push('');
    if (others.length > 0) result.push({ id: '', label: t(msg('launch.filter.categories')), keys: others });
    return result;
  }, [keys, catalog.data, t]);

  const labelOf = useMemo(() => {
    const known = new Map((catalog.data?.genres ?? []).map((genre) => [genre.id, genre.label]));
    return (key: string) => (key === '' ? t(msg('launch.filter.noGenre')) : (known.get(key) ?? key));
  }, [catalog.data, t]);

  /** What each genre has inside its window, kept or not, so setting one aside shows what it costs. */
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    // Under every genre it is in, so each count says what that genre alone would play.
    for (const item of ready) {
      const rating = mediaDifficulty(item);
      for (const key of genreKeysOf(item)) {
        const window = windowOf(value, key);
        if (rating !== null && (rating < window.min || rating > window.max)) continue;
        result.set(key, (result.get(key) ?? 0) + 1);
      }
    }
    return result;
  }, [ready, value]);

  const { kept } = useMemo(() => playlistSelection(items, value), [items, value]);

  function setExcluded(next: Set<string>) {
    onChange({ ...value, excluded: next });
  }

  function toggle(key: string) {
    const next = new Set(value.excluded);
    if (!next.delete(key)) next.add(key);
    setExcluded(next);
  }

  /** Tri-state, like the endless mode: anything set aside brings the rest back, all kept sets them aside. */
  function toggleGroup(groupKeys: string[]) {
    const next = new Set(value.excluded);
    const allKept = groupKeys.every((key) => !next.has(key));
    for (const key of groupKeys) {
      if (allKept) next.add(key);
      else next.delete(key);
    }
    setExcluded(next);
  }

  const everyKept = value.excluded.size === 0;
  const lengths = LENGTHS.filter((length) => length < kept);
  const rounds = value.maxRounds !== null && value.maxRounds < kept ? value.maxRounds : null;
  /** The genres a per-genre window applies to: kept, and rated. */
  const tunable = groups.flatMap((group) => group.keys).filter((key) => !value.excluded.has(key) && rated.has(key));
  const shared = ordered(value.difficulty);

  return (
    <div className="pl-source">
      {/* The count beside the genres it counts, and alone when there are none to choose. */}
      <div className="pl-source-head">
        {keys.length > 1 && (
          <div className="pl-source-genres-head">
            <h3>{t(msg('launch.filter.genres'))}</h3>
            <button
              type="button"
              className="bt-link"
              onClick={() => setExcluded(everyKept ? new Set(keys) : new Set())}
            >
              {t(msg(everyKept ? 'launch.filter.selectNone' : 'launch.filter.selectAll'))}
            </button>
          </div>
        )}
        <div className={`bt-count ${kept === 0 ? 'is-empty' : ''}`} aria-live="polite">
          <strong>{kept}</strong>
          <span className="bt-count-hint">{t(msg('launch.filter.kept', { total: ready.length }))}</span>
        </div>
      </div>

      {keys.length > 1 && (
        <>
          <div className="bt-sections">
            {groups.map((group) => {
              const chosen = group.keys.filter((key) => !value.excluded.has(key)).length;
              const state = chosen === group.keys.length ? 'is-full' : chosen > 0 ? 'is-part' : '';
              return (
                <div key={group.id || 'categories'} className="bt-section">
                  <button type="button" className={`bt-section-title ${state}`} onClick={() => toggleGroup(group.keys)}>
                    <span className="bt-check" aria-hidden="true">
                      {chosen === group.keys.length ? '✓' : chosen > 0 ? '–' : ''}
                    </span>
                    {group.label}
                  </button>
                  <div className="bt-genres">
                    {group.keys.map((key) => {
                      const isOn = !value.excluded.has(key);
                      return (
                        <button
                          key={key || 'none'}
                          type="button"
                          className={`bt-genre ${isOn ? 'is-on' : ''}`}
                          aria-pressed={isOn}
                          onClick={() => toggle(key)}
                        >
                          <span className="bt-genre-label">{labelOf(key)}</span>
                          <span className="bt-genre-count">{counts.get(key) ?? 0}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Only blind tests carry a difficulty, so a quiz of questions is never asked. */}
      {rated.size > 0 && (
        <div className="bt-controls">
          {value.perGenre === null ? (
            <div className="bt-control">
              <p className="pl-source-label">
                {t(msg('launch.filter.difficulty'))}{' '}
                <span className="bt-range">
                  {shared.min} – {shared.max}
                </span>
              </p>
              <DifficultySlider
                min={value.difficulty.min}
                max={value.difficulty.max}
                labels={{ min: t(msg('launch.filter.difficultyMin')), max: t(msg('launch.filter.difficultyMax')) }}
                onChange={(difficulty) => onChange({ ...value, difficulty })}
              />
            </div>
          ) : (
            <div className="pl-source-windows">
              {tunable.map((key) => {
                const window = value.perGenre?.[key] ?? value.difficulty;
                const shown = ordered(window);
                return (
                  <div key={key || 'none'} className="bt-control">
                    <p className="pl-source-label">
                      {labelOf(key)}{' '}
                      <span className="bt-range">
                        {shown.min} – {shown.max}
                      </span>
                    </p>
                    <DifficultySlider
                      min={window.min}
                      max={window.max}
                      labels={{
                        min: t(msg('launch.filter.difficultyMinOf', { genre: labelOf(key) })),
                        max: t(msg('launch.filter.difficultyMaxOf', { genre: labelOf(key) }))
                      }}
                      onChange={(next) => onChange({ ...value, perGenre: { ...value.perGenre, [key]: next } })}
                    />
                  </div>
                );
              })}
            </div>
          )}
          <p className="bt-hint">{t(msg('launch.filter.difficulty.hint'))}</p>

          {rated.size > 1 && (
            <Switch
              label={t(msg('launch.filter.perGenre'))}
              hint={t(msg('launch.filter.perGenre.hint'))}
              checked={value.perGenre !== null}
              onCheckedChange={(checked) =>
                onChange({
                  ...value,
                  // Every genre starts from the range already set, so turning
                  // this on changes nothing until a slider moves.
                  perGenre: checked ? Object.fromEntries(keys.map((key) => [key, value.difficulty])) : null
                })
              }
            />
          )}
        </div>
      )}

      {(kept > LENGTHS[0] || rounds !== null) && (
        <Field label={t(msg('launch.length'))} hint={t(msg('launch.length.hint'))}>
          {({ id: fieldId, describedBy }) => (
            <Select
              id={fieldId}
              aria-describedby={describedBy}
              value={rounds === null ? 'all' : String(rounds)}
              options={[
                { value: 'all', label: t(msg('launch.length.all', { count: kept })) },
                ...lengths.map((length) => ({
                  value: String(length),
                  label: t(msg('launch.length.rounds', { count: length }))
                }))
              ]}
              onValueChange={(next) => onChange({ ...value, maxRounds: next === 'all' ? null : Number(next) })}
            />
          )}
        </Field>
      )}

      {kept === 0 && <p className="bt-error">{t(msg('launch.filter.empty'))}</p>}
    </div>
  );
}
