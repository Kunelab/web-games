import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';

import { ChatPanel } from '../../components/chat/ChatPanel';
import { useMafiaSocket } from '../../hooks/useMafiaSocket';
import { Button, Field, Input, Loading } from '../../ui';
import { MafiaMap } from './MafiaMap';
import './mafia.css';

/**
 * The seat: everything a player does happens here — chat, votes, trials,
 * night powers. The same screen carries the host controls when the browser
 * holds the host token (the creator plays too; there is no separate console).
 */

const PHASE_LABELS: Record<string, string> = {
  lobby: 'Salle d’attente',
  day: 'Jour',
  night: 'Nuit',
  ended: 'Partie terminée'
};

export default function MafiaPlayer() {
  const { code: rawCode } = useParams();
  const code = (rawCode ?? '').toUpperCase();
  const { socket, connected, view, messages, rewards, error, serverNow, applyView } = useMafiaSocket();

  const [name, setName] = useState(() => localStorage.getItem(`mafia:name:${code}`) ?? '');
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [jailMode, setJailMode] = useState(false);
  const [will, setWill] = useState('');
  const [willOpen, setWillOpen] = useState(false);
  const [whisperSlot, setWhisperSlot] = useState('');
  const [whisperText, setWhisperText] = useState('');
  const [remaining, setRemaining] = useState<number | null>(null);

  const hostToken = sessionStorage.getItem(`mafia:host:${code}`);

  /** Auto-rejoin: a stored token proves the seat across refreshes. */
  useEffect(() => {
    const token = localStorage.getItem(`mafia:token:${code}`);
    const storedName = localStorage.getItem(`mafia:name:${code}`);
    if (!socket || !connected || view || !token || !storedName) return;
    socket.emit('mafia:join', { code, name: storedName, playerToken: token }, (ack) => {
      if (ack.ok && ack.view) applyView(ack.view);
    });
  }, [socket, connected, view, code, applyView]);

  /**
   * The wallet's local mirror. The server banks points under the account when
   * the browser is signed in and under the nickname otherwise; this copy is
   * only so an anonymous phone can show its balance without asking anyone.
   */
  useEffect(() => {
    if (!rewards || !view?.me) return;
    const mine = rewards.find((reward) => reward.playerId === view.me?.playerId);
    if (mine?.total != null) {
      localStorage.setItem('mafia:points', String(mine.total));
    }
  }, [rewards, view?.me]);

  /** The countdown every phone derives from the same server deadline. */
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

  // Leaving a phase resets the jailor's picker and clears transient errors.
  // Adjusted during render (React's recommended shape) rather than in an effect.
  const phaseKey = `${view?.phase ?? '-'}:${view?.stage ?? '-'}`;
  const [seenPhaseKey, setSeenPhaseKey] = useState(phaseKey);
  if (phaseKey !== seenPhaseKey) {
    setSeenPhaseKey(phaseKey);
    setJailMode(false);
    setActionError(null);
  }

  function join(event: FormEvent) {
    event.preventDefault();
    if (!socket || !name.trim()) return;
    setJoining(true);
    setJoinError(null);
    socket.emit('mafia:join', { code, name: name.trim() }, (ack) => {
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

  /** What clicking a house means right now, and which houses answer. */
  const targets = useMemo(() => {
    if (!view || !me?.alive) return new Set<number>();
    if (isNight && me.action) return new Set(me.action.targets);
    if (inDiscussion) {
      if (jailMode || view.day > 1) {
        return new Set(view.players.filter((p) => p.alive && p.slot !== me.slot).map((p) => p.slot));
      }
    }
    return new Set<number>();
  }, [view, me, isNight, inDiscussion, jailMode]);

  function onSelect(slot: number) {
    if (!socket || !me) return;
    setActionError(null);
    const fail = (ack: { ok: boolean; error?: string }) => {
      if (!ack.ok) setActionError(ack.error ?? 'Impossible');
    };
    if (isNight && me.action) {
      socket.emit('mafia:action', { targetSlot: me.actionTargetSlot === slot ? null : slot }, fail);
      return;
    }
    if (inDiscussion && jailMode) {
      socket.emit('mafia:dayAction', { type: 'jail', targetSlot: me.jailTargetSlot === slot ? null : slot }, fail);
      return;
    }
    if (inDiscussion) {
      socket.emit('mafia:vote', { targetSlot: me.voteTargetSlot === slot ? null : slot }, fail);
    }
  }

  function ballot(verdict: 'guilty' | 'innocent' | 'abstain') {
    socket?.emit('mafia:ballot', { verdict }, (ack) => {
      if (!ack.ok) setActionError(ack.error ?? 'Impossible');
    });
  }

  function saveWill() {
    socket?.emit('mafia:will', { text: will }, (ack) => {
      if (!ack.ok) setActionError(ack.error ?? 'Impossible');
      else setWillOpen(false);
    });
  }

  if (!connected && !view) return <Loading />;

  /* ------------------------------ join gate ------------------------------ */
  if (!view || !me) {
    return (
      <div className="mz-join">
        <h1 className="page-title">Mafia — table {code}</h1>
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

  const selectedSlot = isNight ? me.actionTargetSlot : jailMode ? me.jailTargetSlot : me.voteTargetSlot;
  const seats = view.players.length;

  return (
    <div className={isNight ? 'mz-screen mz-screen--night' : 'mz-screen'}>
      {/* ------------------------------ header ------------------------------ */}
      <header className="mz-header">
        <div>
          <span className="mz-phase">
            {view.phase === 'day' && view.stage === 'defense' && '⚖️ Défense'}
            {view.phase === 'day' && view.stage === 'judgement' && '⚖️ Jugement'}
            {view.phase === 'day' && view.stage === 'discussion' && `☀️ ${PHASE_LABELS.day} ${view.day}`}
            {view.phase === 'night' && `🌙 ${PHASE_LABELS.night} ${view.day}`}
            {view.phase === 'lobby' && PHASE_LABELS.lobby}
            {view.phase === 'ended' && PHASE_LABELS.ended}
          </span>
          {view.trial && <span className="mz-trial-name"> — {view.trial.name} à la barre</span>}
        </div>
        {remaining !== null && <span className="mz-timer">{remaining}s</span>}
      </header>

      {error && <p className="mz-error">{error}</p>}

      {/* ------------------------------- lobby ------------------------------ */}
      {view.phase === 'lobby' && (
        <section className="mz-lobby">
          <p>
            {seats}/{view.maxPlayers} joueurs. Partagez le code <strong>{code}</strong>.
          </p>
          {hostToken && (
            <div className="mz-host-controls">
              <Button
                variant="ghost"
                onClick={() => socket?.emit('mafia:addBots', { hostToken, count: view.maxPlayers - seats })}
                disabled={seats >= view.maxPlayers}
              >
                Compléter avec des bots ({view.maxPlayers - seats})
              </Button>
              <Button onClick={() => socket?.emit('mafia:start', { hostToken })} disabled={seats < view.minPlayers}>
                Lancer la partie
              </Button>
            </div>
          )}
        </section>
      )}

      {/* -------------------------------- map ------------------------------- */}
      <MafiaMap
        players={view.players}
        mySlot={me.slot}
        night={isNight}
        trialSlot={view.trial?.slot ?? null}
        targets={targets}
        selectedSlot={selectedSlot}
        onSelect={onSelect}
      />

      {/* ----------------------------- role card ---------------------------- */}
      {me.role && (
        <section className={`mz-role mz-role--${me.role.faction}`}>
          <div className="mz-role-head">
            <strong>{me.role.name}</strong>
            <span className="mz-role-faction">
              {me.role.faction === 'town' ? 'Ville' : me.role.faction === 'mafia' ? 'Mafia' : 'Neutre'}
            </span>
            {me.charges !== null && <span className="mz-charges">×{me.charges}</span>}
            {!me.alive && <span className="mz-dead-tag">MORT</span>}
          </div>
          <p className="mz-role-desc">{me.role.description}</p>
          {me.teammates && me.teammates.length > 0 && (
            <p className="mz-teammates">
              Complices : {me.teammates.map((t) => `${t.name} (${t.roleName})`).join(', ')}
            </p>
          )}
          {me.obsessionSlot !== null && <p className="mz-teammates">Obsession : maison {me.obsessionSlot}</p>}
        </section>
      )}

      {/* ---------------------------- action bar ---------------------------- */}
      {me.alive && view.phase !== 'ended' && (
        <section className="mz-actions">
          {isNight && me.jailed && <p className="mz-hint">🔒 Vous êtes en cellule. Parlez au Geôlier dans l’onglet Cellule.</p>}
          {isNight && me.action && (
            <p className="mz-hint">
              {me.action.targets.length > 0
                ? me.actionTargetSlot
                  ? `Cible choisie : maison ${me.actionTargetSlot}. Touchez-la pour annuler.`
                  : 'Choisissez une maison sur la carte.'
                : me.actionTargetSlot
                  ? 'Pouvoir armé pour cette nuit.'
                  : null}
              {me.action.targets.length === 0 && !me.actionTargetSlot && (
                <Button onClick={() => socket?.emit('mafia:action', { targetSlot: me.slot }, () => undefined)}>
                  {me.role?.id === 'veteran' ? 'Passer la nuit en alerte' : 'Enfiler le gilet'}
                </Button>
              )}
            </p>
          )}

          {inDiscussion && view.day > 1 && (
            <p className="mz-hint">
              {me.voteTargetSlot
                ? `Vous accusez la maison ${me.voteTargetSlot}. Touchez-la pour retirer.`
                : 'Touchez une maison pour accuser.'}
            </p>
          )}
          {inDiscussion && view.day <= 1 && <p className="mz-hint">Premier jour : on discute, on ne pend pas.</p>}

          {inDiscussion && me.role?.id === 'jailor' && (
            <Button variant="ghost" onClick={() => setJailMode((mode) => !mode)}>
              {jailMode
                ? 'Mode accusation'
                : me.jailTargetSlot
                  ? `🔒 Prisonnier ce soir : maison ${me.jailTargetSlot} (changer)`
                  : '🔒 Choisir un prisonnier pour ce soir'}
            </Button>
          )}

          {inDiscussion && me.role?.id === 'mayor' && (
            <Button variant="ghost" onClick={() => socket?.emit('mafia:dayAction', { type: 'reveal' }, () => undefined)}>
              🎗️ Se révéler Maire
            </Button>
          )}

          {view.phase === 'day' && view.stage === 'defense' && view.trial?.slot === me.slot && (
            <p className="mz-hint">C’est votre procès : défendez-vous dans le chat !</p>
          )}

          {inJudgement && view.trial?.slot !== me.slot && (
            <div className="mz-judgement">
              <Button className={me.ballot === 'guilty' ? 'mz-guilty mz-cast' : 'mz-guilty'} onClick={() => ballot('guilty')}>
                Coupable
              </Button>
              <Button
                className={me.ballot === 'innocent' ? 'mz-innocent mz-cast' : 'mz-innocent'}
                onClick={() => ballot('innocent')}
              >
                Innocent
              </Button>
              <Button variant="ghost" onClick={() => ballot('abstain')}>
                S’abstenir
              </Button>
            </div>
          )}

          {view.phase === 'day' && (
            <div className="mz-whisper">
              <select
                className="mz-whisper-target"
                value={whisperSlot}
                onChange={(event) => setWhisperSlot(event.target.value)}
              >
                <option value="">🤫 Murmurer à…</option>
                {view.players
                  .filter((player) => player.alive && player.slot !== me.slot)
                  .map((player) => (
                    <option key={player.slot} value={player.slot}>
                      {player.slot}. {player.name}
                    </option>
                  ))}
              </select>
              {whisperSlot && (
                <>
                  <input
                    className="mz-whisper-input"
                    value={whisperText}
                    maxLength={400}
                    placeholder="Entre nous… (la ville verra que vous chuchotez)"
                    onChange={(event) => setWhisperText(event.target.value)}
                  />
                  <Button
                    size="sm"
                    disabled={!whisperText.trim()}
                    onClick={() =>
                      socket?.emit('mafia:whisper', { targetSlot: Number(whisperSlot), text: whisperText.trim() }, (ack) => {
                        if (!ack.ok) setActionError(ack.error ?? 'Impossible de murmurer');
                        else setWhisperText('');
                      })
                    }
                  >
                    Envoyer
                  </Button>
                </>
              )}
            </div>
          )}

          <Button variant="ghost" onClick={() => setWillOpen((open) => !open)}>
            📜 Dernières volontés
          </Button>
          {willOpen && (
            <div className="mz-will">
              <textarea
                value={will}
                onChange={(event) => setWill(event.target.value)}
                maxLength={400}
                placeholder="Ce que la ville lira sur votre cadavre…"
              />
              <Button onClick={saveWill}>Sceller</Button>
            </div>
          )}
          {actionError && <p className="mz-error">{actionError}</p>}
        </section>
      )}

      {/* --------------------------- notifications -------------------------- */}
      {me.notifications.length > 0 && (
        <section className="mz-journal">
          {me.notifications.slice(-4).map((line, index) => (
            <p key={`${index}-${line.slice(0, 12)}`}>{line}</p>
          ))}
        </section>
      )}

      {/* ------------------------------ results ------------------------------ */}
      {view.phase === 'ended' && view.results && (
        <section className="mz-results">
          <h2>Fin de partie</h2>
          <table>
            <tbody>
              {view.results.map((row) => (
                <tr key={row.slot} className={row.winner ? 'mz-winner' : ''}>
                  <td>{row.slot}</td>
                  <td>
                    {row.name}
                    {row.isBot ? ' 🤖' : ''}
                  </td>
                  <td>{row.roleName}</td>
                  <td>{row.winner ? `🏆 ${row.winReason ?? ''}` : ''}</td>
                  <td>+{row.points} pts</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rewards && (
            <p className="mz-hint">
              {rewards
                .filter((reward) => reward.total !== null)
                .map((reward) => `${reward.name} : ${reward.total} pts au total`)
                .join(' · ') || 'Connectez-vous pour conserver vos points de partie en partie.'}
            </p>
          )}
        </section>
      )}

      {/* -------------------------------- chat ------------------------------- */}
      <ChatPanel
        messages={messages}
        channels={me.channels.map((channel) => ({ id: channel.id, label: channel.label, canWrite: channel.canWrite }))}
        onSend={(channel, text) =>
          socket?.emit('mafia:chat', { channel, text }, (ack) => {
            if (!ack.ok) setActionError(ack.error ?? 'Message refusé');
          })
        }
      />
    </div>
  );
}
