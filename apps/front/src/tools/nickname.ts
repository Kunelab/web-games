/**
 * The name you play under, remembered once for every game.
 *
 * It used to be stored per game *and per code*: the quiz kept
 * `kune.player.<code>.name`, CoronaZ kept its own, Mafia kept a third under an
 * older prefix. The effect on a real evening is that somebody who plays a quiz,
 * then a Mafia game, types their name twice, and types it again next Saturday
 * because every new code is a new stranger.
 *
 * So there is one key. The per-code name is still written where it was, because
 * it is what a silent rejoin sends back to the server and it has to keep
 * matching the seat, but the *box* is filled from here.
 */

export const NICKNAME_KEY = 'kune.nickname';

/** Long enough for a real name, short enough for a scoreboard on a television. */
export const NICKNAME_MAX = 24;

export function storedNickname(): string {
  try {
    return (localStorage.getItem(NICKNAME_KEY) ?? '').slice(0, NICKNAME_MAX);
  } catch {
    // A phone with storage disabled simply asks every time.
    return '';
  }
}

export function rememberNickname(name: string): void {
  const trimmed = name.trim().slice(0, NICKNAME_MAX);
  if (!trimmed) return;
  try {
    localStorage.setItem(NICKNAME_KEY, trimmed);
  } catch {
    // Nothing to do, and nothing worth telling the player about.
  }
}
