import { roleOf } from './content/registry.js';
import {
  heroDef,
  itemDef,
  vestCharges,
  weaponStats,
  zombieDef,
  type ItemDef,
  type Rarity,
  type WeaponStats
} from './data.js';
import { lineOfSight } from './map.js';
import { d6, pick } from './rng.js';
import { log, updateObjectives, zombiesInRoom, type CzState, type HeroState, type ZombieState } from './state.js';

/**
 * The dice, straight from the board game the original cloned.
 *
 * A weapon rolls its dice; every die at or above its accuracy is a hit; each hit
 * deals the weapon's damage. Hits beyond the target's death spill onto another
 * zombie in the same room, which is what makes a shotgun into a crowd feel right.
 */

export type Hand = 0 | 1 | 2;

export interface AttackOutcome {
  ok: boolean;
  error?: string;
  hits?: number;
  killed?: string[];
}

/** Bernard's fallback: fists count as a weapon nobody can loot. */
const BARE_HANDS: ItemDef = {
  id: '__fists',
  name: 'Poings',
  kind: 'weapon',
  tier: 1,
  emoji: '👊',
  weapon: { range: 0, dice: 1, damage: 10, accuracy: 4, melee: true, akimbo: false, noisy: false }
};

/** A weapon as it will actually be fired: the instance's stats, not the table's. */
export interface ChosenWeapon {
  def: ItemDef;
  /** The printed stats bent by this instance's rarity. */
  weapon: WeaponStats;
  rarity: Rarity;
  dice: number;
}

/** The weapon an attack would use, or why it cannot. */
export function weaponFor(hero: HeroState, hand: Hand): ChosenWeapon | { error: string } {
  if (hand === 2) {
    const [left, right] = hero.hands;
    if (!left || !right || left.def !== right.def) {
      return { error: 'Il faut la même arme dans les deux mains' };
    }
    const def = itemDef(left.def);
    if (!def.weapon?.akimbo) {
      return { error: 'Cette arme ne se joue pas en akimbo' };
    }
    // A pair shoots as well as its worse half: akimbo doubles the dice, it does
    // not launder a chipped gun through a beautiful one.
    const rarity = Math.min(left.rarity, right.rarity) as Rarity;
    const stats = weaponStats(def, rarity);
    if (!stats) return { error: 'Ce n’est pas une arme' };
    return { def, weapon: stats, rarity, dice: stats.dice * 2 };
  }

  const item = hero.hands[hand];
  if (!item) {
    // A brawler is never unarmed.
    if (heroDef(hero.heroId).ability === 'brawler') {
      const bare = BARE_HANDS.weapon;
      if (!bare) return { error: 'Rien dans cette main' };
      return { def: BARE_HANDS, weapon: bare, rarity: 1, dice: 1 };
    }
    return { error: 'Rien dans cette main' };
  }
  const def = itemDef(item.def);
  const stats = weaponStats(def, item.rarity);
  if (!stats) return { error: 'Ce n’est pas une arme' };
  return { def, weapon: stats, rarity: item.rarity, dice: stats.dice };
}

export function resolveHeroAttack(state: CzState, hero: HeroState, target: ZombieState, hand: Hand): AttackOutcome {
  const chosen = weaponFor(hero, hand);
  if ('error' in chosen) return { ok: false, error: chosen.error };
  const weapon = chosen.weapon;

  const ability = heroDef(hero.heroId).ability;

  // Reach: melee wants the same room; ranged wants a straight, open line.
  // Suzanne's eye adds one room to every barrel.
  if (weapon.melee) {
    if (target.roomId !== hero.roomId) {
      return { ok: false, error: 'Trop loin pour le corps à corps' };
    }
  } else {
    const reach = weapon.range + (ability === 'deadeye' ? 1 : 0);
    const sight = lineOfSight(state.board, hero.roomId, reach);
    if (!sight.has(target.roomId)) {
      return { ok: false, error: 'Pas de ligne de vue' };
    }
  }

  let dice = chosen.dice;
  if (weapon.melee && ability === 'assassin') dice += 1;
  // Diego fights best with his back to the wall.
  if (ability === 'daredevil' && hero.hp <= 20) dice += 1;
  // The boss-slayer perk: one flat die, only against the things it was earned on.
  if (hero.perks.includes('boss-slayer') && zombieDef(target.def).boss) dice += 1;
  // The *kind* of weapon you grew up with: one die of familiarity, two if you
  // built your loadout around it. Loot's second question — good, and good FOR ME.
  // Matched by role, so a marksman is a marksman in a world without rifles.
  if (heroDef(hero.heroId).favoriteWeapon === roleOf(chosen.def.id)) {
    dice += 1 + (hero.loadout.includes('fetiche') ? 1 : 0);
  }
  // Brave: nobody watching your back sharpens the arm.
  if (
    hero.loadout.includes('brave') &&
    !Object.values(state.heroes).some(
      (other) => other.playerId !== hero.playerId && other.alive && !other.escaped && other.roomId === hero.roomId
    )
  ) {
    dice += 1;
  }

  const rolls: number[] = [];
  for (let i = 0; i < dice; i++) rolls.push(d6(state.rng));

  // Charles rerolls one missed die on ranged attacks. Applied before counting so
  // the log shows the roll that actually decided the outcome.
  if (!weapon.melee && ability === 'marksman') {
    const missIndex = rolls.findIndex((roll) => roll < weapon.accuracy);
    if (missIndex !== -1) {
      rolls[missIndex] = d6(state.rng);
    }
  }

  const hits = rolls.filter((roll) => roll >= weapon.accuracy).length;

  // Inès never rings the dinner bell; the "discret" perk muffles one shot a turn.
  if (weapon.noisy && ability !== 'silent') {
    if (hero.loadout.includes('discret') && !hero.noiseSkipUsed) {
      hero.noiseSkipUsed = true;
    } else {
      state.noise[hero.roomId] = (state.noise[hero.roomId] ?? 0) + 1;
    }
  }

  const killed: string[] = [];
  let current: ZombieState | undefined = target;

  for (let hit = 0; hit < hits && current; hit++) {
    current.hp -= weapon.damage;
    if (current.hp <= 0) {
      killed.push(current.id);
      creditKill(state, hero, current);
      const room: string = current.roomId;
      delete state.zombies[current.id];
      // Spare hits find another target in the same room, or stop.
      const others = zombiesInRoom(state, room);
      current = others.length > 0 ? pick(state.rng, others) : undefined;
    }
  }

  const targetName = zombieDef(target.def).name;
  log(
    state,
    hits === 0
      ? `${hero.name} rate ${targetName} (${rolls.join(', ')})`
      : `${hero.name} touche ${hits} fois (${rolls.join(', ')})${killed.length > 0 ? ` — ${killed.length} victime${killed.length > 1 ? 's' : ''}` : ''}`
  );

  return { ok: true, hits, killed };
}

