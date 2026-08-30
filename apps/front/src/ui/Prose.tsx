import { msg } from 'i18n';
import { Fragment, type ReactNode } from 'react';

import { useT } from '../i18n/locale-context';

/**
 * One paragraph of explanation, with the two or three words that carry it in bold.
 *
 * The guides lean on emphasis — "**by day** … **by night**", "**the place you
 * took**" — and that emphasis is part of the sentence, not decoration around it:
 * which words are stressed changes between languages, and a translator who
 * cannot move them ends up bolding the wrong half. So the catalogue entry owns
 * its own `**markers**` and this resolves them.
 *
 * Deliberately not Markdown. Two asterisks and nothing else: a guide page has no
 * business rendering arbitrary markup, and a parser that only knows one rule
 * cannot be surprised by a stray underscore in a French sentence.
 */
export function Prose({ k, className }: { k: string; className?: string }) {
  const t = useT();
  return <p className={className}>{emphasise(t(msg(k)))}</p>;
}

/** Splits on `**…**`; odd segments are the emphasised ones. */
function emphasise(text: string): ReactNode[] {
  return text.split('**').map((part, index) =>
    index % 2 === 1 ? <strong key={index}>{part}</strong> : <Fragment key={index}>{part}</Fragment>
  );
}
