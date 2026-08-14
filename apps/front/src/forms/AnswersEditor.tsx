import { ANSWER_TOLERANCE, maxFieldPoints, toleranceName, type AnswerField, type AnswerToleranceName } from 'game-core';
import { useState } from 'react';

import { Button, Field, IconButton, Input, Select, Switch } from '../ui';
import './forms.css';

/**
 * Editor for a media item's scorable answers.
 *
 * This is the surface the whole scoring model rests on, so it is deliberately
 * explicit: each field shows what it is worth, and the running total tells the host
 * how much the round is worth before they ever play it. The old editor had "title"
 * and "artist" as two hardcoded text inputs with no notion of points at all.
 */

export interface AnswersEditorProps {
  answers: AnswerField[];
  onChange: (next: AnswerField[]) => void;
  /** Free-text kinds ask for anything on the panel, so labels matter less. */
  hint?: string;
}

/**
 * Keys are generated once and never touched again.
 *
 * They used to follow the label, which looked helpful and was three bugs: React
 * saw a new component on every keystroke and the input lost focus mid-word; two
 * fields labelled the same produced the same key and the save failed on the
 * server's uniqueness check; and renaming "Titre" broke the YouTube lookup, which
 * finds the field to fill by its key. Nothing shows a key to anyone, so nothing is
 * lost by leaving it alone.
 */
function nextKey(answers: AnswerField[]): string {
  const taken = new Set(answers.map((answer) => answer.key));

  let position = answers.length + 1;
  while (taken.has(`champ_${position}`)) {
    position += 1;
  }

  return `champ_${position}`;
}

function blankAnswer(answers: AnswerField[]): AnswerField {
  return {
    key: nextKey(answers),
    label: '',
    value: '',
    aliases: [],
    points: 1,
    tolerance: ANSWER_TOLERANCE.normal,
    directBonus: 0
  };
}

export function AnswersEditor({ answers, onChange, hint }: AnswersEditorProps) {
  function update(index: number, patch: Partial<AnswerField>) {
    onChange(answers.map((answer, position) => (position === index ? { ...answer, ...patch } : answer)));
  }

  function remove(index: number) {
    onChange(answers.filter((_, position) => position !== index));
  }

  function add() {
    onChange([...answers, blankAnswer(answers)]);
  }

  return (
    <div className="stack-4">
      {hint && <p className="field-hint">{hint}</p>}

      <div className="answers">
        {answers.map((answer, index) => (
          <AnswerCard
            key={answer.key}
            answer={answer}
            onChange={(patch) => update(index, patch)}
            onRemove={() => remove(index)}
          />
        ))}
      </div>

      {answers.length === 0 && (
        <p className="field-hint">
          Aucune réponse : ce média ne pourra pas être joué tant qu’il n’y en a pas au moins une.
        </p>
      )}

      <div className="answer-total">
        <Button variant="secondary" size="sm" onClick={add}>
          Ajouter une réponse
        </Button>
        <span>
          Total du tour : <strong>{maxFieldPoints(answers)}</strong> points
        </span>
      </div>
    </div>
  );
}

interface AnswerCardProps {
  answer: AnswerField;
  onChange: (patch: Partial<AnswerField>) => void;
  onRemove: () => void;
}

const TOLERANCE_OPTIONS: Array<{ value: AnswerToleranceName; label: string }> = [
  { value: 'exact', label: 'Exacte' },
  { value: 'normal', label: 'Normale' },
  { value: 'loose', label: 'Souple' }
];

/** What the matcher will actually forgive, said plainly for the host. */
function toleranceHint(answer: AnswerField): string {
  const digits = /\d/.test(answer.value);

  switch (toleranceName(answer.tolerance)) {
    case 'exact':
      return 'Doit être écrit exactement, à la casse, aux accents et à la ponctuation près.';
    case 'loose':
      return digits
        ? 'Les chiffres restent exacts. Le reste est très permissif.'
        : 'Très permissif : plusieurs fautes, l’orthographe phonétique, les lettres inversées.';
    default:
      return digits
        ? 'Les chiffres doivent être exacts. Le reste tolère la casse, les accents et une faute.'
        : 'Casse, accents et ponctuation ignorés. Une faute par mot un peu long, les lettres inversées et l’orthographe phonétique sont tolérées.';
  }
}

