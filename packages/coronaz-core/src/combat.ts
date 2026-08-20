import { roleOf } from './content/registry.js';
import {
  heroDef,
  itemDef,
  gearArmor,
  weaponStats,
  zombieDef,
  type ItemDef,
  type Rarity,
  type WeaponStats
} from './data.js';
import { dropFromKill } from './loot.js';
import { lineOfSight } from './map.js';
import { d6, pick } from './rng.js';
import {
  log,
  updateObjectives,
  zombiesInRoom,
  type CzState,
  type HeroState,
  type ItemInstance,
  type ZombieState
} from './state.js';

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
  /** What the last corpse dropped, if anything, so the phone can offer it. */
  loot?: ItemInstance;
}

/**
 * What Yuri's interception is worth: the ten points his old ability took off a
 * wound, spent on the wound he chose to take instead of the first one that landed.
 */
export const SHIELD_RELIEF = 10;

/**
 * What `endurci` is worth, in the same units as a vest: about a rare plate.
 *
 * Two rather than five, because the reduction lands on *every* wound and a walker
 * hits for ten — five would halve the commonest attack in the game for the price of
 * one of two global picks, which is a good deal past the point of being a choice.
 */
export const TOUGHENED_ARMOR = 2;

/**
 * Bernard's fallback: fists count as a weapon nobody can loot.
 *
 * Exported because the phone has to draw his reach too. It was private, which
 * would have left the screen that highlights what a tap can hit restating these
 * numbers — the one kind of duplication this codebase spends most of its effort
 * avoiding, since a screen that disagrees with the server about reach is worse
 * than a screen that says nothing at all.
 */
