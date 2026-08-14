/**
 * Deterministic randomness, carried inside the game state.
 *
 * Every die, every loot roll and every reinforcement goes through this, seeded at
 * game creation. That is what makes the engine testable (a seed is a full script
 * of the game's luck) and the state restorable: the RNG position is a plain number
 * in the snapshot, so a server restart resumes the same sequence instead of
 * reshuffling the world.
 *
 * mulberry32: small, fast, and far better distributed than it has any right to be.
 */

export interface RngState {
  /** Mutated on every draw. Serialise it with the game. */
  value: number;
}

export function seedRng(seed: number): RngState {
  return { value: seed >>> 0 };
}

/** Uniform in [0, 1). */
export function rand(rng: RngState): number {
  rng.value = (rng.value + 0x6d2b79f5) >>> 0;
  let t = rng.value;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function randInt(rng: RngState, maxExclusive: number): number {
  return Math.floor(rand(rng) * maxExclusive);
}

export function d6(rng: RngState): number {
  return 1 + randInt(rng, 6);
}

export function pick<T>(rng: RngState, items: readonly T[]): T {
  const item = items[randInt(rng, items.length)];
  if (item === undefined) {
    throw new Error('pick from an empty list');
  }
  return item;
}

export function chance(rng: RngState, probability: number): boolean {
  return rand(rng) < probability;
}

/** Fisher-Yates, in place is avoided: callers keep their input. */
export function shuffled<T>(rng: RngState, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    const a = copy[i];
    const b = copy[j];
    if (a !== undefined && b !== undefined) {
      copy[i] = b;
      copy[j] = a;
    }
  }
  return copy;
}
