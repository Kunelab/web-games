import { createChat, type ChatState } from 'chat-core';
import { msg, type Msg } from 'i18n';
import { createPresence, markPresent, type PresenceState, type Roster } from 'presence-core';

import type { GameConfig } from './config.js';
import { itemFor, rollBiome, zombieFor } from './content/registry.js';
import type { ZombieArchetype } from './content/roles.js';
import {
  BASE_HEROES,
  clampRarity,
  GM_GLOBAL_PERKS,
  gmClassDef,
  HERO_GLOBAL_PERKS,
  heroDef,
  itemDef,
  STARTING_ROLES,
  torchReach,
  zombieDef,
  type Rarity
} from './data.js';
import type { CzEventId } from './events.js';
import { lineOfSight, openSpace, withinSteps, type Board } from './map.js';
import { mutationDef, mutationEffects, MUTATIONS } from './mutations.js';
import { generateBoard } from './mapgen/index.js';
import { pick, rand, randInt, seedRng, shuffled, type RngState } from './rng.js';

/**
 * The authoritative game state, all of it.
 *
 * Serialisable by construction: written to SQLite on every phase change like the
 * quiz sessions, so a server restart resumes the raid instead of ending it. The
 * 2020 original kept all of this in the host browser's DOM and saved it as an
 * HTML blob; every rule below used to be a jQuery selector.
 */

export interface ItemInstance {
  uid: number;
  def: string;
  /**
   * This one's rarity, rolled when it dropped and within one rank of the def's
   * tier. Drives its stats (see `weaponStats`) and how loudly it glows.
   */
  rarity: Rarity;
  /**
   * How much of it has been used up: hits taken by a vest, for now. Absent means
   * untouched, which is what nearly every item is for its whole life.
   */
  spent?: number;
}

export interface HeroState {
  playerId: string;
  /** Secret the phone stores, to reclaim the seat after a reload. */
  token: string;
  name: string;
  /**
   * The Kune account this seat belongs to, when the phone happens to be logged
   * in. Rewards are banked here rather than under the nickname, so a player who
   * renames himself keeps his rations. Anonymous phones leave it undefined and
   * fall back to the nickname, as before.
   */
  account?: string;
  connected: boolean;
  /** Earned across past games, cosmetic. */
  title?: string;
  heroId: string;
  hp: number;
  maxHp: number;
  ap: number;
  roomId: string;
  hands: [ItemInstance | null, ItemInstance | null];
  gear: [ItemInstance | null, ItemInstance | null];
  bag: ItemInstance[];
  /** Done spending AP this phase; everyone ready ends the phase early. */
  ready: boolean;
  alive: boolean;
  escaped: boolean;
  /**
   * Walked away mid-raid. Out of play like a death, but not a death: the career
   * ledger counts it separately, because "I had to leave" and "the horde ate me"
   * are different evenings and a leaderboard that confuses them is lying.
   */
  forfeited?: boolean;
  /** Chuck's ability, and the flashlight: reset each hero phase. */
  freeSearchUsed: boolean;
  /**
   * The one free crate of the raid, spent once and never refilled.
   *
   * Every survivor gets one search that costs no action point, whatever they are
   * carrying. It exists for the same reason as the pity floor: the opening is where
   * a raid is decided, and a table that finds nothing in the first two turns has
   * already lost without having played. This is the version of that help that costs
   * the player nothing to understand, because it is simply a free search.
   */
  freeRaidSearchUsed: boolean;
  /** Yuri's ability: reset each enemy phase. */
  toughUsed: boolean;
  kills: number;
  /** Boss kills alone, for the hunter trophies. */
  bossKills: number;
  killPoints: number;
  searches: number;
  keysPicked: number;
  damageTaken: number;
  /**
   * Roguelite perks this nickname brought in, resolved from their career when
   * they joined. Small flat bonuses only; see perks.ts for the contract.
   */
  perks: string[];
  /**
   * The per-game pick, chosen in the lobby: one of the character's signature
   * perks plus up to two globals. Cleared nowhere — a raid is one loadout.
   */
  loadout: string[];
  /** The once-per-raid revive, spent or not. */
  secondWindUsed: boolean;
  /** The "discret" perk's silenced shot: reset each hero phase. */
  noiseSkipUsed?: boolean;
  /** Nadia's free step: reset each hero phase. Unused since she learned to run. */
  freeMoveUsed?: boolean;
  /** The `pilleur` perk's free crate in a rich room: reset each hero phase. */
  freeShinyUsed?: boolean;
  /** The `elan` perk's free step into the dark: reset each hero phase. */
  freeExploreUsed?: boolean;
  /**
   * Charles is holding a shot.
   *
   * Set when he ends his turn with a point still in hand, spent by the first
   * creature that walks into his line of fire during the horde's phase. It lives on
   * the hero rather than in a separate table because it is exactly as durable as he
   * is — he dies, the shot goes with him — and because the state is serialised whole
   * on every phase change, so a held shot survives a server restart like everything
   * else does.
   */
  overwatch?: boolean;
  /** Ethan's saved action point, paid out next phase. */
  bankedAp?: number;
  /** Once-per-raid ability spends (magpie's double loot, bulwark's vest). */
  raidFlags?: Record<string, boolean>;
  /** How many finds this hero has drawn, searches and corpses together. */
  lootsDrawn: number;
  /** The best tier this hero has actually turned up, for the pity floor. */
  bestTierFound: number;
  /**
   * Set only by the simulator and by tests: pins this hero's opening finds to the
   * best or the worst the table can give, so a bench can report the spread between
   * a blessed run and a cursed one rather than only their average.
   */
  forcedLuck?: 'lucky' | 'unlucky';
  /** A machine teammate: the server plays this seat. */
  isBot?: boolean;
  /** How the machine plays it. */
  bot?: { mindset: string; skill: string };
}

