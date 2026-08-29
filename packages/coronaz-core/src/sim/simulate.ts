import { gameConfigSchema, type GameConfig } from '../config.js';
import {
  activateNextZombie,
  applyGmAction,
  applyHeroAction,
  beginEnemyPhase,
  endEnemyPhase,
  finalScores,
  heroPhaseDone,
  spawnReinforcements,
  startGame
} from '../engine.js';
import {
  createGame,
  objectivesDone,
  joinHero,
  randomGmLoadout,
  randomHeroLoadout,
  setLoadout,
  switchHero,
  type CzPhase,
  type CzState
} from '../state.js';
import { decideGmAction, type GmMindset } from './gm-policies.js';
import { decideHeroAction, PLAYER_MINDSETS, SKILLS, type Mindset, type SkillProfile } from './policies.js';

/**
 * Headless games, thousands an hour: chess without the board.
 *
 * The simulator drives the exact engine the real game runs — same reducer, same
 * dice, same AI — with bot players and an optional bot game master, no timers
 * and no sockets. A game is fully determined by (seed, config, party): replay
 * the same triple and the same raid unfolds, which is what makes a bug report
 * a seed number.
 */

/** One seat at the table: a character, a play style, a skill level. */
export interface PartyMember {
  mindset: string;
  skill: string;
  /** Forces a specific survivor; omitted = random from the base roster. */
  heroId?: string;
  /**
   * Pins this seat's opening finds to the best or the worst the table can produce.
   *
   * A raid's outcome hangs on the first few crates far more than on anything else,
   * and a win rate averaged over hundreds of games hides that completely. Bench a
   * blessed party against a cursed one and the *spread* is the answer to "how much
   * of this game is the dice".
   */
  luck?: 'lucky' | 'unlucky';
  /** Plays with no loadout at all, for the handicap bonus. */
  noPerks?: boolean;
}

export interface GameOutcome {
  won: boolean;
  turns: number;
  /** Sum of every hero's score. */
  totalScore: number;
  kills: number;
  /**
   * Crates opened, summed across the table.
   *
   * Reported because rooms hold a finite number of things now, so "is the board's
   * stock ever the binding constraint" became a question the bench has to be able
   * to answer. Without it the only way to check is to reason about it, and the
   * whole reason this simulator exists is that reasoning about it is how the loot
   * curve went wrong twice.
   */
  searches: number;
  heroesDead: number;
  /**
   * How far the objectives got before the raid ended.
   *
   * Reported so a loss can be read rather than guessed at: a table wiped with the
   * exit already open lost a fight it could have walked away from, and a table
   * wiped two keys short never had the option. Those are different problems and
   * the win rate alone cannot tell them apart.
   */
  keysCollected: number;
  exitOpen: boolean;
  heroesEscaped: number;
  /** The full combat log, when asked for: the seed replay's transcript. */
  log?: string[];
}

export interface SimSummary {
  games: number;
  winRate: number;
  avgTurns: number;
  avgScore: number;
  avgKills: number;
  avgDeaths: number;
}

/** Beyond this a stalemate is a loss: nobody camps a raid for a hundred turns. */
const TURN_CAP = 60;
const ENDLESS_CAP = 120;

function resolve(member: PartyMember): { mindset: Mindset; skill: SkillProfile } {
  const mindset = PLAYER_MINDSETS[member.mindset];
  const skill = SKILLS[member.skill];
  if (!mindset) throw new Error(`Unknown mindset: ${member.mindset}`);
  if (!skill) throw new Error(`Unknown skill: ${member.skill}`);
  return { mindset, skill };
}

