import {
  ACTION_LABELS,
  FACTION_LABELS,
  SELF_FIRES,
  type MafiaPublicPlayer,
  type MafiaViewMe
} from 'mafia-core';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';

import { ChatPanel } from '../../components/chat/ChatPanel';
import { PauseOverlay, RecoveringMark } from '../../components/presence/PauseOverlay';
import { useHeartbeat } from '../../hooks/useHeartbeat';
import { useMafiaSocket } from '../../hooks/useMafiaSocket';
import { useCountdown } from '../../hooks/useServerClock';
import { cx } from '../../ui/cx';
import { Button, Field, Input, Loading } from '../../ui';
import { QuickEnd } from '../../ui/QuickEnd';
import { msg } from 'i18n';

import { useLocale } from '../../i18n/locale-context';
import { MafiaTown } from './MafiaTown';
import './mafia.css';

/**
 * The seat. Everything a player does happens here.
 *
 * Built around one decision: **the player list is the game**. Every action this
 * game has is aimed at a person, so every action lives on that person's row —
 * "Accuser" beside a name by day, "Soigner" beside the same name by night. One
 * place to look, one kind of thing to press, a label you can actually read.
 *
 * What that replaces: an un-zoomable isometric map that was simultaneously the
 * scoreboard, the roster and the only way to target anything, at six pixels a
 * name on a phone. The town is still there — above, as scenery — but it takes no
 * input at all now, which is also how the whole board stopped being unreachable
 * from a keyboard: these are real buttons in a real list.
 *
 * The remaining three surfaces are the chat (which in a Mafia game *is* the
 * gameplay, so it gets the room), the phase clock, and one row of controls that
 * only appear when they apply.
 *
 * Host controls ride on this same screen when the browser holds the host token:
 * the creator plays like everybody else, there is no separate console.
 */

/** Not every night power names a person; these are aimed at your own house. */
function selfOnly(me: MafiaViewMe): boolean {
  return !!me.action && me.action.targets.length === 0;
}

interface RowAction {
  label: string;
  /** Pressing again clears the choice, so the label flips. */
  chosen: boolean;
  run: () => void;
}

