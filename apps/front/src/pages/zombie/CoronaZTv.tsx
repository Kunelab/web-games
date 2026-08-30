import { msg } from 'i18n';
import { heroDef, LAYOUTS, SCENARIO_LABELS, type CzJoinAck, type CzRaidReward, type CzView } from 'coronaz-core';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { api } from '../../api/client';
import { useCountdown } from '../../hooks/useGameSocket';
import { PauseOverlay } from '../../components/presence/PauseOverlay';
import { useCzSocket } from '../../hooks/useCzSocket';
import { buzzerOrigin } from '../../tools/api-url';
import { Button, Loading } from '../../ui';
import { awardMeta } from '../../app/awards';
import { useT } from '../../i18n/locale-context';
import { czLine } from './czLine';
import { CzEventBanner, MuteButton } from './CoronaZPlayer';
import { czGoals } from './czGoals';
import { CzMap } from './CzMap';
import { CzRewards } from './CzRewards';
import { sfxDefeat, sfxEscape, sfxHordePhase, sfxKill, sfxObjective } from './czSound';
import './coronaz.css';
import '../play.css';

/**
 * The television's ears: state diffs become sound. Kills thud, objectives
 * chime, the horde's phase growls, the ending sings or sinks. Kept out of the
 * component body so the effect reads as what it is — a reaction to the state.
 */
function useTvSounds(view: ReturnType<typeof useCzSocket>['view']) {
  const previous = useRef<{ phase: string; kills: number; objectivesDone: number } | null>(null);

  useEffect(() => {
    if (!view) return;
    const done = view.objectives.filter((objective) => objective.done).length;
    const last = previous.current;
    previous.current = { phase: view.phase, kills: view.killsTotal, objectivesDone: done };
    if (!last) return;

    if (view.killsTotal > last.kills) sfxKill();
    if (done > last.objectivesDone) sfxObjective();
    if (view.phase !== last.phase) {
      if (view.phase === 'enemy') sfxHordePhase();
      if (view.phase === 'won') sfxEscape();
      if (view.phase === 'lost') sfxDefeat();
    }
  }, [view]);
}

/**
 * The television: the shared board, readable from the sofa.
 *
 * It sees exactly what the team sees — the shared fog — so nobody has to look
 * away from it. All it adds is the meta the room wants at a glance: the phase,
 * the clock, the objective, everyone's health, and the log of what just bit whom.
 */
