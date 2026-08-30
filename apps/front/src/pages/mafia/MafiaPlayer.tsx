import {
  ROLES,
  SELF_FIRES,
  slotFaction,
  slotPool,
  type Faction,
  type MafiaChannelKind,
  type MafiaPublicPlayer,
  type MafiaViewMe,
  type RoleId,
  type SlotToken
} from 'mafia-core';
import { msg, type Msg } from 'i18n';
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useParams } from 'react-router';

import { ChatPanel } from '../../components/chat/ChatPanel';
import { PauseOverlay, RecoveringMark } from '../../components/presence/PauseOverlay';
import { useHeartbeat } from '../../hooks/useHeartbeat';
import { useMafiaSocket } from '../../hooks/useMafiaSocket';
import { useCountdown } from '../../hooks/useServerClock';
import { cx } from '../../ui/cx';
import { Button, Field, Input, Loading } from '../../ui';
import { QuickEnd } from '../../ui/QuickEnd';

import { useLocale } from '../../i18n/locale-context';
import { MafiaTown } from './MafiaTown';
import './mafia.css';

/**
 * The seat. Everything a player does happens here.
 *
 * The town is now the **screen**, not a strip above it: a full-bleed board with
 * every surface floating over it, which is the layout a Mafia player expects and
 * the one the old design kept apologising for. The scenery still takes no input —
 * every action is a real button with a word on it — but it is no longer squeezed
 * into 200px of letterbox while the panel that reads "3 en vie" got the rest.
 *
 * Four things float over the board, and their positions are the interface:
 *
 *  - **top centre**, the clock: which phase, which day, how long is left. The one
 *    thing everybody looks up at, so it sits where eyes already go.
 *  - **top left**, two icons: the wills on file (yours, and every one a body has
 *    given up) and your own role card. Both open a panel; neither costs a
 *    permanent strip of screen for something you read twice a game.
 *  - **top right**, the role list: what this table is playing, which is the thing
 *    every deduction is measured against. Each line opens what that role does.
 *  - **left**, the roster, which is still where every action lives.
 *  - **bottom right**, the chat, translucent and bounded — it is the gameplay, so
 *    it is always there, and it is *over* the town rather than beside it.
 *
 * On a phone none of that floats: the same pieces stack in one column, because a
 * 360px screen has no room to layer anything over anything.
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

/**
 * A face for every role, and a fallback for every camp.
 *
 * Two icons on the top left have to be recognisable at 32px with no label, and
 * "your role" is not a thing a generic glyph can say. The ones spelled out here
 * are the roles a table talks about by name; everything else wears its camp's
 * mark, which is still more than a cog.
 */
const FACTION_ICON: Record<Faction, string> = {
  town: '🏘️',
  mafia: '🎩',
  triad: '🐉',
  cult: '🕯️',
  neutral: '🎭'
};

const ROLE_ICON: Partial<Record<RoleId, string>> = {
  sheriff: '⭐',
  investigator: '🔎',
  detective: '👣',
  lookout: '👁️',
  spy: '🕵️',
  coroner: '⚰️',
  doctor: '⚕️',
  bodyguard: '🛡️',
  escort: '💃',
  'bus-driver': '🚌',
  vigilante: '🔫',
  veteran: '🎖️',
  jailor: '🔒',
  mayor: '🎗️',
  marshall: '📯',
  crier: '📣',
  mason: '🧱',
  'mason-leader': '🧱',
  stump: '🌳',
  citizen: '🧑‍🌾',
  godfather: '🎩',
  mafioso: '🔪',
  consigliere: '📒',
  consort: '💋',
  framer: '🖼️',
  blackmailer: '🤐',
  janitor: '🧽',
  disguiser: '🎭',
  actress: '🎬',
  kidnapper: '🪢',
  heartbreaker: '💔',
  'dragon-head': '🐉',
  jester: '🃏',
  executioner: '🪓',
  survivor: '🦺',
  amnesiac: '❓',
  scumbag: '🗑️',
  judge: '⚖️',
  auditor: '🧾',
  witch: '🔮',
  lover: '💘',
  cultist: '🕯️',
  'witch-doctor': '🌿',
  'serial-killer': '🔪',
  'mass-murderer': '🪚',
  arsonist: '🔥',
  poisoner: '🧪',
  electromaniac: '⚡'
};

