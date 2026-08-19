import {
  BIOMES,
  DIFFICULTY_PRESETS,
  defaultGameConfig,
  GM_CLASSES,
  GM_GLOBAL_PERKS,
  gmClassDef,
  gmLoadoutPerkDef,
  validGmLoadout,
  LAYOUTS,
  SCENARIO_LABELS,
  SCENARIOS,
  type GameConfig
} from 'coronaz-core';
import { useState } from 'react';
import QRCode from 'react-qr-code';
import { useNavigate } from 'react-router';

import { api, ApiError } from '../../api/client';
import { useAsync } from '../../hooks/useAsync';
import { buzzerOrigin } from '../../tools/api-url';
import { Badge, Button, Field, Input } from '../../ui';
import './coronaz.css';
import '../playlists.css';

/** The side quests a host may allow, and how to say them. */
/** Quests that can lock the exit. */
const OBJECTIVE_KINDS = [
  { id: 'boss' as const, emoji: '💀', label: 'Abattre un boss' },
  { id: 'kills' as const, emoji: '🧟', label: 'Quota de victimes' },
  { id: 'searches' as const, emoji: '🎒', label: 'Quota de fournitures' }
];

/** Quests that pay points and lock nothing, drawn from the same allow-list. */
const BONUS_KINDS = [
  { id: 'explore' as const, emoji: '🗺️', label: 'Explorer la carte' },
  { id: 'treasure' as const, emoji: '💎', label: 'Trouver une pièce épique' },
  { id: 'intact' as const, emoji: '🤝', label: 'Sortir au complet' },
  { id: 'speed' as const, emoji: '⏱️', label: 'Sortir vite' }
];

/**
 * Where a raid is configured and armed.
 *
 * Presets are starting points, not modes: applying one fills the dials and every
 * dial stays editable, so "cauchemar mais sur une petite carte" is a choice.
 */
