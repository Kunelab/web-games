import {
  needsSecondTarget,
  ROLES,
  SELF_FIRES,
  slotFaction,
  slotPool,
  WILL_MAX_CHARS,
  type Faction,
  type MafiaChannelKind,
  type MafiaView,
  type MafiaPublicPlayer,
  type MafiaViewMe,
  type RoleId,
  type SlotToken
} from 'mafia-core';
import { msg, type Msg } from 'i18n';
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';

import { api } from '../../api/client';
import { mafiaBadgeMeta } from '../../app/mafiaBadges';
import { ChatPanel } from '../../components/chat/ChatPanel';
import { PauseOverlay, RecoveringMark } from '../../components/presence/PauseOverlay';
import { useHeartbeat } from '../../hooks/useHeartbeat';
import { useMafiaSocket } from '../../hooks/useMafiaSocket';
import { useCountdown } from '../../hooks/useServerClock';
import { authorColour } from '../../ui/authorHue';
import { cx } from '../../ui/cx';
import { Button, Field, Input, Loading } from '../../ui';
import { QuickEnd } from '../../ui/QuickEnd';
import { Rewards } from '../../ui/Rewards';

import { useLocale } from '../../i18n/locale-context';
import { MafiaTown } from './MafiaTown';
import { useMafiaSound } from './mafiaSound';
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
  /** The engine would refuse this right now, and the button says why instead. */
  waiting?: boolean;
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
  const { socket, connected, view, messages, rewards, busy, error, serverNow, applyView } = useMafiaSocket();
  const { t, locale } = useLocale();

  /** Sugar: almost every string on this screen is a key with no parameters. */
  const tk = useCallback((key: string, params?: Record<string, string | number | Msg>) => t(msg(key, params)), [t]);

  const [name, setName] = useState(() => localStorage.getItem(`mafia:name:${code}`) ?? '');
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [jailMode, setJailMode] = useState(false);
  /**
   * The first house of a two-target order, held on the phone until the second.
   *
   * Local rather than server state on purpose: half an order is not an order, and
   * the engine refuses one. So the first tap commits to nothing and costs nothing
   * to undo, and only the second tap sends anything at all. `courtAsked` is the
   * same shape of guard for the one power that ends a day outright.
   */
  const [pendingFirst, setPendingFirst] = useState<number | null>(null);
  const [courtAsked, setCourtAsked] = useState(false);
  const [will, setWill] = useState('');
  const [whisperTo, setWhisperTo] = useState<number | null>(null);
  const [whisperText, setWhisperText] = useState('');

  /** Which floating panel is open. One at a time: they overlap the same board. */
  const [panel, setPanel] = useState<'none' | 'wills' | 'me'>('none');
  /**
   * Which half of the wills panel is open.
   *
   * The two are the same document seen from either side of dying — the one
   * you are still writing, and the ones that have already been read out — so
   * they belong behind one icon rather than in two places at opposite ends of
   * the screen, which is where the editor used to live.
   */
  const [willTab, setWillTab] = useState<'mine' | 'dead'>('mine');
  /**
   * Closing a table is a two-press action, like every other irreversible one on
   * this screen: it ends the evening for everybody sitting at it.
   */
  const [closeAsked, setCloseAsked] = useState(false);
  /** A role-list line (or your own card) opened for a closer read. */
  const [reading, setReading] = useState<SlotToken | null>(null);
  /** Mobile only: the roster and the chat share the bottom half. */
  const [tab, setTab] = useState<'players' | 'chat'>('players');
  /**
   * Desktop only: either column folded away, to look at the board behind it.
   *
   * The phone gets tabs and the desktop got nothing, so both panels sat over
   * the town permanently. Not persisted: which panel you want up depends on
   * what is happening this minute, and a remembered choice would greet you
   * with a folded chat at the start of the next game.
   */
  const [folded, setFolded] = useState<{ players: boolean; chat: boolean }>({ players: false, chat: false });
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

  const navigate = useNavigate();
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
    // A half-built order does not survive the phase that could have used it.
    setPendingFirst(null);
    setCourtAsked(false);
  }

  // Dawn, nightfall, a rope and a body. Above the early returns: a hook is a hook.
  useMafiaSound(view);

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

  /**
   * The seconds before the room may vote, counted down on the button.
   *
   * The ballot opens a little after the day does, and again after a verdict, so
   * that the first thing an afternoon produces is an argument rather than a
   * wagon. The rule was entirely invisible: the accuse button was there, it did
   * nothing, and the only feedback was a refusal in red. Now the button says
   * how long, which turns a broken control into a rule of the game.
   */
  /**
   * The server's clock, not this browser's.
   *
   * `voteOpensAt` is a server timestamp and this compared it against
   * `Date.now()`, while `phaseEndsAt` on the same screen goes through
   * `serverNow()` — the offset-corrected clock that exists for exactly this.
   * A player whose machine runs behind the server sees every accuse button
   * disabled for the whole afternoon; one running ahead clicks early and gets a
   * refusal in red from `castVote`. Neither player has done anything wrong and
   * neither has any way to tell what happened.
   *
   * The server-side reader in `turn.ts` already compares against real server
   * time, so this was the only half of the rule keeping its own clock.
   */
  const [now, setNow] = useState(() => serverNow());
  const opensAt = canVote ? (view?.voteOpensAt ?? null) : null;
  useEffect(() => {
    if (opensAt === null || serverNow() >= opensAt) return;
    /**
     * And it stops the moment the lock does.
     *
     * The effect only re-runs when the deadline itself changes, so a ticker
     * started for a fifteen second lock kept re-rendering the page four times a
     * second for the remaining hundred of a two minute afternoon. It clears
     * itself on the tick that passes the deadline instead.
     *
     * One reading per tick, used for both the state and the test, so the last
     * tick cannot set a `now` a hair under the deadline it has just decided was
     * passed.
     */
    const timer = setInterval(() => {
      const at = serverNow();
      setNow(at);
      if (at >= opensAt) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [opensAt, serverNow]);
  /**
   * Counted from the later of the ticker and the clock, not from the ticker.
   *
   * `now` only advances while a ticker is running, and the effect above starts
   * none for a deadline that has already passed. So a `voteOpensAt` that lands
   * late — a backgrounded tab thawing across a verdict, and the ballot reopens
   * eleven seconds after one — left `now` at whatever the *previous* lock had
   * set it to, this above zero, and every accuse and skip button disabled for
   * the rest of the afternoon behind a countdown that never counted.
   *
   * Reading the clock here as well costs nothing and cannot go stale: the
   * ticker is what makes the number *move*, and it is no longer what makes it
   * true.
   */
  const ballotOpensIn =
    opensAt === null ? 0 : Math.max(0, Math.ceil((opensAt - Math.max(now, serverNow())) / 1000));

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
      const twoStep = needsSecondTarget(me.action.type);

      /**
       * A Witch and a Bus Driver are asked twice, on the same list of houses.
       *
       * The alternative was a second screen, and this is better: the question
       * "which house" has one answer surface in this game and it is the player
       * list, so asking it again in the same place costs nothing to learn. The
       * row that was picked first stays on screen wearing ① so the order is
       * legible while it is being built, and tapping it backs out.
       */
      if (twoStep) {
        const submitted = me.actionTargetSlot !== null;
        if (submitted) {
          const isFirst = me.actionTargetSlot === player.slot;
          const isSecond = me.actionSecondTargetSlot === player.slot;
          if (!isFirst && !isSecond) return null;
          return {
            label: isFirst ? tk('mafia.ui.firstPicked') : tk('mafia.ui.secondPicked'),
            chosen: true,
            run: () => {
              setPendingFirst(null);
              socket.emit('mafia:action', { targetSlot: null }, fail);
            }
          };
        }

        if (pendingFirst === null) {
          if (!me.action.targets.includes(player.slot)) return null;
          return {
            label: tk(`mafia.action.${me.action.type}`),
            chosen: false,
            run: () => setPendingFirst(player.slot)
          };
        }

        if (player.slot === pendingFirst) {
          return { label: tk('mafia.ui.cancel'), chosen: true, run: () => setPendingFirst(null) };
        }
        if (!(me.action.secondTargets ?? []).includes(player.slot)) return null;
        const first = pendingFirst;
        return {
          label: tk(`mafia.ui.secondHere.${me.action.type}`),
          chosen: false,
          run: () => {
            setPendingFirst(null);
            socket.emit('mafia:action', { targetSlot: first, secondTargetSlot: player.slot }, fail);
          }
        };
      }

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
      /**
       * Your own row is where "hang nobody" belongs.
       *
       * Every other row offers an accusation; yours cannot, because you cannot
       * accuse yourself — so the slot sits empty on the one row you look at
       * most. Voting to hang nobody is the same vote as an accusation, aimed at
       * no one, and it is the only vote that has nowhere else to live.
       *
       * It was in the corner bar for a while, beside the role card and the
       * wills, where it was both hard to find and sitting next to the button
       * that closes the table — which somebody duly pressed while hunting for
       * this one, ending the game. A destructive control should not be the
       * thing you find while looking for a routine one.
       */
      if (player.slot === me.slot) {
        if (ballotOpensIn > 0) {
          return {
            label: `🔒 ${tk('mafia.ui.ballotOpensIn', { seconds: ballotOpensIn })}`,
            chosen: false,
            waiting: true,
            run: () => undefined
          };
        }
        return {
          label: me.votedSkip
            ? `✓ ${tk('mafia.ui.skipTally', { count: view.skipVotes, needed: view.voteThreshold })}`
            : `⏭️ ${tk('mafia.ui.skip')}${view.skipVotes > 0 ? ` (${view.skipVotes}/${view.voteThreshold})` : ''}`,
          chosen: me.votedSkip,
          run: () => socket.emit('mafia:vote', { targetSlot: me.votedSkip ? null : 'skip' }, fail)
        };
      }
      const chosen = me.voteTargetSlot === player.slot;
      /**
       * Withdrawing is always allowed; committing waits for the floor. The
       * engine says exactly this, and the button now agrees with it.
       */
      if (ballotOpensIn > 0 && !chosen) {
        return {
          label: `🔒 ${tk('mafia.ui.ballotOpensIn', { seconds: ballotOpensIn })}`,
          chosen: false,
          waiting: true,
          run: () => undefined
        };
      }
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
      // Step two of a two-house order says so, and names the house already picked:
      // the whole point of asking twice is that the player can see both halves.
      if (pendingFirst !== null && needsSecondTarget(me.action.type)) {
        return tk(`mafia.ui.pickSecond.${me.action.type}`, { slot: pendingFirst });
      }
      const action = msg(`mafia.action.${me.action.type}`);
      return selfOnly(me) ? tk('mafia.ui.prompt.selfAction', { action }) : tk('mafia.ui.prompt.pickTarget', { action });
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
  }, [view, me, isNight, inDefense, inJudgement, jailMode, canVote, pendingFirst, tk]);

  /**
   * Player names inside an announcement, in the colour their bylines wear.
   *
   * A dawn report or a verdict is one grey italic sentence, and the names in it
   * are the only part anybody is reading. Splitting on the roster and colouring
   * each hit with `authorColour` gives the eye the same anchor it has on a
   * spoken line, so "Loki se balance au bout de la corde" reads as a fact about
   * Loki rather than as a paragraph. Longest name first, on word boundaries, so
   * "Max" does not light up inside "Maximum" and "Tintin" beats "Tin".
   *
   * Above the early return with the rest of the hooks: a hook below it is a hook
   * that runs on some renders and not others, which React forbids.
   */
  const colourNames = useMemo(() => {
    const names = (view?.players ?? []).map((player) => player.name).filter(Boolean);

    /**
     * And the roles, which are the half of an announcement that is actually
     * news.
     *
     * You already know who Loki is. What the morning is telling you is that he
     * was the Doctor, and that word sat in the sentence looking like every
     * other word in it. Coloured by faction, the report answers "was that a
     * good hanging?" before anybody has finished reading it — which is the
     * question a dawn report and a last will exist to answer.
     *
     * Built from `ROLES` rather than from this table's roster, because a report
     * names roles the reader was never told were in play — that is rather the
     * point of one — and a last will can name anything its author felt like
     * claiming.
     */
    const roleCamp = new Map<string, string>();
    /**
     * The display spelling, kept beside the lookup table rather than read back
     * out of it: `roleCamp` is keyed lowercase so the branch below can find a
     * faction whatever the capitals, and feeding those keys to the exact-case
     * pattern matched "sheriff" and never "Shérif", which is every announcement
     * this exists for.
     */
    const shownRoles = new Set<string>();
    for (const [id, role] of Object.entries(ROLES)) {
      const shown = tk(`mafia.role.${id}.name`).trim();
      if (shown && shown !== `mafia.role.${id}.name`) {
        roleCamp.set(shown.toLowerCase(), role.faction);
        shownRoles.add(shown);
      }
    }
    if (names.length === 0 && shownRoles.size === 0) return undefined;

    /**
     * Names first in the alternation, so a player who calls themselves
     * "Veteran" is still a player. Longest first within each set and matched on
     * word boundaries, so "Max" does not light up inside "Maximum" and "Tintin"
     * beats "Tin".
     */
    const quote = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const words = [
      ...[...names].sort((a, b) => b.length - a.length),
      ...[...shownRoles].sort((a, b) => b.length - a.length)
    ].map(quote);
    const isName = new Set(names);
    /**
     * Exact case, on purpose. Matched without regard to case, "loki" typed by a
     * player matched the name "Loki", failed the exact-case `isName` test below,
     * and fell through to the role branch, drawn as a neutral role; and every
     * ordinary "doctor" or "agent" in a spoken line lit up as if the dawn report
     * had said it. Announcements and wills write names and roles with their
     * display capitals, which is what this requires and what `shownRoles`
     * above carries; a player's own lowercase stays plain, which is what it
     * did before roles were added here.
     */
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${words.join('|')})(?![\\p{L}\\p{N}])`, 'gu');

    return (text: string): ReactNode => {
      const parts = text.split(pattern);
      if (parts.length === 1) return text;
      return parts.map((part, index) => {
        if (index % 2 === 0) return part;
        if (isName.has(part)) {
          return (
            <span key={index} className="chat-name" style={{ color: authorColour(part) }}>
              {part}
            </span>
          );
        }
        const camp = roleCamp.get(part.toLowerCase()) ?? 'neutral';
        return (
          <span key={index} className={`chat-role mz-fac--${camp}`}>
            {part}
          </span>
        );
      });
    };
  }, [view?.players, tk]);

  /** The private feed, folded into the square. See the chat panel below. */
  const mine = useMemo(
    () => new Set(messages.filter((message) => message.channel.startsWith('self:')).map((message) => message.id)),
    [messages]
  );
  const squareWithMine = useMemo(
    () => messages.map((message) => (mine.has(message.id) ? { ...message, channel: 'day' } : message)),
    [messages, mine]
  );

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
      <MafiaTown players={view.players} mySlot={me.slot} night={isNight} zoom={zoom} seed={code} />

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
          <div className="mz-will-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={willTab === 'mine'}
              className={cx('mz-will-tab', willTab === 'mine' && 'mz-will-tab--on')}
              onClick={() => setWillTab('mine')}
            >
              {tk('mafia.ui.willsTabMine')}
              {sealed ? ' ✓' : ''}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={willTab === 'dead'}
              className={cx('mz-will-tab', willTab === 'dead' && 'mz-will-tab--on')}
              onClick={() => setWillTab('dead')}
            >
              {tk('mafia.ui.willsTabDead', { count: wills.length })}
            </button>
          </div>

          {willTab === 'mine' ? (
            me.alive ? (
              /* Written here, where it is read: the editor and the archive are
                 the same object at two different moments. */
              <div className="mz-will">
                <label className="mz-will-label" htmlFor="mz-will-text">
                  {tk('mafia.ui.willLabel')}
                </label>
                <textarea
                  id="mz-will-text"
                  value={will}
                  onChange={(event) => setWill(event.target.value)}
                  maxLength={WILL_MAX_CHARS}
                  rows={5}
                />
                <div className="mz-row-actions">
                  <Button onClick={() => socket?.emit('mafia:will', { text: will }, fail)}>
                    {tk('mafia.ui.seal')}
                  </Button>
                  <Button variant="ghost" onClick={() => setWill(sealed)}>
                    {tk('mafia.ui.cancel')}
                  </Button>
                  {sealed && <span className="mz-muted">{tk('mafia.ui.willsSealed')}</span>}
                </div>
              </div>
            ) : (
              <section className="mz-will-entry mz-will-entry--mine">
                <p className={sealed ? undefined : 'mz-muted'}>{sealed || tk('mafia.ui.willsMineEmpty')}</p>
              </section>
            )
          ) : (
            <>
              {wills.length === 0 && <p className="mz-muted">{tk('mafia.ui.willsEmpty')}</p>}
              {wills.map((player) => (
                <section key={player.slot} className="mz-will-entry">
                  <h4>
                    {player.slot}. {player.name}
                    {player.roleName && (
                      <span className={`mz-fac mz-fac--${player.faction ?? 'hidden'}`}> · {t(player.roleName)}</span>
                    )}
                  </h4>
                  {/*
                    The body of a will is where the roles actually get named.
                    "3 is the Sheriff, 7 is a Serial Killer" is the whole point
                    of reading a dead player's notes, and it arrived as one flat
                    paragraph — so it goes through the same decorator the dawn
                    reports use, and the names and roles in it light up the same
                    way they do in the square.
                  */}
                  <p className={player.lastWill ? undefined : 'mz-muted'}>
                    {player.lastWill ? (colourNames?.(player.lastWill) ?? player.lastWill) : tk('mafia.ui.willsNone')}
                  </p>
                </section>
              ))}
            </>
          )}
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
              {me.charges !== null && (
                <span className="mz-charges">{tk('mafia.ui.charges', { count: me.charges })}</span>
              )}
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

          {/*
            The host's way out, behind a panel nobody opens by accident.

            It was a corner icon beside the wills and the role card, which is
            where the *play* controls live — and somebody hunting for the skip
            vote found it instead and ended the game for the whole table. A
            control that closes an evening should not be adjacent to the ones
            you press every turn.

            Here it takes two deliberate acts to reach: open your own role card,
            then confirm. Still available at any point in the evening, which was
            the reason for adding it — a game that has gone wrong should be
            endable without waiting six hours for the sweeper.
          */}
          {hostToken && (
            <div className="mz-role-danger">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (!closeAsked) {
                    setCloseAsked(true);
                    return;
                  }
                  void api
                    .mafiaEnd(code)
                    .then(() => navigate('/mafia'))
                    .catch(() => setCloseAsked(false));
                }}
              >
                {closeAsked ? `⚠️ ${tk('mafia.ui.closeTableSure')}` : `🚪 ${tk('mafia.ui.closeTable')}`}
              </Button>
              <p className="mz-muted">{tk('mafia.ui.closeTableNote')}</p>
            </div>
          )}
        </FloatingPanel>
      )}

      {/* ------------------------------- results -------------------------------- */}
      {/*
        The masks coming off, in the middle of the screen.

        This used to be a panel at the bottom of the roster column, which is the
        one place on the board nobody is looking when a game ends — you had to
        scroll a sidebar past twenty-four names to find out who had won, and the
        button back to the lobby was below that again. It is the last beat of the
        evening and the only thing on screen that matters at that moment, so it
        takes the middle and covers the town.
      */}
      {view.phase === 'ended' && view.results && (
        <section className="mz-endcard" role="dialog" aria-label={tk('mafia.ui.results')}>
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
          {/*
            The career, in place of the footnote that used to be here.

            That line printed everybody's running total and nothing else: a
            receipt, at the exact moment the table is deciding whether to play
            another. The badges, the title and the three nearest bars are the part
            that answers that question, and none of them existed until now.

            Your own row only. The table above is already the comparison — every
            seat, its role and what it scored — and a career is the one thing on
            this screen that is about the person holding the phone.
          */}
          {rewards && view.me && (
            <Rewards
              rewards={rewards.filter((reward) => reward.playerId === view.me?.playerId)}
              meId={view.me.playerId}
              currency="🩸"
              meta={mafiaBadgeMeta}
            />
          )}
          <QuickEnd code={code} fallbackGame="mafia" />
        </section>
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
                {isNewCamp && (
                  <div className="mz-rolelist-separator" style={{ textTransform: 'capitalize' }}>
                    {currentCamp}
                  </div>
                )}
                <button type="button" className={`mz-slot mz-slot--${currentCamp}`} onClick={() => setReading(token)}>
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

        <div className={cx('mz-left', tab === 'chat' && 'mz-left--hidden', folded.players && 'mz-left--min')}>
          <button
            type="button"
            className="mz-min"
            title={tk(folded.players ? 'mafia.ui.unfold' : 'mafia.ui.fold')}
            aria-expanded={!folded.players}
            onClick={() => setFolded((was) => ({ ...was, players: !was.players }))}
          >
            {folded.players ? '▣' : '▁'}
          </button>
          {prompt && <p className="mz-prompt">{prompt}</p>}
          {busy.reading && (
            <p className="mz-listening" aria-live="polite">
              👂 {tk('mafia.ui.bot.reading')}
            </p>
          )}
          {actionError && <p className="mz-error">{actionError}</p>}
          {error && <p className="mz-error">{t(error)}</p>}

          {/* ------------------------------- lobby ------------------------------ */}
          {view.phase === 'lobby' && (
            <section className="mz-panel">
              <p className="mz-lobby-count">{tk('mafia.ui.lobby.count', { seats, max: view.maxPlayers, code })}</p>
              {hostToken && (
                <div className="mz-row-actions">
                  <Button
                    variant="ghost"
                    // One at a time: four was a guess at how many a table wants, and it
                    // overshoots the moment the answer is not a multiple of four.
                    onClick={() => socket?.emit('mafia:addBots', { hostToken, count: 1 })}
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
                      {/*
                        The same colour the chat gives this voice.

                        Following an argument means tying a line in the log to a
                        row in the roster, and doing that by reading names is
                        exactly the work the colour was invented to save. Both
                        sides hash the display name now, so they agree.
                      */}
                      <span className="mz-seat-name" style={{ color: authorColour(player.name) }}>
                        {player.name}
                        {/*
                          The sash, named rather than hinted at.

                          A faint ribbon at half opacity was the whole of it, and
                          it was the Mayor's own role icon, so a revealed
                          Marshall wore the wrong badge. The role is public the
                          moment it is revealed — the town announced it — so it
                          is written out, in its faction's colour, like every
                          other role this roster shows.
                        */}
                        {player.revealedMayor && (
                          <span
                            className={`mz-fac mz-fac--${player.faction ?? 'town'}`}
                            title={tk('mafia.ui.revealed')}
                          >
                            {' '}
                            🎗️ {player.roleName ? t(player.roleName) : tk('mafia.ui.revealed')}
                          </span>
                        )}
                        {!player.connected && player.alive && (
                          <span className="mz-flag mz-flag--away" title={tk('mafia.ui.away')}>
                            {' '}
                            ⚪
                          </span>
                        )}
                        {isMe && <span className="mz-seat-you">{tk('mafia.ui.you')}</span>}
                        {/*
                          And what you are, on the row that says it is you.

                          Your own role was behind an icon in the corner, which
                          meant the one identity you are never in doubt about was
                          the only one not written down anywhere you look. It is
                          not a leak: it is your card, on your line.
                        */}
                        {isMe && me.role && (
                          <span className={`mz-fac mz-fac--${me.role.faction}`}> · {t(me.role.name)}</span>
                        )}
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
                            {/*
                              Day or night, because they are different deaths.
                              A body found at dawn was killed in the dark; only a
                              hanging happens in daylight, and reading "killed by
                              the Serial Killer, day 2" about a corpse the town
                              woke up to is simply the wrong fact.
                            */}
                            {player.death &&
                              ` · ${t(
                                msg(
                                  player.death.phase === 'night' ? 'mafia.roster.diedAtNight' : 'mafia.roster.diedOn',
                                  { cause: player.death.cause, day: player.death.day }
                                )
                              )}`}
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
                        {player.alive &&
                          !onTrial &&
                          !player.votedSkip &&
                          player.votedSlot !== null &&
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
                          className={
                            action.waiting
                              ? 'mz-act mz-act--waiting'
                              : action.chosen
                                ? 'mz-act mz-act--chosen'
                                : 'mz-act'
                          }
                          disabled={action.waiting}
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
                {/*
                  The cell is chosen during the day — the whole day.

                  This was gated on the discussion stage, so the moment a trial
                  opened the jailor lost the button and could no longer pick a
                  prisoner for the coming night. The engine never had that rule:
                  `jailTarget` asks only that it is daytime. Watching a trial and
                  deciding *because of it* who to lock up is the jailor playing
                  well, and the screen was the only thing forbidding it.
                */}
                {view.phase === 'day' && me.alive && me.role?.id === 'jailor' && (
                  <Button variant="ghost" onClick={() => setJailMode((mode) => !mode)}>
                    {jailMode
                      ? tk('mafia.ui.backToAccusations')
                      : me.jailTargetSlot
                        ? tk('mafia.ui.prisoner', { slot: me.jailTargetSlot })
                        : tk('mafia.ui.pickPrisoner')}
                  </Button>
                )}

                {/* The Marshall has the same power and never had the button. */}
                {inDiscussion &&
                  me.alive &&
                  (me.role?.id === 'mayor' || me.role?.id === 'marshall') &&
                  !iAmRevealed && (
                    <Button variant="ghost" onClick={() => socket?.emit('mafia:dayAction', { type: 'reveal' }, fail)}>
                      {tk('mafia.ui.revealMayor')}
                    </Button>
                  )}

                {/*
                  The Judge's court, which the protocol, the manager and the engine
                  have all supported from the start and which no screen ever offered.
                  A single charge sat unusable for every human who ever drew the role.

                  Two presses, like every other irreversible control here: it skips
                  the defense, drops the whole table straight into a verdict, and
                  cannot be taken back once it lands.
                */}
                {inDiscussion && me.alive && me.role?.id === 'judge' && (me.charges ?? 0) > 0 && (
                  <Button
                    variant={courtAsked ? 'danger' : 'ghost'}
                    onClick={() => {
                      if (courtAsked) {
                        socket?.emit('mafia:dayAction', { type: 'court' }, fail);
                        setCourtAsked(false);
                      } else setCourtAsked(true);
                    }}
                  >
                    {tk(courtAsked ? 'mafia.ui.callCourtSure' : 'mafia.ui.callCourt')}
                  </Button>
                )}
              </div>

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
        </div>

        {/* -------------------------------- chat -------------------------------- */}
        <div className={cx('mz-right', tab === 'players' && 'mz-right--hidden', folded.chat && 'mz-right--min')}>
          <button
            type="button"
            className="mz-min"
            title={tk(folded.chat ? 'mafia.ui.unfold' : 'mafia.ui.fold')}
            aria-expanded={!folded.chat}
            onClick={() => setFolded((was) => ({ ...was, chat: !was.chat }))}
          >
            {folded.chat ? '▣' : '▁'}
          </button>
          <ChatPanel
            className="mz-chat"
            /*
              Your own night results, read in the square rather than off the
              role card.

              They arrive on a channel only this seat can read, and they are
              folded into the day tab here so a sheriff's verdict sits between
              the lines that were being said when it came in. Marked, so the
              reader can tell a result meant for their eyes from an announcement
              the whole table saw.
            */
            messages={squareWithMine}
            lineClass={(message) => (mine.has(message.id) ? 'chat-line--private' : undefined)}
            decorate={colourNames}
            channels={me.channels.map((channel) => ({
              id: channel.id,
              label: channelLabel(channel),
              canWrite: channel.canWrite
            }))}
            onSend={(channel, text) => socket?.emit('mafia:chat', { channel, text }, fail)}
            authorTag={(name) => {
              const seat = view.players.find((player) => player.name === name);
              return seat ? String(seat.slot) : null;
            }}
            /*
              The afternoon's paper trail, beside the conversation it belongs to.

              Accusations are deliberately not posted into the square — a table
              of two dozen revising twice apiece wrote seventy lines a day into a
              fixed ring, which is how a day phase used to delete the morning's
              death announcements. This is the same information with its own
              budget: who moved, when, and who took it back.
            */
            extraTabs={[
              {
                id: '@votes',
                label: tk('mafia.ui.votesTab'),
                render: () => <VoteTrail view={view} t={t} />
              }
            ]}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Who accused whom, in the order it happened.
 *
 * Grouped by day and read oldest-first, like the conversation it sits beside —
 * an argument is a sequence, and a list sorted by anything other than time
 * stops being one. A withdrawal gets its own line rather than deleting the
 * accusation it undoes: a seat that piled on and then quietly stepped off is
 * one of the most readable tells in the game, and a log that only kept the
 * final tally would erase exactly that.
 */
function VoteTrail({ view, t }: { view: MafiaView; t: (message: Msg) => string }) {
  const trail = view.voteLog;
  if (trail.length === 0) return <p className="chat-line chat-line--system">{t(msg('mafia.ui.votesEmpty'))}</p>;

  const days = [...new Set(trail.map((note) => note.day))];
  return (
    <>
      {days.map((day) => (
        <div key={day} className="mz-trail-day">
          <p className="mz-trail-head">{t(msg('mafia.ui.votesDay', { day }))}</p>
          {trail
            .filter((note) => note.day === day)
            .map((note, index) => (
              <p key={`${day}-${index}`} className="chat-line mz-trail-line">
                <span className="chat-slot">{note.voterSlot}</span>
                {t(
                  note.skip
                    ? msg('mafia.ui.votesSkip', { voter: note.voter })
                    : note.targetSlot === null
                      ? msg('mafia.ui.votesWithdraw', { voter: note.voter })
                      : msg('mafia.ui.votesAccuse', {
                          voter: note.voter,
                          target: `${note.targetSlot} ${note.target ?? ''}`.trim()
                        })
                )}
              </p>
            ))}
        </div>
      ))}
    </>
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