const roleIcon = (role: RoleId): string => ROLE_ICON[role] ?? FACTION_ICON[ROLES[role].faction];

/** The camp a role-list line belongs to, as a class suffix the CSS colours. */
const slotCamp = (token: SlotToken): string => slotFaction(token) ?? 'hidden';

export default function MafiaPlayer() {
  const { code: rawCode } = useParams();
  const code = (rawCode ?? '').toUpperCase();
  const { socket, connected, view, messages, rewards, error, serverNow, applyView } = useMafiaSocket();
  const { t, locale } = useLocale();

  /** Sugar: almost every string on this screen is a key with no parameters. */
  const tk = useCallback((key: string, params?: Record<string, string | number | Msg>) => t(msg(key, params)), [t]);

  const [name, setName] = useState(() => localStorage.getItem(`mafia:name:${code}`) ?? '');
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [jailMode, setJailMode] = useState(false);
  const [willOpen, setWillOpen] = useState(false);
  const [will, setWill] = useState('');
  const [whisperTo, setWhisperTo] = useState<number | null>(null);
  const [whisperText, setWhisperText] = useState('');

  /** Which floating panel is open. One at a time: they overlap the same board. */
  const [panel, setPanel] = useState<'none' | 'wills' | 'me'>('none');
  /** A role-list line (or your own card) opened for a closer read. */
  const [reading, setReading] = useState<SlotToken | null>(null);
  /** Mobile only: the roster and the chat share the bottom half. */
  const [tab, setTab] = useState<'players' | 'chat'>('players');
  /**
   * How far back the camera sits, remembered per browser.
   *
   * A full table is twenty-four houses on a ring, and at the default framing the
   * far side of it is a row of roofs. Pulling back is a preference rather than a
   * moment, so it survives a reload.
   */
  const [zoom, setZoom] = useState(() => Number(localStorage.getItem('mafia:zoom')) || 1);
  const setCamera = (next: number) => {
    const clamped = Math.min(2, Math.max(1, Number(next.toFixed(2))));
    localStorage.setItem('mafia:zoom', String(clamped));
    setZoom(clamped);
  };

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
      else if (ack.error) setJoinError(t(ack.error));
    });
  }, [socket, code, locale, applyView, t]);

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
        if (!ack.ok) setActionError(t(ack.error));
      });
    },
    [socket, t]
  );

  const voteKick = useCallback(
    (yes: boolean) => {
      setActionError(null);
      socket?.emit('mafia:kick', { type: 'vote', yes }, (ack) => {
        if (!ack.ok) setActionError(t(ack.error));
      });
    },
    [socket, t]
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
        setJoinError(ack.error ? t(ack.error) : tk('mafia.ui.joinFailed'));
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

  const fail = (ack: { ok: boolean; error?: Msg }) => {
    if (!ack.ok) setActionError(ack.error ? t(ack.error) : tk('mafia.refuse.impossible'));
    else setActionError(null);
  };

  /**
   * What the button on one player's row says and does, right now.
   *
   * One function so the list has exactly one shape whatever the phase: the row
   * either offers something or it does not, and the verb comes from the role's
   * own power rather than from a generic "confirm".
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
      const self = player.slot === me.slot && !!SELF_FIRES[me.action.type];
      const verb = tk(self ? `mafia.action.${me.action.type}.self` : `mafia.action.${me.action.type}`);
      return {
        label: chosen ? tk('mafia.ui.cancel') : verb,
        chosen,
        run: () => socket.emit('mafia:action', { targetSlot: chosen ? null : player.slot }, fail)
      };
    }

    if (inDiscussion && jailMode && me.role?.id === 'jailor') {
      if (player.slot === me.slot) return null;
      const chosen = me.jailTargetSlot === player.slot;
      return {
        label: chosen ? tk('mafia.ui.release') : tk('mafia.ui.jail'),
        chosen,
        run: () => socket.emit('mafia:dayAction', { type: 'jail', targetSlot: chosen ? null : player.slot }, fail)
      };
    }

    if (canVote) {
      if (player.slot === me.slot) return null;
      const chosen = me.voteTargetSlot === player.slot;
      return {
        label: chosen ? tk('mafia.ui.withdraw') : tk('mafia.ui.accuse'),
        chosen,
        run: () => socket.emit('mafia:vote', { targetSlot: chosen ? null : player.slot }, fail)
      };
    }

    return null;
  }

  /** One sentence saying what this phase wants from you. */
  const prompt = useMemo(() => {
    if (!view || !me) return null;
    if (view.phase === 'lobby') return tk('mafia.ui.prompt.lobby');
    if (view.phase === 'ended') return null;
    if (!me.alive) return tk('mafia.ui.prompt.dead');
    if (isNight) {
      if (me.jailed) return tk('mafia.ui.prompt.jailed');
      if (!me.action) return tk('mafia.ui.prompt.nightIdle');
      const action = msg(`mafia.action.${me.action.type}`);
      return selfOnly(me)
        ? tk('mafia.ui.prompt.selfAction', { action })
        : tk('mafia.ui.prompt.pickTarget', { action });
    }
    if (inDefense) {
      return view.trial?.slot === me.slot
        ? tk('mafia.ui.prompt.yourDefense')
        : tk('mafia.ui.prompt.defense', { name: view.trial?.name ?? '—' });
    }
    if (inJudgement) {
      return view.trial?.slot === me.slot ? tk('mafia.ui.prompt.yourJudgement') : tk('mafia.ui.prompt.judgement');
    }
    if (jailMode) return tk('mafia.ui.prompt.jailPick');
    if (canVote) return tk('mafia.ui.prompt.discussion');
    return tk('mafia.ui.prompt.firstDay');
  }, [view, me, isNight, inDefense, inJudgement, jailMode, canVote, tk]);

  if (!connected && !view) return <Loading />;

  /* ------------------------------- join gate ------------------------------- */
  if (!view || !me) {
    return (
      <div className="mz-join">
        <h1 className="mz-join-title">{tk('mafia.ui.title')}</h1>
        <p className="mz-join-code">{tk('mafia.ui.table', { code })}</p>
        {error && <p className="mz-error">{t(error)}</p>}
        <form onSubmit={join} className="mz-join-form">
          <Field label={tk('mafia.ui.yourName')}>
            {({ id }) => (
              <Input id={id} value={name} onChange={(event) => setName(event.target.value)} maxLength={20} autoFocus />
            )}
          </Field>
          <Button type="submit" disabled={joining || !name.trim()}>
            {joining ? tk('mafia.ui.connecting') : tk('mafia.ui.takeSeat')}
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

  /** Chat tabs, named here rather than on the server: see `MafiaViewMe.channels`. */
  const channelLabel = (channel: { kind: MafiaChannelKind; with: string | null }): string =>
    channel.kind === 'pm' ? tk('mafia.channel.pm', { name: channel.with ?? '' }) : tk(`mafia.channel.${channel.kind}`);

  /** Every will the town is allowed to read, newest death first. */
  const wills = view.players.filter((player) => !player.alive).reverse();

  return (
    <div className={cx('mz-screen', isNight && 'mz-screen--night')}>
      {/*
        The pause sits over everything. Every action the server exposes already
        refuses while the table is stopped, so this is not the guard — it is the
        explanation, which is the part a frozen clock cannot give by itself.
      */}
      {pause.paused && (
        <PauseOverlay
          waitingFor={pause.waitingFor.map((seat) => ({
            label: tk('mafia.ui.seatLabel', { name: seat.name, slot: seat.slot }),
            id: seat.slot,
            awayMs: seat.awayMs
          }))}
          expiresAt={pause.pauseExpiresAt}
          resumesAt={pause.resumesAt}
          kickable={pause.waitingFor
            .filter((seat) => pause.kickableSlots.includes(seat.slot))
            .map((seat) => ({
              label: tk('mafia.ui.seatLabel', { name: seat.name, slot: seat.slot }),
              id: seat.slot,
              awayMs: seat.awayMs
            }))}
          vote={
            pause.vote
              ? {
                  label: tk('mafia.ui.seatLabel', { name: pause.vote.name, slot: pause.vote.slot }),
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

      {/* --------------------------- the board itself --------------------------- */}
      <MafiaTown
        players={view.players}
        mySlot={me.slot}
        night={isNight}
        onTrial={view.trial !== null}
        zoom={zoom}
      />

      <div className="mz-zoom">
        <button
          type="button"
          onClick={() => setCamera(zoom + 0.25)}
          disabled={zoom >= 2}
          title={tk('mafia.ui.zoomOut')}
          aria-label={tk('mafia.ui.zoomOut')}
        >
          −
        </button>
        <button
          type="button"
          onClick={() => setCamera(zoom - 0.25)}
          disabled={zoom <= 1}
          title={tk('mafia.ui.zoomIn')}
          aria-label={tk('mafia.ui.zoomIn')}
        >
          +
        </button>
      </div>

      {/* ------------------------------ the clock ------------------------------- */}
      <header className="mz-clock">
        <span className="mz-phase">
          {view.phase === 'lobby' && tk('mafia.ui.phase.lobby')}
          {view.phase === 'day' && tk('mafia.ui.phase.day', { day: view.day })}
          {view.phase === 'night' && tk('mafia.ui.phase.night', { day: view.day })}
          {view.phase === 'ended' && tk('mafia.ui.phase.ended')}
        </span>
        {inDefense && <span className="mz-stage">{tk('mafia.ui.stage.defense')}</span>}
        {inJudgement && <span className="mz-stage">{tk('mafia.ui.stage.judgement')}</span>}
        {view.phaseEndsAt !== null && (
          <span className={remaining <= 10 ? 'mz-timer mz-timer--urgent' : 'mz-timer'}>{remaining}s</span>
        )}
        <span className="mz-alive">{tk('mafia.ui.alive', { count: alive })}</span>
      </header>

      {/* --------------------------- the two corner icons ----------------------- */}
      <div className="mz-corner">
        <button
          type="button"
          className={cx('mz-corner-btn', panel === 'wills' && 'mz-corner-btn--on')}
          aria-pressed={panel === 'wills'}
          title={tk('mafia.ui.willsIcon')}
          onClick={() => setPanel((open) => (open === 'wills' ? 'none' : 'wills'))}
        >
          📜
        </button>
        <button
          type="button"
          className={cx('mz-corner-btn', panel === 'me' && 'mz-corner-btn--on')}
          aria-pressed={panel === 'me'}
          title={tk('mafia.ui.roleCardIcon')}
          onClick={() => setPanel((open) => (open === 'me' ? 'none' : 'me'))}
        >
          {me.role ? roleIcon(me.role.id) : '❔'}
        </button>
      </div>

      {panel === 'wills' && (
        <FloatingPanel title={tk('mafia.ui.willsTitle')} onClose={() => setPanel('none')} className="mz-panel--wills">
          <section className="mz-will-entry mz-will-entry--mine">
            <h4>{tk('mafia.ui.willsMine')}</h4>
            <p>{sealed || tk('mafia.ui.willsMineEmpty')}</p>
          </section>
          {wills.length === 0 && <p className="mz-muted">{tk('mafia.ui.willsEmpty')}</p>}
          {wills.map((player) => (
            <section key={player.slot} className="mz-will-entry">
              <h4>
                {player.slot}. {player.name}
                {player.roleName && <span className={`mz-fac mz-fac--${player.faction ?? 'hidden'}`}> · {t(player.roleName)}</span>}
              </h4>
              <p className={player.lastWill ? undefined : 'mz-muted'}>{player.lastWill ?? tk('mafia.ui.willsNone')}</p>
            </section>
          ))}
        </FloatingPanel>
      )}

      {panel === 'me' && me.role && (
        <FloatingPanel title={tk('mafia.ui.roleCardIcon')} onClose={() => setPanel('none')} className="mz-panel--me">
          <div className={`mz-role mz-role--${me.role.faction}`}>
            <div className="mz-role-head">
              <span className="mz-role-icon" aria-hidden="true">
                {roleIcon(me.role.id)}
              </span>
              <strong className="mz-role-name">{t(me.role.name)}</strong>
              <span className="mz-role-faction">{tk(`mafia.faction.${me.role.faction}`)}</span>
              {me.charges !== null && <span className="mz-charges">{tk('mafia.ui.charges', { count: me.charges })}</span>}
              {!me.alive && <span className="mz-dead-tag">{tk('mafia.ui.dead')}</span>}
            </div>
            <p className="mz-role-desc">{t(me.role.description)}</p>
            {me.teammates && me.teammates.length > 0 && (
              <p className="mz-role-note">
                {tk('mafia.ui.withYou', {
                  mates: me.teammates.map((mate) => `${mate.slot}. ${mate.name} (${t(mate.roleName)})`).join(' · ')
                })}
              </p>
            )}
            {me.obsessionSlot !== null && (
              <p className="mz-role-note">{tk('mafia.ui.obsession', { slot: me.obsessionSlot })}</p>
            )}
          </div>

          {/* The private feed lives with the role card: both are yours alone. */}
          {me.notifications.length > 0 && (
            <div className="mz-journal" aria-label={tk('mafia.ui.journal')}>
              {me.notifications
                .slice(-8)
                .reverse()
                .map((line, index) => (
                  <p key={`${index}-${line.k}`}>{t(line)}</p>
                ))}
            </div>
          )}
        </FloatingPanel>
      )}

      {/* ----------------------------- the role list ---------------------------- */}
      {/* --- This need a line return or Separator between each Faction / Camp */}
      <aside className="mz-rolelist" aria-label={tk('mafia.ui.roleListTitle')}>
        <h3>{tk('mafia.ui.roleListTitle')}</h3>
        {view.roleList.length === 0 && <p className="mz-muted">{tk('mafia.ui.roleListEmpty')}</p>}
        <div>
          {view.roleList.map((token, index) => {
            const currentCamp = slotCamp(token);
            const prevCamp = index > 0 ? slotCamp(view.roleList[index - 1]) : null;
            const isNewCamp = index >= 0 && currentCamp !== prevCamp;

            return (
              <span key={`${token}-${index}`}>
                {isNewCamp && <div className="mz-rolelist-separator" style={{ textTransform: 'capitalize' }}>{currentCamp}</div>}
                <button
                  type="button"
                  className={`mz-slot mz-slot--${currentCamp}`}
                  onClick={() => setReading(token)}
                >
                  {tk(token in ROLES ? `mafia.role.${token}.name` : `mafia.slot.${token}`)}
                </button>
              </span>
            );
          })}
        </div>
      </aside>

      {reading && (
        <FloatingPanel
          title={tk(reading in ROLES ? `mafia.role.${reading}.name` : `mafia.slot.${reading}`)}
          onClose={() => setReading(null)}
          className="mz-panel--reading"
        >
          {reading in ROLES ? (
            <>
              <p className={`mz-role-faction mz-role-faction--inline mz-fac--${slotCamp(reading)}`}>
                {tk(`mafia.faction.${ROLES[reading as RoleId].faction}`)}
              </p>
              <p className="mz-role-desc">{tk(`mafia.role.${reading}.desc`)}</p>
            </>
          ) : (
            <>
              <p className="mz-role-desc">
                {tk('mafia.slot.pool', {
                  roles: slotPool(reading)
                    .map((role) => tk(`mafia.role.${role}.name`))
                    .join(', ')
                })}
              </p>
              <ul className="mz-pool">
                {slotPool(reading).map((role) => (
                  <li key={role}>
                    <button type="button" className="mz-slot" onClick={() => setReading(role)}>
                      {roleIcon(role)} {tk(`mafia.role.${role}.name`)}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </FloatingPanel>
      )}

      {/* ------------------------- roster, prompt, controls ---------------------- */}
      <div className="mz-dock">
        <div className="mz-dock-tabs">
          <button
            type="button"
            className={cx('mz-dock-tab', tab === 'players' && 'mz-dock-tab--on')}
            onClick={() => setTab('players')}
          >
            {tk('mafia.ui.players')}
          </button>
          <button
            type="button"
            className={cx('mz-dock-tab', tab === 'chat' && 'mz-dock-tab--on')}
            onClick={() => setTab('chat')}
          >
            {tk('mafia.channel.day')}
          </button>
        </div>

        <div className={cx('mz-left', tab === 'chat' && 'mz-left--hidden')}>
          {prompt && <p className="mz-prompt">{prompt}</p>}
          {actionError && <p className="mz-error">{actionError}</p>}
          {error && <p className="mz-error">{t(error)}</p>}

          {/* ------------------------------- lobby ------------------------------ */}
          {view.phase === 'lobby' && (
            <section className="mz-panel">
              <p className="mz-lobby-count">
                {tk('mafia.ui.lobby.count', { seats, max: view.maxPlayers, code })}
              </p>
              {hostToken && (
                <div className="mz-row-actions">
                  <Button
                    variant="ghost"
                    onClick={() => socket?.emit('mafia:addBots', { hostToken, count: 4 })}
                    disabled={seats >= view.maxPlayers}
                  >
                    {tk('mafia.ui.lobby.addBots')}
                  </Button>
                  <Button onClick={() => socket?.emit('mafia:start', { hostToken })} disabled={seats < view.minPlayers}>
                    {tk('mafia.ui.lobby.start')}
                  </Button>
                </div>
              )}
            </section>
          )}

          {/* ---------------------------- the players --------------------------- */}
          <section className="mz-panel mz-players" aria-label={tk('mafia.ui.players')}>
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
                        {player.isBot && <span className="mz-flag" title={tk('mafia.ui.bot')}> 🤖</span>}
                        {player.revealedMayor && <span className="mz-flag" title={tk('mafia.ui.revealed')}> 🎗️</span>}
                        {!player.connected && player.alive && (
                          <span className="mz-flag mz-flag--away" title={tk('mafia.ui.away')}> ⚪</span>
                        )}
                        {isMe && <span className="mz-seat-you">{tk('mafia.ui.you')}</span>}
                        {/* Wobbling, not waited on: a mark, never an overlay. */}
                        {view.presence.waitingFor.every((seat) => seat.slot !== player.slot) &&
                          view.presence.recovering.some((seat) => seat.slot === player.slot) && (
                            <RecoveringMark label={player.name} />
                          )}
                      </span>
                      <span className="mz-seat-sub">
                        {/*
                          The role, in its camp's colour — for a body, or for
                          everybody once the game is over. The masks coming off is
                          the last beat of a Mafia game, and it used to happen only
                          in the results table: the roster beside it still showed
                          every survivor as a name with nothing under it, which is
                          the one moment you most want to read down the list and see
                          who you had been arguing with all evening.
                        */}
                        {(!player.alive || view.phase === 'ended') && (
                          <>
                            <span className={`mz-fac mz-fac--${player.faction ?? 'hidden'}`}>
                              {player.roleName
                                ? t(player.roleName)
                                : player.faction
                                  ? tk(`mafia.faction.${player.faction}`)
                                  : tk('mafia.ui.unknownIdentity')}
                            </span>
                            {player.death &&
                              ` · ${t(msg('mafia.roster.diedOn', { cause: player.death.cause, day: player.death.day }))}`}
                            {!player.death && view.phase === 'ended' && ` · ${tk('mafia.ui.survived')}`}
                          </>
                        )}
                        {/* Once every role is on the table, 'with you' is noise. */}
                        {player.alive && view.phase !== 'ended' && player.allyRole && (
                          <span className={`mz-ally mz-fac--${me.role?.faction ?? 'hidden'}`}>
                            {tk('mafia.ui.ally', { role: t(player.allyRole) })}
                          </span>
                        )}
                        {player.alive && onTrial && ` · ${tk('mafia.ui.onStand')}`}
                        {player.alive && !onTrial && player.votedSkip && tk('mafia.ui.skipChosen')}
                        {player.alive && !onTrial && !player.votedSkip && player.votedSlot !== null &&
                          tk('mafia.ui.accuses', { slot: player.votedSlot })}
                      </span>
                    </span>

                    {/*
                      Two tallies, never both at once: by day the town's
                      accusations, by night the family's aim. A bare number beside
                      a name said neither — it was just a 1.
                    */}
                    {player.alive && !isNight && player.votesAgainst > 0 && (
                      <span className="mz-votes" title={tk('mafia.ui.votesAgainst', { count: player.votesAgainst })}>
                        ⚖ {player.votesAgainst}
                      </span>
                    )}
                    {player.alive && isNight && player.familyVotes > 0 && (
                      <span
                        className="mz-votes mz-votes--night"
                        title={tk('mafia.ui.familyVotes', { count: player.familyVotes })}
                      >
                        🔪 {player.familyVotes}
                      </span>
                    )}

                    <span className="mz-seat-actions">
                      {canWhisper && (
                        <button
                          type="button"
                          className="mz-icon-btn"
                          title={tk('mafia.ui.whisperTo', { name: player.name })}
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
                    {tk('mafia.ui.guilty')}
                  </button>
                  <button
                    type="button"
                    className={me.ballot === 'innocent' ? 'mz-innocent mz-cast' : 'mz-innocent'}
                    onClick={() => socket?.emit('mafia:ballot', { verdict: 'innocent' }, fail)}
                  >
                    {tk('mafia.ui.innocent')}
                  </button>
                  <button
                    type="button"
                    className="mz-abstain"
                    onClick={() => socket?.emit('mafia:ballot', { verdict: 'abstain' }, fail)}
                  >
                    {tk('mafia.ui.abstain')}
                  </button>
                </div>
              )}

              <div className="mz-row-actions">
                {/**
                 * The day's second exit.
                 *
                 * A town that has said everything it has to say used to have one
                 * way out of the afternoon — waiting for the clock — and on a
                 * quiet day that is two minutes of nothing. This is the same vote
                 * as an accusation, aimed at nobody, and it carries on the same
                 * majority.
                 */}
                {canVote && me.alive && (
                  <Button
                    variant={me.votedSkip ? undefined : 'ghost'}
                    onClick={() =>
                      socket?.emit('mafia:vote', { targetSlot: me.votedSkip ? null : 'skip' }, fail)
                    }
                  >
                    {me.votedSkip
                      ? `✓ ${tk('mafia.ui.skipTally', { count: view.skipVotes, needed: view.voteThreshold })}`
                      : `⏭️ ${tk('mafia.ui.skip')}${view.skipVotes > 0 ? ` (${view.skipVotes}/${view.voteThreshold})` : ''}`}
                  </Button>
                )}

                {inDiscussion && me.alive && me.role?.id === 'jailor' && (
                  <Button variant="ghost" onClick={() => setJailMode((mode) => !mode)}>
                    {jailMode
                      ? tk('mafia.ui.backToAccusations')
                      : me.jailTargetSlot
                        ? tk('mafia.ui.prisoner', { slot: me.jailTargetSlot })
                        : tk('mafia.ui.pickPrisoner')}
                  </Button>
                )}

                {inDiscussion && me.alive && me.role?.id === 'mayor' && !iAmRevealed && (
                  <Button variant="ghost" onClick={() => socket?.emit('mafia:dayAction', { type: 'reveal' }, fail)}>
                    {tk('mafia.ui.revealMayor')}
                  </Button>
                )}

                {me.alive && (
                  <Button variant="ghost" onClick={() => setWillOpen((open) => !open)}>
                    {tk('mafia.ui.will')}
                    {sealed ? ' ✓' : ''}
                  </Button>
                )}
              </div>

              {willOpen && me.alive && (
                <div className="mz-will">
                  <label className="mz-will-label" htmlFor="mz-will-text">
                    {tk('mafia.ui.willLabel')}
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
                      {tk('mafia.ui.seal')}
                    </Button>
                    <Button variant="ghost" onClick={() => { setWill(sealed); setWillOpen(false); }}>
                      {tk('mafia.ui.cancel')}
                    </Button>
                  </div>
                </div>
              )}

              {whisperTo !== null && (
                <div className="mz-whisper">
                  <label className="mz-will-label" htmlFor="mz-whisper-text">
                    {tk('mafia.ui.whisperLabel', {
                      name: view.players.find((player) => player.slot === whisperTo)?.name ?? ''
                    })}
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
                      {tk('mafia.ui.send')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setWhisperTo(null)}>
                      ✕
                    </Button>
                  </div>
                </div>
              )}
            </section>
          )}

          {/* ------------------------------ results ----------------------------- */}
          {view.phase === 'ended' && view.results && (
            <section className="mz-panel mz-results">
              <h2>{tk('mafia.ui.results')}</h2>
              <div className="mz-results-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{tk('mafia.ui.col.seat')}</th>
                      <th scope="col">{tk('mafia.ui.col.player')}</th>
                      <th scope="col">{tk('mafia.ui.col.role')}</th>
                      <th scope="col">{tk('mafia.ui.col.outcome')}</th>
                      <th scope="col">{tk('mafia.ui.col.points')}</th>
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
                        <td>{t(row.roleName)}</td>
                        <td>{row.winner ? `🏆 ${row.winReason ? t(row.winReason) : ''}` : '—'}</td>
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
                    .map((reward) => tk('mafia.ui.totalPoints', { name: reward.name, total: reward.total ?? 0 }))
                    .join(' · ') || tk('mafia.ui.signInToKeep')}
                </p>
              )}
              <QuickEnd code={code} fallbackGame="mafia" />
            </section>
          )}
        </div>

        {/* -------------------------------- chat -------------------------------- */}
        <div className={cx('mz-right', tab === 'players' && 'mz-right--hidden')}>
          <ChatPanel
            className="mz-chat"
            messages={messages}
            channels={me.channels.map((channel) => ({
              id: channel.id,
              label: channelLabel(channel),
              canWrite: channel.canWrite
            }))}
            onSend={(channel, text) => socket?.emit('mafia:chat', { channel, text }, fail)}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * A panel that floats over the board: the wills, your role card, one role's
 * description. Same shell for all three so they open and close the same way and
 * a fourth costs nothing.
 */
function FloatingPanel({
  title,
  onClose,
  className,
  children
}: {
  title: string;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx('mz-float', className)} role="dialog" aria-label={title}>
      <header className="mz-float-head">
        <h3>{title}</h3>
        <button type="button" className="mz-float-close" onClick={onClose} aria-label="✕">
          ✕
        </button>
      </header>
      <div className="mz-float-body">{children}</div>
    </div>
  );
}
