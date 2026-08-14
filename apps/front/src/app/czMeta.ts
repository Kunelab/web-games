/**
 * French faces of the CoronaZ roguelite keys. Unknown keys degrade to a generic
 * medal, so a new server-side trophy never crashes a page.
 */

export const CZ_TROPHY_META: Record<string, { emoji: string; title: string; hint: string }> = {
  'first-raid': { emoji: '🩸', title: 'Premier raid', hint: 'Jouer une partie de CoronaZ' },
  'first-escape': { emoji: '🚪', title: 'Évadé', hint: 'Gagner un raid' },
  packrat: { emoji: '🎒', title: 'Rat de cave', hint: '25 fouilles' },
  'left-for-dead': { emoji: '💀', title: 'Laissé pour mort', hint: 'Tomber 5 fois' },
  blitz: { emoji: '⚡', title: 'Blitz', hint: 'Gagner une évasion en 8 tours ou moins' },
  veteran: { emoji: '🎖️', title: 'Vétéran', hint: '20 raids' },
  'boss-hunter': { emoji: '🏹', title: 'Chasseur de boss', hint: 'Abattre 10 boss' },
  hoarder: { emoji: '📦', title: 'Accumulateur', hint: '100 fouilles' },
  'centurion-z': { emoji: '🪓', title: 'Centurion Z', hint: '100 victimes' },
  'dark-dabbler': { emoji: '😈', title: 'Initié des ténèbres', hint: 'Mener la horde une fois' },
  hordemaster: { emoji: '👑', title: 'Maître de horde', hint: '3 victoires comme MJ' },
  breeder: { emoji: '🧫', title: 'Éleveur', hint: '100 invocations' },
  tyrant: { emoji: '🏴', title: 'Tyran', hint: '10 victoires comme MJ' }
};

export function czTrophyMeta(key: string): { emoji: string; title: string; hint: string } {
  return CZ_TROPHY_META[key] ?? { emoji: '🏅', title: key, hint: '' };
}

export const CZ_PERK_META: Record<string, { emoji: string; label: string }> = {
  'tough-skin': { emoji: '❤️', label: 'Peau dure · +1 PV max' },
  'deep-pockets': { emoji: '🎒', label: 'Grandes poches · +1 place de sac' },
  'second-wind': { emoji: '🫁', label: 'Second souffle · survit à 1 PV, une fois par raid' },
  sprinter: { emoji: '👟', label: 'Sprinteur · +1 PA au premier tour' },
  'boss-slayer': { emoji: '🗡️', label: 'Tueur de boss · +1 dé contre les boss' },
  'lucky-find': { emoji: '🍀', label: 'Trouvaille · première fouille rarité 3+' },
  'dark-pact': { emoji: '😈', label: 'Pacte sombre · +4 de budget initial' },
  overlord: { emoji: '👑', label: 'Seigneur · +2 de revenu par tour' },
  breeder: { emoji: '🧫', label: 'Éleveur · première invocation du tour à -1' },
  'iron-horde': { emoji: '🛡️', label: 'Horde de fer · Carapace niv. 1 à moitié prix' }
};

export function czPerkMeta(key: string): { emoji: string; label: string } {
  return CZ_PERK_META[key] ?? { emoji: '✨', label: key };
}
