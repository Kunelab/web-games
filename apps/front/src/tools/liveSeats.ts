import type { LobbyGame } from 'lobby-core';

import { api, ApiError } from '../api/client';
import { forgetSeat, rememberedSeats, type Seat } from './seats';

/**
 * The seat index (`tools/seats`), checked against the server.
 *
 * Its own file so the index itself loads without the API client: the seat
 * writes to the index on every grant, and is tested under node, where the
 * client's module cannot even be evaluated.
 */

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
