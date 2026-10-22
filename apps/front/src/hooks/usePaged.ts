import { useState } from 'react';

/** Rows per page on the lists of media: enough to scan, few enough to render at once. */
export const PAGE_SIZE = 50;

/** Cards per page on the playlist shelves, which take a screen each at a dozen. */
export const CARD_PAGE_SIZE = 24;

export interface Paged<T> {
  /** Zero-based, and always a page that exists. */
  page: number;
  pageCount: number;
  /** Index of the first row shown, for numbering rows across pages. */
  start: number;
  pageItems: T[];
  total: number;
  setPage: (page: number) => void;
}

/**
 * One page of a list that is already in memory.
 *
 * The lists here are loaded whole and filtered in the browser, which stays cheap
 * well into the thousands; drawing them is what is not. The shared catalogue is
 * thousands of rows, and the playlist editor mounts a drag handle on every one.
 *
 * `resetKey` names the filters in force. A new one means a new list, and the
 * page goes back to the first, derived at render rather than reset by an effect
 * so the old page number never shows against the new rows. The page is clamped
 * too, so deleting the last row of the last page lands on the one before.
 */
export function usePaged<T>(items: readonly T[], pageSize: number = PAGE_SIZE, resetKey = ''): Paged<T> {
  const [state, setState] = useState({ key: resetKey, page: 0 });
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(state.key === resetKey ? state.page : 0, pageCount - 1);
  const start = page * pageSize;

  return {
    page,
    pageCount,
    start,
    pageItems: items.slice(start, start + pageSize),
    total: items.length,
    setPage: (next) => setState({ key: resetKey, page: Math.max(0, Math.min(next, pageCount - 1)) })
  };
}
