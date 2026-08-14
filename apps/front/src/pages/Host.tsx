import { toServerTime, type AnswerAck, type JoinAck } from 'game-core';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import { api } from '../api/client';
import { badgeMeta } from '../app/badges';
import { useAuth } from '../hooks/useAuth';
import { useCountdown, useGameSocket } from '../hooks/useGameSocket';
import { RoundPanel } from './Player';
import { useYoutubePlayer } from '../hooks/useYoutube';
import { joinUrl } from '../tools/api-url';
import { Button, Loading } from '../ui';
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
export default function Host() {
  const { code = '' } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // Solo: this screen presents AND answers — no television, no second device.
  const solo = params.get('solo') === '1';
  const { socket, connected, session, error, serverNow } = useGameSocket();

  const [hostToken] = useState(() => sessionStorage.getItem(`kune.host.${code}`) ?? '');
  const [openError, setOpenError] = useState<string | null>(null);

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
          setOpenError(ack.error ?? "Impossible d'ouvrir cette partie.");
        }
      } catch {
        setOpenError('Le serveur ne répond pas.');
      }
    }

    void open(socket);
  }, [socket, connected, hostToken, code]);

  const round = session?.hostRound ?? null;
  const remaining = useCountdown(round?.phaseEndsAt ?? null, serverNow);

  const blindtestCode = round?.kind === 'blindtest' ? ((round.payload as { code?: string }).code ?? '') : '';

  // A label is a prompt only if the host wrote one. Generated answers have none.
  const prompts = (round?.answers ?? []).map((answer) => answer.label.trim()).filter(Boolean);

  if (!hostToken) {
    return (
      <div className="jeu-screen jeu-center">
        <p className="play-note">
          Cet écran ne connaît pas le jeton de cette partie. Relancez la playlist pour en créer une nouvelle.
        </p>
        <Button variant="secondary" onClick={() => void navigate('/playlists')}>
          Mes playlists
        </Button>
      </div>
    );
  }

  if (openError) {
    return (
      <div className="jeu-screen jeu-center">
        <p className="play-note">{openError}</p>
        <Button variant="secondary" onClick={() => void navigate('/playlists')}>
          Mes playlists
        </Button>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="jeu-screen jeu-center">
        <Loading label="Connexion à la partie…" />
      </div>
    );
  }

  const url = joinUrl(code);

  return (
    <div className="jeu-screen jeu-fixed">
      <header className="host-top">
        <span className="host-code">{code}</span>
        <span className="host-progress tabular">
          {round ? `${round.index + 1} / ${round.total}` : `${session.players.length} joueur(s)`}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void api.endSession(code).finally(() => void navigate('/playlists'));
          }}
        >
          Terminer
        </Button>
      </header>

      {session.phase === 'lobby' && session.oral && (
        <div className="host-lobby">
          <div className="stack-4" style={{ alignItems: 'center', textAlign: 'center' }}>
            <p className="play-label">À l’oral</p>
            <p className="host-prompt">Personne n’a besoin de téléphone.</p>
            <p className="play-note">
              Les réponses se disent à voix haute. C’est vous qui décidez quand les montrer et quand passer.
            </p>
            {/* Nothing to wait for, so nothing disables this. */}
            <Button variant="primary" size="lg" onClick={() => socket?.emit('host:start', { hostToken })}>
              Commencer
            </Button>
          </div>
        </div>
      )}

      {session.phase === 'lobby' && !session.oral && (
        <div className="host-lobby">
          <div className="stack-4" style={{ alignItems: 'center' }}>
            <p className="play-label">Rejoindre avec ce code</p>
            <p className="host-bigcode">{code}</p>
            <p className="play-note">{url}</p>
          </div>

          <div className="stack-4" style={{ alignItems: 'center' }}>
            <p className="play-label">{session.players.length} joueur(s)</p>
            <ul className="player-chips">
              {session.players.map((player) => (
                <li key={player.id} className={player.connected ? '' : 'away'}>
                  {player.name}
                  {/* The title earned across past evenings: the cheap glory that
                      makes a returning nickname feel like a returning player. */}
                  {player.title && <span className="chip-title">{badgeMeta(player.title).title}</span>}
                  {/* Kicking exists for the misclick and the stray phone, so it lives
                      here in the lobby, not on the score strip mid-game. */}
                  <button
                    type="button"
                    className="chip-kick"
                    aria-label={`Retirer ${player.name}`}
                    title={`Retirer ${player.name}`}
                    onClick={() => socket?.emit('host:kick', { hostToken, playerId: player.id })}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
            <Button
              variant="primary"
              size="lg"
              disabled={session.players.length === 0}
              onClick={() => socket?.emit('host:start', { hostToken })}
            >
              Commencer
            </Button>
          </div>
        </div>
      )}

      {session.phase === 'playing' && round && (
        <>
          <div className="host-stage">
            {/* The clip plays here and only here: players receive nothing of it. */}
            {blindtestCode && <HiddenAudio code={blindtestCode} payload={round.payload} phase={round.phase} />}

            {round.phase === 'reveal' ? (
              <div className="host-stage-content">
                {/* The picture stays up next to its answer: on a reveal round the
                    thing everyone was staring at is the point of the moment. */}
                <HostMedia round={round} serverNow={serverNow} revealed />
                <p className="play-label">Réponse</p>
                <p className="host-answer">{round.answers.map((answer) => answer.value).join(' · ')}</p>
                {/* On an estimation the guesses ARE the reveal: the whole room wants
                    to see who said what and by how much they missed. */}
                {round.kind === 'estimation' && session.reveal?.guesses && session.reveal.guesses.length > 0 && (
                  <ul className="guess-list">
                    {session.reveal.guesses.map((guess, index) => (
                      <li key={guess.playerId} className={index === 0 ? 'closest' : undefined}>
                        <span className="score-name">{guess.name}</span>
                        <span className="tabular">{guess.value.toLocaleString('fr-FR')}</span>
                        <span className="guess-delta">
                          {guess.delta === 0
                            ? 'exact !'
                            : guess.delta > 0
                              ? `+${guess.delta.toLocaleString('fr-FR')}`
                              : guess.delta.toLocaleString('fr-FR')}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="play-note">{round.title}</p>
              </div>
            ) : (
              <div className="host-stage-content">
                <HostMedia round={round} serverNow={serverNow} />
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
                    : `${round.answers.length} réponse${round.answers.length > 1 ? 's' : ''} à trouver`}
                </p>
                {round.phase === 'study' && <p className="play-note">Mémorisation en cours</p>}
                {session.oral && round.phase === 'answering' && (
                  <p className="play-note">À vous. Montrez la réponse quand la salle a dit la sienne.</p>
                )}
              </div>
            )}
          </div>

          {solo && <SoloAnswers code={code} />}

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
              {round.phase === 'answering' && (
                <Button
                  variant={session.oral ? 'primary' : 'secondary'}
                  onClick={() => socket?.emit('host:closeAnswers', { hostToken })}
                >
                  {session.oral ? 'Montrer la réponse' : 'Clore les réponses'}
                </Button>
              )}
              <Button
                variant={session.oral && round.phase === 'answering' ? 'ghost' : 'primary'}
                onClick={() => socket?.emit('host:advance', { hostToken })}
              >
                {round.phase === 'reveal' ? 'Suivant' : 'Passer'}
              </Button>
            </div>
          </div>
        </>
      )}

      {session.phase === 'finished' && session.oral && (
        <div className="host-lobby">
          <div className="stack-4" style={{ alignItems: 'center', textAlign: 'center' }}>
            <p className="play-label">Terminé</p>
            <p className="host-prompt">Playlist finie.</p>
            <Button variant="secondary" onClick={() => void navigate('/playlists')}>
              Retour aux playlists
            </Button>
          </div>
        </div>
      )}

      {session.phase === 'finished' && !session.oral && (
        <div className="host-finished">
          <p className="play-label">Classement final</p>
          <Ceremony players={session.players} awards={session.final?.awards ?? []} />
          <Button variant="secondary" onClick={() => void navigate('/playlists')}>
            Retour aux playlists
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

/**
 * Plays the clip without showing it during the guess phase.
 *
 * Kept nearly invisible rather than unmounted: destroying and recreating the iframe
 * between phases costs a reload and a gap in the audio.
 */
function HiddenAudio({ code, payload, phase }: { code: string; payload: unknown; phase: string }) {
  const revealing = phase === 'reveal';
  const window_ = payload as {
    startGuess?: number;
    endGuess?: number;
    startReveal?: number;
    endReveal?: number;
  };

  const { YoutubePlayer, player } = useYoutubePlayer({
    width: 640,
    height: 360,
    playerVars: { controls: 0, disablekb: 1, fs: 0, autoplay: 1 },
    events: { onError: (event) => console.error('youtube error', event.data) }
  });

  const start = revealing ? window_.startReveal : window_.startGuess;
  const end = revealing ? window_.endReveal : window_.endGuess;

  useEffect(() => {
    if (!code) return;
    player.loadVideoById({ videoId: code, startSeconds: start, endSeconds: end });
    // `player` is stable for the life of the hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, start, end]);

  return (
    <div className={revealing ? 'yt-visible' : 'yt-hidden'}>
      <YoutubePlayer />
    </div>
  );
}
