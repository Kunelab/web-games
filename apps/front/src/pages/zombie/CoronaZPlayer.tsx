import {
  gearStats,
  HEROES,
  itemDef,
  RARITY_META,
  roleOf,
  torchReach,
  vestCharges,
  weaponStats,
  type CzActionAck,
  type CzJoinAck,
  type CzView,
  type HeroAction,
  type ItemInstance,
  type Rarity
} from 'coronaz-core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { czPerkMeta } from '../../app/czMeta';
import { useCountdown } from '../../hooks/useGameSocket';
import { useCzSocket } from '../../hooks/useCzSocket';
import { itemSprite } from './czAssets';
import { neighbourRooms } from './czBoard';
import { CzHeroSelect } from './CzHeroSelect';
import { rarityVars } from './czRarity';
import { isMuted, sfxEscape, sfxHeal, sfxKill, sfxLoot, sfxShoot, sfxStep, toggleMute } from './czSound';
import { Badge, Button, Input, Loading } from '../../ui';
import { CzEndScreen } from './CoronaZTv';
import { CzMap } from './CzMap';
import './coronaz.css';
import '../play.css';

/**
 * The survivor's phone. Built around one idea: fast.
 *
 * Tapping an adjacent room moves there. Tapping a zombie attacks it, asking which
 * weapon only when there is genuinely a choice. Loot arrives with a one-tap
 * "Équiper" on the spot, and everything inventory is free, so the three action
 * points go on the board, not on menus.
 */
export default function CoronaZPlayer() {
  const { code = '' } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const { socket, connected, view, error, serverNow, applyView } = useCzSocket();

  const [name, setName] = useState('');
  const [joined, setJoined] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The nickname's roster wallet, refreshed by join and unlock acks. */
  const [career, setCareer] = useState<{ rations: number; unlockedHeroes: string[] } | null>(null);

  const tokenKey = `kune.cz.player.${code}`;

  const join = useCallback(
    async (playerName: string) => {
      if (!socket) return;
      setBusy(true);
      setJoinError(null);
      try {
        /**
         * The name survives alongside the token. A silent rejoin used to send
         * an empty name, which the server's schema rightly refused — so the
         * seat token was there and the reclaim still failed. That was the
         * whole "can't get back into a game" bug.
         */
        const remembered = localStorage.getItem(`${tokenKey}.name`) ?? '';
        const actualName = playerName.trim() || remembered || 'Survivant';

        const ack = (await socket.timeout(5000).emitWithAck('cz:join', {
          code,
          name: actualName,
          playerToken: localStorage.getItem(tokenKey) ?? undefined
        })) as CzJoinAck;

        if (ack.ok) {
          if (ack.playerToken) localStorage.setItem(tokenKey, ack.playerToken);
          if (ack.playerId) localStorage.setItem(`${tokenKey}.id`, ack.playerId);
          localStorage.setItem(`${tokenKey}.name`, actualName);
          if (ack.view) applyView(ack.view);
          if (ack.career) setCareer(ack.career);
          setJoined(true);
        } else {
          setJoinError(ack.error ?? 'Impossible de rejoindre.');
        }
      } catch {
        setJoinError('Le serveur ne répond pas.');
      } finally {
        setBusy(false);
      }
    },
    [socket, code, tokenKey, applyView]
  );

  const autoJoined = useRef(false);
  useEffect(() => {
    if (!socket || !connected || joined || autoJoined.current) return;
    if (!localStorage.getItem(tokenKey)) return;
    autoJoined.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- talks to the socket
    void join('');
  }, [socket, connected, joined, join, tokenKey]);

  /**
   * The connection is not the seat. When the socket drops and comes back as a
   * NEW connection (sleep, network change, anything past the 2-minute recovery
   * window), the server no longer knows which game this socket belongs to —
   * so every reconnect re-presents the token and reclaims the seat, silently.
   */
  useEffect(() => {
    if (!connected || !joined) return;
    // Talks to the socket, like the auto-join above.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void join('');
  }, [connected, joined, join]);

  const send = useCallback(
    async (action: HeroAction): Promise<CzActionAck> => {
      if (!socket) return { ok: false, error: 'Hors ligne' };
      try {
        return (await socket.timeout(5000).emitWithAck('cz:action', action)) as CzActionAck;
      } catch {
        return { ok: false, error: 'Le serveur ne répond pas' };
      }
    },
    [socket]
  );

  if (!connected) {
    return (
      <div className="jeu-screen jeu-center">
        <Loading label="Connexion…" />
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
          <h1 className="join-title">CoronaZ · {code}</h1>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ton nom de survivant"
            maxLength={24}
            aria-label="Ton nom"
            autoFocus
          />
          {joinError && <p className="play-error">{joinError}</p>}
          <Button type="submit" variant="primary" size="lg" block busy={busy} disabled={!name.trim()}>
            Rejoindre le raid
          </Button>
        </form>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="jeu-screen jeu-center">
        <Loading label="En attente de la partie…" />
      </div>
    );
  }

  const myId = localStorage.getItem(`${tokenKey}.id`);
  const me = view.heroes.find((hero) => hero.playerId === myId);
  // Present when this very device created the game: solo play needs no TV, so
  // the creator's phone or PC carries the host powers into the player screen.
  const hostToken = sessionStorage.getItem(`kune.cz.host.${code}`) ?? '';

  if (view.phase === 'lobby') {
    return (
      <LobbyScreen view={view} myId={myId} socket={socket} hostToken={hostToken} career={career} onCareer={setCareer} />
    );
  }

  if (view.phase === 'won' || view.phase === 'lost') {
    return (
      <div className="jeu-screen">
        <CzEndScreen
          view={view}
          // Whoever created the game goes back to the setup for a rematch;
          // a guest goes home.
          onExit={() => void navigate(hostToken ? '/coronaz' : '/')}
        />
      </div>
    );
  }

  if (!me) {
    return (
      <div className="jeu-screen jeu-center">
        <p className="play-note">Vous n’êtes pas dans cette partie.</p>
      </div>
    );
  }

  return <PlayScreen view={view} me={me} myId={myId ?? ''} serverNow={serverNow} send={send} error={error} />;
}

