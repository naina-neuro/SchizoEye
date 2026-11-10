import assert from 'node:assert/strict';
import { after, test } from 'node:test';

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    getApiBase: () => 'https://api.example.test/',
    location: { search: '?token=integration-token' },
  },
});

const { ApiService } = await import('../public/api-service.js');
const originalFetch = globalThis.fetch;
const requests: Array<{ url: string; init?: RequestInit }> = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  requests.push({ url: String(input), init });
  return new Response('{}', { status: 200 });
}) as typeof fetch;

after(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as { window?: unknown }).window;
});

test('classification preserves endpoint, JSON shape, token, and cookie credentials', async () => {
  requests.length = 0;
  const features = { fv_fnum_mean: 12 };
  await ApiService.classifyFeatures(features);
  assert.equal(requests[0].url, 'https://api.example.test/classify');
  assert.equal(requests[0].init?.method, 'POST');
  assert.equal(requests[0].init?.credentials, 'include');
  assert.equal((requests[0].init?.headers as Record<string, string>)['X-Test-Token'], 'integration-token');
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { features });
});

test('session saving preserves the existing save_results request contract', async () => {
  requests.length = 0;
  const payload = { subject_id: 'Subject_01', features: { fv_fnum_mean: 12 } };
  await ApiService.saveResults(payload);
  assert.equal(requests[0].url, 'https://api.example.test/save_results');
  assert.equal(requests[0].init?.method, 'POST');
  assert.equal(requests[0].init?.credentials, 'include');
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), payload);
});

test('report generation and retrieval retain their existing paths and credentials', async () => {
  requests.length = 0;
  const payload = { patient: { id: 'Subject_01' } };
  await ApiService.generateReport(payload);
  await ApiService.getPdf('/sessions/session-id/pdf');
  assert.equal(requests[0].url, 'https://api.example.test/generate-report');
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), payload);
  assert.equal(requests[1].url, 'https://api.example.test/sessions/session-id/pdf');
  assert.equal(requests[1].init?.credentials, 'include');
  assert.equal((requests[1].init?.headers as Record<string, string>)['X-Test-Token'], 'integration-token');
});
