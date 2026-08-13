/** Longest title or playlist name the input schemas accept. */
const MAX_NAME_LENGTH = 200;

/** Matches a suffix this function itself produced, so copies do not stack. */
const COPY_SUFFIX = /\s*\(copie(?: \d+)?\)$/i;

/**
 * Names a duplicate.
 *
 * "Soirée 80" becomes "Soirée 80 (copie)", and duplicating that gives
 * "Soirée 80 (copie 2)" rather than "Soirée 80 (copie) (copie)", which is what
 * appending blindly produces and what makes a library of copies unreadable after
 * the second one.
 *
 * `taken` is whatever the caller already has, compared case-insensitively.
 * Nothing enforces uniqueness in the database, so this is about legibility rather
 * than correctness: a clash is untidy, not broken, which is why it gives up after
 * a hundred attempts instead of failing.
 */
export function copyName(original: string, taken: Iterable<string>): string {
  const base = original.replace(COPY_SUFFIX, '').trim() || original;
  const used = new Set([...taken].map((name) => name.toLowerCase()));

  for (let attempt = 1; attempt <= 100; attempt++) {
    const candidate = truncate(attempt === 1 ? `${base} (copie)` : `${base} (copie ${attempt})`);
    if (!used.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  return truncate(`${base} (copie)`);
}

/**
 * Trimmed from the base rather than the suffix, so a title already at the limit
 * still comes back marked as a copy instead of being rejected by the schema.
 */
function truncate(name: string): string {
  if (name.length <= MAX_NAME_LENGTH) {
    return name;
  }

  const suffix = COPY_SUFFIX.exec(name)?.[0] ?? '';
  return `${name.slice(0, MAX_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`;
}
