import { roleDef, type Faction, type RoleId } from './roles.js';
import type { MafiaPlayer, MafiaState } from './state.js';

/** What the table has been told a seat is: its role, its camp, either, or neither. */
export interface PublicIdentity {
  role: RoleId | null;
  faction: Faction | null;
}

const NOTHING: PublicIdentity = { role: null, faction: null };

/**
 * Whether this seat's body was cleaned: found, but saying nothing.
 *
 * The janitor's charge buys exactly that, whatever the table's reveal policy.
 */
export function bodyCleaned(state: MafiaState, player: MafiaPlayer): boolean {
  return state.deaths.some((death) => death.playerId === player.playerId && death.hidden);
}

/**
 * What the table has been told a seat is, the one rule every screen reads.
 *
 * The roster on the phones, the dawn report and the bots' board all project
 * this, and it used to be written out separately in each of them; the board's
 * copy drifted and told the bots a faction-revealed corpse's real role.
 *
 * - The end of the game lifts every mask.
 * - A sash a living seat has taken out is public: the town announced it by name.
 * - A cleaned body says nothing, whatever the policy; the power was paid for.
 * - Otherwise a body says what `revealOnDeath` allows: the whole role, the camp
 *   alone, or nothing.
 *
 * Always the seat's true `role`, never `disguiseRole`: a borrowed face fools
 * examiners, not the undertaker. A role that was genuinely changed (audited,
 * converted, remembered, initiated) reveals what it became.
 */
export function publicIdentity(state: MafiaState, player: MafiaPlayer): PublicIdentity {
  const role = player.role;
  if (role === null) return NOTHING;
  const whole = { role, faction: roleDef(role).faction };
  if (state.phase === 'ended') return whole;
  if (player.alive) return player.revealed ? whole : NOTHING;
  if (bodyCleaned(state, player)) return NOTHING;
  switch (state.config.revealOnDeath ?? 'role') {
    case 'role':
      return whole;
    case 'faction':
      return { role: null, faction: whole.faction };
    default:
      return NOTHING;
  }
}

/**
 * What the table may read of a seat's last will: the text, or nothing.
 *
 * A rule of its own beside `publicIdentity`, not a case of it. The reveal
 * policy decides what a body is shown as, and stops there: a will is what its
 * owner chose to write, and a body that was found is read out under any
 * `revealOnDeath`.
 *
 * - The end of the game lifts every mask, the living's included.
 * - A living seat's will is its own, sash or no sash.
 * - A cleaned body says nothing, will included: that is what the power buys.
 */
export function publicWill(state: MafiaState, player: MafiaPlayer): string | null {
  const readable = state.phase === 'ended' || (!player.alive && !bodyCleaned(state, player));
  return readable && player.lastWill ? player.lastWill : null;
}
