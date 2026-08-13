import { createContext } from 'react';

import type { AuthUser } from '../api/client';

export interface AuthValue {
  user: AuthUser | null;
  /** False until the session probe has answered, so guards do not flash. */
  loaded: boolean;
  setUser: (user: AuthUser | null) => void;
}

/**
 * The context alone, in a file of its own.
 *
 * Splitting it from the provider and the hook is what keeps fast refresh working:
 * a module that exports a component alongside anything else is replaced wholesale
 * on edit rather than hot-swapped, which throws away the state of everything under
 * it. Three small files, and an edit to the provider no longer logs you out.
 */
export const AuthContext = createContext<AuthValue | null>(null);