function LobbyScreen({
  view,
  myId,
  socket,
  hostToken,
  career,
  onCareer
}: {
  view: CzView;
  myId: string | null;
  socket: ReturnType<typeof useCzSocket>['socket'];
  hostToken: string;
  career: { rations: number; unlockedHeroes: string[] } | null;
  onCareer: (next: { rations: number; unlockedHeroes: string[] }) => void;
}) {
  const mine = view.heroes.find((hero) => hero.playerId === myId);
  const takenBy = new Map(view.heroes.map((hero) => [hero.heroId, hero.name]));
  const myPerks = mine?.perks ?? [];
  const unlocked = new Set(career?.unlockedHeroes ?? []);

  return (
    <div className="jeu-screen cz-lobby">
      <header className="cz-lobby-head">
        <p className="play-label">Choisis ton survivant{career ? ` · 🥫 ${career.rations} rations` : ''}</p>
        <span className="play-note">{view.heroes.length} survivant(s) · la partie commence quand la télé le dit</span>
      </header>

      <CzHeroSelect
        mine={mine?.heroId ?? null}
        takenBy={takenBy}
        unlocked={unlocked}
        rations={career?.rations ?? null}
        biome={view.biome}
        loadout={mine?.loadout ?? []}
        onPick={(heroId) => socket?.emit('cz:selectHero', { heroId }, () => undefined)}
        onUnlock={(heroId) =>
          socket?.emit('cz:unlockHero', { heroId }, (ack) => {
            if (ack.ok && ack.career) onCareer(ack.career);
          })
        }
        onLoadout={(perks) => socket?.emit('cz:loadout', { perks }, () => undefined)}
      />

      <footer className="cz-lobby-foot">
        {/* The roguelite payoff: what this nickname has earned, worn into battle. */}
        {myPerks.length > 0 && (
          <div className="cz-acquis">
            <span className="cz-slot-label">Vos acquis</span>
            {myPerks.map((perk) => {
              const meta = czPerkMeta(perk);
              return (
                <span className="play-note" key={perk}>
                  {meta.emoji} {meta.label}
                </span>
              );
            })}
          </div>
        )}

        {hostToken ? (
          /* Solo or TV-less: this device created the game, so it can staff the
             table with bots and fire the starting gun itself. */
          <div className="cz-actions">
            {view.heroes.length < 5 && (
              <>
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
              </>
            )}
            <Button variant="primary" size="lg" onClick={() => socket?.emit('cz:start', { hostToken })}>
              Lancer le raid
            </Button>
          </div>
        ) : (
          <p className="play-note">La télé lance la partie quand tout le monde est là.</p>
        )}
      </footer>
    </div>
  );
}

