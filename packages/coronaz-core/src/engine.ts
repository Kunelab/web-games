import { resolveHeroAttack, resolveZombieAttack, type Hand } from './combat.js';
import { archetypeOf, itemFor, itemsOfBiome, zombieFor } from './content/registry.js';
import {
  clampRarity,
  gearStats,
  heroDef,
  itemDef,
  RARITY_META,
  RARITY_WEIGHTS,
  zombieDef,
  type ItemDef,
  type Rarity
} from './data.js';
import { getRoom, neighbors, shortestPath } from './map.js';
import { chance, pick, rand, randInt } from './rng.js';
import {
  activeHeroes,
  bagCapacity,
  HERO_AP,
  heroesInRoom,
  log,
  makeItem,
  objectivesDone,
  rollZombieType,
  seedZombies,
  spawnZombie,
  threat,
  updateExplored,
  updateObjectives,
  type CzState,
  type HeroState,
  type ItemInstance
} from './state.js';

/**
 * The reducer. Every mutation of a running game funnels through here, so the
 * rules exist in exactly one place and the server is the only one applying them.
 *
 * Phases are simultaneous rather than sequential: during the hero phase everyone
 * spends their AP at once against a shared clock, which is the pace fix over the
 * 2020 original's strict turn order. The enemy phase is resolved by the AI in
 * paced steps, or played by the game master by hand.
 */

/* ------------------------------ hero actions ------------------------------ */

export type HeroAction =
  | { type: 'move'; roomId: string }
  | { type: 'attack'; zombieId: string; hand: Hand }
  | { type: 'search' }
  | { type: 'pickupKey' }
  | { type: 'exit' }
  /** Consumables: a medkit costs 1 AP, adrenaline pays for itself. */
  | { type: 'use'; uid: number }
  /** Free: inventory is logistics, not heroism. */
  | { type: 'equip'; uid: number; slot: 'hand0' | 'hand1' | 'gear0' | 'gear1' | 'bag' }
  | { type: 'drop'; uid: number }
  | { type: 'give'; uid: number; toPlayerId: string }
  | { type: 'ready' };

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** Set by a successful search, so the phone can offer one-tap equipping. */
  loot?: ItemInstance;
  /** Attack feedback, so the phone can sound the hit and the kill. */
  hits?: number;
  killed?: string[];
}

