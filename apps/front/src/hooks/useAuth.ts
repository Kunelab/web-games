import { useContext } from 'react';

import { AuthContext, type AuthValue } from './auth-context';

export function useAuth(): AuthValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return context;
}
