import { msg, msgOf, type Msg } from 'i18n';
import type { LobbyGame } from 'lobby-core';
import { HEARTBEAT_MS } from 'presence-core';

import { rememberNickname } from '../tools/nickname';
import { noteSeat } from '../tools/seats';

/**
 * A phone's seat at a game, and everything it takes to keep it.
 *
 * The three games hold a seat the same way: a token in storage proves which
 * seat is yours, a join hands it back to the server, and the server answers
 * with the seat, a refusal, or a door. That used to be written once per page
 * and once more per socket hook, and the copies drifted: refusals arrived as
 * three different kinds of thing, the keys followed three schemes, and two of
 * the pages joined twice on a reconnect because each decided *when* to rejoin
 * from a different signal.
 *
 * This is the one copy. It decides when to present the seat (once each time the
 * line comes up, and never merely because the seat was just granted), waits
 * five seconds for any answer, writes what a granted seat leaves behind, beats
 * while seated, and turns everything that can go wrong into a `Msg` the screen
 * renders in its reader's language. A game describes itself in a
 * `SeatProtocol`; the line and the storage are passed in, which is what lets
 * all of this run under node against a fake line and a fake store.
 */

/**
 * Where a seat stands, as the screen needs to know it.
 *
 * - `connecting`: the line is down, whether it has never been up or just dropped.
 * - `anonymous`: the line is up and this phone has no seat here.
 * - `joining`: a join is out and nothing is held yet.
 * - `seated`: the server gave this phone its seat, and has not since taken it away.
 * - `locked`: the room has a door. Sticky until the seat is granted, so the
 *   password box does not blink out while a guess is on its way.
 * - `evicted`: the server refused the seat this phone remembers (a kick, a
 *   game that is gone). The reason is in `error`.
 */
export type SeatStatus = 'connecting' | 'anonymous' | 'joining' | 'seated' | 'locked' | 'evicted';

type Listener = (...args: never[]) => void;

/**
 * The few things the seat needs from a socket.
 *
 * Shaped exactly like the slice of socket.io's client it stands for, down to
 * `timeout(ms).emitWithAck`, so the production adapter is a thin wrapper and
 * the server clock (`useServerClock`) can measure through the same object.
 * Untyped on purpose: the protocol is what knows the events, and `createSeat`
 * is where the two meet.
 */
export interface Transport {
  readonly connected: boolean;
  /** Rejects when no acknowledgement arrives within `ms`, like socket.io does. */
  timeout(ms: number): { emitWithAck(event: string, ...args: unknown[]): Promise<unknown> };
  emit(event: string, ...args: unknown[]): void;
  on(event: string, listener: Listener): void;
  off(event: string, listener: Listener): void;
}

/**
 * Where a seat is remembered between page loads.
 *
 * No `remove`: nothing here ever forgets a token. A refused seat keeps it on
 * purpose (see `evicted`), and a finished game keeps it because it is what lets
 * the screen go on showing the results.
 */
export interface SeatStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/**
 * What every game's answer to a join has in common.
 *
 * `error` is `unknown` because that is what actually arrives: the type says a
 * string for the quiz and the raid, but their handlers also send `Msg` objects
 * (a bad request, a join that threw), and Mafia only ever sends a `Msg`.
 */
export interface JoinAnswer {
  ok: boolean;
  error?: unknown;
  needsPassword?: boolean;
  playerToken?: string;
  playerId?: string;
}

/** Where one code's seat lives in the store. */
export interface SeatKeys {
  token: string;
  /** Sent back with the token, because every join schema requires a name. */
  name: string;
  /** For a screen that finds this phone in a roster without asking it: the quiz host's solo seat. */
  id?: string;
}

/** What a join says, before a game puts it into its own payload shape. */
export interface SeatRequest {
  code: string;
  name: string;
  token?: string;
  /** Only on a guess at a door; a returning token never needs one. */
  password?: string;
}

/**
 * One game's half of the conversation.
 *
 * `C` and `S` are the game's client and server event maps, `A` its join
 * answer, `V` the view it broadcasts, and `About` whatever else the phone says
 * about itself on every join (Mafia's locale, which is what its bots speak).
 */
