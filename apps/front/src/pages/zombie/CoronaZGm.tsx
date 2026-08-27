import {
  GM_ORDERS,
  GM_REWARD_ID,
  GM_UPGRADES,
  PROGRAM_LABELS,
  zombieDef,
  zombiesOfBiome,
  type CzActionAck,
  type CzJoinAck,
  type GmAction
} from 'coronaz-core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import { useCountdown } from '../../hooks/useGameSocket';
import { PauseOverlay } from '../../components/presence/PauseOverlay';
import { useCzSocket } from '../../hooks/useCzSocket';
import { zombieSprite } from './czAssets';
import { neighbourRooms } from './czBoard';
import { Button, Loading } from '../../ui';
import { CzEventBanner } from './CoronaZPlayer';
import { CzEndScreen } from './CoronaZTv';
import { CzMap } from './CzMap';
import './coronaz.css';
import '../play.css';

/**
 * The game master's phone: the horde's controller.
 *
 * Sees the whole board, no fog. During the enemy phase: tap a zombie to select
 * it, tap an adjacent room to walk it, "Mordre" when it stands among survivors,
 * and a spawn menu on the ☣️ rooms bounded by the per-turn budget. During the
 * hero phase it is a spectator screen with perfect information — and the log,
 * which is the only way to know what the survivors just did to you.
 *
 * Three things about this screen were wrong in ways only playing it shows, and
 * all three were about *quantity*. By turn eight the horde is thirty creatures
 * and the clock is forty-five seconds:
 *
 * 1. **Nothing said which creatures had already moved.** Action points were
 *    visible only on the selected one, so finding the ones still owed a turn meant
 *    tapping all thirty. They now carry their remaining points on the board and
 *    the spent ones grey out, and ⏭ walks the queue for you.
 * 2. **The panels grew past the bottom of the screen.** This screen is `100dvh`
 *    with `overflow: hidden` and the sheets stacked unbounded, so on a small phone
 *    "Finir la phase" — the single most important button here — was simply below
 *    the fold with no way to scroll to it. The dock scrolls now, the sheets are
 *    mutually exclusive, and the phase controls are pinned outside the scroll.
 * 3. **There was no way out but the clock or conceding.** ⏩ hands the rest of the
 *    horde to the server's own brain, which plays it exactly as AI mode would.
 */
