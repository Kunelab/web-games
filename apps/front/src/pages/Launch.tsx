import { defaultSessionConfig, type SessionConfig } from 'game-core';
import { useState } from 'react';
import QRCode from 'react-qr-code';
import { Link, useNavigate, useParams } from 'react-router';

import { api, ApiError } from '../api/client';
import { useAsync } from '../hooks/useAsync';
import { joinUrl } from '../tools/api-url';
import { Badge, Button, Field, Input, Loading, Switch } from '../ui';
import { PublicSwitch } from '../ui/PublicSwitch';
import './playlists.css';

/**
 * The step between a playlist and a game: options, then the code.
 *
 * A named route rather than a hidden screen, so the host can leave, come back, or
 * send the link to the television without losing the game.
 */
export default function Launch() {
  const { id } = useParams<{ id: string }>();
  const playlistId = Number(id);
  const navigate = useNavigate();

  const playlist = useAsync(() => api.getPlaylist(playlistId), [playlistId]);

  const [config, setConfig] = useState<SessionConfig>(defaultSessionConfig);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<{
    code: string;
    hostToken: string;
    skipped: { title: string; missing: string[] }[];
  } | null>(null);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const session = await api.startSession(playlistId, config);
      // The host token proves ownership over the socket, and it must survive a
      // refresh of the host screen, so it goes in sessionStorage keyed by code.
      sessionStorage.setItem(`kune.host.${session.code}`, session.hostToken);
      setStarted(session);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Le lancement a échoué.');
    } finally {
      setStarting(false);
    }
  }

  if (playlist.loading) return <Loading />;
  if (!playlist.data) {
    return (
      <>
        <Link to="/playlists" className="backlink">
          ← Playlists
        </Link>
        <p className="field-error">{playlist.error ?? 'Playlist introuvable.'}</p>
      </>
    );
  }

  const ready = playlist.data.items.length - playlist.data.notReadyCount;

  if (started) {
    const url = joinUrl(started.code);

    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title">Prêt à jouer</h1>
            <p className="page-sub">
              {config.oral
                ? 'Ouvrez l’écran de jeu sur la télé et lancez le premier tour.'
                : 'Les joueurs scannent, puis vous lancez le premier tour.'}
            </p>
          </div>
        </div>

        <div className="launch-layout">
          <div className="stack-5">
            {/* The code still exists, and a phone can still use it, but an oral game
                has no reason to put it on screen. */}
            {!config.oral && (
              <div className="editor-section">
                <p className="join-code">{started.code}</p>
                <p className="join-url">{url}</p>
              </div>
            )}

            {started.skipped.length > 0 && (
              <div className="editor-section">
                <h2 className="editor-section-title">
                  Médias écartés <Badge tone="warn">{started.skipped.length}</Badge>
                </h2>
                <ul className="stack-2" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {started.skipped.map((entry) => (
                    <li key={entry.title} className="field-hint">
                      <strong>{entry.title}</strong> — il manque {entry.missing.join(', ')}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <Button variant="primary" size="lg" onClick={() => void navigate(`/partie/${started.code}`)}>
              Ouvrir l’écran de jeu
            </Button>

            {/* One device does both: the stage on top, your answers underneath.
                Oral mode already IS the no-phones mode, so it needs no twin. */}
            {!config.oral && (
              <Button variant="secondary" size="lg" onClick={() => void navigate(`/partie/${started.code}?solo=1`)}>
                Jouer en solo sur cet appareil
              </Button>
            )}
          </div>

          {!config.oral && (
            <div className="qr-card">
              <QRCode value={url} size={Math.min(280, Math.round(window.innerWidth * 0.6))} />
            </div>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <Link to={`/playlists/${playlistId}`} className="backlink">
        ← {playlist.data.name ?? 'Playlist'}
      </Link>

      <div className="page-head">
        <div>
          <h1 className="page-title">Lancer « {playlist.data.name ?? 'Playlist'} »</h1>
          <p className="page-sub">
            {ready} média{ready === 1 ? '' : 's'} jouable{ready === 1 ? '' : 's'}
            {playlist.data.notReadyCount > 0 && ` · ${playlist.data.notReadyCount} écarté(s)`}
          </p>
        </div>
      </div>

      <div className="launch-layout">
        <div className="editor-section">
          <h2 className="editor-section-title">Options de la partie</h2>

          <PublicSwitch
            what="cette partie"
            value={config.public}
            onChange={(checked) => setConfig({ ...config, public: checked })}
          />

          <Switch
            label="Ordre aléatoire"
            checked={config.shuffle}
            onCheckedChange={(checked) => setConfig({ ...config, shuffle: checked, chronological: false })}
          />
          <Switch
            label="Ordre chronologique"
            hint="Selon la date de chaque média."
            checked={config.chronological}
            onCheckedChange={(checked) => setConfig({ ...config, chronological: checked, shuffle: false })}
          />
          <Switch
            label="Enchaîner automatiquement"
            hint="Sinon, vous avancez manuellement après chaque révélation."
            checked={config.autoAdvance}
            onCheckedChange={(checked) => setConfig({ ...config, autoAdvance: checked })}
          />
          <Switch
            label="Sans téléphones, à l’oral"
            hint="Seule la télé affiche quelque chose, les réponses se disent à voix haute et rien n’est compté. C’est aussi le mode pour essayer une playlist seul."
            checked={config.oral}
            onCheckedChange={(checked) =>
              setConfig({
                ...config,
                oral: checked,
                // A reveal that jumps to the next round after twelve seconds cuts off
                // a room that is still talking, so this mode starts host-driven. It
                // stays a switch: turn it back on for a hands-off slideshow.
                autoAdvance: checked ? false : config.autoAdvance
              })
            }
          />

          {/* Everything below decides how answers are scored and arbitrated, which
              is not a question an oral game has. */}
          {!config.oral && (
            <>
              <Switch
                label="Points de combo"
                hint="Gagner plusieurs manches d’affilée multiplie les points : ×1,1, ×1,2… jusqu’à ×2."
                checked={config.scoring.combo.enabled}
                onCheckedChange={(checked) =>
                  setConfig({
                    ...config,
                    scoring: { ...config.scoring, combo: { ...config.scoring.combo, enabled: checked } }
                  })
                }
              />
              <Switch
                label="Points de remontée"
                hint="Le dernier tiers, s’il est vraiment décroché, marque jusqu’à ×1,5 sur ce qu’il trouve."
                checked={config.scoring.comeback.enabled}
                onCheckedChange={(checked) =>
                  setConfig({
                    ...config,
                    scoring: {
                      ...config.scoring,
                      comeback: { ...config.scoring.comeback, enabled: checked }
                    }
                  })
                }
              />

              <Field label="Essais par réponse" hint="Nombre de mauvaises réponses avant qu’un champ se bloque.">
                {({ id: fieldId, describedBy }) => (
                  <Input
                    id={fieldId}
                    aria-describedby={describedBy}
                    type="number"
                    min={1}
                    max={10}
                    value={config.attemptsPerField}
                    onChange={(event) =>
                      setConfig({ ...config, attemptsPerField: Math.max(1, Number(event.target.value)) })
                    }
                  />
                )}
              </Field>
            </>
          )}

          {error && <p className="field-error">{error}</p>}

          <Button variant="primary" size="lg" busy={starting} disabled={ready === 0} onClick={() => void start()}>
            Créer la partie
          </Button>
        </div>

        {config.oral ? (
          <div className="editor-section" style={{ maxWidth: '22rem' }}>
            <h2 className="editor-section-title">Comment ça se joue</h2>
            <p className="field-hint">
              La télé montre le média, la salle répond à voix haute, vous montrez la réponse quand tout le monde s’est
              prononcé. Rien n’est chronométré et rien n’est compté.
            </p>
            <p className="field-hint">
              La partie démarre même s’il n’y a personne, ce qui en fait le moyen le plus rapide d’écouter une playlist
              du début à la fin pour vérifier qu’elle tient debout.
            </p>
            <p className="field-hint">
              Un téléphone peut quand même rejoindre avec le code si vous voulez tester l’écran joueur.
            </p>
          </div>
        ) : (
          <div className="editor-section" style={{ maxWidth: '22rem' }}>
            <h2 className="editor-section-title">Comment se calcule le score</h2>
            <p className="field-hint">
              Chaque réponse est une course à part : le premier à trouver le titre marque le maximum sur ce champ, même
              si quelqu’un d’autre a trouvé l’artiste avant lui.
            </p>
            <p className="field-hint">
              Trois choses entrent dans le calcul : la place obtenue sur la réponse, qui compte le plus ; le temps qu’il
              restait au chrono ; et le temps par rapport aux autres joueurs qui ont trouvé, ce qui récompense celui qui
              savait quand la question était difficile pour tout le monde.
            </p>
            <p className="field-hint">
              Le retard réseau est compensé : c’est le moment où le joueur a appuyé qui est retenu, pas celui où son
              message est arrivé. Les points ont des décimales, c’est normal.
            </p>
          </div>
        )}
      </div>
    </>
  );
}
