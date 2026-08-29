import { DIFFICULTY_PRESETS, type GameConfig } from 'coronaz-core';
import { defaultSessionConfig, type SessionConfig } from 'game-core';
import type { MafiaConfig } from 'mafia-core';

/**
 * Turning what a room voted for into what an engine understands.
 *
 * The lobby deals in opaque strings — `"cauchemar"`, `"court"`, `"faction"` —
 * because the browser renders a lobby for three games without importing any of
 * their engines. This file is the single place those strings become configs, and
 * it is deliberately the only part of quick match that knows all three games
 * exist.
 *
 * Every reader is total: an unrecognised value falls back rather than throwing.
 * A vote arrives over a socket, and a room should not be able to kill its own
 * launch by sending a typo.
 */

/** How many rounds a quick quiz plays. Zero means the whole playlist. */
export function quizRounds(length: string | undefined): number {
  switch (length) {
    case 'court':
      return 8;
    case 'long':
      return 0;
    default:
      return 15;
  }
}

export function quizConfig(settings: Record<string, string>): SessionConfig {
  return {
    ...defaultSessionConfig,
    /**
     * Shuffled, always. A quick match slices the first N of the order, so without
     * this every room that rolled the same quiz would play the same eight rounds.
     */
    shuffle: true,
    chronological: false,
    oral: false,
    autoAdvance: true,
    autonomous: true,
    public: true,
    scoring: {
      ...defaultSessionConfig.scoring,
      combo: { ...defaultSessionConfig.scoring.combo, enabled: settings.combo !== 'off' }
    }
  };
}

const CZ_SCENARIOS = new Set(['escape', 'purge', 'survival']);
const CZ_BIOMES = new Set(['random', 'modern', 'cyber']);

export function coronazConfig(settings: Record<string, string>): Partial<GameConfig> {
  const scenario = settings.scenario ?? 'escape';
  const biome = settings.biome ?? 'random';
  const preset = DIFFICULTY_PRESETS[settings.difficulty ?? 'normal'] ?? DIFFICULTY_PRESETS.normal ?? {};

  return {
    ...preset,
    // The horde is the server's: a quick room has no game master, and electing one
    // from strangers would hand a stranger everybody else's evening.
    mode: 'ai',
    scenario: (CZ_SCENARIOS.has(scenario) ? scenario : 'escape') as GameConfig['scenario'],
    biome: CZ_BIOMES.has(biome) ? biome : 'random',
    public: true
  };
}

const MAFIA_DAY_MS: Record<string, number> = {
  rapide: 90_000,
  normal: 120_000,
  'posé': 180_000
};

export function mafiaConfig(settings: Record<string, string>, maxPlayers: number): Partial<MafiaConfig> {
  const reveal = settings.reveal;

  return {
    maxPlayers,
    dayMs: MAFIA_DAY_MS[settings.pace ?? 'normal'] ?? MAFIA_DAY_MS.normal,
    revealOnDeath: reveal === 'role' || reveal === 'none' ? reveal : 'faction',
    setup: settings.setup === 'chaos' ? { mode: 'chaos' } : { mode: 'auto' },
    public: true
  };
}
