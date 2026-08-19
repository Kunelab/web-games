import type { GearStats, ItemDef, WeaponStats } from '../data.js';
import type { ItemRole, ZombieArchetype } from './roles.js';
import { archetypeDef, roleDef } from './roles.js';

/**
 * What a biome is, and what it takes to write one.
 *
 * A biome is the whole surface of a raid: what you fight with, what fights you,
 * and what the place looks like. Layouts are orthogonal to it — a cyberpunk
 * suburb and a modern bunker are both legal — so a biome never says anything about
 * floor plans beyond which building programmes suit it.
 *
 * Adding one is a file and a line in the registry, exactly like a quiz media kind:
 *
 *   1. fill all sixteen item roles and all nine creature archetypes;
 *   2. list the building programmes it wants;
 *   3. add it to `BIOMES` in registry.ts.
 *
 * What you *cannot* do is make it stronger: a role owns its tier and its power
 * budget, an archetype owns its stats, and both are checked by tests. Identity comes
 * from names, faces, stat *shape* and props, not from bigger numbers.
 */

/** One weapon or piece of gear, as a biome supplies it. The tier comes from the role. */
export interface BiomeItem {
  /** Globally unique across every biome: it is the id that ends up in a save file. */
  id: string;
  name: string;
  emoji: string;
  /** Weapons only. Must respect the role's power budget. */
  weapon?: WeaponStats;
  /** Gear only. */
  gear?: GearStats;
}

/** One creature, as a biome supplies it. Every number comes from the archetype. */
export interface BiomeZombie {
  /** Globally unique across every biome. */
  id: string;
  name: string;
  emoji: string;
}

export interface BiomeDef {
  id: string;
  name: string;
  /** One line for the setup screen. */
  blurb: string;
  /** Every item role, filled. */
  items: Record<ItemRole, BiomeItem>;
  /** Every creature archetype, filled. */
  zombies: Record<ZombieArchetype, BiomeZombie>;
  /** Which building programmes this world is built from. */
  buildings: readonly string[];
}

/**
 * Expands a biome into the flat `ItemDef` list the rest of the engine already
 * speaks. The tier is the role's, so no biome can move an item up the loot table.
 */
export function biomeItems(biome: BiomeDef): ItemDef[] {
  return (Object.entries(biome.items) as [ItemRole, BiomeItem][]).map(([role, item]) => {
    const definition = roleDef(role);
    return {
      id: item.id,
      name: item.name,
      kind: definition.kind,
      tier: definition.tier,
      emoji: item.emoji,
      weapon: item.weapon,
      gear: item.gear
    };
  });
}

/** The same for creatures: the archetype's numbers, the biome's face. */
export function biomeZombies(biome: BiomeDef) {
  return (Object.entries(biome.zombies) as [ZombieArchetype, BiomeZombie][]).map(([archetype, zombie]) => {
    const definition = archetypeDef(archetype);
    return {
      id: zombie.id,
      name: zombie.name,
      emoji: zombie.emoji,
      hp: definition.hp,
      ap: definition.ap,
      damage: definition.damage,
      armor: definition.armor,
      points: definition.points,
      cost: definition.cost,
      rarity: definition.rarity,
      boss: definition.boss,
      /** Resolved to the biome's own id for that archetype. */
      summons: definition.summons ? biome.zombies[definition.summons].id : undefined
    };
  });
}