export function applyHeroAction(state: CzState, playerId: string, action: HeroAction): ActionResult {
  const hero = state.heroes[playerId];
  if (!hero) return { ok: false, error: 'Joueur inconnu' };
  if (state.phase !== 'heroes') return { ok: false, error: 'Ce n’est pas la phase des héros' };
  if (!hero.alive) return { ok: false, error: 'Vous êtes tombé' };
  if (hero.escaped) return { ok: false, error: 'Vous êtes déjà sorti' };

  switch (action.type) {
    case 'ready':
      // Ethan pockets one unspent point for tomorrow; everyone else just rests.
      if (heroDef(hero.heroId).ability === 'tactician' && hero.ap > 0) {
        hero.bankedAp = 1;
      }
      hero.ready = true;
      hero.ap = 0;
      return { ok: true };
    case 'equip':
      return equip(hero, action.uid, action.slot);
    case 'drop':
      return drop(hero, action.uid);
    case 'give':
      return give(state, hero, action.uid, action.toPlayerId);
    default:
      break;
  }

  // Everything below costs AP — except the ability- or torch-funded free search,
  // Nadia's first step, and the adrenaline shot, playable at zero AP by design.
  const freeSearch =
    action.type === 'search' &&
    !hero.freeSearchUsed &&
    (heroDef(hero.heroId).ability === 'scavenger' ||
      hero.gear.some((item) => item && itemDef(item.def).gear?.flashlight));

  const freeMove = action.type === 'move' && !hero.freeMoveUsed && heroDef(hero.heroId).ability === 'fleet';

  const freeUse =
    action.type === 'use' &&
    [...hero.bag, ...hero.gear].some(
      (item) =>
        item?.uid === action.uid &&
        (itemDef(item.def).gear?.adrenaline !== undefined ||
          // The medic's hands: healing costs them nothing.
          (itemDef(item.def).gear?.heal !== undefined && heroDef(hero.heroId).ability === 'medic'))
    );

  if (hero.ap <= 0 && !freeSearch && !freeUse && !freeMove) {
    return { ok: false, error: 'Plus de PA ce tour' };
  }

  const spend = () => {
    if (freeSearch) {
      hero.freeSearchUsed = true;
    } else if (freeMove) {
      hero.freeMoveUsed = true;
    } else {
      hero.ap -= 1;
    }
  };

  switch (action.type) {
    case 'move': {
      const from = getRoom(state.board, hero.roomId);
      const open = neighbors(state.board, from).some((room) => room.id === action.roomId);
      if (!open) return { ok: false, error: 'Pas de porte par là' };
      spend();
      hero.roomId = action.roomId;

      // The Parasite's garden: crossing an infested room costs skin. Rosa has
      // seen worse.
      const into = getRoom(state.board, action.roomId);
      if (into.kind === 'fungus' && heroDef(hero.heroId).ability !== 'veteran') {
        hero.hp -= 10;
        hero.damageTaken += 10;
        log(state, `${hero.name} traverse les spores (-10 PV)`);
        if (state.config.mode === 'gm' && state.config.gmClass === 'charognard') {
          state.gmBudget += 1;
        }
        if (hero.hp <= 0) {
          hero.alive = false;
          log(state, `${hero.name} est tombé.`);
        }
      }

      // Awa reads the doorways: neighbours count as seen-once.
      if (heroDef(hero.heroId).ability === 'scout') {
        const explored = new Set(state.explored);
        for (const room of neighbors(state.board, into)) {
          explored.add(room.id);
        }
        state.explored = [...explored];
      }

      updateExplored(state);
      checkEnd(state);
      return { ok: true };
    }

    case 'attack': {
      const target = state.zombies[action.zombieId];
      if (!target) return { ok: false, error: 'Cible déjà tombée' };
      const outcome = resolveHeroAttack(state, hero, target, action.hand);
      if (!outcome.ok) return outcome;
      spend();
      checkEnd(state);
      return outcome;
    }

    case 'search': {
      if (hero.bag.length >= bagCapacity(hero)) return { ok: false, error: 'Sac plein' };
      spend();
      hero.searches += 1;
      state.searchesTotal += 1;
      const roll = rollLoot(state, hero);
      const found = makeItem(state, roll.def.id, roll.rarity);
      hero.bag.push(found);
      log(state, `${hero.name} trouve ${describe(found)}`);

      // Léa's fingers: the raid's first crate gives twice, bag allowing.
      const flags = (hero.raidFlags ??= {});
      if (heroDef(hero.heroId).ability === 'magpie' && !flags.magpie && hero.bag.length < bagCapacity(hero)) {
        flags.magpie = true;
        const extra = rollLoot(state, hero);
        const bonus = makeItem(state, extra.def.id, extra.rarity);
        hero.bag.push(bonus);
        log(state, `${hero.name} chaparde aussi ${describe(bonus)}`);
      }

      updateObjectives(state);
      return { ok: true, loot: found };
    }

    case 'use': {
      const owned = [...hero.bag, ...hero.gear].find((item) => item?.uid === action.uid) ?? null;
      if (!owned) return { ok: false, error: 'Objet introuvable' };
      // The instance's numbers, not the printed ones: a rare medkit heals more.
      const gear = gearStats(itemDef(owned.def), owned.rarity);

      if (gear?.heal) {
        if (hero.hp >= hero.maxHp) return { ok: false, error: 'Déjà au maximum' };
        const medic = heroDef(hero.heroId).ability === 'medic';
        if (!medic) spend();
        // Sacha's hands are worth a whole point of health on this scale; the
        // ability was documented as +10 and coded as +1 before the scale change.
        const amount = gear.heal + (medic ? 10 : 0);
        hero.hp = Math.min(hero.maxHp, hero.hp + amount);
        consume(hero, owned.uid);
        log(state, `${hero.name} se soigne (+${amount} PV)`);
        return { ok: true };
      }

      if (gear?.adrenaline) {
        // Pays for itself: the shot IS the action points. Fatou doses better.
        const amount = gear.adrenaline + (heroDef(hero.heroId).ability === 'adrenal' ? 1 : 0);
        hero.ap += amount;
        consume(hero, owned.uid);
        log(state, `${hero.name} s’injecte de l’adrénaline (+${amount} PA)`);
        return { ok: true };
      }

      return { ok: false, error: 'Rien à utiliser ici' };
    }

    case 'pickupKey': {
      const room = getRoom(state.board, hero.roomId);
      if (!room.hasKey) return { ok: false, error: 'Pas de clé ici' };
      spend();
      room.hasKey = false;
      state.keysCollected += 1;
      hero.keysPicked += 1;
      log(state, `${hero.name} ramasse une clé (${state.keysCollected}/${state.config.keys})`);
      return { ok: true };
    }

    case 'exit': {
      if (state.config.scenario === 'endless') {
        return { ok: false, error: 'Personne ne sort. Marquez des points.' };
      }
      const room = getRoom(state.board, hero.roomId);
      if (room.kind !== 'exit') return { ok: false, error: 'La sortie n’est pas ici' };
      if (state.config.scenario === 'escape' && state.keysCollected < state.config.keys) {
        return { ok: false, error: `Il manque ${state.config.keys - state.keysCollected} clé(s)` };
      }
      // The side quests gate the door: the exit opens for a team that did the job.
      if (state.config.scenario === 'escape' && !objectivesDone(state)) {
        const pending = state.objectives.find((objective) => !objective.done);
        return { ok: false, error: `Objectif à finir d’abord : ${pending?.label ?? ''}` };
      }
      spend();
      hero.escaped = true;
      hero.ready = true;
      log(state, `${hero.name} s’échappe !`);
      checkEnd(state);
      return { ok: true };
    }

    default:
      return { ok: false, error: 'Action inconnue' };
  }
}

