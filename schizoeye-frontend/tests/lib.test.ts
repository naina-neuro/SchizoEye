import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FEATURE_ORDER } from '../src/types/featureOrder.ts';
import { panssBins, ageBins, summaryStats } from '../src/lib/analytics.ts';
import { REPORT_GROUPS, formatReportValue, panssStyle } from '../src/lib/reportGroups.ts';
import { panssCell, ageSex, filterSessions } from '../src/lib/sessionView.ts';
import { adminStats, formatServerDate } from '../src/lib/adminStats.ts';
import { readStoredAuth, storeAuth, clearStoredAuth } from '../src/lib/authStorage.ts';
import type { Session } from '../src/types/session.ts';

const here = new URL('.', import.meta.url).pathname;
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('59-feature contract: generated FEATURE_ORDER == battery-controller.js == app.py REQUIRED_FEATURES (names and order)', () => {
  const js = [...read('../public/battery-controller.js').match(/const FEATURE_ORDER = \[([\s\S]*?)\];/)![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const py = [...read('../../backup_original/app.py').match(/REQUIRED_FEATURES = \[([\s\S]*?)\]/)![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.equal(FEATURE_ORDER.length, 59);
  assert.equal(new Set(FEATURE_ORDER).size, 59);
  assert.deepEqual([...FEATURE_ORDER], js);
  assert.deepEqual([...FEATURE_ORDER], py);
  assert.ok(here.length > 0);
});

test('every feature key shown in the report modal is a real model feature', () => {
  const all = new Set<string>(FEATURE_ORDER);
  for (const g of REPORT_GROUPS) for (const [k] of g.keys) assert.ok(all.has(k), k);
  assert.equal(REPORT_GROUPS.length, 5);
});

test('PANSS histogram bins reproduce the original boundaries', () => {
  assert.deepEqual(panssBins([30, 44, 45, 59, 60, 134, 135, 210, 29, 0]), [2, 2, 1, 0, 0, 0, 1, 2]); // 29 and 0 dropped
  assert.equal(panssBins([]).length, 8);
});

test('age histogram bins reproduce the original boundaries', () => {
  assert.deepEqual(ageBins([5, 17, 18, 27, 28, 37, 38, 47, 48, 57, 58, 67, 68, 99]), [2, 2, 2, 2, 2, 2, 2]);
});

test('analytics summary cards', () => {
  assert.deepEqual(summaryStats({ total_sessions: 3, panss_distribution: [60, 61], age_distribution: [30, 31] }),
    { totalSessions: 3, avgPanss: '60.5', avgAge: 31, withPanss: 2 });
  assert.deepEqual(summaryStats({ total_sessions: 0, panss_distribution: [], age_distribution: [] }),
    { totalSessions: 0, avgPanss: '—', avgAge: '—', withPanss: 0 });
});

test('report value formatting: decimals, percentages, missing values', () => {
  assert.equal(formatReportValue('HS4_Mean_H_gain', 0.91234, ''), '0.912');
  assert.equal(formatReportValue('fv_fdur_mean', 250.5, 'ms'), '250.500 ms');
  assert.equal(formatReportValue('antisaccade_error_rate', 0.125, '%'), '12.5 %');
  assert.equal(formatReportValue('antisaccade_accuracy', '0.9', '%'), '90.0 %');
  assert.equal(formatReportValue('x', undefined, ''), '—');
  assert.equal(formatReportValue('x', null, ''), '—');
  assert.equal(formatReportValue('x', '', ''), '—');
});

test('PANSS styling thresholds', () => {
  assert.equal(panssStyle('—').label, 'Not recorded');
  assert.equal(panssStyle('60').label, 'Mild / HC');
  assert.equal(panssStyle('61').label, 'Moderate');
  assert.equal(panssStyle('90').label, 'Moderate');
  assert.equal(panssStyle('91').label, 'Severe');
});

const S = (o: Partial<Session>): Session => ({ id: 'i', patient_id: 'PAT-1', subject_id: 'S1', name: 'Asha Rao', age: 30, gender: 'Female',
  date: '25 Oct 2026, 10:00', panss: 55, features: {}, notes: '', notes_author: 'unknown', has_report: true, ...o });

test('session view helpers: PANSS null/N/A → dash (original printed "null"), search, age/sex', () => {
  assert.equal(panssCell(S({ panss: null })), '—');
  assert.equal(panssCell(S({ panss: 'N/A' })), '—');
  assert.equal(panssCell(S({ panss: 55 })), '55');
  assert.equal(ageSex(S({})), '30 / Female');
  const rows = [S({}), S({ id: 'j', patient_id: 'PAT-2', name: 'Ben Li', gender: 'Male' })];
  assert.equal(filterSessions(rows, 'ben').length, 1);
  assert.equal(filterSessions(rows, 'PAT-1')[0].id, 'i');
  assert.equal(filterSessions(rows, '  ').length, 2);
  assert.equal(filterSessions(rows, 'zzz').length, 0);
});

test('admin stats: totals, today (UTC date prefix), distinct real authors', () => {
  const now = new Date('2026-10-25T08:00:00Z');
  assert.equal(formatServerDate(now), '25 Oct 2026');
  const rows = [S({}), S({ date: '24 Oct 2026, 23:59' }), S({ notes_author: 'doctor' }), S({ notes_author: 'doctor' }), S({ notes_author: 'dr2' })];
  assert.deepEqual(adminStats(rows, now), { total: 5, today: 4, authors: 2 });
  assert.deepEqual(adminStats([], now), { total: 0, today: 0, authors: 0 });
});

test('auth storage uses the original localStorage keys and requires both values', () => {
  const m = new Map<string, string>();
  const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  assert.equal(readStoredAuth(store), null);
  storeAuth(store, { username: 'doctor', role: 'doctor' });
  assert.equal(m.get('currentUser'), 'doctor');
  assert.equal(m.get('currentRole'), 'doctor');
  assert.deepEqual(readStoredAuth(store), { username: 'doctor', role: 'doctor' });
  m.delete('currentRole');
  assert.equal(readStoredAuth(store), null);
  storeAuth(store, { username: 'a', role: 'b' });
  clearStoredAuth(store);
  assert.equal(readStoredAuth(store), null);
});
