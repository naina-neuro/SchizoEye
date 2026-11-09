import type { AuthUser } from '../types/session.ts';

// Same keys the original index.html used, so a login in the old page or in battery tabs stays compatible.
const USER_KEY = 'currentUser';
const ROLE_KEY = 'currentRole';

type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Display identity only. This is NOT authorization: anyone can edit localStorage, and Flask currently never
 * checks the session (see the Stage-1 auth findings). Kept identical to the original behaviour on purpose.
 */
export function readStoredAuth(store: KV): AuthUser | null {
  const username = store.getItem(USER_KEY);
  const role = store.getItem(ROLE_KEY);
  return username && role ? { username, role } : null;
}
export function storeAuth(store: KV, u: AuthUser): void {
  store.setItem(USER_KEY, u.username);
  store.setItem(ROLE_KEY, u.role);
}
export function clearStoredAuth(store: KV): void {
  store.removeItem(USER_KEY);
  store.removeItem(ROLE_KEY);
}
