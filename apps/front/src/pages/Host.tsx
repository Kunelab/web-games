import { toServerTime, type AnswerAck, type JoinAck } from 'game-core';
import { msg } from 'i18n';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import { api } from '../api/client';
import { badgeMeta } from '../app/badges';
import { fieldText } from '../forms/fieldText';
import { isAdmin, useAuth } from '../hooks/useAuth';
import { useCountdown, useGameSocket } from '../hooks/useGameSocket';
import { useLocale } from '../i18n/locale-context';
import { RoundPanel } from './Player';
import { joinUrl } from '../tools/api-url';
import { Button, Chip, Loading } from '../ui';
import { BlindtestAudio } from '../ui/BlindtestAudio';
import { Ceremony } from '../ui/Ceremony';
import { RevealImage } from '../ui/RevealImage';
import './play.css';

/**
 * The host screen: the television.
 *
 * Everything on it is sized to be read across a room, and there is no navigation at
 * all. It is a real route keyed by the join code, so a refresh reattaches to the
 * running game instead of ending it, which is what the old implementation did.
 */
/**
 * The clip window's four numbers, and the words the editor already uses for them.
 *
 * Reused rather than reworded: a host who has ever opened the media editor has
 * seen these exact labels against these exact fields, and two names for one
 * number is how a form teaches somebody the wrong thing.
 */
const CLIP_FIELDS = [
  { key: 'startGuess', group: 'field.guessClip', edge: 'field.start' },
  { key: 'endGuess', group: 'field.guessClip', edge: 'field.end' },
  { key: 'startReveal', group: 'field.revealClip', edge: 'field.start' },
  { key: 'endReveal', group: 'field.revealClip', edge: 'field.end' }
] as const;

const CLIP_KEYS = CLIP_FIELDS.map((field) => field.key);

