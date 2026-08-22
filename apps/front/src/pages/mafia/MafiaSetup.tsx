import { SETUPS, SLOT_TOKENS, roleDef, ROLES, type RoleId } from 'mafia-core';
import { useState } from 'react';
import QRCode from 'react-qr-code';
import { useNavigate } from 'react-router';

import { api } from '../../api/client';
import { useAsync } from '../../hooks/useAsync';
import { Button, Field, Input, Select } from '../../ui';
import './mafia.css';

/**
 * Where a Mafia table is opened: clock settings, then the setup — a proposed
 * template, one of the account's ten saved slot lists, the balanced automatic
 * roster, or pure chaos. The creator is a player like the others: this screen
 * pockets the host token and sends the browser straight to a seat.
 */

const DAY_CHOICES = [
  { value: '90000', label: 'Jour : 1 min 30' },
  { value: '120000', label: 'Jour : 2 min' },
  { value: '180000', label: 'Jour : 3 min' }
];

const NIGHT_CHOICES = [
  { value: '30000', label: 'Nuit : 30 s' },
  { value: '45000', label: 'Nuit : 45 s' },
  { value: '60000', label: 'Nuit : 1 min' }
];

/**
 * What a corpse gives away. The middle setting is the interesting one: naming the
 * camp keeps the game's shape while making a Coroner worth a seat.
 */
const REVEAL_CHOICES = [
  { value: 'role', label: 'À la mort : rôle complet' },
  { value: 'faction', label: 'À la mort : camp seulement' },
  { value: 'none', label: 'À la mort : rien du tout' }
];

type SetupChoice =
  | { mode: 'auto' }
  | { mode: 'chaos' }
  | { mode: 'preset'; presetId: string }
  | { mode: 'custom'; slots: string[] };

/** Human label for a slot token: role name, or the category in French. */
function tokenLabel(token: string): string {
  if (token in ROLES) return roleDef(token as RoleId).name;
  const labels: Record<string, string> = {
    'town-core': 'Ville (base)',
    'town-investigative': 'Ville (enquête)',
    'town-protective': 'Ville (protection)',
    'town-killing': 'Ville (armée)',
    'town-power': 'Ville (pouvoir)',
    'town-random': 'Ville (hasard)',
    'mafia-support': 'Mafia (soutien)',
    'mafia-deception': 'Mafia (tromperie)',
    'mafia-random': 'Mafia (hasard)',
    'neutral-benign': 'Neutre (bénin)',
    'neutral-evil': 'Neutre (maléfique)',
    'neutral-killing': 'Neutre (tueur)',
    'neutral-random': 'Neutre (hasard)',
    any: 'N’importe quoi'
  };
  return labels[token] ?? token;
}