export default function MafiaPlayer() {
  const { code: rawCode } = useParams();
  const code = (rawCode ?? '').toUpperCase();
  const { socket, connected, view, messages, rewards, error, serverNow, applyView } = useMafiaSocket();
  const { t, locale } = useLocale();

  const [name, setName] = useState(() => localStorage.getItem(`mafia:name:${code}`) ?? '');
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [jailMode, setJailMode] = useState(false);
  const [willOpen, setWillOpen] = useState(false);
  const [will, setWill] = useState('');
  const [whisperTo, setWhisperTo] = useState<number | null>(null);
  const [whisperText, setWhisperText] = useState('');

  /** The countdown every phone derives from the same server deadline. */
  const remaining = useCountdown(view?.phaseEndsAt ?? null, serverNow);

  const hostToken = sessionStorage.getItem(`mafia:host:${code}`);

  /**
   * Reclaims the seat with the stored token, on a refresh and on every reconnect.
   *
   * The connection is not the seat. A socket that drops and comes back past
   * socket.io's recovery window is a new connection as far as the server is
   * concerned, so it no longer knows which table this phone belongs to: the token
   * has to be re-presented, or the seat is silently detached — receiving no state
   * and able to do nothing. This used to be gated on `!view`, so it ran on a
   * refresh and never on a reconnect, which is the one case it exists for.
   */
  const reclaim = useCallback(() => {
    const token = localStorage.getItem(`mafia:token:${code}`);
    const storedName = localStorage.getItem(`mafia:name:${code}`);
    if (!socket || !token || !storedName) return;
    socket.emit('mafia:join', { code, name: storedName, playerToken: token, locale }, (ack) => {
      if (ack.ok && ack.view) applyView(ack.view);
      // The room voted to carry on without this phone: the token is spent, and
      // saying so beats a screen that silently never updates again.
      else if (ack.error) setJoinError(ack.error);
    });
  }, [socket, code, locale, applyView]);

  useEffect(() => {
    if (!socket || !connected) return;
    reclaim();
  }, [socket, connected, reclaim]);

  /**
   * The heartbeat, and the resync that rides with it.
   *
   * Seated phones only: a screen with no seat has no presence to report. See
   * `useHeartbeat` for why an open socket is not the same as a present player.
   */
  const beat = useCallback(() => socket?.emit('mafia:beat'), [socket]);
  useHeartbeat({ connected, seated: view?.me != null, beat, onReconnect: reclaim });

  const proposeKick = useCallback(
    (slot: string | number) => {
      setActionError(null);
      socket?.emit('mafia:kick', { type: 'propose', targetSlot: Number(slot) }, (ack) => {
        if (!ack.ok) setActionError(ack.error ?? 'Impossible');
      });
    },
    [socket]
  );

  const voteKick = useCallback(
    (yes: boolean) => {
      setActionError(null);
      socket?.emit('mafia:kick', { type: 'vote', yes }, (ack) => {
        if (!ack.ok) setActionError(ack.error ?? 'Impossible');
      });
    },
    [socket]
  );

  /**
   * The wallet's local mirror, so an anonymous phone can show its balance.
   * The server banks under the account when signed in, the nickname otherwise.
   */
  useEffect(() => {
    if (!rewards || !view?.me) return;
    const mine = rewards.find((reward) => reward.playerId === view.me?.playerId);
    if (mine?.total != null) localStorage.setItem('mafia:points', String(mine.total));
  }, [rewards, view?.me]);

  /**
   * The sealed will, mirrored locally so the editor opens showing what is
   * actually on file. It used to open blank every time and accept the blank on
   * save, so checking your own will was how you deleted it.
   */
  const sealed = view?.me?.lastWill ?? '';
  const [seenSealed, setSeenSealed] = useState(sealed);
  if (sealed !== seenSealed) {
    setSeenSealed(sealed);
    setWill(sealed);
  }

  // Leaving a phase resets the jailor's picker and clears transient errors.
  // Adjusted during render (React's recommended shape) rather than in an effect.
  const phaseKey = `${view?.phase ?? '-'}:${view?.stage ?? '-'}`;
  const [seenPhaseKey, setSeenPhaseKey] = useState(phaseKey);
  if (phaseKey !== seenPhaseKey) {
    setSeenPhaseKey(phaseKey);
    setJailMode(false);
    setActionError(null);
    setWhisperTo(null);
  }

  function join(event: FormEvent) {
    event.preventDefault();
    if (!socket || !name.trim()) return;
    setJoining(true);
    setJoinError(null);
    socket.emit('mafia:join', { code, name: name.trim(), locale }, (ack) => {
      setJoining(false);
      if (!ack.ok || !ack.view) {
        setJoinError(ack.error ?? 'Impossible de rejoindre');
        return;
      }
      localStorage.setItem(`mafia:token:${code}`, ack.playerToken ?? '');
      localStorage.setItem(`mafia:name:${code}`, name.trim());
      applyView(ack.view);
    });
  }

  const me = view?.me ?? null;
  const isNight = view?.phase === 'night';
  const inDiscussion = view?.phase === 'day' && view.stage === 'discussion';
  const inJudgement = view?.phase === 'day' && view.stage === 'judgement';
  const inDefense = view?.phase === 'day' && view.stage === 'defense';
  const canVote = inDiscussion && (view?.day ?? 0) > 1;

  const fail = (ack: { ok: boolean; error?: string }) => {
    if (!ack.ok) setActionError(ack.error ?? 'Impossible');
    else setActionError(null);
  };

  /**
   * What the button on one player's row says and does, right now.
   *
   * One function so the list has exactly one shape whatever the phase: the row
   * either offers something or it does not, and the verb comes from the role's
   * own power rather than from a generic "confirmer".
   */
  function rowAction(player: MafiaPublicPlayer): RowAction | null {
    if (!socket || !me?.alive || !player.alive) return null;

    if (isNight) {
      if (!me.action || me.jailed) return null;
      const mine = selfOnly(me);
      const reachable = mine ? player.slot === me.slot : me.action.targets.includes(player.slot);
      if (!reachable) return null;
      const chosen = me.actionTargetSlot === player.slot;
      // Pointing the match at your own house is a different sentence from
      // pointing it at somebody else's.
      const verb =
        player.slot === me.slot && SELF_FIRES[me.action.type]
          ? SELF_FIRES[me.action.type]!
          : ACTION_LABELS[me.action.type];
      return {
        label: chosen ? 'Annuler' : verb,
        chosen,
        run: () => socket.emit('mafia:action', { targetSlot: chosen ? null : player.slot }, fail)
      };
    }

    if (inDiscussion && jailMode && me.role?.id === 'jailor') {
      if (player.slot === me.slot) return null;
      const chosen = me.jailTargetSlot === player.slot;
      return {
        label: chosen ? 'Relâcher' : 'Emprisonner',
        chosen,
        run: () => socket.emit('mafia:dayAction', { type: 'jail', targetSlot: chosen ? null : player.slot }, fail)
      };
    }

    if (canVote) {
      if (player.slot === me.slot) return null;
      const chosen = me.voteTargetSlot === player.slot;
      return {
        label: chosen ? 'Retirer' : 'Accuser',
        chosen,
        run: () => socket.emit('mafia:vote', { targetSlot: chosen ? null : player.slot }, fail)
      };
    }

    return null;
  }

  /** One sentence saying what this phase wants from you. */
  const prompt = useMemo(() => {
    if (!view || !me) return null;
    if (view.phase === 'lobby') return 'En attente : l’hôte lance la partie quand la table est prête.';
    if (view.phase === 'ended') return null;
    if (!me.alive) return 'Vous êtes mort. Le cimetière vous écoute, la ville ne vous entend plus.';
    if (isNight) {
      if (me.jailed) return '🔒 En cellule pour la nuit. Parlez au Geôlier dans l’onglet Cellule.';
      if (!me.action) return 'La nuit passe. Vous n’avez rien à jouer — écoutez.';
      if (selfOnly(me)) return `Votre pouvoir se joue chez vous : « ${ACTION_LABELS[me.action.type]} » sur votre ligne.`;
      return `Choisissez votre cible : « ${ACTION_LABELS[me.action.type]} » sur la ligne de quelqu’un.`;
    }
    if (inDefense) {
      return view.trial?.slot === me.slot
        ? 'C’est votre procès. Vous seul avez la parole : défendez-vous dans le chat.'
        : `${view.trial?.name ?? 'L’accusé'} se défend. La ville écoute.`;
    }
    if (inJudgement) {
      return view.trial?.slot === me.slot ? 'La ville vote sur votre sort.' : 'Rendez votre verdict.';
    }
    if (jailMode) return 'Désignez le prisonnier de ce soir.';
    if (canVote) return 'Discutez, puis accusez qui vous voulez voir à la barre.';
    return 'Premier jour : on parle, on ne pend pas. Faites-vous des amis.';
  }, [view, me, isNight, inDefense, inJudgement, jailMode, canVote]);

  if (!connected && !view) return <Loading />;

  /* ------------------------------- join gate ------------------------------- */
  if (!view || !me) {
    return (
      <div className="mz-join">
        <h1 className="mz-join-title">Mafia</h1>
        <p className="mz-join-code">Table {code}</p>
        {error && <p className="mz-error">{error}</p>}
        <form onSubmit={join} className="mz-join-form">
          <Field label="Votre nom">
            {({ id }) => (
              <Input id={id} value={name} onChange={(event) => setName(event.target.value)} maxLength={20} autoFocus />
            )}
          </Field>
          <Button type="submit" disabled={joining || !name.trim()}>
            {joining ? 'Connexion…' : 'Prendre place'}
          </Button>
          {joinError && <p className="mz-error">{joinError}</p>}
        </form>
      </div>
    );
  }

  const seats = view.players.length;
  const alive = view.players.filter((player) => player.alive).length;
  // The sash is public, so my own row is the honest source for "already out".
  const iAmRevealed = view.players.some((player) => player.slot === me.slot && player.revealedMayor);

  const pause = view.presence;

  return (
    <div className={isNight ? 'mz-screen mz-screen--night' : 'mz-screen'}>
      {/*
        The pause sits over everything. Every action the server exposes already
        refuses while the table is stopped, so this is not the guard — it is the
        explanation, which is the part a frozen clock cannot give by itself.
      */}
      {pause.paused && (
        <PauseOverlay
          waitingFor={pause.waitingFor.map((seat) => ({
            label: `${seat.name} (maison ${seat.slot})`,
            id: seat.slot,
            awayMs: seat.awayMs
          }))}
          expiresAt={pause.pauseExpiresAt}
          resumesAt={pause.resumesAt}
          kickable={pause.waitingFor
            .filter((seat) => pause.kickableSlots.includes(seat.slot))
            .map((seat) => ({ label: `${seat.name} (maison ${seat.slot})`, id: seat.slot, awayMs: seat.awayMs }))}
          vote={
            pause.vote
              ? {
                  label: `${pause.vote.name} (maison ${pause.vote.slot})`,
                  closesAt: pause.vote.closesAt,
                  yes: pause.vote.yes,
                  no: pause.vote.no,
                  needed: pause.vote.needed,
                  mine: pause.vote.mine
                }
              : null
          }
          serverNow={serverNow}
          onPropose={proposeKick}
          onVote={voteKick}
          error={actionError}
        />
      )}

      {/* ------------------------------- header ------------------------------- */}
      <header className="mz-header">
        <span className="mz-phase">
          {view.phase === 'lobby' && 'Salle d’attente'}
          {view.phase === 'day' && `☀️ Jour ${view.day}`}
          {view.phase === 'night' && `🌙 Nuit ${view.day}`}
          {view.phase === 'ended' && 'Partie terminée'}
        </span>
        {inDefense && <span className="mz-stage">⚖️ Défense</span>}
        {inJudgement && <span className="mz-stage">⚖️ Jugement</span>}
        <span className="mz-alive">{alive} en vie</span>
        {view.phaseEndsAt !== null && (
          <span className={remaining <= 10 ? 'mz-timer mz-timer--urgent' : 'mz-timer'}>{remaining}s</span>
        )}
      </header>

      <div className="mz-body">
        <div className="mz-left">
          {/* ------------------------------ scenery ----------------------------- */}
          <MafiaTown
            players={view.players}
            mySlot={me.slot}
            night={isNight}
            onTrial={view.trial !== null}
          />

          {/* ------------------------------- lobby ------------------------------ */}
          {view.phase === 'lobby' && (
            <section className="mz-panel">
              <p className="mz-lobby-count">
                {seats} / {view.maxPlayers} joueurs · code <strong>{code}</strong>
              </p>
              {hostToken && (
                <div className="mz-row-actions">
                  <Button
                    variant="ghost"
                    onClick={() => socket?.emit('mafia:addBots', { hostToken, count: 4 })}
                    disabled={seats >= view.maxPlayers}
                  >
                    + 4 bots
                  </Button>
                  <Button onClick={() => socket?.emit('mafia:start', { hostToken })} disabled={seats < view.minPlayers}>
                    Lancer la partie
                  </Button>
                </div>
              )}
            </section>
          )}

          {/* ----------------------------- role card ---------------------------- */}
          {me.role && (
            <section className={`mz-role mz-role--${me.role.faction}`}>
              <div className="mz-role-head">
                <strong className="mz-role-name">{me.role.name}</strong>
                <span className="mz-role-faction">{FACTION_LABELS[me.role.faction]}</span>
                {me.charges !== null && <span className="mz-charges">{me.charges} restant(s)</span>}
                {!me.alive && <span className="mz-dead-tag">Mort</span>}
              </div>
              <p className="mz-role-desc">{me.role.description}</p>
              {me.teammates && me.teammates.length > 0 && (
                <p className="mz-role-note">
                  Avec vous : {me.teammates.map((mate) => `${mate.slot}. ${mate.name} (${mate.roleName})`).join(' · ')}
                </p>
              )}
              {me.obsessionSlot !== null && <p className="mz-role-note">Votre obsession : maison {me.obsessionSlot}</p>}
            </section>
          )}

          {/* ------------------------------ prompt ------------------------------ */}
          {prompt && <p className="mz-prompt">{prompt}</p>}
          {actionError && <p className="mz-error">{actionError}</p>}
          {error && <p className="mz-error">{error}</p>}

          {/* ---------------------------- the players --------------------------- */}
          <section className="mz-panel mz-players" aria-label="Les joueurs">
            <ul>
              {view.players.map((player) => {
                const action = rowAction(player);
                const isMe = player.slot === me.slot;
                const onTrial = player.onTrial;
                const canWhisper =
                  view.phase === 'day' && me.alive && player.alive && !isMe && whisperTo !== player.slot;

                return (
                  <li
                    key={player.slot}
                    className={cx(
                      'mz-seat',
                      !player.alive && 'mz-seat--dead',
                      isMe && 'mz-seat--me',
                      onTrial && 'mz-seat--trial'
                    )}
                  >
                    <span className="mz-seat-no">{player.slot}</span>

                    <span className="mz-seat-id">
                      <span className="mz-seat-name">
                        {player.name}
                        {player.isBot && <span className="mz-flag" title="Bot"> 🤖</span>}
                        {player.revealedMayor && <span className="mz-flag" title="Révélé"> 🎗️</span>}
                        {!player.connected && player.alive && (
                          <span className="mz-flag mz-flag--away" title="Déconnecté"> ⚪</span>
                        )}
                        {isMe && <span className="mz-seat-you">vous</span>}
                        {/* Wobbling, not waited on: a mark, never an overlay. */}
                        {view.presence.waitingFor.every((seat) => seat.slot !== player.slot) &&
                          view.presence.recovering.some((seat) => seat.slot === player.slot) && (
                            <RecoveringMark label={player.name} />
                          )}
                      </span>
                      <span className="mz-seat-sub">
                        {!player.alive && (
                          <>
                            {/* The role, in its camp's colour — or as much of it as the
                                table's reveal policy allows. */}
                            <span className={`mz-fac mz-fac--${player.faction ?? 'hidden'}`}>
                              {player.roleName ??
                                (player.faction ? FACTION_LABELS[player.faction] : 'Identité inconnue')}
                            </span>
                            {player.death && ` · ${t(msg('mafia.roster.diedOn', { cause: player.death.cause, day: player.death.day }))}`}
                          </>
                        )}
                        {player.alive && onTrial && 'À la barre'}
                        {player.alive && !onTrial && player.votedSlot !== null && `accuse la maison ${player.votedSlot}`}
                      </span>
                    </span>

                    {player.alive && player.votesAgainst > 0 && (
                      <span className="mz-votes" title={`${player.votesAgainst} voix contre`}>
                        {player.votesAgainst}
                      </span>
                    )}

                    <span className="mz-seat-actions">
                      {canWhisper && (
                        <button
                          type="button"
                          className="mz-icon-btn"
                          title={`Murmurer à ${player.name}`}
                          onClick={() => setWhisperTo(player.slot)}
                        >
                          🤫
                        </button>
                      )}
                      {action && (
                        <button
                          type="button"
                          className={action.chosen ? 'mz-act mz-act--chosen' : 'mz-act'}
                          onClick={action.run}
                        >
                          {action.label}
                        </button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* ---------------------------- the controls --------------------------- */}
          {view.phase !== 'ended' && (
            <section className="mz-panel mz-controls">
              {inJudgement && me.alive && view.trial?.slot !== me.slot && (
                <div className="mz-verdict">
                  <button
                    type="button"
                    className={me.ballot === 'guilty' ? 'mz-guilty mz-cast' : 'mz-guilty'}
                    onClick={() => socket?.emit('mafia:ballot', { verdict: 'guilty' }, fail)}
                  >
                    Coupable
                  </button>
                  <button
                    type="button"
                    className={me.ballot === 'innocent' ? 'mz-innocent mz-cast' : 'mz-innocent'}
                    onClick={() => socket?.emit('mafia:ballot', { verdict: 'innocent' }, fail)}
                  >
                    Innocent
                  </button>
                  <button
                    type="button"
                    className="mz-abstain"
                    onClick={() => socket?.emit('mafia:ballot', { verdict: 'abstain' }, fail)}
                  >
                    S’abstenir
                  </button>
                </div>
              )}

              <div className="mz-row-actions">
                {inDiscussion && me.alive && me.role?.id === 'jailor' && (
                  <Button variant="ghost" onClick={() => setJailMode((mode) => !mode)}>
                    {jailMode
                      ? '↩︎ Revenir aux accusations'
                      : me.jailTargetSlot
                        ? `🔒 Prisonnier : maison ${me.jailTargetSlot}`
                        : '🔒 Choisir un prisonnier'}
                  </Button>
                )}

                {inDiscussion && me.alive && me.role?.id === 'mayor' && !iAmRevealed && (
                  <Button variant="ghost" onClick={() => socket?.emit('mafia:dayAction', { type: 'reveal' }, fail)}>
                    🎗️ Se révéler Maire
                  </Button>
                )}

                {me.alive && (
                  <Button variant="ghost" onClick={() => setWillOpen((open) => !open)}>
                    📜 Dernières volontés{sealed ? ' ✓' : ''}
                  </Button>
                )}
              </div>

              {willOpen && me.alive && (
                <div className="mz-will">
                  <label className="mz-will-label" htmlFor="mz-will-text">
                    Ce que la ville lira sur votre cadavre
                  </label>
                  <textarea
                    id="mz-will-text"
                    value={will}
                    onChange={(event) => setWill(event.target.value)}
                    maxLength={400}
                    rows={3}
                  />
                  <div className="mz-row-actions">
                    <Button
                      onClick={() =>
                        socket?.emit('mafia:will', { text: will }, (ack) => {
                          fail(ack);
                          if (ack.ok) setWillOpen(false);
                        })
                      }
                    >
                      Sceller
                    </Button>
                    <Button variant="ghost" onClick={() => { setWill(sealed); setWillOpen(false); }}>
                      Annuler
                    </Button>
                  </div>
                </div>
              )}

              {whisperTo !== null && (
                <div className="mz-whisper">
                  <label className="mz-will-label" htmlFor="mz-whisper-text">
                    🤫 À {view.players.find((player) => player.slot === whisperTo)?.name} — la ville verra que vous
                    chuchotez
                  </label>
                  <div className="mz-whisper-row">
                    <input
                      id="mz-whisper-text"
                      value={whisperText}
                      maxLength={400}
                      autoFocus
                      onChange={(event) => setWhisperText(event.target.value)}
                    />
                    <Button
                      size="sm"
                      disabled={!whisperText.trim()}
                      onClick={() =>
                        socket?.emit('mafia:whisper', { targetSlot: whisperTo, text: whisperText.trim() }, (ack) => {
                          fail(ack);
                          if (ack.ok) {
                            setWhisperText('');
                            setWhisperTo(null);
                          }
                        })
                      }
                    >
                      Envoyer
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setWhisperTo(null)}>
                      ✕
                    </Button>
                  </div>
                </div>
              )}
            </section>
          )}

          {/* --------------------------- private feed --------------------------- */}
          {me.notifications.length > 0 && (
            <section className="mz-panel mz-journal" aria-label="Vos informations privées">
              {me.notifications
                .slice(-5)
                .reverse()
                .map((line, index) => (
                  <p key={`${index}-${line.slice(0, 16)}`}>{line}</p>
                ))}
            </section>
          )}

          {/* ------------------------------ results ----------------------------- */}
          {view.phase === 'ended' && view.results && (
            <section className="mz-panel mz-results">
              <h2>Les masques tombent</h2>
              <div className="mz-results-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">Joueur</th>
                      <th scope="col">Rôle</th>
                      <th scope="col">Issue</th>
                      <th scope="col">Points</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.results.map((row) => (
                      <tr key={row.slot} className={row.winner ? 'mz-winner' : ''}>
                        <td>{row.slot}</td>
                        <td>
                          {row.name}
                          {row.isBot ? ' 🤖' : ''}
                        </td>
                        <td>{row.roleName}</td>
                        <td>{row.winner ? `🏆 ${row.winReason ?? ''}` : '—'}</td>
                        <td className="mz-num">+{row.points}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rewards && (
                <p className="mz-role-note">
                  {rewards
                    .filter((reward) => reward.total !== null)
                    .map((reward) => `${reward.name} : ${reward.total} pts au total`)
                    .join(' · ') || 'Connectez-vous pour conserver vos points de partie en partie.'}
                </p>
              )}
              <QuickEnd code={code} fallbackGame="mafia" />
            </section>
          )}
        </div>

        {/* -------------------------------- chat -------------------------------- */}
        <div className="mz-right">
          <ChatPanel
            messages={messages}
            channels={me.channels}
            onSend={(channel, text) => socket?.emit('mafia:chat', { channel, text }, fail)}
            placeholder={me.alive ? 'Parlez…' : 'Les morts murmurent entre eux…'}
          />
        </div>
      </div>
    </div>
  );
}
