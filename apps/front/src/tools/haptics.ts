/**
 * The one channel that works in a loud room with the phone on a knee.
 *
 * A party is the worst possible environment for a screen: the television has
 * everyone's eyes, the room has everyone's ears, and the phone has neither
 * until it asks for attention. Vibration is the only thing it can do that
 * reaches its owner through a pocket, so the moments worth interrupting
 * somebody for are spelled out here rather than left as bare millisecond
 * arrays at the call sites.
 *
 * Deliberately not a hook and not configurable. `navigator.vibrate` is ignored
 * outright by iOS Safari and by any desktop, and it is already silenced by the
 * system when the phone is not on vibrate, so there is nothing here that needs
 * a preference of its own: a player who does not want it has already told
 * their phone.
 */

export type Haptic = 'joined' | 'won' | 'lost' | 'sent' | 'turn' | 'phase';

/**
 * What each pattern is for, in the order a game night meets them.
 *
 * Written out rather than inferred with `as const`, because `vibrate` wants a
 * mutable `number[]` and a frozen tuple is the one thing it will not take. The
 * `Record<Haptic, …>` is what keeps the table and the union in step.
 */
const PATTERNS: Record<Haptic, number | number[]> = {
  /** You are in. Confirms a join that otherwise only changes the screen. */
  joined: 30,
  /** The buzzer is yours: answer now. The one that must not be missed. */
  won: [0, 60, 50, 120],
  /** Somebody beat you to it, or your press landed too late. */
  lost: [0, 25, 40, 25],
  /** The server took your answer. A full stop, not a verdict. */
  sent: 20,
  /** The game is waiting on you specifically: your night action, your vote. */
  turn: [0, 40, 60, 40, 60, 40],
  /** A phase changed under you while you were not looking. */
  phase: 45
};

export function buzz(pattern: Haptic): void {
  // `vibrate` is missing on desktop Safari and on any browser without a motor.
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(PATTERNS[pattern]);
  } catch {
    // Some browsers throw rather than return false when the page is hidden.
  }
}
