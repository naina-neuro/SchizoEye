import { apiFetch } from './client.ts';

export type LoginResult =
  | { ok: true; username: string; role: string }
  | { ok: false; error: string; network: boolean };

/** POST /login → { success, role, username } | 401 { success:false, error }. Messages match the original doLogin(). */
export async function login(username: string, password: string): Promise<LoginResult> {
  try {
    const resp = await apiFetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await resp.json();
    if (data.success) return { ok: true, username: data.username, role: data.role };
    return { ok: false, error: data.error || 'Login failed. Check credentials.', network: false };
  } catch (e) {
    console.error('[login] request failed', e);
    return { ok: false, error: 'Unable to reach the server. Check your connection and try again.', network: true };
  }
}

/** POST /logout. Failure is logged but never blocks the local sign-out (same as the original doLogout()). */
export async function logout(): Promise<boolean> {
  try {
    const r = await apiFetch('/logout', { method: 'POST' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return true;
  } catch (e) {
    console.error('[logout] request failed', e);
    return false;
  }
}
