import { msg, type Msg } from 'i18n';
import {
  eventDef,
  gearStats,
  HEROES,
  MUTATIONS,
  PROGRAM_LABELS,
  SHINY_LOOT,
  itemDef,
  isTwoHanded,
  RARITY_META,
  roleOf,
  torchReach,
  gearArmor,
  weaponStats,
  type CzActionAck,
  type CzClientToServer,
  type CzEventId,
  type CzRaidReward,
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
import { useCountdown } from '../../hooks/useServerClock';
import { PauseOverlay } from '../../components/presence/PauseOverlay';
import { useWakeLock } from '../../hooks/useWakeLock';
import { JoinForm } from '../../seat/JoinForm';
import { useJoinDraft } from '../../seat/useJoinDraft';
import { czSeat } from '../../seat/protocols';
import type { Answered } from '../../seat/seat';
import { useSeat, type SeatOf } from '../../seat/useSeat';
import { buzz } from '../../tools/haptics';
import { forgetSeat } from '../../tools/seats';
import { itemSprite } from './czAssets';
import { czNextGoal } from './czGoals';
import { CzHeroSelect } from './CzHeroSelect';
import { rarityVars } from './czRarity';
import { isMuted, sfxEscape, sfxHeal, sfxKill, sfxLoot, sfxShoot, sfxStep, toggleMute } from './czSound';
import { Badge, Button, Loading } from '../../ui';
import { QuickEnd } from '../../ui/QuickEnd';
import { CzEndScreen } from './CoronaZTv';
import { CzMap } from './CzMap';
import './coronaz.css';
import '../play.css';

/** What an action comes back as: the server's answer, its refusal already a message. */
type ActionAnswer = Answered<CzActionAck>;

/** The nickname's roster wallet, refreshed by join and unlock answers. */
type Career = { rations: number; unlockedHeroes: string[] };

type CzSeat = SeatOf<typeof czSeat>;

/**
 * The survivor's phone. Built around one idea: fast.
 *
 * Tapping an adjacent room moves there. Tapping a zombie attacks it, asking which
 * weapon only when there is genuinely a choice. Loot arrives with a one-tap
 * "Équiper" on the spot, and everything inventory is free, so the three action
 * points go on the board, not on menus.
 */
export default function CoronaZPlayer() {
  const t = useT();
  const { code = '' } = useParams<{ code: string }>();
  const { status, view, error, grant, join, call, send, on, serverNow } = useSeat(czSeat, code);
  const draft = useJoinDraft();

  /**
   * What the raid paid, once it has ended. Null until the server says so, which
   * is a moment after the final view arrives: the careers have to be written first.
   */
  const [rewards, setRewards] = useState<CzRaidReward[] | null>(null);
  useEffect(() => on('cz:rewards', setRewards), [on]);

  /**
   * The wallet, as of the answer that last seated this phone or the last unlock
   * since. Adjusted during render rather than in an effect: a new grant simply
   * replaces what an older one said.
   */
  const [career, setCareer] = useState<Career | null>(null);
  const [seenGrant, setSeenGrant] = useState(grant);
  if (grant !== seenGrant) {
    setSeenGrant(grant);
    if (grant?.career) setCareer(grant.career);
  }
  /** The Kune login this raid pays into, when the browser is logged in. */
  const account = grant?.account ?? null;
  const [kickError, setKickError] = useState<Msg | null>(null);

  /** Proposes carrying on without an absentee, or votes on the open proposal; a refusal shows on the pause. */
  const kick = useCallback(
    (payload: Parameters<CzClientToServer['cz:kick']>[0]) => {
      setKickError(null);
      void call('cz:kick', payload).then((answer) => {
        if (!answer.ok) setKickError(answer.error ?? msg('presence.kick.impossible'));
      });
    },
    [call]
  );
  const proposeKick = useCallback(
    (playerId: string | number) => kick({ type: 'propose', playerId: String(playerId) }),
    [kick]
  );
  const voteKick = useCallback((yes: boolean) => kick({ type: 'vote', yes }), [kick]);

  /**
   * A raid is mostly other people's turns, which is exactly as long as a phone
   * waits before locking itself and taking the socket with it.
   */
  useWakeLock(view !== null);

  /**
   * Your turn, and the horde's, in the pocket.
   *
   * The hero phase is the game asking this player for something, and the one
   * before it is four other people doing things this phone showed silently. A
   * table waits on whoever did not notice their turn started, so it gets the
   * long pattern; the horde moving gets a tap.
   *
   * Not on the first view: arriving at a raid is not an interruption, and this
   * runs again on every silent reconnect.
   */
  const phase = view?.phase ?? null;
  const mine = phase === 'heroes';
  const lastPhase = useRef<string | null>(null);
  useEffect(() => {
    if (phase === null) return;
    const previous = lastPhase.current;
    lastPhase.current = phase;
    if (previous === null || previous === phase) return;
    buzz(mine ? 'turn' : 'phase');
  }, [phase, mine]);

  /** A won or lost raid is not somewhere the front page should offer to return to. */
  useEffect(() => {
    if (phase === 'won' || phase === 'lost') forgetSeat('coronaz', code);
  }, [phase, code]);

  const sendAction = useCallback((action: HeroAction): Promise<ActionAnswer> => call('cz:action', action), [call]);

  if (status === 'connecting') {
    return (
      <div className="jeu-screen jeu-center">
        <Loading label={t(msg('cz.play.connecting'))} />
      </div>
    );
  }

  if (status !== 'seated' && !view) {
    return (
      <div className="jeu-screen jeu-center">
        <JoinForm
          draft={draft}
          status={status}
          error={error}
          join={join}
          nameLabel={t(msg('cz.play.yourName'))}
          submitLabel={t(msg('cz.play.join'))}
        >
          <h1 className="join-title">CoronaZ · {code}</h1>
        </JoinForm>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="jeu-screen jeu-center">
        <Loading label={t(msg('cz.play.waiting'))} />
      </div>
    );
  }

  const myId = grant?.playerId ?? null;
  const me = view.heroes.find((hero) => hero.playerId === myId);
  // Present when this very device created the game: solo play needs no TV, so
  // the creator's phone or PC carries the host powers into the player screen.
  const hostToken = sessionStorage.getItem(`kune.cz.host.${code}`) ?? '';

  if (view.phase === 'lobby') {
    return (
      <LobbyScreen
        view={view}
        myId={myId}
        call={call}
        send={send}
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
          onRematch={hostToken ? () => send('cz:rematch', { hostToken }) : undefined}
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
        <p className="play-note">{t(msg('cz.play.notInGame'))}</p>
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
          pause={pause}
          serverNow={serverNow}
          onPropose={proposeKick}
          onVote={voteKick}
          error={kickError && t(kickError)}
        />
      )}
      <PlayScreen
        view={view}
        me={me}
        myId={myId ?? ''}
        serverNow={serverNow}
        send={sendAction}
        say={(text) => void call('cz:say', { text })}
        error={error}
      />
    </>
  );
}