export default function Host() {
  const { code = '' } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  /**
   * Whether this screen is also a player.
   *
   * It used to be read straight off the URL and never changed, so the decision
   * was made on the launch screen before the room existed — by somebody who did
   * not yet know whether anybody else was coming. The query string is still where
   * it starts, because "play alone" is a reasonable thing to click from the
   * launcher, but it is a starting value now rather than a verdict: the lobby can
   * flip it either way until the game begins.
   */
  const [solo, setSolo] = useState(() => params.get('solo') === '1');
  const { socket, connected, session, error, serverNow } = useGameSocket();
  const { t, locale } = useLocale();
  const { user } = useAuth();
  /**
   * Whether to *offer* the correction controls. The server decides whether to
   * honour them, against the role on the session rather than this.
   */
  const canCorrect = isAdmin(user);

  const [hostToken] = useState(() => sessionStorage.getItem(`kune.host.${code}`) ?? '');
  const [openError, setOpenError] = useState<string | null>(null);
  /** Whether the host has already asked an endless game to wind up. */
  const [stopping, setStopping] = useState(false);
  /**
   * The round whose library entry this screen just threw away.
   *
   * Kept so the button can be replaced by a word rather than by nothing: the
   * server stops sending `libraryCode` the instant the row is gone, which would
   * otherwise make the button vanish with no sign that pressing it did anything.
   * Keyed by round id so it clears itself on the next one.
   */
  const [flagged, setFlagged] = useState('');
  /**
   * The correction being typed, keyed by answer field, or null when closed.
   *
   * Held in one object rather than an input each, because the fields are the
   * round's and vary by kind: a blind test asks for a title and an artist, an
   * anime opening for the work alone.
   */
  const [correcting, setCorrecting] = useState<Record<string, string> | null>(null);
  /**
   * The clip window being typed, in seconds, or null when the form is closed.
   *
   * Apart from the answers because it is a different kind of mistake: the model
   * read the title wrong, or the chorus lookup missed and the round opens on an
   * intro. Either can be right while the other is wrong, and the server takes
   * them independently.
   */
  const [clip, setClip] = useState<Record<string, string> | null>(null);

  // Re-runs on every reconnect: a fresh socket after a drop knows nothing, so
  // the television re-presents its token each time the line comes back.
  useEffect(() => {
    if (!socket || !connected || !hostToken) return;

    async function open(target: NonNullable<typeof socket>) {
      try {
        // socket.io's ack types do not survive `timeout()`, so the shape is
        // asserted once here rather than spreading `any` through the component.
        const ack = (await target.timeout(5000).emitWithAck('host:open', { code, hostToken })) as JoinAck;

        if (ack.ok) {
          setOpenError(null);
        } else {
          setOpenError(ack.error ?? t(msg('host.openFailed')));
        }
      } catch {
        setOpenError(t(msg('play.serverQuiet')));
      }
    }

    void open(socket);
  }, [socket, connected, hostToken, code, t]);

  const round = session?.hostRound ?? null;
  const remaining = useCountdown(round?.phaseEndsAt ?? null, serverNow);

  const blindtestCode = round?.kind === 'blindtest' ? ((round.payload as { code?: string }).code ?? '') : '';

  /**
   * Whether the media plays here.
   *
   * It does unless the room asked for one screen only and that screen is
   * somebody else's — the phone plugged into the television, or the laptop that
   * joined as a player because it was the device sitting under the projector.
   * This screen keeps its prompts, its clock and its controls either way: the
   * question is where the media goes, not who presses "next".
   */
  const isStage = !session?.tvOnly || session.tvPlayerId === null;

  // A label is a prompt only if the host wrote one. Generated answers have none,
  // and a stock one from the kind arrives as a catalogue key.
  const prompts = (round?.answers ?? []).map((answer) => fieldText(t, answer.label).trim()).filter(Boolean);

  if (!hostToken) {
    return (
      <div className="jeu-screen jeu-center">
        <p className="play-note">{t(msg('host.noToken'))}</p>
        <Button variant="secondary" onClick={() => void navigate('/playlists')}>
          {t(msg('host.myPlaylists'))}
        </Button>
      </div>
    );
  }

  if (openError) {
    return (
      <div className="jeu-screen jeu-center">
        <p className="play-note">{openError}</p>
        <Button variant="secondary" onClick={() => void navigate('/playlists')}>
          {t(msg('host.myPlaylists'))}
        </Button>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="jeu-screen jeu-center">
        <Loading label={t(msg('host.connectingToGame'))} />
      </div>
    );
  }

  const url = joinUrl(code);

  return (
    <div className="jeu-screen jeu-fixed">
      <header className="host-top">
        <span className="host-code">{code}</span>
        <span className="host-progress tabular">
          {round
            ? /**
               * An endless game has no denominator.
               *
               * `total` is the length of the order, which in this mode grows by one
               * every time the buffer tops up. Printed as a fraction it counts
               * "3 / 7" then "4 / 8": a progress bar that never progresses, because
               * the thing it measures against is being extended as you play.
               */
              session.infinite
              ? `${round.index + 1} · ∞`
              : `${round.index + 1} / ${round.total}`
            : t(msg('play.playerCount', { count: session.players.length }))}
        </span>
        {/**
         * The only graceful way out of an endless game.
         *
         * "Terminer" destroys the session, which banks the scores but skips
         * straight past the podium. This stops the refill instead, so the round on
         * screen finishes, the order runs out, and the ceremony happens the way it
         * does in every other game. Hidden once pressed, because it is not
         * reversible and a second press would say nothing new.
         */}
        {session.infinite && session.phase === 'playing' && !stopping && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStopping(true);
              void api.blindtestStop(code).catch(() => setStopping(false));
            }}
          >
            {t(msg('host.stopAfterRound'))}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void api.endSession(code).finally(() => void navigate('/playlists'));
          }}
        >
          {t(msg('host.end'))}
        </Button>
      </header>

      {session.phase === 'lobby' && session.oral && (
        <div className="host-lobby">
          <div className="stack-4" style={{ alignItems: 'center', textAlign: 'center' }}>
            <p className="play-label">{t(msg('host.oral'))}</p>
            <p className="host-prompt">{t(msg('host.oralPrompt'))}</p>
            <p className="play-note">{t(msg('host.oralNote'))}</p>
            {/* Nothing to wait for, so nothing disables this. */}
            <Button variant="primary" size="lg" onClick={() => socket?.emit('host:start', { hostToken })}>
              {t(msg('host.start'))}
            </Button>
          </div>
        </div>
      )}

      {session.phase === 'lobby' && !session.oral && (
        <div className="host-lobby">
          <div className="stack-4" style={{ alignItems: 'center' }}>
            <p className="play-label">{t(msg('host.joinWithCode'))}</p>
            <p className="host-bigcode">{code}</p>
            <p className="play-note">{url}</p>
          </div>

          <div className="stack-4" style={{ alignItems: 'center' }}>
            <p className="play-label">{t(msg('play.playerCount', { count: session.players.length }))}</p>
            <ul className="player-chips">
              {session.players.map((player) => (
                <li key={player.id} className={player.connected ? '' : 'away'}>
                  {player.name}
                  {/*
                    The title earned across past evenings: the cheap glory that
                    makes a returning nickname feel like a returning player.

                    With its medal, and never the bare word. "Vainqueur" on its
                    own beside a name, on a screen that says "waiting to start",
                    reads as this lobby having a winner already. The emoji and
                    the hover both say what it actually is, which is something
                    that nickname did on another evening.
                  */}
                  {player.title && (
                    <span
                      className="chip-title"
                      title={`${t(msg(badgeMeta(player.title).titleKey))} · ${t(msg(badgeMeta(player.title).hintKey))}`}
                    >
                      {badgeMeta(player.title).emoji} {t(msg(badgeMeta(player.title).titleKey))}
                    </span>
                  )}
                  {/* Kicking exists for the misclick and the stray phone, so it lives
                      here in the lobby, not on the score strip mid-game. */}
                  <button
                    type="button"
                    className="chip-kick"
                    aria-label={t(msg('host.remove', { name: player.name }))}
                    title={t(msg('host.remove', { name: player.name }))}
                    onClick={() => socket?.emit('host:kick', { hostToken, playerId: player.id })}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
            {/*
              Playing here, or only presenting.

              Both are ordinary ways to run an evening and neither is the obvious
              default: a laptop under a projector with six phones in the room is
              a television, and the same laptop on a kitchen table with nobody
              else there is a player. So it is asked rather than assumed, and it
              is asked in the lobby, where the answer is actually knowable.

              Taking the seat away is a kick rather than a quiet unmount. The
              server keeps a seat through a disconnection on purpose - that is
              what stops a locked phone losing its score - so leaving the panel
              behind would leave this screen sitting in the player list as an
              absent player, and the room would be waiting for it.
            */}
            <div className="stack-2" style={{ alignItems: 'center', textAlign: 'center' }}>
              <p className="play-label">{t(msg('host.seatPick'))}</p>
              <div className="host-seat-pick">
                <Button variant={solo ? 'primary' : 'ghost'} onClick={() => setSolo(true)}>
                  {t(msg('host.seatPlaying'))}
                </Button>
                <Button
                  variant={solo ? 'ghost' : 'primary'}
                  onClick={() => {
                    setSolo(false);
                    const seat = localStorage.getItem(`kune.player.${code}.id`);
                    if (seat) socket?.emit('host:kick', { hostToken, playerId: seat });
                  }}
                >
                  {t(msg('host.seatScreen'))}
                </Button>
              </div>
              <p className="play-note">{t(msg(solo ? 'host.soloSeat' : 'host.seatHint'))}</p>
            </div>

            <Button
              variant="primary"
              size="lg"
              disabled={session.players.length === 0}
              onClick={() => socket?.emit('host:start', { hostToken })}
            >
              {t(msg('host.start'))}
            </Button>
          </div>

          {/*
            Which screen is the television, asked once the room exists.

            It cannot be asked any earlier: the answer is a device, and until the
            devices have connected and said their names there is nothing to point
            at. It appears only for a game that asked for one screen, because
            otherwise every screen is the stage and the question has no meaning.
          */}
          {session.tvOnly && (
            <div className="stack-4" style={{ alignItems: 'center' }}>
              <p className="play-label">{t(msg('host.tvPick'))}</p>
              <div className="tv-picker">
                <Chip
                  active={session.tvPlayerId === null}
                  onClick={() => socket?.emit('host:setTv', { hostToken, playerId: null })}
                >
                  📺 {t(msg('host.tvThisScreen'))}
                </Chip>
                {session.players.map((player) => (
                  <Chip
                    key={player.id}
                    active={session.tvPlayerId === player.id}
                    onClick={() => socket?.emit('host:setTv', { hostToken, playerId: player.id })}
                  >
                    {player.name}
                  </Chip>
                ))}
              </div>
              <p className="play-note">{t(msg('host.tvHint'))}</p>
            </div>
          )}
        </div>
      )}

      {session.phase === 'playing' && round && (
        <>
          <div className="host-stage">
            {/* Mounted only when this screen is the one presenting: with the
                television being somebody's phone, playing the clip here as well
                would put the same song in the room twice, a second apart. */}
            {blindtestCode && isStage && (
              <BlindtestAudio
                code={blindtestCode}
                payload={round.payload}
                phase={round.phase}
                /**
                 * A clip that cannot play is not a round, so move on.
                 *
                 * Only the host does this, and only while guessing: the host owns
                 * the clock, and letting every player screen advance on its own
                 * error would race several skips against each other. On the
                 * reveal the answer is already up, so there is nothing to rescue
                 * and cutting it short would only look like a glitch.
                 */
                onUnplayable={() => {
                  if (round.phase !== 'reveal') socket?.emit('host:advance', { hostToken });
                }}
              />
            )}

            {round.phase === 'reveal' ? (
              <div className="host-stage-content">
                {/* The picture stays up next to its answer: on a reveal round the
                    thing everyone was staring at is the point of the moment. */}
                {isStage && <HostMedia round={round} serverNow={serverNow} revealed />}
                <p className="play-label">{t(msg('play.answer'))}</p>
                <p className="host-answer">{round.answers.map((answer) => answer.value).join(' · ')}</p>
                {/* On an estimation the guesses ARE the reveal: the whole room wants
                    to see who said what and by how much they missed. */}
                {round.kind === 'estimation' && session.reveal?.guesses && session.reveal.guesses.length > 0 && (
                  <ul className="guess-list">
                    {session.reveal.guesses.map((guess, index) => (
                      <li key={guess.playerId} className={index === 0 ? 'closest' : undefined}>
                        <span className="score-name">{guess.name}</span>
                        <span className="tabular">{guess.value.toLocaleString(locale)}</span>
                        <span className="guess-delta">
                          {guess.delta === 0
                            ? t(msg('play.exact'))
                            : guess.delta > 0
                              ? `+${guess.delta.toLocaleString(locale)}`
                              : guess.delta.toLocaleString(locale)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="play-note">{round.title}</p>
                {/*
                  The one moment a wrong generated answer can be caught.

                  A round drawn by the model is kept in the shared library once it
                  has been played, so the catalogue grows out of what rooms have
                  actually heard. The reveal is also the only time anybody is in a
                  position to say the answer is wrong - the room has just heard the
                  clip and read what it was supposed to be - and before this there
                  was nowhere to put that. The button is here and not on the phones
                  because the catalogue is everybody's and the host is the one
                  person in the room already arbitrating.

                  It disappears once pressed, because the server drops
                  `libraryCode` from the view the moment the entry is gone.
                */}
                {session.reveal?.libraryCode && (
                  <div className="host-flag">
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setFlagged(session.reveal?.roundId ?? '');
                        socket?.emit('host:flagRound', { hostToken });
                      }}
                    >
                      {t(msg('host.flagWrong'))}
                    </Button>
                    <p className="play-note">{t(msg('host.flagHint'))}</p>
                  </div>
                )}
                {!session.reveal?.libraryCode && flagged === session.reveal?.roundId && (
                  <p className="play-note">{t(msg('host.flagged'))}</p>
                )}
              </div>
            ) : (
              <div className="host-stage-content">
                {isStage && <HostMedia round={round} serverNow={serverNow} />}
                {/* No deadline, no countdown: an oral round shows a nought otherwise. */}
                {round.phaseEndsAt !== null && (
                  /* The huge countdown owns the screen only when nothing else is on
                     it. Beside a picture or a grid it becomes a corner detail, or it
                     takes the room the thing being guessed needs. */
                  <p className={`host-timer tabular ${round.kind === 'blindtest' ? '' : 'compact'}`}>{remaining}</p>
                )}
                {/* Only real prompts go on the television. With none, the useful thing
                    to say is how much there is to find, not a row of separators. */}
                <p className="host-prompt">
                  {prompts.length > 0
                    ? prompts.join(' · ')
                    : t(msg('host.answersToFind', { count: round.answers.length }))}
                </p>
                {round.phase === 'study' && <p className="play-note">{t(msg('host.memorising'))}</p>}
                {session.oral && round.phase === 'answering' && <p className="play-note">{t(msg('host.yourTurn'))}</p>}
                {/*
                  Who has the buzzer, on the one screen the whole room is looking at.

                  The name is the point rather than the fact: everybody heard a
                  buzz, nobody can tell whose phone it was, and a race that does not
                  announce its winner out loud is a race the table has to settle by
                  asking. Read from `session.round`, which the host receives too —
                  `hostRound` carries the answers and nothing about the race.
                */}
                {round.phase === 'answering' && session.round?.buzz?.holderName && (
                  <p className="host-buzz">🔔 {session.round.buzz.holderName}</p>
                )}
              </div>
            )}
          </div>

          {/*
            Stopped, and saying so.

            A clock that has simply gone is indistinguishable from a clock that
            has broken, and the host is the one person who knows which. Said on
            this screen because it is the one facing the room.
          */}
          {round.held && <p className="host-held">⏸ {t(msg('host.heldNote'))}</p>}

          {/*
            Correcting what the answer actually is.

            Offered at any point in the round rather than only at the reveal,
            because a wrong answer is usually spotted while people are still
            typing at it — and correcting it then is the difference between a
            round the room argues about and one it simply plays. The clock is
            stopped on open: without that, typing a correction is a race against
            an auto-advance.

            Admin only, and the check is doubled on purpose. This decides what
            is *drawn*; the server decides what is honoured, from the role on
            the session rather than from anything this screen says.
          */}
          {canCorrect && round.libraryCode && correcting !== null && (
            <form
              className="host-correct"
              onSubmit={(event) => {
                event.preventDefault();
                const fields = Object.entries(correcting).map(([key, value]) => ({ key, value }));
                // Blank or unparseable is "leave it alone", not zero: the server
                // takes only the keys it is sent.
                const seconds = Object.fromEntries(
                  Object.entries(clip ?? {})
                    .map(([key, value]) => [key, Number(value)] as const)
                    .filter(([, value]) => Number.isFinite(value) && value >= 0)
                );
                socket?.emit('host:correctRound', { hostToken, fields, clip: seconds });
                setCorrecting(null);
                setClip(null);
                socket?.emit('host:holdRound', { hostToken, hold: false });
              }}
            >
              {round.answers.map((answer) => (
                <label key={answer.key}>
                  <span className="play-label">{fieldText(t, answer.label)}</span>
                  <input
                    className="host-correct-input"
                    value={correcting[answer.key] ?? ''}
                    onChange={(event) => setCorrecting((current) => ({ ...current, [answer.key]: event.target.value }))}
                  />
                </label>
              ))}
              {/*
                The window, for a round that opens in the wrong place.

                Shown for every kind whose payload has one rather than gated on
                the kind by name: the keys are read off the payload above, so a
                round without them simply renders no boxes.
              */}
              {clip && CLIP_KEYS.some((key) => key in clip) && (
                <fieldset className="host-correct-clip">
                  <legend className="play-label">{t(msg('host.correctClip'))}</legend>
                  {CLIP_FIELDS.map((field) => (
                    <label key={field.key}>
                      <span className="play-note">
                        {t(msg(field.group))} · {t(msg(field.edge))}
                      </span>
                      <input
                        className="host-correct-input tabular"
                        type="number"
                        min={0}
                        value={clip[field.key] ?? ''}
                        onChange={(event) => setClip((current) => ({ ...current, [field.key]: event.target.value }))}
                      />
                    </label>
                  ))}
                </fieldset>
              )}
              <p className="play-note">{t(msg('host.correctNote'))}</p>
              <div className="host-correct-actions">
                <Button type="submit" variant="primary" size="sm">
                  {t(msg('host.correctSave'))}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setCorrecting(null);
                    setClip(null);
                    socket?.emit('host:holdRound', { hostToken, hold: false });
                  }}
                >
                  {t(msg('host.correctCancel'))}
                </Button>
              </div>
            </form>
          )}

          <div className="host-bottom">
            {/* Nobody scored anything in an oral game, so the strip would be a row of
                zeros at best and empty at worst. */}
            {!session.oral && (
              <ul className="score-strip">
                {session.players.map((player) => (
                  <li key={player.id} className={player.connected ? '' : 'away'}>
                    <span className="score-name">{player.name}</span>
                    <span className="score-value tabular">{player.score}</span>
                  </li>
                ))}
              </ul>
            )}

            <div className="host-controls">
              {/*
                The clock, off and on.

                Any phase, because the moment a host needs it is rarely the tidy
                one: a plainly wrong answer gets noticed while people are still
                typing at it. The host's to press and not an admin's — stopping
                a game you are running is what running it is, and it changes
                nothing outside the room.
              */}
              <Button variant="ghost" onClick={() => socket?.emit('host:holdRound', { hostToken, hold: !round.held })}>
                {round.held ? `▶ ${t(msg('host.resume'))}` : `⏸ ${t(msg('host.hold'))}`}
              </Button>
              {canCorrect && round.libraryCode && correcting === null && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    // Stopped first, then opened: the other order gives the
                    // auto-advance a window to fire in.
                    socket?.emit('host:holdRound', { hostToken, hold: true });
                    setCorrecting(Object.fromEntries(round.answers.map((answer) => [answer.key, answer.value])));
                    const payload = (round.payload ?? {}) as Record<string, unknown>;
                    setClip(
                      Object.fromEntries(
                        CLIP_KEYS.map((key) => [key, String(typeof payload[key] === 'number' ? payload[key] : 0)])
                      )
                    );
                  }}
                >
                  ✎ {t(msg('host.correct'))}
                </Button>
              )}
              {round.phase === 'answering' && (
                <Button
                  variant={session.oral ? 'primary' : 'secondary'}
                  onClick={() => socket?.emit('host:closeAnswers', { hostToken })}
                >
                  {t(msg(session.oral ? 'host.showAnswer' : 'host.closeAnswers'))}
                </Button>
              )}
              <Button
                variant={session.oral && round.phase === 'answering' ? 'ghost' : 'primary'}
                onClick={() => socket?.emit('host:advance', { hostToken })}
              >
                {t(msg(round.phase === 'reveal' ? 'host.next' : 'host.skip'))}
              </Button>
            </div>
          </div>
        </>
      )}

      {/*
        Solo play's other half, mounted from the lobby onwards.

        It used to live inside the block above, which meant the seat did not
        exist until the game was running — and the game could not start, because
        starting needs a player and this screen was the only one there was. The
        panel itself still draws nothing until there is a round; what moved is
        when the chair is taken.
      */}
      {solo && <SoloAnswers code={code} />}

      {session.phase === 'finished' && session.oral && (
        <div className="host-lobby">
          <div className="stack-4" style={{ alignItems: 'center', textAlign: 'center' }}>
            <p className="play-label">{t(msg('play.finished'))}</p>
            <p className="host-prompt">{t(msg('host.playlistDone'))}</p>
            <Button variant="secondary" onClick={() => void navigate('/playlists')}>
              {t(msg('host.backToPlaylists'))}
            </Button>
          </div>
        </div>
      )}

      {session.phase === 'finished' && !session.oral && (
        <div className="host-finished">
          <p className="play-label">{t(msg('host.finalStandings'))}</p>
          <Ceremony
            players={session.players}
            awards={session.final?.awards ?? []}
            rewards={session.final?.rewards ?? []}
          />
          <Button variant="secondary" onClick={() => void navigate('/playlists')}>
            {t(msg('host.backToPlaylists'))}
          </Button>
        </div>
      )}

      {error && <p className="play-error">{error}</p>}
    </div>
  );
}

