import { defaultSessionConfig, type SessionConfig } from 'game-core';
import { msg } from 'i18n';
import { useState } from 'react';
import QRCode from 'react-qr-code';
import { Link, useNavigate, useParams } from 'react-router';

import { api, ApiError } from '../api/client';
import { fieldText } from '../forms/fieldText';
import { useAsync } from '../hooks/useAsync';
import { useT } from '../i18n/locale-context';
import { joinUrl } from '../tools/api-url';
import { Badge, Button, Field, Input, Loading, Select, Switch } from '../ui';
import { PublicSwitch } from '../ui/PublicSwitch';
import { RoomDoor } from '../ui/RoomDoor';
import { ShareLink } from '../ui/ShareLink';
import { BlindtestSource, type BlindtestDraw } from './BlindtestSource';
import './playlists.css';

/** What this room will be played on. */
export type LaunchSource = 'playlist' | 'blindtest';

/**
 * The step between deciding what to play and a room with a code in it.
 *
 * A named route rather than a hidden screen, so the host can leave, come back, or
 * send the link to the television without losing the game.
 *
 * **Two sources, one room.** What a quiz is played on is either a playlist
 * somebody wrote or the generated blind test, and that used to be the difference
 * between two entirely separate screens — this one, which asked every question
 * about the room, and a second one which asked none of them. So a generated blind
 * test could not be listed on the public board, could not be named, could not be
 * given a password and could not be raced on a buzzer, for no reason other than
 * where its launch button happened to live. The source is a panel on this screen
 * now, and everything below it is the same for both.
 */