export interface SeatProtocol<C, S, A extends JoinAnswer, V, About = undefined> {
  /** Which game the front page's way back (`tools/seats`) files the seat under. */
  game: LobbyGame;
  keys: (code: string) => SeatKeys;
  join: Extract<keyof C, string>;
  ask: (request: SeatRequest, about: About | undefined) => unknown;
  /** The broadcast that carries the view. */
  state: Extract<keyof S, string>;
  /** The broadcast that carries a complaint. */
  error: Extract<keyof S, string>;
  /** The view a granted join carries, so the screen does not wait for a broadcast. */
  view: (answer: A) => V | undefined;
  /** The presence beat, for a game that pauses for absent players. */
  beat?: Extract<keyof C, string>;
  /** Said when a join is refused without a reason. */
  refused: Msg;
  /** Said when the server does not answer in time. */
  quiet: Msg;
}

export interface SeatSnapshot<A, V> {
  status: SeatStatus;
  /** What the server last said the game looks like; kept through drops and refusals. */
  view: V | null;
  error: Msg | null;
  /** The answer that last granted the seat: the player id, and for the raid what it pays into. */
  grant: A | null;
}

/** The response an event's acknowledgement carries, or `never` for an event that has none. */
type AckOf<F> = F extends (payload: never, ack: infer K) => void
  ? K extends (response: infer R) => void
    ? R
    : never
  : never;

type PayloadOf<F> = F extends (payload: infer P, ...rest: never[]) => void ? P : never;

type ArgsOf<F> = F extends (...args: infer P) => void ? P : never;

/** The events a server acknowledges, which are the only ones worth waiting on. */
export type Asked<C> = { [E in keyof C]: [AckOf<C[E]>] extends [never] ? never : E }[keyof C] & string;

/** An answer whose refusal, if it gave one, is a `Msg` whatever the server sent. */
type Spoken<R> = R extends { error?: unknown } ? Omit<R, 'error'> & { error?: Msg } : R;

/**
 * What a `call` resolves to: the server's answer, spoken, or the silence that
 * stands in for one when five seconds pass. The silence is `ok: false` with a
 * message and none of the answer's other fields, which is why they all read as
 * optional on it rather than being missing from the type.
 */
export type Answered<R> = Spoken<R> | ({ ok: false; error: Msg } & Partial<Omit<Spoken<R>, 'ok' | 'error'>>);

/**
 * The seat, as a screen holds it.
 *
 * Every member is a closure over the seat rather than a method, so any of them
 * can be handed to a child or an event handler on its own.
 */
export interface SeatController<C, S, A, V, About = undefined> {
  snapshot: () => SeatSnapshot<A, V>;
  /** For `useSyncExternalStore`: called after every change to the snapshot. */
  subscribe: (listener: () => void) => () => void;
  /**
   * Asks for a seat under `name`, or the remembered name when it is blank.
   *
   * Resolves to whether it was granted, never rejects. Ignored while the line
   * is down or another join is already out on this line.
   */
  join: (name: string, password?: string) => Promise<boolean>;
  /** An acknowledged event, with the same five seconds and the same `Msg` refusals as a join. */
  call: <E extends Asked<C>>(event: E, payload: PayloadOf<C[E]>) => Promise<Answered<AckOf<C[E]>>>;
  /**
   * An event the server never acknowledges (`cz:start`, `mafia:addBots`).
   *
   * Separate from `call` because waiting on one would turn every such button
   * into a five-second timer that always ends in "the server is not answering".
   */
  send: <E extends Extract<keyof C, string>>(event: E, ...args: ArgsOf<C[E]>) => void;
  /** A game's events beyond the view: rewards, chat pushes, who is busy. */
  on: <E extends Extract<keyof S, string>>(event: E, listener: S[E]) => () => void;
  /** Changes what every join says about the phone; a seated phone re-presents with it. */
  describe: (about: About) => void;
  close: () => void;
}

/** How long any answer is waited for. */
export const ANSWER_MS = 5000;