export interface ZombieState {
  id: string;
  def: string;
  roomId: string;
  hp: number;
  /** With the elite bonus baked in, so the UI can draw a real health bar. */
  maxHp: number;
  /** Refilled at the start of each enemy phase, spent by the AI or the GM. */
  ap: number;
  /** Added to the def's damage: late spawns and GM claws hit harder. */
  bonusDmg: number;
}

/** What a side quest can ask for. */
export type CzObjectiveKind =
  /** Kill anything that counts as a boss. */
  | 'boss'
  /** A body count. */
  | 'kills'
  /** A supply count: crates opened. */
  | 'searches'
  /** See a share of the world. */
  | 'explore'
  /** Find something genuinely good. */
  | 'treasure'
  /** Get out with everyone still standing. */
  | 'intact'
  /** Get out quickly. */
  | 'speed';

/**
 * A side quest drawn at map generation.
 *
 * Required ones gate the exit in an escape; **optional** ones never gate anything
 * and pay score instead. That split is the point: a table that wants a clean sweep
 * can chase the bonus, and a table that is bleeding can walk away from it.
 */
export interface CzObjective {
  id: string;
  kind: CzObjectiveKind;
  target: number;
  progress: number;
  done: boolean;
  /** What the quest asks for, as a key: the phone renders it. */
  label: Msg;
  /** Pays score, blocks nothing. */
  optional?: boolean;
}

/** What the game master has permanently bought for the horde. */
export interface GmUpgrades {
  /** +1 HP per level on every future spawn. */
  hide: number;
  /** +1 damage per level on every future spawn. */
  claws: number;
}

export interface LogEntry {
  turn: number;
  /** Prose, or a key for the lines that have been localised. See `log`. */
  text: string | Msg;
  /**
   * Written about something the survivors could not see when it happened.
   *
   * The fog is a team fog — `visibleRooms` unions every hero's sight — so this is
   * one flag rather than a list of who witnessed it. Recorded at write time and
   * never revised: a line you saw stays in your log after you walk away, and a
   * line you missed does not appear because somebody later opened that door.
   */
  hidden?: boolean;
}

export type CzPhase = 'lobby' | 'heroes' | 'enemy' | 'won' | 'lost';

export interface CzState {
  code: string;
  hostToken: string;
  /** Only meaningful in GM mode; issued anyway so switching costs nothing. */
  gmToken: string;
  hostUserId: number | null;
  config: GameConfig;
  seed: number;
  rng: RngState;
  board: Board;
  phase: CzPhase;
  /** Server-time deadline of the current phase, null when unclocked. */
  phaseEndsAt: number | null;
  turn: number;
  heroes: Record<string, HeroState>;
  zombies: Record<string, ZombieState>;
  nextUid: number;
  nextZombieId: number;
  keysCollected: number;
  killsTotal: number;
  /** Boss kills, for the boss objectives. */
  bossKills: number;
  /** Team-wide searches, for the supply objectives. */
  searchesTotal: number;
  /** The best rarity anyone has found, for the treasure objective. */
  bestRarityFound: number;
  /** Reserved for the speed objective's bookkeeping. */
  objectivesSpeedTurn?: number;
  /** The side quests this map was generated with. */
  objectives: CzObjective[];
  /** Per-room noise laid this turn; the horde homes in on it. */
  noise: Record<string, number>;
  /** Rooms the team has ever seen. Fog is shared: this is co-op. */
  explored: string[];
  /**
   * What is happening to the district this turn, if anything.
   *
   * Rolled at the top of each enemy phase and cleared when the heroes get the board
   * back, so it is exactly one turn long. Stored rather than derived because it must
   * be *the same* event for everybody — the television announces it, the phones read
   * it, and the horde's rules bend to it — and because a state that is serialised on
   * every phase change should not re-roll its weather on a server restart.
   */
  event?: CzEventId | null;
  /**
   * The game master's points. Income arrives each enemy phase and unspent
   * points carry over: saving up for an abomination is a strategy, not a bug.
   */
  gmBudget: number;
  gmUpgrades: GmUpgrades;
  /** True while the "rush" order is paid for this phase. */
  gmRush: boolean;
  /** The game master's roguelite perks, resolved from the host's career. */
  gmPerks: string[];
  /** The game master's per-game loadout: one class perk plus two globals. */
  gmLoadout: string[];
  /** The breeder perk's once-per-phase discount, spent or not. */
  gmDiscountUsed: boolean;
  /**
   * The General's once-a-turn reinforcement that acts immediately, spent or not.
   *
   * Optional so a raid saved before the class had this behaviour still parses: an
   * undefined flag reads as unspent, which is the harmless direction to be wrong in.
   */
  gmSurgeUsed?: boolean;
  log: LogEntry[];
  /**
   * What the survivors say to each other.
   *
   * Separate from `log` on purpose. The log is the game's own account of events
   * and is fogged **per entry** — one line hidden, the next not, decided by the
   * room it happened in. `chat-core` answers visibility per *channel* and says so
   * in its header, which is the right model for speech and the wrong one for a
   * fog. Two feeds, each with the rule that fits it, rendered side by side.
   *
   * Optional because raids saved before it existed restore without one; the
   * manager fills it in on the way back.
   */
  chat?: ChatState;
  resultsRecorded?: boolean;
  /**
   * Who is still on the raid: heartbeats, the pause, and any vote to carry on
   * without somebody. Optional so a raid persisted by an older build still
   * parses — `raidPresence` fills it in on first touch.
   */
  presence?: PresenceState;
  lastActivityAt: number;
}

export const HERO_AP = 3;
export const MAX_BAG = 5;
const MAX_LOG = 60;

