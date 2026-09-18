import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideNightTarget, makeBrain, makePersonality, type PublicInfo } from './policies.js';
import type { MafiaPlayer } from '../state.js';

/**
 * Where the match goes on the first night, when the board is blank.
 *
 * Night one has no claims on it, so every rule that ranks a seat by what it has
 * said scores nothing and the ranked list comes back empty. What a killer does
 * with an empty ranking is the whole question: the mafia's own branch falls
 * back to a uniform draw, and the arsonist's did not.
 */
function board(alive: number[]): PublicInfo {
  return {
    day: 1,
    aliveSlots: alive,
    deadRoles: new Map(),
    lastNightDeathSlots: new Set(),
    nightDeathsTotal: 0,
    rampage: 0,
    votes: new Map(),
    totalDead: 0,
    trials: [],
    voteHistory: [],
    revealedMayorSlot: null,
    humanSlots: new Set(),
    claims: [],
    deaths: [],
    provenRoles: new Map()
  } as unknown as PublicInfo;
}

describe('the arsonist on night one', () => {
  it('does not pour its petrol on the lowest seat every time', () => {
    const alive = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const self = { slot: 7, role: 'arsonist', intel: [] } as unknown as MafiaPlayer;
    const info = board(alive);

    const hits = new Map<number, number>();
    for (let run = 0; run < 4000; run++) {
      let seed = run * 2654435761 + 1;
      const rng = () => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return seed / 2 ** 31;
      };
      const brain = makeBrain(self.slot, makePersonality({ courage: 0.5, aggression: 0.5 } as never, rng));
      const pick = decideNightTarget(
        self,
        brain,
        info,
        alive.filter((slot) => slot !== self.slot),
        'douse',
        new Set(),
        [],
        rng
      );
      if (pick !== null) hits.set(pick, (hits.get(pick) ?? 0) + 1);
    }

    const total = [...hits.values()].reduce((sum, count) => sum + count, 0);
    const first = (hits.get(1) ?? 0) / total;

    /**
     * Eleven houses are legal and none of them has said a word, so nothing on
     * the board distinguishes house 1 from house 12. A fair draw gives it 9%.
     * The bar is deliberately loose — this is testing that the choice is a
     * choice at all, not that the draw is perfectly flat.
     */
    assert.ok(first < 0.2, `house 1 took the match ${(first * 100).toFixed(1)}% of the time, from a blank board`);
  });
});
