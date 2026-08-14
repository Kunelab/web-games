import {
  GM_ORDERS,
  GM_UPGRADES,
  PROGRAM_LABELS,
  zombieDef,
  zombiesOfBiome,
  type CzActionAck,
  type CzJoinAck,
  type GmAction
} from 'coronaz-core';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import { useCountdown } from '../../hooks/useGameSocket';
import { useCzSocket } from '../../hooks/useCzSocket';
import { zombieSprite } from './czAssets';
import { neighbourRooms } from './czBoard';
import { Button, Loading } from '../../ui';
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
 * hero phase it is a spectator screen with perfect information.
 */
export default function CoronaZGm() {
  const { code = '' } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { socket, connected, view, error, serverNow, applyView } = useCzSocket();

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
        <CzEndScreen view={view} onExit={() => void navigate('/coronaz')} />
      </div>
    );
  }

  const myPhase = view.phase === 'enemy';
  const selectedZombie = selected ? view.zombies.find((zombie) => zombie.id === selected) : undefined;

  /** Rooms the selected zombie could step into, or spawn rooms when shopping. */
  const targets = new Set<string>();
  if (myPhase && selectedZombie && selectedZombie.ap > 0) {
    const room = view.rooms.find((candidate) => candidate.id === selectedZombie.roomId);
    if (room) {
      for (const next of neighbourRooms(view, room)) targets.add(next.id);
    }
  } else if (myPhase && !selectedZombie) {
    for (const room of view.rooms) {
      if (room.kind === 'spawn') targets.add(room.id);
    }
  }

  const heroesInSelectedRoom = selectedZombie
    ? view.heroes.some((hero) => hero.alive && !hero.escaped && hero.roomId === selectedZombie.roomId)
    : false;

  return (
    <div className="jeu-screen jeu-fixed cz-player">
      <header className="cz-gm-bar">
        <span className="play-label">MJ · {view.code}</span>
        {view.phaseEndsAt !== null && <span className="player-timer tabular">{remaining}</span>}
        {myPhase ? (
          <span className="cz-budget tabular">
            Budget : {view.gmBudget ?? 0}
            {view.gm && <span className="play-note"> (+{view.gm.income}/tour)</span>}
          </span>
        ) : (
          <span className="play-note">Les survivants jouent…</span>
        )}
      </header>

      <CzMap
        view={view}
        compact
        targetRooms={targets}
        selectedZombieId={selected}
        onZombieTap={myPhase ? (zombieId) => setSelected(selected === zombieId ? null : zombieId) : undefined}
        onRoomTap={
          myPhase
            ? (roomId) => {
                if (selectedZombie) {
                  void send({ type: 'gmMove', zombieId: selectedZombie.id, roomId });
                } else {
                  setSpawnRoom(roomId);
                }
              }
            : undefined
        }
      />

      <div className="cz-bottom">
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
              <Button variant="ghost" onClick={() => setSelected(null)}>
                Déselectionner
              </Button>
            </div>
            <p className="play-note">Touchez une salle en surbrillance pour le déplacer.</p>
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
                return (
                  <Button
                    key={def.id}
                    variant="secondary"
                    size="sm"
                    disabled={(view.gmBudget ?? 0) < def.cost}
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
            <p className="play-note">Les renforts n’agissent qu’à la prochaine phase.</p>
          </div>
        )}

        {myPhase && view.gm && (
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

        {myPhase && (
          <div className="cz-actions">
            <Button variant="primary" onClick={() => socket?.emit('cz:gmEnd', { gmToken })}>
              Finir la phase de la horde
            </Button>
          </div>
        )}

        {feedback && <p className="play-error">{feedback}</p>}
        {error && <p className="play-error">{error}</p>}
      </div>
    </div>
  );
}