export function createGame(options: {
  code: string;
  hostToken: string;
  gmToken: string;
  hostUserId: number | null;
  config: GameConfig;
  seed: number;
  gmPerks?: string[];
  gmLoadout?: string[];
  now?: number;
}): CzState {
  const rng = seedRng(options.seed);
  /**
   * `random` is resolved here and written into the state's own config, so a raid
   * knows which world it is in for the rest of its life — every loot roll and every
   * reinforcement reads it. The layout resolves the same way, inside the generator,
   * and lands on the board.
   */
  const config: GameConfig = {
    ...options.config,
    biome: options.config.biome === 'random' ? rollBiome(rng).id : options.config.biome
  };
  const board = generateBoard(rng, config);

  const state: CzState = {
    code: options.code,
    hostToken: options.hostToken,
    gmToken: options.gmToken,
    hostUserId: options.hostUserId,
    config,
    seed: options.seed,
    rng,
    board,
    phase: 'lobby',
    phaseEndsAt: null,
    presence: createPresence(),
    turn: 0,
    heroes: {},
    zombies: {},
    nextUid: 1,
    nextZombieId: 1,
    keysCollected: 0,
    killsTotal: 0,
    bossKills: 0,
    searchesTotal: 0,
    bestRarityFound: 0,
    objectives: [],
    noise: {},
    explored: [],
    gmBudget: 0,
    gmUpgrades: { hide: 0, claws: 0 },
    gmRush: false,
    gmPerks: options.gmPerks ?? [],
    gmLoadout: options.gmLoadout ?? [],
    gmDiscountUsed: false,
    gmSurgeUsed: false,
    log: [],
    chat: createChat(),
    lastActivityAt: options.now ?? Date.now()
  };

  rollObjectives(state);
  return state;
}

/**
 * How far gone the world is: the one number the whole escalation reads.
 *
 * Quadratic in *progress*, so the horde does not just keep coming, it keeps coming
 * faster. Heroes gear up early and then plateau (loot fatigue, finite AP); this
 * curve is what guarantees the crossover, and endless mode is the curve given free
 * rein.
 *
 * Progress is the turn divided by how long this world takes to cross, and that
 * divisor is the whole reason the curve is not simply "turn". The constants here
 * were tuned against a board you could cross in ten turns; a suburb takes fourteen,
 * and leaving the knee where it was meant a bigger world was punished twice — once
 * for being long, and again for having reached turn twelve while doing it. Stretch
 * the arc to the world and a preset means the same evening on either.
 */
export function threat(state: CzState): number {
  const pace = state.config.scenario === 'endless' ? 1.6 : 1;
  const progress = state.turn / (boardPressure(state) * partyPace(state));
  return progress * (1 + progress / 12) * state.config.escalation * pace;
}

/**
 * Draws the side quests. Purge already is a kill objective and endless has no
 * finish line to gate, so both roll none.
 */
function rollObjectives(state: CzState): void {
  if (state.config.scenario === 'purge' || state.config.scenario === 'endless') return;

  const heroesExpected = 3;
  /** Only what the host left on the list. */
  const allowed = new Set<string>(state.config.objectiveKinds);
  const templates: { kind: CzObjective['kind']; make: () => CzObjective }[] = [
    {
      kind: 'boss',
      make: () => ({ id: 'boss', kind: 'boss', target: 1, progress: 0, done: false, label: msg('coronaz.goal.boss') })
    },
    {
      kind: 'kills',
      make: () => {
        const target = 6 + randInt(state.rng, 5) + state.config.reinforcement * 2;
        return {
          id: 'kills',
          kind: 'kills',
          target,
          progress: 0,
          done: false,
          label: msg('coronaz.goal.kills', { target })
        };
      }
    },
    {
      kind: 'searches',
      make: () => {
        const target = heroesExpected * 2 + randInt(state.rng, 4);
        return {
          id: 'searches',
          kind: 'searches',
          target,
          progress: 0,
          done: false,
          label: msg('coronaz.goal.searches', { target })
        };
      }
    }
  ];

  /**
   * The optional half: quests that pay score and gate nothing.
   *
   * Written as their own table because they are a different kind of promise. A
   * required quest is a door you cannot open yet; an optional one is a reason to
   * take one more room before you leave, and it has to be safe to abandon.
   */
  const bonuses: { kind: CzObjectiveKind; make: () => CzObjective }[] = [
    {
      kind: 'explore',
      make: () => {
        const target = Math.max(6, Math.round(state.board.rooms.length * 0.45));
        return {
          id: 'explore',
          kind: 'explore',
          target,
          progress: 0,
          done: false,
          optional: true,
          label: msg('coronaz.goal.explore', { target })
        };
      }
    },
    {
      kind: 'treasure',
      make: () => ({
        id: 'treasure',
        kind: 'treasure',
        target: 4,
        progress: 0,
        done: false,
        optional: true,
        label: msg('coronaz.goal.treasure')
      })
    },
    {
      kind: 'intact',
      make: () => ({
        id: 'intact',
        kind: 'intact',
        target: 1,
        progress: 0,
        done: false,
        optional: true,
        label: msg('coronaz.goal.intact')
      })
    },
    {
      kind: 'speed',
      make: () => {
        const target = 8 + randInt(state.rng, 4);
        return {
          id: 'speed',
          kind: 'speed',
          target,
          progress: 0,
          done: false,
          optional: true,
          label: msg('coronaz.goal.speed', { target })
        };
      }
    },
    {
      kind: 'kills',
      make: () => {
        const target = 14 + randInt(state.rng, 9) + state.config.reinforcement * 3;
        return {
          id: 'kills-bonus',
          kind: 'kills',
          target,
          progress: 0,
          done: false,
          optional: true,
          label: msg('coronaz.goal.bounty', { target })
        };
      }
    }
  ];

  const pool = shuffled(
    state.rng,
    templates.filter((template) => allowed.has(template.kind))
  );
  for (const template of pool.slice(0, state.config.secondaryObjectives)) {
    state.objectives.push(template.make());
  }

  const bonusPool = shuffled(
    state.rng,
    bonuses.filter(
      (bonus) => allowed.has(bonus.kind) && !state.objectives.some((existing) => existing.kind === bonus.kind)
    )
  );
  for (const bonus of bonusPool.slice(0, state.config.optionalObjectives)) {
    state.objectives.push(bonus.make());
  }

  // A boss objective needs a boss to exist: one colossus stalks the map from the
  // start, awake and worth its points, whoever plays the horde.
  if (state.objectives.some((objective) => objective.kind === 'boss')) {
    const spawns = state.board.rooms.filter((room) => room.kind === 'spawn');
    const room = spawns[0] ?? state.board.rooms[state.board.rooms.length - 1];
    if (room) spawnZombie(state, room.id, zombieFor(state.config.biome, 'colossus').id);
  }
}