export default function CoronaZSetup() {
  const navigate = useNavigate();
  const [config, setConfig] = useState<GameConfig>(defaultGameConfig);
  const [preset, setPreset] = useState('normal');
  const [seed, setSeed] = useState('');
  /** The GM's CoD pick: one signature perk + up to two globals, per game. */
  const [gmPerks, setGmPerks] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<{ code: string; hostToken: string; gmToken?: string } | null>(null);

  /** A raid already running under this account: the way back to its screens. */
  const mine = useAsync(() => api.czMine(), []);
  /** Two-step so a stray tap cannot bin a raid that is being played. */
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  /** The host's ledger: rations and which horde classes are already bought. */
  const me = useAsync(() => api.czMe(), []);

  function set<K extends keyof GameConfig>(key: K, value: GameConfig[K]) {
    setConfig((current) => ({ ...current, [key]: value }));
  }

  /** Bins one of my live raids. First tap asks, second one does it. */
  async function cancel(code: string) {
    if (confirmCancel !== code) {
      setConfirmCancel(code);
      return;
    }
    setCancelling(code);
    try {
      await api.czEnd(code);
      setConfirmCancel(null);
      mine.reload();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "L'annulation a échoué.");
    } finally {
      setCancelling(null);
    }
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const parsedSeed = seed.trim() === '' ? undefined : Math.abs(Math.floor(Number(seed.trim())));
      const session = await api.czCreate(
        config,
        parsedSeed !== undefined && Number.isFinite(parsedSeed) ? parsedSeed : undefined,
        config.mode === 'gm' && gmPerks.length > 0 ? gmPerks : undefined
      );
      sessionStorage.setItem(`kune.cz.host.${session.code}`, session.hostToken);
      if (session.gmToken) {
        sessionStorage.setItem(`kune.cz.gm.${session.code}`, session.gmToken);
      }
      setStarted(session);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'La création a échoué.');
    } finally {
      setBusy(false);
    }
  }

  if (started) {
    const joinUrl = `${buzzerOrigin}/coronaz/rejoindre/${started.code}`;
    const gmUrl = started.gmToken ? `${buzzerOrigin}/coronaz/mj/${started.code}?jeton=${started.gmToken}` : null;

    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title">Partie {started.code}</h1>
            <p className="page-sub">
              Les survivants scannent, la télé affiche le plateau
              {gmUrl ? ', le maître du jeu ouvre son lien sur son téléphone' : ''}.
            </p>
          </div>
        </div>

        <div className="launch-layout">
          <div className="stack-5">
            <div className="editor-section">
              <p className="join-code">{started.code}</p>
              <p className="join-url">{joinUrl}</p>
            </div>

            {gmUrl && (
              <div className="editor-section">
                <h2 className="editor-section-title">Lien du maître du jeu</h2>
                <p className="join-url">{gmUrl}</p>
                <p className="field-hint">
                  À garder pour soi : ce lien donne le contrôle de la horde et la vision de tout le plateau.
                </p>
              </div>
            )}

            <Button variant="primary" size="lg" onClick={() => void navigate(`/coronaz/${started.code}`)}>
              Ouvrir l’écran télé
            </Button>
            {/* No television required: this device joins as a survivor and keeps
                the host powers (bots, launch) on the same screen. */}
            <Button variant="secondary" size="lg" onClick={() => void navigate(`/coronaz/rejoindre/${started.code}`)}>
              Jouer en solo sur cet appareil
            </Button>
          </div>

          <div className="qr-card">
            <QRCode value={joinUrl} size={Math.min(280, Math.round(window.innerWidth * 0.6))} />
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">CoronaZ</h1>
          <p className="page-sub">Survie coopérative : le plateau sur la télé, chaque survivant sur son téléphone.</p>
        </div>
      </div>

      {(mine.data ?? []).length > 0 && (
        <div className="live-banner">
          {(mine.data ?? []).map((session) => (
            <div className="live-banner-row" key={session.code}>
              <span>
                Raid en cours : <strong className="tabular">{session.code}</strong>
              </span>
              <span style={{ display: 'flex', gap: '0.5rem' }}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    sessionStorage.setItem(`kune.cz.host.${session.code}`, session.hostToken);
                    void navigate(`/coronaz/${session.code}`);
                  }}
                >
                  Écran télé
                </Button>
                {session.gmToken && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      void navigate(`/coronaz/mj/${session.code}?jeton=${session.gmToken ?? ''}`);
                    }}
                  >
                    Écran MJ
                  </Button>
                )}
                {/* The way out of a raid nobody is going to finish. Live raids sat
                    in this banner forever with no way to clear them except playing
                    them out or restarting the server. */}
                <Button
                  variant="ghost"
                  size="sm"
                  busy={cancelling === session.code}
                  onClick={() => void cancel(session.code)}
                >
                  {confirmCancel === session.code ? 'Confirmer ?' : 'Annuler'}
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="launch-layout">
        <div className="stack-5">
          <div className="editor-section">
            <h2 className="editor-section-title">Qui joue la horde ?</h2>
            <div className="cz-actions">
              <Button variant={config.mode === 'ai' ? 'primary' : 'secondary'} onClick={() => set('mode', 'ai')}>
                L’ordinateur
              </Button>
              <Button variant={config.mode === 'gm' ? 'primary' : 'secondary'} onClick={() => set('mode', 'gm')}>
                Un maître du jeu
              </Button>
            </div>
            {config.mode === 'gm' && (
              <p className="field-hint">
                Le maître du jeu reçoit un lien secret : il voit tout le plateau, déplace les zombies et achète les
                renforts avec un budget par tour.
              </p>
            )}

            {config.mode === 'gm' && (
              <>
                <span className="panel-group-label">
                  Visage de la horde{me.data ? ` · 🥫 ${me.data.stats.rations} rations` : ''}
                </span>
                <div className="stack-2">
                  {GM_CLASSES.map((gmClass) => {
                    const owned = !gmClass.cost || (me.data?.stats.unlockedGm ?? []).includes(gmClass.id);
                    if (owned) {
                      return (
                        <Button
                          key={gmClass.id}
                          variant={config.gmClass === gmClass.id ? 'primary' : 'secondary'}
                          size="sm"
                          onClick={() => {
                            set('gmClass', gmClass.id);
                            // Re-read the pick through the server's own rule:
                            // what stays valid stays picked.
                            setGmPerks((current) => validGmLoadout(gmClass.id, current));
                          }}
                        >
                          {gmClass.emoji} {gmClass.name} — {gmClass.blurb}
                        </Button>
                      );
                    }
                    return (
                      <Button
                        key={gmClass.id}
                        variant="ghost"
                        size="sm"
                        disabled={(me.data?.stats.rations ?? 0) < (gmClass.cost ?? 0)}
                        onClick={() => {
                          void api
                            .czUnlockGm(gmClass.id)
                            .then(() => me.reload())
                            .catch(() => undefined);
                        }}
                      >
                        🔒 {gmClass.emoji} {gmClass.name} — {gmClass.blurb} ({gmClass.cost} 🥫)
                      </Button>
                    );
                  })}
                </div>

                <GmPerkPicker classId={config.gmClass} perks={gmPerks} onChange={setGmPerks} />
              </>
            )}
          </div>

          <div className="editor-section">
            <h2 className="editor-section-title">Scénario</h2>
            <div className="cz-actions">
              {SCENARIOS.map((scenario) => (
                <Button
                  key={scenario}
                  variant={config.scenario === scenario ? 'primary' : 'secondary'}
                  onClick={() => set('scenario', scenario)}
                >
                  {SCENARIO_LABELS[scenario].name}
                </Button>
              ))}
            </div>
            <p className="field-hint">{SCENARIO_LABELS[config.scenario].goal}</p>
          </div>

          <div className="editor-section">
            <h2 className="editor-section-title">Le monde</h2>
            <div className="cz-actions">
              <Button
                variant={config.layout === 'random' ? 'primary' : 'secondary'}
                onClick={() => set('layout', 'random')}
              >
                🎲 Au hasard
              </Button>
              {LAYOUTS.map((layout) => (
                <Button
                  key={layout.id}
                  variant={config.layout === layout.id ? 'primary' : 'secondary'}
                  onClick={() => set('layout', layout.id)}
                >
                  {layout.name}
                </Button>
              ))}
            </div>
            <p className="field-hint">
              {config.layout === 'random'
                ? 'Un quartier, un lotissement, un complexe ou un établissement : tiré à la création.'
                : LAYOUTS.find((layout) => layout.id === config.layout)?.blurb}
            </p>

            {/* Orthogonal to the shape on purpose: any world, any era. */}
            <span className="panel-group-label">Biome · l’arsenal et la faune</span>
            <div className="cz-actions">
              <Button
                variant={config.biome === 'random' ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => set('biome', 'random')}
              >
                🎲 Au hasard
              </Button>
              {BIOMES.map((biome) => (
                <Button
                  key={biome.id}
                  variant={config.biome === biome.id ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => set('biome', biome.id)}
                >
                  {biome.name}
                </Button>
              ))}
            </div>
            <p className="field-hint">
              {config.biome === 'random'
                ? 'Tiré à la création. Chaque biome apporte ses propres armes et ses propres créatures.'
                : BIOMES.find((biome) => biome.id === config.biome)?.blurb}
            </p>
          </div>

          <div className="editor-section">
            <h2 className="editor-section-title">Difficulté</h2>
            <p className="field-hint">
              La carte se mesure en cases : les salles en occupent une à quatre, donc 12 × 7 donne une quarantaine de
              salles. Les écrans se déplacent et zooment, rien n’a besoin de tenir d’un coup d’œil — et la horde est
              nourrie à proportion de la taille du bâtiment, pour qu’un grand immeuble ne soit pas un réglage de
              difficulté déguisé.
            </p>
            <div className="cz-actions">
              {Object.keys(DIFFICULTY_PRESETS).map((name) => (
                <Button
                  key={name}
                  variant={preset === name ? 'primary' : 'secondary'}
                  onClick={() => {
                    setPreset(name);
                    setConfig((current) => ({ ...current, ...DIFFICULTY_PRESETS[name] }));
                  }}
                >
                  {name}
                </Button>
              ))}
            </div>

            <div
              className="form-grid"
              style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}
            >
              <NumberField
                label="Largeur (cases)"
                value={config.width}
                min={6}
                max={32}
                onChange={(v) => set('width', v)}
              />
              <NumberField
                label="Hauteur (cases)"
                value={config.height}
                min={4}
                max={24}
                onChange={(v) => set('height', v)}
              />
              <NumberField
                label="Zombies au départ"
                value={config.startingZombies}
                min={0}
                max={20}
                onChange={(v) => set('startingZombies', v)}
              />
              <NumberField
                label="Renforts (0-3)"
                value={config.reinforcement}
                min={0}
                max={3}
                onChange={(v) => set('reinforcement', v)}
              />
              {config.scenario === 'escape' && (
                <NumberField label="Clés" value={config.keys} min={1} max={6} onChange={(v) => set('keys', v)} />
              )}
              {config.scenario === 'purge' && (
                <NumberField
                  label="Victimes à atteindre"
                  value={config.killTarget}
                  min={5}
                  max={60}
                  onChange={(v) => set('killTarget', v)}
                />
              )}
              {config.scenario === 'survival' && (
                <NumberField
                  label="Tours à tenir"
                  value={config.survivalTurns}
                  min={3}
                  max={30}
                  onChange={(v) => set('survivalTurns', v)}
                />
              )}
              {(config.scenario === 'escape' || config.scenario === 'survival') && (
                <NumberField
                  label="Objectifs secondaires"
                  value={config.secondaryObjectives}
                  min={0}
                  max={2}
                  onChange={(v) => set('secondaryObjectives', v)}
                />
              )}
              {(config.scenario === 'escape' || config.scenario === 'survival') && (
                <NumberField
                  label="Primes (facultatives)"
                  value={config.optionalObjectives}
                  min={0}
                  max={3}
                  onChange={(v) => set('optionalObjectives', v)}
                />
              )}
              <NumberField
                label="Chrono héros (s, 0 = sans)"
                value={config.heroPhaseSeconds}
                min={0}
                max={120}
                onChange={(v) => set('heroPhaseSeconds', v)}
              />
              {config.mode === 'gm' && (
                <NumberField
                  label="Chrono MJ (s, 0 = sans)"
                  value={config.gmPhaseSeconds}
                  min={0}
                  max={120}
                  onChange={(v) => set('gmPhaseSeconds', v)}
                />
              )}
              <NumberField
                label="PV bonus héros"
                value={config.heroHpBonus}
                min={-2}
                max={3}
                onChange={(v) => set('heroHpBonus', v)}
              />
              <NumberField
                label="Chance au butin"
                value={config.lootLuck}
                min={-1}
                max={2}
                onChange={(v) => set('lootLuck', v)}
              />
              <Field
                label="Graine (optionnelle)"
                hint="La même graine avec les mêmes réglages rejoue exactement le même monde : carte, butin, dés."
              >
                {({ id }) => (
                  <Input
                    id={id}
                    inputMode="numeric"
                    placeholder="au hasard"
                    value={seed}
                    onChange={(event) => setSeed(event.target.value)}
                  />
                )}
              </Field>
            </div>
          </div>

          {(config.scenario === 'escape' || config.scenario === 'survival') &&
            (config.secondaryObjectives > 0 || config.optionalObjectives > 0) && (
              <div className="editor-section">
                <h2 className="editor-section-title">Quels objectifs et quelles primes ?</h2>
                <p className="field-hint">
                  Ce qui peut être tiré. En Évasion ils verrouillent la sortie, ailleurs ils paient des
                  points ; et si l’un d’eux vous ennuie, rayez-le de la liste plutôt que de tout couper.
                </p>
                <div className="cz-perk-grid">
                  {OBJECTIVE_KINDS.map((objective) => {
                    const picked = config.objectiveKinds.includes(objective.id);
                    // The last one standing cannot be unticked: nothing to draw from
                    // is what the count above is for.
                    const last = picked && config.objectiveKinds.length === 1;
                    return (
                      <button
                        key={objective.id}
                        type="button"
                        className={`cz-perk ${picked ? 'picked' : ''}`}
                        disabled={last}
                        onClick={() =>
                          set(
                            'objectiveKinds',
                            picked
                              ? config.objectiveKinds.filter((kind) => kind !== objective.id)
                              : [...config.objectiveKinds, objective.id]
                          )
                        }
                      >
                        {objective.emoji} {objective.label}
                      </button>
                    );
                  })}
                </div>

                <p className="field-hint">
                  Primes : elles ne verrouillent rien et rapportent le double de points. Un bonus
                  qu’on abandonne sans regret, ou qu’on va chercher pour le tableau final.
                </p>
                <div className="cz-perk-grid">
                  {BONUS_KINDS.map((objective) => {
                    const picked = config.objectiveKinds.includes(objective.id);
                    return (
                      <button
                        key={objective.id}
                        type="button"
                        className={`cz-perk ${picked ? 'picked' : ''}`}
                        onClick={() =>
                          set(
                            'objectiveKinds',
                            picked
                              ? config.objectiveKinds.filter((kind) => kind !== objective.id)
                              : [...config.objectiveKinds, objective.id]
                          )
                        }
                      >
                        {objective.emoji} {objective.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

          {error && <p className="field-error">{error}</p>}

          <Button variant="primary" size="lg" busy={busy} onClick={() => void create()}>
            Créer la partie
          </Button>
        </div>

        <div className="editor-section" style={{ maxWidth: '22rem' }}>
          <h2 className="editor-section-title">Comment ça se joue</h2>
          <p className="field-hint">
            Chaque tour, tous les survivants agissent en même temps pendant le chrono : 3 points d’action chacun, à
            dépenser en déplacements, attaques, fouilles.
          </p>
          <p className="field-hint">
            Puis la horde joue. S’équiper, échanger et jeter sont gratuits et instantanés : le rythme est le jeu.
          </p>
          <p className="field-hint">
            Les points gagnés comptent dans l’<strong>historique</strong> et le palmarès, comme les quiz.{' '}
            <Badge tone="warn">1 à 4 joueurs</Badge>
          </p>
        </div>
      </div>
    </>
  );
}

/**
 * The horde's CoD pick: one signature perk from the class's three, plus up to
 * two from the shared pool. Optional — an empty pick is a legal loadout.
 */
function GmPerkPicker({
  classId,
  perks,
  onChange
}: {
  classId: string;
  perks: string[];
  onChange: (perks: string[]) => void;
}) {
  const signaturePool = gmClassDef(classId).personalPerks as readonly string[];
  const signature = perks.find((id) => signaturePool.includes(id)) ?? null;
  const globals = perks.filter((id) => !signaturePool.includes(id));
  const globalPool = GM_GLOBAL_PERKS.filter((id) => !signaturePool.includes(id));

  return (
    <>
      <span className="panel-group-label">Atout signature (1 au choix)</span>
      <div className="cz-perk-grid">
        {signaturePool.map((id) => {
          const perk = gmLoadoutPerkDef(id);
          const picked = signature === id;
          return (
            <button
              key={id}
              type="button"
              className={`cz-perk ${picked ? 'picked' : ''}`}
              onClick={() => onChange([...(picked ? [] : [id]), ...globals])}
            >
              {perk.emoji} {perk.label}
            </button>
          );
        })}
      </div>

      <span className="panel-group-label">Atouts généraux ({globals.length}/2)</span>
      <div className="cz-perk-grid">
        {globalPool.map((id) => {
          const perk = gmLoadoutPerkDef(id);
          const picked = globals.includes(id);
          const full = !picked && globals.length >= 2;
          return (
            <button
              key={id}
              type="button"
              className={`cz-perk ${picked ? 'picked' : ''}`}
              disabled={full}
              onClick={() =>
                onChange([
                  ...(signature ? [signature] : []),
                  ...(picked ? globals.filter((g) => g !== id) : [...globals, id])
                ])
              }
            >
              {perk.emoji} {perk.label}
            </button>
          );
        })}
      </div>
    </>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label}>
      {({ id }) => (
        <Input
          id={id}
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, Math.round(next))));
          }}
        />
      )}
    </Field>
  );
}
