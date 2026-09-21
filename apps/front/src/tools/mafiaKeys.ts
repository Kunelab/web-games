/**
 * Where the Mafia table keeps its things, and the one-time move that got it
 * there.
 *
 * Mafia predates the `kune.` prefix and kept its own `mafia:token:ABC12` shape,
 * which was harmless right up until anything wanted to look across all three
 * games at once — the seat index in `tools/seats` being the first. Rather than
 * teach every reader two conventions, the keys were renamed and the old ones
 * are carried over on first load.
 *
 * The migration matters more than a rename usually would: these keys hold the
 * token that proves which seat is yours. Dropping them would take the seat away
 * from anyone mid-game when the new build reached their phone, which for a
 * Mafia player means being unable to act rather than merely being inconvenienced.
 */

export const mafiaKeys = {
  token: (code: string) => `kune.mafia.player.${code}`,
  name: (code: string) => `kune.mafia.player.${code}.name`,
  host: (code: string) => `kune.mafia.host.${code}`,
  spoilers: (code: string) => `kune.mafia.tv.spoilers.${code}`,
  zoom: 'kune.mafia.zoom',
  points: 'kune.mafia.points'
} as const;

/**
 * `mafia:token:ABC12` and friends, as they were written before the rename.
 *
 * Both stores are scanned with the same table. `mafia:host:` only ever existed
 * in `sessionStorage` and the rest only in `localStorage`, but saying so here
 * would buy nothing: a scan that finds no such key simply does nothing.
 */
const LEGACY: { from: RegExp; to: (code: string) => string }[] = [
  { from: /^mafia:token:(.+)$/, to: mafiaKeys.token },
  { from: /^mafia:name:(.+)$/, to: mafiaKeys.name },
  { from: /^mafia:host:(.+)$/, to: mafiaKeys.host },
  { from: /^mafia:tv:spoilers:(.+)$/, to: mafiaKeys.spoilers },
  { from: /^mafia:zoom$/, to: () => mafiaKeys.zoom },
  { from: /^mafia:points$/, to: () => mafiaKeys.points }
];

function move(store: Storage, from: string, to: string): void {
  const value = store.getItem(from);
  // An existing new-style value wins: it was written by this build, so it is
  // the fresher of the two and re-running the migration must not undo it.
  if (value !== null && store.getItem(to) === null) store.setItem(to, value);
  store.removeItem(from);
}

/** Run once, as early as possible, before any screen reads a token. */
export function migrateMafiaKeys(): void {
  for (const store of [localStorage, sessionStorage]) {
    try {
      // Collected first: removing keys while iterating `store.key(i)` reindexes
      // the store underneath the loop and skips every other entry.
      const names: string[] = [];
      for (let i = 0; i < store.length; i += 1) {
        const name = store.key(i);
        if (name !== null && name.startsWith('mafia:')) names.push(name);
      }

      for (const name of names) {
        for (const { from, to } of LEGACY) {
          const match = from.exec(name);
          if (match) {
            move(store, name, to(match[1]));
            break;
          }
        }
      }
    } catch {
      // Storage refused. Nothing to migrate, and nothing that can be done.
    }
  }
}
