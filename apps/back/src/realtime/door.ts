/**
 * The word at the door, checked the same way for all three games.
 *
 * A room password is not an account password and this file exists to keep the
 * difference explicit. It guards one evening, it is typed on a phone by somebody
 * standing in the room, and it is frequently read off a television — so it is
 * stored and compared in the clear, and the only thing the server promises about
 * it is that it never leaves the server. Nothing projects it into a view.
 *
 * The rule that matters more than the comparison is **who is asked**. Only a
 * phone taking a new seat is: a token that names somebody already seated has
 * been through the door once, and asking again would mean every reload, every
 * lift, every phone that locked itself during a night phase had to have the
 * password retyped by whoever is holding it. That is the shape of a feature
 * people turn off.
 */

/** True when this room has a door at all. */
export function isLocked(password: string | undefined): boolean {
  return (password ?? '').length > 0;
}

/**
 * Whether the phone may come in.
 *
 * `returning` is the caller's answer to "does this token already name a seat
 * here", which only the game's own state can settle — so each engine works it
 * out and hands the verdict in, rather than this file learning three shapes of
 * roster.
 */
export function mayEnter(
  password: string | undefined,
  offered: string | undefined,
  returning: boolean
): { ok: true } | { ok: false; needsPassword: true } {
  if (!isLocked(password) || returning) return { ok: true };
  if ((offered ?? '').trim() === password) return { ok: true };
  return { ok: false, needsPassword: true };
}
