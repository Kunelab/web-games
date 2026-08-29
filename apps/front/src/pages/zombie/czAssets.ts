import { czEnemySprite, czHeroPortrait, czItemSprite } from '../../app/assets';

/**
 * The 2020 repo's art, mapped onto today's roster. The sprites live under
 * `public/games/coronaz/` and ship with the frontend; anything without a sprite (the
 * two new consumables, the fists, every portrait) falls back to its emoji, so a
 * missing file is a cosmetic downgrade and never a broken screen.
 *
 * The board's own artwork is not here — it is painted, and its raster slots live
 * in `iso/art.ts`. This file is the flat sprites: creatures, items, faces.
 */

const ZOMBIE_SPRITES: Record<string, string> = {
  walker: 'zombie1.jpg',
  runner: 'runner2.jpg',
  horror: 'horror1.jpg',
  fatty: 'tank1.jpg',
  mutant: 'tank2.jpg',
  screamer: 'horror2.jpg',
  brute: 'runner1.jpg',
  boss: 'Boss1.jpg',
  abomination: 'Boss2.jpg'
};

const ITEM_SPRITES: Record<string, string> = {
  bat: 'bat.png',
  machete: 'machete.png',
  pickaxe: 'pickaxe.png',
  chainsaw: 'chainsaw.png',
  pistol: 'pistol.png',
  shotgun: 'shotgun.png',
  p90: 'p90.png',
  ak47: 'AK47.png',
  deagle: 'deagle.png',
  sniper: 'sniper.png',
  flamethrower: 'flamethrower.png',
  minigun: 'Minigun.png',
  vest: 'bulletproof_vest.png',
  flashlight: 'flashlight.png'
};

export function zombieSprite(def: string): string | null {
  const file = ZOMBIE_SPRITES[def];
  return file ? czEnemySprite(file) : null;
}

export function itemSprite(def: string): string | null {
  const file = ITEM_SPRITES[def];
  return file ? czItemSprite(file) : null;
}

/**
 * A hero's portrait, for the selection grid and the roster.
 *
 * Nothing is here yet — twenty of them is a real commission — so the component
 * that uses this falls back to the emoji medallion when the file 404s. Drop
 * `public/games/coronaz/heroes/charles.jpg` in and Charles has a face, with no code
 * change. See docs/coronaz-art.md for the size and framing.
 */
export function heroPortrait(heroId: string): string {
  return czHeroPortrait(heroId);
}

/**
 * A hero's medallion colour, stable per character. Twenty survivors and no
 * raster art yet: a big emoji on a hue-locked ring is the consistent face of the
 * roster until there is one.
 */
export function heroHue(heroId: string): number {
  let hash = 0;
  for (const char of heroId) hash = (hash * 131 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}
