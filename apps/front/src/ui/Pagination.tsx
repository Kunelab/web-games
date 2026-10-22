import { msg } from 'i18n';
import type { RefObject } from 'react';

import { useT } from '../i18n/locale-context';
import { Button } from '../ui';

/**
 * The pages to offer by number: the ends, and the neighbours of the current one.
 *
 * A gap of a single page is filled with that page rather than an ellipsis, since
 * "…" standing for exactly one number is a button hidden for no saving.
 */
function pageWindow(page: number, count: number): (number | null)[] {
  const wanted = [...new Set([0, count - 1, page - 1, page, page + 1])]
    .filter((candidate) => candidate >= 0 && candidate < count)
    .sort((a, b) => a - b);

  const shown: (number | null)[] = [];
  let previous: number | null = null;
  for (const candidate of wanted) {
    if (previous !== null && candidate - previous === 2) shown.push(previous + 1);
    else if (previous !== null && candidate - previous > 2) shown.push(null);
    shown.push(candidate);
    previous = candidate;
  }
  return shown;
}

/**
 * Pages under a list, and nothing at all when there is only one.
 *
 * `anchor` is the list itself. The pager sits below it, so turning the page from
 * here would leave the reader at the bottom of rows they have not read; the list
 * is brought back into view when its top has scrolled away.
 */
export function Pagination({
  page,
  pageCount,
  start,
  shown,
  total,
  onPage,
  anchor
}: {
  page: number;
  pageCount: number;
  start: number;
  /** Rows on this page. */
  shown: number;
  total: number;
  onPage: (page: number) => void;
  anchor?: RefObject<HTMLElement | null>;
}) {
  const t = useT();
  if (pageCount <= 1) return null;

  function go(next: number) {
    onPage(next);
    const top = anchor?.current?.getBoundingClientRect().top;
    if (top !== undefined && top < 0) anchor?.current?.scrollIntoView({ block: 'start' });
  }

  return (
    <nav className="pager" aria-label={t(msg('pager.label'))}>
      <span className="pager-range tabular">
        {t(msg('pager.range', { from: start + 1, to: start + shown, total }))}
      </span>
      <span className="pager-pages">
        <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => go(page - 1)}>
          {t(msg('pager.prev'))}
        </Button>
        {pageWindow(page, pageCount).map((candidate, index) =>
          candidate === null ? (
            <span key={`gap-${index}`} className="pager-gap" aria-hidden="true">
              …
            </span>
          ) : (
            <Button
              key={candidate}
              variant={candidate === page ? 'secondary' : 'ghost'}
              size="sm"
              className="tabular"
              aria-label={t(msg('pager.page', { page: candidate + 1 }))}
              aria-current={candidate === page ? 'page' : undefined}
              onClick={() => go(candidate)}
            >
              {candidate + 1}
            </Button>
          )
        )}
        <Button variant="ghost" size="sm" disabled={page === pageCount - 1} onClick={() => go(page + 1)}>
          {t(msg('pager.next'))}
        </Button>
      </span>
    </nav>
  );
}
