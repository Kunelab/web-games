/**
 * The faces of the CoronaZ roguelite keys: an emoji, and the catalogue keys that
 * name and explain each one.
 *
 * Unknown keys degrade to a generic medal whose name is its own id — the
 * renderer prints a missing key rather than an empty span — so a new
 * server-side trophy never crashes a page.
 */

export const CZ_TROPHY_EMOJI: Record<string, string> = {
  'first-raid': '🩸',
  'first-escape': '🚪',
  packrat: '🎒',
  'left-for-dead': '💀',
  blitz: '⚡',
  veteran: '🎖️',
  'boss-hunter': '🏹',
  hoarder: '📦',
  'centurion-z': '🪓',
  'dark-dabbler': '😈',
  hordemaster: '👑',
  breeder: '🧫',
  tyrant: '🏴'
};

export function czTrophyMeta(key: string): { emoji: string; titleKey: string; hintKey: string } {
  return {
    emoji: CZ_TROPHY_EMOJI[key] ?? '🏅',
    titleKey: `coronaz.trophy.${key}`,
    hintKey: `coronaz.trophy.${key}.hint`
  };
}

export const CZ_PERK_EMOJI: Record<string, string> = {
  'tough-skin': '❤️',
  'deep-pockets': '🎒',
  'second-wind': '🫁',
  sprinter: '👟',
  'boss-slayer': '🗡️',
  'lucky-find': '🍀',
  'dark-pact': '😈',
  overlord: '👑',
  breeder: '🧫',
  'iron-horde': '🛡️'
};

export function czPerkMeta(key: string): { emoji: string; labelKey: string } {
  return { emoji: CZ_PERK_EMOJI[key] ?? '✨', labelKey: `coronaz.perk.${key}` };
}