function PlayScreen({
  view,
  me,
  myId,
  serverNow,
  send,
  error
}: {
  view: CzView;
  me: CzView['heroes'][number];
  myId: string;
  serverNow: () => number;
  send: (action: HeroAction) => Promise<CzActionAck>;
  error: string | null;
}) {
  const remaining = useCountdown(view.phaseEndsAt, serverNow);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [loot, setLoot] = useState<ItemInstance | null>(null);
  const [attackTarget, setAttackTarget] = useState<string | null>(null);
  const [bagOpen, setBagOpen] = useState(false);

  const myTurn = view.phase === 'heroes' && me.alive && !me.escaped;
  const room = view.rooms.find((candidate) => candidate.id === me.roomId);
  const inventory = view.me;

  /** The weapon a hand would fire, for its voice. */
  function weaponIn(hand: 0 | 1 | 2): string {
    const item = inventory?.hands[hand === 2 ? 0 : hand];
    return item?.def ?? '__fists';
  }

  async function act(action: HeroAction) {
    const result = await send(action);
    setFeedback(result.ok ? null : (result.error ?? 'Impossible'));
    if (result.loot) setLoot(result.loot);

    // The satisfying part: every action answers out loud.
    if (result.ok) {
      if (action.type === 'move') sfxStep();
      if (action.type === 'search') sfxLoot();
      if (action.type === 'use') sfxHeal();
      if (action.type === 'exit') sfxEscape();
      if (action.type === 'attack') {
        sfxShoot(weaponIn(action.hand));
        if ((result.killed?.length ?? 0) > 0) sfxKill();
      }
    }
    return result;
  }

  /** Rooms one doorway or archway away: the tap-to-move surface. */
  const adjacent = new Set<string>();
  if (myTurn && me.ap > 0 && room) {
    for (const next of neighbourRooms(view, room)) adjacent.add(next.id);
  }

  /** Weapon options for the tapped zombie; one option attacks without asking. */
  const attackOptions = (): { label: string; hand: 0 | 1 | 2; rarity: Rarity }[] => {
    if (!inventory) return [];
    const options: { label: string; hand: 0 | 1 | 2; rarity: Rarity }[] = [];
    const [left, right] = inventory.hands;

    for (const [item, hand] of [
      [left, 0],
      [right, 1]
    ] as const) {
      if (item && itemDef(item.def).weapon) {
        options.push({ label: itemDef(item.def).name, hand, rarity: item.rarity });
      }
    }
    if (left && right && left.def === right.def && itemDef(left.def).weapon?.akimbo) {
      options.push({
        label: `${itemDef(left.def).name} ×2 (akimbo)`,
        hand: 2,
        // A pair fires at the worse gun's quality, and says so.
        rarity: Math.min(left.rarity, right.rarity) as Rarity
      });
    }
    return options;
  };

  async function onZombieTap(zombieId: string) {
    if (!myTurn) return;
    // Out of points used to be a silent no-op, which reads exactly like a broken
    // button. Anything a tap cannot do, it should say.
    if (me.ap <= 0) {
      setFeedback('Plus de PA ce tour');
      return;
    }
    const options = attackOptions();
    if (options.length === 0) {
      setFeedback('Aucune arme en main');
      return;
    }
    if (options.length === 1 && options[0]) {
      await act({ type: 'attack', zombieId, hand: options[0].hand });
      return;
    }
    setAttackTarget(zombieId);
  }

  /** One tap to wear what you just found: weapons to a hand, gear to a slot. */
  async function quickEquip(item: ItemInstance) {
    if (!inventory) return;
    const def = itemDef(item.def);
    let slot: 'hand0' | 'hand1' | 'gear0' | 'gear1';
    if (def.kind === 'weapon') {
      slot = inventory.hands[0] === null ? 'hand0' : inventory.hands[1] === null ? 'hand1' : 'hand0';
    } else {
      slot = inventory.gear[0] === null ? 'gear0' : inventory.gear[1] === null ? 'gear1' : 'gear0';
    }
    await act({ type: 'equip', uid: item.uid, slot });
    setLoot(null);
  }

  return (
    <div className="jeu-screen jeu-fixed cz-player">
      <header className="player-top">
        <span className="play-label">{view.code}</span>
        <span className="player-timer tabular">{view.phaseEndsAt !== null ? remaining : ''}</span>
        <span className="player-score tabular">
          {me.hp}❤ · {myTurn ? `${me.ap} PA` : view.phase === 'enemy' ? 'la horde…' : ''}
        </span>
        <MuteButton />
      </header>

      {/* The one job still open, always in sight: the old game's missing goal. */}
      {view.objectives.some((objective) => !objective.done) && (
        <p className="play-note">▹ {view.objectives.find((objective) => !objective.done)?.label}</p>
      )}

      <CzMap
        view={view}
        compact
        myPlayerId={myId}
        targetRooms={adjacent}
        onRoomTap={(roomId) => void act({ type: 'move', roomId })}
        onZombieTap={myTurn ? (zombieId) => void onZombieTap(zombieId) : undefined}
        camera="auto"
      />

      {!me.alive && <p className="play-error">Vous êtes tombé. La partie continue sans vous.</p>}
      {me.escaped && <p className="play-good">Vous êtes dehors. Regardez-les courir.</p>}

      {/* Everything below is docked to the bottom of the screen: the map owns
          the middle, the hands own the bottom, the page never scrolls. */}
      <div className="cz-bottom">
        {myTurn && (
          <div className="cz-actions">
            <Button
              variant="secondary"
              disabled={me.ap <= 0 && !inventory?.freeSearchAvailable}
              onClick={() => void act({ type: 'search' })}
            >
              Fouiller{inventory?.freeSearchAvailable ? ' 🆓' : ''}
            </Button>
            {room?.hasKey && (
              <Button variant="primary" disabled={me.ap <= 0} onClick={() => void act({ type: 'pickupKey' })}>
                🔑 Ramasser
              </Button>
            )}
            {room?.kind === 'exit' && (
              <Button variant="primary" disabled={me.ap <= 0} onClick={() => void act({ type: 'exit' })}>
                🚪 Sortir
              </Button>
            )}
            <Button variant="secondary" onClick={() => setBagOpen((open) => !open)}>
              🎒 Sac
            </Button>
            <Button
              variant={me.ready ? 'ghost' : 'secondary'}
              disabled={me.ready}
              onClick={() => void act({ type: 'ready' })}
            >
              {me.ready ? 'Prêt ✓' : 'Prêt'}
            </Button>
          </div>
        )}

        {loot && (
          <div className={`cz-loot-toast r${loot.rarity}`} style={rarityVars(loot.rarity)}>
            <span className="cz-loot-face">
              <ItemFace item={loot} big />
              {itemDef(loot.def).name}
              <span className="cz-rarity" style={{ color: RARITY_META[loot.rarity].color }}>
                {RARITY_META[loot.rarity].label}
              </span>
            </span>
            <ItemStats item={loot} compact />
            <span style={{ display: 'flex', gap: '0.5rem' }}>
              <Button variant="primary" size="sm" onClick={() => void quickEquip(loot)}>
                Équiper
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setLoot(null)}>
                Garder
              </Button>
            </span>
          </div>
        )}

        {attackTarget && (
          <div className="cz-sheet">
            <span className="cz-slot-label">Attaquer avec</span>
            <div className="cz-actions">
              {attackOptions().map((option) => (
                <Button
                  key={option.hand}
                  variant="primary"
                  onClick={() => {
                    void act({ type: 'attack', zombieId: attackTarget, hand: option.hand });
                    setAttackTarget(null);
                  }}
                >
                  <span style={{ color: RARITY_META[option.rarity].color }}>◆</span> {option.label}
                </Button>
              ))}
              <Button variant="ghost" onClick={() => setAttackTarget(null)}>
                Annuler
              </Button>
            </div>
          </div>
        )}

        {bagOpen && inventory && (
          <InventorySheet view={view} me={me} inventory={inventory} act={(action) => void act(action)} />
        )}

        {feedback && <p className="play-error">{feedback}</p>}
        {error && <p className="play-error">{error}</p>}
      </div>
    </div>
  );
}

