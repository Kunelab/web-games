/**
 * Is this id one the table lists, and so one whose catalogue keys are checked?
 *
 * Every face table in `app/` (awards, quiz and Mafia badges, CoronaZ trophies
 * and perks, media kinds) takes an id that arrives as a plain string, off the
 * wire or out of the database, and has to decide between its own entry and the
 * generic fallback. Six private guards each spelled that decision out the same
 * way; this is the one they now share.
 *
 * `Object.hasOwn` rather than `in`: an id is data, and `toString` or
 * `constructor` is a perfectly good id for a server to send, which `in` would
 * find on every plain object by inheritance and hand back a function as an
 * emoji.
 *
 * The narrowing is the point. Once `key` is one of the table's own keys, a
 * `msg` built from `award.${key}` at the call site is checked against the
 * catalogue for every entry, and only the other branch needs `msgOf`. That split
 * stays with each caller, because the catalogue prefix is a literal only the
 * caller knows.
 */
export function hasKey<T extends object>(table: T, key: string): key is Extract<keyof T, string> {
  return Object.hasOwn(table, key);
}
