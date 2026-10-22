import { msg, type MsgKey } from 'i18n';

import type { GeneratedFilter } from '../api/client';
import { useT } from '../i18n/locale-context';
import { Chip } from '../ui';

const CHOICES: { value: GeneratedFilter; label: MsgKey }[] = [
  { value: 'include', label: 'lib.generated.include' },
  { value: 'exclude', label: 'lib.generated.exclude' },
  { value: 'only', label: 'lib.generated.only' }
];

/**
 * In, out, or nothing else: the rows the endless blind test generated.
 *
 * Shown to an admin only, the one reader whose lists hold them. They arrive by
 * the thousand, every round a room plays is filed among them, and a library
 * that is mostly somebody else's catalogue is hard to tidy and harder to build
 * a quiz from. Three chips rather than a switch, because "only those" is the
 * view a curator wants as often as "none of those".
 */
export function GeneratedFilterChips({
  value,
  onChange
}: {
  value: GeneratedFilter;
  onChange: (next: GeneratedFilter) => void;
}) {
  const t = useT();
  return (
    <div className="filters" role="group" aria-label={t(msg('lib.generated.label'))}>
      <span className="filters-label">{t(msg('lib.generated.label'))}</span>
      {CHOICES.map((choice) => (
        <Chip key={choice.value} active={value === choice.value} onClick={() => onChange(choice.value)}>
          {t(msg(choice.label))}
        </Chip>
      ))}
    </div>
  );
}
