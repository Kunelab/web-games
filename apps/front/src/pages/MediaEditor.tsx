import {
  ANSWER_TOLERANCE,
  mediaReadiness,
  normalizeAnswer,
  type AnswerField,
  type KindTiming
} from 'game-core';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import {
  api,
  ApiError,
  type KindDescriptor,
  type MediaItem,
  type PanelItem,
  type YoutubeMetadata
} from '../api/client';
import { kindColor } from '../app/kinds';
import { AnswersEditor } from '../forms/AnswersEditor';
import { PayloadFields } from '../forms/PayloadFields';
import { useAsync } from '../hooks/useAsync';
import { Badge, Button, Field, Input, Loading } from '../ui';
import './library.css';

/**
 * One editor for every media kind.
 *
 * The payload half is generated from the kind's own field metadata, so this file has
 * no idea what a blind test or a quiz contains. Adding a kind means adding a file in
 * game-core; nothing here changes.
 *
 * It is also a real route, `/bibliotheque/:id`, which is the fix for the old editor:
 * that one lived in the list page's state, so the back button did nothing and a
 * refresh threw the work away.
 */
export default function MediaEditor() {
  const { id } = useParams<{ id: string }>();
  const mediaId = id === undefined ? null : Number(id);

  const kinds = useAsync(() => api.kinds(), []);
  const existing = useAsync(
    () => (mediaId === null ? Promise.resolve(null) : api.getMedia(mediaId)),
    [mediaId]
  );

  if (kinds.loading || existing.loading) {
    return <Loading />;
  }

  if (existing.error) {
    return (
      <>
        <Link to="/bibliotheque" className="backlink">
          ← Bibliothèque
        </Link>
        <p className="field-error">{existing.error}</p>
      </>
    );
  }

  // Keyed on the item, so arriving data mounts a fresh form whose state is seeded
  // from props. That replaces copying the loaded item into state inside an effect,
  // which cost an extra render and a frame of empty inputs.
  return (
    <Editor
      key={existing.data?.id ?? 'new'}
      item={existing.data ?? null}
      kinds={kinds.data ?? []}
      mediaId={mediaId}
    />
  );
}

interface EditorProps {
  item: MediaItem | null;
  kinds: KindDescriptor[];
  mediaId: number | null;
}

