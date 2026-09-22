import { DIFFICULTY_PRESETS, type GameConfig } from 'coronaz-core';
import { defaultSessionConfig, type SessionConfig } from 'game-core';
import type { MafiaConfig } from 'mafia-core';

import { env } from '../env.js';

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

/**
 * What the endless blind test plays when a hostless room asks for it.
 *
 * A fixed set rather than a fourth thing to vote on. The three dials are the
 * whole promise of a quick match — what, how hard, how long — and "which eleven
 * of thirty genres" is not a dial, it is the setup screen this mode exists
 * instead of. So the list is the crowd-pleasing middle of the catalogue: things
 * a room of five strangers has a fair chance of naming, across enough decades
 * that nobody's twenties are the whole evening.
 *
 * The difficulty window is left wide open for the same reason the host's screen
 * defaults to it: the draw picks a level per round inside the window, so a wide
 * one is a varied evening rather than an unfair one.
 */
export function quickBlindtestSettings(): {
  genreIds: string[];
  difficultyMin: number;
  difficultyMax: number;
  region: string;
} {
  return {
    genreIds: ['pop', 'rock', 'chanson-fr', 'variete-80', 'rap-fr', 'films-musique'],
    difficultyMin: 0,
    difficultyMax: 100,
    region: env.YOUTUBE_REGION
  };
}

/**
 * How much of a quick blind test comes from the shared catalogue.
 *
 * Turned well up, where the host's screen splits it down the middle. A room that
 * assembled itself out of strangers has nobody who decided to spend a search per
 * round, and the catalogue half is both free and already vetted by whichever room
 * played it first. The evening is the same evening; it just costs nothing.
 */
export const QUICK_REPLAY_SHARE = 0.85;

/**
 * What "long" means for a blind test a room voted for.
 *
 * A published quiz set to "long" plays all of it, and all of it is a number
 * somebody wrote down. A generated one has no such number, and the honest
 * translation — endless — is the one thing a hostless room cannot have, because
 * ending an endless session is the host's button and there is no host. So long
 * is a long evening rather than a permanent one.
 */
export const QUICK_LONG_ROUNDS = 30;

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
