import type { MafiaPublicPlayer } from 'mafia-core';
import { msg, type Msg } from 'i18n';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';

import { PauseOverlay } from '../../components/presence/PauseOverlay';
import { useMafiaSocket } from '../../hooks/useMafiaSocket';
import { useCountdown } from '../../hooks/useServerClock';
import { cx } from '../../ui/cx';
import { Loading } from '../../ui';
import { useT } from '../../i18n/locale-context';
import { MafiaTown } from './MafiaTown';
import { useMafiaSound } from './mafiaSound';
import './mafia.css';

/**
 * The television. Optional, neutral, and it never plays.
 *
 * A Mafia table is normally played apart — phones and laptops in different
 * houses — so this screen is an *addition* for the case where people are in one
 * room together: something to look at, at the scale of a room, while everyone
 * keeps their own secrets on their own device. It holds no seat: it never votes,
 * never speaks, never sees a role, and the server refuses every mutation that
 * would need one.
 *
 * It claims a table with the join code alone. That is safe rather than lax: the
 * projection it receives is the host console's, which carries no `me`, no living
 * player's role, and only the square's chat — strictly less than any player at the
 * table already has.
 *
 * The one thing it *can* do beyond showing the game is open the lobby, and only
 * when the host handed it the table itself. See `hostToken` below: a room whose
 * only screen is the television could otherwise seat no bots and never start.
 *
 * **Spoiler mode is on by default**, because a big shared screen is the one
 * surface in an asymmetric-information game where a leak reaches everybody at
 * once. With it on, the TV shows the shape of the game — who is standing, who is
 * accused, who is in the ground, what the square is saying — and withholds every
 * identity, including the end-of-game roster, until somebody in the room decides
 * otherwise.
 */

const FACTION_HINT: Record<string, string> = {
  town: 'mz-fac--town',
  mafia: 'mz-fac--mafia',
  triad: 'mz-fac--triad',
  cult: 'mz-fac--cult',
  neutral: 'mz-fac--neutral'
};

