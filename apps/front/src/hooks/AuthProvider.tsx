import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { api, onUnauthorized, type AuthUser } from '../api/client';
import { AuthContext, type AuthValue } from './auth-context';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    api
      .me()
      .then((result) => {
        if (!cancelled) setUser(result);
      })
      .catch(() => {
        // A failed probe means anonymous, not broken.
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // One place reacts to an expired session, rather than every request deciding
  // to navigate. The old axios interceptor redirected from inside the request,
  // which is what made the login page reload in a loop.
  useEffect(() => onUnauthorized(() => setUser(null)), []);

  const value = useMemo<AuthValue>(() => ({ user, loaded, setUser: (next) => setUser(next) }), [user, loaded]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
