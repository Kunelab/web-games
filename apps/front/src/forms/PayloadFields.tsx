import type { FieldMeta } from 'game-core';
import { useEffect, useState } from 'react';

import {
  api,
  ApiError,
  type DifficultyPreset,
  type DifficultyRange,
  type PanelItem,
  type PanelNationality,
  type PanelTheme,
  type WikiSubject,
  type YoutubeMetadata
} from '../api/client';
import { Button, Chip, Field, IconButton, Input, Select, Switch, Textarea } from '../ui';
import './forms.css';

/**
 * Renders a media kind's payload editor from its own metadata.
 *
 * Nothing here knows what a blind test or a quiz is. The kind declares its fields
 * once in game-core, the server validates against that same declaration, and this
 * builds the controls from it — so adding a kind adds no code to this file, and a
 * field can never exist in the form but not in the schema.
 */

/**
 * The panel control's wiring, which is unlike every other control here.
 *
 * Generating a grid produces pictures and the answers that go with them, and
 * answers do not live in the payload. So the editor above owns both lists and
 * passes down the two operations, keeping cell and answer aligned by index.
 */
export interface PanelBinding {
  /** Answer values, in cell order, so each thumbnail can be captioned. */
  labels: string[];
  onGenerated: (items: PanelItem[]) => void;
  onRemoved: (index: number) => void;
}

export interface PayloadFieldsProps {
  fields: FieldMeta[];
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  errors: Record<string, string>;
  /** Called when a YouTube lookup succeeds, so answers can be prefilled. */
  onYoutubeMetadata?: (metadata: YoutubeMetadata) => void;
  /** Called when a Wikipedia lookup is adopted, so answers can be prefilled. */
  onWikiSubject?: (subject: WikiSubject) => void;
  /** Required by the `panel` control, ignored by every other kind. */
  panel?: PanelBinding;
}