export default function CoronaZGm() {
  const { code = '' } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { socket, connected, view, rewards, error, serverNow, applyView } = useCzSocket();

  // The token arrives once in the setup link, then lives in this phone.
  const [gmToken] = useState(() => {
    const fromUrl = params.get('jeton');
    if (fromUrl) sessionStorage.setItem(`kune.cz.gm.${code}`, fromUrl);
    return fromUrl ?? sessionStorage.getItem(`kune.cz.gm.${code}`) ?? '';
  });

  const [openError, setOpenError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [spawnRoom, setSpawnRoom] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [concedeAsked, setConcedeAsked] = useState(false);
  const [endAsked, setEndAsked] = useState(false);
  const [handedOver, setHandedOver] = useState(false);
  /** Which panel owns the dock. One at a time, so the dock cannot outgrow it. */
  const [panel, setPanel] = useState<'none' | 'upgrades' | 'log'>('none');

  // Re-attaches on every reconnect: a fresh socket knows nothing of the raid.
  useEffect(() => {
    if (!socket || !connected || !gmToken) return;
    socket
      .timeout(5000)
      .emitWithAck('cz:gmOpen', { code, gmToken })
      .then((ack: CzJoinAck) => {
        if (ack.ok) {
          if (ack.view) applyView(ack.view);
          setOpenError(null);
        } else {
          setOpenError(ack.error ?? 'Impossible d’ouvrir.');
        }
      })
      .catch(() => setOpenError('Le serveur ne répond pas.'));
  }, [socket, connected, gmToken, code, applyView]);

  const send = useCallback(
    async (action: GmAction) => {
      if (!socket) return;
      try {
        const result = (await socket.timeout(5000).emitWithAck('cz:gmAction', action)) as CzActionAck;
        setFeedback(result.ok ? null : (result.error ?? 'Impossible'));
      } catch {
        setFeedback('Le serveur ne répond pas');
      }
    },
    [socket]
  );

  const remaining = useCountdown(view?.phaseEndsAt ?? null, serverNow);

  /**
   * A new phase is a clean slate: no stale selection, no half-confirmed buttons,
   * and the hand-over flag cleared, or ⏩ would stay dead for the rest of the raid.
   *
   * Reset during render against a remembered marker rather than in an effect. It is
   * what React recommends for state that has to follow a prop, it is the idiom this
   * codebase already uses for the camera's viewport, and an effect here would land a
   * frame late — long enough to show the previous phase's confirmation on the new
   * phase's screen.
   */
  const marker = `${view?.phase ?? ''}:${view?.turn ?? 0}`;
  const [phaseMark, setPhaseMark] = useState(marker);
  if (phaseMark !== marker) {
    setPhaseMark(marker);
    setSelected(null);
    setSpawnRoom(null);
    setEndAsked(false);
    setConcedeAsked(false);
    setHandedOver(false);
    setPanel('none');
  }

  /** The horde's queue: who still owes a turn, in the order the server will take them. */
  const pending = useMemo(() => {
    if (!view || view.phase !== 'enemy') return [];
    return view.zombies.filter((zombie) => zombie.ap > 0).sort((a, b) => a.id.localeCompare(b.id));
  }, [view]);

  const spent = useMemo(
    () => new Set((view?.zombies ?? []).filter((zombie) => zombie.ap <= 0).map((zombie) => zombie.id)),
    [view]
  );

  if (!gmToken || openError) {
    return (
      <div className="jeu-screen jeu-center">
        <p className="play-note">{openError ?? 'Ce lien ne porte pas le jeton du maître du jeu.'}</p>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="jeu-screen jeu-center">
        <Loading label="Connexion…" />
      </div>
    );
  }

  if (view.phase === 'won' || view.phase === 'lost') {
    return (
      <div className="jeu-screen">
        <CzEndScreen view={view} rewards={rewards} meId={GM_REWARD_ID} onExit={() => void navigate('/coronaz')} />
      </div>
    );
  }

  const myPhase = view.phase === 'enemy';
  const selectedZombie = selected ? view.zombies.find((zombie) => zombie.id === selected) : undefined;

  /**
   * Everywhere the selected creature could reach with the points it has left — not
   * only next door.
   *
   * A tap is worth the whole walk now, so the board has to offer the whole walk: a
   * runner with two points shows two rooms of reach and gets there in one tap
   * instead of four. Breadth-first over the doorways, bounded by the action points,
   * which is exactly the rule the server applies.
   */
  const targets = new Set<string>();
  if (myPhase && selectedZombie && selectedZombie.ap > 0) {
    let frontier = [selectedZombie.roomId];
    for (let step = 0; step < selectedZombie.ap; step++) {
      const next: string[] = [];
      for (const id of frontier) {
        const room = view.rooms.find((candidate) => candidate.id === id);
        if (!room) continue;
        for (const other of neighbourRooms(view, room)) {
          if (other.id === selectedZombie.roomId || targets.has(other.id)) continue;
          targets.add(other.id);
          next.push(other.id);
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }
  } else if (myPhase && !selectedZombie) {
    for (const room of view.rooms) {
      if (room.kind === 'spawn') targets.add(room.id);
    }
  }

  const heroesInSelectedRoom = selectedZombie
    ? view.heroes.some((hero) => hero.alive && !hero.escaped && !hero.forfeited && hero.roomId === selectedZombie.roomId)
    : false;

  /** Selects the next creature that still owes a turn, and lets the camera find it. */
  function nextPending(): void {
    if (pending.length === 0) return;
    const at = pending.findIndex((zombie) => zombie.id === selected);
    const next = pending[(at + 1) % pending.length];
    if (next) {
      setSelected(next.id);
      setSpawnRoom(null);
    }
  }

  const affordable = zombiesOfBiome(view.biome).filter((def) => def.cost <= (view.gmBudget ?? 0)).length;

  return (
    <div className="jeu-screen jeu-fixed cz-player cz-gm">
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
      <header className="cz-gm-bar">
        <span className="play-label">MJ · {view.code}</span>
        {view.phaseEndsAt !== null && <span className="player-timer tabular">{remaining}</span>}
        {myPhase ? (
          <>
            <span className="cz-budget tabular">
              Budget : {view.gmBudget ?? 0}
              {view.gm && <span className="play-note"> (+{view.gm.income}/tour)</span>}
            </span>
            {/* How much of the horde still owes a turn: the number this screen was
                missing. Without it the phase has no visible end. */}
            <span className={`cz-gm-queue tabular ${pending.length === 0 ? 'done' : ''}`}>
              {pending.length === 0 ? '✓ horde jouée' : `🧟 ${pending.length} à jouer`}
            </span>
          </>
        ) : (
          <span className="play-note">Les survivants jouent…</span>
        )}
      </header>

      {view.event && <CzEventBanner id={view.event} />}

      <CzMap
        view={view}
        compact
        targetRooms={targets}
        selectedZombieId={selected}
        spentZombies={myPhase ? spent : undefined}
        // Selecting a creature the camera is not looking at is no help at all.
        focusRoomId={selectedZombie?.roomId ?? null}
        onZombieTap={myPhase ? (zombieId) => setSelected(selected === zombieId ? null : zombieId) : undefined}
        onRoomTap={
          myPhase
            ? (roomId) => {
                if (selectedZombie) {
                  void send({ type: 'gmMove', zombieId: selectedZombie.id, roomId });
                } else {
                  setSpawnRoom(roomId);
                  setPanel('none');
                }
              }
            : undefined
        }
      />

      {/*
       * The dock scrolls; the phase controls below it do not.
       *
       * This screen is `100dvh` with `overflow: hidden`, and these panels used to
       * stack unbounded inside it — so on a 360-wide phone the end-of-phase button
       * was under the fold with no scroll to reach it. The horde's most important
       * control was unreachable exactly when the horde was biggest.
       */}
      <div className="cz-bottom cz-gm-dock">
        {myPhase && selectedZombie && (
          <div className="cz-sheet">
            <span className="cz-slot-label">
              {zombieDef(selectedZombie.def).emoji} {zombieDef(selectedZombie.def).name} · {selectedZombie.ap} PA ·{' '}
              {selectedZombie.hp} PV
            </span>
            <div className="cz-actions">
              <Button
                variant="primary"
                disabled={!heroesInSelectedRoom || selectedZombie.ap <= 0}
                onClick={() => void send({ type: 'gmAttack', zombieId: selectedZombie.id })}
              >
                🦷 Mordre
              </Button>
              <Button variant="secondary" disabled={pending.length === 0} onClick={nextPending}>
                ⏭ Suivant
              </Button>
              <Button variant="ghost" onClick={() => setSelected(null)}>
                Déselectionner
              </Button>
            </div>
            <p className="play-note">
              {selectedZombie.ap > 0
                ? `Touchez une salle en surbrillance : jusqu’à ${selectedZombie.ap} d’un seul geste.`
                : 'Cette créature a fini son tour.'}
            </p>
          </div>
        )}

        {myPhase && spawnRoom && (
          <div className="cz-sheet">
            <span className="cz-slot-label">
              {/* The room's purpose reads better than its coordinates. */}
              Renfort · {PROGRAM_LABELS[view.rooms.find((room) => room.id === spawnRoom)?.program ?? 'storage']} —
              budget {view.gmBudget ?? 0}
            </span>
            <div className="cz-actions">
              {/* This world's bestiary, not every creature in the game. */}
              {zombiesOfBiome(view.biome).map((def) => {
                const sprite = zombieSprite(def.id);
                const tooDear = (view.gmBudget ?? 0) < def.cost;
                return (
                  <Button
                    key={def.id}
                    variant="secondary"
                    size="sm"
                    disabled={tooDear}
                    // Why it is grey, rather than leaving the phone to guess.
                    title={tooDear ? `${def.name} coûte ${def.cost} : il manque ${def.cost - (view.gmBudget ?? 0)}` : def.name}
                    onClick={() => {
                      void send({ type: 'gmSpawn', roomId: spawnRoom, def: def.id });
                      setSpawnRoom(null);
                    }}
                  >
                    {sprite ? <img className="cz-spawn-face" src={sprite} alt="" /> : def.emoji} {def.name} ({def.cost})
                  </Button>
                );
              })}
              <Button variant="ghost" size="sm" onClick={() => setSpawnRoom(null)}>
                Annuler
              </Button>
            </div>
            <p className="play-note">
              {affordable === 0
                ? 'Rien d’abordable ce tour : le budget se reporte.'
                : 'Les renforts n’agissent qu’à la prochaine phase.'}
            </p>
          </div>
        )}

        {myPhase && view.gm && panel === 'upgrades' && (
          <div className="cz-sheet">
            <span className="cz-slot-label">Évolutions de la horde · permanentes</span>
            <div className="cz-actions">
              {(['hide', 'claws'] as const).map((key) => {
                const upgrade = GM_UPGRADES[key];
                const level = view.gm?.upgrades[key] ?? 0;
                const maxed = level >= upgrade.maxLevel;
                const cost = maxed ? 0 : upgrade.cost(level);
                return (
                  <Button
                    key={key}
                    variant="secondary"
                    size="sm"
                    disabled={maxed || (view.gmBudget ?? 0) < cost}
                    onClick={() => void send({ type: 'gmUpgrade', upgrade: key })}
                  >
                    {upgrade.label} {maxed ? '· max' : `(${cost})`} {level > 0 ? `· niv. ${level}` : ''}
                  </Button>
                );
              })}
              <Button
                variant="secondary"
                size="sm"
                disabled={view.gm.rushUsed || (view.gmBudget ?? 0) < GM_ORDERS.rush.cost}
                onClick={() => void send({ type: 'gmOrder', order: 'rush' })}
              >
                {GM_ORDERS.rush.label} ({GM_ORDERS.rush.cost})
              </Button>
            </div>
          </div>
        )}

        {/* What the survivors just did. The log only ever existed on the television,
            which is the screen the game master is not holding — so the hero phase
            was spent watching tokens slide with no idea who searched what or who
            nearly died. It is the whole reason to care during their turn. */}
        {panel === 'log' && (
          <ul className="cz-log phone">
            {[...view.log].reverse().map((entry, index) => (
              <li key={`${entry.turn}-${index}`}>{entry.text}</li>
            ))}
          </ul>
        )}
      </div>

      {/* Pinned: never scrolls away, never grows. */}
      <div className="cz-gm-controls">
        <div className="cz-actions">
          {myPhase && (
            <Button variant="secondary" disabled={pending.length === 0} onClick={nextPending}>
              ⏭ Suivant{pending.length > 0 ? ` (${pending.length})` : ''}
            </Button>
          )}
          {myPhase && view.gm && (
            <Button
              variant={panel === 'upgrades' ? 'primary' : 'ghost'}
              onClick={() => setPanel(panel === 'upgrades' ? 'none' : 'upgrades')}
            >
              ⚒️ Évolutions
            </Button>
          )}
          <Button variant={panel === 'log' ? 'primary' : 'ghost'} onClick={() => setPanel(panel === 'log' ? 'none' : 'log')}>
            📜 Journal
          </Button>
        </div>

        {myPhase && (
          <div className="cz-actions">
            {/* Hand the rest to the server. Not a concession: the horde still plays,
                and plays well. */}
            <Button
              variant="secondary"
              disabled={handedOver || pending.length === 0}
              onClick={() => {
                setHandedOver(true);
                setSelected(null);
                socket?.emit('cz:gmAuto', { gmToken });
              }}
            >
              {handedOver ? '⏳ La horde se joue…' : `⏩ Laisser jouer (${pending.length})`}
            </Button>
            {/* Two taps, because a mistap here throws away the whole horde's turn —
                and it used to be one tap, directly above the concede button. */}
            <Button
              variant="primary"
              onClick={() => {
                if (endAsked || pending.length === 0) socket?.emit('cz:gmEnd', { gmToken });
                else setEndAsked(true);
              }}
            >
              {endAsked && pending.length > 0 ? `Finir avec ${pending.length} en réserve ?` : 'Finir la phase'}
            </Button>
          </div>
        )}

        {/* Conceding works in any phase: a game master who wants to stop should not
            have to wait for his turn to say so. */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (concedeAsked) void send({ type: 'gmForfeit' });
            else setConcedeAsked(true);
          }}
        >
          {concedeAsked ? 'Laisser la victoire aux survivants ?' : '🏳️ Abandonner la horde'}
        </Button>

        {feedback && <p className="play-error">{feedback}</p>}
        {error && <p className="play-error">{error}</p>}
      </div>
    </div>
  );
}
