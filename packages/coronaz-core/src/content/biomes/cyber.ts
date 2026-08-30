import type { BiomeDef } from '../biome.js';

/**
 * The city after the grid came back up: chrome, arcologies, and what the clinics
 * left behind.
 *
 * The second biome, and the reason the whole role-and-archetype layer was built —
 * it had exactly one entry until now, which meant every raid used the same twelve
 * weapons and the same nine creatures, and that was the single largest source of
 * "we have seen this" after three evenings. The infrastructure was finished and
 * unused.
 *
 * What identity is allowed to be, and what it is not:
 *
 * - **Names, faces and fiction**: freely. That is most of what a world is.
 * - **The dice-against-damage split**: within the role's power budget, which a test
 *   holds to ±15 %. A shock rod that hits twice for seven is a different weapon to
 *   swing than a bat that hits once for fourteen, and neither is stronger.
 * - **Reach, `pierce`, `akimbo` and `noisy`**: deliberately *identical* to the
 *   reference biome, role for role. These are the four properties `expectedDamage`
 *   cannot see, so varying them would be a power change the power test would wave
 *   through — a quieter arsenal against a horde that homes in on noise is simply a
 *   better arsenal, and a rifle with one more room of reach is a straight upgrade.
 *   The place to spend those is a role, for every world at once.
 * - **Stats**: never. Hit points, damage, cost and points all come from the
 *   archetype, because the threat curve is the spine of the whole balance.
 */
export const cyber: BiomeDef = {
  id: 'cyber',
  name: 'coronaz.biome.cyber.name',
  blurb: 'coronaz.biome.cyber.blurb',

  items: {
    club: {
      id: 'shockrod',
      name: 'coronaz.thing.shockrod',
      emoji: '🔌',
      // Two taps of seven where the bat swings once for fourteen: same budget,
      // and it clears a pair of husks the bat has to hit twice for.
      weapon: { range: 0, dice: 2, damage: 7, accuracy: 1, melee: true, akimbo: false, noisy: false }
    },
    blade: {
      id: 'monoblade',
      name: 'coronaz.thing.monoblade',
      emoji: '⚔️',
      weapon: { range: 0, dice: 2, damage: 12, accuracy: 1, melee: true, akimbo: true, noisy: false }
    },
    pick: {
      id: 'railspike',
      name: 'coronaz.thing.railspike',
      emoji: '🪛',
      weapon: { range: 0, dice: 1, damage: 22, accuracy: 1, melee: true, akimbo: false, noisy: false, pierce: true }
    },
    saw: {
      id: 'plasmacutter',
      name: 'coronaz.thing.plasmacutter',
      emoji: '🔥',
      // Two cuts of eighteen against the chainsaw's one of thirty-six: the same
      // heavy melee slot, spent on a crowd instead of on a carapace.
      weapon: { range: 0, dice: 2, damage: 18, accuracy: 1, melee: true, akimbo: false, noisy: true, pierce: true }
    },
    sidearm: {
      id: 'holdout',
      name: 'coronaz.thing.holdout',
      emoji: '🔫',
      weapon: { range: 1, dice: 3, damage: 11, accuracy: 1, melee: false, akimbo: true, noisy: true }
    },
    scatter: {
      id: 'flechette',
      name: 'coronaz.thing.flechette',
      emoji: '🪡',
      weapon: { range: 1, dice: 2, damage: 17, accuracy: 1, melee: false, akimbo: false, noisy: true }
    },
    smg: {
      id: 'smartgun',
      name: 'coronaz.thing.smartgun',
      emoji: '🎛️',
      weapon: { range: 1, dice: 4, damage: 12, accuracy: 1, melee: false, akimbo: true, noisy: true }
    },
    rifle: {
      id: 'pulserifle',
      name: 'coronaz.thing.pulserifle',
      emoji: '⚡',
      weapon: { range: 2, dice: 3, damage: 15, accuracy: 1, melee: false, akimbo: false, noisy: true }
    },
    magnum: {
      id: 'handcannon',
      name: 'coronaz.thing.handcannon',
      emoji: '💢',
      weapon: { range: 2, dice: 2, damage: 28, accuracy: 1, melee: false, akimbo: false, noisy: true, pierce: true }
    },
    marksman: {
      id: 'railgun',
      name: 'coronaz.thing.railgun',
      emoji: '🛰️',
      weapon: { range: 3, dice: 1, damage: 58, accuracy: 1, melee: false, akimbo: false, noisy: true, pierce: true }
    },
    flamer: {
      id: 'arcthrower',
      name: 'coronaz.thing.arcthrower',
      emoji: '🌩️',
      weapon: { range: 1, dice: 2, damage: 35, accuracy: 1, melee: false, akimbo: false, noisy: true }
    },
    chaingun: {
      id: 'rotarylaser',
      name: 'coronaz.thing.rotarylaser',
      emoji: '🔆',
      weapon: { range: 1, dice: 6, damage: 12, accuracy: 1, melee: false, akimbo: false, noisy: true }
    },

    vest: { id: 'weave', name: 'coronaz.thing.weave', emoji: '🧵', gear: { armor: 3 } },
    torch: { id: 'optics', name: 'coronaz.thing.optics', emoji: '🥽', gear: { flashlight: true } },
    medkit: { id: 'nanogel', name: 'coronaz.thing.nanogel', emoji: '🧪', gear: { heal: 18 } },
    stim: { id: 'combatstim', name: 'coronaz.thing.combatstim', emoji: '🧬', gear: { adrenaline: 2 } }
  },

  zombies: {
    walker: { id: 'husk', name: 'coronaz.thing.husk', emoji: '🧟' },
    runner: { id: 'chaser', name: 'coronaz.thing.chaser', emoji: '🏃' },
    horror: { id: 'splicer', name: 'coronaz.thing.splicer', emoji: '👺' },
    fatty: { id: 'bloater', name: 'coronaz.thing.bloater', emoji: '🛢️' },
    mutant: { id: 'chimera', name: 'coronaz.thing.chimera', emoji: '👹' },
    screamer: { id: 'broadcaster', name: 'coronaz.thing.broadcaster', emoji: '📡' },
    brute: { id: 'enforcer', name: 'coronaz.thing.enforcer', emoji: '🤖' },
    colossus: { id: 'juggernaut', name: 'coronaz.thing.juggernaut', emoji: '🦾' },
    abomination: { id: 'singularity', name: 'coronaz.thing.singularity', emoji: '☣️' }
  },

  /**
   * The same building programmes as the reference world, minus the church.
   *
   * Layouts are orthogonal to biomes on purpose, so this list is about what the
   * *fiction* wants standing in it rather than about floor plans. Everything here
   * reads as well in chrome as in brick — a hospital is a clinic, a police station
   * is a precinct — and dropping one entry is enough to make a district drawn in
   * this world land differently from the same layout drawn in the other.
   */
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
    'spine'
  ]
};