export function PayloadFields({
  fields,
  value,
  onChange,
  errors,
  onYoutubeMetadata,
  onWikiSubject,
  panel
}: PayloadFieldsProps) {
  const groups = groupFields(fields);

  return (
    <div className="form-groups">
      {groups.map((group) => (
        <fieldset className="form-group" key={group.name ?? '__ungrouped'}>
          {group.name && <legend className="form-legend">{group.name}</legend>}
          <div className="form-grid">
            {group.fields.map((field) => (
              <div className={field.width === 'half' ? 'span-half' : 'span-full'} key={field.name}>
                <PayloadField
                  field={field}
                  value={value[field.name]}
                  error={errors[field.name]}
                  onChange={(next) => onChange({ ...value, [field.name]: next })}
                  onYoutubeMetadata={onYoutubeMetadata}
                  onWikiSubject={onWikiSubject}
                  panel={panel}
                />
              </div>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

interface Group {
  name: string | undefined;
  fields: FieldMeta[];
}

/** Consecutive fields sharing a `group` render under one heading. */
function groupFields(fields: FieldMeta[]): Group[] {
  const groups: Group[] = [];

  for (const field of fields) {
    const last = groups.at(-1);
    if (last && last.name === field.group) {
      last.fields.push(field);
    } else {
      groups.push({ name: field.group, fields: [field] });
    }
  }

  return groups;
}

interface PayloadFieldProps {
  field: FieldMeta;
  value: unknown;
  error?: string;
  onChange: (next: unknown) => void;
  onYoutubeMetadata?: (metadata: YoutubeMetadata) => void;
  onWikiSubject?: (subject: WikiSubject) => void;
  panel?: PanelBinding;
}

function PayloadField({ field, value, error, onChange, onYoutubeMetadata, onWikiSubject, panel }: PayloadFieldProps) {
  if (field.control === 'switch') {
    return (
      <Switch
        label={field.label}
        hint={field.help}
        checked={Boolean(value)}
        onCheckedChange={(checked) => onChange(checked)}
      />
    );
  }

  return (
    <Field label={field.label} hint={field.help} error={error}>
      {({ id, describedBy, invalid }) => {
        const shared = { id, 'aria-describedby': describedBy, 'aria-invalid': invalid || undefined };

        switch (field.control) {
          case 'textarea':
            return (
              <Textarea
                {...shared}
                value={asString(value)}
                placeholder={field.placeholder}
                onChange={(event) => onChange(event.target.value)}
              />
            );

          case 'number':
            return (
              <Input
                {...shared}
                type="number"
                min={field.min}
                max={field.max}
                step={field.step ?? 1}
                value={typeof value === 'number' ? String(value) : asString(value)}
                placeholder={field.placeholder}
                onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}
              />
            );

          case 'seconds':
            return (
              <SecondsInput
                {...shared}
                seconds={typeof value === 'number' ? value : 0}
                onSeconds={(next) => onChange(next)}
              />
            );

          case 'duration':
            return (
              <DurationInput
                {...shared}
                ms={typeof value === 'number' ? value : 0}
                min={field.min}
                max={field.max}
                onMs={(next) => onChange(next)}
              />
            );

          case 'select':
            return (
              <Select
                id={id}
                aria-describedby={describedBy}
                value={asString(value)}
                onValueChange={(next) => onChange(next)}
                options={(field.options ?? []).map((option) => ({ value: option.value, label: option.label }))}
                placeholder={field.placeholder}
              />
            );

          case 'youtube':
            return (
              <YoutubeInput
                {...shared}
                value={asString(value)}
                placeholder={field.placeholder}
                onChange={onChange}
                onMetadata={onYoutubeMetadata}
              />
            );

          case 'image':
            return field.wikiSearch ? (
              <WikiImageInput
                {...shared}
                value={asString(value)}
                placeholder={field.placeholder}
                onChange={onChange}
                onSubject={onWikiSubject}
              />
            ) : (
              <ImageInput {...shared} value={asString(value)} placeholder={field.placeholder} onChange={onChange} />
            );

          case 'list':
            return <ListInput {...shared} values={asStringArray(value)} onChange={onChange} />;

          case 'panel':
            return panel ? (
              <PanelInput {...shared} cells={asStringArray(value)} binding={panel} />
            ) : (
              <p className="field-hint">Cette grille ne peut être composée que depuis l’éditeur de média.</p>
            );

          default:
            return (
              <Input
                {...shared}
                type="text"
                value={asString(value)}
                placeholder={field.placeholder}
                onChange={(event) => onChange(event.target.value)}
              />
            );
        }
      }}
    </Field>
  );
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Anything else has no sensible text form and must not reach an input as
  // "[object Object]".
  return '';
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asString) : [];
}

/* --------------------------------------------------------------- mm:ss input */

interface SecondsInputProps {
  seconds: number;
  onSeconds: (seconds: number) => void;
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

function secondsToClock(total: number): string {
  const safe = Math.max(0, Math.trunc(total));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function clockToSeconds(text: string): number | null {
  const match = /^(\d{1,3}):([0-5]?\d)$/.exec(text.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Timestamps as mm:ss.
 *
 * Held as local text while being typed so the caret does not jump: reformatting on
 * every keystroke is what made the old time inputs unusable, and it is also why
 * they had to be uncontrolled to work at all.
 */
function SecondsInput({ seconds, onSeconds, ...aria }: SecondsInputProps) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (text: string) => {
    const parsed = clockToSeconds(text);
    if (parsed !== null) {
      onSeconds(parsed);
    }
    setDraft(null);
  };

  return (
    <Input
      {...aria}
      className="input-mono"
      inputMode="numeric"
      placeholder="mm:ss"
      value={draft ?? secondsToClock(seconds)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => commit(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit(event.currentTarget.value);
        }
      }}
    />
  );
}

interface DurationInputProps {
  ms: number;
  onMs: (ms: number) => void;
  min?: number;
  max?: number;
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

/** Stored in milliseconds, shown in seconds, because nobody thinks in 20000. */
function DurationInput({ ms, onMs, min, max, ...aria }: DurationInputProps) {
  return (
    <div className="input-suffixed">
      <Input
        {...aria}
        type="number"
        min={min === undefined ? undefined : Math.round(min / 1000)}
        max={max === undefined ? undefined : Math.round(max / 1000)}
        step={1}
        value={Math.round(ms / 1000)}
        onChange={(event) => onMs(Math.max(0, Number(event.target.value)) * 1000)}
      />
      <span className="input-suffix">secondes</span>
    </div>
  );
}

/* ------------------------------------------------------------- youtube input */

interface YoutubeInputProps {
  value: string;
  onChange: (next: string) => void;
  onMetadata?: (metadata: YoutubeMetadata) => void;
  placeholder?: string;
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

function YoutubeInput({ value, onChange, onMetadata, placeholder, ...aria }: YoutubeInputProps) {
  const [raw, setRaw] = useState(value);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  /** Accepts a bare id or any YouTube URL carrying one. */
  function extractId(text: string): string | null {
    const trimmed = text.trim();
    if (YOUTUBE_ID.test(trimmed)) return trimmed;

    try {
      const url = new URL(trimmed);
      const fromQuery = url.searchParams.get('v');
      if (fromQuery && YOUTUBE_ID.test(fromQuery)) return fromQuery;
      const last = url.pathname.split('/').filter(Boolean).pop();
      if (last && YOUTUBE_ID.test(last)) return last;
    } catch {
      // Not a URL.
    }
    return null;
  }

  async function lookup() {
    const id = extractId(raw);
    if (!id) {
      setMessage('Ce lien ne contient pas d’identifiant YouTube.');
      return;
    }

    onChange(id);
    setBusy(true);
    setMessage(null);

    try {
      const metadata = await api.youtubeLookup(id);
      onMetadata?.(metadata);
      setMessage(`Trouvé : ${metadata.rawTitle}`);
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : 'La recherche a échoué. Le code reste enregistré.');
    } finally {
      setBusy(false);
    }
  }

  const id = extractId(raw);

  return (
    <div className="stack-2">
      <div className="row-attached">
        <Input
          {...aria}
          value={raw}
          placeholder={placeholder}
          onChange={(event) => {
            setRaw(event.target.value);
            const extracted = extractId(event.target.value);
            // Keep the payload in sync even without a lookup, so a paste alone is
            // enough to save a working item.
            onChange(extracted ?? event.target.value.trim());
          }}
          onBlur={() => void (id && lookup())}
        />
        <Button variant="secondary" onClick={() => void lookup()} busy={busy} disabled={!id}>
          Remplir
        </Button>
      </div>

      {id && (
        <div className="yt-preview">
          <img src={`https://img.youtube.com/vi/${id}/default.jpg`} alt="" width={80} height={60} />
          <div className="stack-1">
            <code className="yt-id">{id}</code>
            <a className="link-quiet" href={`https://www.youtube.com/watch?v=${id}`} target="_blank" rel="noreferrer">
              Ouvrir sur YouTube
            </a>
          </div>
        </div>
      )}

      {message && <p className="field-hint">{message}</p>}
    </div>
  );
}

/* --------------------------------------------------------------- image input */

interface ImageInputProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

function ImageInput({ value, onChange, placeholder, ...aria }: ImageInputProps) {
  const [broken, setBroken] = useState(false);

  return (
    <div className="stack-2">
      <Input
        {...aria}
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          setBroken(false);
          onChange(event.target.value);
        }}
      />
      {value && !broken && <img className="image-preview" src={value} alt="" onError={() => setBroken(true)} />}
      {value && broken && <p className="field-error">Cette image ne charge pas.</p>}
    </div>
  );
}

/**
 * An image field with the panel pipeline behind it: type a name, get pictures.
 *
 * Picking a result fills the URL and hands the whole subject to the editor, which
 * uses the title as the answer and the opening lines as material. Manual paste
 * keeps working exactly as before — the lookup is an offer, not a mode.
 */
function WikiImageInput({
  value,
  onChange,
  onSubject,
  placeholder,
  ...aria
}: ImageInputProps & { onSubject?: (subject: WikiSubject) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<WikiSubject[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function search() {
    const wanted = query.trim();
    if (wanted.length < 2 || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const { results: found } = await api.wikiSearch(wanted);
      setResults(found);
      if (found.length === 0) setMessage('Rien trouvé avec une image utilisable.');
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : 'La recherche a échoué.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-2">
      <ImageInput value={value} onChange={onChange} placeholder={placeholder} {...aria} />

      <div className="row-attached">
        <Input
          value={query}
          placeholder="Chercher sur Wikipédia : tour eiffel, marie curie…"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void search();
            }
          }}
        />
        <Button variant="secondary" size="sm" busy={busy} onClick={() => void search()}>
          Chercher
        </Button>
      </div>

      {message && <p className="field-hint">{message}</p>}

      {results.length > 0 && (
        <ul className="wiki-results">
          {results.map((result) => (
            <li key={result.pageUrl}>
              <img src={result.imageUrl} alt="" loading="lazy" />
              <span>
                <span className="wiki-result-title">{result.label}</span>
                {result.description && <span className="wiki-result-desc">{result.description}</span>}
              </span>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  onChange(result.imageUrl);
                  onSubject?.(result);
                  setResults([]);
                }}
              >
                Utiliser
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Two native range inputs stacked on one track.
 *
 * A dual-thumb slider without a dependency: both inputs cover the full track,
 * pointer events land on whichever thumb is nearer thanks to the higher z-index
 * on the thumb halves, and each thumb clamps against the other so the window can
 * be narrowed to a sliver but never inverted. The highlighted band between the
 * thumbs is a background gradient recomputed from the values.
 */
function DifficultySlider({ range, onChange }: { range: DifficultyRange; onChange: (next: DifficultyRange) => void }) {
  const highlight = `linear-gradient(to right,
    var(--rule) ${range.min}%,
    var(--accent) ${range.min}%,
    var(--accent) ${range.max}%,
    var(--rule) ${range.max}%)`;

  return (
    <div className="range-slider" style={{ background: highlight }}>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={range.min}
        aria-label="Notoriété minimale"
        onChange={(event) => onChange({ ...range, min: Math.min(Number(event.target.value), range.max) })}
      />
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={range.max}
        aria-label="Notoriété maximale"
        onChange={(event) => onChange({ ...range, max: Math.max(Number(event.target.value), range.min) })}
      />
    </div>
  );
}

/* --------------------------------------------------------------- panel input */

interface PanelInputProps {
  cells: string[];
  binding: PanelBinding;
  id?: string;
  'aria-describedby'?: string;
}

/** Sizes worth offering, up to what the sources can reliably fill. */
const PANEL_SIZES = [10, 20, 30, 40, 50];

/**
 * Builds a memory panel by theme instead of by hand.
 *
 * Twenty URLs and twenty answers is the one authoring job nobody does twice, so
 * the point of this control is that a playable panel is three clicks. What comes
 * back is a proposal: every cell can be dropped, every answer stays editable
 * below, and the source article is one click away for anything doubtful.
 */
function PanelInput({ cells, binding, ...aria }: PanelInputProps) {
  const [themes, setThemes] = useState<PanelTheme[]>([]);
  const [nationalities, setNationalities] = useState<PanelNationality[]>([]);
  const [presets, setPresets] = useState<DifficultyPreset[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [chosenNats, setChosenNats] = useState<string[]>(['fr', 'us']);
  const [range, setRange] = useState<DifficultyRange>({ min: 0, max: 70 });
  const [count, setCount] = useState(20);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /**
   * Cells whose image would not load, by URL.
   *
   * This is the existence check, and it happens here on purpose: the browser that
   * has to draw the panel is the only authority on whether it can, and it answers
   * for free while the host is already looking at the grid.
   */
  const [broken, setBroken] = useState<string[]>([]);

  useEffect(() => {
    // Themes, groups and nationalities are the server's to know: nothing here is
    // hardcoded, so adding a sub-category is a server-only change.
    api
      .panelThemes()
      .then((response) => {
        setThemes(response.themes);
        setNationalities(response.nationalities);
        setPresets(response.difficultyPresets);
        setRange(response.defaultRange);
      })
      .catch(() => setMessage('Les thèmes de panel sont indisponibles.'));
  }, []);

  function toggle(id: string) {
    setChosen((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
  }

  function toggleNat(id: string) {
    setChosenNats((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
  }

  /** The nationality picker only earns its space when a people theme is in play. */
  const peopleSelected = themes.some(
    (theme) => theme.byNationality && (chosen.length === 0 || chosen.includes(theme.id))
  );

  async function generate() {
    const wanted = chosen.length > 0 ? chosen : themes.map((theme) => theme.id);
    if (wanted.length === 0) return;

    setBusy(true);
    setMessage(null);
    setBroken([]);

    try {
      const { items } = await api.buildPanel(wanted, count, range, chosenNats);
      binding.onGenerated(items);
      setMessage(
        items.length < count
          ? `${items.length} éléments trouvés sur ${count} demandés. Relancez pour compléter.`
          : `${items.length} éléments. Vérifiez la grille avant d’enregistrer.`
      );
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : 'La génération a échoué.');
    } finally {
      setBusy(false);
    }
  }

  /** Themes render under their group heading, in the order the server sent. */
  const groups: { name: string; themes: PanelTheme[] }[] = [];
  for (const theme of themes) {
    const group = groups.find((candidate) => candidate.name === theme.group);
    if (group) group.themes.push(theme);
    else groups.push({ name: theme.group, themes: [theme] });
  }

  return (
    <div className="stack-3" id={aria.id} aria-describedby={aria['aria-describedby']}>
      {groups.map((group) => (
        <div key={group.name}>
          <span className="panel-group-label">{group.name}</span>
          <div className="panel-themes">
            {group.themes.map((theme) => (
              <Chip key={theme.id} active={chosen.includes(theme.id)} onClick={() => toggle(theme.id)}>
                {theme.label}
              </Chip>
            ))}
          </div>
        </div>
      ))}

      {peopleSelected && nationalities.length > 0 && (
        <div>
          <span className="panel-group-label">Nationalités</span>
          <div className="panel-themes">
            {nationalities.map((nationality) => (
              <Chip
                key={nationality.id}
                active={chosenNats.includes(nationality.id)}
                onClick={() => toggleNat(nationality.id)}
              >
                {nationality.label}
              </Chip>
            ))}
          </div>
        </div>
      )}

      <div>
        <span className="panel-group-label">
          Difficulté · {range.min}–{range.max}
        </span>
        <div className="panel-themes">
          {presets.map((preset) => (
            <Chip
              key={preset.id}
              active={range.min === preset.min && range.max === preset.max}
              onClick={() => setRange({ min: preset.min, max: preset.max })}
            >
              {preset.label}
            </Chip>
          ))}
        </div>
        <DifficultySlider range={range} onChange={setRange} />
        <p className="field-hint">
          Notoriété mesurée sur les vues mensuelles de chaque sujet, dans sa catégorie : 0 pioche les têtes d’affiche,
          100 va chercher les inconnus. Resserrez la plage ou mélangez tout.
        </p>
      </div>

      <div className="panel-actions">
        <Select
          value={String(count)}
          onValueChange={(next) => setCount(Number(next))}
          options={PANEL_SIZES.map((size) => ({ value: String(size), label: `${size} éléments` }))}
        />
        <Button variant="primary" size="sm" busy={busy} onClick={() => void generate()}>
          {cells.length > 0 ? 'Regénérer' : 'Composer la grille'}
        </Button>
        <span className="field-hint">
          {chosen.length === 0 ? 'Tous les thèmes mélangés' : `${chosen.length} thème(s)`}
        </span>
      </div>

      {cells.length > 0 && (
        <ul className="panel-grid-edit">
          {cells.map((cell, index) => (
            <li key={`${cell}-${index}`} className={broken.includes(cell) ? 'cell-broken' : undefined}>
              {broken.includes(cell) ? (
                <span className="cell-failed">image indisponible</span>
              ) : (
                <img src={cell} alt="" loading="lazy" onError={() => setBroken((current) => [...current, cell])} />
              )}
              <span className="panel-cell-label">{binding.labels[index] ?? '—'}</span>
              <IconButton
                icon={<CrossIcon />}
                label={`Retirer ${binding.labels[index] ?? `l’élément ${index + 1}`}`}
                onClick={() => binding.onRemoved(index)}
              />
            </li>
          ))}
        </ul>
      )}

      {broken.length > 0 && (
        <p className="field-error">{broken.length} image(s) ne se chargent pas. Retirez-les avant d’enregistrer.</p>
      )}

      {message && <p className="field-hint">{message}</p>}
    </div>
  );
}

function CrossIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/* ---------------------------------------------------------------- list input */

interface ListInputProps {
  values: string[];
  onChange: (next: string[]) => void;
  id?: string;
  'aria-describedby'?: string;
}

function ListInput({ values, onChange, ...aria }: ListInputProps) {
  const [draft, setDraft] = useState('');

  function add() {
    const trimmed = draft.trim();
    if (!trimmed || values.includes(trimmed)) {
      setDraft('');
      return;
    }
    onChange([...values, trimmed]);
    setDraft('');
  }

  return (
    <div className="stack-2">
      <div className="row-attached">
        <Input
          {...aria}
          value={draft}
          placeholder="Ajouter puis Entrée"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button variant="secondary" onClick={add} disabled={!draft.trim()}>
          Ajouter
        </Button>
      </div>
      {values.length > 0 && (
        <ul className="token-list">
          {values.map((entry) => (
            <li key={entry}>
              <span>{entry}</span>
              <button
                type="button"
                aria-label={`Retirer ${entry}`}
                onClick={() => onChange(values.filter((candidate) => candidate !== entry))}
              >
                &times;
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