/**
 * Hands, gear, bag. Tap an item, say where it goes; everything here is free, so
 * this sheet can stay open mid-fight without costing the fight.
 */
function InventorySheet({
  view,
  me,
  inventory,
  act
}: {
  view: CzView;
  me: CzView['heroes'][number];
  inventory: NonNullable<CzView['me']>;
  act: (action: HeroAction) => void;
}) {
  const [selected, setSelected] = useState<ItemInstance | null>(null);

  const teammates = view.heroes.filter(
    (hero) => hero.playerId !== me.playerId && hero.alive && !hero.escaped && hero.roomId === me.roomId
  );

  const toggle = (item: ItemInstance) => setSelected((current) => (current?.uid === item.uid ? null : item));

  return (
    <div className="cz-sheet">
      <span className="cz-slot-label">Mains</span>
      <div className="cz-items">
        <ItemButton item={inventory.hands[0] ?? null} label="main gauche" onSelect={toggle} />
        <ItemButton item={inventory.hands[1] ?? null} label="main droite" onSelect={toggle} />
      </div>
      <span className="cz-slot-label">Équipement</span>
      <div className="cz-items">
        <ItemButton item={inventory.gear[0] ?? null} label="libre" onSelect={toggle} />
        <ItemButton item={inventory.gear[1] ?? null} label="libre" onSelect={toggle} />
      </div>
      <span className="cz-slot-label">Sac ({inventory.bag.length}/5)</span>
      <div className="cz-items">
        {inventory.bag.map((item) => (
          <ItemButton key={item.uid} item={item} label="" onSelect={toggle} />
        ))}
        {inventory.bag.length === 0 && <span className="play-note">Vide. Fouillez.</span>}
      </div>

      {selected && (
        <>
          <span className="cz-slot-label">
            {itemDef(selected.def).name}
            <span className="cz-rarity" style={{ color: RARITY_META[selected.rarity].color }}>
              {RARITY_META[selected.rarity].label}
            </span>
          </span>
          <ItemStats item={selected} />
          <span className="cz-slot-label">→ où ?</span>
          <div className="cz-actions">
            {(itemDef(selected.def).gear?.heal || itemDef(selected.def).gear?.adrenaline) && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  act({ type: 'use', uid: selected.uid });
                  setSelected(null);
                }}
              >
                {itemDef(selected.def).gear?.heal ? 'Se soigner (1 PA)' : 'S’injecter (gratuit)'}
              </Button>
            )}
            {itemDef(selected.def).kind === 'weapon' ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    act({ type: 'equip', uid: selected.uid, slot: 'hand0' });
                    setSelected(null);
                  }}
                >
                  Main G
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    act({ type: 'equip', uid: selected.uid, slot: 'hand1' });
                    setSelected(null);
                  }}
                >
                  Main D
                </Button>
              </>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  act({ type: 'equip', uid: selected.uid, slot: inventory.gear[0] === null ? 'gear0' : 'gear1' });
                  setSelected(null);
                }}
              >
                Porter
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                act({ type: 'equip', uid: selected.uid, slot: 'bag' });
                setSelected(null);
              }}
            >
              Sac
            </Button>
            {teammates.map((mate) => (
              <Button
                key={mate.playerId}
                variant="secondary"
                size="sm"
                onClick={() => {
                  act({ type: 'give', uid: selected.uid, toPlayerId: mate.playerId });
                  setSelected(null);
                }}
              >
                → {mate.name}
              </Button>
            ))}
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                act({ type: 'drop', uid: selected.uid });
                setSelected(null);
              }}
            >
              Jeter
            </Button>
          </div>
        </>
      )}

      <Badge tone="ok">Tout ici est gratuit : aucune action dépensée.</Badge>
    </div>
  );
}