export default function MafiaTv() {
  const { code: rawCode } = useParams();
  const code = (rawCode ?? '').toUpperCase();
  const { socket, connected, view, messages, error, serverNow } = useMafiaSocket();
  const t = useT();

  const [claimError, setClaimError] = useState<Msg | null>(null);
  /**
   * The host's own console, when this screen *is* the host's screen.
   *
   * The television claims a table with the join code alone, which is right for
   * a screen somebody put on the wall — and it meant that a host who set the
   * table up on that screen could do nothing with it. No bots, no start button,
   * a lobby that sits there forever. The obvious workaround, giving every
   * spectator host powers, hands the game to anybody who reads the code off the
   * wall, so it is not the fix.
   *
   * Instead the host's own "open the town screen" link carries the host token
   * in the URL *fragment*. A fragment never leaves the browser: it is not sent
   * with the request and not put in a `Referer`, so the token travels no
   * further than the tab it was opened in. It is read once, kept where the rest
   * of the app keeps it, and wiped from the address bar immediately — a token
   * sitting in a URL bar in front of a room is a token the room has.
   *
   * A television opened with a bare code is exactly what it always was.
   */
  const [hostToken] = useState<string | null>(() => {
    const handed = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('host');
    if (handed) sessionStorage.setItem(`mafia:host:${code}`, handed);
    return handed ?? sessionStorage.getItem(`mafia:host:${code}`);
  });
  /** Off means "reveal nothing". Remembered per table so a reload keeps the choice. */
  const [spoilers, setSpoilers] = useState(() => localStorage.getItem(`mafia:tv:spoilers:${code}`) === 'on');
  const shellRef = useRef<HTMLDivElement>(null);
  const remaining = useCountdown(view?.phaseEndsAt ?? null, serverNow);

  // And out of sight: a token left in an address bar in front of a room is a
  // token the room has. Read above, wiped here, once.
  useEffect(() => {
    if (window.location.hash.includes('host=')) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, []);

  useEffect(() => {
    if (!socket || !connected) return;
    socket.emit('mafia:spectate', { code }, (ack) => {
      if (!ack.ok) setClaimError(ack.error ?? msg('mafia.tv.cannotJoin'));
    });
  }, [socket, connected, code]);

  useEffect(() => {
    localStorage.setItem(`mafia:tv:spoilers:${code}`, spoilers ? 'on' : 'off');
  }, [spoilers, code]);

  // The room's ears. Above the early returns, because a hook is a hook.
  useMafiaSound(view);

  function toggleFullscreen() {
    const node = shellRef.current;
    if (!node) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void node.requestFullscreen().catch(() => undefined);
  }

  if (claimError) {
    return (
      <div className="mz-tv-empty">
        <h1>{t(msg('mafia.ui.table', { code }))}</h1>
        <p>{t(claimError)}</p>
      </div>
    );
  }

  if (!view) return <Loading />;

  const isNight = view.phase === 'night';
  const joinUrl = `${window.location.origin}/mafia/rejoindre/${code}`;
  /** Seats taken, which is what both lobby buttons are bounded by. */
  const seated = view.players.length;

  /** What a dead row is allowed to say here. */
  function epitaph(player: MafiaPublicPlayer): { text: string; className: string } | null {
    if (player.alive) return null;
    if (!spoilers) return { text: t(msg('mafia.tv.deadShort')), className: 'mz-fac--hidden' };
    if (player.roleName) {
      return { text: t(player.roleName), className: FACTION_HINT[player.faction ?? 'neutral'] ?? 'mz-fac--neutral' };
    }
    if (player.faction) {
      return {
        text: t(msg(`mafia.faction.${player.faction}`)),
        className: FACTION_HINT[player.faction] ?? 'mz-fac--neutral'
      };
    }
    return { text: t(msg('mafia.tv.unrecognisable')), className: 'mz-fac--hidden' };
  }

  /**
   * The transcript, veiled to match the roster.
   *
   * The roster hiding a role while the dawn report below it announced the same
   * role in prose was the first version of this screen, and it withheld nothing
   * from anybody. The server marks its own identity-bearing lines (`reveals`), so
   * this holds those back and leaves a marker in their place — the room still sees
   * that something happened, without being told what.
   *
   * Post-game the projection widens to every channel, whispers and family rooms
   * included. That is the biggest reveal of all, so it waits behind the same
   * switch.
   */
  const shown = spoilers
    ? messages
    : messages
        .filter((message) => message.channel === 'day')
        .map((message) =>
          // `msg` is dropped along with the text: a veiled line must not still be
          // carrying the key that would render the thing being veiled.
          message.reveals
            ? { ...message, msg: undefined, text: t(msg('mafia.tv.veiled')), veiled: true }
            : message
        );

  const pause = view.presence;

  return (
    <div ref={shellRef} className={isNight ? 'mz-tv mz-tv--night' : 'mz-tv'}>
      {/*
        The television shows the pause and cannot resolve it: it holds no seat, so
        the server refuses every mutation from it — including a ballot. The room
        votes on its phones, and this screen is how the room notices it should.
      */}
      {pause.paused && (
        <PauseOverlay
          waitingFor={pause.waitingFor.map((seat) => ({
            label: t(msg('mafia.ui.seatLabel', { name: seat.name, slot: seat.slot })),
            id: seat.slot,
            awayMs: seat.awayMs
          }))}
          expiresAt={pause.pauseExpiresAt}
          resumesAt={pause.resumesAt}
          kickable={[]}
          vote={
            pause.vote
              ? {
                  label: t(msg('mafia.ui.seatLabel', { name: pause.vote.name, slot: pause.vote.slot })),
                  closesAt: pause.vote.closesAt,
                  yes: pause.vote.yes,
                  no: pause.vote.no,
                  needed: pause.vote.needed,
                  mine: null
                }
              : null
          }
          serverNow={serverNow}
          onPropose={null}
          onVote={null}
        />
      )}
      <header className="mz-tv-bar">
        <span className="mz-tv-phase">
          {view.phase === 'lobby' && t(msg('mafia.ui.phase.lobby'))}
          {view.phase === 'day' && t(msg('mafia.ui.phase.day', { day: view.day }))}
          {view.phase === 'night' && t(msg('mafia.ui.phase.night', { day: view.day }))}
          {view.phase === 'ended' && t(msg('mafia.ui.phase.ended'))}
        </span>
        {view.stage === 'defense' && <span className="mz-tv-stage">{t(msg('mafia.ui.stage.defense'))}</span>}
        {view.stage === 'judgement' && <span className="mz-tv-stage">{t(msg('mafia.ui.stage.judgement'))}</span>}
        {view.trial && <span className="mz-tv-trial">{t(msg('mafia.tv.onStand', { name: view.trial.name }))}</span>}

        <span className="mz-tv-spacer" />

        {view.phase === 'lobby' && <span className="mz-tv-code">{t(msg('mafia.tv.code', { code }))}</span>}
        <span className="mz-tv-alive">
          {t(msg('mafia.ui.alive', { count: view.players.filter((player) => player.alive).length }))}
        </span>
        {view.phaseEndsAt !== null && (
          <span className={remaining <= 10 ? 'mz-tv-timer mz-tv-timer--urgent' : 'mz-tv-timer'}>{remaining}s</span>
        )}

        <button type="button" className="mz-tv-btn" onClick={() => setSpoilers((on) => !on)}>
          {t(msg(spoilers ? 'mafia.tv.hideRoles' : 'mafia.tv.showRoles'))}
        </button>
        <button type="button" className="mz-tv-btn" onClick={toggleFullscreen} title={t(msg('mafia.tv.fullscreen'))}>
          ⛶
        </button>
      </header>

      {error && <p className="mz-tv-error">{t(error)}</p>}

      <div className="mz-tv-body">
        <div className="mz-tv-stagearea">
          <MafiaTown players={view.players} mySlot={null} night={isNight} seed={code} />
          {view.phase === 'lobby' && (
            <p className="mz-tv-invite">
              {t(msg('mafia.tv.joinAt'))} <strong>{joinUrl}</strong>
            </p>
          )}
          {/*
            The two buttons a table cannot start without, and only for the screen
            that proved it is the host's. Deliberately the same pair the phone
            has and nothing more: this screen still never votes, never speaks and
            never sees a role.
          */}
          {view.phase === 'lobby' && hostToken && (
            <div className="mz-tv-host">
              <button
                type="button"
                className="mz-tv-btn"
                onClick={() => socket?.emit('mafia:addBots', { hostToken, count: 1 })}
                disabled={seated >= view.maxPlayers}
              >
                {t(msg('mafia.ui.lobby.addBots'))}
              </button>
              <button
                type="button"
                className="mz-tv-btn mz-tv-btn--go"
                onClick={() => socket?.emit('mafia:start', { hostToken })}
                disabled={seated < view.minPlayers}
              >
                {t(msg('mafia.ui.lobby.start'))}
              </button>
            </div>
          )}
          {!spoilers && (
            <p className="mz-tv-note">{t(msg('mafia.tv.noSpoilers'))}</p>
          )}
        </div>

        <aside className="mz-tv-side">
          <ul className="mz-tv-roster">
            {view.players.map((player) => {
              const dead = epitaph(player);
              return (
                <li
                  key={player.slot}
                  className={cx('mz-tv-seat', !player.alive && 'mz-tv-seat--dead', player.onTrial && 'mz-tv-seat--trial')}
                >
                  <span className="mz-tv-no">{player.slot}</span>
                  <span className="mz-tv-name">
                    {player.name}
                    {player.revealedMayor && ' 🎗️'}
                  </span>
                  {dead && <span className={`mz-tv-epitaph ${dead.className}`}>{dead.text}</span>}
                  {player.alive && player.votesAgainst > 0 && <span className="mz-tv-votes">{player.votesAgainst}</span>}
                </li>
              );
            })}
          </ul>

          <div className="mz-tv-chat">
            {shown.slice(-40).map((message) => {
              const veiled = 'veiled' in message && message.veiled === true;
              return (
                <p
                  key={message.id}
                  className={cx('mz-tv-line', message.kind === 'system' && 'mz-tv-line--sys', veiled && 'mz-tv-line--veiled')}
                >
                  {message.authorId && <strong>{message.authorName} </strong>}
                  {message.msg ? t(message.msg) : message.text}
                </p>
              );
            })}
            <ChatFloor deps={shown.length} />
          </div>
        </aside>
      </div>
    </div>
  );
}

/** Keeps the transcript pinned to the newest line without a ref dance upstream. */
function ChatFloor({ deps }: { deps: number }) {
  const floor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    floor.current?.scrollIntoView({ block: 'end' });
  }, [deps]);
  return <div ref={floor} />;
}
