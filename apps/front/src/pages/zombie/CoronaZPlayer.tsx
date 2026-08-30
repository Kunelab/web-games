import { msg } from 'i18n';
import {
  BARE_HANDS,
  eventDef,
  gearStats,
  HEROES,
  heroDef,
  MUTATIONS,
  PROGRAM_LABELS,
  SHINY_LOOT,
  itemDef,
  RARITY_META,
  roleOf,
  torchReach,
  gearArmor,
  weaponStats,
  type CzActionAck,
  type CzEventId,
  type CzJoinAck,
  type CzView,
  type HeroAction,
  type ItemInstance,
  type Rarity
} from 'coronaz-core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';

import CzChat from './CzChat';
import { useT } from '../../i18n/locale-context';
import { czLine } from './czLine';
import { czPerkMeta } from '../../app/czMeta';
import { useCountdown } from '../../hooks/useGameSocket';
import { PauseOverlay } from '../../components/presence/PauseOverlay';
import { useCzSocket } from '../../hooks/useCzSocket';
import { useHeartbeat } from '../../hooks/useHeartbeat';
import { itemSprite } from './czAssets';
import { neighbourRooms, sightRooms } from './czBoard';
import { czNextGoal } from './czGoals';
import { CzHeroSelect } from './CzHeroSelect';
import { rarityVars } from './czRarity';
import { isMuted, sfxEscape, sfxHeal, sfxKill, sfxLoot, sfxShoot, sfxStep, toggleMute } from './czSound';
import { Badge, Button, Input, Loading } from '../../ui';
import { QuickEnd } from '../../ui/QuickEnd';
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
  const { socket, connected, view, rewards, error, serverNow, applyView } = useCzSocket();

  const [name, setName] = useState('');
  const [joined, setJoined] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The nickname's roster wallet, refreshed by join and unlock acks. */
  const [career, setCareer] = useState<{ rations: number; unlockedHeroes: string[] } | null>(null);
  /** The Kune login this raid pays into, when the browser is logged in. */
  const [account, setAccount] = useState<string | null>(null);
  const [kickError, setKickError] = useState<string | null>(null);

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
          setAccount(ack.account ?? null);
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

  /**
   * The heartbeat: how the raid learns this phone is still here.
   *
   * An open socket is not a present player — see `useHeartbeat`. The reclaim
   * above already runs on every reconnect, so this only adds the beat and the
   * resync that follows it.
   */
  const beat = useCallback(() => socket?.emit('cz:beat'), [socket]);
  useHeartbeat({ connected, seated: joined, beat });

  const proposeKick = useCallback(
    (playerId: string | number) => {
      setKickError(null);
      socket?.emit('cz:kick', { type: 'propose', playerId: String(playerId) }, (ack) => {
        if (!ack.ok) setKickError(ack.error ?? 'Impossible');
      });
    },
    [socket]
  );

  const voteKick = useCallback(
    (yes: boolean) => {
      setKickError(null);
      socket?.emit('cz:kick', { type: 'vote', yes }, (ack) => {
        if (!ack.ok) setKickError(ack.error ?? 'Impossible');
      });
    },
    [socket]
  );

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
      <LobbyScreen
        view={view}
        myId={myId}
        socket={socket}
        hostToken={hostToken}
        career={career}
        account={account}
        onCareer={setCareer}
      />
    );
  }

  if (view.phase === 'won' || view.phase === 'lost') {
    return (
      <div className="jeu-screen">
        <CzEndScreen
          view={view}
          rewards={rewards}
          meId={myId}
          // Solo or TV-less: this device created the raid, so it can start the next
          // one without anybody walking back through setup.
          onRematch={hostToken ? () => socket?.emit('cz:rematch', { hostToken }) : undefined}
          /* The way out is QuickEnd's below, so there are not two of them. */
        />
        {/**
         * A rematch and a replay are not the same offer.
         *
         * `cz:rematch` above keeps this exact table in this exact slot, seats and
         * all, and only the host can call it. This is the other one: a quick match
         * had no host, so "encore" means a new room that anyone from the raid — and
         * anyone else — can walk into.
         */}
        <QuickEnd code={code} fallbackGame="coronaz" />
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

  const pause = view.presence;

  return (
    <>
      {/*
        Over the board rather than inside it. Every action the server exposes
        already refuses while the raid is stopped, so this is not the guard — it
        is the explanation, which is the part a frozen clock cannot give.
      */}
      {pause.paused && (
        <PauseOverlay
          waitingFor={pause.waitingFor.map((seat) => ({
            label: seat.name,
            id: seat.playerId,
            awayMs: seat.awayMs
          }))}
          expiresAt={pause.pauseExpiresAt}
          resumesAt={pause.resumesAt}
          kickable={pause.waitingFor
            .filter((seat) => pause.kickablePlayerIds.includes(seat.playerId))
            .map((seat) => ({ label: seat.name, id: seat.playerId, awayMs: seat.awayMs }))}
          vote={
            pause.vote
              ? {
                  label: pause.vote.name,
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
          error={kickError}
        />
      )}
      <PlayScreen
        view={view}
        me={me}
        myId={myId ?? ''}
        serverNow={serverNow}
        send={send}
        say={(text) => socket?.emit('cz:say', { text }, () => undefined)}
        error={error}
      />
    </>
  );
}

function LobbyScreen({
  view,
  myId,
  socket,
  hostToken,
  career,
  account,
  onCareer
}: {
  view: CzView;
  myId: string | null;
  socket: ReturnType<typeof useCzSocket>['socket'];
  hostToken: string;
  career: { rations: number; unlockedHeroes: string[] } | null;
  account: string | null;
  onCareer: (next: { rations: number; unlockedHeroes: string[] }) => void;
}) {
  const t = useT();
  const mine = view.heroes.find((hero) => hero.playerId === myId);
  const takenBy = new Map(view.heroes.map((hero) => [hero.heroId, hero.name]));
  const myPerks = mine?.perks ?? [];
  const unlocked = new Set(career?.unlockedHeroes ?? []);

  return (
    <div className="jeu-screen cz-lobby">
      <header className="cz-lobby-head">
        <p className="play-label">
          Choisis ton survivant{career ? ` · 🥫 ${career.rations} rations` : ''}
          {/* Where the evening's score lands: the account when there is one. */}
          {account ? <span className="cz-ledger"> 🔗 compte {account}</span> : <span className="cz-ledger"> 📱 ce pseudo</span>}
        </p>
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

      {/* The table's own handicap. Any player may toggle one: the people who will
          be eaten choose how hungry the horde is, and are paid for it. */}
      <section className="cz-mutations">
        <span className="cz-slot-label">
          Mutations de la horde · récompense ×{view.mutationReward.toFixed(2)}
        </span>
        <div className="cz-perk-grid">
          {MUTATIONS.map((mutation) => {
            const taken = view.mutations.includes(mutation.id);
            return (
              <button
                key={mutation.id}
                type="button"
                className={`cz-perk ${taken ? 'picked' : ''}`}
                onClick={() =>
                  socket?.emit(
                    'cz:mutations',
                    {
                      mutations: taken
                        ? view.mutations.filter((id) => id !== mutation.id)
                        : [...view.mutations, mutation.id]
                    },
                    () => undefined
                  )
                }
              >
                {mutation.emoji} {t(msg(mutation.name))} · {t(msg(mutation.blurb))}{' '}
                <span className="cz-mutation-reward">+{Math.round(mutation.reward * 100)}% de score</span>
              </button>
            );
          })}
        </div>
      </section>

      <footer className="cz-lobby-foot">
        {/* The roguelite payoff: what this nickname has earned, worn into battle. */}
        {myPerks.length > 0 && (
          <div className="cz-acquis">
            <span className="cz-slot-label">Vos acquis</span>
            {myPerks.map((perk) => {
              const meta = czPerkMeta(perk);
              return (
                <span className="play-note" key={perk}>
                  {meta.emoji} {t(msg(meta.labelKey))}
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
  say,
  error
}: {
  view: CzView;
  me: CzView['heroes'][number];
  myId: string;
  serverNow: () => number;
  send: (action: HeroAction) => Promise<CzActionAck>;
  say: (text: string) => void;
  error: string | null;
}) {
  const t = useT();
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
    // A search finds one; a corpse can drop one. Same toast, same one-tap equip.
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

  /**
   * The creatures a tap would actually hit: the attack's missing affordance.
   *
   * Every zombie on the board used to be tappable, and the reach check lived on
   * the server, so learning your weapon's range meant tapping something and
   * reading `Pas de ligne de vue` a round trip later. This asks the same question
   * the server will ask — melee wants the same room, a barrel wants a straight
   * open line, Suzanne's eye adds one — and hands the answer to the board, which
   * rings what is reachable and fades the rest.
   *
   * Both hands count, and the union is right: the tap picks the weapon afterwards,
   * so anything either hand can hit is something this tap can do.
   */
  const inReach = new Set<string>();
  if (myTurn && me.ap > 0 && room) {
    const ability = heroDef(me.heroId).ability;
    const rooms = new Set<string>();
    const held = [inventory?.hands[0] ?? null, inventory?.hands[1] ?? null].filter(
      (item): item is ItemInstance => item !== null && itemDef(item.def).weapon !== undefined
    );
    // Bernard fights with what he was born with, so he always has a melee option.
    const weapons = held.map((item) => weaponStats(itemDef(item.def), item.rarity));
    if (weapons.length === 0 && ability === 'brawler') weapons.push(BARE_HANDS.weapon);

    for (const weapon of weapons) {
      if (!weapon) continue;
      if (weapon.melee) {
        rooms.add(room.id);
      } else {
        for (const id of sightRooms(view, room.id, weapon.range + (ability === 'deadeye' ? 1 : 0)).keys()) {
          rooms.add(id);
        }
      }
    }
    for (const zombie of view.zombies) {
      if (rooms.has(zombie.roomId)) inReach.add(zombie.id);
    }
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
        options.push({ label: t(msg(itemDef(item.def).name)), hand, rarity: item.rarity });
      }
    }
    if (left && right && left.def === right.def && itemDef(left.def).weapon?.akimbo) {
      options.push({
        label: `${t(msg(itemDef(left.def).name))} ×2 (akimbo)`,
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

      {/* The one job still open, always in sight — keys included, which is what a
          player on a phone actually needs to know. */}
      {czNextGoal(view) && <p className="play-note">▹ {t(czNextGoal(view)!.label)}</p>}

      {/* What is happening to the district, if anything. Loud, because it lasts one
          turn and a rule nobody notices is a rule that reads as a bug. */}
      {view.event && <CzEventBanner id={view.event} />}

      <CzMap
        view={view}
        compact
        myPlayerId={myId}
        targetRooms={adjacent}
        inReach={myTurn ? inReach : undefined}
        onRoomTap={(roomId) => void act({ type: 'move', roomId })}
        onZombieTap={myTurn ? (zombieId) => void onZombieTap(zombieId) : undefined}
        camera="auto"
      />

      {/* Where you are standing, and what it is worth. The map glitters over a good
          room; this is the line that says why, and it is also the only way a player
          learns that rooms differ at all. */}
      {room && (
        <p className="cz-room-line">
          {PROGRAM_LABELS[room.program]}
          {room.loot >= SHINY_LOOT && <span className="cz-room-rich"> ✨ bon butin</span>}
          {room.loot <= -0.15 && <span className="cz-room-poor"> · pauvre</span>}
          {/* How much of it is left. A room runs dry now, and a rule the player
              cannot see is a rule that reads as a bug: without this the third
              "Fouiller" of the turn just fails and nothing explains why. */}
          {room.finds > 0 ? (
            <span className="cz-room-finds"> · {room.finds} à fouiller</span>
          ) : (
            <span className="cz-room-poor"> · salle vidée</span>
          )}
        </p>
      )}

      {!me.alive && <p className="play-error">Vous êtes tombé. La partie continue sans vous.</p>}
      {me.escaped && <p className="play-good">Vous êtes dehors. Regardez-les courir.</p>}

      <CzChat messages={view.chat} me={me.playerId} onSend={say} />

      {/* Everything below is docked to the bottom of the screen: the map owns
          the middle, the hands own the bottom, the page never scrolls. */}
      <div className="cz-bottom">
        {myTurn && (
          <div className="cz-actions">
            {/* Disabled on an empty room as well as on an empty pocket: the button
                should not offer what the server will refuse. */}
            <Button
              variant="secondary"
              disabled={(me.ap <= 0 && !inventory?.freeSearchAvailable) || (room?.finds ?? 0) <= 0}
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
            {/* Forfeit lives in the bag now, not here. Two taps was the right guard
                and the wrong place: it sat in the grid next to "Prêt", the one
                button every player presses every single turn, on a three-column
                layout where the two land side by side. A confirmation is not a
                licence to put a raid-ending action under the thumb that is already
                moving. */}
          </div>
        )}

        {/* What just happened, while the horde moves.
            The log was only ever painted on the television, which is the one screen
            nobody is looking at during their own turn — and during the enemy phase a
            player has nothing to do but watch tokens slide with no idea who bit whom.
            It shows here only while the horde plays: that is when the dock is empty
            anyway, so the information costs no space it was using for anything else. */}
        {view.phase === 'enemy' && view.log.length > 0 && (
          <ul className="cz-log phone">
            {[...view.log]
              .slice(-4)
              .reverse()
              .map((entry, index) => (
                <li key={`${entry.turn}-${index}`}>{czLine(entry.text, t)}</li>
              ))}
          </ul>
        )}

        {loot && (
          <div className={`cz-loot-toast r${loot.rarity}`} style={rarityVars(loot.rarity)}>
            <span className="cz-loot-face">
              <ItemFace item={loot} big />
              {t(msg(itemDef(loot.def).name))}
              <span className="cz-rarity" style={{ color: RARITY_META[loot.rarity].color }}>
                {t(msg(RARITY_META[loot.rarity].label))}
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
  const t = useT();
  const [selected, setSelected] = useState<ItemInstance | null>(null);
  const [quitAsked, setQuitAsked] = useState(false);

  const teammates = view.heroes.filter(
    (hero) => hero.playerId !== me.playerId && hero.alive && !hero.escaped && !hero.forfeited && hero.roomId === me.roomId
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
            {t(msg(itemDef(selected.def).name))}
            <span className="cz-rarity" style={{ color: RARITY_META[selected.rarity].color }}>
              {t(msg(RARITY_META[selected.rarity].label))}
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

      {/* Leaving the raid: two taps, and behind the bag rather than in the row of
          buttons pressed every turn. Still free, still instant, still not a death. */}
      {me.alive && !me.escaped && !me.forfeited && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (quitAsked) act({ type: 'forfeit' });
            else setQuitAsked(true);
          }}
        >
          {quitAsked ? 'Abandonner pour de bon ?' : '🏳️ Abandonner le raid'}
        </Button>
      )}
    </div>
  );
}

/**
 * This turn's weather, named and explained.
 *
 * Shared by the phone, the television and the game master's screen: all three have
 * to be told the same thing at the same moment, or a horde that walks away from
 * somebody looks like the horde being broken rather than an alarm going off.
 */
export function CzEventBanner({ id }: { id: CzEventId }) {
  const t = useT();
  const event = eventDef(id);
  if (!event) return null;
  return (
    <p className={`cz-event ${event.favours}`}>
      <span aria-hidden="true">{event.emoji}</span> <strong>{t(msg(event.name))}</strong> · {t(msg(event.blurb))}
    </p>
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
  const t = useT();
  const sprite = itemSprite(item.def);
  return (
    <span
      className={`cz-art r${item.rarity} ${big ? 'big' : ''}`}
      style={rarityVars(item.rarity)}
      title={t(msg(RARITY_META[item.rarity].label))}
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
    facts.push(`🎲 ${weapon.dice} touche${weapon.dice > 1 ? 's' : ''} par attaque`);
    facts.push(`💥 ${weapon.damage} dégâts par touche`);
    if (printed && delta !== 0) {
      const better = delta > 0;
      const what =
        weapon.damage !== printed.damage
          ? `${weapon.damage} dégâts au lieu de ${printed.damage}`
          : `${weapon.dice} dé${weapon.dice > 1 ? 's' : ''} au lieu de ${printed.dice}`;
      facts.push(`${better ? '✨ Belle pièce' : '🩹 Abîmée'} : ${what}`);
    }
    if (weapon.pierce) facts.push('🛡️ Perforante : ignore la moitié de l’armure');
    if (weapon.akimbo) facts.push('🙌 Akimbo : une dans chaque main double les dés');
    if (weapon.noisy && !compact) facts.push('📢 Bruyante : attire la horde');
  }
  if (gear?.heal) facts.push(`💊 Rend ${gear.heal} PV`);
  if (gear?.adrenaline) facts.push(`⚡ +${gear.adrenaline} PA immédiats`);
  if (gear?.armor !== undefined) {
    // What a legendary plate is for, said out loud: it takes more off every hit.
    facts.push(`🦺 -${gearArmor(def, item.rarity)} dégâts sur chaque blessure`);
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
