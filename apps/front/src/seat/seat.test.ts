import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { HEARTBEAT_MS } from 'presence-core';

import { czSeat, mafiaSeat, quizSeat } from './protocols';
import { createSeat, type SeatStore, type Transport } from './seat';

/**
 * The seat, driven through its interface with a fake line and a fake store.
 *
 * The line stands in for socket.io and the store for `localStorage`; nothing
 * else is faked. The server is whatever the test scripts: `serve` answers an
 * event the way the real handler would, and leaving an event unserved is a
 * server that never answers.
 */

type Listener = (...args: never[]) => void;

class FakeLine implements Transport {
  connected = false;
  private listeners = new Map<string, Set<Listener>>();
  private answers = new Map<string, (payload: unknown) => unknown>();
  /** Every acknowledged request, in order. */
  readonly requests: { event: string; payload: unknown }[] = [];
  /** Every fire-and-forget event, with what it carried, in order. */
  readonly emitted: { event: string; args: unknown[] }[] = [];

  timeout(ms: number) {
    return {
      emitWithAck: (event: string, ...args: unknown[]): Promise<unknown> => {
        const payload = args[0];
        this.requests.push({ event, payload });
        const answer = this.answers.get(event);
        if (answer) return Promise.resolve(answer(payload));
        // socket.io's own behaviour for an ack that never comes.
        return new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('operation has timed out')), ms);
        });
      }
    };
  }

  emit(event: string, ...args: unknown[]): void {
    this.emitted.push({ event, args });
  }

  on(event: string, listener: Listener): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
  }

  off(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  /** How the server answers `event` from now on. */
  serve(event: string, answer: (payload: unknown) => unknown): void {
    this.answers.set(event, answer);
  }

  /** The server stops answering `event`. */
  silence(event: string): void {
    this.answers.delete(event);
  }

  /** The server saying something nobody asked for. */
  push(event: string, ...args: unknown[]): void {
    this.fire(event, ...args);
  }

  up(): void {
    this.connected = true;
    this.fire('connect');
  }

  down(): void {
    this.connected = false;
    this.fire('disconnect');
  }

  sent(event: string): Record<string, unknown>[] {
    return this.requests
      .filter((request) => request.event === event)
      .map((request) => request.payload as Record<string, unknown>);
  }

  private fire(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) (listener as (...values: unknown[]) => void)(...args);
  }
}

function memoryStore(initial: Record<string, string> = {}): SeatStore {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => void values.set(key, value)
  };
}

