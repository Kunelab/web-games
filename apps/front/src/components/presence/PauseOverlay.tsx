import { useState } from 'react';

import { useCountdown } from '../../hooks/useServerClock';
import { cx } from '../../ui/cx';
import './presence.css';

/**
 * The screen every player sees while the game is stopped.
 *
 * One component for both games, because the situation is identical and the
 * vocabulary is the only difference: Mafia waits for houses, CoronaZ waits for
 * survivors, and both need the same four things on screen — who we are waiting
 * for, how long the wait may last, whether it is about to end, and the one
 * button that lets the room carry on without somebody.
 *
 * Not dismissable, but foldable. A pause the room can click *away* is a pause
 * that silently stops protecting the person it exists for, so it never leaves
 * the screen — folded it is still a banner across the top, and it unfolds itself
 * again for the two moments that are addressed to this player: a vote to answer,
 * and the countdown back into play.
 *
 * Foldable because covering the whole page costs something real. Mafia keeps its
 * chat open during a pause on purpose — a pause is a social moment, and "anyone
 * know where house 4 went?" is how it ends — and a shade over the chat panel
 * makes the server's permission unusable. Nothing is being guarded by the shade
 * anyway: the engines refuse every board action while stopped, so this screen is
 * the explanation, not the lock.
 */

export interface PauseSeat {
  /** How the game names this seat: a house number, or a survivor. */
  label: string;
  /** What the room votes against. A slot in Mafia, a player id in CoronaZ. */
  id: string | number;
  awayMs: number;
}

export interface PauseVote {
  label: string;
  closesAt: number;
  yes: number;
  no: number;
  needed: number;
  /** This viewer's own ballot, or null if they have not cast one. */
  mine: boolean | null;
}

export interface PauseOverlayProps {
  waitingFor: PauseSeat[];
  /** When the wait lapses on its own and play continues without them. */
  expiresAt: number | null;
  /** Set while the resume countdown runs: every screen shows this number. */
  resumesAt: number | null;
  /** Seats a kick may be proposed against; empty until the delay has elapsed. */
  kickable: PauseSeat[];
  vote: PauseVote | null;
  serverNow: () => number;
  /** Null for a screen with no seat: a television watches, it does not vote. */
  onPropose: ((id: string | number) => void) | null;
  onVote: ((yes: boolean) => void) | null;
  error?: string | null;
}

