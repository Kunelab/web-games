import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../api/client';

export interface AsyncState<T> {
  data: T | undefined;
  loading: boolean;
  error: string | null;
  /** Re-runs the loader. */
  reload: () => void;
  /** Replaces the data locally, for optimistic updates. */
  set: (next: T) => void;
}

/**
 * Loads something once and on demand.
 *
 * Small on purpose: a query library would be a reasonable choice at a larger scale,
 * but every screen here loads one or two lists, and this keeps the loading and error
 * states explicit rather than implicit. Crucially it tracks whether the component is
 * still mounted, which the old pages did not — every one of them could set state
 * after unmount.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  });

  useEffect(() => {
    let cancelled = false;
    // Starting a fetch is the external-system case an effect exists for, and the
    // loading flag has to flip as the request starts rather than a render later.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);

    loaderRef
      .current()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof ApiError ? cause.message : 'Le chargement a échoué.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  const set = useCallback((next: T) => setData(next), []);

  return { data, loading, error, reload, set };
}
