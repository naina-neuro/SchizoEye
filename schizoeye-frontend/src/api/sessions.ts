import { apiFetch, apiUrl } from './client.ts';
import type { CsvType, Session } from '../types/session.ts';

/** GET /sessions. Error handling mirrors the original loadSessions(). */
export async function fetchSessions(): Promise<Session[]> {
  const r = await apiFetch(`/sessions?_=${Date.now()}`, { cache: 'no-store' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  if (Array.isArray(d)) return d as Session[];
  if (Array.isArray(d.sessions)) return d.sessions as Session[];
  throw new Error(d.error || 'Unexpected sessions response');
}

// File downloads are plain navigations (window.open / <a>), exactly like the original dashboards.
export const sessionPdfUrl = (id: string): string => apiUrl(`/sessions/${id}/pdf`);
export const sessionCsvUrl = (id: string, type: CsvType): string => apiUrl(`/sessions/${id}/csv/${type}`);
export const exportAllFeaturesUrl = (): string => apiUrl('/sessions/export_all_features');