function LobbyScreen({
  view,
  myId,
  call,
  send,
  hostToken,
  career,
  account,
  onCareer
}: {
  view: CzView;
  myId: string | null;
  /** The seat's own `call` and `send`; the lobby's choices ride on the same line. */
  call: CzSeat['call'];
  send: CzSeat['send'];
  hostToken: string;
  career: Career | null;
  account: string | null;
  onCareer: (next: Career) => void;
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
          {career
            ? t(msg('cz.play.pickSurvivorRations', { count: career.rations }))
            : t(msg('cz.play.pickSurvivor'))}
          {/* Where the evening's score lands: the account when there is one. */}
          <span className="cz-ledger">
            {' '}
            {account ? t(msg('cz.play.account', { login: account })) : t(msg('cz.play.thisNickname'))}
          </span>
        </p>
        <span className="play-note">{t(msg('cz.play.survivorCount', { count: view.heroes.length }))}</span>
      </header>

      <CzHeroSelect
        mine={mine?.heroId ?? null}
        takenBy={takenBy}
        unlocked={unlocked}
        rations={career?.rations ?? null}
        biome={view.biome}
        loadout={mine?.loadout ?? []}
        onPick={(heroId) => void call('cz:selectHero', { heroId })}
        onUnlock={(heroId) =>
          void call('cz:unlockHero', { heroId }).then((answer) => {
            if (answer.ok && answer.career) onCareer(answer.career);
          })
        }
        onLoadout={(perks) => void call('cz:loadout', { perks })}
      />

      {/* The table's own handicap. Any player may toggle one: the people who will
          be eaten choose how hungry the horde is, and are paid for it. */}
      <section className="cz-mutations">
        <span className="cz-slot-label">
          {t(msg('cz.play.mutations', { factor: view.mutationReward.toFixed(2) }))}
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
                  void call('cz:mutations', {
                    mutations: taken
                      ? view.mutations.filter((id) => id !== mutation.id)
                      : [...view.mutations, mutation.id]
                  })
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
                  {meta.emoji} {t(meta.label)}
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
                  onClick={() => void call('cz:addBot', { hostToken, skill: 'expert' })}
                >
                  {t(msg('cz.play.botExpert'))}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void call('cz:addBot', { hostToken, skill: 'newbie' })}
                >
                  {t(msg('cz.play.botNewbie'))}
                </Button>
              </>
            )}
            <Button variant="primary" size="lg" onClick={() => send('cz:start', { hostToken })}>
              {t(msg('cz.play.start'))}
            </Button>
          </div>
        ) : (
          <p className="play-note">{t(msg('cz.play.tvStarts'))}</p>
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
  send: (action: HeroAction) => Promise<ActionAnswer>;
  say: (text: string) => void;
  error: Msg | null;
}) {
  const t = useT();
  const remaining = useCountdown(view.phaseEndsAt, serverNow);
  const [feedback, setFeedback] = useState<Msg | null>(null);
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
    setFeedback(result.ok ? null : (result.error ?? msg('mafia.refuse.impossible')));
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

  /**
   * Where a tap may move this survivor: the tap-to-move surface. The engine's
   * own answer (`reach.moves`), so a runner is offered her two-room sprint and
   * nobody is offered a door the server would refuse.
   */
  const adjacent = new Set<string>(myTurn && me.ap > 0 ? (inventory?.reach.moves ?? []) : []);

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
  /**
   * Which rooms each hand can hit, kept apart rather than merged.
   *
   * The union is what the map wants — anything either hand reaches is a tap
   * worth offering — but the attack sheet wants the opposite: it lists both
   * weapons and has to say which of them can actually touch *this* creature.
   * Merging first and asking later was why the sheet cheerfully offered a
   * machete against something two rooms away and let the server refuse it.
   */
  const reachByHand = new Map<0 | 1, Set<string>>();
  if (myTurn && me.ap > 0 && inventory) {
    // The engine's own answer, per hand: Bernard's fists and Suzanne's eye included.
    for (const hand of [0, 1] as const) reachByHand.set(hand, new Set(inventory.reach.attack[hand]));
  }

  const inReach = new Set<string>();
  for (const rooms of reachByHand.values()) {
    for (const zombie of view.zombies) {
      if (rooms.has(zombie.roomId)) inReach.add(zombie.id);
    }
  }

  /** Weapon options for the tapped zombie; one option attacks without asking. */
  /**
   * Weapon options for a given creature; one usable option attacks without asking.
   *
   * Every weapon in hand is listed, including the ones that cannot reach — shown
   * and disabled rather than hidden, because a sheet whose contents change as you
   * tap around the board is a sheet nobody can learn. `why` is the same reason
   * the engine would have given, so the answer arrives before the attempt rather
   * than as a refusal afterwards.
   */
  const attackOptions = (
    zombieId: string | null
  ): { label: string; hand: 0 | 1 | 2; rarity: Rarity; usable: boolean; why: Msg | null }[] => {
    if (!inventory) return [];
    const target = zombieId ? view.zombies.find((zombie) => zombie.id === zombieId) : null;
    const [left, right] = inventory.hands;

    const verdict = (hand: 0 | 1): { usable: boolean; why: Msg | null } => {
      if (!target) return { usable: true, why: null };
      const rooms = reachByHand.get(hand);
      if (rooms?.has(target.roomId)) return { usable: true, why: null };
      const item = hand === 0 ? left : right;
      const melee = item ? weaponStats(itemDef(item.def), item.rarity)?.melee : true;
      return { usable: false, why: msg(melee ? 'cz.play.tooFarMelee' : 'cz.play.noLineOfSight') };
    };

    const options: ReturnType<typeof attackOptions> = [];
    for (const [item, hand] of [
      [left, 0],
      [right, 1]
    ] as const) {
      if (item && itemDef(item.def).weapon) {
        options.push({ label: t(msg(itemDef(item.def).name)), hand, rarity: item.rarity, ...verdict(hand) });
      }
    }
    if (left && right && left.def === right.def && itemDef(left.def).weapon?.akimbo) {
      options.push({
        label: `${t(msg(itemDef(left.def).name))} ×2 (akimbo)`,
        hand: 2,
        // A pair fires at the worse gun's quality, and says so.
        rarity: Math.min(left.rarity, right.rarity) as Rarity,
        ...verdict(0)
      });
    }
    return options;
  };

  async function onZombieTap(zombieId: string) {
    if (!myTurn) return;
    // Out of points used to be a silent no-op, which reads exactly like a broken
    // button. Anything a tap cannot do, it should say.
    if (me.ap <= 0) {
      setFeedback(msg('cz.play.noAp'));
      return;
    }
    const options = attackOptions(zombieId);
    if (options.length === 0) {
      setFeedback(msg('cz.play.noWeapon'));
      return;
    }
    const usable = options.filter((option) => option.usable);
    if (usable.length === 0) {
      // Say the reason the engine would have given, without spending the trip.
      setFeedback(options[0].why ?? msg('cz.play.noWeapon'));
      return;
    }
    if (usable.length === 1 && usable[0]) {
      await act({ type: 'attack', zombieId, hand: usable[0].hand });
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
          {me.hp}❤ · {myTurn ? `${me.ap} PA` : view.phase === 'enemy' ? t(msg('cz.play.hordePlaying')) : ''}
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
          {t(msg(PROGRAM_LABELS[room.program]))}
          {room.loot >= SHINY_LOOT && <span className="cz-room-rich"> {t(msg('cz.play.goodLoot'))}</span>}
          {room.loot <= -0.15 && <span className="cz-room-poor">{t(msg('cz.play.poor'))}</span>}
          {/* How much of it is left. A room runs dry now, and a rule the player
              cannot see is a rule that reads as a bug: without this the third
              "Fouiller" of the turn just fails and nothing explains why. */}
          {room.finds > 0 ? (
            <span className="cz-room-finds">{t(msg('cz.play.toSearch', { count: room.finds }))}</span>
          ) : (
            <span className="cz-room-poor">{t(msg('cz.play.emptied'))}</span>
          )}
        </p>
      )}

      {!me.alive && <p className="play-error">{t(msg('cz.play.down'))}</p>}
      {me.escaped && <p className="play-good">{t(msg('cz.play.out'))}</p>}

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
              {t(msg('cz.play.search'))}
              {inventory?.freeSearchAvailable ? ' 🆓' : ''}
            </Button>
            {room?.hasKey && (
              <Button variant="primary" disabled={me.ap <= 0} onClick={() => void act({ type: 'pickupKey' })}>
                {t(msg('cz.play.pickupKey'))}
              </Button>
            )}
            {room?.kind === 'exit' && (
              <Button variant="primary" disabled={me.ap <= 0} onClick={() => void act({ type: 'exit' })}>
                {t(msg('cz.play.exit'))}
              </Button>
            )}
            <Button variant="secondary" onClick={() => setBagOpen((open) => !open)}>
              {t(msg('cz.play.bagButton'))}
            </Button>
            <Button
              variant={me.ready ? 'ghost' : 'secondary'}
              disabled={me.ready}
              onClick={() => void act({ type: 'ready' })}
            >
              {t(msg(me.ready ? 'cz.play.readyDone' : 'cz.play.ready'))}
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
                {t(msg('cz.play.equip'))}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setLoot(null)}>
                {t(msg('cz.play.keep'))}
              </Button>
            </span>
          </div>
        )}

        {attackTarget && (
          <div className="cz-sheet">
            <span className="cz-slot-label">{t(msg('cz.play.attackWith'))}</span>
            <div className="cz-actions">
              {attackOptions(attackTarget).map((option) => (
                <Button
                  key={option.hand}
                  variant="primary"
                  disabled={!option.usable}
                  title={option.why ? t(option.why) : undefined}
                  onClick={() => {
                    void act({ type: 'attack', zombieId: attackTarget, hand: option.hand });
                    setAttackTarget(null);
                  }}
                >
                  <span style={{ color: RARITY_META[option.rarity].color }}>◆</span> {option.label}
                </Button>
              ))}
              <Button variant="ghost" onClick={() => setAttackTarget(null)}>
                {t(msg('cz.play.cancel'))}
              </Button>
            </div>
          </div>
        )}

        {bagOpen && inventory && (
          <InventorySheet view={view} me={me} inventory={inventory} act={(action) => void act(action)} />
        )}

        {feedback && <p className="play-error">{t(feedback)}</p>}
        {error && <p className="play-error">{t(error)}</p>}
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
      <span className="cz-slot-label">{t(msg('cz.play.hands'))}</span>
      <div className="cz-items">
        <ItemButton item={inventory.hands[0] ?? null} label={t(msg('cz.play.leftHandSlot'))} onSelect={toggle} />
        <ItemButton item={inventory.hands[1] ?? null} label={t(msg('cz.play.rightHandSlot'))} onSelect={toggle} />
      </div>
      <span className="cz-slot-label">{t(msg('cz.play.gear'))}</span>
      <div className="cz-items">
        <ItemButton item={inventory.gear[0] ?? null} label={t(msg('cz.play.freeSlot'))} onSelect={toggle} />
        <ItemButton item={inventory.gear[1] ?? null} label={t(msg('cz.play.freeSlot'))} onSelect={toggle} />
      </div>
      <span className="cz-slot-label">{t(msg('cz.play.bagCount', { count: inventory.bag.length }))}</span>
      <div className="cz-items">
        {inventory.bag.map((item) => (
          <ItemButton key={item.uid} item={item} label="" onSelect={toggle} />
        ))}
        {inventory.bag.length === 0 && <span className="play-note">{t(msg('cz.play.bagEmpty'))}</span>}
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
          <span className="cz-slot-label">{t(msg('cz.play.where'))}</span>
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
                {t(msg(itemDef(selected.def).gear?.heal ? 'cz.play.heal' : 'cz.play.inject'))}
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
                  {t(msg('cz.play.leftHand'))}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    act({ type: 'equip', uid: selected.uid, slot: 'hand1' });
                    setSelected(null);
                  }}
                >
                  {t(msg('cz.play.rightHand'))}
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
                {t(msg('cz.play.wear'))}
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
              {t(msg('cz.play.bag'))}
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
              {t(msg('cz.play.drop'))}
            </Button>
          </div>
        </>
      )}

      <Badge tone="ok">{t(msg('cz.play.allFree'))}</Badge>

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
          {t(msg(quitAsked ? 'cz.play.forfeitSure' : 'cz.play.forfeit'))}
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
  const t = useT();
  const [muted, setMuted] = useState(isMuted());
  return (
    <button
      type="button"
      className="cz-mute"
      aria-label={t(msg(muted ? 'cz.play.soundOn' : 'cz.play.soundOff'))}
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
  const t = useT();
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
          <ItemFace item={item} /> {t(msg(def.name))}
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
    // The cost of the big ones, said first: it is the reason not to take this one.
    if (isTwoHanded(def)) facts.push('🙌 À deux mains : occupe vos deux mains');
    if (weapon.akimbo) facts.push('🙌 Akimbo : une dans chaque main double les dés');
    if (weapon.noisy && !compact) facts.push('📢 Bruyante : attire la horde');
  }
  if (gear?.heal) facts.push(`💊 Rend ${gear.heal} PV`);
  if (gear?.adrenaline) facts.push(`⚡ +${gear.adrenaline} PA immédiats`);
  if (gear?.blast) facts.push(`💣 ${gear.blast} dégâts à toute la salle, armure ignorée`);
  if (gear?.hush) facts.push('🌫️ Efface le bruit ici et dans les salles voisines');
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