export function runGame(options: {
  config: Partial<GameConfig>;
  seed: number;
  party: PartyMember[];
  gmMindset?: GmMindset;
  /** Roguelite perks every bot hero carries, for balance checks of the meta. */
  heroPerks?: string[];
  gmPerks?: string[];
  captureLog?: boolean;
}): GameOutcome {
  const config = gameConfigSchema.parse({
    ...options.config,
    mode: options.gmMindset ? 'gm' : 'ai',
    // Clocks are wall-time; a simulation has no wall.
    heroPhaseSeconds: 0,
    gmPhaseSeconds: 0
  });

  const state = createGame({
    code: 'SIM',
    hostToken: 'sim',
    gmToken: 'sim-gm',
    hostUserId: null,
    config,
    seed: options.seed,
    gmPerks: options.gmPerks,
    now: 0
  });

  // The bot game master picks a loadout like a human would; deterministic per
  // seed, so the bench stays replayable.
  if (config.mode === 'gm') {
    state.gmLoadout = randomGmLoadout(state.rng, config.gmClass);
  }

  const party = options.party.map(resolve);
  for (let i = 0; i < options.party.length; i++) {
    const spec = options.party[i];
    const { hero } = joinHero(
      state,
      `${spec?.skill ?? 'bot'}-${spec?.mindset ?? 'balanced'}-${i + 1}`,
      undefined,
      options.heroPerks ?? []
    );
    // The bench ignores unlock economics on purpose: it exists to answer "is
    // this character balanced", which requires playing it before anyone owns it.
    if (spec?.heroId) {
      switchHero(state, hero.playerId, spec.heroId);
    }
    if (spec?.luck) hero.forcedLuck = spec.luck;
    // Every bot builds a loadout: the targets describe games as they are played.
    // Unless the bench is measuring what going without is worth.
    if (!spec?.noPerks) {
      setLoadout(state, hero.playerId, randomHeroLoadout(state.rng, hero.heroId));
    }
  }
  startGame(state, 0);

  const cap = config.scenario === 'endless' ? ENDLESS_CAP : TURN_CAP;

  // Read through a helper: the engine mutates `phase` behind these calls, and
  // TypeScript's narrowing would otherwise "prove" the checks impossible.
  const phase = (): CzPhase => state.phase;

  while ((phase() === 'heroes' || phase() === 'enemy') && state.turn <= cap) {
    playHeroPhase(state, party);
    if (phase() !== 'heroes') break;

    beginEnemyPhase(state, 0);
    playEnemyPhase(state, options.gmMindset);
    if (phase() !== 'enemy') break;
    endEnemyPhase(state, 0);
  }

  // Ran out the cap without a verdict: the raid rotted, the horde wins.
  const won = state.phase === 'won';
  const scores = finalScores(state);

  return {
    won,
    turns: state.turn,
    totalScore: scores.reduce((sum, score) => sum + score.score, 0),
    kills: state.killsTotal,
    searches: state.searchesTotal,
    heroesDead: Object.values(state.heroes).filter((hero) => !hero.alive).length,
    keysCollected: state.keysCollected,
    exitOpen: state.keysCollected >= state.config.keys && objectivesDone(state),
    heroesEscaped: Object.values(state.heroes).filter((hero) => hero.escaped).length,
    log: options.captureLog ? state.log.map((entry) => `T${entry.turn} ${entry.text}`) : undefined
  };
}

function playHeroPhase(state: CzState, party: { mindset: Mindset; skill: SkillProfile }[]): void {
  // Each hero plays out their whole allowance; the guard kills any policy loop
  // (an action that succeeds without spending anything, forever).
  const heroes = Object.values(state.heroes);
  for (let index = 0; index < heroes.length; index++) {
    const hero = heroes[index];
    const brain = party[index] ?? party[0];
    if (!hero || !brain) continue;

    let guard = 0;
    while (state.phase === 'heroes' && guard++ < 40) {
      const action = decideHeroAction(state, hero, brain.mindset, brain.skill);
      if (!action) break;
      const result = applyHeroAction(state, hero.playerId, action);
      if (!result.ok) break;
    }
    if (state.phase !== 'heroes') return;
    if (hero.alive && !hero.escaped && !hero.ready) {
      applyHeroAction(state, hero.playerId, { type: 'ready' });
    }
  }

  // heroPhaseDone is what the server checks; the simulator honours the same gate.
  if (state.phase === 'heroes' && !heroPhaseDone(state)) {
    for (const hero of Object.values(state.heroes)) {
      applyHeroAction(state, hero.playerId, { type: 'ready' });
    }
  }
}

function playEnemyPhase(state: CzState, gmMindset?: GmMindset): void {
  if (gmMindset) {
    let guard = 0;
    while (state.phase === 'enemy' && guard++ < 60) {
      const action = decideGmAction(state, gmMindset);
      if (!action) break;
      const result = applyGmAction(state, action);
      if (!result.ok) break;
    }
  }

  // The shared movement AI walks whatever is on the board, both modes.
  let guard = 0;
  while (state.phase === 'enemy' && activateNextZombie(state).more && guard++ < 500) {
    /* one zombie per call */
  }

  if (state.phase === 'enemy' && !gmMindset) {
    spawnReinforcements(state);
  }
}

/** A uniform party, the common case for the calibration matrix. */
export function uniformParty(size: number, mindset: string, skill: string): PartyMember[] {
  return Array.from({ length: size }, () => ({ mindset, skill }));
}

export function runMany(options: {
  games: number;
  config: Partial<GameConfig>;
  party: PartyMember[];
  gmMindset?: GmMindset;
  heroPerks?: string[];
  gmPerks?: string[];
  seedBase?: number;
}): SimSummary {
  let wins = 0;
  let turns = 0;
  let score = 0;
  let kills = 0;
  let deaths = 0;

  for (let i = 0; i < options.games; i++) {
    const outcome = runGame({
      config: options.config,
      seed: (options.seedBase ?? 1000) + i * 7919,
      party: options.party,
      gmMindset: options.gmMindset,
      heroPerks: options.heroPerks,
      gmPerks: options.gmPerks
    });
    wins += outcome.won ? 1 : 0;
    turns += outcome.turns;
    score += outcome.totalScore;
    kills += outcome.kills;
    deaths += outcome.heroesDead;
  }

  return {
    games: options.games,
    winRate: wins / options.games,
    avgTurns: turns / options.games,
    avgScore: score / options.games,
    avgKills: kills / options.games,
    avgDeaths: deaths / options.games
  };
}
