export { seedRng, rand, randInt, d6, pick, chance, shuffled, type RngState } from './rng.js';

export {
  HEROES,
  BASE_HEROES,
  GM_CLASSES,
  BASE_GM_CLASSES,
  ZOMBIES,
  ITEMS,
  RARITY_WEIGHTS,
  RARITY_META,
  RARITY_SPREAD,
  STARTING_ROLES,
  STAT_SCALE,
  HERO_LOADOUT_PERKS,
  HERO_GLOBAL_PERKS,
  GM_LOADOUT_PERKS,
  GM_GLOBAL_PERKS,
  heroDef,
  gmClassDef,
  zombieDef,
  itemDef,
  loadoutPerkDef,
  gmLoadoutPerkDef,
  clampRarity,
  rarityRange,
  weaponStats,
  gearStats,
  type HeroDef,
  type GmClassDef,
  type ZombieDef,
  type ItemDef,
  type ItemKind,
  type HeroAbility,
  type LoadoutPerkDef,
  type Rarity,
  type WeaponStats,
  type GearStats
} from './data.js';

export {
  BIOMES,
  BIOME_IDS,
  biomeDef,
  rollBiome,
  itemsOfBiome,
  zombiesOfBiome,
  itemFor,
  zombieFor,
  roleOf,
  archetypeOf
} from './content/registry.js';

export type { BiomeDef, BiomeItem, BiomeZombie } from './content/biome.js';

export {
  ITEM_ROLES,
  WEAPON_ROLES,
  ARCHETYPES,
  POWER_TOLERANCE,
  expectedDamage,
  roleDef,
  archetypeDef,
  type ItemRole,
  type WeaponRole,
  type GearRole,
  type RoleDef,
  type ZombieArchetype,
  type ArchetypeDef
} from './content/roles.js';

export {
  SCENARIOS,
  SCENARIO_LABELS,
  DIFFICULTY_PRESETS,
  gameConfigSchema,
  defaultGameConfig,
  type GameConfig,
  type Scenario
} from './config.js';

export {
  neighbors,
  degree,
  shortestPath,
  distancesFrom,
  lineOfSight,
  roomAt,
  roomOfCell,
  getRoom,
  roomId,
  cellIndex,
  cellXY,
  cellCount,
  edgeAt,
  edgeBetween,
  edgeCode,
  passable,
  seeThrough,
  connectionsOf,
  isOutdoorProgram,
  MAX_ROOM_CELLS,
  OUTDOOR_PROGRAMS,
  type Board,
  type Room,
  type RoomKind,
  type RoomProgram,
  type FloorKind,
  type EdgeKind,
  type Connection
} from './map.js';

export {
  generateBoard,
  boardSummary,
  LAYOUTS,
  LAYOUT_IDS,
  layoutDef,
  BUILDING_PROGRAMS,
  PROGRAM_LABELS,
  buildingProgram,
  type LayoutDef,
  type Plot,
  type Rect
} from './mapgen/index.js';

export {
  createGame,
  joinHero,
  joinBot,
  bagCapacity,
  heroHas,
  heroMaxHp,
  setLoadout,
  randomHeroLoadout,
  randomGmLoadout,
  validGmLoadout,
  switchHero,
  spawnZombie,
  rollZombieType,
  rollArchetype,
  makeItem,
  activeHeroes,
  heroesInRoom,
  zombiesInRoom,
  visibleRooms,
  updateExplored,
  updateObjectives,
  objectivesDone,
  threat,
  log,
  HERO_AP,
  MAX_BAG,
  type CzState,
  type CzPhase,
  type CzObjective,
  type GmUpgrades,
  type HeroState,
  type ZombieState,
  type ItemInstance,
  type LogEntry
} from './state.js';

export {
  resolveHeroAttack,
  resolveZombieAttack,
  weaponFor,
  type Hand,
  type AttackOutcome,
  type ChosenWeapon
} from './combat.js';

export {
  applyHeroAction,
  applyGmAction,
  startGame,
  startHeroPhase,
  beginEnemyPhase,
  endEnemyPhase,
  activateNextZombie,
  spawnReinforcements,
  heroPhaseDone,
  checkEnd,
  rollLoot,
  finalScores,
  gmIncome,
  GM_UPGRADES,
  GM_ORDERS,
  type HeroAction,
  type GmAction,
  type ActionResult,
  type FinalScore,
  type LootRoll
} from './engine.js';

/**
 * The bot brains, exported for the server's live co-op bots. The simulator and
 * the real game share one set of behaviors on purpose: what the bench balances
 * is what the living room plays with.
 */
export {
  decideHeroAction,
  PLAYER_MINDSETS,
  SKILLS,
  playerMindsetNames,
  skillNames,
  weaponScore,
  type Mindset,
  type SkillProfile
} from './sim/policies.js';
export { decideGmAction, gmMindsetNames, type GmMindset } from './sim/gm-policies.js';

export {
  CZ_TROPHIES,
  ALL_HERO_PERKS,
  ALL_GM_PERKS,
  emptyCareerStats,
  trophiesFor,
  heroPerksFor,
  gmPerksFor,
  type CzCareerStats,
  type CzTrophyDef,
  type CzTrophyTier
} from './perks.js';

export {
  toView,
  computeCzAwards,
  czHeroActionSchema,
  czGmActionSchema,
  czJoinSchema,
  type CzRole,
  type CzView,
  type CzItemView,
  type CzRoomView,
  type CzHeroView,
  type CzZombieView,
  type CzMeView,
  type CzAwardView,
  type CzJoinAck,
  type CzActionAck,
  type CzClientToServer,
  type CzServerToClient
} from './protocol.js';