export default function CoronaZTv() {
  const t = useT();
  const { code = '' } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const { socket, connected, view, rewards, error, serverNow, applyView } = useCzSocket();

  const [hostToken] = useState(() => sessionStorage.getItem(`kune.cz.host.${code}`) ?? '');
  const [openError, setOpenError] = useState<string | null>(null);

  // Re-runs on every reconnect, not just the first: a fresh socket knows
  // nothing, so the television re-presents its token each time the line comes
  // back. Opening twice is harmless; staying detached is a frozen screen.
  useEffect(() => {
    if (!socket || !connected || !hostToken) return;

    socket
      .timeout(5000)
      .emitWithAck('cz:open', { code, hostToken })
      .then((ack: CzJoinAck) => {
        if (ack.ok) {
          // The ack carries the state; the server also pushes it. Either path
          // alone gets this screen off "Connexion à la partie…".
          if (ack.view) applyView(ack.view);
          setOpenError(null);
        } else {
          setOpenError(ack.error ?? t(msg('cz.tv.openFailed')));
        }
      })
      .catch(() => setOpenError(t(msg('cz.play.serverQuiet'))));
  }, [socket, connected, hostToken, code, applyView, t]);

  const remaining = useCountdown(view?.phaseEndsAt ?? null, serverNow);
  useTvSounds(view);

  if (!hostToken) {
    return (
      <div className="jeu-screen jeu-center">
        <p className="play-note">{t(msg('cz.tv.noToken'))}</p>
        <Button variant="secondary" onClick={() => void navigate('/coronaz')}>
          {t(msg('cz.tv.prepare'))}
        </Button>
      </div>
    );
  }

  if (openError) {
    return (
      <div className="jeu-screen jeu-center">
        <p className="play-note">{openError}</p>
        <Button variant="secondary" onClick={() => void navigate('/coronaz')}>
          Retour
        </Button>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="jeu-screen jeu-center">
        <Loading label={t(msg('cz.tv.connecting'))} />
      </div>
    );
  }

  const ended = view.phase === 'won' || view.phase === 'lost';

  return (
    <div className="jeu-screen jeu-fixed">
      {/*
        Shown here and resolvable only on a phone: this screen holds no seat, so
        the server refuses every mutation from it, a ballot included.
      */}
      {view.presence.paused && (
        <PauseOverlay
          waitingFor={view.presence.waitingFor.map((seat) => ({
            label: seat.name,
            id: seat.playerId,
            awayMs: seat.awayMs
          }))}
          expiresAt={view.presence.pauseExpiresAt}
          resumesAt={view.presence.resumesAt}
          kickable={[]}
          vote={
            view.presence.vote
              ? {
                  label: view.presence.vote.name,
                  closesAt: view.presence.vote.closesAt,
                  yes: view.presence.vote.yes,
                  no: view.presence.vote.no,
                  needed: view.presence.vote.needed,
                  mine: null
                }
              : null
          }
          serverNow={serverNow}
          onPropose={null}
          onVote={null}
        />
      )}
      <header className="host-top">
        <span className="host-code">{view.code}</span>
        <span className="host-progress tabular">
          Tour {view.turn} · {t(msg(SCENARIO_LABELS[view.scenario].name))}
          {/* Which world this is: the same scenario plays differently in a
              suburb and in a bunker, so the room should know which it got. */}
          {' · '}
          {LAYOUTS.find((layout) => layout.id === view.layout)?.name ?? view.layout}
        </span>
        <MuteButton />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void api.czEnd(code).finally(() => void navigate('/coronaz'));
          }}
        >
          Terminer
        </Button>
      </header>

      {/* The district's weather, on the screen the whole room is looking at. */}
      {view.event && <CzEventBanner id={view.event} />}

      {view.phase === 'lobby' && (
        <div className="host-lobby">
          <div className="stack-4" style={{ alignItems: 'center' }}>
            <p className="play-label">Rejoindre avec ce code</p>
            <p className="host-bigcode">{view.code}</p>
            <p className="play-note">{`${buzzerOrigin}/coronaz/rejoindre/${view.code}`}</p>
          </div>
          <div className="stack-4" style={{ alignItems: 'center' }}>
            <p className="play-label">{view.heroes.length} survivant(s) · 5 max</p>
            <ul className="player-chips">
              {view.heroes.map((hero) => (
                <li key={hero.playerId} className={hero.connected ? '' : 'away'}>
                  {heroDef(hero.heroId).emoji} {hero.name}
                  {hero.isBot && ' 🤖'}
                  {hero.isBot && (
                    <button
                      type="button"
                      className="chip-kick"
                      aria-label={`Retirer ${hero.name}`}
                      onClick={() => socket?.emit('cz:removeBot', { hostToken, playerId: hero.playerId })}
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>

            {/* Machine teammates: solo players raid with a full table. */}
            {view.heroes.length < 5 && (
              <div className="cz-actions">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => socket?.emit('cz:addBot', { hostToken, skill: 'expert' }, () => undefined)}
                >
                  + Bot expert
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => socket?.emit('cz:addBot', { hostToken, skill: 'newbie' }, () => undefined)}
                >
                  + Bot novice
                </Button>
              </div>
            )}

            <p className="cz-goal">{t(msg(SCENARIO_LABELS[view.scenario].goal))}</p>
            <p className="play-note">Graine du monde : {view.seed}</p>
            <Button
              variant="primary"
              size="lg"
              disabled={view.heroes.length === 0}
              onClick={() => socket?.emit('cz:start', { hostToken })}
            >
              Lancer le raid
            </Button>
          </div>
        </div>
      )}

      {(view.phase === 'heroes' || view.phase === 'enemy') && (
        <div className="cz-tv">
          {/* Nobody pans a television: it follows the survivors while they act
              and frames the whole floor once the horde starts moving. */}
          <CzMap view={view} camera="auto" />
          <aside className="cz-side">
            <div>
              <p className={`cz-phase ${view.phase === 'enemy' ? 'enemy' : ''}`}>
                {view.phase === 'heroes' ? 'Aux survivants' : 'La horde joue'}
              </p>
              {view.phaseEndsAt !== null && (
                <p className={`cz-timer tabular ${remaining <= 5 ? 'urgent' : ''}`}>{remaining}</p>
              )}
            </div>

            {/* One list: the keys, the side quests, the way out. The keys used to
                live in a sentence of their own and read as scenery. */}
            <ul className="cz-objectives">
              {czGoals(view).map((goal) => (
                <li key={goal.key} className={`${goal.done ? 'done' : ''} ${goal.primary ? 'primary' : ''}`}>
                  {goal.done ? '✔' : '▹'} {t(goal.label)}
                </li>
              ))}
            </ul>

            <ul className="cz-hero-list">
              {view.heroes.map((hero) => (
                <li key={hero.playerId} className={!hero.alive ? 'down' : hero.escaped || hero.forfeited ? 'out' : ''}>
                  <span>{heroDef(hero.heroId).emoji}</span>
                  <span>
                    {hero.name}
                    {hero.escaped ? ' · sorti' : ''}
                  </span>
                  <span className="cz-hp tabular">{hero.hp}❤</span>
                  <span className="cz-ap tabular">
                    {view.phase === 'heroes' && hero.alive && !hero.escaped && !hero.forfeited
                      ? hero.ready
                        ? t(msg('cz.tv.ready'))
                        : `${hero.ap} PA`
                      : ''}
                  </span>
                </li>
              ))}
            </ul>

            <ul className="cz-log">
              {[...view.log].reverse().map((entry, index) => (
                <li key={`${entry.turn}-${index}`}>{czLine(entry.text, t)}</li>
              ))}
            </ul>

            {/* The room's own voices, under the game's. Read-only: nobody types
                on a television, and everyone who could is holding a phone. */}
            {view.chat.length > 0 && (
              <ul className="cz-log cz-said">
                {[...view.chat]
                  .slice(-6)
                  .reverse()
                  .map((message) => (
                    <li key={message.id}>
                      <strong>{message.authorName}</strong> {message.text}
                    </li>
                  ))}
              </ul>
            )}
          </aside>
        </div>
      )}

      {ended && (
        <CzEndScreen
          view={view}
          rewards={rewards}
          onExit={() => void navigate('/coronaz')}
          // The television created the raid, so it holds the host token and is the
          // natural place for the room to ask for another one.
          onRematch={hostToken ? () => socket?.emit('cz:rematch', { hostToken }) : undefined}
        />
      )}

      {error && <p className="play-error">{error}</p>}
    </div>
  );
}

/**
 * Shared by the TV and the phones: verdict, scores, distinctions — and, since it
 * is the only screen anyone reads at the end of a raid, the career the raid fed
 * and the way back into another one.
 */
export function CzEndScreen({
  view,
  onExit,
  rewards,
  meId,
  onRematch
}: {
  view: CzView;
  onExit?: () => void;
  rewards?: CzRaidReward[] | null;
  meId?: string | null;
  /** Present on the device that created the raid: one tap back into another. */
  onRematch?: () => void;
}) {
  const t = useT();
  return (
    <div className="cz-end">
      <p className={`cz-verdict ${view.phase === 'won' ? 'won' : 'lost'}`}>
        {t(msg(view.phase === 'won' ? 'cz.tv.survived' : 'cz.tv.devoured'))}
      </p>
      {/* The seed is the rematch: same world, same dice, new decisions. */}
      <p className="play-note">
        {t(msg('cz.tv.seed', { turn: view.turn, seed: view.seed }))}
      </p>
      {/* Why the numbers are what they are: the table's own handicap, and the
          survivors who refused their perks. */}
      {view.mutations.length > 0 && (
        <p className="play-note">
          {t(msg('cz.tv.mutations', { count: view.mutations.length }))}
          {view.mutationReward.toFixed(2)}
        </p>
      )}

      <ol className="final-standings">
        {(view.scores ?? []).map((score, index) => (
          <li key={score.playerId}>
            <span className="rank tabular">{index + 1}</span>
            <span className="score-name">
              {heroDef(score.heroId).emoji} {score.name}
              {!score.alive && ' 💀'}
              {score.escaped && ' 🚪'}
              {score.forfeited && <span title={t(msg('cz.tv.forfeited'))}> 🏳️</span>}
              {score.bareHanded && <span title="Aucun atout choisi : +12 pts"> 🙌</span>}
            </span>
            <span className="score-value tabular">{score.score} pts</span>
          </li>
        ))}
      </ol>

      {(view.awards ?? []).length > 0 && (
        <ul className="awards">
          {(view.awards ?? []).map((award) => {
            const meta = awardMeta(award.key);
            return (
              <li key={award.key}>
                <span className="award-emoji" aria-hidden="true">
                  {meta.emoji}
                </span>
                <span className="award-title">{t(msg(meta.titleKey))}</span>
                <span className="award-holder">{award.playerName}</span>
                <span className="award-value">{award.value}</span>
              </li>
            );
          })}
        </ul>
      )}

      {/* What the evening paid. Below the scoreboard, because the verdict is what
          the room shouts about and this is what it takes home. */}
      {rewards && rewards.length > 0 && <CzRewards rewards={rewards} meId={meId ?? null} />}

      <div className="cz-actions">
        {/* Another raid, same settings, same table, same code.
            A rematch used to mean walking back through setup, re-creating a game,
            re-reading the code out, everybody re-joining and re-picking a character
            and a loadout — after every thirty-minute raid. That friction is the
            reason an evening stops at three games rather than five. */}
        {onRematch && (
          <Button variant="primary" size="lg" onClick={onRematch}>
            {t(msg('cz.tv.again'))}
          </Button>
        )}
        {onExit && (
          <Button variant="secondary" onClick={onExit}>
            Retour
          </Button>
        )}
      </div>
    </div>
  );
}