/** Recomputed after every kill or search; cheap, and the single source of truth. */
export function updateObjectives(state: CzState): void {
  const progressOf = (kind: CzObjectiveKind): number => {
    switch (kind) {
      case 'boss':
        return state.bossKills;
      case 'kills':
        return state.killsTotal;
      case 'searches':
        return state.searchesTotal;
      case 'explore':
        return state.explored.length;
      case 'treasure':
        return state.bestRarityFound;
      case 'intact':
        // Counts down: it is "nobody has fallen", checked at the end of the raid.
        return Object.values(state.heroes).every((hero) => hero.alive) ? 1 : 0;
      case 'speed':
        // Beat the clock: satisfied while the turn is still under the target.
        return state.turn <= 0 ? 0 : Math.max(0, 1 + (state.objectivesSpeedTurn ?? 0));
    }
  };

  for (const objective of state.objectives) {
    objective.progress = progressOf(objective.kind);
    const wasDone = objective.done;
    // A 'speed' objective is judged when the raid ends, not while it runs.
    objective.done = objective.kind === 'speed' ? state.turn <= objective.target : objective.progress >= objective.target;
    if (objective.done && !wasDone) {
      log(state, msg('cz.log.objectiveDone', { label: objective.label }));
    }
  }
}

/** Whether every *required* side quest is done: what the exit actually waits for. */
export function objectivesDone(state: CzState): boolean {
  return state.objectives.every((objective) => objective.optional || objective.done);
}

/**
 * The reinforcement table, gated by threat: the shamblers of turn two share it
 * with the abominations of turn fifteen. `minThreat` keeps a boss out of the early
 * game, and past its gate a boss's weight grows with the threat, which is the
 * "stronger faster and faster" the horde is owed.
 *
 * Keyed by *archetype*, so the table is the game's and the creatures are the
 * biome's: a cyberpunk raid sends whatever it calls a runner, on the same schedule.
 */
const SPAWN_WEIGHTS: readonly { archetype: ZombieArchetype; weight: number; minThreat: number }[] = [
  { archetype: 'walker', weight: 45, minThreat: 0 },
  { archetype: 'runner', weight: 20, minThreat: 0 },
  { archetype: 'horror', weight: 15, minThreat: 2 },
  { archetype: 'fatty', weight: 10, minThreat: 4 },
  { archetype: 'mutant', weight: 8, minThreat: 7 },
  { archetype: 'screamer', weight: 5, minThreat: 10 },
  { archetype: 'brute', weight: 4, minThreat: 13 },
  { archetype: 'colossus', weight: 3, minThreat: 16 },
  { archetype: 'abomination', weight: 2, minThreat: 22 }
];

/** Which archetype the horde sends next; the caller resolves it to a creature. */
export function rollArchetype(rng: RngState, threatLevel = 0): ZombieArchetype {
  const eligible = SPAWN_WEIGHTS.filter((entry) => threatLevel >= entry.minThreat);
  const weightOf = (entry: (typeof SPAWN_WEIGHTS)[number]) =>
    entry.minThreat > 0 ? entry.weight * (1 + (threatLevel - entry.minThreat) / 10) : entry.weight;

  const total = eligible.reduce((sum, entry) => sum + weightOf(entry), 0);
  let roll = total * rand(rng);
  for (const entry of eligible) {
    roll -= weightOf(entry);
    if (roll < 0) return entry.archetype;
  }
  return 'walker';
}

/** The creature id the horde sends next, in this game's biome. */
export function rollZombieType(state: CzState, threatLevel = 0): string {
  return zombieFor(state.config.biome, rollArchetype(state.rng, threatLevel)).id;
}

/**
 * Rooms the difficulty presets were calibrated on: the 2020 board, 8×4 squares.
 */
export const REFERENCE_ROOMS = 32;

/**
 * How much horde this world is worth, relative to the reference board.
 *
 * The presets describe *pressure on a party*, not a number of zombies, and the
 * board is a free dial from 24 cells to 768. Without this, a bigger world quietly
 * became an easier game: the same two spawn rooms feeding the same packs across
 * twice the floor plan means longer walks and fewer bites.
 *
 * The exponent is the part worth explaining. Scaling *linearly* with room count
 * looked right and was measured wrong: on the sixty-room worlds the plot generator
 * produces it put normal at 65% where it belongs near 93%. The reason is that what
 * a party feels is not the horde's *density* but its *contact rate*, and contact
 * depends on how far the horde has to walk — a distance, which grows with the
 * square root of an area, not with the area. So: square root.
 *
 *   32 rooms → 1.00    44 rooms → 1.17    60 rooms → 1.37    120 rooms → 1.94
 *
 * Same reasoning as the party scaling below, and the same shape of fix: a preset
 * should mean one evening's difficulty whoever showed up and whatever the map.
 */