export const BARE_HANDS: ItemDef = {
  id: '__fists',
  name: 'Poings',
  kind: 'weapon',
  tier: 1,
  emoji: '👊',
  weapon: { range: 0, dice: 1, damage: 10, accuracy: 1, melee: true, akimbo: false, noisy: false }
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
  /**
   * Charles's and Johanna's dice used to be added here, and they are gone.
   *
   * Their abilities were rewritten into a held shot and a refund on clearing a
   * room, and leaving the old bonuses in place would have handed each of them
   * *both* — a straight power increase smuggled in under a redesign, and precisely
   * the kind of thing the difficulty ladder cannot absorb quietly. The whole point
   * of the rewrite was that the budget does not move.
   */
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

  /**
   * Every die connects.
   *
   * Weapons all carry accuracy 1, so there is no roll to lose: an attack's whole
   * question is how many dice you brought. The dice are still *drawn* from the
   * seeded stream, deliberately — a raid's luck has to stay reproducible from its
   * seed, and silently skipping draws would make every saved seed replay
   * differently from the day it was played.
   */
  const rolls: number[] = [];
  for (let i = 0; i < dice; i++) rolls.push(d6(state.rng));
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
  let dropped: ItemInstance | null = null;
  let current: ZombieState | undefined = target;

  /**
   * Armour, applied per hit and not per attack.
   *
   * This is the whole reason a heavy weapon exists. Six dice of 12 against a
   * colossus (armour 9) deliver 3 apiece; one shot of 58 with `pierce` meets 4 and
   * delivers 54. A hit always lands for at least 1, so armour makes a weapon a bad
   * answer, never a useless one, and a survivor holding nothing but a bat can still
   * chip a boss down rather than stand there doing literally nothing.
   */
  const bite = (zombie: ZombieState): number => {
    const armor = zombieDef(zombie.def).armor;
    const shield = weapon.pierce ? Math.floor(armor / 2) : armor;
    return Math.max(1, weapon.damage - shield);
  };

  for (let hit = 0; hit < hits && current; hit++) {
    current.hp -= bite(current);
    if (current.hp <= 0) {
      killed.push(current.id);
      creditKill(state, hero, current);
      // The corpse pays: a room of zombies is now worth clearing, not just surviving.
      const spoils = dropFromKill(state, hero, current.def);
      if (spoils) {
        dropped = spoils;
        log(state, `${hero.name} ramasse ${itemDef(spoils.def).name} sur la carcasse`);
      }
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
      ? `${hero.name} n'atteint pas ${targetName}`
      : `${hero.name} touche ${hits} fois ${targetName}${killed.length > 0 ? ` — ${killed.length} victime${killed.length > 1 ? 's' : ''}` : ''}`
  );

  return { ok: true, hits, killed, loot: dropped ?? undefined };
}

function creditKill(state: CzState, hero: HeroState, zombie: ZombieState): void {
  const def = zombieDef(zombie.def);
  const ability = heroDef(hero.heroId).ability;
  hero.kills += 1;
  // Karim's bounty and the Chasseur perk: score only, never power.
  // Karim's trophies. The `chasseur` perk that used to add a second point here is
  // gone: it moved a number on a screen nobody reads until the raid is over, which
  // is the one thing the perk pass was about removing.
  hero.killPoints += def.points + (ability === 'trophy' ? 1 : 0);
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
 * The victim is random among those present, with two thumbs on the scale: `fantome`
 * pushes a survivor towards the back of the queue, and Yuri steps in front of
 * whoever was picked. A worn plate eats the whole attack once, for Omar.
 */
export function resolveZombieAttack(state: CzState, zombie: ZombieState): void {
  const present = Object.values(state.heroes).filter(
    (hero) => hero.alive && !hero.escaped && !hero.forfeited && hero.roomId === zombie.roomId
  );
  if (present.length === 0) return;

  /**
   * `fantome`: the horde looks past you, while somebody steadier is standing there.
   *
   * It replaced `sang-froid`, which was `vigor` with a different emoji — the same
   * "+10 PV max", printed twice in a pool of eighteen. Worth about the same hit
   * points across a raid, and *positional*: it does nothing at all alone in a room,
   * which is its price, and it makes standing together a tactic.
   *
   * The health condition is not decoration, and the bench is why. Skipping the
   * holder unconditionally cost nine points of win rate against an aggressive game
   * master — the same trap Yuri's shield fell into, from the other direction.
   * Redirecting damage *concentrates* it, and concentration kills: a party of three
   * where one seat is untouchable is a party of two absorbing everything, and a dead
   * survivor contributes nothing while a wounded one still does. Sparing the holder
   * only while somebody healthier is there to take it means the perk can never move
   * a wound onto the person closer to dying of it.
   */
  const healthiest = Math.max(...present.map((hero) => hero.hp));
  const exposed = present.filter((hero) => !hero.loadout.includes('fantome') || hero.hp >= healthiest);
  const pool = exposed.length > 0 ? exposed : present;

  let victim = pick(state.rng, pool);

  /**
   * Yuri steps in front. The one ability in the game that reads as an act.
   *
   * "The first wound of each enemy phase is reduced by 10" was a number, spent
   * silently, that nobody at the table could ever see working. This is the same
   * budget — once a phase, ten points off — spent on *whose* wound it is instead,
   * which is the verb a co-operative game wants.
   *
   * Both bounds are load-bearing, and the bench is why. The first draft intercepted
   * every hit he could survive, and it cost eight points of win rate against an
   * aggressive game master: concentrating a phase's damage onto one survivor is
   * strictly worse than spreading it, because a dead hero stops contributing while a
   * wounded one does not. A shield that kills its holder protects nobody. So it
   * fires once a phase (the same `toughUsed` flag as before), it takes ten points
   * off what it intercepts, and it never triggers on a blow he could not walk away
   * from.
   */
  let intercepted = false;
  if (!victim.toughUsed || heroDef(victim.heroId).ability !== 'tough') {
    const shield = present.find(
      (hero) =>
        hero.playerId !== victim.playerId && heroDef(hero.heroId).ability === 'tough' && !hero.toughUsed
    );
    if (shield) {
      const incoming = Math.max(1, zombieDef(zombie.def).damage + zombie.bonusDmg - SHIELD_RELIEF);
      if (shield.hp > incoming) {
        log(state, `${shield.name} s’interpose devant ${victim.name}`);
        shield.toughUsed = true;
        victim = shield;
        intercepted = true;
      }
    }
  }

  const def = zombieDef(zombie.def);
  let damage = def.damage + zombie.bonusDmg;
  const flags = (victim.raidFlags ??= {});

  // The dodge: one whole attack of the raid, sidestepped.
  if (victim.loadout.includes('esquive') && !flags.esquive) {
    flags.esquive = true;
    log(state, `${victim.name} esquive ${def.name} !`);
    return;
  }

  /**
   * The plate. Best one worn, not the sum of both: two legendary vests would
   * otherwise shrug off half the bestiary outright.
   *
   * `endurci` joins the same `max()` rather than adding on top, for exactly that
   * reason — it is a thin plate a survivor brought instead of one they found, and a
   * perk that stacked with a legendary vest would be doing something no two vests
   * are allowed to do between them.
   */
  const armor = Math.max(
    0,
    victim.loadout.includes('endurci') ? TOUGHENED_ARMOR : 0,
    ...victim.gear.map((item) => (item ? gearArmor(itemDef(item.def), item.rarity) : 0))
  );
  if (armor > 0) {
    // Omar's craft: once per raid, the plate holds the whole thing.
    if (heroDef(victim.heroId).ability === 'bulwark' && !flags.bulwark) {
      flags.bulwark = true;
      log(state, `Le gilet renforcé de ${victim.name} tient bon (${def.name})`);
      return;
    }
    damage = Math.max(1, damage - armor);
  }

  // Taking it on purpose hurts less than being caught by it: the ten points his
  // old ability shaved off a wound, now spent on the wound he chose to take.
  if (intercepted) damage = Math.max(1, damage - SHIELD_RELIEF);

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