/** An item in the log: its name and, because it now varies, its rarity. */
function describe(item: ItemInstance): string {
  return `${itemDef(item.def).name} (${RARITY_META[item.rarity].label})`;
}

/** Spends a consumable, wherever it sits. */
function consume(hero: HeroState, uid: number): void {
  const bagIndex = hero.bag.findIndex((item) => item.uid === uid);
  if (bagIndex !== -1) {
    hero.bag.splice(bagIndex, 1);
    return;
  }
  for (const index of [0, 1] as const) {
    if (hero.gear[index]?.uid === uid) hero.gear[index] = null;
  }
}

/** What a crate turned out to hold: which item, and how good this one is. */
export interface LootRoll {
  def: ItemDef;
  rarity: Rarity;
}

/**
 * Loot: tier first, item second, condition third.
 *
 * The tier roll uses the original's 40/30/15/10/5 curve and decides *what* turns
 * up; `lootLuck` shifts it by whole ranks. Loot fatigue then pulls it back down
 * as a hero keeps searching: the fourth crate is never as good as the first,
 * which is the heroes' half of the escalation bargain — their power plateaus at
 * mid-game while the horde keeps compounding.
 *
 * The third roll is this version's: the item's own rarity, one rank either side
 * of its tier. It is what makes a search worth watching even when the tier is
 * one you have seen all evening, and it never crosses tiers, so the curve above
 * still owns the pacing.
 */
export function rollLoot(state: CzState, hero?: HeroState): LootRoll {
  const total = RARITY_WEIGHTS.reduce((sum, weight) => sum + weight, 0);
  let roll = Math.floor(total * rand(state.rng));
  let rank = 0;
  for (let i = 0; i < RARITY_WEIGHTS.length; i++) {
    roll -= RARITY_WEIGHTS[i] ?? 0;
    if (roll < 0) {
      rank = i;
      break;
    }
  }

  // Margot's charm bends the fatigue curve, never the table itself.
  const fatigueStep = hero && heroDef(hero.heroId).ability === 'lucky' ? 8 : 4;
  const fatigue = hero ? Math.floor(hero.searches / fatigueStep) : 0;
  // The Fouineur loadout perk lifts the raid's first crate by one rank.
  const fouineur = hero?.loadout.includes('fouineur') && hero.searches === 1 ? 1 : 0;
  let tier = Math.min(4, Math.max(0, rank + state.config.lootLuck - fatigue + fouineur)) + 1;

  // Lucky find: the raid's first crate is never junk. One guaranteed floor,
  // once, which is a good start and not a build.
  if (hero?.perks.includes('lucky-find') && hero.searches === 1) {
    tier = Math.max(tier, 3);
  }

  // Only what this world contains: the biome is the whole loot table.
  const candidates = itemsOfBiome(state.config.biome).filter((item) => item.tier === tier);
  const def = pick(state.rng, candidates);

  // Condition. Luck tilts it both ways, and a bad roll on a good tier is still a
  // good find: the tier is the pacing, this is the texture.
  const upChance = 0.22 + Math.max(0, state.config.lootLuck) * 0.06;
  const downChance = Math.max(0.05, 0.28 - state.config.lootLuck * 0.06);
  const condition = rand(state.rng);
  const wobble = condition < upChance ? 1 : condition < upChance + downChance ? -1 : 0;

  return { def, rarity: clampRarity(def.tier + wobble) };
}