/** Aliases are stored as a list but typed as one line, hence the two forms. */
function parseAliases(text: string): string[] {
  return text
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function AnswerCard({ answer, onChange, onRemove }: AnswerCardProps) {
  const hasChoices = Boolean(answer.choices?.length);

  /**
   * The alias line is held as text while it is being edited.
   *
   * Rendering `aliases.join(', ')` straight back was a trap: typing a comma parsed
   * to a list with one entry, which rendered without the comma, which deleted the
   * character as it was typed. The separator was unreachable and so was every alias
   * after the first. Same reason the mm:ss inputs keep a draft.
   */
  const [aliasDraft, setAliasDraft] = useState<string | null>(null);

  return (
    <div className="answer-card">
      <div className="answer-head">
        <div className="grow">
          <Field label="Intitulé" hint="Optionnel. Vide, rien n’est demandé au joueur : il cite ce qu’il voit.">
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                value={answer.label}
                placeholder="Titre, Artiste, Année…"
                onChange={(event) => onChange({ label: event.target.value })}
              />
            )}
          </Field>
        </div>
        <div className="answer-points">
          <Field label="Points">
            {({ id }) => (
              <Input
                id={id}
                type="number"
                min={0}
                max={100}
                value={answer.points}
                onChange={(event) => onChange({ points: Math.max(0, Number(event.target.value)) })}
              />
            )}
          </Field>
        </div>
        <IconButton icon={<TrashIcon />} label={`Supprimer ${answer.label || 'cette réponse'}`} onClick={onRemove} />
      </div>

      <div className="answer-row">
        <div className="grow">
          <Field label="Bonne réponse" hint={toleranceHint(answer)}>
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                value={answer.value}
                onChange={(event) => onChange({ value: event.target.value })}
              />
            )}
          </Field>
        </div>
        <div className="answer-strictness">
          <Field label="Exigence">
            {({ id }) => (
              <Select
                id={id}
                value={toleranceName(answer.tolerance)}
                options={TOLERANCE_OPTIONS}
                onValueChange={(next) =>
                  onChange({ tolerance: ANSWER_TOLERANCE[next as AnswerToleranceName] ?? ANSWER_TOLERANCE.normal })
                }
              />
            )}
          </Field>
        </div>
      </div>

      <Field
        label="Autres formulations acceptées"
        hint="Séparées par une virgule. Pour les vrais autres noms, pas les fautes de frappe."
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            value={aliasDraft ?? answer.aliases.join(', ')}
            placeholder="Die Aerzte, Aerzte"
            onChange={(event) => {
              setAliasDraft(event.target.value);
              onChange({ aliases: parseAliases(event.target.value) });
            }}
            // Leaving the field hands it back to the stored list, which tidies up
            // spacing and stray separators.
            onBlur={() => setAliasDraft(null)}
          />
        )}
      </Field>

      <Switch
        label="Proposer des choix"
        hint="Le joueur peut répondre à l’aveugle pour plus de points, ou révéler les choix pour moins."
        checked={hasChoices}
        onCheckedChange={(checked) =>
          onChange(
            checked
              ? { choices: [answer.value || '', '', '', ''].slice(0, 4), directBonus: answer.points }
              : { choices: undefined, directBonus: 0 }
          )
        }
      />

      {hasChoices && (
        <div className="stack-3">
          <Field label="Choix proposés" hint="La bonne réponse doit figurer à l’identique dans la liste.">
            {({ id, describedBy }) => (
              <div className="stack-2" id={id} aria-describedby={describedBy}>
                {(answer.choices ?? []).map((choice, index) => (
                  <div className="row-attached" key={index}>
                    <Input
                      value={choice}
                      placeholder={`Choix ${index + 1}`}
                      onChange={(event) => {
                        const next = [...(answer.choices ?? [])];
                        next[index] = event.target.value;
                        onChange({ choices: next });
                      }}
                    />
                    <IconButton
                      icon={<TrashIcon />}
                      label={`Retirer le choix ${index + 1}`}
                      onClick={() => onChange({ choices: (answer.choices ?? []).filter((_, p) => p !== index) })}
                    />
                  </div>
                ))}
                {(answer.choices?.length ?? 0) < 8 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onChange({ choices: [...(answer.choices ?? []), ''] })}
                  >
                    Ajouter un choix
                  </Button>
                )}
              </div>
            )}
          </Field>

          <Field label="Bonus réponse directe" hint="Points supplémentaires si le joueur ne révèle pas les choix.">
            {({ id }) => (
              <Input
                id={id}
                type="number"
                min={0}
                max={100}
                value={answer.directBonus}
                onChange={(event) => onChange({ directBonus: Math.max(0, Number(event.target.value)) })}
              />
            )}
          </Field>
        </div>
      )}
    </div>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