/**
 * Solo play's answer half: a second socket on the same page, seated as a
 * regular player, feeding the same RoundPanel a phone would show — minus the
 * media, which the stage above already presents. The server neither knows nor
 * cares that the host and this player share a screen.
 */
function SoloAnswers({ code }: { code: string }) {
  const { socket, connected, session, serverNow, clock } = useGameSocket();
  const { user } = useAuth();
  const { locale } = useLocale();
  const [seated, setSeated] = useState(false);

  const tokenKey = `kune.player.${code}`;

  // Re-seats on every reconnect: the token reclaims the same chair.
  useEffect(() => {
    if (!socket || !connected) return;

    socket
      .timeout(5000)
      .emitWithAck('session:join', {
        code,
        playerName: user?.login ?? 'Solo',
        playerToken: localStorage.getItem(tokenKey) ?? undefined
      })
      .then((raw: unknown) => {
        const ack = raw as JoinAck;
        if (ack.ok) {
          if (ack.playerToken) localStorage.setItem(tokenKey, ack.playerToken);
          if (ack.playerId) localStorage.setItem(`${tokenKey}.id`, ack.playerId);
          setSeated(true);
        }
      })
      .catch(() => undefined);
  }, [socket, connected, code, user, tokenKey]);

  const myId = localStorage.getItem(`${tokenKey}.id`);

  if (!seated || !session || session.phase !== 'playing' || !session.round) {
    return null;
  }

  return (
    <div className="host-solo-panel">
      <RoundPanel
        key={session.round.roundId}
        session={session}
        serverNow={serverNow}
        offsetMs={clock.offsetMs}
        myId={myId}
        locale={locale}
        hidePresentation
        onSubmit={async (fieldKey, value, direct) => {
          if (!socket || !session.round) return { ok: false };
          return (await socket.timeout(5000).emitWithAck('answer:submit', {
            roundId: session.round.roundId,
            fieldKey,
            value,
            clientTime: toServerTime(clock),
            direct
          })) as AnswerAck;
        }}
        onRevealChoices={async (fieldKey) => {
          if (!socket || !session.round) return;
          await socket.timeout(5000).emitWithAck('answer:revealChoices', {
            roundId: session.round.roundId,
            fieldKey
          });
        }}
        onBuzz={async () => {
          if (!socket || !session.round) return { ok: false };
          return (await socket.timeout(5000).emitWithAck('answer:buzz', {
            roundId: session.round.roundId,
            clientTime: toServerTime(clock)
          })) as { ok: boolean; error?: string };
        }}
      />
    </div>
  );
}