/** The mute switch, shared by phone and TV headers. */
export function MuteButton() {
  const [muted, setMuted] = useState(isMuted());
  return (
    <button
      type="button"
      className="cz-mute"
      aria-label={muted ? 'Activer le son' : 'Couper le son'}
      onClick={() => setMuted(toggleMute())}
    >
      {muted ? '🔇' : '🔊'}
    </button>
  );
}

/**
 * An item's face: the 2020 sprite when one exists, its emoji otherwise — wearing
 * its rarity either way.
 */
export function ItemFace({ item, big = false }: { item: ItemInstance; big?: boolean }) {
  const sprite = itemSprite(item.def);
  return (
    <span
      className={`cz-art r${item.rarity} ${big ? 'big' : ''}`}
      style={rarityVars(item.rarity)}
      title={RARITY_META[item.rarity].label}
    >
      {sprite ? (
        <img className="cz-item-sprite" src={sprite} alt="" />
      ) : (
        <span className="cz-item-emoji">{itemDef(item.def).emoji}</span>
      )}
    </span>
  );
}

function ItemButton({
  item,
  label,
  onSelect
}: {
  item: ItemInstance | null;
  label: string;
  onSelect: (item: ItemInstance) => void;
}) {
  const def = item ? itemDef(item.def) : null;
  return (
    <button
      type="button"
      className={`cz-item ${item ? `r${item.rarity}` : 'empty'}`}
      // The Fortnite tongue: the border says the rarity before the name does.
      style={item ? { ...rarityVars(item.rarity), borderColor: RARITY_META[item.rarity].color } : undefined}
      onClick={item ? () => onSelect(item) : undefined}
    >
      {item && def ? (
        <>
          <ItemFace item={item} /> {def.name}
          {def.weapon?.akimbo && (
            <span className="cz-akimbo" title="Akimbo">
              🙌
            </span>
          )}
        </>
      ) : (
        label
      )}
    </button>
  );
}

