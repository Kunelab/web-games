/**
 * Mutations: the survivors making their own night harder, on purpose.
 *
 * The table picks these in the lobby. Each one hands the horde something real and
 * pays the *heroes* for it: score at the end, and rations into whoever's account
 * is attached. It is the same bargain a difficulty preset offers, except chosen by
 * the people who will suffer it rather than by the host, and priced.
 *
 * Every effect is flat and additive, like the rest of this game's numbers. Nothing
 * here multiplies, nothing here is conditional, and the reward is stated in the same
 * breath as the cost so a table can weigh it in one read.
 */

export interface MutationDef {
  id: string;
  name: string;
  emoji: string;
  /** What it does to the horde, in one line. */
  blurb: string;
  /** Extra hit points on every creature. */
  hp?: number;
  /** Extra damage on every creature. */
  damage?: number;
  /** Extra action point for every creature. */
  ap?: number;
  /** Multiplies the reinforcement rate. */
  reinforcement?: number;
  /** Extra hit points on bosses only, on top of `hp`. */
  bossHp?: number;
  /**
   * What the table earns for taking it, as a share of the raid's score. Priced by
   * how much the effect actually costs a party, not by how it reads.
   */
  reward: number;
}

export const MUTATIONS: readonly MutationDef[] = [
  {
    id: 'thick',
    name: 'Peau épaisse',
    emoji: '🧱',
    blurb: '+10 PV à toute la horde.',
    hp: 10,
    reward: 0.15
  },
  {
    id: 'claws',
    name: 'Griffes',
    emoji: '🩸',
    blurb: '+10 dégâts à toute la horde.',
    damage: 10,
    reward: 0.2
  },
  {
    id: 'swift',
    name: 'Nerfs à vif',
    emoji: '⚡',
    blurb: '+1 PA à toute la horde : elle arrive deux fois plus vite.',
    ap: 1,
    reward: 0.3
  },
  {
    id: 'fertile',
    name: 'Portée féconde',
    emoji: '🥚',
    blurb: 'Les salles d’apparition crachent moitié plus souvent.',
    reinforcement: 1.5,
    reward: 0.25
  },
  {
    id: 'titans',
    name: 'Titans',
    emoji: '💀',
    blurb: '+40 PV aux boss.',
    bossHp: 40,
    reward: 0.15
  }
];

export function mutationDef(id: string): MutationDef | undefined {
  return MUTATIONS.find((mutation) => mutation.id === id);
}

/** The chosen mutations, resolved into one set of numbers. */
export interface MutationEffects {
  hp: number;
  damage: number;
  ap: number;
  bossHp: number;
  reinforcement: number;
  /** Score multiplier: 1 with nothing taken. */
  reward: number;
}

export function mutationEffects(ids: readonly string[]): MutationEffects {
  const effects: MutationEffects = { hp: 0, damage: 0, ap: 0, bossHp: 0, reinforcement: 1, reward: 1 };
  for (const id of ids) {
    const mutation = mutationDef(id);
    if (!mutation) continue;
    effects.hp += mutation.hp ?? 0;
    effects.damage += mutation.damage ?? 0;
    effects.ap += mutation.ap ?? 0;
    effects.bossHp += mutation.bossHp ?? 0;
    effects.reinforcement *= mutation.reinforcement ?? 1;
    effects.reward += mutation.reward;
  }
  return effects;
}