function Editor({ item, kinds, mediaId }: EditorProps) {
  const navigate = useNavigate();

  const [kind, setKind] = useState<string | null>(item?.kind ?? null);
  const [title, setTitle] = useState(item?.title ?? '');
  const [category, setCategory] = useState(item?.category ?? '');
  const [date, setDate] = useState(item?.date ?? '');
  const [answers, setAnswers] = useState<AnswerField[]>(item?.answers ?? []);
  const [payload, setPayload] = useState<Record<string, unknown>>(
    (item?.payload ?? {}) as Record<string, unknown>
  );
  const [timing, setTiming] = useState<KindTiming | null>(item?.timing ?? null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const descriptor = kinds.find((candidate) => candidate.id === kind);

  /** Choosing a kind seeds its defaults, so the form is never blank. */
  function chooseKind(next: KindDescriptor) {
    setKind(next.id);
    setPayload({ ...(next.defaultPayload as Record<string, unknown>) });
    setAnswers(next.defaultAnswers.map((answer) => ({ ...answer })));
    setTiming(null);
  }

  /**
   * Fills what YouTube knows, without overwriting what the host already wrote.
   * A lookup should feel like help, not like losing your edits.
   */
  function applyYoutube(metadata: YoutubeMetadata) {
    if (!title.trim()) {
      setTitle(metadata.rawTitle.slice(0, 200));
    }

    setAnswers((current) =>
      current.map((answer) => {
        if (answer.value.trim()) return answer;

        switch (answerRole(answer)) {
          case 'title':
            return metadata.title ? { ...answer, value: metadata.title } : answer;
          case 'artist': {
            const artist = metadata.artist || metadata.channel;
            return artist ? { ...answer, value: artist } : answer;
          }
          case 'year':
            return metadata.year ? { ...answer, value: metadata.year } : answer;
          default:
            return answer;
        }
      })
    );

    if (!date && metadata.year) {
      setDate(`${metadata.year}-01-01`);
    }
  }

  /**
   * A generated panel replaces both halves of the item at once.
   *
   * The two lists are matched by index, which is what lets a host drop a cell they
   * do not like and have its answer go with it. Labels are left empty: there is no
   * question here, only a grid to name, and "Élément 1" is not a prompt, it is a row
   * number pretending to be one.
   */
  function applyPanel(items: PanelItem[]) {
    setPayload((current) => ({ ...current, cells: items.map((item) => item.imageUrl) }));
    setAnswers(
      items.map((item, index) => ({
        key: `item_${index + 1}`,
        label: '',
        value: item.label,
        aliases: item.aliases,
        points: 1,
        tolerance: ANSWER_TOLERANCE.normal,
        directBonus: 0
      }))
    );
  }

  function removePanelCell(index: number) {
    setPayload((current) => ({
      ...current,
      cells: (Array.isArray(current.cells) ? current.cells : []).filter((_, position) => position !== index)
    }));
    setAnswers((current) => current.filter((_, position) => position !== index));
  }

  async function save() {
    if (!kind) return;

    setSaving(true);
    setError(null);
    setFieldErrors({});

    const body = {
      kind,
      title: title.trim() || 'Sans titre',
      category: category.trim() || null,
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
      answers,
      payload,
      timing
    };

    try {
      const saved = mediaId === null ? await api.createMedia(body) : await api.updateMedia(mediaId, body);
      // Creating navigates to the item's own address, so the next refresh or back
      // press lands somewhere real.
      void navigate(`/bibliotheque/${saved.id}`, { replace: true });
    } catch (cause) {
      if (cause instanceof ApiError) {
        setError(cause.message);
        setFieldErrors(extractFieldErrors(cause.details));
      } else {
        setError("L'enregistrement a échoué.");
      }
    } finally {
      setSaving(false);
    }
  }

  // Step one for a new item: pick what it is. The old form asked for every field
  // of every type at once.
  if (!kind) {
    return (
      <>
        <Link to="/bibliotheque" className="backlink">
          ← Bibliothèque
        </Link>
        <div className="page-head">
          <div>
            <h1 className="page-title">Nouveau média</h1>
            <p className="page-sub">Quel genre de chose faut-il deviner ?</p>
          </div>
        </div>
        <div className="kind-picker">
          {kinds.map((option) => (
            <button
              key={option.id}
              type="button"
              className="kind-option"
              style={{ borderLeftColor: kindColor(option.id) }}
              onClick={() => chooseKind(option)}
            >
              <span className="icon" aria-hidden="true">
                {option.icon}
              </span>
              <span className="name">{option.label.fr}</span>
              <span className="desc">{option.description.fr}</span>
            </button>
          ))}
        </div>
      </>
    );
  }

  const readiness = mediaReadiness({ kind, answers, payload });

  return (
    <>
      <Link to="/bibliotheque" className="backlink">
        ← Bibliothèque
      </Link>

      <div className="page-head">
        <div>
          <h1 className="page-title">{mediaId === null ? 'Nouveau média' : title || 'Sans titre'}</h1>
          <p className="page-sub">{descriptor?.label.fr}</p>
        </div>
      </div>

      {error && (
        <p className="field-error" style={{ marginBottom: 'var(--space-4)' }}>
          {error}
        </p>
      )}

      <div className="editor-layout">
        <div className="stack-5">
          <section className="editor-section">
            <h2 className="editor-section-title">Contenu</h2>
            {descriptor && (
              <PayloadFields
                fields={descriptor.formFields}
                value={payload}
                onChange={setPayload}
                errors={fieldErrors}
                onYoutubeMetadata={applyYoutube}
                panel={{
                  labels: answers.map((answer) => answer.value),
                  onGenerated: applyPanel,
                  onRemoved: removePanelCell
                }}
              />
            )}
          </section>

          <section className="editor-section">
            <h2 className="editor-section-title">Réponses et points</h2>
            <AnswersEditor
              answers={answers}
              onChange={setAnswers}
              hint={
                kind === 'image-memory'
                  ? 'Une réponse par élément à retrouver. Le joueur cite ce qu’il veut, le serveur devine de quel élément il parle.'
                  : undefined
              }
            />
          </section>
        </div>

        <div className="stack-5">
          <section className="editor-section">
            <h2 className="editor-section-title">Classement</h2>

            <Field label="Titre interne" hint="Pour retrouver ce média. Jamais montré aux joueurs.">
              {({ id: fieldId, describedBy }) => (
                <Input
                  id={fieldId}
                  aria-describedby={describedBy}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              )}
            </Field>

            <Field label="Catégorie" hint="Libre : « années 80 », « cinéma »…">
              {({ id: fieldId, describedBy }) => (
                <Input
                  id={fieldId}
                  aria-describedby={describedBy}
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                />
              )}
            </Field>

            <Field label="Date" hint="Sert au mode chronologique.">
              {({ id: fieldId, describedBy }) => (
                <Input
                  id={fieldId}
                  aria-describedby={describedBy}
                  type="date"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                />
              )}
            </Field>
          </section>

          {descriptor && (
            <section className="editor-section">
              <h2 className="editor-section-title">Minutage</h2>
              <p className="field-hint">
                Par défaut : {Math.round(descriptor.defaultTiming.answerMs / 1000)} s pour répondre,{' '}
                {Math.round(descriptor.defaultTiming.revealMs / 1000)} s de révélation.
              </p>
              {timing === null ? (
                <Button variant="secondary" size="sm" onClick={() => setTiming({ ...descriptor.defaultTiming })}>
                  Personnaliser pour ce média
                </Button>
              ) : (
                <div className="stack-3">
                  <Field label="Temps de réponse">
                    {({ id: fieldId }) => (
                      <div className="input-suffixed">
                        <Input
                          id={fieldId}
                          type="number"
                          min={3}
                          max={600}
                          value={Math.round(timing.answerMs / 1000)}
                          onChange={(event) =>
                            setTiming({ ...timing, answerMs: Math.max(3, Number(event.target.value)) * 1000 })
                          }
                        />
                        <span className="input-suffix">secondes</span>
                      </div>
                    )}
                  </Field>
                  <Field label="Durée de révélation">
                    {({ id: fieldId }) => (
                      <div className="input-suffixed">
                        <Input
                          id={fieldId}
                          type="number"
                          min={0}
                          max={120}
                          value={Math.round(timing.revealMs / 1000)}
                          onChange={(event) =>
                            setTiming({ ...timing, revealMs: Math.max(0, Number(event.target.value)) * 1000 })
                          }
                        />
                        <span className="input-suffix">secondes</span>
                      </div>
                    )}
                  </Field>
                  <Button variant="ghost" size="sm" onClick={() => setTiming(null)}>
                    Revenir au réglage par défaut
                  </Button>
                </div>
              )}
            </section>
          )}
        </div>
      </div>

      <div className="editor-bar">
        <span className="readiness">
          {readiness.ready ? (
            <>
              <Badge tone="ok">prêt</Badge> Jouable en partie.
            </>
          ) : (
            <>
              <Badge tone="warn">brouillon</Badge> Il manque {readiness.missing.join(', ')}.
            </>
          )}
        </span>
        <div className="page-actions">
          <Button variant="ghost" onClick={() => void navigate('/bibliotheque')}>
            Retour
          </Button>
          <Button variant="primary" busy={saving} onClick={() => void save()}>
            Enregistrer
          </Button>
        </div>
      </div>
    </>
  );
}

/**
 * What a YouTube lookup can fill in.
 *
 * Keyed off the field's key first, which is what the kinds' own defaults carry, and
 * off its label otherwise: a host who adds a field for the year picks the label,
 * never the key, and the point of the lookup is that they do not have to type the
 * year at all.
 */
function answerRole(answer: AnswerField): 'title' | 'artist' | 'year' | null {
  const label = normalizeAnswer(answer.label);

  if (answer.key === 'title' || label === 'titre' || label === 'title') return 'title';
  if (answer.key === 'artist' || ['artiste', 'artist', 'groupe', 'interprete'].includes(label)) return 'artist';
  if (answer.key === 'year' || ['annee', 'year', 'date'].includes(label)) return 'year';

  return null;
}

/** Turns the server's Zod issue list into per-field messages. */
function extractFieldErrors(details: unknown): Record<string, string> {
  if (!Array.isArray(details)) return {};

  const result: Record<string, string> = {};
  for (const issue of details) {
    if (typeof issue !== 'object' || issue === null) continue;
    const { path, message } = issue as { path?: unknown; message?: unknown };
    if (!Array.isArray(path) || typeof message !== 'string') continue;

    const key = path.filter((part): part is string => typeof part === 'string').at(-1);
    if (key) {
      result[key] = message;
    }
  }
  return result;
}