export function boardPressure(state: CzState): number {
  const ratio = state.board.rooms.length / REFERENCE_ROOMS;
  return Math.max(0.6, Math.min(2.5, Math.sqrt(ratio)));
}

/** The party size the difficulty presets were calibrated on. */
export const REFERENCE_HEROES = 3;

/**
 * How much horde this *table* is worth.
 *
 * The opening horde has always scaled with the party. The reinforcements never
 * did, and that asymmetry was invisible in a bench that only ever ran three
 * heroes: a lone survivor with three action points was receiving the same waves as
 * five survivors with fifteen. Measured across party sizes, solo on `difficile`
 * won 2.8% of its raids and a table of five won 94%, which is two different games
 * wearing one preset's name.
 *
 * What a party can answer is roughly its action points, so what arrives scales
 * linearly with heads. Deliberately the *seated* count rather than the living one:
 * the horde easing off every time somebody dies would turn a bad turn into a
 * comfortable one, and losing a friend should not be a difficulty setting.
 */
export function partyPressure(state: CzState): number {
  return seatedHeroes(state) / REFERENCE_HEROES;
}

function seatedHeroes(state: CzState): number {
  return Math.max(1, Object.keys(state.heroes).length);
}

/**
 * How long this table's raid takes, relative to the three-hero reference — and so
 * how much the escalation's arc should be stretched for them.
 *
 * The second half of the solo problem, and the subtler one. Scaling the horde's
 * *volume* to the party is not enough, because a lone survivor also takes longer to
 * do the job: measured, 14 turns against a trio's 11.6. Threat is quadratic in
 * progress, so those extra turns arrive as a third more world-gone-to-hell on top
 * of having a third of the bodies. Stretching the arc to the table's expected pace
 * is what makes `normal` mean the same evening alone as it does with friends.
 *
 * Under three it stretches, over three it compresses, which is also the answer to a
 * table of five winning every raid on the easier presets.
 */
export function partyPace(state: CzState): number {
  return Math.max(0.8, Math.min(1.25, 1 + (REFERENCE_HEROES - seatedHeroes(state)) * 0.08));
}

/**
 * Seeds the opening horde, scaled to the table and to the building.
 *
 * Called at game start rather than at creation, because only then is the party
 * size known. The preset's `startingZombies` describes a three-hero raid; a solo
 * survivor faces 60% of it and a full table 140%, so "normal" means roughly the
 * same evening whether two of you showed up or five. The random-table simulation
 * is what surfaced this: without scaling, solo won 6% and five players 100%.
 */
export function seedZombies(state: CzState): void {
  const spawns = state.board.rooms.filter((room) => room.kind === 'spawn');
  if (spawns.length === 0) return;

  const heroCount = Math.max(1, Object.keys(state.heroes).length);
  const count = Math.round((state.config.startingZombies * (2 + heroCount)) / 5);

  for (let i = 0; i < count; i++) {
    const room = spawns[i % spawns.length];
    if (!room) continue;
    spawnZombie(state, room.id, rollZombieType(state));
  }
}

/**
 * Spawns one zombie, with whatever the moment adds to the printed stats.
 *
 * Against the AI, late spawns arrive as elites: bonus HP and eventually bonus
 * damage scaled by the threat curve. Under a game master the escalation is his
 * income instead, and the permanent `hide`/`claws` upgrades he bought apply to
 * everything he fields. Both paths climb; the heroes' gear does not.
 */
export function spawnZombie(state: CzState, roomId: string, def: string): ZombieState {
  const definition = zombieDef(def);
  const mutated = mutationEffects(state.config.mutations);

  let bonusHp: number;
  let bonusDmg: number;

  if (state.config.mode === 'gm') {
    bonusHp = state.gmUpgrades.hide * 10;
    bonusDmg = state.gmUpgrades.claws * 10;
    // Class physiology: the necromancer's swarm is cheap and brittle, the
    // butcher's giants come reinforced.
    if (state.config.gmClass === 'necromancienne') bonusHp -= 10;
    if (state.config.gmClass === 'boucher' && definition.boss) bonusHp += 20;
    // The Brutalité loadout perk stacks its own flat plate on bosses.
    if (state.gmLoadout.includes('brutalite') && definition.boss) bonusHp += 10;
  } else {
    const level = threat(state);
    bonusHp = Math.floor(level / 8) * 10;
    bonusDmg = Math.min(2, Math.floor(level / 20)) * 10;
  }

  // What the table asked for, on top of everything else.
  bonusHp += mutated.hp + (definition.boss ? mutated.bossHp : 0);
  bonusDmg += mutated.damage;

  const maxHp = Math.max(10, definition.hp + bonusHp);
  const zombie: ZombieState = {
    id: `z${state.nextZombieId++}`,
    def,
    roomId,
    hp: maxHp,
    maxHp,
    ap: 0,
    bonusDmg
  };
  state.zombies[zombie.id] = zombie;

  if (definition.boss) {
    // Tied to the room it walked into: naming the creature is exactly the kind of
    // thing the survivors are supposed to discover rather than read.
    log(state, `${definition.emoji} ${definition.name} est arrivé.`, roomId);
  }
  return zombie;
}

/**
 * Mints one item. Without a rarity it comes out exactly as printed — starting
 * weapons, perk kits and side arms are plain examples of themselves, so only a
 * crate can hand out something remarkable.
 */
export function makeItem(state: CzState, def: string, rarity?: number): ItemInstance {
  const definition = itemDef(def); // throws on unknown ids before they enter the state
  return {
    uid: state.nextUid++,
    def,
    rarity: rarity === undefined ? definition.tier : clampRarity(rarity)
  };
}