export default function Launch({ source = 'playlist' }: { source?: LaunchSource }) {
  const { id } = useParams<{ id: string }>();
  const playlistId = Number(id);
  const navigate = useNavigate();
  const t = useT();

  const isBlindtest = source === 'blindtest';

  // Never asked for on the generated side: there is no playlist to fetch, and
  // `useAsync` is given something that resolves rather than a conditional hook.
  const playlist = useAsync(
    () => (isBlindtest ? Promise.resolve(null) : api.getPlaylist(playlistId)),
    [playlistId, isBlindtest]
  );

  const [config, setConfig] = useState<SessionConfig>(defaultSessionConfig);
  /**
   * The genres and the window, or null while they could not start a game.
   *
   * Owned here rather than inside the panel because it is what the start button
   * sends, and the start button belongs to the room. `useState`'s setter is
   * stable, so handing it straight down is also what keeps the panel's reporting
   * effect from looping.
   */
  const [draw, setDraw] = useState<BlindtestDraw | null>(null);
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
      const session = isBlindtest
        ? draw && { ...(await api.blindtestCreate({ ...draw, config })), skipped: [] }
        : await api.startSession(playlistId, config);
      if (!session) return;
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
  if (!isBlindtest && !playlist.data) {
    return (
      <>
        <Link to="/playlists" className="backlink">
          {t(msg('ple.back'))}
        </Link>
        <p className="field-error">{playlist.error ?? t(msg('launch.notFound'))}</p>
      </>
    );
  }

  /** What this room is playing, in the reader's words. Also the unnamed room's name. */
  const subject = isBlindtest
    ? t(msg('launch.blindtest'))
    : (playlist.data?.name ?? t(msg('launch.backPlaylist')));
  const ready = playlist.data ? playlist.data.items.length - playlist.data.notReadyCount : 0;

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
                {/* Beside the code, because it is the second half of the same
                    sentence: the code gets you to the door and this opens it.
                    The host chose it, so there is nothing to hide from them. */}
                {config.password && (
                  <p className="field-hint">
                    {t(msg('room.password'))} : <strong>{config.password}</strong>
                  </p>
                )}
                {/* The QR beside this covers the room; this covers the group chat,
                    which is where at least half of an evening's players are. */}
                <ShareLink url={url} title={subject} />
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
                      <strong>{entry.title}</strong>{' '}
                      {t(
                        msg('launch.missing', {
                          // Keys from the server; the words belong to this reader.
                          fields: entry.missing.map((key) => fieldText(t, key)).join(', ')
                        })
                      )}
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
      <Link to={isBlindtest ? '/quiz/creer' : `/playlists/${playlistId}`} className="backlink">
        ← {isBlindtest ? t(msg('quiz.create.title')) : subject}
      </Link>

      <div className="page-head">
        <div>
          <h1 className="page-title">{t(msg('launch.of', { name: subject }))}</h1>
          <p className="page-sub">
            {isBlindtest ? (
              t(msg('launch.blindtest.lede'))
            ) : (
              <>
                {t(msg('launch.playable', { count: ready }))}
                {(playlist.data?.notReadyCount ?? 0) > 0 &&
                  t(msg('launch.skippedMeta', { count: playlist.data?.notReadyCount ?? 0 }))}
              </>
            )}
          </p>
        </div>
      </div>

      {/* What is being played, above how the room is set up: the panel decides
          whether there is anything to play at all, and the start button below
          stays dead until it says there is. */}
      {isBlindtest && (
        <div className="editor-section">
          <h2 className="editor-section-title">{t(msg('launch.blindtest.source'))}</h2>
          <BlindtestSource onChange={setDraw} />
        </div>
      )}

      <div className="launch-layout">
        <div className="editor-section">
          <h2 className="editor-section-title">{t(msg('launch.options'))}</h2>

          <PublicSwitch
            what={t(msg('launch.thisGame'))}
            value={config.public}
            onChange={(checked) => setConfig({ ...config, public: checked })}
          />

          <RoomDoor
            name={config.name}
            password={config.password}
            fallback={subject}
            onName={(next) => setConfig({ ...config, name: next })}
            onPassword={(next) => setConfig({ ...config, password: next })}
          />

          {/*
            Where the media plays, asked as a question with two answers.

            It was a switch called "there is a television", which is the wrong
            shape for it twice over. A switch has a default that reads as the
            normal thing and an "on" that reads as the exception, and neither of
            these is either — a room on a sofa with phones and a room in front of
            a big screen are both perfectly ordinary evenings. And what the
            switch decided was never really "is there a TV", it was "does the
            clip play on every device or on exactly one", which is what the two
            options now say out loud.

            *Which* screen is the one is deliberately not asked here: it is a
            device, and the devices are not in the room yet. That question is put
            in the lobby, where they are.
          */}
          <Field
            label={t(msg('launch.stage'))}
            hint={t(msg(config.tv ? 'launch.stage.tv.hint' : 'launch.stage.everyone.hint'))}
          >
            {({ id: fieldId, describedBy }) => (
              <Select
                id={fieldId}
                aria-describedby={describedBy}
                value={config.tv ? 'tv' : 'everyone'}
                options={[
                  { value: 'everyone', label: t(msg('launch.stage.everyone')) },
                  { value: 'tv', label: t(msg('launch.stage.tv')) }
                ]}
                onValueChange={(next) => setConfig({ ...config, tv: next === 'tv' })}
              />
            )}
          </Field>

          {/* Both questions are about an order that already exists, and a
              generated blind test has none: its rounds are drawn one ahead of
              the room, already paced by difficulty, and there is no date to sort
              by. The server forces the pair off for it regardless — see
              `POST /blindtest/sessions` — so asking would be asking twice and
              answering neither time. */}
          {!isBlindtest && (
            <>
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
            </>
          )}
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

              <Switch
                label={t(msg('launch.buzzer'))}
                hint={t(msg('launch.buzzer.hint'))}
                checked={config.buzzer}
                onCheckedChange={(checked) => setConfig({ ...config, buzzer: checked })}
              />

              {/* Only worth asking once the format is on, and worth asking then:
                  the length of this window is the whole risk of pressing early. */}
              {config.buzzer && (
                <Field label={t(msg('launch.buzzerWindow'))} hint={t(msg('launch.buzzerWindow.hint'))}>
                  {({ id: fieldId, describedBy }) => (
                    <Input
                      id={fieldId}
                      aria-describedby={describedBy}
                      type="number"
                      min={3}
                      max={30}
                      value={Math.round(config.buzzerWindowMs / 1000)}
                      onChange={(event) =>
                        setConfig({
                          ...config,
                          buzzerWindowMs: Math.min(30, Math.max(3, Number(event.target.value))) * 1000
                        })
                      }
                    />
                  )}
                </Field>
              )}

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

          {/* Dead until there is something to play: an empty playlist on one
              side, and on the other a set of genres the catalogue cannot fill. */}
          <Button
            variant="primary"
            size="lg"
            busy={starting}
            disabled={isBlindtest ? draw === null : ready === 0}
            onClick={() => void start()}
          >
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
