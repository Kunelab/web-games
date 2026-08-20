import { z } from 'zod';

/**
 * Everything a host can turn before a game, validated once here and carried in
 * the state. Presets fill these; the setup screen exposes them individually, so
 * "cauchemar mais avec une petite carte" is a choice rather than a feature
 * request.
 */

export const SCENARIOS = ['escape', 'purge', 'survival', 'endless'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const gameConfigSchema = z.object({
  /** Who plays the horde: the server, or a human on their phone. */
  mode: z.enum(['ai', 'gm']).default('ai'),
  /**
   * The horde's face in GM mode: a class from data.ts. Validated against the
   * roster at the route, defaulted here so old configs keep parsing.
   */
  gmClass: z.string().max(24).default('horde'),
  scenario: z.enum(SCENARIOS).default('escape'),

  /**
   * The board's size in *cells*, not rooms. Rooms own one to four cells each,
   * streets eat a good share of the grid and some of it is rubble you cannot enter
   * at all, so a 22×22 world comes out around 150 rooms — a district rather than a
   * building. The screens pan, zoom and carry a minimap; nothing has to fit in one
   * glance.
   */
  width: z.number().int().min(6).max(32).default(22),
  height: z.number().int().min(4).max(24).default(22),
  /**
   * The shape of the world: a city block, a suburb, one big installation, a venue
   * on a street — or `random`, which is the default and the point.
   */
  layout: z.string().max(24).default('random'),
  /**
   * The *look* of the world, and what fights you in it: a biome brings its own
   * arsenal and its own bestiary. Orthogonal to the layout on purpose — any world
   * shape can be built in any biome — and `random` by default.
   */
  biome: z.string().max(24).default('random'),
  /** Keys to collect before the exit opens (escape scenario). */
  keys: z.number().int().min(1).max(6).default(3),
  /** Rooms that breed reinforcements. */
  spawnRooms: z.number().int().min(1).max(5).default(3),
  /**
   * How much of the grid is impassable rubble, as a share of it: collapsed
   * buildings, flooded lots, a crater. Nothing enters, nothing spawns, and the
   * generator still guarantees the rest is one connected world.
   */
  rubble: z.number().min(0).max(0.35).default(0.12),
  /** Zombies on the board at the start. */
  startingZombies: z.number().int().min(0).max(20).default(6),
  /**
   * Reinforcement pressure, 0 (none) to 3 (relentless). Scales the AI's spawn
   * odds and the game master's per-turn budget alike.
   */
  reinforcement: z.number().int().min(0).max(3).default(1),
  /** Kills to win the purge scenario. */
  killTarget: z.number().int().min(5).max(60).default(20),
  /** Turns to hold out in the survival scenario. */
  survivalTurns: z.number().int().min(3).max(30).default(8),
  /**
   * How many side quests are drawn at map generation. In the escape scenario they
   * gate the exit; elsewhere they pay bonus points.
   */
  secondaryObjectives: z.number().int().min(0).max(2).default(1),
  /**
   * How many *optional* quests are drawn. They gate nothing and pay score, so this
   * is the dial for "give us something to chase" rather than for difficulty.
   */
  optionalObjectives: z.number().int().min(0).max(3).default(2),
  /**
   * Which side quests are allowed to be drawn. A host who dislikes being sent
   * hunting for a boss can strike it off the list rather than turning the whole
   * feature off, and an empty list means none whatever the count above says.
   */
  objectiveKinds: z
    .array(z.enum(['boss', 'kills', 'searches', 'explore', 'treasure', 'intact', 'speed']))
    .default(['boss', 'kills', 'searches', 'explore', 'treasure', 'intact', 'speed']),
  /**
   * Mutations the *table* has taken: each one strengthens the horde and pays the
   * survivors for it. Chosen in the lobby by the players, not by the host, which is
   * why it lives in the config but is written after creation.
   */
  mutations: z.array(z.string().max(24)).default([]),
  /**
   * Whether the district has weather: one rolled event at the top of a third of the
   * enemy phases, from turn three.
   *
   * On by default, because it is the answer to "turn six played exactly like turn
   * five" and that was the complaint that mattered. A dial rather than a rule for
   * the same reason the objective kinds have one: a table that wants the pure
   * tactical game should be able to say so instead of tolerating it.
   */
  events: z.boolean().default(true),
  /**
   * How much the dark hides. `none`: the whole board is lit (easy evenings).
   * `map`: the layout is known but creatures only appear in line of sight.
   * `full`: unexplored rooms are pitch black, the original dread.
   */
  fog: z.enum(['none', 'map', 'full']).default('full'),
  /**
   * How fast the horde outgrows the heroes, 0 (never) to 3 (avalanche). Feeds
   * the threat curve: reinforcement pressure, elite stat bonuses on late spawns,
   * and the game master's income all ride on it.
   */
  escalation: z.number().min(0).max(3).default(1),

  /**
   * Seconds per hero phase, 0 for no clock. The pace dial: every hero spends
   * their AP inside this window, simultaneously.
   */
  heroPhaseSeconds: z.number().int().min(0).max(120).default(30),
  /** Seconds the game master gets, 0 for no clock. Ignored vs the AI. */
  gmPhaseSeconds: z.number().int().min(0).max(120).default(45),

  /** Added to every hero's printed HP. Negative makes veterans sweat. */
  heroHpBonus: z.number().int().min(-2).max(3).default(0),
  /**
   * Shifts the loot table by whole rarity ranks: +1 turns the 40% common slot
   * into uncommon-or-better odds. -1 makes the map stingy.
   */
  lootLuck: z.number().int().min(-1).max(2).default(0)
});

export type GameConfig = z.infer<typeof gameConfigSchema>;

export const defaultGameConfig: GameConfig = gameConfigSchema.parse({});

/**
 * The four dials most people actually want, bundled. A preset is applied client
 * side and then remains editable, so it is a starting point rather than a mode.
 */
export const DIFFICULTY_PRESETS: Record<string, Partial<GameConfig>> = {
  facile: {
    startingZombies: 6,
    fog: 'none',
    reinforcement: 1,
    heroHpBonus: 1,
    lootLuck: 1,
    escalation: 0.8,
    heroPhaseSeconds: 45
  },
  normal: {
    startingZombies: 9,
    fog: 'map',
    reinforcement: 1,
    heroHpBonus: 0,
    lootLuck: 0,
    escalation: 1.1,
    heroPhaseSeconds: 30
  },
  difficile: {
    startingZombies: 11,
    reinforcement: 2,
    heroHpBonus: 0,
    lootLuck: 0,
    escalation: 2.2,
    heroPhaseSeconds: 20
  },
  cauchemar: {
    startingZombies: 12,
    reinforcement: 3,
    heroHpBonus: -1,
    lootLuck: -1,
    escalation: 2.5,
    heroPhaseSeconds: 15
  },
  /**
   * Past lethal: the tier that exists because the roguelite perks exist. A fresh
   * team should not book this room; a team wearing every trophy gets roughly the
   * cauchemar experience back.
   */
  apocalypse: {
    startingZombies: 18,
    keys: 4,
    reinforcement: 3,
    heroHpBonus: -2,
    lootLuck: -1,
    escalation: 3,
    heroPhaseSeconds: 15
  }
};

export const SCENARIO_LABELS: Record<Scenario, { name: string; goal: string }> = {
  escape: {
    name: 'Évasion',
    goal: 'Remplissez les objectifs, ramassez les clés, puis rejoignez la sortie.'
  },
  purge: {
    name: 'Purge',
    goal: 'Éliminez la horde : atteignez le quota de victimes.'
  },
  survival: {
    name: 'Survie',
    goal: 'Tenez le nombre de tours demandé. L’extraction fait le reste.'
  },
  endless: {
    name: 'Sans fin',
    goal: 'Personne ne sort. Marquez le plus de points avant la fin, la horde ne cessera jamais de grossir.'
  }
};
