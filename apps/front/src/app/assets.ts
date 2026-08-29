import type { LobbyGame } from 'lobby-core';

/**
 * Every path into `public/games/`, in one file.
 *
 * The art used to be addressed by string literals spread across the board
 * renderer, the sprite table and three components, which is why the folders
 * could not be reorganised without a grep-and-pray. They are built here instead:
 * the layout is documented in `public/games/README.md` and known to nothing else.
 *
 * Every one of these may 404, deliberately. Art arrives one commission at a time,
 * and each caller falls back to an emoji or a painted placeholder, so a missing
 * file costs a face rather than a screen.
 */

const ROOT = '/games';

export function gameRoot(game: LobbyGame): string {
  return `${ROOT}/${game}`;
}

/** The game's wordmark, for a menu header or a guide. */
export function gameLogo(game: LobbyGame): string {
  return `${ROOT}/${game}/logo.svg`;
}

/* ------------------------------------------------------------------ CoronaZ */

export function czEnemySprite(file: string): string {
  return `${ROOT}/coronaz/enemies/${file}`;
}

export function czItemSprite(file: string): string {
  return `${ROOT}/coronaz/items/${file}`;
}

export function czTerrain(file: string): string {
  return `${ROOT}/coronaz/terrain/${file}`;
}

export function czIso(file: string): string {
  return `${ROOT}/coronaz/iso/${file}`;
}

export function czIsoManifest(): string {
  return `${ROOT}/coronaz/iso/manifest.json`;
}

export function czHeroPortrait(heroId: string): string {
  return `${ROOT}/coronaz/heroes/${heroId}.jpg`;
}

/**
 * A bought outfit, worn over whichever survivor you drew.
 *
 * Flat rather than filed per hero on purpose: a wardrobe you can only wear when
 * the auto-seating happens to give you Charles is a wardrobe nobody buys from.
 */
export function czSkin(skinId: string): string {
  return `${ROOT}/coronaz/skins/${skinId}.png`;
}

/* -------------------------------------------------------------------- Mafia */

export function mafiaRolePortrait(roleId: string): string {
  return `${ROOT}/mafia/roles/${roleId}.jpg`;
}

export function mafiaSkin(skinId: string): string {
  return `${ROOT}/mafia/skins/${skinId}.png`;
}

/* --------------------------------------------------------------------- Quiz */

export function quizCover(file: string): string {
  return `${ROOT}/quiz/covers/${file}`;
}
