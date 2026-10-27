/**
 * A work's name as a room is asked for it: without the brackets at its end.
 *
 * The model names works the way Wikipedia titles its pages, "Drive (film,
 * 2011)", "Les Muppets (série télévisée, 1976)", or with a translation, "Les
 * Soprano (The Sopranos)". Nobody types the brackets, the reveal reads like a
 * disambiguation page, and the catalogue's own names stop matching the seeds
 * they came from: "The Big Bang Theory (série télévisée)" is not "The Big Bang
 * Theory" to anything that compares names.
 *
 * So the value loses its last bracket, and what it said is kept where the
 * answer check still finds it: the whole old name always, and the bracket's
 * text too when it is another name for the work rather than a note about it.
 */

/** A bracket that describes the work instead of naming it. */
const QUALIFIER =
  /^(?:\d{4}(?:\s*[-–]\s*\d{4})?|.*\b(?:film|films|série|series|serie|saison|season|téléfilm|tv|jeu vidéo|video game|anime|remake|arc|part|partie|cour|ova|oav|movie|vol\.?|volume)\b.*)$/i;

/** A trailing bracket: "Name (Something)". */
const TRAILING = /^(.*\S)\s*\(([^()]+)\)\s*$/;

export function cleanWorkName(value: string, aliases: readonly string[]): { value: string; aliases: string[] } {
  const match = TRAILING.exec(value);
  if (!match) return { value, aliases: [...aliases] };
  const name = match[1].trim();
  const inside = match[2].trim();
  const extra = [value, ...(QUALIFIER.test(inside) ? [] : [inside])];
  const seen = new Set([name.toLowerCase()]);
  const kept: string[] = [];
  for (const alias of [...aliases, ...extra]) {
    const key = alias.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(alias.trim());
  }
  return { value: name, aliases: kept };
}