/* ------------------------------ inventory --------------------------------- */

type Slot = 'hand0' | 'hand1' | 'gear0' | 'gear1' | 'bag';

/** Where an item currently sits, so equip can swap rather than duplicate. */
function takeItem(
  hero: HeroState,
  uid: number
): { item: ItemInstance; putBack: (item: ItemInstance | null) => void } | null {
  const bagIndex = hero.bag.findIndex((item) => item.uid === uid);
  if (bagIndex !== -1) {
    const item = hero.bag[bagIndex];
    if (!item) return null;
    hero.bag.splice(bagIndex, 1);
    return { item, putBack: (back) => back && hero.bag.push(back) };
  }

  for (const [collection, index] of [
    [hero.hands, 0],
    [hero.hands, 1],
    [hero.gear, 0],
    [hero.gear, 1]
  ] as const) {
    const item = collection[index];
    if (item?.uid === uid) {
      collection[index] = null;
      return { item, putBack: (back) => (collection[index] = back) };
    }
  }

  return null;
}

function equip(hero: HeroState, uid: number, slot: Slot): ActionResult {
  const source = takeItem(hero, uid);
  if (!source) return { ok: false, error: 'Objet introuvable' };
  const def = itemDef(source.item.def);

  const fail = (error: string): ActionResult => {
    source.putBack(source.item);
    return { ok: false, error };
  };

  if (slot === 'bag') {
    if (hero.bag.length >= bagCapacity(hero)) return fail('Sac plein');
    hero.bag.push(source.item);
    return { ok: true };
  }

  const isHand = slot === 'hand0' || slot === 'hand1';
  if (isHand && def.kind !== 'weapon') return fail('Une main tient une arme');
  if (!isHand && def.kind !== 'gear') return fail('Cet emplacement reçoit un équipement');

  const collection = isHand ? hero.hands : hero.gear;
  const index = slot === 'hand0' || slot === 'gear0' ? 0 : 1;

  // Whatever was there goes where the new item came from: a swap, never a loss.
  const displaced = collection[index];
  collection[index] = source.item;
  source.putBack(displaced);
  return { ok: true };
}

function drop(hero: HeroState, uid: number): ActionResult {
  const source = takeItem(hero, uid);
  if (!source) return { ok: false, error: 'Objet introuvable' };
  return { ok: true };
}

function give(state: CzState, hero: HeroState, uid: number, toPlayerId: string): ActionResult {
  const receiver = state.heroes[toPlayerId];
  if (!receiver || !receiver.alive || receiver.escaped || receiver.roomId !== hero.roomId) {
    return { ok: false, error: 'Personne pour le prendre ici' };
  }
  if (receiver.bag.length >= bagCapacity(receiver)) return { ok: false, error: 'Son sac est plein' };

  const source = takeItem(hero, uid);
  if (!source) return { ok: false, error: 'Objet introuvable' };
  receiver.bag.push(source.item);
  log(state, `${hero.name} donne ${describe(source.item)} à ${receiver.name}`);
  return { ok: true };
}

/* -------------------------------- phases ---------------------------------- */

/** What a unit costs THIS game master: class discounts, floored at 1. */
export function gmSpawnCost(state: CzState, def: string): number {
  const definition = zombieDef(def);
  let cost = definition.cost;
  const gmClass = state.config.gmClass;

  // Classes discount a *kind* of creature, not a named one, so the tracker's
  // bargain on runners holds in a world whose runners are drones.
  const archetype = archetypeOf(def);

  if (gmClass === 'necromancienne') cost -= 1;
  if (gmClass === 'boucher' && definition.boss) cost -= 2;
  if (gmClass === 'traqueur' && archetype === 'runner') cost = 1;
  if (gmClass === 'hurleur' && archetype === 'screamer') cost -= 2;
  if (state.gmLoadout.includes('porte-voix') && archetype === 'screamer') cost -= 1;

  return Math.max(1, cost);
}

