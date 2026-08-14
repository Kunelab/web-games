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
  name: 'Moderne',
  blurb: 'Le monde de la semaine dernière : pavillons, bureaux, boîtes de nuit, rues.',

  items: {
    club: {
      id: 'bat',
      name: 'Batte de baseball',
      emoji: '🏏',
      weapon: { range: 0, dice: 1, damage: 10, accuracy: 3, melee: true, akimbo: false, noisy: false }
    },
    blade: {
      id: 'machete',
      name: 'Machette',
      emoji: '🔪',
      weapon: { range: 0, dice: 1, damage: 20, accuracy: 3, melee: true, akimbo: true, noisy: false }
    },
    pick: {
      id: 'pickaxe',
      name: 'Pioche',
      emoji: '⛏️',
      weapon: { range: 0, dice: 1, damage: 10, accuracy: 2, melee: true, akimbo: false, noisy: false }
    },
    saw: {
      id: 'chainsaw',
      name: 'Tronçonneuse',
      emoji: '🪚',
      weapon: { range: 0, dice: 1, damage: 40, accuracy: 2, melee: true, akimbo: false, noisy: true }
    },
    sidearm: {
      id: 'pistol',
      name: 'Pistolet',
      emoji: '🔫',
      weapon: { range: 1, dice: 2, damage: 10, accuracy: 4, melee: false, akimbo: true, noisy: true }
    },
    scatter: {
      id: 'shotgun',
      name: 'Fusil à pompe',
      emoji: '💥',
      weapon: { range: 1, dice: 2, damage: 20, accuracy: 4, melee: false, akimbo: false, noisy: true }
    },
    smg: {
      id: 'p90',
      name: 'P-90',
      emoji: '🔫',
      weapon: { range: 1, dice: 4, damage: 10, accuracy: 2, melee: false, akimbo: true, noisy: true }
    },
    rifle: {
      id: 'ak47',
      name: 'AK-47',
      emoji: '🔫',
      weapon: { range: 2, dice: 3, damage: 20, accuracy: 4, melee: false, akimbo: false, noisy: true }
    },
    magnum: {
      id: 'deagle',
      name: 'Desert Eagle',
      emoji: '🔫',
      weapon: { range: 2, dice: 1, damage: 40, accuracy: 3, melee: false, akimbo: false, noisy: true }
    },
    marksman: {
      id: 'sniper',
      name: 'Sniper',
      emoji: '🎯',
      weapon: { range: 3, dice: 1, damage: 30, accuracy: 3, melee: false, akimbo: false, noisy: true }
    },
    flamer: {
      id: 'flamethrower',
      name: 'Lance-flammes',
      emoji: '🔥',
      weapon: { range: 1, dice: 1, damage: 100, accuracy: 1, melee: false, akimbo: false, noisy: true }
    },
    chaingun: {
      id: 'minigun',
      name: 'Minigun',
      emoji: '⚙️',
      weapon: { range: 1, dice: 5, damage: 10, accuracy: 3, melee: false, akimbo: false, noisy: true }
    },

    vest: { id: 'vest', name: 'Gilet pare-balles', emoji: '🦺', gear: { vest: true } },
    torch: { id: 'flashlight', name: 'Lampe torche', emoji: '🔦', gear: { flashlight: true } },
    medkit: { id: 'medkit', name: 'Kit de soin', emoji: '💊', gear: { heal: 20 } },
    stim: { id: 'adrenaline', name: 'Adrénaline', emoji: '💉', gear: { adrenaline: 2 } }
  },

  zombies: {
    walker: { id: 'walker', name: 'Zombie', emoji: '🧟' },
    runner: { id: 'runner', name: 'Coureur', emoji: '🏃' },
    horror: { id: 'horror', name: 'Horreur', emoji: '👺' },
    fatty: { id: 'fatty', name: 'Gras', emoji: '🧟‍♂️' },
    mutant: { id: 'mutant', name: 'Mutant', emoji: '👹' },
    screamer: { id: 'screamer', name: 'Hurleuse', emoji: '🗣️' },
    brute: { id: 'brute', name: 'Brute', emoji: '🦍' },
    colossus: { id: 'boss', name: 'Colosse', emoji: '💀' },
    abomination: { id: 'abomination', name: 'Abomination', emoji: '👿' }
  },

  buildings: ['house', 'flats', 'offices', 'club', 'shop', 'workshop', 'facility']
};
