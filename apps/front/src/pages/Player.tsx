import { toServerTime, type AnswerAck, type JoinAck, type RedactedAnswerField, type RoundView } from 'game-core';
import { msg } from 'i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';

import { awardMeta } from '../app/awards';
import { badgeMeta } from '../app/badges';
import { fieldText } from '../forms/fieldText';
import { useCountdown, useGameSocket } from '../hooks/useGameSocket';
import { useLocale } from '../i18n/locale-context';
import { assetUrl } from '../tools/api-url';
import { BlindtestAudio } from '../ui/BlindtestAudio';
import { QuickEnd } from '../ui/QuickEnd';
import { RevealImage } from '../ui/RevealImage';
import { Rewards } from '../ui/Rewards';
import { cx } from '../ui/cx';
import { Badge, Button, Input, Loading } from '../ui';
import './play.css';

/**
 * The player's phone.
 *
 * One thing to do at a time, thumb-sized targets, and the score arrives from the
 * server rather than being guessed locally. The player token is kept in
 * localStorage so a phone that locks or a tab that reloads rejoins the same seat with
 * the same score instead of appearing as a new player.
 */
export default function Player() {
  const { code = '' } = useParams<{ code: string }>();
  const { socket, connected, session, error, serverNow, clock } = useGameSocket();
  const { t, locale } = useLocale();

  const [name, setName] = useState('');
  const [joined, setJoined] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tokenKey = `kune.player.${code}`;

  const join = useCallback(
    async (playerName: string) => {
      if (!socket) return;
      setBusy(true);
      setJoinError(null);

      try {
        // The remembered name rides with the token: a silent rejoin used to
        // send an empty name, which the schema refused — token or no token.
        const remembered = localStorage.getItem(`${tokenKey}.name`) ?? '';
        const actualName = playerName.trim() || remembered || t(msg('play.defaultName'));

        // socket.io's ack types do not survive `timeout()`; asserted once here.
        const ack = (await socket.timeout(5000).emitWithAck('session:join', {
          code,
          playerName: actualName,
          playerToken: localStorage.getItem(tokenKey) ?? undefined
        })) as JoinAck;

        if (ack.ok) {
          if (ack.playerToken) localStorage.setItem(tokenKey, ack.playerToken);
          if (ack.playerId) localStorage.setItem(`${tokenKey}.id`, ack.playerId);
          localStorage.setItem(`${tokenKey}.name`, actualName);
          setJoined(true);
        } else {
          setJoinError(ack.error ?? t(msg('play.joinFailed')));
        }
      } catch {
        setJoinError(t(msg('play.serverQuiet')));
      } finally {
        setBusy(false);
      }
    },
    // Wrapped so the auto-rejoin effect below can depend on it honestly. Without
    // this it would be a new function every render, and the effect would either
    // lie about its dependencies or re-run on each one.
    [socket, code, tokenKey, t]
  );

  // A stored token means this phone was already in the game: rejoin silently
  // rather than asking for the nickname again.
  const autoJoined = useRef(false);
  useEffect(() => {
    if (!socket || !connected || joined || autoJoined.current) return;
    if (!localStorage.getItem(tokenKey)) return;

    autoJoined.current = true;
    // Rejoining talks to the socket, an external system, and the busy flag has to
    // flip as the request starts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void join('');
  }, [socket, connected, joined, join, tokenKey]);

  // A NEW socket after a drop knows nothing: every reconnect re-presents the
  // token and reclaims the seat, silently.
  useEffect(() => {
    if (!connected || !joined) return;
    // Same reasoning as the auto-join above: this talks to the socket.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void join('');
  }, [connected, joined, join]);

  if (!connected) {
    return (
      <div className="jeu-screen jeu-center">
        <Loading label={t(msg('play.connecting'))} />
      </div>
    );
  }

  if (!joined) {
    return (
      <div className="jeu-screen jeu-center">
        <form
          className="join-form"
          onSubmit={(event) => {
            event.preventDefault();
            void join(name);
          }}
        >
          <h1 className="join-title">{t(msg('play.game', { code }))}</h1>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t(msg('play.yourNickname'))}
            maxLength={24}
            aria-label={t(msg('play.yourNickname'))}
            autoFocus
          />
          {joinError && <p className="play-error">{joinError}</p>}
          <Button type="submit" variant="primary" size="lg" block busy={busy} disabled={!name.trim()}>
            {t(msg('play.join'))}
          </Button>
        </form>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="jeu-screen jeu-center">
        <Loading label={t(msg('play.waitingForGame'))} />
      </div>
    );
  }

  const myId = localStorage.getItem(`${tokenKey}.id`);
  const me = session.players.find((player) => player.id === myId);

  return (
    <div className="jeu-screen">
      <header className="player-top">
        <span className="play-label">{code}</span>
        {me && (
          <span className="player-score tabular">
            {me.score} pts · {me.rank}
            <sup>{me.rank === 1 ? 'er' : 'e'}</sup>
          </span>
        )}
      </header>

      {session.phase === 'lobby' && (
        <div className="jeu-center" style={{ flex: 1 }}>
          <div className="stack-4" style={{ textAlign: 'center' }}>
            <p className="play-note">{t(msg('play.waitingForStart'))}</p>
            <p className="play-label">{t(msg('play.playerCount', { count: session.players.length }))}</p>
            <ul className="player-chips">
              {session.players.map((player) => (
                <li key={player.id} className={player.connected ? '' : 'away'}>
                  {player.name}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/**
       * The stage, on this phone, when this phone is one.
       *
       * The server decides that, and says so by sending `stageRound` or not:
       * every player gets one when the room has no television, and exactly one
       * gets it when the host appointed a screen. Only the blind test needs it —
       * every other kind already reaches a player through its own redacted
       * presentation — so this is one clip player, mounted when there is a clip
       * to play and this device is where it plays.
       *
       * Outside the round panel on purpose: it must survive the switch to the
       * reveal, where it stops being invisible and becomes the video everybody
       * was listening to.
       */}
      {session.phase === 'playing' && session.stageRound?.kind === 'blindtest' && (
        <BlindtestAudio
          code={(session.stageRound.payload as { code?: string }).code ?? ''}
          payload={session.stageRound.payload}
          phase={session.stageRound.phase}
        />
      )}

      {session.phase === 'playing' && session.round && (
        <RoundPanel
          key={session.round.roundId}
          session={session}
          serverNow={serverNow}
          offsetMs={clock.offsetMs}
          myId={myId}
          locale={locale}
          onSubmit={async (fieldKey, value, direct) => {
            if (!socket || !session.round) return { ok: false };

            // `clientTime` is this phone's own clock converted to server time with
            // its measured offset. That is what lets the server credit the moment
            // the player actually pressed rather than when the packet landed.
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
            // Same clock treatment as an answer: the race is decided on when the
            // thumb landed, not on when the packet did.
            return (await socket.timeout(5000).emitWithAck('answer:buzz', {
              roundId: session.round.roundId,
              clientTime: toServerTime(clock)
            })) as { ok: boolean; error?: string };
          }}
        />
      )}

      {session.phase === 'finished' && (
        <div className="jeu-center" style={{ flex: 1 }}>
          <div className="stack-4" style={{ textAlign: 'center' }}>
            <p className="play-label">{t(msg('play.finished'))}</p>
            {/* The television holds the ceremony; the phone tells you what YOU got. */}
            {(session.final?.awards ?? [])
              .filter((award) => award.playerId === myId)
              .map((award) => {
                const meta = awardMeta(award.key);
                return (
                  <p className="player-award" key={award.key}>
                    {meta.emoji} {t(msg(meta.titleKey))} · {award.value}
                  </p>
                );
              })}
            <ol className="final-standings">
              {session.players.map((player) => (
                <li key={player.id} className={player.id === myId ? 'me' : undefined}>
                  <span className="rank tabular">{player.rank}</span>
                  <span className="score-name">{player.name}</span>
                  <span className="score-value tabular">{player.score}</span>
                </li>
              ))}
            </ol>

            {/*
              Your row only, on the device in your hand.

              The television shows everybody's, because reading out who unlocked
              what is what that screen is for. A phone is not that screen: the
              person holding it wants to know whether the badge they have been
              circling for three evenings finally dropped, and scrolling past four
              other people's bars to find out is the version of this that nobody
              reads twice.
            */}
            <Rewards
              rewards={(session.final?.rewards ?? []).filter((row) => row.playerId === myId)}
              meId={myId}
              currency="🎟️"
              meta={badgeMeta}
            />

            <QuickEnd code={code} fallbackGame="quiz" />
          </div>
        </div>
      )}

      {error && <p className="play-error">{error}</p>}
    </div>
  );
}

interface RoundPanelProps {
  session: NonNullable<ReturnType<typeof useGameSocket>['session']>;
  serverNow: () => number;
  offsetMs: number;
  /** This phone’s player id, so the reveal shows its own score. */
  myId: string | null;
  /** The reader's language, for the numbers `toLocaleString` has to format. */
  locale: string;
  /**
   * True when this panel sits on a screen that already presents the media, i.e.
   * solo play on the host screen: the question is up there, only answers here.
   */
  hidePresentation?: boolean;
  onSubmit: (
    fieldKey: string,
    value: string,
    direct: boolean
  ) => Promise<{ ok: boolean; error?: string; correct?: boolean; attemptsLeft?: number }>;
  onRevealChoices: (fieldKey: string) => Promise<void>;
  /** Press the buzzer. Only ever called on a round that is being raced. */
  onBuzz: () => Promise<{ ok: boolean; error?: string }>;
}

/** Exported for the host screen's solo mode: one device presents AND answers. */
export function RoundPanel({
  session,
  serverNow,
  myId,
  locale,
  hidePresentation = false,
  onSubmit,
  onRevealChoices,
  onBuzz
}: RoundPanelProps) {
  const t = useLocale().t;
  const round = session.round;
  const remaining = useCountdown(round?.phaseEndsAt ?? null, serverNow);
  const [feedback, setFeedback] = useState<{ field: string; text: string; good: boolean } | null>(null);

  if (!round) return null;

  const reveal = session.reveal;

  if (round.phase === 'reveal' && reveal) {
    // By player id, not "the first entry that scored something", which showed a
    // stranger's points as your own on any round where someone else answered.
    const mine = reveal.roundScores.find((entry) => entry.playerId === myId);

    return (
      <div className="jeu-center" style={{ flex: 1 }}>
        <div className="stack-4" style={{ textAlign: 'center' }}>
          {/*
            The thing everybody was staring at, still on screen beside its answer.

            The reveal used to be words on an empty page: whatever had been in
            front of the player for twenty seconds vanished at the exact moment
            they were told what it was, which is the one moment it is worth
            looking at. A blind test is the exception that needs no code here —
            its clip player lives outside this panel and simply stops hiding.
          */}
          {!hidePresentation && <Presentation round={round} serverNow={serverNow} revealed />}
          <p className="play-label">{t(msg('play.answer'))}</p>
          {reveal.answers.map((answer) => (
            <p className="player-answer" key={answer.key}>
              {answer.value}
            </p>
          ))}
          {reveal.guesses && reveal.guesses.length > 0 && (
            <GuessList guesses={reveal.guesses} myId={myId} locale={locale} />
          )}
          {reveal.explanation && <p className="play-note">{reveal.explanation}</p>}
          {mine && (
            <p className="play-note">
              {t(msg('play.pointsThisRound', { points: mine.points }))}
              {/* A multiplied score has to say why, or it reads as a bug. */}
              {mine.comboMultiplier !== undefined && mine.comboMultiplier > 1 && (
                <>
                  {' '}
                  <Badge tone="ok">{t(msg('play.combo', { factor: mine.comboMultiplier.toFixed(1) }))}</Badge>
                </>
              )}
              {mine.comebackMultiplier !== undefined && mine.comebackMultiplier > 1 && (
                <>
                  {' '}
                  <Badge tone="warn">{t(msg('play.comeback', { factor: mine.comebackMultiplier.toFixed(1) }))}</Badge>
                </>
              )}
            </p>
          )}
          {mine && mine.comboLength > 1 && (
            <p className="play-note">{t(msg('play.streak', { count: mine.comboLength }))}</p>
          )}
        </div>
      </div>
    );
  }

  if (round.phase === 'study') {
    return (
      <div className="jeu-center" style={{ flex: 1 }}>
        <div className="stack-4" style={{ textAlign: 'center' }}>
          <p className="play-label">{t(msg('play.memorise'))}</p>
          <p className="host-timer tabular">{remaining}</p>
          {!hidePresentation && <Presentation round={round} serverNow={serverNow} />}
        </div>
      </div>
    );
  }

  // An estimation is one number, revisable until the phase closes: none of the
  // solved/locked machinery below describes it.
  if (round.kind === 'estimation') {
    const unit = (round.presentation as { unit?: string }).unit;
    return (
      <div className="player-round">
        <div className="player-round-head">
          <span className="player-timer tabular">{remaining}</span>
          <span className="play-note">
            {round.index + 1} / {round.total}
          </span>
        </div>

        {!hidePresentation && <Presentation round={round} serverNow={serverNow} />}

        <EstimationBox unit={unit} onSubmit={(value) => onSubmit(round.fields[0]?.key ?? 'estimate', value, false)} />
      </div>
    );
  }

  const open = round.fields.filter(
    (field) => !round.solvedFieldKeys.includes(field.key) && !round.lockedFieldKeys.includes(field.key)
  );

  // The server pools every field that does not offer choices, so the screen has to
  // group them the same way or it would be describing a game nobody is playing.
  const pooled = round.fields.filter((field) => !field.hasChoices);
  const withChoices = round.fields.filter((field) => field.hasChoices);

  return (
    <div className="player-round">
      <div className="player-round-head">
        <span className="player-timer tabular">{remaining}</span>
        <span className="play-note">
          {round.index + 1} / {round.total}
        </span>
      </div>

      {!hidePresentation && <Presentation round={round} serverNow={serverNow} />}

      {/*
        On a raced round the answer boxes belong to one person at a time.

        Hidden rather than disabled for everybody else, and that is the point of
        the format: a phone showing a live text box is a phone telling its owner to
        keep thinking, and in a race the whole tension is that you have already
        stopped. The server refuses out-of-turn answers regardless — this is what
        the room sees, not what protects the rule.
      */}
      {round.buzz && <Buzzer buzz={round.buzz} myId={myId} serverNow={serverNow} onBuzz={onBuzz} />}

      {round.buzz && round.buzz.holderId !== myId ? null : (
        <div className="stack-4">
          {/* Written answers share one box, because the server accepts any of them from
            it: typing the year into a box headed "Titre" and being told "trouvé"
            while that box stayed open would look broken. One box, and a list of what
            is still out there. A field with choices keeps its own, since that one is
            genuinely a pick from its own list. */}
          {pooled.length > 1 && (
            <FreeRecallBox
              fields={pooled}
              solvedKeys={round.solvedFieldKeys}
              locked={pooled.every((field) => round.lockedFieldKeys.includes(field.key))}
              onSubmit={(value) => {
                const target = pooled.find((field) => !round.solvedFieldKeys.includes(field.key));
                return onSubmit(target?.key ?? pooled[0]?.key ?? '', value, false);
              }}
            />
          )}

          {(pooled.length > 1 ? withChoices : round.fields).map((field) => {
            const solved = round.solvedFieldKeys.includes(field.key);
            const locked = round.lockedFieldKeys.includes(field.key);

            return (
              <AnswerBox
                key={field.key}
                field={field}
                solved={solved}
                locked={locked}
                feedback={feedback?.field === field.key ? feedback : null}
                onRevealChoices={() => void onRevealChoices(field.key)}
                onSubmit={async (value, direct) => {
                  const result = await onSubmit(field.key, value, direct);
                  setFeedback({
                    field: field.key,
                    good: Boolean(result.correct),
                    text: result.correct
                      ? t(msg('play.found'))
                      : (result.error ??
                        (result.attemptsLeft !== undefined
                          ? t(msg('play.notFoundLeft', { count: result.attemptsLeft }))
                          : t(msg('play.notFound'))))
                  });
                }}
              />
            );
          })}

          {open.length === 0 && <p className="play-note">{t(msg('play.allPlayed'))}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * The buzzer: one button, and the three states that are not it.
 *
 * The states are deliberately not collapsed into "enabled / disabled". A player
 * who cannot press needs to know *which* reason applies, because two of them end
 * their round and one does not: somebody else is answering (wait), you already
 * tried (that is it for you), or the race you entered is still being settled.
 * A greyed-out button says none of that.
 */
function Buzzer({
  buzz,
  myId,
  serverNow,
  onBuzz
}: {
  buzz: NonNullable<RoundView['buzz']>;
  myId: string | null;
  serverNow: () => number;
  onBuzz: () => Promise<{ ok: boolean; error?: string }>;
}) {
  const t = useLocale().t;
  const [busy, setBusy] = useState(false);
  const window = useCountdown(buzz.windowEndsAt, serverNow);
  const mine = buzz.holderId !== null && buzz.holderId === myId;

  if (mine) {
    return (
      <p className="play-buzz play-buzz-mine">
        {t(msg('play.buzz.yours'))} <span className="tabular">{window}</span>
      </p>
    );
  }

  if (buzz.holderId !== null) {
    return (
      <p className="play-buzz play-buzz-taken">
        {t(msg('play.buzz.taken', { name: buzz.holderName ?? '?' }))} <span className="tabular">{window}</span>
      </p>
    );
  }

  if (buzz.spent) {
    return <p className="play-buzz play-buzz-spent">{t(msg('play.buzz.spent'))}</p>;
  }

  if (buzz.racing) {
    return <p className="play-buzz play-buzz-racing">{t(msg('play.buzz.racing'))}</p>;
  }

  return (
    <Button
      variant="primary"
      size="lg"
      block
      busy={busy}
      className="play-buzz-button"
      onClick={() => {
        setBusy(true);
        void onBuzz().finally(() => setBusy(false));
      }}
    >
      {t(msg('play.buzz.press'))}
    </Button>
  );
}

/**
 * One box for a whole panel: type what you remember, as many times as you can.
 *
 * The tally is kept here rather than read from the round view because the server
 * does not broadcast a state change per answer, and it must not: who has found what
 * is exactly the information a player would love to see on someone else's screen.
 */
function FreeRecallBox({
  fields,
  solvedKeys,
  locked,
  onSubmit
}: {
  fields: RedactedAnswerField[];
  solvedKeys: string[];
  locked: boolean;
  onSubmit: (value: string) => Promise<{ ok: boolean; error?: string; correct?: boolean }>;
}) {
  const t = useLocale().t;
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<string[]>([]);
  const [miss, setMiss] = useState<string | null>(null);

  const total = fields.length;
  /**
   * Prompts are listed when there are prompts to list.
   *
   * Knowing that a film round wants the title, the director and the year is part of
   * the round. A grid of faces has no questions at all, only answers, so its fields
   * carry no label and there is nothing to print. The count is also capped, because
   * forty prompts is not a list a phone can use.
   */
  const labelled = fields.filter((field) => field.label.trim().length > 0);
  const showPrompts = labelled.length > 0 && total <= 8;

  async function send() {
    const answer = value.trim();
    if (!answer || busy) return;

    setBusy(true);
    try {
      const result = await onSubmit(answer);
      if (result.correct) {
        setFound((current) => [...current, answer]);
        setMiss(null);
        setValue('');
      } else {
        setMiss(result.error ?? t(msg('play.notFound')));
      }
    } finally {
      setBusy(false);
    }
  }

  const done = found.length >= total;

  return (
    <div className="recall">
      <div className="recall-head">
        <span className="play-label">{t(msg(showPrompts ? 'play.answerInAnyOrder' : 'play.recallWhatYouSaw'))}</span>
        <span className="recall-count tabular">
          {found.length} / {total}
        </span>
      </div>

      {showPrompts && (
        <ul className="recall-prompts">
          {labelled.map((field) => (
            <li key={field.key} className={solvedKeys.includes(field.key) ? 'got' : undefined}>
              <span>{fieldText(t, field.label)}</span>
              <span className="tabular">{field.points}</span>
            </li>
          ))}
        </ul>
      )}

      {locked && <p className="field-error">{t(msg('play.noTriesThisRound'))}</p>}

      {!done && !locked && (
        <div className="row-attached">
          <Input
            value={value}
            placeholder={t(msg('play.oneItemThenEnter'))}
            autoComplete="off"
            onChange={(event) => {
              setValue(event.target.value);
              setMiss(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void send();
              }
            }}
          />
          <Button variant="primary" busy={busy} onClick={() => void send()}>
            {t(msg('play.confirm'))}
          </Button>
        </div>
      )}

      {miss && <p className="field-error">{miss}</p>}
      {done && <p className="play-note">{t(msg('play.allFound'))}</p>}

      {found.length > 0 && (
        <ul className="token-list">
          {found.map((entry) => (
            <li key={entry}>
              <span>{entry}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One number, committed and revisable.
 *
 * The server keeps only the latest value, so "Envoyer" after a change is an
 * overwrite, not a second guess. The committed number stays on screen: the point of
 * the format is talking yourself into a better number before the clock runs out.
 */
function EstimationBox({
  unit,
  onSubmit
}: {
  unit?: string;
  onSubmit: (value: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const t = useLocale().t;
  const [value, setValue] = useState('');
  const [committed, setCommitted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const answer = value.trim();
    if (!answer || busy) return;

    setBusy(true);
    setError(null);
    try {
      const result = await onSubmit(answer);
      if (result.ok) {
        setCommitted(answer);
        setValue('');
      } else {
        setError(result.error ?? t(msg('play.estimateRefused')));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="estimate-box">
      <form
        className="row-attached"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <Input
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          placeholder={t(msg(committed ? 'play.fixEstimate' : 'play.yourEstimate'))}
          inputMode="decimal"
          autoComplete="off"
          enterKeyHint="send"
        />
        {unit && <span className="estimate-unit">{unit}</span>}
        <Button type="submit" variant="primary" busy={busy} disabled={!value.trim()}>
          {t(msg(committed ? 'play.fix' : 'play.send'))}
        </Button>
      </form>

      {error && <p className="play-error">{error}</p>}
      {committed && (
        <p className="estimate-committed">
          {t(msg('play.estimateCommitted'))}
          <strong>{committed}</strong>
          {unit ? ` ${unit}` : ''}
          {t(msg('play.estimateEditable'))}
        </p>
      )}
    </div>
  );
}

/** Everyone's number at the reveal, closest first. */
function GuessList({
  guesses,
  myId,
  locale
}: {
  guesses: { playerId: string; name: string; value: number; delta: number }[];
  myId: string | null;
  locale: string;
}) {
  const t = useLocale().t;
  // The reader's own grouping and decimal marks: 1 234,5 or 1,234.5.
  const format = (value: number) => value.toLocaleString(locale);

  return (
    <ul className="guess-list">
      {guesses.map((guess, index) => (
        <li key={guess.playerId} className={cx(index === 0 && 'closest', guess.playerId === myId && 'me')}>
          <span className="score-name">{guess.name}</span>
          <span className="tabular">{format(guess.value)}</span>
          <span className="guess-delta">
            {guess.delta === 0
              ? t(msg('play.exact'))
              : guess.delta > 0
                ? `+${format(guess.delta)}`
                : format(guess.delta)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Kind-specific rendering of whatever the server allowed the player to see.
 *
 * `revealed` is the same distinction the host screen draws: during the round a
 * picture is being progressively uncovered and a panel may be meant to be gone,
 * and at the reveal both are simply shown.
 */
function Presentation({
  round,
  serverNow,
  revealed = false
}: {
  round: NonNullable<NonNullable<ReturnType<typeof useGameSocket>['session']>['round']>;
  serverNow: () => number;
  revealed?: boolean;
}) {
  const presentation = round.presentation as {
    question?: string;
    imageUrl?: string;
    cellUrls?: string[];
    mode?: 'pixelate' | 'blur';
    intensity?: number;
    startZoom?: number;
    keepVisible?: boolean;
  };

  if (round.kind === 'quiz' || round.kind === 'estimation') {
    return (
      <div className="stack-3">
        <p className="player-question">{presentation.question}</p>
        {presentation.imageUrl && <img className="player-image" src={assetUrl(presentation.imageUrl)} alt="" />}
      </div>
    );
  }

  if (round.kind === 'image-reveal' && presentation.imageUrl) {
    // Progress comes from the synchronised clock, so every phone shows the same frame
    // of the reveal without a single frame being transmitted. The round's own answer
    // time stands in when the phase has no deadline, as in an oral game, where the
    // old expression became zero and revealed the picture instantly.
    const duration = round.phaseEndsAt !== null ? round.phaseEndsAt - round.phaseStartAt : round.answerMs;

    return (
      <div className="reveal-frame">
        <RevealImage
          className="player-image"
          src={assetUrl(presentation.imageUrl)}
          mode={presentation.mode ?? 'blur'}
          intensity={presentation.intensity ?? 40}
          startZoom={presentation.startZoom ?? 1}
          startAt={round.phaseStartAt}
          durationMs={duration}
          serverNow={serverNow}
          revealed={revealed}
        />
      </div>
    );
  }

  // `keepVisible` is about the answering phase only. Gating the study phase on it
  // too, as this did, left the default panel showing nothing at all to memorise.
  if (round.kind === 'image-memory' && (revealed || round.phase === 'study' || presentation.keepVisible !== false)) {
    // A generated panel arrives as one image per item and is laid out here, which
    // is also why the grid can hold forty cells without anyone compositing a
    // picture of it: the browser is better at this than an image pipeline.
    if (presentation.cellUrls && presentation.cellUrls.length > 0) {
      return (
        <ul className="panel-grid">
          {presentation.cellUrls.map((url, index) => (
            <li key={url}>
              <img src={assetUrl(url)} alt="" loading="lazy" />
              <span className="panel-grid-number">{index + 1}</span>
            </li>
          ))}
        </ul>
      );
    }

    if (presentation.imageUrl) {
      return <img className="player-image" src={assetUrl(presentation.imageUrl)} alt="" />;
    }
  }

  return null;
}

function AnswerBox({
  field,
  solved,
  locked,
  feedback,
  onSubmit,
  onRevealChoices
}: {
  field: RedactedAnswerField;
  solved: boolean;
  locked: boolean;
  feedback: { text: string; good: boolean } | null;
  onSubmit: (value: string, direct: boolean) => Promise<void>;
  onRevealChoices: () => void;
}) {
  const t = useLocale().t;
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  async function send(answer: string, direct: boolean) {
    if (!answer.trim()) return;
    setBusy(true);
    try {
      await onSubmit(answer.trim(), direct);
      setValue('');
    } finally {
      setBusy(false);
    }
  }

  if (solved) {
    return (
      <div className="answer-box solved">
        <span className="play-label">{fieldText(t, field.label).trim() || t(msg('play.answer'))}</span>
        <Badge tone="ok">{t(msg('play.gotIt'))}</Badge>
      </div>
    );
  }

  if (locked) {
    return (
      <div className="answer-box locked">
        <span className="play-label">{fieldText(t, field.label).trim() || t(msg('play.answer'))}</span>
        <span className="play-note">{t(msg('play.noTriesLeft'))}</span>
      </div>
    );
  }

  return (
    <div className="answer-box">
      <div className="answer-box-head">
        <span className="play-label">{fieldText(t, field.label).trim() || t(msg('play.answer'))}</span>
        <span className="play-note tabular">
          {t(msg('play.points', { points: field.points }))}
          {field.directBonus > 0 && !field.choices ? t(msg('play.blindBonus', { bonus: field.directBonus })) : ''}
        </span>
      </div>

      {field.choices ? (
        <div className="choice-grid">
          {field.choices.map((choice) => (
            <Button key={choice} variant="secondary" busy={busy} onClick={() => void send(choice, false)}>
              {choice}
            </Button>
          ))}
        </div>
      ) : (
        <>
          <form
            className="row-attached"
            onSubmit={(event) => {
              event.preventDefault();
              void send(value, true);
            }}
          >
            <Input
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={t(msg('play.yourAnswer'))}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="send"
            />
            <Button type="submit" variant="primary" busy={busy} disabled={!value.trim()}>
              {t(msg('play.send'))}
            </Button>
          </form>

          {field.hasChoices && (
            <Button variant="ghost" size="sm" onClick={onRevealChoices}>
              {t(msg('play.seeChoices'))}
            </Button>
          )}
        </>
      )}

      {feedback && <p className={feedback.good ? 'play-good' : 'play-error'}>{feedback.text}</p>}
    </div>
  );
}
