import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveZombieAttack } from './combat.js';
import { gameConfigSchema } from './config.js';
import { HERO_GLOBAL_PERKS, HERO_LOADOUT_PERKS, HEROES, heroDef } from './data.js';
import { itemFor } from './content/registry.js';
import { activateNextZombie, applyGmAction, applyHeroAction, beginEnemyPhase, startGame } from './engine.js';
import { shortestPath } from './map.js';
import { createGame, joinHero, makeItem, spawnZombie, visibleRooms, type CzState, type HeroState } from './state.js';

/**
 * The five rewritten abilities, and the perks that replaced the duplicates.
 *
 * These are worth testing rather than reading because each one is a *verb* now,
 * and a verb has an off state, an on state and a boundary between them — where a
 * "+1 die" had none and could only really be wrong by being absent. Two of the
 * bugs these caught were live: Charles and Johanna kept their old dice bonuses
 * *alongside* their new abilities, which was a silent power increase smuggled in
 * under a redesign, and Chuck's extra find recomputed itself into an unlimited
 * supply.
 */

function raid(heroIds: string[], overrides: Record<string, unknown> = {}) {
  const state = createGame({
    code: 'TEST',
    hostToken: 'h',
    gmToken: 'g',
    hostUserId: null,
    // The biome is pinned: these tests are about abilities, and a rolled arsenal
    // changes every weapon's dice-versus-damage split under them. The cyber plasma
    // cutter throws two dice where the chainsaw throws one, which is enough to clear
    // a room the fixture meant to leave occupied — that is correct content and a
    // broken test.
    config: gameConfigSchema.parse({
      startingZombies: 0,
      secondaryObjectives: 0,
      events: false,
      biome: 'modern',
      ...overrides
    }),
    seed: 909
  });
  // Seat everybody first, then assign the characters: auto-seating draws from the
  // base roster, and half the roster under test is unlockable.
  const heroes: HeroState[] = [];
  for (let seat = 0; seat < heroIds.length; seat++) {
    const { hero } = joinHero(state, `H${seat}`, undefined);
    heroes.push(hero);
  }
  heroIds.forEach((heroId, index) => {
    const hero = heroes[index];
    if (hero) hero.heroId = heroId;
  });
  startGame(state, 0);
  return { state, heroes };
}

/** Arms a hero with a specific role, in a specific hand. */
function arm(state: CzState, hero: HeroState, role: Parameters<typeof itemFor>[1], hand: 0 | 1 = 0): void {
  hero.hands[hand] = makeItem(state, itemFor(state.config.biome, role).id, 5);
}

describe('the perk pool has no duplicates left', () => {
  it('no two perks describe the same effect', () => {
    // Three pairs used to: vigor/sang-froid ("+10 PV max"), soigneur/trousse (a
    // medkit), arme/couteau (the off hand). A pool where two entries are
    // indistinguishable is a pool with two fewer entries and a bug.
    const effects = HERO_LOADOUT_PERKS.map((perk) => perk.label.split('·')[1]?.trim() ?? perk.label);
    assert.equal(new Set(effects).size, effects.length, `duplicate effect in: ${effects.join(' | ')}`);
  });

  it('at most two perks are "start holding something"', () => {
    const kits = HERO_LOADOUT_PERKS.filter((perk) => /commence avec/.test(perk.label));
    assert.ok(kits.length <= 2, `${kits.length} of ${HERO_LOADOUT_PERKS.length} are starting kits`);
  });

  it('every signature perk is on somebody, and every global is pickable', () => {
    const onSomebody = new Set(HEROES.flatMap((hero) => hero.personalPerks));
    const known = new Set(HERO_LOADOUT_PERKS.map((perk) => perk.id));

    for (const id of onSomebody) assert.ok(known.has(id), `${id} is on a character but not in the pool`);
    for (const id of HERO_GLOBAL_PERKS) assert.ok(known.has(id), `${id} is pickable but not in the pool`);

    // Nothing in the pool is unreachable: a perk nobody can ever pick is dead code
    // that reads like content.
    for (const perk of HERO_LOADOUT_PERKS) {
      assert.ok(
        onSomebody.has(perk.id) || HERO_GLOBAL_PERKS.includes(perk.id),
        `${perk.id} cannot be picked by anybody`
      );
    }
  });
});