export function PauseOverlay({
  waitingFor,
  expiresAt,
  resumesAt,
  kickable,
  vote,
  serverNow,
  onPropose,
  onVote,
  error
}: PauseOverlayProps) {
  const [folded, setFolded] = useState(false);
  const resumeIn = useCountdown(resumesAt, serverNow);
  const expiresIn = useCountdown(expiresAt, serverNow);
  const voteIn = useCountdown(vote?.closesAt ?? null, serverNow);

  /**
   * Also true when there is nobody left to name.
   *
   * The view is built at broadcast time and the pause is re-evaluated once a
   * second, so for up to a second after the last player reconnects the game is
   * still stopped while the list of who it is waiting for is already empty.
   * Reading that as "about to resume" is both true and better than rendering
   * "waiting for" followed by nothing.
   */
  const resuming = resumesAt !== null || waitingFor.length === 0;

  /**
   * Folding is the player's choice right up until the screen has something to
   * ask them. A vote is a question addressed to them, and the resume countdown
   * is the one number everybody has to see at the same time — neither may be
   * sitting behind a fold nobody remembered they had closed.
   */
  const demandsAttention = resuming || vote !== null;

  if (folded && !demandsAttention) {
    return (
      <div className="pz-banner" role="status">
        <span className="pz-spinner" aria-hidden="true" />
        <span>
          En pause · on attend <strong>{waitingFor.map((seat) => seat.label).join(', ')}</strong>
          {expiresAt !== null && ` · reprise dans ${expiresIn}s`}
        </span>
        <button type="button" className="pz-fold" onClick={() => setFolded(false)}>
          Détails
        </button>
      </div>
    );
  }

  return (
    <div className="pz-shade" role="alertdialog" aria-modal="true" aria-labelledby="pz-title">
      <div className={cx('pz-card', resuming && 'pz-card--resuming')}>
        {resuming ? (
          <>
            <h2 className="pz-title" id="pz-title">
              Tout le monde est là
            </h2>
            <p className="pz-lead">
              {resumesAt === null ? (
                'Reprise imminente'
              ) : (
                <>
                  Reprise dans <strong className="pz-big">{resumeIn}</strong>
                </>
              )}
            </p>
            <p className="pz-note">Le temps qui restait à la phase vous est rendu intact.</p>
          </>
        ) : (
          <>
            <h2 className="pz-title" id="pz-title">
              Partie en pause
            </h2>
            <p className="pz-lead">
              On attend <strong>{waitingFor.map((seat) => seat.label).join(', ')}</strong>
            </p>
            <ul className="pz-waiting">
              {waitingFor.map((seat) => (
                <li key={String(seat.id)}>
                  <span className="pz-spinner" aria-hidden="true" />
                  {seat.label}
                  <span className="pz-away">absent depuis {Math.round(seat.awayMs / 1000)}s</span>
                </li>
              ))}
            </ul>
            {expiresAt !== null && (
              <p className="pz-note">
                Sans retour, la partie reprend sans {waitingFor.length > 1 ? 'eux' : 'lui'} dans {expiresIn}s.
              </p>
            )}
          </>
        )}

        {vote ? (
          <div className="pz-vote">
            <p className="pz-vote-q">
              Continuer sans <strong>{vote.label}</strong> ?
            </p>
            <p className="pz-vote-tally">
              {vote.yes} pour · {vote.no} contre · {vote.needed > 0 ? `${vote.needed} de plus` : 'majorité atteinte'} ·{' '}
              {voteIn}s
            </p>
            {onVote && (
              <div className="pz-vote-buttons">
                <button
                  type="button"
                  className={cx('pz-btn', vote.mine === true && 'pz-btn--on')}
                  onClick={() => onVote(true)}
                >
                  Continuer
                </button>
                <button
                  type="button"
                  className={cx('pz-btn', vote.mine === false && 'pz-btn--on')}
                  onClick={() => onVote(false)}
                >
                  Attendre
                </button>
              </div>
            )}
          </div>
        ) : (
          onPropose &&
          kickable.length > 0 && (
            <div className="pz-vote">
              {/*
                Only ever offered once the absence has outlasted the delay, which
                is the point of the whole feature: for the first half-minute there
                is no button here at all, because most drops come back.
              */}
              <p className="pz-vote-q">Cette absence dure. Proposer de continuer sans&nbsp;:</p>
              <div className="pz-vote-buttons">
                {kickable.map((seat) => (
                  <button key={String(seat.id)} type="button" className="pz-btn" onClick={() => onPropose(seat.id)}>
                    {seat.label}
                  </button>
                ))}
              </div>
            </div>
          )
        )}

        {error && <p className="pz-error">{error}</p>}

        {!demandsAttention && (
          <button type="button" className="pz-fold pz-fold--card" onClick={() => setFolded(true)}>
            Réduire et parler
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The quiet version: somebody is wobbling, and nothing has stopped.
 *
 * A mark beside a name rather than a screen over the game. Most silences end
 * inside the resync window without ever becoming a pause, and interrupting four
 * people for each of them would make the pause itself unreadable.
 */
export function RecoveringMark({ label }: { label: string }) {
  return (
    <span className="pz-recovering" title={`${label} : reconnexion…`}>
      <span className="pz-spinner pz-spinner--small" aria-hidden="true" />
      <span className="pz-recovering-label">reconnexion…</span>
    </span>
  );
}
