import { apiFetch } from './client.ts';
import type { AnalyticsData } from '../types/session.ts';

/** Thrown when the server answered but reported failure (original text: "Error: <server error>"). */
export class AnalyticsServerError extends Error {}

/** GET /analytics. Any other thrown error is a transport/parse failure (original: "Failed to load analytics: <msg>"). */
export async function fetchAnalytics(): Promise<AnalyticsData> {
  const r = await apiFetch(`/analytics?_=${Date.now()}`, { cache: 'no-store' });
  const d = await r.json();
  if (!d.success) throw new AnalyticsServerError(d.error);
  return d as AnalyticsData;
}