export function joinHero(
  state: CzState,
  name: string,
  token: string | undefined,
  perks: string[] = [],
  account?: string
): { hero: HeroState; reconnected: boolean } {
  if (token) {
    const existing = Object.values(state.heroes).find((hero) => hero.token === token);
    /**
     * A seat the room voted out cannot be reclaimed by the token that held it.
     *
     * Without this the vote is decoration: the removed survivor reconnects two
     * seconds later, the reclaim succeeds because the token is still valid, and
     * the raid is back where it started with no way to say so.
     */
    if (existing && raidPresence(state).kicked.includes(existing.playerId)) {
      throw new Error('Le raid a continué sans vous');
    }
    if (existing) {
      existing.connected = true;
      markPresent(raidPresence(state), existing.playerId);
      // Re-read on every reconnect: the player may have logged in since.
      if (account) existing.account = account;
      return { hero: existing, reconnected: true };
    }
  }

  if (state.phase !== 'lobby') {
    throw new Error('La partie a déjà commencé');
  }
  if (Object.keys(state.heroes).length >= 5) {
    throw new Error('La table est pleine (5 survivants)');
  }
  // Auto-seating draws from the base roster only; unlocked characters are a
  // deliberate pick via switchHero, gated by the career server-side.
  const taken = new Set(Object.values(state.heroes).map((hero) => hero.heroId));
  const free = shuffled(
    state.rng,
    BASE_HEROES.map((definition) => definition.id).filter((id) => !taken.has(id))
  );
  const heroId = free[0];
  if (!heroId) {
    throw new Error('Tous les survivants de base sont pris');
  }

  const definition = heroDef(heroId);
  const start = state.board.rooms.find((room) => room.kind === 'start') ?? state.board.rooms[0];
  if (!start) throw new Error('board without rooms');

  const playerId = `p${Object.keys(state.heroes).length + 1}_${Math.floor(rand(state.rng) * 1e9).toString(36)}`;
  const maxHp = heroMaxHp(state, heroId, perks, []);

  const hero: HeroState = {
    playerId,
    token: cryptoToken(state),
    name: name.trim().slice(0, 24) || definition.name,
    account,
    connected: true,
    heroId,
    hp: maxHp,
    maxHp,
    ap: 0,
    roomId: start.id,
    // Rosa walks in armed; everyone else grabs whatever blunt thing was near —
    // whatever that is in this world.
    hands: [
      makeItem(
        state,
        itemFor(state.config.biome, heroDef(heroId).ability === 'veteran' ? 'sidearm' : pick(state.rng, STARTING_ROLES))
          .id
      ),
      null
    ],
    gear: [null, null],
    bag: [],
    ready: false,
    alive: true,
    escaped: false,
    freeSearchUsed: false,
    freeRaidSearchUsed: false,
    lootsDrawn: 0,
    bestTierFound: 0,
    toughUsed: false,
    kills: 0,
    bossKills: 0,
    killPoints: 0,
    searches: 0,
    keysPicked: 0,
    damageTaken: 0,
    perks,
    loadout: [],
    secondWindUsed: false
  };

  state.heroes[playerId] = hero;
  return { hero, reconnected: false };
}

/**
 * Another raid, same table: a fresh lobby carrying the seats forward.
 *
 * A rematch used to mean walking the host back through the setup screen, creating
 * a new game, reading a new code out loud, everybody re-joining, re-picking a
 * character and re-picking a loadout — after every raid, all of which take about
 * as long as a turn does. That friction is a real reason an evening stops at three
 * games instead of five, and it costs nothing to remove.
 *
 * A new world, deliberately: same config, **new seed**. Replaying a seed is
 * already a feature of the setup screen for the table that wants the same map
 * back; the default meaning of "again" is somewhere else.
 *
 * What carries over is exactly the seating — token, name, ledger, chosen
 * character, chosen loadout, career perks, and a bot's personality. What does not
 * is everything the raid did: inventories, wounds, scores, the board. Keeping the
 * code and the tokens is what lets every phone in the room walk into the new lobby
 * without anybody typing anything.
 */
export function rematch(state: CzState, seed: number): CzState {
  const next = createGame({
    code: state.code,
    hostToken: state.hostToken,
    gmToken: state.gmToken,
    hostUserId: state.hostUserId,
    // Copied, not shared: the old state is still alive while this is built, and
    // two raids pointing at one config object is the kind of aliasing that shows
    // up three features later as a mutation leaking backwards.
    config: { ...state.config, mutations: [...state.config.mutations] },
    seed,
    gmPerks: [...state.gmPerks],
    gmLoadout: [...state.gmLoadout]
  });

  // Seat order is preserved so the lobby looks like the room does.
  for (const previous of Object.values(state.heroes)) {
    const { hero } = joinHero(next, previous.name, undefined, previous.perks, previous.account);
    hero.token = previous.token;
    hero.isBot = previous.isBot;
    hero.bot = previous.bot;
    // The character has to be re-seated before the loadout: switching bodies
    // voids the pick, which is right in a lobby and wrong here.
    try {
      switchHero(next, hero.playerId, previous.heroId);
    } catch {
      // Somebody else took it first, or it is no longer a legal pick. The
      // auto-seated character stands, which is what a lobby would have given them.
    }
    try {
      setLoadout(next, hero.playerId, previous.loadout);
    } catch {
      // Only reachable when the character above could not be re-seated, since the
      // signature perks belong to a body. An empty pick is the lobby's own default.
    }
  }

  // The table's handicap is a table decision, not a raid decision: it survives.
  setMutations(next, state.config.mutations);
  return next;
}

/**
 * Seats a bot survivor. Same seat as a human's, plus the flag and the brain
 * settings, both serialised with the state so a restart keeps its personality.
 */
export function joinBot(state: CzState, name: string, mindset: string, skill: string): HeroState {
  const { hero } = joinHero(state, name, undefined, []);
  hero.isBot = true;
  hero.bot = { mindset, skill };
  return hero;
}

