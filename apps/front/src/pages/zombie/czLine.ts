import type { Msg, Translate } from 'i18n';

/**
 * One line of the raid log, whichever half of the migration it comes from.
 *
 * CoronaZ's log is the last surface still written as prose: most entries are
 * French sentences the engine composed, and the ones that have been localised
 * arrive as keys. Rather than convert nine hundred lines of narration in one go,
 * `LogEntry.text` accepts both and this renders whichever it is handed — so a
 * line becomes translatable the day somebody keys it, with no change here.
 */
export function czLine(text: string | Msg, t: Translate): string {
  return typeof text === 'string' ? text : t(text);
}
