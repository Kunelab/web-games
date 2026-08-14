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
  zombieDef,
  type Rarity
} from './data.js';
import { lineOfSight, type Board } from './map.js';
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
}

export interface HeroState {
  playerId: string;
  /** Secret the phone stores, to reclaim the seat after a reload. */
  token: string;
  name: string;
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
  /** Chuck's ability, and the flashlight: reset each hero phase. */
  freeSearchUsed: boolean;
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
  /** Nadia's free step: reset each hero phase. */
  freeMoveUsed?: boolean;
  /** Ethan's saved action point, paid out next phase. */
  bankedAp?: number;
  /** Once-per-raid ability spends (magpie's double loot, bulwark's vest). */
  raidFlags?: Record<string, boolean>;
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

/** A side quest drawn at map generation. In escape it gates the exit. */
export interface CzObjective {
  id: string;
  kind: 'boss' | 'kills' | 'searches';
  target: number;
  progress: number;
  done: boolean;
  label: string;
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
  text: string;
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
  /** The side quests this map was generated with. */
  objectives: CzObjective[];
  /** Per-room noise laid this turn; the horde homes in on it. */
  noise: Record<string, number>;
  /** Rooms the team has ever seen. Fog is shared: this is co-op. */
  explored: string[];
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
  log: LogEntry[];
  resultsRecorded?: boolean;
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
    turn: 0,
    heroes: {},
    zombies: {},
    nextUid: 1,
    nextZombieId: 1,
    keysCollected: 0,
    killsTotal: 0,
    bossKills: 0,
    searchesTotal: 0,
    objectives: [],
    noise: {},
    explored: [],
    gmBudget: 0,
    gmUpgrades: { hide: 0, claws: 0 },
    gmRush: false,
    gmPerks: options.gmPerks ?? [],
    gmLoadout: options.gmLoadout ?? [],
    gmDiscountUsed: false,
    log: [],
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
  const progress = state.turn / boardPressure(state);
  return progress * (1 + progress / 12) * state.config.escalation * pace;
}

/**
 * Draws the side quests. Purge already is a kill objective and endless has no
 * finish line to gate, so both roll none.
 */
function rollObjectives(state: CzState): void {
  if (state.config.scenario === 'purge' || state.config.scenario === 'endless') return;

  const heroesExpected = 3;
  const templates: (() => CzObjective)[] = [
    () => ({
      id: 'boss',
      kind: 'boss',
      target: 1,
      progress: 0,
      done: false,
      label: 'Abattre un boss'
    }),
    () => {
      const target = 6 + randInt(state.rng, 5) + state.config.reinforcement * 2;
      return { id: 'kills', kind: 'kills', target, progress: 0, done: false, label: `Éliminer ${target} zombies` };
    },
    () => {
      const target = heroesExpected * 2 + randInt(state.rng, 4);
      return {
        id: 'searches',
        kind: 'searches',
        target,
        progress: 0,
        done: false,
        label: `Récupérer ${target} fournitures`
      };
    }
  ];

  for (const make of shuffled(state.rng, templates).slice(0, state.config.secondaryObjectives)) {
    state.objectives.push(make());
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
  for (const objective of state.objectives) {
    objective.progress =
      objective.kind === 'boss' ? state.bossKills : objective.kind === 'kills' ? state.killsTotal : state.searchesTotal;
    const wasDone = objective.done;
    objective.done = objective.progress >= objective.target;
    if (objective.done && !wasDone) {
      log(state, `Objectif rempli : ${objective.label}`);
    }
  }
}

export function objectivesDone(state: CzState): boolean {
  return state.objectives.every((objective) => objective.done);
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
    log(state, `${definition.emoji} ${definition.name} est arrivé.`);
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
  perks: string[] = []
): { hero: HeroState; reconnected: boolean } {
  if (token) {
    const existing = Object.values(state.heroes).find((hero) => hero.token === token);
    if (existing) {
      existing.connected = true;
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
  return Object.values(state.heroes).filter((hero) => hero.alive && !hero.escaped);
}

export function zombiesInRoom(state: CzState, roomId: string): ZombieState[] {
  return Object.values(state.zombies).filter((zombie) => zombie.roomId === roomId);
}

export function heroesInRoom(state: CzState, roomId: string): HeroState[] {
  return activeHeroes(state).filter((hero) => hero.roomId === roomId);
}

/** Rooms the team currently sees: union of every active hero's line of sight. */
export function visibleRooms(state: CzState): Set<string> {
  const visible = new Set<string>();
  for (const hero of activeHeroes(state)) {
    for (const id of lineOfSight(state.board, hero.roomId).keys()) {
      visible.add(id);
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

export function log(state: CzState, text: string): void {
  state.log.push({ turn: state.turn, text });
  if (state.log.length > MAX_LOG) {
    state.log.splice(0, state.log.length - MAX_LOG);
  }
}
