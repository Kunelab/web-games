import { msg, type Msg } from 'i18n';

/**
 * Prefixes that mark a string as one of ours rather than one of theirs.
 *
 * `field.` names an authoring field, `ans.` an answer's stock prompt, `miss.`
 * a fragment of what a media item still lacks. Matching on a prefix rather than
 * on "looks like a dotted key" is deliberate: a host is perfectly entitled to
 * label an answer `2001: A Space Odyssey`, and guessing would translate it into
 * its own name.
 */
const KEY_PREFIXES = ['field.', 'ans.', 'miss.'];

/**
 * A field's own words, whoever wrote them.
 *
 * The media-kind definitions supply catalogue keys now, but a row saved before
 * they did still carries the French inline — and an answer's `label` in
 * particular is *data*, editable by whoever wrote the question, and always has
 * been. So a value that looks like one of our keys gets translated and anything
 * else is printed exactly as typed, which is the only rule that serves both.
 *
 * This is not only the editor's business. The same `label` is read out on the
 * television as a prompt, printed over a player's answer box and listed in the
 * library, and every one of those places showed a bare `field.title` until they
 * came through here.
 *
 * In its own file rather than beside the form that uses it: a module that
 * exports both components and helpers loses fast refresh for the whole file.
 */
export function fieldText(t: (message: Msg) => string, value: string | undefined): string {
  if (!value) return '';
  return KEY_PREFIXES.some((prefix) => value.startsWith(prefix)) ? t(msg(value)) : value;
}