export function createSeat<C, S, A extends JoinAnswer, V, About>(
  protocol: SeatProtocol<C, S, A, V, About>,
  code: string,
  transport: Transport,
  store: SeatStore
): SeatController<C, S, A, V, About> {
  const keys = protocol.keys(code);
  let snapshot: SeatSnapshot<A, V> = { status: 'connecting', view: null, error: null, grant: null };
  const subscribers = new Set<() => void>();
  let beating: ReturnType<typeof setInterval> | null = null;
  let about: About | undefined;

  /** Whether the line is up right now. */
  let connected = false;
  /**
   * Which connection this is, counted up each time the line comes up. A new one
   * is a stranger to the server, so it presents the seat whatever the last one
   * left in flight, and the answer to that older request no longer means anything.
   */
  let generation = 0;
  let attempts = 0;
  /** The join that is out, if one is: which attempt it is, and which connection it went out on. */
  let pending: { attempt: number; generation: number } | null = null;

  /** The server gave this phone its seat, and has not since taken it away. */
  let seatHeld = false;
  /** The room asked for its word. Sticky until a seat is granted (see `locked`). */
  let passwordAsked = false;
  let evicted = false;

  function status(): SeatStatus {
    if (!connected) return 'connecting';
    if (passwordAsked) return 'locked';
    if (pending) return 'joining';
    if (evicted) return 'evicted';
    if (seatHeld) return 'seated';
    return 'anonymous';
  }

  function update(patch: Partial<SeatSnapshot<A, V>> = {}): void {
    snapshot = { ...snapshot, ...patch, status: status() };
    heartbeat();
    for (const subscriber of subscribers) subscriber();
  }

  /**
   * Beats while seated, and only then.
   *
   * The beat is how the server learns a *player* is present, which an open
   * socket does not prove (see presence-core). It lives here rather than in a
   * hook because the seat is the one thing that knows exactly when the phone is
   * seated: the screens used to approximate it, one with "has joined once" and
   * one with "the view has a `me`", and the second also re-presented the seat
   * from the beat, which is how a reconnect came to send its join twice.
   */
  function heartbeat(): void {
    const beat = protocol.beat;
    const due = beat !== undefined && snapshot.status === 'seated';
    if (due && beating === null) {
      // At once, so coming back is reported without waiting out an interval.
      transport.emit(beat);
      beating = setInterval(() => transport.emit(beat), HEARTBEAT_MS);
    } else if (!due && beating !== null) {
      clearInterval(beating);
      beating = null;
    }
  }

  async function present(name: string, password?: string): Promise<boolean> {
    const token = store.get(keys.token) ?? undefined;
    const attempt = (attempts += 1);
    pending = { attempt, generation };
    update({ error: null });

    let answer: A;
    try {
      // The transport is untyped and socket.io's ack typing does not survive
      // `timeout()` anyway; the protocol's answer type is asserted once, here.
      answer = (await transport
        .timeout(ANSWER_MS)
        .emitWithAck(protocol.join, protocol.ask({ code, name, token, password }, about))) as A;
    } catch {
      if (pending?.attempt !== attempt) return false;
      pending = null;
      // A seat held before the drop is still assumed held: nothing has said
      // otherwise, and the next connection will present it again.
      update({ error: protocol.quiet });
      return false;
    }
    if (pending?.attempt !== attempt) return false;
    pending = null;

    if (!answer.ok) {
      if (answer.needsPassword) passwordAsked = true;
      else if (token) {
        /**
         * The token is kept. The same refusal shape carries "the table carried
         * on without you" and "could not join" from a server having a bad
         * moment, and the token is the only proof of the seat there is. The
         * worst a spent one costs is one refused round trip per reconnect.
         */
        evicted = true;
        seatHeld = false;
      }
      update({ error: refusal(answer, protocol.refused) });
      return false;
    }

    seatHeld = true;
    passwordAsked = false;
    evicted = false;
    if (answer.playerToken) store.set(keys.token, answer.playerToken);
    if (answer.playerId && keys.id) store.set(keys.id, answer.playerId);
    // The name rides with the token: a silent rejoin that sent an empty name was
    // refused by the schema, token or no token. The shared nickname and the
    // front page's way back are refreshed on the silent ones too, which keeps
    // the seat's timestamp honest.
    store.set(keys.name, name);
    rememberNickname(name);
    noteSeat(protocol.game, code, name);
    update({ grant: answer, error: null, view: protocol.view(answer) ?? snapshot.view });
    return true;
  }

  /**
   * A reconnect past socket.io's recovery window is a *new* connection, and the
   * server no longer knows which game it belongs to, so the seat has to be
   * re-presented. That is an edge, not a level: once each time the line comes
   * up, the first time included (a refresh), and at no other moment. Keyed on
   * anything else (the seat being granted, a callback changing identity) it
   * fires twice, which costs a round trip, a roster broadcast to the whole room
   * and a latency probe at a phone that had just been measured.
   *
   * A seat is remembered when both its token and its name are: a token without
   * a name could only be presented under a made-up one.
   */
  function onConnect(): void {
    connected = true;
    generation += 1;
    pending = null;
    const token = store.get(keys.token);
    const name = store.get(keys.name);
    if (token && name) void present(name);
    else update({ error: null });
  }

  function onDisconnect(): void {
    connected = false;
    update();
  }

  async function call<E extends Asked<C>>(event: E, payload: PayloadOf<C[E]>): Promise<Answered<AckOf<C[E]>>> {
    try {
      return answered(await transport.timeout(ANSWER_MS).emitWithAck(event, payload)) as Answered<AckOf<C[E]>>;
    } catch {
      return { ok: false, error: protocol.quiet } as Answered<AckOf<C[E]>>;
    }
  }

  /** What the seat itself listens for on the line, so `close` can let go of exactly these. */
  const seatListeners: [string, Listener][] = [
    ['connect', onConnect],
    ['disconnect', onDisconnect],
    ['connect_error', () => update({ error: msg('net.unreachable') })],
    [protocol.state, (view: V) => update({ view })],
    [
      protocol.error,
      (payload: { message?: unknown } | undefined) => {
        const message = said(payload?.message);
        if (message) update({ error: message });
      }
    ]
  ];
  for (const [event, listener] of seatListeners) transport.on(event, listener);
  if (transport.connected) onConnect();

  return {
    snapshot: () => snapshot,
    subscribe: (subscriber) => {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    join: (name, password) => {
      // socket.io would buffer a join sent on a dead line and deliver it on the
      // next connection, answered on a line this seat has already moved past.
      if (!connected || pending?.generation === generation) return Promise.resolve(false);
      return present(name.trim() || (store.get(keys.name) ?? ''), password || undefined);
    },
    call,
    send: (event, ...args) => transport.emit(event, ...args),
    on: (event, listener) => {
      // `S[E]` is one of the server map's listeners; the transport takes any.
      const heard = listener as Listener;
      transport.on(event, heard);
      return () => transport.off(event, heard);
    },
    describe: (next) => {
      if (Object.is(next, about)) return;
      about = next;
      const name = store.get(keys.name);
      if (snapshot.status === 'seated' && name) void present(name);
    },
    close: () => {
      for (const [event, listener] of seatListeners) transport.off(event, listener);
      connected = false;
      update();
      subscribers.clear();
    }
  };
}

function isMsg(value: unknown): value is Msg {
  return typeof value === 'object' && value !== null && typeof (value as { k?: unknown }).k === 'string';
}

/**
 * Whatever the server said, as a `Msg`.
 *
 * A sentence (the quiz and the raid still send a few in French) rides as a key
 * that no catalogue has, which the renderer hands back verbatim: the same words
 * the screen showed before, and a real key the day the server sends one.
 *
 * Through `msgOf`, the escape hatch, because that is exactly what it is: text
 * the server chose at runtime, which no type on this side can check.
 */
export function said(value: unknown): Msg | undefined {
  if (isMsg(value)) return value;
  if (typeof value === 'string' && value.trim()) return msgOf(value);
  return undefined;
}

/**
 * Why a join was refused.
 *
 * At a door, the server's own `Msg` if it sent one (Mafia), and otherwise the
 * shared "wrong password": the quiz and the raid send a French sentence there
 * that their screens have always replaced.
 */
function refusal(answer: JoinAnswer, fallback: Msg): Msg {
  if (answer.needsPassword) return isMsg(answer.error) ? answer.error : msg('room.wrong');
  return said(answer.error) ?? fallback;
}

function answered(answer: unknown): unknown {
  if (typeof answer !== 'object' || answer === null || !('error' in answer)) return answer;
  const { error, ...rest } = answer;
  const message = said(error);
  return message ? { ...rest, error: message } : rest;
}
