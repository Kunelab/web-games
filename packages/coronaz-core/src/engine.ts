import { resolveHeroAttack, resolveZombieAttack, weaponFor, type Hand } from './combat.js';
import { archetypeOf, itemFor, zombieFor } from './content/registry.js';
import { gearStats, heroDef, itemDef, RARITY_META, zombieDef } from './data.js';
import { rollLoot } from './loot.js';
import { mutationEffects } from './mutations.js';
import { CZ_EVENTS, EVENT_CHANCE, EVENT_FROM_TURN } from './events.js';
import { getRoom, neighbors, shortestPath } from './map.js';
import { SHINY_LOOT } from './mapgen/programs.js';
import { chance, randInt } from './rng.js';
import { raidPaused, startRaidPresence } from './presence.js';
import {
  activeHeroes,
  bagCapacity,
  HERO_AP,
  partyPressure,
  hasTorch,
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
  zombiesInRoom,
  type CzState,
  type HeroState,
  type ItemInstance,
  type ZombieState
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
  | { type: 'ready' }
  /** Walk away mid-raid. The others keep playing. */
  | { type: 'forfeit' };

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** Set by a successful search, so the phone can offer one-tap equipping. */
  loot?: ItemInstance;
  /** Attack feedback, so the phone can sound the hit and the kill. */
  hits?: number;
  killed?: string[];
}

/**
 * What every action answers while the raid is stopped.
 *
 * A pause exists so nobody loses a turn to somebody else's router, which only
 * works if nothing moves during it: the phase clock is parked, the horde does not
 * activate, and a survivor cannot spend the AP of a turn the absent player is
 * still owed.
 */
const PAUSED_REFUSAL: ActionResult = { ok: false, error: 'Le raid est en pause' };

