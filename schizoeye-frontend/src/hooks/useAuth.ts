import { useCallback, useState } from 'react';
import { login, logout } from '../api/auth.ts';
import type { LoginResult } from '../api/auth.ts';
import { clearStoredAuth, readStoredAuth, storeAuth } from '../lib/authStorage.ts';
import type { AuthUser } from '../types/session.ts';

/**
 * Login state. Restoring from localStorage is display-only (see lib/authStorage.ts) — it does not prove the
 * Flask session is still valid, exactly like the original page. Real authorization must be enforced by Flask.
 */
export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(() => readStoredAuth(window.localStorage));

  const signIn = useCallback(async (username: string, password: string): Promise<LoginResult> => {
    const r = await login(username, password);
    if (r.ok) {
      const u = { username: r.username, role: r.role };
      storeAuth(window.localStorage, u);
      setUser(u);
    }
    return r;
  }, []);

  const signOut = useCallback(async () => {
    await logout(); // failure is logged inside; local sign-out always proceeds
    clearStoredAuth(window.localStorage);
    setUser(null);
  }, []);

  return { user, signIn, signOut };
}