export function startGame(state: CzState, now = Date.now()): void {
  if (state.phase !== 'lobby') return;
  if (Object.keys(state.heroes).length === 0) throw new Error('Personne dans la partie');
  state.turn = 0;

  // The lobby picks become physical things: starter kits, side arms, a known
  // neighbourhood. All flat, all once.
  // Perks hand out a *kind* of thing; the biome decides what that is here.
  const kit = (role: Parameters<typeof itemFor>[1]) => makeItem(state, itemFor(state.config.biome, role).id);

  for (const hero of Object.values(state.heroes)) {
    if (hero.loadout.includes('soigneur') || hero.loadout.includes('trousse')) {
      hero.bag.push(kit('medkit'));
    }
    if (hero.loadout.includes('injection')) {
      hero.bag.push(kit('stim'));
    }
    if (hero.loadout.includes('arme') && hero.hands[1] === null) {
      hero.hands[1] = kit('sidearm');
    }
    if (hero.loadout.includes('couteau') && hero.hands[1] === null) {
      hero.hands[1] = kit('blade');
    }
    if (hero.loadout.includes('boussole')) {
      const start = getRoom(state.board, hero.roomId);
      const explored = new Set(state.explored);
      for (const room of neighbors(state.board, start)) explored.add(room.id);
      state.explored = [...explored];
    }
  }

  // The classes that reshape the map do it here, before the first look around.
  if (state.config.mode === 'gm') {
    if (state.gmLoadout.includes('tresor')) {
      state.gmBudget += 3;
    }
    if (state.gmLoadout.includes('taniere')) {
      const extra = state.board.rooms.find((room) => room.kind === 'normal' && !room.hasKey);
      if (extra) extra.kind = 'spawn';
    }
    if (state.gmLoadout.includes('essaim')) {
      const den = state.board.rooms.find((room) => room.kind === 'spawn');
      if (den) {
        const shambler = zombieFor(state.config.biome, 'walker').id;
        spawnZombie(state, den.id, shambler);
        spawnZombie(state, den.id, shambler);
      }
    }
    if (state.config.gmClass === 'parasite') {
      // Three ordinary rooms turn to spore gardens: crossing them costs skin.
      const candidates = state.board.rooms.filter((room) => room.kind === 'normal' && !room.hasKey);
      for (const room of candidates.slice(0, 3)) {
        room.kind = 'fungus';
      }
      log(state, 'Des spores couvrent une partie du complexe…');
    }
    if (state.config.gmClass === 'crypte') {
      const extra = state.board.rooms.find((room) => room.kind === 'normal' && !room.hasKey);
      if (extra) {
        extra.kind = 'spawn';
        log(state, 'Une crypte s’ouvre : la horde a une porte de plus.');
      }
    }
  }

  // The opening horde waits for the headcount: it scales with the party.
  seedZombies(state);
  if (state.config.mode === 'gm' && state.gmPerks.includes('dark-pact')) {
    state.gmBudget += 4;
  }
  updateExplored(state);
  startHeroPhase(state, now);
  log(state, 'La partie commence.');
}

export function startHeroPhase(state: CzState, now = Date.now()): void {
  state.phase = 'heroes';
  state.turn += 1;
  for (const hero of Object.values(state.heroes)) {
    if (!hero.alive || hero.escaped) continue;
    hero.ap =
      HERO_AP +
      (state.turn === 1 && hero.perks.includes('sprinter') ? 1 : 0) +
      (state.turn === 1 && hero.loadout.includes('nerveux') ? 1 : 0) +
      // Ethan's banked point comes home.
      (hero.bankedAp ?? 0);
    hero.bankedAp = 0;
    hero.ready = false;
    hero.freeSearchUsed = false;
    hero.freeMoveUsed = false;
    hero.noiseSkipUsed = false;
  }
  state.phaseEndsAt = state.config.heroPhaseSeconds > 0 ? now + state.config.heroPhaseSeconds * 1000 : null;
  state.lastActivityAt = now;
}

/** Everyone done or out of AP: nothing left for the clock to protect. */
export function heroPhaseDone(state: CzState): boolean {
  return activeHeroes(state).every((hero) => hero.ready || hero.ap <= 0);
}

/**
 * The game master's pay: a base wage plus a cut of the threat curve, so his
 * purse compounds the way the AI's elites do. Unspent points carry over, which
 * is what makes "starve them early, save for the abomination" a strategy.
 */
export function gmIncome(state: CzState): number {
  return (
    3 +
    state.config.reinforcement * 2 +
    Math.floor(threat(state) / 2.5) +
    (state.gmPerks.includes('overlord') ? 2 : 0) +
    (state.gmLoadout.includes('dividende') ? 1 : 0)
  );
}