/** Bag size, perk and ability included: the only place the cap is read. */
export function bagCapacity(hero: HeroState): number {
  return (
    MAX_BAG +
    (hero.perks.includes('deep-pockets') ? 1 : 0) +
    (hero.loadout.includes('poches') ? 1 : 0) +
    (heroDef(hero.heroId).ability === 'mule' ? 2 : 0)
  );
}

/** Whether the hero carries an effect, whatever earned it (career or loadout). */
export function heroHas(hero: HeroState, key: string): boolean {
  return hero.perks.includes(key) || hero.loadout.includes(key);
}

/**
 * Whether this survivor is carrying something that lights a room: the one source
 * of a renewable free search.
 *
 * By the gear *flag*, never by an item id. The projection used to test
 * `item.def === 'flashlight'` while the engine tested `gear?.flashlight`, so the two
 * already disagreed for any biome that names its torch something else — the exact
 * drift the roles layer was built to prevent, and the sort that shows up as "the
 * button says free and the server charges me".
 */
export function hasTorch(hero: HeroState): boolean {
  return hero.gear.some((item) => item !== null && itemDef(item.def).gear?.flashlight === true);
}

/** A believable pick for a bot: one signature perk, two globals, seeded. */
export function randomHeroLoadout(rng: RngState, heroId: string): string[] {
  const personal = pick(rng, heroDef(heroId).personalPerks as unknown as string[]);
  const globals = shuffled(rng, HERO_GLOBAL_PERKS).slice(0, 2);
  return [personal, ...globals];
}

export function randomGmLoadout(rng: RngState, classId: string): string[] {
  const personal = pick(rng, gmClassDef(classId).personalPerks as unknown as string[]);
  const globals = shuffled(
    rng,
    GM_GLOBAL_PERKS.filter((id) => id !== personal)
  ).slice(0, 2);
  return [personal, ...globals];
}

/** The game master's pick, validated: one class perk plus up to two globals. */
export function validGmLoadout(classId: string, perkIds: string[]): string[] {
  const unique = [...new Set(perkIds)].slice(0, 3);
  const personalPool = gmClassDef(classId).personalPerks as unknown as string[];
  const personal = unique.filter((id) => personalPool.includes(id));
  const globals = unique.filter((id) => !personalPool.includes(id) && GM_GLOBAL_PERKS.includes(id));
  // Anything outside both pools, or a second signature pick, is quietly dropped:
  // the setup screen may lag behind a rebalance and must not brick a creation.
  return [...personal.slice(0, 1), ...globals.slice(0, 2)];
}

/**
 * Max HP, from every flat source at once: the printed stat, the difficulty's
 * bonus (in old ±1 units, scaled here), the career's tough-skin, the loadout's
 * vigour and sang-froid. One function so no caller can forget a term.
 */
export function heroMaxHp(state: CzState, heroId: string, perks: string[], loadout: string[]): number {
  return (
    heroDef(heroId).hp +
    state.config.heroHpBonus * 10 +
    (perks.includes('tough-skin') ? 10 : 0) +
    (loadout.includes('vigor') ? 10 : 0) +
    (loadout.includes('sang-froid') ? 10 : 0)
  );
}

/**
 * Sets the lobby pick: at most one of the character's signature perks, at most
 * two globals, nothing else. Server truth — the phone's list is a suggestion.
 */
export function setLoadout(state: CzState, playerId: string, perkIds: string[]): void {
  if (state.phase !== 'lobby') throw new Error('La partie a commencé');
  const hero = state.heroes[playerId];
  if (!hero) throw new Error('Joueur inconnu');

  const unique = [...new Set(perkIds)].slice(0, 3);
  const personal = unique.filter((id) => (heroDef(hero.heroId).personalPerks as string[]).includes(id));
  const globals = unique.filter((id) => HERO_GLOBAL_PERKS.includes(id));

  if (personal.length + globals.length !== unique.length) {
    throw new Error('Atout inconnu pour ce personnage');
  }
  if (personal.length > 1) throw new Error('Un seul atout de personnage');
  if (globals.length > 2) throw new Error('Deux atouts généraux maximum');

  hero.loadout = unique;
  hero.maxHp = heroMaxHp(state, hero.heroId, hero.perks, hero.loadout);
  hero.hp = hero.maxHp;
}

/**
 * Sets the table's mutations. Lobby only, and unknown ids are dropped rather than
 * refused: a phone whose list is one release behind must not brick the raid.
 */
export function setMutations(state: CzState, ids: string[]): void {
  if (state.phase !== 'lobby') throw new Error('La partie a commencé');
  const known = [...new Set(ids)].filter((id) => mutationDef(id) !== undefined).slice(0, MUTATIONS.length);
  state.config.mutations = known;
}

/**
 * Tokens come from the seeded RNG so the engine stays dependency-free; they only
 * defend a seat in a living-room game, not a bank account.
 */
function cryptoToken(state: CzState): string {
  let token = '';
  for (let i = 0; i < 4; i++) {
    token += Math.floor(rand(state.rng) * 0xffffffff)
      .toString(36)
      .padStart(6, '0');
  }
  return token;
}

export function switchHero(state: CzState, playerId: string, heroId: string): void {
  if (state.phase !== 'lobby') throw new Error('La partie a commencé');
  const hero = state.heroes[playerId];
  if (!hero) throw new Error('Joueur inconnu');
  const definition = heroDef(heroId);

  const taken = Object.values(state.heroes).some((other) => other.playerId !== playerId && other.heroId === heroId);
  if (taken) throw new Error('Ce survivant est déjà pris');

  hero.heroId = heroId;
  // A new body voids the old pick: signature perks belong to a character.
  hero.loadout = [];
  hero.maxHp = heroMaxHp(state, heroId, hero.perks, hero.loadout);
  hero.hp = hero.maxHp;
  // Rosa re-arms on pick; anyone else keeps whatever they were holding.
  if (definition.ability === 'veteran') {
    hero.hands[0] = makeItem(state, itemFor(state.config.biome, 'sidearm').id);
  }
}

