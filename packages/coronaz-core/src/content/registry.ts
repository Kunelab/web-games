import type { ItemDef, ZombieDef } from '../data.js';
import { pick, type RngState } from '../rng.js';
import { biomeItems, biomeZombies, type BiomeDef } from './biome.js';
import { modern } from './biomes/modern.js';
import type { ItemRole, ZombieArchetype } from './roles.js';

/**
 * Every biome in the game, and the lookups the rules use to reach into one.
 *
 * One line per biome, and the rest of the engine never learns their names. The
 * ids of every item and creature are globally unique across biomes, which is the
 * small decision that keeps `itemDef(id)` and `zombieDef(id)` working exactly as
 * they did — a save file holds ids, and it must still mean something after a
 * biome is added.
 */
export const BIOMES: readonly BiomeDef[] = [modern];

export const BIOME_IDS = BIOMES.map((biome) => biome.id);

export function biomeDef(id: string): BiomeDef {
  const found = BIOMES.find((biome) => biome.id === id);
  if (!found) throw new Error(`Unknown biome: ${id}`);
  return found;
}

export function rollBiome(rng: RngState): BiomeDef {
  return pick(rng, BIOMES);
}

/* ------------------------------- flat indexes ------------------------------ */

interface Resolved {
  items: ItemDef[];
  zombies: ZombieDef[];
  itemByRole: Map<ItemRole, ItemDef>;
  roleByItem: Map<string, ItemRole>;
  zombieByArchetype: Map<ZombieArchetype, ZombieDef>;
  archetypeByZombie: Map<string, ZombieArchetype>;
}

const resolved = new Map<string, Resolved>();

function resolve(biome: BiomeDef): Resolved {
  const found = resolved.get(biome.id);
  if (found) return found;

  const items = biomeItems(biome);
  const zombies = biomeZombies(biome);
  const built: Resolved = {
    items,
    zombies,
    itemByRole: new Map(
      (Object.keys(biome.items) as ItemRole[]).map((role) => {
        const item = items.find((candidate) => candidate.id === biome.items[role].id);
        if (!item) throw new Error(`Biome ${biome.id} does not fill the role ${role}`);
        return [role, item];
      })
    ),
    roleByItem: new Map((Object.keys(biome.items) as ItemRole[]).map((role) => [biome.items[role].id, role])),
    zombieByArchetype: new Map(
      (Object.keys(biome.zombies) as ZombieArchetype[]).map((archetype) => {
        const zombie = zombies.find((candidate) => candidate.id === biome.zombies[archetype].id);
        if (!zombie) throw new Error(`Biome ${biome.id} does not fill the archetype ${archetype}`);
        return [archetype, zombie];
      })
    ),
    archetypeByZombie: new Map(
      (Object.keys(biome.zombies) as ZombieArchetype[]).map((archetype) => [biome.zombies[archetype].id, archetype])
    )
  };

  resolved.set(biome.id, built);
  return built;
}

/** Every item that can be found in this biome, in role order. */
export function itemsOfBiome(biomeId: string): readonly ItemDef[] {
  return resolve(biomeDef(biomeId)).items;
}

/** Every creature this biome fields, in archetype order. */
export function zombiesOfBiome(biomeId: string): readonly ZombieDef[] {
  return resolve(biomeDef(biomeId)).zombies;
}

/**
 * The item filling a role here. This is how a perk hands out "a sidearm" and how
 * Charles finds his rifle in a world that never built one.
 */
export function itemFor(biomeId: string, role: ItemRole): ItemDef {
  const item = resolve(biomeDef(biomeId)).itemByRole.get(role);
  if (!item) throw new Error(`Biome ${biomeId} has no item for role ${role}`);
  return item;
}

/** The creature filling an archetype here. */
export function zombieFor(biomeId: string, archetype: ZombieArchetype): ZombieDef {
  const zombie = resolve(biomeDef(biomeId)).zombieByArchetype.get(archetype);
  if (!zombie) throw new Error(`Biome ${biomeId} has no creature for archetype ${archetype}`);
  return zombie;
}

/** What job an item does, whichever biome it came from. */
export function roleOf(itemId: string): ItemRole | undefined {
  for (const biome of BIOMES) {
    const role = resolve(biome).roleByItem.get(itemId);
    if (role) return role;
  }
  return undefined;
}

/** What job a creature does, whichever biome it came from. */
export function archetypeOf(zombieId: string): ZombieArchetype | undefined {
  for (const biome of BIOMES) {
    const archetype = resolve(biome).archetypeByZombie.get(zombieId);
    if (archetype) return archetype;
  }
  return undefined;
}

/** Every item of every biome: the global registry a save file resolves against. */
export function allItems(): readonly ItemDef[] {
  return BIOMES.flatMap((biome) => resolve(biome).items);
}

export function allZombies(): readonly ZombieDef[] {
  return BIOMES.flatMap((biome) => resolve(biome).zombies);
}