export function beginEnemyPhase(state: CzState, now = Date.now()): void {
  if (state.phase !== 'heroes') return;
  state.phase = 'enemy';

  for (const zombie of Object.values(state.zombies)) {
    zombie.ap = zombieDef(zombie.def).ap;
  }
  for (const hero of Object.values(state.heroes)) {
    hero.toughUsed = false;
  }

  if (state.config.mode === 'gm') {
    state.gmBudget += gmIncome(state);
    state.gmDiscountUsed = false;
  }
  state.phaseEndsAt =
    state.config.mode === 'gm' && state.config.gmPhaseSeconds > 0 ? now + state.config.gmPhaseSeconds * 1000 : null;
  state.lastActivityAt = now;
}

/**
 * AI: activates ONE zombie completely and returns whether any remain.
 *
 * One at a time so the server can pace the broadcasts and the room can watch the
 * horde move piece by piece, rather than the board teleporting into its final
 * arrangement.
 */
export function activateNextZombie(state: CzState): boolean {
  const zombie = Object.values(state.zombies)
    .filter((candidate) => candidate.ap > 0)
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  if (!zombie) return false;

  // A screamer breeds when it wakes: killing it fast is the whole assignment.
  // Under the Great Screamer, the scream carries twice as far.
  const summons = zombieDef(zombie.def).summons;
  if (summons) {
    const litter = state.config.mode === 'gm' && state.config.gmClass === 'hurleur' ? 2 : 1;
    for (let i = 0; i < litter; i++) {
      spawnZombie(state, zombie.roomId, summons);
    }
  }

  while (zombie.ap > 0 && state.zombies[zombie.id]) {
    if (heroesInRoom(state, zombie.roomId).length > 0) {
      zombie.ap -= 1;
      resolveZombieAttack(state, zombie);
      checkEnd(state);
      continue;
    }

    const target = nearestHero(state, zombie.roomId);
    if (!target) break;

    const path = shortestPath(state.board, zombie.roomId, target.roomId);
    const step = path?.[0];
    if (!step) break;

    zombie.ap -= 1;
    zombie.roomId = step;
  }

  zombie.ap = 0;
  return Object.values(state.zombies).some((candidate) => candidate.ap > 0);
}

/**
 * Closest active hero by path length; noise breaks the tie. Firing a gun is how
 * you volunteer.
 */
function nearestHero(state: CzState, fromRoomId: string): HeroState | null {
  let best: HeroState | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestNoise = -1;

  for (const hero of activeHeroes(state)) {
    const path = shortestPath(state.board, fromRoomId, hero.roomId);
    if (path === null) continue;
    const noise = state.noise[hero.roomId] ?? 0;

    if (path.length < bestDistance || (path.length === bestDistance && noise > bestNoise)) {
      best = hero;
      bestDistance = path.length;
      bestNoise = noise;
    }
  }

  return best;
}

/**
 * AI reinforcements, once the horde has moved.
 *
 * Everything here climbs with the threat curve: the odds a spawn room fires, the
 * size of a walker pack, and (via `rollZombieType`) what crawls out of it. Turn
 * three sends a zombie; turn fifteen sends a brute with friends.
 */
export function spawnReinforcements(state: CzState): void {
  const level = threat(state);
  const base = [0.25, 0.5, 0.75, 0.95][state.config.reinforcement] ?? 0.5;
  const odds = Math.min(1, base + level / 60);

  for (const room of state.board.rooms) {
    if (room.kind !== 'spawn') continue;
    if (!chance(state.rng, odds)) continue;

    const def = rollZombieType(state, level);
    /**
     * Walkers arrive in packs scaled to the team and the hour; bigger things come
     * alone until the threat says otherwise.
     *
     * Deliberately *not* scaled by the size of the world. A bigger world already
     * takes more turns to cross, so it already receives more reinforcement rounds —
     * multiplying the packs on top of that made the total delivered grow with the
     * board's area while the party's capacity to answer it grows only with the
     * clock. That is what took normal from 93% to 65% on the first bench of the new
     * generator. The world's size is answered by `threat`'s stretched arc instead.
     */
    const packBonus = Math.floor(level / 15);
    const count =
      def === 'walker'
        ? 1 + randInt(state.rng, Math.max(1, activeHeroes(state).length)) + packBonus
        : 1 + (level >= 30 ? randInt(state.rng, 2) : 0);
    for (let i = 0; i < count; i++) {
      spawnZombie(state, room.id, def);
    }
    log(state, `${count > 1 ? `${count} renforts` : 'Un renfort'} (${zombieDef(def).name}) en ${room.id}`);
  }
}

