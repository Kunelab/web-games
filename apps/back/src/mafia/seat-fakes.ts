import { BotMinds } from './bot-mind.js';
import { Seat } from './seat.js';

/**
 * A phrasebook seat on its own, for tests: no driver, no timers, no model.
 *
 * What the seat would ask the driver around it is answered inertly: no trial
 * has been read, no private room has been heard, and nobody calls the room for
 * clues. The will hook and the dice are the test's to choose.
 */
export function seatAlone(
  options: { will?: (code: string, botId: string, text: string) => void; rng?: () => number } = {}
): { seat: Seat; minds: BotMinds } {
  const minds = new BotMinds();
  const seat = new Seat({
    minds,
    jury: () => undefined,
    roomHeard: () => undefined,
    callForClues: () => false,
    will: options.will ?? (() => undefined),
    rng: options.rng ?? Math.random
  });
  return { seat, minds };
}