describe('Charles holds a shot', () => {
  it('an unspent point becomes overwatch, and the first thing into his sights eats it', () => {
    const { state, heroes } = raid(['charles']);
    const charles = heroes[0];
    assert.ok(charles);
    arm(state, charles, 'marksman');

    // Somewhere down a straight line from him, two rooms off.
    const target = state.board.rooms.find(
      (room) => room.id !== charles.roomId && (shortestPath(state.board, charles.roomId, room.id)?.length ?? 99) === 2
    );
    assert.ok(target, 'the fixture has nowhere two rooms away');
    const zombie = spawnZombie(state, target.id, 'walker');
    assert.ok(zombie);

    charles.ap = 2;
    applyHeroAction(state, charles.playerId, { type: 'ready' });
    assert.equal(charles.overwatch, true, 'a point in hand is a held shot');

    beginEnemyPhase(state, 0);
    const hpBefore = zombie.hp;
    activateNextZombie(state);

    const survivor = state.zombies[zombie.id];
    assert.ok(
      survivor === undefined || survivor.hp < hpBefore,
      'it walked towards him and nothing happened'
    );
    assert.equal(state.heroes[charles.playerId]?.overwatch, false, 'the held shot is spent');
  });

  it('no point in hand, no held shot', () => {
    const { state, heroes } = raid(['charles']);
    const charles = heroes[0];
    assert.ok(charles);
    charles.ap = 0;
    applyHeroAction(state, charles.playerId, { type: 'ready' });
    assert.notEqual(charles.overwatch, true);
  });

  it('he no longer gets his old ranged die as well', () => {
    // The bug this caught: the rewrite added the held shot and left `+1 die at
    // range` in the combat path, so he had both.
    const { state, heroes } = raid(['charles', 'rosa']);
    const [charles, plain] = heroes;
    assert.ok(charles && plain);
    // Same weapon, same rarity, and neither of them calls it a favourite.
    arm(state, charles, 'scatter');
    arm(state, plain, 'scatter');
    assert.notEqual(heroDef('charles').favoriteWeapon, 'scatter');
    assert.notEqual(heroDef('rosa').favoriteWeapon, 'scatter');

    const room = charles.roomId;
    plain.roomId = room;
    const a = spawnZombie(state, room, 'abomination');
    const b = spawnZombie(state, room, 'abomination');
    assert.ok(a && b);

    applyHeroAction(state, charles.playerId, { type: 'attack', zombieId: a.id, hand: 0 });
    applyHeroAction(state, plain.playerId, { type: 'attack', zombieId: b.id, hand: 0 });
    assert.equal(a.maxHp - a.hp, b.maxHp - b.hp, 'Charles is still throwing an extra die');
  });
});

describe('Johanna clears rooms', () => {
  it('emptying a room in melee refunds the point', () => {
    const { state, heroes } = raid(['johanna']);
    const johanna = heroes[0];
    assert.ok(johanna);
    arm(state, johanna, 'chaingun');

    const zombie = spawnZombie(state, johanna.roomId, 'walker');
    assert.ok(zombie);
    johanna.ap = 3;
    // A melee weapon, so the refund's own condition is met.
    arm(state, johanna, 'saw');

    applyHeroAction(state, johanna.playerId, { type: 'attack', zombieId: zombie.id, hand: 0 });
    assert.equal(state.zombies[zombie.id], undefined, 'the fixture failed to kill it');
    assert.equal(johanna.ap, 3, 'the room is clear, so the swing was free');
  });

  it('but not while something is still standing', () => {
    const { state, heroes } = raid(['johanna']);
    const johanna = heroes[0];
    assert.ok(johanna);
    arm(state, johanna, 'saw');

    const first = spawnZombie(state, johanna.roomId, 'walker');
    // An abomination, so no swing in the game can empty this room by accident.
    spawnZombie(state, johanna.roomId, 'abomination');
    assert.ok(first);
    johanna.ap = 3;

    applyHeroAction(state, johanna.playerId, { type: 'attack', zombieId: first.id, hand: 0 });
    assert.equal(johanna.ap, 2, 'a refund with the room still occupied');
  });

  it('and not at range: it is an execution, not a marksmanship bonus', () => {
    const { state, heroes } = raid(['johanna']);
    const johanna = heroes[0];
    assert.ok(johanna);
    arm(state, johanna, 'chaingun');

    const target = state.board.rooms.find(
      (room) => room.id !== johanna.roomId && (shortestPath(state.board, johanna.roomId, room.id)?.length ?? 99) === 1
    );
    assert.ok(target);
    const zombie = spawnZombie(state, target.id, 'walker');
    assert.ok(zombie);
    johanna.ap = 3;

    const outcome = applyHeroAction(state, johanna.playerId, { type: 'attack', zombieId: zombie.id, hand: 0 });
    if (outcome.ok && state.zombies[zombie.id] === undefined) {
      assert.equal(johanna.ap, 2, 'a ranged kill should not refund');
    }
  });
});

