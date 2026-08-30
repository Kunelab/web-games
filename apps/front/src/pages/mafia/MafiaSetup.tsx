import { SETUPS, SLOT_TOKENS, ROLES } from 'mafia-core';
import { msg } from 'i18n';
import { useState } from 'react';
import QRCode from 'react-qr-code';
import { useNavigate } from 'react-router';

import { api } from '../../api/client';
import { useAsync } from '../../hooks/useAsync';
import { Button, Field, Input, Select } from '../../ui';
import { PublicSwitch } from '../../ui/PublicSwitch';
import { useT } from '../../i18n/locale-context';
import './mafia.css';

/**
 * Where a Mafia table is opened: clock settings, then the setup — a proposed
 * template, one of the account's ten saved slot lists, the balanced automatic
 * roster, or pure chaos. The creator is a player like the others: this screen
 * pockets the host token and sends the browser straight to a seat.
 */

/**
 * The clock and reveal options, as value/key pairs.
 *
 * Keys rather than words: a `<Select>` wants strings, so the words are resolved
 * at render against the reader's own catalogue rather than baked in here.
 */
const DAY_CHOICES = [
  { value: '90000', key: 'mafia.setup.day90' },
  { value: '120000', key: 'mafia.setup.day120' },
  { value: '180000', key: 'mafia.setup.day180' }
];

const NIGHT_CHOICES = [
  { value: '30000', key: 'mafia.setup.night30' },
  { value: '45000', key: 'mafia.setup.night45' },
  { value: '60000', key: 'mafia.setup.night60' }
];

/**
 * What a corpse gives away. The middle setting is the interesting one: naming the
 * camp keeps the game's shape while making a Coroner worth a seat.
 */
const REVEAL_CHOICES = [
  { value: 'role', key: 'mafia.setup.reveal.role' },
  { value: 'faction', key: 'mafia.setup.reveal.faction' },
  { value: 'none', key: 'mafia.setup.reveal.none' }
];

type SetupChoice =
  | { mode: 'auto' }
  | { mode: 'chaos' }
  | { mode: 'preset'; presetId: string }
  | { mode: 'custom'; slots: string[] };

/**
 * The catalogue key that names a slot: the role, or the category.
 *
 * This used to be a second, French-only table of category names living beside
 * the one in `roles.ts` — two lists of the same thing, drifting apart, neither
 * translated. Both are keys now, and the seat screen's role list renders the
 * identical ones.
 */
function tokenKey(token: string): string {
  return token in ROLES ? `mafia.role.${token}.name` : `mafia.slot.${token}`;
}

/** `<Select>` wants words; the tables above hold keys. */
function useOptionLabels(t: (key: string) => string) {
  return (choices: { value: string; key: string }[]) =>
    choices.map((choice) => ({ value: choice.value, label: t(choice.key) }));
}