/** Lets every answer already given reach the seat. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('a seat', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }));
  afterEach(() => mock.timers.reset());

  it('presents a remembered seat once each time the line comes up, the first time included', async () => {
    const line = new FakeLine();
    line.serve('session:join', () => ({ ok: true, playerToken: 'tok-1', playerId: 'p1' }));
    const seat = createSeat(
      quizSeat,
      'ABCD',
      line,
      memoryStore({ 'kune.player.ABCD': 'tok-1', 'kune.player.ABCD.name': 'Ada' })
    );

    line.up();
    await settle();
    assert.equal(line.sent('session:join').length, 1);
    assert.equal(line.sent('session:join')[0].playerToken, 'tok-1');
    assert.equal(line.sent('session:join')[0].playerName, 'Ada');
    assert.equal(seat.snapshot().status, 'seated');

    line.down();
    assert.equal(seat.snapshot().status, 'connecting');
    line.up();
    await settle();
    assert.equal(line.sent('session:join').length, 2);
    assert.equal(seat.snapshot().status, 'seated');
  });

  it('joins once when a name is typed, not again because the seat was granted', async () => {
    const line = new FakeLine();
    line.serve('session:join', () => ({ ok: true, playerToken: 'tok-new', playerId: 'p7' }));
    const store = memoryStore();
    const seat = createSeat(quizSeat, 'ABCD', line, store);

    line.up();
    await settle();
    assert.equal(seat.snapshot().status, 'anonymous');
    assert.equal(line.sent('session:join').length, 0);

    assert.equal(await seat.join('  Ada '), true);
    await settle();
    assert.equal(seat.snapshot().status, 'seated');
    assert.equal(line.sent('session:join').length, 1);
    assert.equal(line.sent('session:join')[0].playerName, 'Ada');
    // Read by the host screen, which gives up its own solo seat by this id.
    assert.equal(store.get('kune.player.ABCD.id'), 'p7');

    // The token that came back is the one the next connection presents.
    line.down();
    line.up();
    await settle();
    assert.equal(line.sent('session:join').length, 2);
    assert.equal(line.sent('session:join')[1].playerToken, 'tok-new');
  });

  it('is locked by a room with a door, and stays locked through a wrong word', async () => {
    const line = new FakeLine();
    // What the quiz handler answers: a flag, and a sentence the phone ignores.
    line.serve('session:join', (payload) =>
      (payload as { password?: string }).password === 'sesame'
        ? { ok: true, playerToken: 'tok-door', playerId: 'p2' }
        : { ok: false, needsPassword: true, error: 'Mot de passe incorrect' }
    );
    const seat = createSeat(quizSeat, 'ABCD', line, memoryStore());
    line.up();
    await settle();

    await seat.join('Ada');
    assert.equal(seat.snapshot().status, 'locked');
    assert.deepEqual(seat.snapshot().error, { k: 'room.wrong' });

    const guess = seat.join('Ada', 'nope');
    // The box stays up while the word is out: the room still has a door.
    assert.equal(seat.snapshot().status, 'locked');
    assert.equal(await guess, false);
    assert.equal(line.sent('session:join')[1].password, 'nope');
    assert.equal(seat.snapshot().status, 'locked');
    assert.deepEqual(seat.snapshot().error, { k: 'room.wrong' });

    assert.equal(await seat.join('Ada', 'sesame'), true);
    assert.equal(seat.snapshot().status, 'seated');
    assert.equal(seat.snapshot().error, null);
  });

  it('turns a server that never answers into a message after five seconds, not an exception', async () => {
    const line = new FakeLine();
    const seat = createSeat(quizSeat, 'ABCD', line, memoryStore());
    line.up();
    await settle();

    const attempt = seat.join('Ada');
    mock.timers.tick(4999);
    await settle();
    assert.equal(seat.snapshot().status, 'joining');
    assert.equal(seat.snapshot().error, null);

    mock.timers.tick(1);
    assert.equal(await attempt, false);
    assert.equal(seat.snapshot().status, 'anonymous');
    assert.deepEqual(seat.snapshot().error, { k: 'play.serverQuiet' });
  });

  it('is evicted when the server refuses the seat it remembers, and keeps the token', async () => {
    const line = new FakeLine();
    line.serve('mafia:join', () => ({ ok: false, error: { k: 'mafia.refuse.tableMovedOn' } }));
    const store = memoryStore({ 'kune.mafia.player.WXYZ': 'tok-gone', 'kune.mafia.player.WXYZ.name': 'Bo' });
    const seat = createSeat(mafiaSeat, 'WXYZ', line, store);

    line.up();
    await settle();
    assert.equal(seat.snapshot().status, 'evicted');
    assert.deepEqual(seat.snapshot().error, { k: 'mafia.refuse.tableMovedOn' });

    /**
     * Not forgotten: a refusal is also what a server having a bad moment sends
     * (`joinFailed`), and the token is the only proof of the seat there is.
     */
    line.down();
    line.up();
    await settle();
    assert.equal(line.sent('mafia:join').length, 2);
    assert.equal(line.sent('mafia:join')[1].playerToken, 'tok-gone');
  });

  it('shows what the server last said: the answer that seated it, then every broadcast', async () => {
    const line = new FakeLine();
    line.serve('session:join', () => ({ ok: true, playerToken: 't', playerId: 'p1', session: { phase: 'lobby' } }));
    const seat = createSeat(quizSeat, 'ABCD', line, memoryStore());
    let heard = 0;
    const stop = seat.subscribe(() => (heard += 1));
    line.up();
    await settle();

    await seat.join('Ada');
    assert.deepEqual(seat.snapshot().view, { phase: 'lobby' });
    assert.equal(seat.snapshot().grant?.playerId, 'p1');

    line.push('session:state', { phase: 'playing' });
    assert.deepEqual(seat.snapshot().view, { phase: 'playing' });

    const before = heard;
    assert.ok(before > 0);
    stop();
    line.push('session:state', { phase: 'finished' });
    assert.equal(heard, before);
  });

  it('reports an unreachable server and whatever the server says went wrong as messages', async () => {
    const line = new FakeLine();
    const seat = createSeat(quizSeat, 'ABCD', line, memoryStore());

    line.push('connect_error', new Error('xhr poll error'));
    assert.deepEqual(seat.snapshot().error, { k: 'net.unreachable' });

    line.up();
    await settle();
    assert.equal(seat.snapshot().error, null);

    // The quiz still speaks French sentences; they ride as keys no catalogue has,
    // which the renderer hands back verbatim.
    line.push('session:error', { message: 'Vous avez été retiré de la partie' });
    assert.deepEqual(seat.snapshot().error, { k: 'Vous avez été retiré de la partie' });
  });

  it('beats while seated, pauses while the line is down, and stops for good when closed', async () => {
    const line = new FakeLine();
    line.serve('cz:join', () => ({ ok: true, playerToken: 'tok-z', playerId: 'z1' }));
    const seat = createSeat(
      czSeat,
      'RAID',
      line,
      memoryStore({ 'kune.cz.player.RAID': 'tok-z', 'kune.cz.player.RAID.name': 'Cy' })
    );
    const beats = () => line.emitted.filter((sent) => sent.event === 'cz:beat').length;

    mock.timers.tick(HEARTBEAT_MS * 3);
    assert.equal(beats(), 0);

    line.up();
    await settle();
    // At once, so coming back is reported without waiting out an interval.
    assert.equal(beats(), 1);
    mock.timers.tick(HEARTBEAT_MS);
    mock.timers.tick(HEARTBEAT_MS);
    assert.equal(beats(), 3);

    line.down();
    mock.timers.tick(HEARTBEAT_MS * 3);
    assert.equal(beats(), 3);

    line.up();
    await settle();
    assert.equal(beats(), 4);

    seat.close();
    mock.timers.tick(HEARTBEAT_MS * 3);
    assert.equal(beats(), 4);
  });

  it("answers a call with the server's answer, its refusal as a message, or the silence as one", async () => {
    const line = new FakeLine();
    line.serve('answer:submit', (payload) =>
      (payload as { value: string }).value === 'Paris'
        ? { ok: true, correct: true, points: 120 }
        : { ok: false, error: 'Trop tard' }
    );
    const seat = createSeat(quizSeat, 'ABCD', line, memoryStore());
    line.up();
    await settle();
    const answer = (value: string) => ({ roundId: 'r1', fieldKey: 'city', value, clientTime: 0, direct: false });

    assert.deepEqual(await seat.call('answer:submit', answer('Paris')), { ok: true, correct: true, points: 120 });
    assert.deepEqual(await seat.call('answer:submit', answer('Lyon')), { ok: false, error: { k: 'Trop tard' } });

    const buzz = seat.call('answer:buzz', { roundId: 'r1', clientTime: 0 });
    mock.timers.tick(5000);
    assert.deepEqual(await buzz, { ok: false, error: { k: 'play.serverQuiet' } });
  });

  it("passes the game's other events through: sends as they are, subscriptions until let go", async () => {
    const line = new FakeLine();
    const seat = createSeat(czSeat, 'RAID', line, memoryStore());
    line.up();
    await settle();

    seat.send('cz:start', { hostToken: 'host-1' });
    assert.deepEqual(line.emitted, [{ event: 'cz:start', args: [{ hostToken: 'host-1' }] }]);

    const heard: unknown[] = [];
    const stop = seat.on('cz:rewards', (rewards) => heard.push(rewards));
    line.push('cz:rewards', ['first']);
    stop();
    line.push('cz:rewards', ['second']);
    assert.deepEqual(heard, [['first']]);
  });

  it('says what the phone speaks with every join, and says it again when a seated phone switches', async () => {
    const line = new FakeLine();
    line.serve('mafia:join', () => ({ ok: true, playerToken: 'tok-m', playerId: 'm1' }));
    const seat = createSeat(
      mafiaSeat,
      'WXYZ',
      line,
      memoryStore({ 'kune.mafia.player.WXYZ': 'tok-m', 'kune.mafia.player.WXYZ.name': 'Bo' })
    );

    seat.describe('fr');
    assert.equal(line.sent('mafia:join').length, 0);
    line.up();
    await settle();
    assert.equal(line.sent('mafia:join')[0].locale, 'fr');

    seat.describe('fr');
    assert.equal(line.sent('mafia:join').length, 1);

    seat.describe('en');
    await settle();
    assert.equal(line.sent('mafia:join').length, 2);
    assert.equal(line.sent('mafia:join')[1].locale, 'en');
    assert.equal(line.sent('mafia:join')[1].playerToken, 'tok-m');
    assert.equal(seat.snapshot().status, 'seated');
  });

  it("sends one join at a time on a line, and lets a dead line's answer change nothing", async () => {
    const line = new FakeLine();
    const seat = createSeat(
      quizSeat,
      'ABCD',
      line,
      memoryStore({ 'kune.player.ABCD': 'tok-1', 'kune.player.ABCD.name': 'Ada' })
    );

    // The server is slow to answer the first presentation...
    line.up();
    await settle();
    void seat.join('Ada');
    assert.equal(line.sent('session:join').length, 1);

    // ...and the line drops and comes back before it does. The new connection
    // is a stranger to the server, so it presents the seat regardless.
    line.down();
    line.serve('session:join', () => ({ ok: true, playerToken: 'tok-1', playerId: 'p1' }));
    line.up();
    await settle();
    assert.equal(line.sent('session:join').length, 2);
    assert.equal(seat.snapshot().status, 'seated');

    mock.timers.tick(5000);
    await settle();
    assert.equal(seat.snapshot().status, 'seated');
    assert.equal(seat.snapshot().error, null);
  });

  it('keeps the seat it had when a reconnect goes unanswered, and says the server is quiet', async () => {
    const line = new FakeLine();
    line.serve('cz:join', () => ({ ok: true, playerToken: 'tok-z', playerId: 'z1' }));
    const seat = createSeat(
      czSeat,
      'RAID',
      line,
      memoryStore({ 'kune.cz.player.RAID': 'tok-z', 'kune.cz.player.RAID.name': 'Cy' })
    );
    line.up();
    await settle();

    line.down();
    line.silence('cz:join');
    line.up();
    await settle();
    assert.equal(seat.snapshot().status, 'joining');
    mock.timers.tick(5000);
    await settle();
    assert.equal(seat.snapshot().status, 'seated');
    assert.deepEqual(seat.snapshot().error, { k: 'cz.play.serverQuiet' });
  });

  it('joins only on a live line: none while it is down, at once on one already open', async () => {
    const line = new FakeLine();
    line.serve('session:join', () => ({ ok: true, playerToken: 'tok-1', playerId: 'p1' }));
    const store = memoryStore();
    const seat = createSeat(quizSeat, 'ABCD', line, store);

    // socket.io would buffer it and send it on the next connection, whose
    // answer belongs to a line this seat has already moved past.
    assert.equal(await seat.join('Ada'), false);
    assert.equal(line.sent('session:join').length, 0);
    seat.close();

    store.set('kune.player.ABCD', 'tok-1');
    store.set('kune.player.ABCD.name', 'Ada');
    line.up();
    const late = createSeat(quizSeat, 'ABCD', line, store);
    await settle();
    assert.equal(line.sent('session:join').length, 1);
    assert.equal(late.snapshot().status, 'seated');
  });
});