/**
 * What the room actually looks at.
 *
 * This screen showed a countdown, the prompts and nothing else, so a picture round
 * had no picture anywhere but on the players' phones and a memory panel was a grid on
 * a telephone. Both are wrong: those rounds are things a room looks at together, and
 * with nobody holding a phone, as when trying a playlist out alone or playing out
 * loud, there was nothing to guess from at all.
 *
 * The host is trusted with the real payload, so the sources are used directly rather
 * than through the per-round token proxy, which exists to keep filenames away from
 * players. A blind test is the deliberate exception: its video stays hidden, because
 * this screen faces the room and the title would be sitting in the corner of it.
 */
function HostMedia({
  round,
  serverNow,
  revealed = false
}: {
  round: NonNullable<NonNullable<ReturnType<typeof useGameSocket>['session']>['hostRound']>;
  serverNow: () => number;
  revealed?: boolean;
}) {
  const payload = round.payload as {
    src?: string;
    cells?: string[];
    question?: string;
    imageUrl?: string;
    mode?: 'pixelate' | 'blur';
    intensity?: number;
    startZoom?: number;
    keepVisible?: boolean;
  };

  if (round.kind === 'quiz' || round.kind === 'estimation') {
    return (
      <div className="stack-4">
        {payload.question && <p className="host-question">{payload.question}</p>}
        {payload.imageUrl && <img className="host-image" src={payload.imageUrl} alt="" />}
      </div>
    );
  }

  if (round.kind === 'image-reveal' && payload.src) {
    /**
     * The duration comes from the phase when it has an end, and from the round's own
     * answer time when it does not. An oral round is host-driven and has no deadline,
     * and deriving the duration from that would hand over a sharp picture at once.
     */
    const duration = round.phaseEndsAt !== null ? round.phaseEndsAt - round.phaseStartAt : round.answerMs;

    return (
      <div className="host-reveal-frame">
        <RevealImage
          className="host-image"
          src={payload.src}
          mode={payload.mode ?? 'blur'}
          intensity={payload.intensity ?? 40}
          startZoom={payload.startZoom ?? 1}
          startAt={round.phaseStartAt}
          durationMs={duration}
          serverNow={serverNow}
          revealed={revealed}
        />
      </div>
    );
  }

  if (round.kind === 'image-memory') {
    // Visible while it is being memorised, and afterwards only if the host said so.
    const visible = revealed || round.phase === 'study' || payload.keepVisible === true;
    if (!visible) {
      return null;
    }

    if (payload.cells && payload.cells.length > 0) {
      return <PanelGrid cells={payload.cells} />;
    }

    if (payload.src) {
      return <img className="host-image" src={payload.src} alt="" />;
    }
  }

  return null;
}

