// Single place that decides which Flask backend the React app talks to.
// Same rule as public/config.js: window.SCHIZOEYE_API_BASE > (optional VITE_API_BASE) > localhost:5000 on localhost > production Render URL.
// NOTE: public/config.js (used only by battery.html) is a separate copy of this rule — change both if the backend URL ever changes.

export const PRODUCTION_API_BASE = 'https://schizoeyeclassification.onrender.com';
export const LOCAL_API_BASE = 'http://localhost:5000';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function resolveApiBase(opts: { windowOverride?: string; envOverride?: string; hostname?: string }): string {
  const local = opts.hostname === 'localhost' || opts.hostname === '127.0.0.1';
  const base = opts.windowOverride || opts.envOverride || (local ? LOCAL_API_BASE : PRODUCTION_API_BASE);
  return base.replace(/\/$/, '');
}

export function getApiBase(): string {
  const w = typeof window !== 'undefined' ? (window as unknown as { SCHIZOEYE_API_BASE?: string; location?: Location }) : undefined;
  const env = (import.meta as unknown as { env?: { VITE_API_BASE?: string } }).env;
  return resolveApiBase({
    windowOverride: w?.SCHIZOEYE_API_BASE,
    envOverride: env?.VITE_API_BASE,
    hostname: w?.location?.hostname,
  });
}

export const apiUrl = (path: string): string => `${getApiBase()}${path}`;

/** fetch against the Flask API. Always sends the session cookie (credentials: 'include'), as login/logout/save already did. */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(apiUrl(path), { credentials: 'include', ...init });
}