/* --------------------------------- queries -------------------------------- */

export function activeHeroes(state: CzState): HeroState[] {
  return Object.values(state.heroes).filter((hero) => hero.alive && !hero.escaped && !hero.forfeited);
}

/**
 * The presence block, created on demand.
 *
 * Raids snapshotted before this feature existed have no `presence`, and the
 * honest way to read one is to give it a fresh empty one rather than to litter
 * every call site with a null check.
 */
export function raidPresence(state: CzState): PresenceState {
  state.presence ??= createPresence();
  return state.presence;
}

/**
 * The seats the raid actually waits for.
 *
 * Humans still in play. A bot is always present, and a survivor who is dead,
 * escaped or has forfeited has no turn left to take — so none of them can stop
 * the clock, and a raid does not freeze because the first casualty shut their
 * laptop two turns ago.
 */
export function waitedOnHeroes(state: CzState): Roster {
  return activeHeroes(state)
    .filter((hero) => !hero.isBot)
    .map((hero) => hero.playerId);
}

export function zombiesInRoom(state: CzState, roomId: string): ZombieState[] {
  return Object.values(state.zombies).filter((zombie) => zombie.roomId === roomId);
}

export function heroesInRoom(state: CzState, roomId: string): HeroState[] {
  return activeHeroes(state).filter((hero) => hero.roomId === roomId);
}

/**
 * How far an open space is seen from inside it. Four rooms is a good stretch of
 * street without handing over the whole district.
 */
const OPEN_SIGHT = 4;

/**
 * Rooms the team currently sees.
 *
 * Three sources, and the last two are what stop the fog reading as broken:
 *
 * - **straight lines**, the Zombicide rule, which is also what a gun can reach;
 * - **the open space you are standing in**, because an arch means there is no wall
 *   there, and lighting four rays across a street while leaving the rest of it
 *   black looks like a bug rather than like darkness;
 * - **next door**, for anyone carrying a torch good enough to throw light that far.
 */
export function visibleRooms(state: CzState): Set<string> {
  const visible = new Set<string>();

  /**
   * A flare lights the whole district for the turn, and a blackout puts everyone
   * back in the room they are standing in.
   *
   * Handled here rather than in the projection because sight is not only what a
   * screen draws: it is also what the fog *records*, so a flare has to actually
   * explore the district and a blackout must not un-explore it. Fog only ever
   * recedes, which `updateExplored` guarantees, so a blackout is temporary
   * blindness rather than forgetting.
   */
  if (state.event === 'flare') {
    for (const room of state.board.rooms) visible.add(room.id);
    return visible;
  }
  if (state.event === 'blackout') {
    for (const hero of activeHeroes(state)) visible.add(hero.roomId);
    return visible;
  }

  for (const hero of activeHeroes(state)) {
    for (const id of lineOfSight(state.board, hero.roomId).keys()) {
      visible.add(id);
    }
    for (const id of openSpace(state.board, hero.roomId, OPEN_SIGHT)) {
      visible.add(id);
    }
    /**
     * A good torch, or `vigile`, sees around the corner.
     *
     * This used to add the room's immediate *neighbours*, and it was dead code — all
     * of it. `lineOfSight` is unbounded along a straight open run, so every
     * neighbour of every room is already visible to everybody, always; a measured
     * probe found this branch revealing something new in 0 of 185 rooms. So the
     * legendary torch's advertised reach ("lights the rooms next door, which on a
     * dark map is worth more than any number") had never once done anything, and
     * neither would the perk.
     *
     * Counted in *steps* now, which is the only way to buy sight the rays do not
     * already give you: what the dark actually hides is what is around a corner.
     */
    const reach =
      Math.max(0, ...hero.gear.map((item) => (item ? torchReach(itemDef(item.def), item.rarity) : 0))) +
      (hero.loadout.includes('vigile') ? 1 : 0);
    if (reach > 0) {
      for (const id of withinSteps(state.board, hero.roomId, reach + 1)) {
        visible.add(id);
      }
    }
  }
  return visible;
}

/** Called after anything that could move a hero: fog only ever recedes. */
export function updateExplored(state: CzState): void {
  const explored = new Set(state.explored);
  for (const id of visibleRooms(state)) {
    explored.add(id);
  }
  state.explored = [...explored];
}

/**
 * Adds a line to the raid log.
 *
 * `roomId` is what the line is *about*. Given one the survivors cannot currently
 * see, the entry is marked hidden and only the game master reads it until the
 * raid ends.
 *
 * This is not decoration. The log used to be shipped to every screen unfiltered
 * while the map beside it was carefully fogged, so players read where the horde
 * was massing and what it was made of. It also quietly cancelled the Bone
 * Colossus, whose whole ability is to surface in rooms nobody has explored: the
 * ambush was announced in writing the moment it was bought.
 */
/**
 * One line of the raid's own account of itself.
 *
 * `text` is still prose for most of this file — the log is the last CoronaZ
 * surface written in one language — but it accepts a `Msg` so the lines that
 * *have* been keyed, like a finished objective, carry the key instead of a
 * rendered sentence. The screens render either.
 */
export function log(state: CzState, text: string | Msg, roomId?: string): void {
  const hidden = roomId !== undefined && !visibleRooms(state).has(roomId);
  state.log.push(hidden ? { turn: state.turn, text, hidden } : { turn: state.turn, text });
  if (state.log.length > MAX_LOG) {
    state.log.splice(0, state.log.length - MAX_LOG);
  }
}