/**
 * A panel laid out to fill the screen it is on.
 *
 * The number of columns has to come from the number of cells and the shape of the box
 * they go in, which is why `auto-fit` cannot do this: it knows a minimum cell width
 * and nothing else, so it settled on the narrowest grid it was allowed and left the
 * rows to overflow whatever was underneath.
 *
 * The box is measured rather than assumed. Deriving it from the window was the first
 * attempt and it is wrong by a lot: the stage sits under a header and above the
 * prompt and the controls, so it is far wider than tall, and using the window's ratio
 * asked for six columns where the space wanted seven and made every cell a letterbox.
 */
function PanelGrid({ cells }: { cells: string[] }) {
  const grid = useRef<HTMLUListElement>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);

  /**
   * The shape of the pictures, measured from the pictures.
   *
   * Guessing it was the mistake. A portrait target suits faces and mangles flags: a
   * two-to-one flag in a portrait cell shows 45% of its width, which reads as a
   * stretch and can crop away the part that identifies the country. So the cells are
   * shaped by what is in them, and the median is used rather than the mean so that
   * one oddity, and Nepal's pennant is a real one, does not drag the whole grid.
   */
  const measured = useRef(new Map<string, number>());
  const [contentAspect, setContentAspect] = useState<number | null>(null);

  function recordAspect(source: string, image: HTMLImageElement) {
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
    measured.current.set(source, image.naturalWidth / image.naturalHeight);

    const sorted = [...measured.current.values()].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? null;

    // Relaid out only when the median actually moves, so a panel does not reshuffle
    // once per image as fifty of them arrive.
    setContentAspect((current) =>
      median !== null && (current === null || Math.abs(median - current) / current > 0.02) ? median : current
    );
  }

  useEffect(() => {
    const element = grid.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) {
        setBox({ width: rect.width, height: rect.height });
      }
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const columns = panelColumns(cells.length, box, contentAspect);
  const rows = Math.ceil(cells.length / columns);

  return (
    <ul
      ref={grid}
      className="host-panel-grid"
      style={{
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`
      }}
    >
      {cells.map((cell, index) => (
        <li key={`${cell}-${index}`}>
          <img
            src={cell}
            alt=""
            // A cached image can already be decoded by the time React attaches the
            // node, and then no load event ever fires, so both paths report.
            ref={(node) => {
              if (node?.complete) recordAspect(cell, node);
            }}
            onLoad={(event) => recordAspect(cell, event.currentTarget)}
          />
          <span className="panel-grid-number">{index + 1}</span>
        </li>
      ))}
    </ul>
  );
}

/** Used only until the pictures have reported their own shape. */
const ASSUMED_CELL_ASPECT = 3 / 4;

/** Beyond a dozen across, a face on a television stops being a face. */
const MAX_PANEL_COLUMNS = 12;

/** Deliberately small: a ragged last row is untidy, badly shaped cells are worse. */
const EMPTY_SLOT_COST = 0.015;

/**
 * How many across, chosen so a cell is about the shape of the pictures in it.
 *
 * Every count is tried and the one whose cells come closest to the content's own shape
 * wins. Matching the shape is what removes the need to crop at all: a grid of flags
 * lands on wide cells, a grid of faces on tall ones, and either way the picture very
 * nearly fills its cell without losing anything.
 *
 * Measuring the box is safe here, but it was not always: while the pictures were in
 * the flow they set their own rows' height, so a narrow grid was a tall grid, a tall
 * grid asked for fewer columns, and two columns was a stable answer the layout could
 * not climb out of. Taking the images out of the flow is what makes the box
 * independent of this decision, and therefore safe to measure.
 */
function panelColumns(
  count: number,
  box: { width: number; height: number } | null,
  contentAspect: number | null
): number {
  if (count <= 1) return 1;
  if (!box) {
    // One frame before the first measurement: near enough, and never wrong enough to
    // be seen.
    return Math.min(count, count <= 12 ? 5 : 10);
  }

  const target = contentAspect ?? ASSUMED_CELL_ASPECT;

  let best = 1;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let columns = 1; columns <= Math.min(count, MAX_PANEL_COLUMNS); columns += 1) {
    const rows = Math.ceil(count / columns);
    const aspect = box.width / columns / (box.height / rows);

    // Compared as a ratio rather than a difference, so being half as wide as the
    // target counts the same as being twice as wide. A small charge per empty slot
    // breaks near-ties towards a layout that fills its last row, without letting a
    // tidy grid of badly shaped cells win outright.
    const score = Math.abs(Math.log(aspect / target)) + (columns * rows - count) * EMPTY_SLOT_COST;

    if (score < bestScore) {
      best = columns;
      bestScore = score;
    }
  }

  return best;
}