describe('Yuri steps in front', () => {
  it('takes a wound aimed at somebody sharing his room', () => {
    const { state, heroes } = raid(['yuri', 'rosa']);
    const [yuri, mate] = heroes;
    assert.ok(yuri && mate);
    mate.roomId = yuri.roomId;

    const zombie = spawnZombie(state, yuri.roomId, 'walker');
    assert.ok(zombie);
    beginEnemyPhase(state, 0);

    const mateHp = mate.hp;
    const yuriHp = yuri.hp;
    resolveZombieAttack(state, zombie);

    // Either he was the random pick anyway, or he intercepted; the mate must be
    // untouched in both cases.
    assert.equal(mate.hp, mateHp, 'the wound reached the person he was covering');
    assert.ok(yuri.hp < yuriHp, 'and somebody has to have taken it');
  });

  it('only once a phase, so a phase of damage cannot be concentrated on him', () => {
    /**
     * The bound the bench forced. Intercepting everything he could survive cost
     * eight points of win rate against an aggressive game master: piling a phase's
     * damage onto one survivor is strictly worse than spreading it, because a dead
     * hero contributes nothing and a wounded one still does.
     *
     * Asserted on the flag rather than on who bled. The victim is a random pick
     * among everyone present, so with two survivors in a room the roll picks Yuri
     * half the time anyway — a test that watched hit points would be measuring the
     * dice, not the rule.
     */
    const { state, heroes } = raid(['yuri', 'rosa']);
    const [yuri, mate] = heroes;
    assert.ok(yuri && mate);
    mate.roomId = yuri.roomId;

    const zombie = spawnZombie(state, yuri.roomId, 'walker');
    assert.ok(zombie);
    beginEnemyPhase(state, 0);
    assert.equal(yuri.toughUsed, false, 'a new phase re-arms him');

    // Enough swings that an unbounded shield would certainly have fired again.
    for (let attempt = 0; attempt < 20 && yuri.alive && mate.alive; attempt++) {
      resolveZombieAttack(state, zombie);
    }
    assert.equal(yuri.toughUsed, true, 'the interception is spent, once');
  });

  it('never takes a blow he could not walk away from', () => {
    const { state, heroes } = raid(['yuri', 'rosa']);
    const [yuri, mate] = heroes;
    assert.ok(yuri && mate);
    mate.roomId = yuri.roomId;
    yuri.hp = 5;

    const zombie = spawnZombie(state, yuri.roomId, 'abomination');
    assert.ok(zombie);
    beginEnemyPhase(state, 0);
    resolveZombieAttack(state, zombie);

    // He may still have been the random victim — that is the dice, not the shield.
    // What must never happen is him *choosing* a blow that kills him.
    assert.equal(yuri.toughUsed, false, 'he stepped in front of a blow that would kill him');
  });
});

describe('Nadia runs', () => {
  it('crosses two rooms for one point, and arrives loudly', () => {
    const { state, heroes } = raid(['nadia']);
    const nadia = heroes[0];
    assert.ok(nadia);

    const twoAway = state.board.rooms.find(
      (room) => (shortestPath(state.board, nadia.roomId, room.id)?.length ?? 99) === 2
    );
    assert.ok(twoAway, 'the fixture has nowhere two rooms away');

    nadia.ap = 3;
    const outcome = applyHeroAction(state, nadia.playerId, { type: 'move', roomId: twoAway.id });
    assert.equal(outcome.ok, true);
    assert.equal(nadia.roomId, twoAway.id);
    assert.equal(nadia.ap, 2, 'two rooms, one point');
    assert.ok((state.noise[twoAway.id] ?? 0) > 0, 'nobody sprints quietly');
  });

  it('cannot run through a wall: the second room has to be reachable', () => {
    const { state, heroes } = raid(['nadia']);
    const nadia = heroes[0];
    assert.ok(nadia);

    const far = state.board.rooms.find(
      (room) => (shortestPath(state.board, nadia.roomId, room.id)?.length ?? 0) > 2
    );
    assert.ok(far);
    nadia.ap = 3;
    assert.equal(applyHeroAction(state, nadia.playerId, { type: 'move', roomId: far.id }).ok, false);
  });

  it('anybody else is refused the same move', () => {
    const { state, heroes } = raid(['rosa']);
    const rosa = heroes[0];
    assert.ok(rosa);
    const twoAway = state.board.rooms.find(
      (room) => (shortestPath(state.board, rosa.roomId, room.id)?.length ?? 99) === 2
    );
    assert.ok(twoAway);
    rosa.ap = 3;
    assert.equal(applyHeroAction(state, rosa.playerId, { type: 'move', roomId: twoAway.id }).ok, false);
  });
});

