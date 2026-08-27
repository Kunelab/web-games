import { FACTION_LABELS, type MafiaPublicPlayer } from 'mafia-core';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';

import { useMafiaSocket } from '../../hooks/useMafiaSocket';
import { Loading } from '../../ui';
import { useT } from '../../i18n/locale-context';
import { MafiaTown } from './MafiaTown';
import './mafia.css';

/**
 * The television. Optional, neutral, and it never plays.
 *
 * A Mafia table is normally played apart — phones and laptops in different
 * houses — so this screen is an *addition* for the case where people are in one
 * room together: something to look at, at the scale of a room, while everyone
 * keeps their own secrets on their own device. It holds no seat, so every
 * mutation the server exposes refuses it; the only two buttons on it change what
 * this screen shows, never what the game does.
 *
 * It claims a table with the join code alone. That is safe rather than lax: the
 * projection it receives is the host console's, which carries no `me`, no living
 * player's role, and only the square's chat — strictly less than any player at the
 * table already has. A secret in the URL would buy no privacy and cost the room
 * the one-tap setup that makes putting it on the TV worth doing.
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

  const [claimError, setClaimError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  /** Off means "reveal nothing". Remembered per table so a reload keeps the choice. */
  const [spoilers, setSpoilers] = useState(() => localStorage.getItem(`mafia:tv:spoilers:${code}`) === 'on');
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!socket || !connected) return;
    socket.emit('mafia:spectate', { code }, (ack) => {
      if (!ack.ok) setClaimError(ack.error ?? 'Impossible de rejoindre cette table');
    });
  }, [socket, connected, code]);

  useEffect(() => {
    localStorage.setItem(`mafia:tv:spoilers:${code}`, spoilers ? 'on' : 'off');
  }, [spoilers, code]);

  useEffect(() => {
    const tick = () => {
      if (!view?.phaseEndsAt) {
        setRemaining(null);
        return;
      }
      setRemaining(Math.max(0, Math.ceil((view.phaseEndsAt - serverNow()) / 1000)));
    };
    tick();
    const interval = setInterval(tick, 500);
    return () => clearInterval(interval);
  }, [view?.phaseEndsAt, serverNow]);

  function toggleFullscreen() {
    const node = shellRef.current;
    if (!node) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void node.requestFullscreen().catch(() => undefined);
  }

  if (claimError) {
    return (
      <div className="mz-tv-empty">
        <h1>Table {code}</h1>
        <p>{claimError}</p>
      </div>
    );
  }

  if (!view) return <Loading />;

  const isNight = view.phase === 'night';
  const joinUrl = `${window.location.origin}/mafia/rejoindre/${code}`;

  /** What a dead row is allowed to say here. */
  function epitaph(player: MafiaPublicPlayer): { text: string; className: string } | null {
    if (player.alive) return null;
    if (!spoilers) return { text: 'Mort', className: 'mz-fac--hidden' };
    if (player.roleName) {
      return { text: player.roleName, className: FACTION_HINT[player.faction ?? 'neutral'] ?? 'mz-fac--neutral' };
    }
    if (player.faction) {
      return { text: FACTION_LABELS[player.faction], className: FACTION_HINT[player.faction] ?? 'mz-fac--neutral' };
    }
    return { text: 'Corps méconnaissable', className: 'mz-fac--hidden' };
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
            ? { ...message, msg: undefined, text: '⸻ un secret a été dit ici ⸻', veiled: true }
            : message
        );

  return (
    <div ref={shellRef} className={isNight ? 'mz-tv mz-tv--night' : 'mz-tv'}>
      <header className="mz-tv-bar">
        <span className="mz-tv-phase">
          {view.phase === 'lobby' && 'Salle d’attente'}
          {view.phase === 'day' && `☀️ Jour ${view.day}`}
          {view.phase === 'night' && `🌙 Nuit ${view.day}`}
          {view.phase === 'ended' && 'Partie terminée'}
        </span>
        {view.stage === 'defense' && <span className="mz-tv-stage">Défense</span>}
        {view.stage === 'judgement' && <span className="mz-tv-stage">Jugement</span>}
        {view.trial && <span className="mz-tv-trial">{view.trial.name} à la barre</span>}

        <span className="mz-tv-spacer" />

        {view.phase === 'lobby' && <span className="mz-tv-code">Code&nbsp;{code}</span>}
        <span className="mz-tv-alive">{view.players.filter((player) => player.alive).length} en vie</span>
        {remaining !== null && (
          <span className={remaining <= 10 ? 'mz-tv-timer mz-tv-timer--urgent' : 'mz-tv-timer'}>{remaining}s</span>
        )}

        <button type="button" className="mz-tv-btn" onClick={() => setSpoilers((on) => !on)}>
          {spoilers ? '🙈 Masquer les rôles' : '👁️ Révéler les rôles'}
        </button>
        <button type="button" className="mz-tv-btn" onClick={toggleFullscreen}>
          ⛶
        </button>
      </header>

      {error && <p className="mz-tv-error">{error}</p>}

      <div className="mz-tv-body">
        <div className="mz-tv-stagearea">
          <MafiaTown players={view.players} mySlot={null} night={isNight} onTrial={view.trial !== null} />
          {view.phase === 'lobby' && (
            <p className="mz-tv-invite">
              Rejoignez la table sur <strong>{joinUrl}</strong>
            </p>
          )}
          {!spoilers && (
            <p className="mz-tv-note">
              Mode sans spoiler : cet écran ne montre aucun rôle. Les identités restent sur les téléphones.
            </p>
          )}
        </div>

        <aside className="mz-tv-side">
          <ul className="mz-tv-roster">
            {view.players.map((player) => {
              const dead = epitaph(player);
              return (
                <li
                  key={player.slot}
                  className={[
                    'mz-tv-seat',
                    player.alive ? '' : 'mz-tv-seat--dead',
                    player.onTrial ? 'mz-tv-seat--trial' : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
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
            {shown.slice(-40).map((message) => (
              <p
                key={message.id}
                className={[
                  'mz-tv-line',
                  message.kind === 'system' ? 'mz-tv-line--sys' : '',
                  'veiled' in message && message.veiled ? 'mz-tv-line--veiled' : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {message.authorId && <strong>{message.authorName} </strong>}
                {message.msg ? t(message.msg) : message.text}
              </p>
            ))}
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
