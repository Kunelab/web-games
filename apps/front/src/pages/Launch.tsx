import { defaultSessionConfig, type SessionConfig } from 'game-core';
import { msg } from 'i18n';
import { useState } from 'react';
import QRCode from 'react-qr-code';
import { Link, useNavigate, useParams } from 'react-router';

import { api, ApiError } from '../api/client';
import { useAsync } from '../hooks/useAsync';
import { useT } from '../i18n/locale-context';
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
  const t = useT();

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
      setError(cause instanceof ApiError ? cause.message : t(msg('launch.failed')));
    } finally {
      setStarting(false);
    }
  }

  if (playlist.loading) return <Loading />;
  if (!playlist.data) {
    return (
      <>
        <Link to="/playlists" className="backlink">
          {t(msg('ple.back'))}
        </Link>
        <p className="field-error">{playlist.error ?? t(msg('launch.notFound'))}</p>
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
            <h1 className="page-title">{t(msg('launch.ready'))}</h1>
            <p className="page-sub">{t(msg(config.oral ? 'launch.readyOral' : 'launch.readyPhones'))}</p>
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
                  {t(msg('launch.skipped'))} <Badge tone="warn">{started.skipped.length}</Badge>
                </h2>
                <ul className="stack-2" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {started.skipped.map((entry) => (
                    <li key={entry.title} className="field-hint">
                      <strong>{entry.title}</strong> {t(msg('launch.missing', { fields: entry.missing.join(', ') }))}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <Button variant="primary" size="lg" onClick={() => void navigate(`/partie/${started.code}`)}>
              {t(msg('launch.openScreen'))}
            </Button>

            {/* One device does both: the stage on top, your answers underneath.
                Oral mode already IS the no-phones mode, so it needs no twin. */}
            {!config.oral && (
              <Button variant="secondary" size="lg" onClick={() => void navigate(`/partie/${started.code}?solo=1`)}>
                {t(msg('launch.solo'))}
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
        ← {playlist.data.name ?? t(msg('launch.backPlaylist'))}
      </Link>

      <div className="page-head">
        <div>
          <h1 className="page-title">
            {t(msg('launch.of', { name: playlist.data.name ?? t(msg('launch.backPlaylist')) }))}
          </h1>
          <p className="page-sub">
            {t(msg('launch.playable', { count: ready }))}
            {playlist.data.notReadyCount > 0 &&
              t(msg('launch.skippedMeta', { count: playlist.data.notReadyCount }))}
          </p>
        </div>
      </div>

      <div className="launch-layout">
        <div className="editor-section">
          <h2 className="editor-section-title">{t(msg('launch.options'))}</h2>

          <PublicSwitch
            what={t(msg('launch.thisGame'))}
            value={config.public}
            onChange={(checked) => setConfig({ ...config, public: checked })}
          />

          {/*
            Asked here, with the rest of the setup, and never afterwards.

            A television is a decision about the room you are sitting in, and the
            room is arranged before anybody presses start. Offering it later —
            as a button on the host screen — would mean the first round plays to
            the wrong screens while somebody hunts for the toggle.
          */}
          <Switch
            label={t(msg('launch.tv'))}
            hint={t(msg('launch.tv.hint'))}
            checked={config.tv}
            onCheckedChange={(checked) => setConfig({ ...config, tv: checked })}
          />

          <Switch
            label={t(msg('launch.shuffle'))}
            checked={config.shuffle}
            onCheckedChange={(checked) => setConfig({ ...config, shuffle: checked, chronological: false })}
          />
          <Switch
            label={t(msg('launch.chronological'))}
            hint={t(msg('launch.chronological.hint'))}
            checked={config.chronological}
            onCheckedChange={(checked) => setConfig({ ...config, chronological: checked, shuffle: false })}
          />
          <Switch
            label={t(msg('launch.autoAdvance'))}
            hint={t(msg('launch.autoAdvance.hint'))}
            checked={config.autoAdvance}
            onCheckedChange={(checked) => setConfig({ ...config, autoAdvance: checked })}
          />
          <Switch
            label={t(msg('launch.oral'))}
            hint={t(msg('launch.oral.hint'))}
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
                label={t(msg('launch.combo'))}
                hint={t(msg('launch.combo.hint'))}
                checked={config.scoring.combo.enabled}
                onCheckedChange={(checked) =>
                  setConfig({
                    ...config,
                    scoring: { ...config.scoring, combo: { ...config.scoring.combo, enabled: checked } }
                  })
                }
              />
              <Switch
                label={t(msg('launch.comeback'))}
                hint={t(msg('launch.comeback.hint'))}
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

              <Field label={t(msg('launch.attempts'))} hint={t(msg('launch.attempts.hint'))}>
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
            {t(msg('launch.create'))}
          </Button>
        </div>

        {config.oral ? (
          <div className="editor-section" style={{ maxWidth: '22rem' }}>
            <h2 className="editor-section-title">{t(msg('launch.howOral'))}</h2>
            <p className="field-hint">{t(msg('launch.howOral.1'))}</p>
            <p className="field-hint">{t(msg('launch.howOral.2'))}</p>
            <p className="field-hint">{t(msg('launch.howOral.3'))}</p>
          </div>
        ) : (
          <div className="editor-section" style={{ maxWidth: '22rem' }}>
            <h2 className="editor-section-title">{t(msg('launch.howScore'))}</h2>
            <p className="field-hint">{t(msg('launch.howScore.1'))}</p>
            <p className="field-hint">{t(msg('launch.howScore.2'))}</p>
            <p className="field-hint">{t(msg('launch.howScore.3'))}</p>
          </div>
        )}
      </div>
    </>
  );
}
