import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveApiBase, getApiBase, PRODUCTION_API_BASE } from '../src/api/client.ts';
import { login, logout } from '../src/api/auth.ts';
import { fetchSessions, sessionPdfUrl, sessionCsvUrl, exportAllFeaturesUrl } from '../src/api/sessions.ts';
import { saveNotes } from '../src/api/notes.ts';
import { fetchAnalytics, AnalyticsServerError } from '../src/api/analytics.ts';

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
const realFetch = globalThis.fetch;
const g = globalThis as unknown as Record<string, unknown>;
function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  g.fetch = async (url: string, init: RequestInit = {}) => { calls.push({ url, init }); return handler(url, init); };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => { calls = []; delete g.window; });
afterEach(() => { g.fetch = realFetch; delete g.window; });

test('API base resolution matches public/config.js rules', () => {
  assert.equal(resolveApiBase({ hostname: 'naina-schizo.netlify.app' }), PRODUCTION_API_BASE);
  assert.equal(resolveApiBase({ hostname: 'localhost' }), 'http://localhost:5000');
  assert.equal(resolveApiBase({ hostname: '127.0.0.1' }), 'http://localhost:5000');
  assert.equal(resolveApiBase({ hostname: 'localhost', windowOverride: 'https://x.example/' }), 'https://x.example');
  assert.equal(resolveApiBase({ hostname: 'localhost', envOverride: 'http://dev:9/' }), 'http://dev:9');
  assert.equal(PRODUCTION_API_BASE, 'https://schizoeyeclassification.onrender.com');
  g.window = { location: { hostname: 'localhost' } };
  assert.equal(getApiBase(), 'http://localhost:5000');
});

test('login: request shape and success response', async () => {
  mockFetch(() => json({ success: true, role: 'doctor', username: 'doctor' }));
  const r = await login('doctor', 'pw');
  assert.deepEqual(r, { ok: true, username: 'doctor', role: 'doctor' });
  assert.equal(calls[0].url, `${PRODUCTION_API_BASE}/login`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'include');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { username: 'doctor', password: 'pw' });
  assert.equal((calls[0].init.headers as Record<string, string>)['Content-Type'], 'application/json');
});

test('login: 401 shows server error; missing error uses fallback; network failure message', async () => {
  mockFetch(() => json({ success: false, error: 'Invalid credentials' }, 401));
  assert.deepEqual(await login('a', 'b'), { ok: false, error: 'Invalid credentials', network: false });
  mockFetch(() => json({ success: false }, 401));
  assert.equal((await login('a', 'b') as { error: string }).error, 'Login failed. Check credentials.');
  mockFetch(() => { throw new TypeError('Failed to fetch'); });
  const n = await login('a', 'b');
  assert.deepEqual(n, { ok: false, error: 'Unable to reach the server. Check your connection and try again.', network: true });
});

test('logout: POST with credentials; failure returns false instead of throwing', async () => {
  mockFetch(() => json({ success: true }));
  assert.equal(await logout(), true);
  assert.equal(calls[0].url, `${PRODUCTION_API_BASE}/logout`);
  assert.equal(calls[0].init.credentials, 'include');
  mockFetch(() => json({}, 500));
  assert.equal(await logout(), false);
  mockFetch(() => { throw new Error('down'); });
  assert.equal(await logout(), false);
});

test('fetchSessions: accepts {sessions}, bare array; errors for HTTP failure / unexpected shape; credentials sent', async () => {
  const rows = [{ id: '1' }];
  mockFetch(() => json({ success: true, sessions: rows }));
  assert.deepEqual(await fetchSessions(), rows);
  assert.match(calls[0].url, /\/sessions\?_=\d+$/);
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[0].init.cache, 'no-store');
  mockFetch(() => json(rows));
  assert.deepEqual(await fetchSessions(), rows);
  mockFetch(() => json({ success: false, error: 'Database not connected' }, 503));
  await assert.rejects(fetchSessions(), /Database not connected/);
  mockFetch(() => new Response('<html>', { status: 502 }));
  await assert.rejects(fetchSessions(), /HTTP 502/);
  mockFetch(() => json({ success: true }));
  await assert.rejects(fetchSessions(), /Unexpected sessions response/);
});

test('download URLs match the Flask routes', () => {
  assert.equal(sessionPdfUrl('abc'), `${PRODUCTION_API_BASE}/sessions/abc/pdf`);
  assert.equal(sessionCsvUrl('abc', 'spem'), `${PRODUCTION_API_BASE}/sessions/abc/csv/spem`);
  assert.equal(exportAllFeaturesUrl(), `${PRODUCTION_API_BASE}/sessions/export_all_features`);
});

test('saveNotes: payload {notes, author}; success and both failure messages', async () => {
  mockFetch(() => json({ success: true }));
  assert.deepEqual(await saveNotes('s1', 'hello', 'doctor'), { ok: true });
  assert.equal(calls[0].url, `${PRODUCTION_API_BASE}/sessions/s1/notes`);
  assert.equal(calls[0].init.credentials, 'include');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { notes: 'hello', author: 'doctor' });
  mockFetch(() => json({ success: false, error: 'Session not found' }, 404));
  assert.deepEqual(await saveNotes('s1', 'x', 'd'), { ok: false, message: '⚠ Save failed: Session not found' });
  mockFetch(() => json({ success: false }, 500));
  assert.deepEqual(await saveNotes('s1', 'x', 'd'), { ok: false, message: '⚠ Save failed: Unknown error' });
  mockFetch(() => { throw new Error('offline'); });
  assert.deepEqual(await saveNotes('s1', 'x', 'd'), { ok: false, message: '⚠ Network error: offline' });
});

test('fetchAnalytics: success returns data; server failure → AnalyticsServerError; transport failure propagates', async () => {
  const data = { success: true, total_sessions: 1, daily_counts: [], panss_distribution: [], gender_distribution: {}, age_distribution: [], feature_averages: {} };
  mockFetch(() => json(data));
  assert.deepEqual(await fetchAnalytics(), data);
  assert.equal(calls[0].init.credentials, 'include');
  mockFetch(() => json({ success: false, error: 'Database not connected' }, 503));
  await assert.rejects(fetchAnalytics(), (e: unknown) => e instanceof AnalyticsServerError && e.message === 'Database not connected');
  mockFetch(() => { throw new Error('boom'); });
  await assert.rejects(fetchAnalytics(), (e: unknown) => !(e instanceof AnalyticsServerError) && (e as Error).message === 'boom');
});