describe('the game master walks a creature in one tap', () => {
  /**
   * A tap used to be worth exactly one room, so a runner with two points cost four
   * taps to walk — select, tap, select, tap — against thirty creatures and a
   * forty-five-second clock. Still one point per room; just not one tap per point.
   */
  function horde() {
    const state = createGame({
      code: 'TEST',
      hostToken: 'h',
      gmToken: 'g',
      hostUserId: null,
      config: gameConfigSchema.parse({ mode: 'gm', startingZombies: 0, events: false, biome: 'modern' }),
      seed: 909
    });
    joinHero(state, 'Proie', undefined);
    startGame(state, 0);
    applyHeroAction(state, Object.keys(state.heroes)[0] ?? '', { type: 'ready' });
    beginEnemyPhase(state, 0);
    return state;
  }

  it('spends one point per room crossed', () => {
    const state = horde();
    const start = state.board.rooms[0];
    assert.ok(start);
    const runner = spawnZombie(state, start.id, 'runner');
    runner.ap = 2;

    const twoAway = state.board.rooms.find(
      (room) => (shortestPath(state.board, start.id, room.id)?.length ?? 99) === 2
    );
    assert.ok(twoAway, 'the fixture has nowhere two rooms away');

    assert.equal(applyGmAction(state, { type: 'gmMove', zombieId: runner.id, roomId: twoAway.id }).ok, true);
    assert.equal(runner.roomId, twoAway.id);
    assert.equal(runner.ap, 0, 'two rooms should cost two points');
  });

  it('refuses a walk it cannot pay for, rather than truncating it', () => {
    // A horde that half-obeys is worse than one that says no: the game master has to
    // be able to trust where the piece will end up before letting go of the screen.
    const state = horde();
    const start = state.board.rooms[0];
    assert.ok(start);
    const walker = spawnZombie(state, start.id, 'walker');
    walker.ap = 1;

    const threeAway = state.board.rooms.find(
      (room) => (shortestPath(state.board, start.id, room.id)?.length ?? 99) === 3
    );
    assert.ok(threeAway);

    const refused = applyGmAction(state, { type: 'gmMove', zombieId: walker.id, roomId: threeAway.id });
    assert.equal(refused.ok, false);
    assert.equal(walker.roomId, start.id, 'the creature moved anyway');
    assert.equal(walker.ap, 1, 'and it was charged for it');
  });
});

