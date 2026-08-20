import type { CzState } from './state.js';

/**
 * One thing that happens to the district, rolled at the top of each enemy phase.
 *
 * The reason this exists: turn six played exactly like turn five. Every turn of a
 * raid asked the same question with a bigger number attached — three action points,
 * move or search or shoot, and a horde that is now slightly larger. The escalation
 * curve made the raid *harder* over time and never made it *different*, so a table
 * had seen the whole shape of the game by its third evening.
 *
 * Four rules keep these from becoming the thing that decides raids:
 *
 * 1. **They cancel out.** The set is built in pairs that pull opposite ways — a
 *    swarm against a lull, a supply drop against a siren, a blackout against a
 *    flare. Across a raid the expected effect is close to nothing, which is what
 *    lets the difficulty ladder the simulator spent five versions calibrating stay
 *    exactly where it is.
 * 2. **They last one turn.** Nothing here compounds and nothing is permanent,
 *    except a supply drop's crate, which is a place on the map rather than a stat.
 * 3. **They are announced.** An event nobody can read is indistinguishable from a
 *    bug — which is the same reason the loot bonus is drawn on the floor and the
 *    room's remaining finds are printed on the phone.
 * 4. **They never touch the walls.** No event opens or closes a boundary. The
 *    generator guarantees the world is one connected place, windows were carefully
 *    designed not to break that, and a random event is the last thing that should
 *    be allowed to stand a raid up on an unreachable exit.
 */

export type CzEventId = 'siren' | 'drop' | 'swarm' | 'calm' | 'blackout' | 'flare';

export interface CzEventDef {
  id: CzEventId;
  name: string;
  emoji: string;
  /** One line, shown on the television and on every phone. */
  blurb: string;
  /**
   * Which way it pulls, for the pairing rule above. The set must stay balanced:
   * a test asserts the sum is zero, because "they cancel out" is the entire
   * argument for why this feature does not need the ladder re-tuned.
   */
  favours: 'heroes' | 'horde';
}

export const CZ_EVENTS: readonly CzEventDef[] = [
  {
    id: 'siren',
    name: 'Sirène',
    emoji: '📢',
    blurb: 'Une alarme hurle quelque part : la horde se détourne vers elle.',
    favours: 'horde'
  },
  {
    id: 'drop',
    name: 'Largage',
    emoji: '📦',
    blurb: 'Une caisse tombe du ciel. Quelqu’un devrait aller voir.',
    favours: 'heroes'
  },
  {
    id: 'swarm',
    name: 'Nuée',
    emoji: '🐝',
    blurb: 'Les salles d’apparition crachent deux fois ce tour.',
    favours: 'horde'
  },
  {
    id: 'calm',
    name: 'Accalmie',
    emoji: '🌙',
    blurb: 'Rien ne vient, ce tour-ci. Profitez-en.',
    favours: 'heroes'
  },
  {
    id: 'blackout',
    name: 'Coupure',
    emoji: '🔌',
    blurb: 'Le quartier s’éteint : on ne voit plus que la salle où l’on se tient.',
    favours: 'horde'
  },
  {
    id: 'flare',
    name: 'Fusée éclairante',
    emoji: '🎆',
    blurb: 'Tout le quartier est éclairé, le temps d’un tour.',
    favours: 'heroes'
  }
];

export function eventDef(id: CzEventId): CzEventDef | undefined {
  return CZ_EVENTS.find((event) => event.id === id);
}

/**
 * How often anything happens at all.
 *
 * A third of turns: often enough that a raid has three or four of them and no two
 * raids read the same, rare enough that an ordinary turn is still the default and
 * the events stay memorable rather than becoming weather.
 */
export const EVENT_CHANCE = 0.34;

/** The turn from which events may fire. Never the first: the opening is enough. */
export const EVENT_FROM_TURN = 3;

/** Whether the horde's sight-and-spawn rules are bent this turn. */
export function eventActive(state: CzState, id: CzEventId): boolean {
  return state.event === id;
}
