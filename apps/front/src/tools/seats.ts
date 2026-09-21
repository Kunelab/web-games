import { isLobbyGame, type LobbyGame } from 'lobby-core';

import { api, ApiError } from '../api/client';

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
 * shortcut would otherwise send somebody into an error screen.
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

/**
 * Does this code still name a game, and which game is it?
 *
 * Codes share one namespace across the three engines on purpose, so a player
 * can type one without knowing which game it belongs to. Asking means asking
 * each engine in turn. A 404 everywhere is the only answer that means the code
 * is wrong; anything else is the server having a bad day and is reported as
 * such rather than as "no such game".
 */
const SUMMARY: Record<LobbyGame, (code: string) => Promise<unknown>> = {
  quiz: (code) => api.sessionSummary(code),
  coronaz: (code) => api.czSummary(code),
  mafia: (code) => api.mafiaSummary(code)
};

export class ProbeFailed extends Error {}

/** True if the game still exists, false on a clean 404. Throws if the server is unwell. */
export async function seatIsLive(game: LobbyGame, code: string): Promise<boolean> {
  try {
    await SUMMARY[game](code);
    return true;
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) return false;
    throw new ProbeFailed(`could not check ${game} ${code}`, { cause });
  }
}

/**
 * Which game a bare code belongs to, or null if none of them claims it.
 *
 * Throws `ProbeFailed` when an engine answered with something other than a
 * 404, because "the server is down" and "you mistyped the code" deserve
 * different sentences on screen.
 */
export async function gameForCode(code: string): Promise<LobbyGame | null> {
  const games: LobbyGame[] = ['quiz', 'coronaz', 'mafia'];
  for (const game of games) {
    if (await seatIsLive(game, code)) return game;
  }
  return null;
}

/** The remembered seats whose games are still running, newest first. */
export async function liveSeats(): Promise<Seat[]> {
  const seats = rememberedSeats();
  const checked = await Promise.all(
    seats.map(async (seat) => {
      try {
        return (await seatIsLive(seat.game, seat.code)) ? seat : null;
      } catch {
        // Unreachable is not the same as finished. Keep the offer; the worst
        // case is a shortcut that fails the same way the rest of the page did.
        return seat;
      }
    })
  );

  // The ones the server said are over are dropped for good, not merely hidden:
  // they would otherwise be re-checked on every visit for the next eight hours.
  for (const [index, seat] of seats.entries()) {
    if (checked[index] === null) forgetSeat(seat.game, seat.code);
  }

  return checked.filter((seat): seat is Seat => seat !== null);
}
