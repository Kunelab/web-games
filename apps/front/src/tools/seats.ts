import { isLobbyGame, type LobbyGame } from 'lobby-core';

/**
 * The games this phone was in, and whether they are still going on.
 *
 * Every join already leaves a token in `localStorage`, which is what makes a
 * refresh keep your seat. Nothing ever *read* that to offer a way back, so a
 * player who closed the tab, or opened one link too many, had no route to the
 * game they were in three seconds ago except asking the room to read the code
 * out again. The tokens are still the authority on rejoining; this is only an
 * index over them, so the screens have something to show without knowing where
 * three different games keep their keys.
 *
 * Two rules keep it from becoming clutter. An entry is **forgotten after a few
 * hours**, because a code from last Saturday is not an offer, it is a dead
 * link. And an entry is **checked against the server** before it is shown: a
 * game that has ended is gone from the board, which is exactly the moment the
 * shortcut would otherwise send somebody into an error screen. That check is
 * `tools/liveSeats`; this file touches nothing but storage.
 */

const KEY = 'kune.recent';

/** Long enough to survive an evening and a phone that locked through dinner. */
const MAX_AGE_MS = 8 * 60 * 60 * 1000;

/** Enough for the three games at once, plus the one you just left. */
const MAX_ENTRIES = 4;

export interface Seat {
  game: LobbyGame;
  code: string;
  /** The name this phone sat down under, which need not be the current nickname. */
  name: string;
  /** When the seat was last taken, as epoch milliseconds. */
  at: number;
}

function isSeat(value: unknown): value is Seat {
  if (typeof value !== 'object' || value === null) return false;
  const seat = value as Record<string, unknown>;
  return (
    typeof seat.game === 'string' &&
    isLobbyGame(seat.game) &&
    typeof seat.code === 'string' &&
    typeof seat.name === 'string' &&
    typeof seat.at === 'number'
  );
}

function read(): Seat[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - MAX_AGE_MS;
    return parsed.filter(isSeat).filter((seat) => seat.at > cutoff);
  } catch {
    // Unreadable storage, or something else wrote nonsense under this key.
    return [];
  }
}

function write(seats: Seat[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(seats.slice(0, MAX_ENTRIES)));
  } catch {
    // A phone with storage disabled has no tokens either, so it has nothing to
    // resume into. Losing the index costs it nothing it still had.
  }
}

/** Called whenever a join succeeds, including the silent ones on reconnect. */
export function noteSeat(game: LobbyGame, code: string, name: string): void {
  const others = read().filter((seat) => !(seat.game === game && seat.code === code));
  write([{ game, code, name, at: Date.now() }, ...others]);
}

/** Called when the seat is knowingly given up: a kick, a leave, a finished game. */
export function forgetSeat(game: LobbyGame, code: string): void {
  write(read().filter((seat) => !(seat.game === game && seat.code === code)));
}

/** What is remembered, newest first, without asking the server anything. */
export function rememberedSeats(): Seat[] {
  return read();
}