export function applyHeroAction(state: CzState, playerId: string, action: HeroAction): ActionResult {
  if (raidPaused(state)) return PAUSED_REFUSAL;
  const hero = state.heroes[playerId];
  if (!hero) return { ok: false, error: 'Joueur inconnu' };
  if (state.phase !== 'heroes') return { ok: false, error: 'Ce n’est pas la phase des héros' };
  if (!hero.alive) return { ok: false, error: 'Vous êtes tombé' };
  if (hero.escaped) return { ok: false, error: 'Vous êtes déjà sorti' };
  if (hero.forfeited) return { ok: false, error: 'Vous avez abandonné ce raid' };

  switch (action.type) {
    case 'forfeit': {
      /**
       * Abandoning, which the game had no word for.
       *
       * A survivor could previously only leave a raid by dying in it or by playing
       * it to the end, so a table of four where one person has to catch a train
       * either waited or was stuck. Free, immediate, and irreversible on purpose:
       * it is a door, not a tactic. The raid ends by itself if this was the last
       * one standing, which is the same check a death runs.
       */
      hero.forfeited = true;
      hero.ready = true;
      hero.ap = 0;
      log(state, `${hero.name} abandonne le raid.`);
      checkEnd(state);
      return { ok: true };
    }
    case 'ready':
      // Ethan pockets one unspent point for tomorrow; everyone else just rests.
      if (heroDef(hero.heroId).ability === 'tactician' && hero.ap > 0) {
        hero.bankedAp = 1;
      }
      /**
       * Charles keeps his last point on the trigger.
       *
       * Held here rather than as its own action deliberately: "the point you did not
       * spend becomes a shot" needs no button, and it turns the decision every
       * player already makes — press Prêt now, or squeeze one more thing in — into
       * his character. It is also why he is the only survivor with a reason to *want*
       * the enemy phase.
       */
      if (heroDef(hero.heroId).ability === 'marksman' && hero.ap > 0) {
        hero.overwatch = true;
        log(state, `${hero.name} tient la ligne de mire`);
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
  // and the adrenaline shot, playable at zero AP by design.
  const freeSearch = action.type === 'search' && !hero.freeSearchUsed && hasTorch(hero);

  /**
   * `pilleur`: one free crate a turn, but only somewhere worth robbing.
   *
   * The perk it replaced lifted the raid's *first* crate by a rank and then did
   * nothing for the remaining twenty turns. This one pays every turn and only if
   * you went somewhere for it, which is the whole difference between a bonus and a
   * reason to cross the street.
   */
  const freeShiny =
    action.type === 'search' &&
    !freeSearch &&
    !hero.freeShinyUsed &&
    hero.loadout.includes('pilleur') &&
    getRoom(state.board, hero.roomId).loot >= SHINY_LOOT;

  /**
   * The raid's one free crate, spent only when nothing else would have paid for it.
   *
   * Checked after the renewable free searches on purpose: a survivor with a torch
   * should burn the torch's search first and keep the once-per-raid one in their
   * pocket, which is what a player would do if the game asked them.
   */
  const freeRaidSearch = action.type === 'search' && !freeSearch && !freeShiny && !hero.freeRaidSearchUsed;

  /**
   * `elan`: the first step into somewhere nobody has been is free, every turn.
   *
   * The same free point `nerveux` handed out on turn one, except it only exists if
   * it is spent walking into the dark — so the perk argues for exploring instead of
   * paying you for having shown up.
   */
  const freeExplore =
    action.type === 'move' &&
    !hero.freeExploreUsed &&
    hero.loadout.includes('elan') &&
    !state.explored.includes(action.roomId);

  // `serrurier`: keys cost nothing. Fetching one was a chore billed in action
  // points — enter, pick up, leave — and the scenario's whole spine.
  const freeKey = action.type === 'pickupKey' && hero.loadout.includes('serrurier');

  const freeUse =
    action.type === 'use' &&
    [...hero.bag, ...hero.gear].some(
      (item) =>
        item?.uid === action.uid &&
        (itemDef(item.def).gear?.adrenaline !== undefined ||
          // The medic's hands: healing costs them nothing.
          (itemDef(item.def).gear?.heal !== undefined && heroDef(hero.heroId).ability === 'medic'))
    );

  const anyFree = freeSearch || freeShiny || freeRaidSearch || freeUse || freeExplore || freeKey;
  if (hero.ap <= 0 && !anyFree) {
    return { ok: false, error: 'Plus de PA ce tour' };
  }

  const spend = () => {
    if (freeSearch) {
      hero.freeSearchUsed = true;
    } else if (freeShiny) {
      hero.freeShinyUsed = true;
    } else if (freeRaidSearch) {
      hero.freeRaidSearchUsed = true;
    } else if (freeExplore) {
      hero.freeExploreUsed = true;
    } else if (freeKey) {
      // Nothing to mark: it is free every time, which is the perk.
    } else {
      hero.ap -= 1;
    }
  };

  switch (action.type) {
    case 'move': {
      const from = getRoom(state.board, hero.roomId);
      const open = neighbors(state.board, from).some((room) => room.id === action.roomId);

      /**
       * Nadia runs. One point carries her two rooms, and she arrives loudly.
       *
       * Her old ability made her first step each turn free, which is the same
       * distance and none of the tension. A trade beats a discount: the horde homes
       * in on noise, so her speed is also how she gets found — and the second room
       * has to be reachable *through* the first, or she would be walking through
       * walls rather than sprinting down a corridor.
       */
      const sprinting =
        !open && heroDef(hero.heroId).ability === 'fleet' && (shortestPath(state.board, from.id, action.roomId)?.length ?? 99) === 2;

      if (!open && !sprinting) return { ok: false, error: 'Pas de porte par là' };
      spend();
      hero.roomId = action.roomId;
      if (sprinting) {
        // Noise is laid where she ends up: that is where the horde will come.
        state.noise[action.roomId] = (state.noise[action.roomId] ?? 0) + 1;
        log(state, `${hero.name} traverse au pas de course`);
      }

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

      /**
       * `eclaireur` smells the keys next door.
       *
       * It replaced `boussole`, which revealed the start room's neighbours once at
       * turn one and then never again. This one keeps paying and it points at the
       * thing the scenario is actually about — a room with a key in it stops being
       * one of a hundred identical boxes.
       */
      if (hero.loadout.includes('eclaireur')) {
        const explored = new Set(state.explored);
        for (const room of neighbors(state.board, into)) {
          if (room.hasKey) explored.add(room.id);
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
      const room = target.roomId;
      const melee = target.roomId === hero.roomId;
      const outcome = resolveHeroAttack(state, hero, target, action.hand);
      if (!outcome.ok) return outcome;
      spend();

      /**
       * Johanna's execution: clearing a room in melee gives the point back.
       *
       * Her old ability was one more melee die. This is about the same amount of
       * killing and a far better shape: two creatures and two points is a bet that
       * both of them die, and winning it buys the room *and* the step out of it.
       * Melee only, and only if the room is genuinely empty — the refund is for
       * finishing the job, not for swinging.
       */
      if (
        melee &&
        heroDef(hero.heroId).ability === 'assassin' &&
        (outcome.killed?.length ?? 0) > 0 &&
        zombiesInRoom(state, room).length === 0
      ) {
        hero.ap += 1;
        log(state, `${hero.name} nettoie la salle et reprend son souffle`);
      }

      checkEnd(state);
      return outcome;
    }

    case 'search': {
      /**
       * A full bag is a swap for a dealer, and a refusal for everybody else.
       *
       * `brocanteur` exists because the back half of a raid used to be spent unable
       * to look at anything at all: five slots fill up, and from then on every crate
       * is a "Sac plein". Trading up is the interesting version of that problem —
       * what do you leave on the floor — and it needs no new action to express.
       */
      const swapping = hero.bag.length >= bagCapacity(hero) && hero.loadout.includes('brocanteur');
      if (hero.bag.length >= bagCapacity(hero) && !swapping) return { ok: false, error: 'Sac plein' };
      /**
       * A room runs dry. Nothing used to stop a survivor searching the same room
       * for the whole raid, which made standing still the strongest play in any
       * room the loot table paid well for — and standing still is the one thing
       * this game should never reward. Now a good room is a destination rather
       * than a campsite.
       */
      const here = getRoom(state.board, hero.roomId);
      /**
       * Chuck's eye finds the one more thing everybody else walked past, which is
       * why a team keeps him in the armoury rather than sending him on ahead.
       *
       * Counted by letting the room's stock go to -1 rather than by remembering
       * which rooms he has already picked over. Clamping at zero instead looked
       * right and gave him *unlimited* searches in a spent room — his allowance
       * would have recomputed to one every time — and a per-hero set of room ids
       * would be more state to serialise for the same answer. At -1 the room refuses
       * him too, and it was already refusing everybody else at zero.
       */
      const allowance = here.finds + (heroDef(hero.heroId).ability === 'scavenger' ? 1 : 0);
      if (allowance <= 0) return { ok: false, error: 'Cette salle est vidée' };
      spend();
      here.finds -= 1;
      if (swapping) {
        // The worst thing in the bag goes on the floor. Rarity first, then tier:
        // a legendary machete outranks a common rifle, which is the whole reason
        // rarity exists per instance.
        let worst = 0;
        for (let index = 1; index < hero.bag.length; index++) {
          const candidate = hero.bag[index];
          const standing = hero.bag[worst];
          if (!candidate || !standing) continue;
          const score = (item: ItemInstance) => item.rarity * 10 + itemDef(item.def).tier;
          if (score(candidate) < score(standing)) worst = index;
        }
        const dropped = hero.bag.splice(worst, 1)[0];
        if (dropped) log(state, `${hero.name} laisse ${describe(dropped)}`);
      }
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

/* Loot lives in loot.ts: both searching and killing produce it, and combat cannot
   import the engine. Re-exported here because every caller already looks for it. */
export { dropFromKill, FORCED_LUCK_DRAWS, rollLoot, type LootRoll } from './loot.js';

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
  if (!receiver || !receiver.alive || receiver.escaped) {
    return { ok: false, error: 'Personne pour le prendre ici' };
  }

  /**
   * `courrier` throws it through the doorway.
   *
   * Handing things over was already free and already the best thing a team could
   * do — but it required both survivors to be standing in the same room, so the
   * free action routinely cost two moves to set up. One room of reach is the
   * cheapest way to make the game's most co-operative verb actually usable.
   */
  const reach = hero.loadout.includes('courrier') ? 1 : 0;
  if (receiver.roomId !== hero.roomId) {
    const distance = reach === 0 ? 99 : (shortestPath(state.board, hero.roomId, receiver.roomId)?.length ?? 99);
    if (distance > reach) return { ok: false, error: 'Personne pour le prendre ici' };
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
  if (gmClass === 'hurleur' && archetype === 'screamer') cost -= 2;
  /**
   * The Tracker's runner discount is gone, and so are the General's and the Bone
   * Colossus's.
   *
   * All three classes were nothing but a price list — "runners cost 1", "Rush costs
   * 3", "upgrades cost 3 less" — which is a spreadsheet edit rather than an
   * identity, and picking between them changed the arithmetic without changing how
   * the horde played. Each now bends a *rule* instead: the Tracker's creatures
   * quicken where guns were fired, the General's first reinforcement acts at once,
   * and the Bone Colossus can surface anywhere nobody has looked.
   */
  if (state.gmLoadout.includes('porte-voix') && archetype === 'screamer') cost -= 1;

  return Math.max(1, cost);
}

export function startGame(state: CzState, now = Date.now()): void {
  if (state.phase !== 'lobby') return;
  if (Object.keys(state.heroes).length === 0) throw new Error('Personne dans la partie');
  state.turn = 0;

  /**
   * The objective deliberately does *not* scale with the table.
   *
   * It was tried: a key per survivor, surplus keys taken off the board. It made two
   * players (78% on `difficile`) beat three (72%), because a team can fetch keys in
   * parallel — so a smaller table was getting both a shorter job and a smaller
   * horde. A difficulty curve that dips in the middle is worse than one that is
   * merely steep. The party is answered by the horde's volume (`partyPressure`) and
   * by the pace of the escalation (`partyPace`), and the job stays the job.
   */

  // The lobby picks become physical things: starter kits, side arms, a known
  // neighbourhood. All flat, all once.
  // Perks hand out a *kind* of thing; the biome decides what that is here.
  const kit = (role: Parameters<typeof itemFor>[1]) => makeItem(state, itemFor(state.config.biome, role).id);

  for (const hero of Object.values(state.heroes)) {
    if (hero.loadout.includes('soigneur')) {
      hero.bag.push(kit('medkit'));
    }
    if (hero.loadout.includes('injection')) {
      hero.bag.push(kit('stim'));
    }
    // `serrurier` shows the door from the first breath: knowing where you are
    // leaving from is what makes the route a decision rather than a discovery.
    if (hero.loadout.includes('serrurier')) {
      const exit = state.board.rooms.find((room) => room.kind === 'exit');
      if (exit) {
        const explored = new Set(state.explored);
        explored.add(exit.id);
        state.explored = [...explored];
      }
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
  startRaidPresence(state, now);
  startHeroPhase(state, now);
  log(state, 'La partie commence.');
}

export function startHeroPhase(state: CzState, now = Date.now()): void {
  state.phase = 'heroes';
  state.turn += 1;
  for (const hero of Object.values(state.heroes)) {
    if (!hero.alive || hero.escaped || hero.forfeited) continue;
    hero.ap =
      HERO_AP +
      (state.turn === 1 && hero.perks.includes('sprinter') ? 1 : 0) +
      // Ethan's banked point comes home.
      (hero.bankedAp ?? 0);
    hero.bankedAp = 0;
    hero.ready = false;
    hero.freeSearchUsed = false;
    hero.freeMoveUsed = false;
    hero.noiseSkipUsed = false;
    hero.freeShinyUsed = false;
    hero.freeExploreUsed = false;
    // A held shot is spent, or it expired unfired; either way the new turn starts
    // with the barrel down.
    hero.overwatch = false;
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

  const mutated = mutationEffects(state.config.mutations);
  for (const zombie of Object.values(state.zombies)) {
    zombie.ap = zombieDef(zombie.def).ap + mutated.ap;
    /**
     * The Tracker's creatures quicken where guns were fired.
     *
     * His old class was "runners cost 1", a price list entry. This makes him the one
     * horde that *punishes noise*, which turns a rule the survivors already know
     * about into a decision they have to keep making — and it means playing quietly
     * against him is a real strategy rather than a mild preference. Read here, before
     * `endEnemyPhase` wipes the noise, because the shots that matter are the ones
     * fired during the turn just finished.
     */
    if (state.config.mode === 'gm' && state.config.gmClass === 'traqueur' && (state.noise[zombie.roomId] ?? 0) > 0) {
      zombie.ap += 1;
    }
  }
  state.gmSurgeUsed = false;
  for (const hero of Object.values(state.heroes)) {
    hero.toughUsed = false;
    /**
     * The clock is a valid way to hold a shot too.
     *
     * `ready` arms it and then zeroes the points, so a Charles who pressed the
     * button is already covered. This is the other path in: a phase that simply ran
     * out with points still in his hand should mean the same thing, or the ability
     * would quietly punish the player who was still deciding when the timer went.
     */
    if (hero.alive && !hero.escaped && !hero.forfeited && hero.ap > 0 && heroDef(hero.heroId).ability === 'marksman') {
      hero.overwatch = true;
    }
  }

  rollEvent(state);

  if (state.config.mode === 'gm') {
    /**
     * A swarm and a lull, in the currency a *human* horde actually spends.
     *
     * `spawnReinforcements` never runs in game-master mode — the dens do not fire,
     * the game master buys everything by hand — so those two events announced
     * themselves on every screen and then did precisely nothing. An event that says
     * "les salles d'apparition crachent deux fois ce tour" and changes no part of the
     * board is worse than no event: it is the game lying to the table, which is the
     * exact failure the whole feature is built to avoid.
     *
     * So against a human they move the budget instead. Same two turns, same two
     * directions, in the resource that is the horde's reinforcements here.
     */
    const income = gmIncome(state);
    state.gmBudget += state.event === 'calm' ? 0 : state.event === 'swarm' ? income * 2 : income;
    if (state.event === 'calm') log(state, '🌙 La horde ne reçoit rien ce tour.');
    if (state.event === 'swarm') log(state, '🐝 Le budget de la horde double ce tour.');
    state.gmDiscountUsed = false;
  }

  state.phaseEndsAt =
    state.config.mode === 'gm' && state.config.gmPhaseSeconds > 0 ? now + state.config.gmPhaseSeconds * 1000 : null;
  state.lastActivityAt = now;
}

/**
 * The district's weather for this turn, and whatever it does to the board.
 *
 * Rolled here, at the top of the enemy phase, so the survivors learn what is
 * happening at the same moment the horde starts moving — and cleared in
 * `endHeroPhase`'s counterpart, so it never lasts into a second turn.
 *
 * The reason any of this exists is that turn six played exactly like turn five: the
 * escalation curve made a raid steadily harder and never made it different, so a
 * table had seen the whole shape of the game by its third evening. See `events.ts`
 * for why the set is built in opposing pairs and why that is what keeps the
 * difficulty ladder valid.
 */
function rollEvent(state: CzState): void {
  state.event = null;
  if (!state.config.events) return;
  if (state.turn < EVENT_FROM_TURN) return;
  if (!chance(state.rng, EVENT_CHANCE)) return;

  const rolled = CZ_EVENTS[randInt(state.rng, CZ_EVENTS.length)];
  if (!rolled) return;
  state.event = rolled.id;
  log(state, `${rolled.emoji} ${rolled.name} — ${rolled.blurb}`);

  /**
   * The two that change the board rather than a rule.
   *
   * `siren` and `drop` both name a room, and both draw from rooms the team has
   * actually seen: an alarm in a district nobody has visited pulls the horde
   * somewhere invisible, which reads as the horde behaving strangely for no reason,
   * and a crate nobody can find is not a reward.
   */
  const known = state.board.rooms.filter((room) => state.explored.includes(room.id));
  const stage = known.length > 0 ? known : state.board.rooms;
  const where = stage[randInt(state.rng, stage.length)];
  if (!where) return;

  if (rolled.id === 'siren') {
    // Noise is what the horde homes in on, so this is written in the same currency
    // a gunshot is. Loud enough to outbid an ordinary firefight, and it can just as
    // easily pull them off somebody as onto them — which is the point of it being
    // an event rather than an attack.
    state.noise[where.id] = (state.noise[where.id] ?? 0) + SIREN_NOISE;
    log(state, `L’alarme vient de ${where.id}`);
  }

  if (rolled.id === 'drop') {
    // Stock and quality, both: a crate is a *destination*, which is the one thing a
    // supply drop has to be. Spent by searching like anything else, so it competes
    // for action points instead of being handed over.
    where.finds += DROP_FINDS;
    where.loot += DROP_LOOT;
    log(state, `La caisse est tombée en ${where.id}`);
  }
}

/** How loud an alarm is, in gunshots. Enough to outbid a firefight. */
const SIREN_NOISE = 5;
/** What a crate holds, and how well the table pays for it. */
const DROP_FINDS = 3;
const DROP_LOOT = 0.6;

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
    // It walked into somebody's sights.
    if (!fireOverwatch(state, zombie)) break;
  }

  zombie.ap = 0;
  return Object.values(state.zombies).some((candidate) => candidate.ap > 0);
}

/**
 * Charles's held shot, resolved: the creature just moved, so somebody may be
 * waiting for it.
 *
 * Called from both places a creature can change rooms — the AI's activation loop
 * and the game master's move — because the ability is about the board, not about
 * who is pushing the pieces. A held shot must mean the same thing against a human
 * as against the server, or the two modes are different games.
 *
 * Returns false when the creature died, which is the caller's cue to stop walking
 * it: everything below the call site assumes it still exists.
 */
function fireOverwatch(state: CzState, zombie: ZombieState): boolean {
  for (const hero of activeHeroes(state)) {
    if (!hero.overwatch) continue;

    // The shot is only ever taken with what is actually in hand. Both hands are
    // offered and the first that can reach wins, which is the same order the
    // phone's attack menu uses.
    for (const hand of [0, 1] as const) {
      if (!state.zombies[zombie.id]) return false;
      const chosen = weaponFor(hero, hand);
      if ('error' in chosen) continue;
      // Melee is not overwatch: standing in a doorway with a bat is not holding a
      // line of fire, and letting it count would make the ability free for anyone.
      if (chosen.weapon.melee) continue;

      const outcome = resolveHeroAttack(state, hero, zombie, hand);
      if (!outcome.ok) continue;

      hero.overwatch = false;
      log(state, `${hero.name} tire de son poste !`);
      checkEnd(state);
      return state.zombies[zombie.id] !== undefined;
    }
  }
  return true;
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
  /**
   * How often a den fires, scaled to the table. This is the only party term in the
   * reinforcements, and it is the one that was missing: what a party can answer is
   * its action points, so what arrives has to scale with heads or a preset means
   * two different games depending on how many people turned up.
   */
  /**
   * The weather's half of the reinforcements.
   *
   * A lull stops them dead and a swarm doubles the odds. These are the pair that
   * carries most of the events' variance, and they are deliberately the two that
   * cancel most exactly: same frequency, opposite sign, one turn each.
   */
  if (state.event === 'calm') {
    log(state, '🌙 Rien ne vient.');
    return;
  }
  const weather = state.event === 'swarm' ? 2 : 1;

  const odds = Math.min(
    1,
    (base + level / 60) * partyPressure(state) * mutationEffects(state.config.mutations).reinforcement * weather
  );

  for (const room of state.board.rooms) {
    if (room.kind !== 'spawn') continue;
    if (!chance(state.rng, odds)) continue;

    const def = rollZombieType(state, level);
    /**
     * Shamblers arrive in packs that grow with the hour; bigger things come alone
     * until the threat says otherwise.
     *
     * Deliberately scaled by neither the size of the world nor the size of the
     * party — both live elsewhere. The world is answered by `threat`'s stretched
     * arc (a bigger world takes more turns, so it already receives more waves) and
     * the party by the odds above. Multiplying here as well is what took normal
     * from 93% to 65% on the first bench of the new generator: the total delivered
     * grew with the board's area while the party's capacity grew with the clock.
     */
    const packBonus = Math.floor(level / 15);
    const count =
      def === zombieFor(state.config.biome, 'walker').id
        ? 1 + randInt(state.rng, 2) + packBonus
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
  /**
   * And the weather clears.
   *
   * One turn is the whole contract: nothing here compounds, so a blackout cannot
   * become the raid and a lull cannot become the difficulty setting. The crate a
   * supply drop left behind stays, because that one is a place rather than a rule.
   */
  state.event = null;

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
  | { type: 'gmOrder'; order: 'rush' }
  /** Concede the raid to the survivors. */
  | { type: 'gmForfeit' };

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
  if (raidPaused(state)) return PAUSED_REFUSAL;
  if (state.config.mode !== 'gm') return { ok: false, error: 'L’IA joue cette partie' };
  /**
   * Conceding is the one thing the horde may do out of turn.
   *
   * Every other game-master action needs the enemy phase, but a game master who
   * wants to stop should not have to wait for his turn to come round to say so, and
   * the survivors should not have to keep playing a raid nobody is running.
   */
  if (action.type === 'gmForfeit') {
    if (state.phase === 'won' || state.phase === 'lost') return { ok: false, error: 'La partie est finie' };
    log(state, 'Le maître du jeu abandonne : la horde se retire.');
    finish(state, 'won', 'La horde abandonne le terrain.');
    return { ok: true };
  }
  if (state.phase !== 'enemy') return { ok: false, error: 'Ce n’est pas la phase de la horde' };

  switch (action.type) {
    case 'gmMove': {
      const zombie = state.zombies[action.zombieId];
      if (!zombie) return { ok: false, error: 'Zombie inconnu' };
      if (zombie.ap <= 0) return { ok: false, error: 'Plus de PA' };

      /**
       * One tap can spend the creature's whole allowance.
       *
       * A tap used to be worth exactly one room, so a runner with two points cost the
       * game master four taps to walk — select, tap, select, tap — and by turn eight
       * there are thirty creatures and forty-five seconds. That is the single biggest
       * reason that screen could not be played rather than merely operated.
       *
       * Still one point per room, still along a real path, and the held-shot check
       * runs after *every* step: a survivor watching a corridor gets his shot at the
       * moment the creature crosses his line, not at the end of its walk. Anything
       * further than the points on hand is refused rather than truncated — a horde
       * that half-obeys is worse than one that says no.
       */
      const path = shortestPath(state.board, zombie.roomId, action.roomId);
      if (!path || path.length === 0) return { ok: false, error: 'Pas de porte par là' };
      if (path.length > zombie.ap) return { ok: false, error: `Il faut ${path.length} PA` };

      for (const step of path) {
        zombie.ap -= 1;
        zombie.roomId = step;
        // A held shot answers a human's hand exactly as it answers the server's, and
        // it can kill: stop walking a creature that no longer exists.
        if (!fireOverwatch(state, zombie)) break;
      }
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
      /**
       * The Bone Colossus surfaces anywhere nobody has looked.
       *
       * His old class was "upgrades cost 3 less", which is a price and not a
       * character. This is the same budget spent on *where* instead of on how much,
       * and it is the only thing in the game that lets the horde ambush: the
       * survivors' own unexplored map becomes the threat, so scouting stops being
       * bookkeeping. Bounded by the fog itself — every room they light is a room he
       * loses — so the ability shrinks exactly as the raid goes on.
       */
      const canSurface =
        state.config.gmClass === 'ossature' && !state.explored.includes(room.id) && !heroesInRoom(state, room.id).length;
      if (room.kind !== 'spawn' && !canSurface) return { ok: false, error: 'Pas une salle d’apparition' };
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
      const summoned = spawnZombie(state, room.id, action.def);
      /**
       * The General's first reinforcement each turn arrives already awake.
       *
       * His old class was "Rush costs 3", which is a discount on an order he was
       * going to buy anyway. Breaking the "reinforcements wait a phase" rule is a
       * genuinely different way to play the horde — a bought creature can bite *now*,
       * so his budget is a threat in the moment rather than an investment — and one a
       * turn keeps it from becoming the only thing he ever does.
       */
      if (state.config.gmClass === 'general' && !state.gmSurgeUsed && summoned) {
        state.gmSurgeUsed = true;
        summoned.ap = zombieDef(action.def).ap + mutationEffects(state.config.mutations).ap;
        log(state, `${def.name} arrive au pas de charge`);
      }
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
      const base = order.cost;
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
  /** Took no perk at all, and was paid for it. Shown on the end screen. */
  bareHanded: boolean;
  /** Walked away mid-raid, which is neither a death nor an escape. */
  forfeited: boolean;
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

  const required = state.objectives.filter((objective) => !objective.optional);
  const bonuses = state.objectives.filter((objective) => objective.optional);
  const requiredDone = required.filter((objective) => objective.done).length;
  const bonusesDone = bonuses.filter((objective) => objective.done).length;
  // A bonus quest pays more than a required one: nobody had to take it.
  const objectiveBonus = requiredDone * 3 + bonusesDone * 6;

  /** What the table earned for handicapping itself. */
  const mutationReward = mutationEffects(state.config.mutations).reward;

  return Object.values(state.heroes)
    .map((hero) => {
      const raw =
        hero.killPoints +
        hero.keysPicked * 5 +
        hero.searches +
        enduranceBonus +
        objectiveBonus +
        // Lettré: the scholar's cut, score only.
        (hero.loadout.includes('lettre') ? (requiredDone + bonusesDone) * 2 : 0) +
        /**
         * Bare-handed: a survivor who took no loadout at all scores more.
         *
         * Perks are a real advantage, so declining them is a real handicap, and a
         * handicap nobody notices is a handicap nobody takes. Flat rather than a
         * multiplier, like everything else here, and worth about a boss.
         */
        (hero.loadout.length === 0 ? 12 : 0) +
        (hero.escaped ? 10 : 0) +
        (won ? 5 : 0) +
        (hero.alive ? 3 : 0);

      return {
        playerId: hero.playerId,
        name: hero.name,
        heroId: hero.heroId,
        score: Math.round(raw * mutationReward),
        kills: hero.kills,
        keysPicked: hero.keysPicked,
        searches: hero.searches,
        damageTaken: hero.damageTaken,
        alive: hero.alive,
        escaped: hero.escaped,
        bareHanded: hero.loadout.length === 0,
        forfeited: hero.forfeited === true
      };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'fr'));
}
