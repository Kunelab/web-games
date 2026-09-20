import { useContext } from 'react';

import type { AuthUser } from '../api/client';
import { AuthContext, type AuthValue } from './auth-context';

export function useAuth(): AuthValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return context;
}

/**
 * Mirrors `isAdmin` in the API's `services/ownership.ts`.
 *
 * A screen asks this to *offer* what the server will allow, never to authorise:
 * every action behind it is checked again server-side against the role on the
 * session. Kept here rather than inlined per screen because the two-role test is
 * exactly the kind of thing that gets written once, copied, and then only half
 * updated when a third role appears.
 */
export function isAdmin(user: AuthUser | null | undefined): boolean {
  return user?.role === 'admin' || user?.role === 'super-admin';
}