function creditKill(state: CzState, hero: HeroState, zombie: ZombieState): void {
  const def = zombieDef(zombie.def);
  const ability = heroDef(hero.heroId).ability;
  hero.kills += 1;
  // Karim's bounty and the Chasseur perk: score only, never power.
  hero.killPoints += def.points + (ability === 'trophy' ? 1 : 0) + (hero.loadout.includes('chasseur') ? 1 : 0);
  state.killsTotal += 1;
  if (def.boss) {
    state.bossKills += 1;
    hero.bossKills += 1;
    // Viktor drinks to the fallen giant.
    if (ability === 'grim' && hero.hp < hero.maxHp) {
      hero.hp = Math.min(hero.maxHp, hero.hp + 10);
      log(state, `${hero.name} reprend des forces sur la carcasse (+10 PV)`);
    }
    log(state, `${hero.name} a abattu ${def.name} !`);
  }
  updateObjectives(state);
}

/**
 * One zombie attack on the heroes in its room.
 *
 * The victim is random among those present. A worn vest eats the whole attack and
 * is destroyed; Yuri shrugs one point off the first wound of each enemy phase.
 */
export function resolveZombieAttack(state: CzState, zombie: ZombieState): void {
  const victims = Object.values(state.heroes).filter(
    (hero) => hero.alive && !hero.escaped && hero.roomId === zombie.roomId
  );
  const victim = victims.length > 0 ? pick(state.rng, victims) : undefined;
  if (!victim) return;

  const def = zombieDef(zombie.def);
  let damage = def.damage + zombie.bonusDmg;
  const flags = (victim.raidFlags ??= {});

  // The dodge: one whole attack of the raid, sidestepped.
  if (victim.loadout.includes('esquive') && !flags.esquive) {
    flags.esquive = true;
    log(state, `${victim.name} esquive ${def.name} !`);
    return;
  }

  const vestIndex = victim.gear.findIndex((item) => item && itemDef(item.def).gear?.vest);
  const vest = vestIndex === -1 ? null : victim.gear[vestIndex as 0 | 1];
  if (vest) {
    // Omar's craft: once per raid, the plate holds and costs nothing.
    if (heroDef(victim.heroId).ability === 'bulwark' && !flags.bulwark) {
      flags.bulwark = true;
      log(state, `Le gilet renforcé d'${victim.name} tient bon (${def.name})`);
      return;
    }

    // A good plate holds more than once: that is what an epic vest is *for*.
    const charges = vestCharges(itemDef(vest.def), vest.rarity);
    vest.spent = (vest.spent ?? 0) + 1;
    const left = charges - vest.spent;
    if (left <= 0) {
      victim.gear[vestIndex as 0 | 1] = null;
      log(state, `Le gilet de ${victim.name} encaisse ${def.name} et rend l’âme`);
    } else {
      log(state, `Le gilet de ${victim.name} encaisse ${def.name} (${left} impact${left > 1 ? 's' : ''} encore)`);
    }
    return;
  }

  if (heroDef(victim.heroId).ability === 'tough' && !victim.toughUsed) {
    victim.toughUsed = true;
    damage = Math.max(0, damage - 10);
    if (damage === 0) {
      log(state, `${victim.name} encaisse ${def.name} sans broncher`);
      return;
    }
  }

  // Coriace: the raid's first wound loses 10, once.
  if (victim.loadout.includes('coriace') && !flags.coriace) {
    flags.coriace = true;
    damage = Math.max(0, damage - 10);
    if (damage === 0) {
      log(state, `${victim.name} serre les dents (${def.name})`);
      return;
    }
  }

  victim.hp -= damage;
  victim.damageTaken += damage;
  // The scavenger lord feeds on pain: one budget point per wound landed.
  if (state.config.mode === 'gm' && state.config.gmClass === 'charognard') {
    state.gmBudget += 1;
  }
  log(state, `${def.name} blesse ${victim.name} (-${damage} PV)`);

  if (victim.hp <= 0) {
    // Second wind: one refusal per raid, down to a sliver, and the collapse
    // costs whatever action points were left. It buys the next turn to run or
    // heal — it does not buy this one.
    if (victim.perks.includes('second-wind') && !victim.secondWindUsed) {
      victim.secondWindUsed = true;
      victim.hp = 10;
      victim.ap = 0;
      log(state, `${victim.name} refuse de tomber (second souffle) !`);
      return;
    }
    victim.alive = false;
    log(state, `${victim.name} est tombé.`);
  }
}