/**
 * The AK-versus-P90 answer, on the spot: every number *this* item carries, plus
 * who calls it their favourite. The numbers come from the instance, so a rare
 * machete shows the threshold it actually hits on and the difference from the
 * printed weapon is called out — otherwise the whole rarity roll would be a
 * colour with no consequence anyone could read.
 */
function ItemStats({ item, compact = false }: { item: ItemInstance; compact?: boolean }) {
  const def = itemDef(item.def);
  const weapon = weaponStats(def, item.rarity);
  const gear = gearStats(def, item.rarity);
  const printed = def.weapon;
  // Whose favourite this is, by role: Charles loves marksman rifles, whichever
  // one this world happens to have built.
  const role = roleOf(item.def);
  const fans = HEROES.filter((hero) => hero.favoriteWeapon === role);
  const delta = item.rarity - def.tier;

  const facts: string[] = [];
  if (weapon) {
    facts.push(weapon.melee ? '⚔️ Corps à corps' : `🎯 Portée ${weapon.range}`);
    facts.push(`🎲 ${weapon.dice} dé${weapon.dice > 1 ? 's' : ''} · touche sur ${weapon.accuracy}+`);
    facts.push(`💥 ${weapon.damage} dégâts par touche`);
    if (printed && delta !== 0) {
      const better = delta > 0;
      const what =
        weapon.accuracy !== printed.accuracy
          ? `touche sur ${weapon.accuracy}+ au lieu de ${printed.accuracy}+`
          : `${weapon.damage} dégâts au lieu de ${printed.damage}`;
      facts.push(`${better ? '✨ Belle pièce' : '🩹 Abîmée'} : ${what}`);
    }
    if (weapon.akimbo) facts.push('🙌 Akimbo : une dans chaque main double les dés');
    if (weapon.noisy && !compact) facts.push('📢 Bruyante : attire la horde');
  }
  if (gear?.heal) facts.push(`💊 Rend ${gear.heal} PV`);
  if (gear?.adrenaline) facts.push(`⚡ +${gear.adrenaline} PA immédiats`);
  if (gear?.vest) {
    // What an epic vest is for, said out loud: a plate that holds twice.
    const charges = vestCharges(def, item.rarity) - (item.spent ?? 0);
    facts.push(
      charges > 1 ? `🦺 Encaisse ${charges} impacts avant de céder` : '🦺 Encaisse une blessure, puis rend l’âme'
    );
  }
  if (gear?.flashlight) {
    facts.push('🔦 Une fouille gratuite par tour');
    if (torchReach(def, item.rarity) > 0) facts.push('💡 Éclaire aussi les salles voisines');
  }
  if (fans.length > 0 && !compact) {
    facts.push(`❤️ Arme fétiche de ${fans.map((fan) => fan.name).join(', ')} (+1 dé)`);
  }

  return (
    <div className={`cz-item-stats ${compact ? 'compact' : ''}`}>
      {facts.map((fact) => (
        <span key={fact}>{fact}</span>
      ))}
    </div>
  );
}