export default function MafiaSetup() {
  const navigate = useNavigate();
  const t = useT();
  const tk = (key: string, params?: Record<string, string | number>) => t(msg(key, params));
  const tokenLabel = (token: string) => tk(tokenKey(token));
  const labelled = useOptionLabels(tk);
  const [dayMs, setDayMs] = useState('120000');
  const [nightMs, setNightMs] = useState('45000');
  const [revealOnDeath, setRevealOnDeath] = useState('role');
  const [tab, setTab] = useState<'proposes' | 'miens'>('proposes');
  const [choice, setChoice] = useState<SetupChoice>({ mode: 'auto' });
  const [draftSlots, setDraftSlots] = useState<string[]>([]);
  const [draftName, setDraftName] = useState('');
  const [isPublic, setIsPublic] = useState(false);
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
        setup: choice,
        public: isPublic
      });
      sessionStorage.setItem(`mafia:host:${session.code}`, session.hostToken);
      setCreated(session);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : tk('mafia.setup.createFailed'));
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
      setError(caught instanceof Error ? caught.message : tk('mafia.setup.saveFailed'));
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
      ? tk('mafia.setup.auto.name')
      : choice.mode === 'chaos'
        ? tk('mafia.setup.chaos.name')
        : choice.mode === 'preset'
          ? tk(`mafia.setup.preset.${choice.presetId}.name`)
          : tk('mafia.setup.custom', { count: choice.slots.length });

  return (
    <div className="stack-4">
      <h1 className="page-title">{tk('mafia.ui.title')}</h1>
      <p className="page-sub">{tk('mafia.setup.pitch')}</p>

      {mine.data && mine.data.length > 0 && !created && (
        <section className="mz-mine">
          {mine.data.map((table) => (
            <Button key={table.code} variant="ghost" onClick={() => reattach(table.code, table.hostToken)}>
              {tk('mafia.setup.resume', {
                code: table.code,
                players: table.players,
                phase: tk(`mafia.ui.phaseName.${table.phase}`)
              })}
            </Button>
          ))}
        </section>
      )}

      {!created ? (
        <>
          <section className="mz-setup-form">
            <Field label={tk('mafia.setup.dayPace')}>
              {({ id }) => <Select id={id} value={dayMs} onValueChange={setDayMs} options={labelled(DAY_CHOICES)} />}
            </Field>
            <Field label={tk('mafia.setup.nightPace')}>
              {({ id }) => (
                <Select id={id} value={nightMs} onValueChange={setNightMs} options={labelled(NIGHT_CHOICES)} />
              )}
            </Field>
            <Field label={tk('mafia.setup.revealLabel')}>
              {({ id }) => (
                <Select
                  id={id}
                  value={revealOnDeath}
                  onValueChange={setRevealOnDeath}
                  options={labelled(REVEAL_CHOICES)}
                />
              )}
            </Field>
            <p className="mz-hint">{tk('mafia.setup.revealHint')}</p>
          </section>

          {/* ------------------------------ setups ------------------------------ */}
          <section className="mz-templates">
            <div className="mz-tabs">
              <button
                type="button"
                className={tab === 'proposes' ? 'mz-tab mz-tab--active' : 'mz-tab'}
                onClick={() => setTab('proposes')}
              >
                {tk('mafia.setup.tab.proposed')}
              </button>
              <button
                type="button"
                className={tab === 'miens' ? 'mz-tab mz-tab--active' : 'mz-tab'}
                onClick={() => setTab('miens')}
              >
                {tk('mafia.setup.tab.mine', { count: templates.data?.length ?? 0 })}
              </button>
            </div>

            {tab === 'proposes' && (
              <div className="mz-template-list">
                <button
                  type="button"
                  className={choice.mode === 'auto' ? 'mz-template mz-template--active' : 'mz-template'}
                  onClick={() => setChoice({ mode: 'auto' })}
                >
                  <strong>{tk('mafia.setup.auto.name')}</strong>
                  <span>{tk('mafia.setup.auto.desc')}</span>
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
                    <strong>{tk(`mafia.setup.preset.${setup.id}.name`)}</strong>
                    <span>{tk(`mafia.setup.preset.${setup.id}.desc`)}</span>
                  </button>
                ))}
                <button
                  type="button"
                  className={choice.mode === 'chaos' ? 'mz-template mz-template--active' : 'mz-template'}
                  onClick={() => setChoice({ mode: 'chaos' })}
                >
                  <strong>{tk('mafia.setup.chaos.name')}</strong>
                  <span>{tk('mafia.setup.chaos.desc')}</span>
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
                        {tk('mafia.setup.seatsSummary', {
                          count: template.slots.length,
                          roles:
                            template.slots.slice(0, 5).map(tokenLabel).join(', ') +
                            (template.slots.length > 5 ? '…' : '')
                        })}
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
                        title={tk('mafia.setup.remove')}
                        onClick={() => setDraftSlots((slots) => slots.filter((_, i) => i !== index))}
                      >
                        {tokenLabel(token)} ✕
                      </button>
                    ))}
                    {draftSlots.length === 0 && <span className="mz-hint">{tk('mafia.setup.emptyDraft')}</span>}
                  </div>
                  <Select
                    value=""
                    placeholder={tk('mafia.setup.addSeat', { count: draftSlots.length })}
                    onValueChange={(token) => {
                      if (draftSlots.length < 24) setDraftSlots((slots) => [...slots, token]);
                    }}
                    options={SLOT_TOKENS.map((token) => ({ value: token, label: tokenLabel(token) }))}
                  />
                  <div className="mz-template-actions">
                    <Field label={tk('mafia.setup.templateName')}>
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
                      {tk('mafia.setup.save')}
                    </Button>
                    <Button
                      onClick={() => setChoice({ mode: 'custom', slots: draftSlots })}
                      disabled={draftSlots.length < 4}
                    >
                      {tk('mafia.setup.useTemplate')}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </section>

          <section className="mz-setup-form">
            <PublicSwitch what={tk('mafia.setup.thisTable')} value={isPublic} onChange={setIsPublic} />
            <p className="mz-hint">
              {tk('mafia.setup.chosen')} <strong>{choiceLabel}</strong>
            </p>
            <Button onClick={() => void create()} busy={busy}>
              {tk('mafia.setup.open')}
            </Button>
            {error && <p className="mz-error">{error}</p>}
          </section>
        </>
      ) : (
        <section className="mz-created">
          <p>{tk('mafia.setup.created', { code: created.code })}</p>
          <div className="mz-qr">
            <QRCode value={joinUrl} size={140} />
          </div>
          <p className="mz-join-url">{joinUrl}</p>
          <Button onClick={() => void navigate(`/mafia/rejoindre/${created.code}`)}>{tk('mafia.setup.goSit')}</Button>

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
              <strong>{tk('mafia.setup.tvTitle')}</strong> {tk('mafia.setup.tvPitch')}
            </p>
            <div className="mz-qr">
              <QRCode value={tvUrl} size={110} />
            </div>
            <p className="mz-join-url">{tvUrl}</p>
            <Button variant="ghost" onClick={() => window.open(tvUrl, '_blank', 'noopener')}>
              {tk('mafia.setup.openTv')}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