describe('the perks that replaced the duplicates', () => {
  it('vigile lights the rooms next door, in full fog', () => {
    const { state, heroes } = raid(['rosa'], { fog: 'full' });
    const hero = heroes[0];
    assert.ok(hero);

    /**
     * Asked of every room on the board, not of one.
     *
     * The perk buys sight in *steps*, and line of sight is already unbounded along
     * a straight open run — so from any given room it may genuinely have nothing
     * left to reveal, and a fixture that happens to stand in one of those rooms
     * proves nothing either way. What has to be true is that it works *somewhere*,
     * which is exactly the claim that failed when this branch was measured: the
     * version that added the immediate neighbours revealed something new in 0 of
     * 185 rooms, because they were all visible already.
     */
    let gains = 0;
    for (const room of state.board.rooms) {
      hero.roomId = room.id;
      hero.loadout = [];
      const blind = visibleRooms(state).size;
      hero.loadout = ['vigile'];
      if (visibleRooms(state).size > blind) gains += 1;
    }
    assert.ok(gains > state.board.rooms.length / 4, `the perk lit something in only ${gains} rooms`);
  });

  it('serrurier makes a key free, and shows the door', () => {
    const { state, heroes } = raid(['ethan'], { fog: 'full', keys: 3 });
    const hero = heroes[0];
    assert.ok(hero);
    hero.loadout = ['serrurier'];

    const keyRoom = state.board.rooms.find((room) => room.hasKey);
    assert.ok(keyRoom);
    hero.roomId = keyRoom.id;
    hero.ap = 3;

    assert.equal(applyHeroAction(state, hero.playerId, { type: 'pickupKey' }).ok, true);
    assert.equal(hero.ap, 3, 'the key cost a point');
  });

  it('courrier hands things through a doorway', () => {
    const { state, heroes } = raid(['marco', 'rosa']);
    const [marco, mate] = heroes;
    assert.ok(marco && mate);
    marco.loadout = ['courrier'];

    const next = state.board.rooms.find(
      (room) => (shortestPath(state.board, marco.roomId, room.id)?.length ?? 99) === 1
    );
    assert.ok(next);
    mate.roomId = next.id;

    const parcel = makeItem(state, itemFor(state.config.biome, 'medkit').id);
    marco.bag.push(parcel);

    assert.equal(
      applyHeroAction(state, marco.playerId, { type: 'give', uid: parcel.uid, toPlayerId: mate.playerId }).ok,
      true
    );
    assert.ok(mate.bag.some((item) => item.uid === parcel.uid));
  });

  it('and without it, one room away is still too far', () => {
    const { state, heroes } = raid(['marco', 'rosa']);
    const [marco, mate] = heroes;
    assert.ok(marco && mate);
    marco.loadout = [];

    const next = state.board.rooms.find(
      (room) => (shortestPath(state.board, marco.roomId, room.id)?.length ?? 99) === 1
    );
    assert.ok(next);
    mate.roomId = next.id;

    const parcel = makeItem(state, itemFor(state.config.biome, 'medkit').id);
    marco.bag.push(parcel);
    assert.equal(
      applyHeroAction(state, marco.playerId, { type: 'give', uid: parcel.uid, toPlayerId: mate.playerId }).ok,
      false
    );
  });

  it('brocanteur turns a full bag into a swap instead of a refusal', () => {
    const { state, heroes } = raid(['rosa']);
    const hero = heroes[0];
    assert.ok(hero);
    hero.loadout = ['brocanteur'];
    hero.freeSearchUsed = true;
    hero.freeRaidSearchUsed = true;

    // Fill the bag with the worst thing in the game, and put the hero somewhere
    // with something left to find.
    const room = state.board.rooms.find((candidate) => candidate.id === hero.roomId);
    assert.ok(room);
    room.finds = 5;
    while (hero.bag.length < 5) hero.bag.push(makeItem(state, itemFor(state.config.biome, 'club').id, 1));
    const full = hero.bag.length;

    hero.ap = 3;
    const outcome = applyHeroAction(state, hero.playerId, { type: 'search' });
    assert.equal(outcome.ok, true, 'a full bag still refused the search');
    assert.equal(hero.bag.length, full, 'a swap keeps the bag the same size');
  });

  it('and without it a full bag is still a refusal', () => {
    const { state, heroes } = raid(['rosa']);
    const hero = heroes[0];
    assert.ok(hero);
    hero.loadout = [];
    while (hero.bag.length < 5) hero.bag.push(makeItem(state, itemFor(state.config.biome, 'club').id, 1));

    hero.ap = 3;
    assert.equal(applyHeroAction(state, hero.playerId, { type: 'search' }).ok, false);
  });

  it('elan pays for the first step into the dark, and only that', () => {
    const { state, heroes } = raid(['awa'], { fog: 'full' });
    const hero = heroes[0];
    assert.ok(hero);
    hero.loadout = ['elan'];
    hero.ap = 3;

    // Somewhere adjacent that nobody has seen.
    const unseen = state.board.rooms.find(
      (room) =>
        (shortestPath(state.board, hero.roomId, room.id)?.length ?? 99) === 1 && !state.explored.includes(room.id)
    );
    if (!unseen) return; // Awa's own ability may already have revealed everything nearby.

    const before = hero.ap;
    assert.equal(applyHeroAction(state, hero.playerId, { type: 'move', roomId: unseen.id }).ok, true);
    assert.equal(hero.ap, before, 'the step into the dark cost a point');
    assert.equal(hero.freeExploreUsed, true, 'and it should be spent for the turn');
  });
});