export default function MafiaSetup() {
  const navigate = useNavigate();
  const [dayMs, setDayMs] = useState('120000');
  const [nightMs, setNightMs] = useState('45000');
  const [revealOnDeath, setRevealOnDeath] = useState('role');
  const [tab, setTab] = useState<'proposes' | 'miens'>('proposes');
  const [choice, setChoice] = useState<SetupChoice>({ mode: 'auto' });
  const [draftSlots, setDraftSlots] = useState<string[]>([]);
  const [draftName, setDraftName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ code: string; hostToken: string } | null>(null);

  const mine = useAsync(() => api.mafiaMine(), []);
  const templates = useAsync(() => api.mafiaTemplates(), []);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const session = await api.mafiaCreate({
        dayMs: Number(dayMs),
        nightMs: Number(nightMs),
        revealOnDeath: revealOnDeath as 'role' | 'faction' | 'none',
        setup: choice
      });
      sessionStorage.setItem(`mafia:host:${session.code}`, session.hostToken);
      setCreated(session);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Création impossible');
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    if (!draftName.trim() || draftSlots.length < 4) return;
    setError(null);
    try {
      await api.mafiaSaveTemplate(draftName.trim(), draftSlots);
      templates.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sauvegarde impossible');
    }
  }

  function reattach(code: string, hostToken: string) {
    sessionStorage.setItem(`mafia:host:${code}`, hostToken);
    void navigate(`/mafia/rejoindre/${code}`);
  }

  const joinUrl = created ? `${window.location.origin}/mafia/rejoindre/${created.code}` : '';
  const tvUrl = created ? `${window.location.origin}/mafia/tv/${created.code}` : '';

  const choiceLabel =
    choice.mode === 'auto'
      ? 'Équilibré automatique'
      : choice.mode === 'chaos'
        ? '🎲 Chaos total'
        : choice.mode === 'preset'
          ? (SETUPS.find((setup) => setup.id === choice.presetId)?.name ?? choice.presetId)
          : `Personnalisé (${choice.slots.length} sièges)`;

  return (
    <div className="stack-4">
      <h1 className="page-title">Mafia</h1>
      <p className="page-sub">
        Jusqu’à 24 joueurs autour de la place du village. La ville cherche ses tueurs ; les tueurs jurent qu’ils sont
        innocents. Gratuit, et pour toujours.
      </p>

      {mine.data && mine.data.length > 0 && !created && (
        <section className="mz-mine">
          {mine.data.map((table) => (
            <Button key={table.code} variant="ghost" onClick={() => reattach(table.code, table.hostToken)}>
              Reprendre la table {table.code} ({table.players} joueurs, {table.phase})
            </Button>
          ))}
        </section>
      )}

      {!created ? (
        <>
          <section className="mz-setup-form">
            <Field label="Rythme des journées">
              {({ id }) => <Select id={id} value={dayMs} onValueChange={setDayMs} options={DAY_CHOICES} />}
            </Field>
            <Field label="Rythme des nuits">
              {({ id }) => <Select id={id} value={nightMs} onValueChange={setNightMs} options={NIGHT_CHOICES} />}
            </Field>
            <Field label="Révélation des rôles">
              {({ id }) => (
                <Select id={id} value={revealOnDeath} onValueChange={setRevealOnDeath} options={REVEAL_CHOICES} />
              )}
            </Field>
            <p className="mz-hint">
              Un corps nettoyé par le Nettoyeur reste anonyme dans tous les cas, et un visage emprunté ne trompe que les
              enquêteurs — la dépouille dit toujours ce que le joueur était vraiment.
            </p>
          </section>

          {/* ------------------------------ setups ------------------------------ */}
          <section className="mz-templates">
            <div className="mz-tabs">
              <button
                type="button"
                className={tab === 'proposes' ? 'mz-tab mz-tab--active' : 'mz-tab'}
                onClick={() => setTab('proposes')}
              >
                Modèles proposés
              </button>
              <button
                type="button"
                className={tab === 'miens' ? 'mz-tab mz-tab--active' : 'mz-tab'}
                onClick={() => setTab('miens')}
              >
                Mes modèles ({templates.data?.length ?? 0}/10)
              </button>
            </div>

            {tab === 'proposes' && (
              <div className="mz-template-list">
                <button
                  type="button"
                  className={choice.mode === 'auto' ? 'mz-template mz-template--active' : 'mz-template'}
                  onClick={() => setChoice({ mode: 'auto' })}
                >
                  <strong>Équilibré automatique</strong>
                  <span>Le serveur compose une table équilibrée selon le nombre de joueurs.</span>
                </button>
                {SETUPS.map((setup) => (
                  <button
                    key={setup.id}
                    type="button"
                    className={
                      choice.mode === 'preset' && choice.presetId === setup.id
                        ? 'mz-template mz-template--active'
                        : 'mz-template'
                    }
                    onClick={() => setChoice({ mode: 'preset', presetId: setup.id })}
                  >
                    <strong>{setup.name}</strong>
                    <span>{setup.description}</span>
                  </button>
                ))}
                <button
                  type="button"
                  className={choice.mode === 'chaos' ? 'mz-template mz-template--active' : 'mz-template'}
                  onClick={() => setChoice({ mode: 'chaos' })}
                >
                  <strong>🎲 Chaos total</strong>
                  <span>Chaque siège tire un rôle au hasard. Aucune promesse, aucun regret.</span>
                </button>
              </div>
            )}

            {tab === 'miens' && (
              <div className="mz-template-list">
                {(templates.data ?? []).map((template) => (
                  <div key={template.name} className="mz-template mz-template--saved">
                    <button
                      type="button"
                      className="mz-template-load"
                      onClick={() => {
                        setChoice({ mode: 'custom', slots: template.slots });
                        setDraftSlots(template.slots);
                        setDraftName(template.name);
                      }}
                    >
                      <strong>{template.name}</strong>
                      <span>
                        {template.slots.length} sièges — {template.slots.slice(0, 5).map(tokenLabel).join(', ')}
                        {template.slots.length > 5 ? '…' : ''}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void api.mafiaDeleteTemplate(template.name).then(() => templates.reload());
                      }}
                    >
                      🗑️
                    </Button>
                  </div>
                ))}

                {/* The editor: compose a slot list, save it, play it. */}
                <div className="mz-template-editor">
                  <div className="mz-chips">
                    {draftSlots.map((token, index) => (
                      <button
                        key={`${token}-${index}`}
                        type="button"
                        className="mz-chip"
                        title="Retirer"
                        onClick={() => setDraftSlots((slots) => slots.filter((_, i) => i !== index))}
                      >
                        {tokenLabel(token)} ✕
                      </button>
                    ))}
                    {draftSlots.length === 0 && <span className="mz-hint">Ajoutez des sièges ci-dessous.</span>}
                  </div>
                  <Select
                    value=""
                    placeholder={`Ajouter un siège (${draftSlots.length}/24)`}
                    onValueChange={(token) => {
                      if (draftSlots.length < 24) setDraftSlots((slots) => [...slots, token]);
                    }}
                    options={SLOT_TOKENS.map((token) => ({ value: token, label: tokenLabel(token) }))}
                  />
                  <div className="mz-template-actions">
                    <Field label="Nom du modèle">
                      {({ id }) => (
                        <Input
                          id={id}
                          value={draftName}
                          onChange={(event) => setDraftName(event.target.value)}
                          maxLength={30}
                        />
                      )}
                    </Field>
                    <Button variant="ghost" onClick={() => void saveDraft()} disabled={!draftName.trim() || draftSlots.length < 4}>
                      💾 Sauvegarder
                    </Button>
                    <Button
                      onClick={() => setChoice({ mode: 'custom', slots: draftSlots })}
                      disabled={draftSlots.length < 4}
                    >
                      Utiliser ce modèle
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </section>

          <section className="mz-setup-form">
            <p className="mz-hint">
              Distribution choisie : <strong>{choiceLabel}</strong>
            </p>
            <Button onClick={() => void create()} busy={busy}>
              Ouvrir une table
            </Button>
            {error && <p className="mz-error">{error}</p>}
          </section>
        </>
      ) : (
        <section className="mz-created">
          <p>
            Table <strong>{created.code}</strong> ouverte. Les joueurs rejoignent avec ce code ou ce QR :
          </p>
          <div className="mz-qr">
            <QRCode value={joinUrl} size={140} />
          </div>
          <p className="mz-join-url">{joinUrl}</p>
          <Button onClick={() => void navigate(`/mafia/rejoindre/${created.code}`)}>Prendre place à ma table</Button>

          {/**
           * The television, offered and never assumed.
           *
           * A table is normally played apart, so this is the "we are all in the
           * same room" extra: its own link, opened on whatever screen the room
           * has. It takes no seat and plays nothing, and it starts with every role
           * hidden — a big shared screen is the one place a leak reaches everybody
           * at once.
           */}
          <div className="mz-tv-offer">
            <p className="mz-hint">
              <strong>Dans la même pièce ?</strong> Ouvrez la ville en grand sur une télé ou un PC. Cet écran ne joue
              pas, ne prend pas de siège, et démarre sans révéler aucun rôle.
            </p>
            <div className="mz-qr">
              <QRCode value={tvUrl} size={110} />
            </div>
            <p className="mz-join-url">{tvUrl}</p>
            <Button variant="ghost" onClick={() => window.open(tvUrl, '_blank', 'noopener')}>
              📺 Ouvrir l’écran de la ville
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