export function endEnemyPhase(state: CzState, now = Date.now()): void {
  if (state.phase !== 'enemy') return;

  // Last turn's gunfire has been answered; the map goes quiet again.
  state.noise = {};
  state.gmRush = false;

  if (
    state.config.scenario === 'survival' &&
    state.turn >= state.config.survivalTurns &&
    // No extraction with the job half done: the chopper circles until it is.
    objectivesDone(state)
  ) {
    finish(state, 'won', 'Extraction ! Vous avez tenu.');
    return;
  }

  checkEnd(state);
  if (state.phase === 'enemy') {
    startHeroPhase(state, now);
  }
}

/* ------------------------------- GM actions ------------------------------- */

export type GmAction =
  | { type: 'gmMove'; zombieId: string; roomId: string }
  | { type: 'gmAttack'; zombieId: string }
  | { type: 'gmSpawn'; roomId: string; def: string }
  /** Permanent horde upgrades: every future spawn carries them. */
  | { type: 'gmUpgrade'; upgrade: 'hide' | 'claws' }
  /** One-shot orders for this phase. */
  | { type: 'gmOrder'; order: 'rush' };

/**
 * The game master's shop. Costs escalate per level so the second rank of claws
 * is a real decision, and both trees cap: the ceiling is what keeps a hoarding
 * GM from making the late game unlosable.
 */
export const GM_UPGRADES: Record<
  'hide' | 'claws',
  { label: string; maxLevel: number; cost: (level: number) => number }
> = {
  hide: { label: 'Carapace (+1 PV aux renforts)', maxLevel: 3, cost: (level) => 8 + level * 4 },
  claws: { label: 'Griffes (+1 dégât aux renforts)', maxLevel: 2, cost: (level) => 12 + level * 6 }
};

export const GM_ORDERS: Record<'rush', { label: string; cost: number }> = {
  rush: { label: 'Ruée (+1 PA à toute la horde, ce tour)', cost: 6 }
};

export function applyGmAction(state: CzState, action: GmAction): ActionResult {
  if (state.phase !== 'enemy') return { ok: false, error: 'Ce n’est pas la phase de la horde' };
  if (state.config.mode !== 'gm') return { ok: false, error: 'L’IA joue cette partie' };

  switch (action.type) {
    case 'gmMove': {
      const zombie = state.zombies[action.zombieId];
      if (!zombie) return { ok: false, error: 'Zombie inconnu' };
      if (zombie.ap <= 0) return { ok: false, error: 'Plus de PA' };
      const from = getRoom(state.board, zombie.roomId);
      if (!neighbors(state.board, from).some((room) => room.id === action.roomId)) {
        return { ok: false, error: 'Pas de porte par là' };
      }
      zombie.ap -= 1;
      zombie.roomId = action.roomId;
      return { ok: true };
    }

    case 'gmAttack': {
      const zombie = state.zombies[action.zombieId];
      if (!zombie) return { ok: false, error: 'Zombie inconnu' };
      if (zombie.ap <= 0) return { ok: false, error: 'Plus de PA' };
      if (heroesInRoom(state, zombie.roomId).length === 0) {
        return { ok: false, error: 'Personne à mordre ici' };
      }
      zombie.ap -= 1;
      resolveZombieAttack(state, zombie);
      checkEnd(state);
      return { ok: true };
    }

    case 'gmSpawn': {
      const room = getRoom(state.board, action.roomId);
      if (room.kind !== 'spawn') return { ok: false, error: 'Pas une salle d’apparition' };
      const def = zombieDef(action.def);
      // Class pricing first, then the once-per-phase point off (breeder trophy
      // or Économat loadout perk — they share the once, never stack).
      const classCost = gmSpawnCost(state, action.def);
      const oncePerPhase = state.gmPerks.includes('breeder') || state.gmLoadout.includes('economat');
      const discounted = oncePerPhase && !state.gmDiscountUsed ? Math.max(1, classCost - 1) : classCost;
      if (discounted > state.gmBudget) return { ok: false, error: 'Budget insuffisant' };
      state.gmBudget -= discounted;
      if (discounted < classCost) state.gmDiscountUsed = true;
      // Fresh reinforcements act next phase, not the one they arrive in.
      spawnZombie(state, room.id, action.def);
      log(state, `Le maître du jeu invoque ${def.name}`);
      return { ok: true };
    }

    case 'gmUpgrade': {
      const upgrade = GM_UPGRADES[action.upgrade];
      const level = state.gmUpgrades[action.upgrade];
      if (level >= upgrade.maxLevel) return { ok: false, error: 'Déjà au maximum' };
      // Iron horde: the first rank of Carapace at half price. Cheaper, not free.
      // The bone colossus haggles everything down by 3, floored at 2.
      const discounted = action.upgrade === 'hide' && level === 0 && state.gmPerks.includes('iron-horde');
      let cost = discounted ? Math.ceil(upgrade.cost(level) / 2) : upgrade.cost(level);
      if (state.config.gmClass === 'ossature') cost = Math.max(2, cost - 3);
      if (state.gmLoadout.includes('forgeron')) cost = Math.max(2, cost - 2);
      if (cost > state.gmBudget) return { ok: false, error: `Il faut ${cost} points` };
      state.gmBudget -= cost;
      state.gmUpgrades[action.upgrade] = level + 1;
      log(state, `La horde évolue : ${upgrade.label}`);
      return { ok: true };
    }

    case 'gmOrder': {
      if (state.gmRush) return { ok: false, error: 'Déjà ordonné ce tour' };
      const order = GM_ORDERS[action.order];
      // The general barks cheaper; the Clairon perk shaves two more.
      const base = state.config.gmClass === 'general' ? 3 : order.cost;
      const cost = Math.max(1, base - (state.gmLoadout.includes('clairon') ? 2 : 0));
      if (cost > state.gmBudget) return { ok: false, error: `Il faut ${cost} points` };
      state.gmBudget -= cost;
      state.gmRush = true;
      for (const zombie of Object.values(state.zombies)) {
        zombie.ap += 1;
      }
      log(state, 'La horde entend l’appel : ruée !');
      return { ok: true };
    }

    default:
      return { ok: false, error: 'Action inconnue' };
  }
}

