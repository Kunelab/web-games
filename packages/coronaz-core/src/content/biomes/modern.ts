import type { BiomeDef } from '../biome.js';

/**
 * The world as it was last week: houses, offices, a night club, a lock-up.
 *
 * The reference biome, and the one every number in the documentation was measured
 * on. Its arsenal is the 2020 table column for column (damage ×10) and its bestiary
 * is that table's stat block, so writing it out as a biome changed nothing about
 * the game — it only gave the roles and archetypes something to point at.
 */
export const modern: BiomeDef = {
  id: 'modern',
  name: 'coronaz.biome.modern.name',
  blurb: 'coronaz.biome.modern.blurb',

  items: {
    club: {
      id: 'bat',
      name: 'coronaz.thing.bat',
      emoji: '🏏',
      weapon: { range: 0, dice: 1, damage: 14, accuracy: 1, melee: true, akimbo: false, noisy: false }
    },
    blade: {
      id: 'machete',
      name: 'coronaz.thing.machete',
      emoji: '🔪',
      weapon: { range: 0, dice: 2, damage: 12, accuracy: 1, melee: true, akimbo: true, noisy: false }
    },
    pick: {
      id: 'pickaxe',
      name: 'coronaz.thing.pickaxe',
      emoji: '⛏️',
      weapon: { range: 0, dice: 1, damage: 22, accuracy: 1, melee: true, akimbo: false, noisy: false, pierce: true }
    },
    saw: {
      id: 'chainsaw',
      name: 'coronaz.thing.chainsaw',
      emoji: '🪚',
      weapon: { range: 0, dice: 1, damage: 36, accuracy: 1, melee: true, akimbo: false, noisy: true, pierce: true }
    },
    sidearm: {
      id: 'pistol',
      name: 'coronaz.thing.pistol',
      emoji: '🔫',
      weapon: { range: 1, dice: 3, damage: 11, accuracy: 1, melee: false, akimbo: true, noisy: true }
    },
    scatter: {
      id: 'shotgun',
      name: 'coronaz.thing.shotgun',
      emoji: '💥',
      weapon: { range: 1, dice: 2, damage: 17, accuracy: 1, melee: false, akimbo: false, noisy: true }
    },
    smg: {
      id: 'p90',
      name: 'coronaz.thing.p90',
      emoji: '🔫',
      weapon: { range: 1, dice: 4, damage: 12, accuracy: 1, melee: false, akimbo: true, noisy: true }
    },
    rifle: {
      id: 'ak47',
      name: 'coronaz.thing.ak47',
      emoji: '🔫',
      weapon: { range: 2, dice: 3, damage: 15, accuracy: 1, melee: false, akimbo: false, noisy: true }
    },
    magnum: {
      id: 'deagle',
      name: 'coronaz.thing.deagle',
      emoji: '🔫',
      weapon: { range: 2, dice: 1, damage: 56, accuracy: 1, melee: false, akimbo: false, noisy: true, pierce: true }
    },
    marksman: {
      id: 'sniper',
      name: 'coronaz.thing.sniper',
      emoji: '🎯',
      weapon: { range: 3, dice: 1, damage: 58, accuracy: 1, melee: false, akimbo: false, noisy: true, pierce: true }
    },
    flamer: {
      id: 'flamethrower',
      name: 'coronaz.thing.flamethrower',
      emoji: '🔥',
      weapon: { range: 1, dice: 2, damage: 35, accuracy: 1, melee: false, akimbo: false, noisy: true }
    },
    chaingun: {
      id: 'minigun',
      name: 'coronaz.thing.minigun',
      emoji: '⚙️',
      weapon: { range: 1, dice: 6, damage: 12, accuracy: 1, melee: false, akimbo: false, noisy: true }
    },

    vest: { id: 'vest', name: 'coronaz.thing.vest', emoji: '🦺', gear: { armor: 3 } },
    torch: { id: 'flashlight', name: 'coronaz.thing.flashlight', emoji: '🔦', gear: { flashlight: true } },
    medkit: { id: 'medkit', name: 'coronaz.thing.medkit', emoji: '💊', gear: { heal: 18 } },
    stim: { id: 'adrenaline', name: 'coronaz.thing.adrenaline', emoji: '💉', gear: { adrenaline: 2 } }
  },

  zombies: {
    walker: { id: 'walker', name: 'coronaz.thing.walker', emoji: '🧟' },
    runner: { id: 'runner', name: 'coronaz.thing.runner', emoji: '🏃' },
    horror: { id: 'horror', name: 'coronaz.thing.horror', emoji: '👺' },
    fatty: { id: 'fatty', name: 'coronaz.thing.fatty', emoji: '🧟‍♂️' },
    mutant: { id: 'mutant', name: 'coronaz.thing.mutant', emoji: '👹' },
    screamer: { id: 'screamer', name: 'coronaz.thing.screamer', emoji: '🗣️' },
    brute: { id: 'brute', name: 'coronaz.thing.brute', emoji: '🦍' },
    colossus: { id: 'boss', name: 'coronaz.thing.boss', emoji: '💀' },
    abomination: { id: 'abomination', name: 'coronaz.thing.abomination', emoji: '👿' }
  },

  buildings: [
    'house',
    'flats',
    'offices',
    'club',
    'shop',
    'workshop',
    'facility',
    'police',
    'hospital',
    'quarters',
    'firestation',
    'school',
    'supermarket',
    'church',
    'spine'
  ]
};
