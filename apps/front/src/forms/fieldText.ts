import { msg, type Msg } from 'i18n';

/**
 * A field's own words, whoever wrote them.
 *
 * The media-kind definitions supply catalogue keys now, but a row saved before
 * they did still carries the French inline — and an answer's `label` in
 * particular is *data*, editable by whoever wrote the question, and always has
 * been. So a value that looks like one of our keys gets translated and anything
 * else is printed exactly as typed, which is the only rule that serves both.
 *
 * In its own file rather than beside the form that uses it: a module that
 * exports both components and helpers loses fast refresh for the whole file.
 */
export function fieldText(t: (message: Msg) => string, value: string | undefined): string {
  if (!value) return '';
  return value.startsWith('field.') ? t(msg(value)) : value;
}