/* ------------------------------ end and score ----------------------------- */

function finish(state: CzState, phase: 'won' | 'lost', message: string): void {
  state.phase = phase;
  state.phaseEndsAt = null;
  log(state, message);
}

export function checkEnd(state: CzState): void {
  if (state.phase === 'won' || state.phase === 'lost') return;

  if (state.config.scenario === 'purge' && state.killsTotal >= state.config.killTarget) {
    finish(state, 'won', 'La purge est accomplie.');
    return;
  }

  const remaining = activeHeroes(state).length;
  if (remaining > 0) return;

  const escaped = Object.values(state.heroes).some((hero) => hero.escaped);
  if (state.config.scenario === 'escape' && escaped) {
    finish(state, 'won', 'Les survivants sont dehors.');
  } else {
    finish(state, 'lost', 'La horde a gagné.');
  }
}

export interface FinalScore {
  playerId: string;
  name: string;
  heroId: string;
  score: number;
  kills: number;
  keysPicked: number;
  searches: number;
  damageTaken: number;
  alive: boolean;
  escaped: boolean;
}

/**
 * Points, so an evening of CoronaZ feeds the same history and careers as the
 * quizzes. Kills are weighted by what they were, objectives pay best, and
 * surviving is worth something even in defeat.
 */
export function finalScores(state: CzState): FinalScore[] {
  const won = state.phase === 'won';
  // Endless is scored on how long the lights stayed on; team objectives pay
  // everyone, since they gate everyone's exit.
  const enduranceBonus = state.config.scenario === 'endless' ? Math.floor(state.turn / 2) : 0;
  const objectivesDoneCount = state.objectives.filter((objective) => objective.done).length;
  const objectiveBonus = objectivesDoneCount * 3;

  return Object.values(state.heroes)
    .map((hero) => ({
      playerId: hero.playerId,
      name: hero.name,
      heroId: hero.heroId,
      score:
        hero.killPoints +
        hero.keysPicked * 5 +
        hero.searches +
        enduranceBonus +
        objectiveBonus +
        // Lettré: the scholar's cut, score only.
        (hero.loadout.includes('lettre') ? objectivesDoneCount * 2 : 0) +
        (hero.escaped ? 10 : 0) +
        (won ? 5 : 0) +
        (hero.alive ? 3 : 0),
      kills: hero.kills,
      keysPicked: hero.keysPicked,
      searches: hero.searches,
      damageTaken: hero.damageTaken,
      alive: hero.alive,
      escaped: hero.escaped
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'fr'));
}
