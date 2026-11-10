// Real-browser test of the React app against a MOCK Flask API (shapes copied from app.py). Not a test of Flask/Mongo.
//   Needs: playwright (+ a Chromium), esbuild (ships with Vite), react, react-dom.   node tests/e2e/run-e2e.mjs
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
let haveChart = true; try { require.resolve('chart.js'); } catch { haveChart = false; }

// ---- build the real app bundle ---------------------------------------------------------------
const out = mkdtempSync(path.join(os.tmpdir(), 'se-e2e-'));
await esbuild.build({
  entryPoints: [path.join(root, 'src/main.tsx')], bundle: true, outfile: path.join(out, 'app.js'), format: 'iife',
  jsx: 'automatic', nodePaths: (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean), define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'error',
  alias: haveChart ? {} : { 'chart.js': path.join(root, 'tests/e2e/chart-stub.ts') },
});
console.log(`bundled src/main.tsx (chart.js: ${haveChart ? 'real package' : 'STUB — real package not installed here'})`);

// ---- mock Flask API ---------------------------------------------------------------------------
const FEATURES = [...readFileSync(path.join(root, 'public/feature-extractor.js'), 'utf8').match(/const FEATURE_ORDER = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const now = new Date();
const todayStr = `${String(now.getUTCDate()).padStart(2, '0')} ${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
const feats = Object.fromEntries(FEATURES.map((n, i) => [n, n.includes('error_rate') || n.includes('accuracy') ? 0.125 : i + 0.5]));
const sessions = [
  { id: 'aaa111', patient_id: 'PAT-AAA', subject_id: 'S1', name: 'Asha Rao', age: 30, gender: 'Female', date: `${todayStr}, 10:00`, panss: 55, features: feats, notes: 'old note', notes_author: 'doctor', has_report: true },
  { id: 'bbb222', patient_id: 'PAT-BBB', subject_id: 'S2', name: 'Ben Li', age: 41, gender: 'Male', date: `${todayStr}, 11:30`, panss: 95, features: feats, notes: '', notes_author: 'unknown', has_report: true },
  { id: 'ccc333', patient_id: 'PAT-CCC', subject_id: 'S3', name: 'Cara Diaz', age: 'N/A', gender: 'N/A', date: '01 Jan 2020, 09:00', panss: null, features: {}, notes: '', notes_author: 'unknown', has_report: false },
];
const analytics = { success: true, total_sessions: 3, daily_counts: [{ date: '2026-10-24', count: 1 }, { date: '2026-10-25', count: 2 }], panss_distribution: [55, 70], gender_distribution: { Female: 2, Male: 1 }, age_distribution: [30, 40], feature_averages: { HS4_Mean_H_gain: { mean: 0.9, min: 0.8, max: 1.0, n: 2 } } };
const USERS = { admin: 'admin', doctor: 'doctor', clinician: 'clinician' };
const log = []; const state = { failSessions: false, notesBody: null };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const send = (res, code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname; let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    log.push(`${req.method} ${p}`);
    if (p === '/' ) { const h = readFileSync(path.join(root, 'index.html'), 'utf8').replace('<script type="module" src="/src/main.tsx"></script>', '<link rel="stylesheet" href="/app.css"><script src="/app.js"></script>'); return send(res, 200, h, { 'Content-Type': 'text/html' }); }
    if (p === '/app.js' || p === '/app.css') return send(res, 200, readFileSync(path.join(out, p)), { 'Content-Type': types[path.extname(p)] });
    if (p === '/embed') return send(res, 200, '<iframe id="f" src="/"></iframe>', { 'Content-Type': 'text/html' });
    if (p === '/login' && req.method === 'POST') { const b = JSON.parse(body || '{}'); return USERS[b.username] && b.password === 'pw' ? send(res, 200, { success: true, role: b.username, username: b.username }, { 'Set-Cookie': 'sid=1; Path=/' }) : send(res, 401, { success: false, error: 'Invalid credentials' }); }
    if (p === '/logout') return send(res, 200, { success: true });
    if (p === '/sessions') return state.failSessions ? send(res, 503, { success: false, error: 'Database not connected' }) : send(res, 200, { success: true, sessions });
    if (p === '/analytics') return send(res, 200, analytics);
    let m;
    if ((m = p.match(/^\/sessions\/([^/]+)\/notes$/))) { state.notesBody = JSON.parse(body); return send(res, 200, { success: true }); }
    if ((m = p.match(/^\/sessions\/([^/]+)\/pdf$/))) return send(res, 200, '%PDF-1.4 mock', { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename=report_${m[1]}.pdf` });
    if ((m = p.match(/^\/sessions\/([^/]+)\/csv\/(\w+)$/)) || p === '/sessions/export_all_features') return send(res, 200, 'a,b\n1,2\n', { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename=x.csv' });
    const f = path.join(root, 'public', p);
    if (existsSync(f) && !f.endsWith('/')) return send(res, 200, readFileSync(f), { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
    send(res, 404, { error: 'not found' });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- drive it ---------------------------------------------------------------------------------
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : '  ' + extra}`); if (!ok) failures++; };
const browser = await chromium.launch();
const ctx = await browser.newContext({ acceptDownloads: true });
await ctx.route((url) => !['127.0.0.1', 'localhost'].includes(url.hostname), (r) => r.abort()); // no internet in tests
await ctx.addInitScript((b) => { window.SCHIZOEYE_API_BASE = b; }, base); // point the app at the mock API (tests the override path)
const page = await ctx.newPage();
const pageErrors = []; page.on('pageerror', (e) => pageErrors.push(e.message));
const shot = async (n) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${n}.png` }); }; // optional: SHOTS=/dir
const login = async (user, pw = 'pw') => { await page.fill('#login-username', user); await page.fill('#login-password', pw); await page.click('#login-btn'); };

await page.goto(base + '/');
check('root shows login screen', await page.isVisible('#login-screen')); await shot('1-login');
await page.click('#login-btn');
check('empty credentials message', (await page.textContent('#login-error')) === 'Please enter username and password.');
await login('doctor', 'wrong');
await page.waitForFunction(() => document.querySelector('#login-error')?.textContent === 'Invalid credentials');
check('wrong password shows server error', true);
await page.click('#toggle-pw');
check('show/hide password toggles input type', (await page.getAttribute('#login-password', 'type')) === 'text');
await page.click('#toggle-pw');

// doctor
await login('doctor');
await page.waitForSelector('#doctor-dashboard tbody tr .dash-pid');
await shot('2-doctor'); check('doctor dashboard + header identity', (await page.textContent('#doctor-dashboard .dash-sub')) === 'Signed in as: doctor · doctor');
check('doctor sees 3 session rows', (await page.locator('#doctor-dashboard tbody tr').count()) === 3);
check('null PANSS shows "—" (not "null")', (await page.locator('#doctor-dashboard tbody tr').nth(2).locator('td').nth(4).textContent()) === '—');
check('session without report has no View/PDF buttons', (await page.locator('#doctor-dashboard tbody tr').nth(2).locator('button', { hasText: /View|PDF/ }).count()) === 0);
await page.fill('#doctor-search-input', 'ben');
check('search filters rows', (await page.locator('#doctor-dashboard tbody tr').count()) === 1);
await page.fill('#doctor-search-input', 'zzz');
check('no-match message', (await page.textContent('#doctor-dashboard tbody')).includes('No matching sessions.'));
await page.fill('#doctor-search-input', '');

await page.locator('#doctor-dashboard tbody tr').first().locator('button', { hasText: '59 Features' }).click();
const names = await page.locator('#feature-modal .feat-name').allTextContents();
check('feature modal lists 59 features in model order', names.length === 59 && names.every((n, i) => n === FEATURES[i]));
check('feature values formatted to 4 decimals', (await page.locator('#feature-modal .feat-val').first().textContent()) === '0.5000');
await page.mouse.click(5, 5);
check('modal closes on backdrop click', (await page.locator('#feature-modal').count()) === 0);

const getsBefore = log.filter((l) => l === 'GET /sessions').length;
await page.locator('#doctor-dashboard tbody tr').first().locator('button', { hasText: 'Notes' }).click();
check('notes modal prefilled', (await page.inputValue('#notes-textarea')) === 'old note');
await page.fill('#notes-textarea', 'new clinical note');
await page.click('text=💾 Save Notes');
await page.waitForFunction(() => document.querySelector('#notes-save-status')?.textContent?.includes('saved'));
check('notes POST body is {notes, author}', JSON.stringify(state.notesBody) === JSON.stringify({ notes: 'new clinical note', author: 'doctor' }), JSON.stringify(state.notesBody));
await page.waitForSelector('#notes-modal', { state: 'detached' });
await page.waitForTimeout(200);
check('notes modal closes and list reloads', log.filter((l) => l === 'GET /sessions').length > getsBefore);

await page.locator('#doctor-dashboard tbody tr').first().locator('button', { hasText: 'View' }).click();
await shot('3-report'); check('report modal shows 5 feature groups + patient', (await page.locator('#report-modal .cr-group').count()) === 5 && (await page.textContent('#report-modal')).includes('Asha Rao'));
check('report PANSS 55 labelled Mild / HC', (await page.textContent('#report-modal .cr-patient-bar')).includes('Mild / HC'));
check('report shows percent formatting for error rate', (await page.textContent('#report-modal')).includes('12.5 %'));
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#report-modal .report-modal-btn')]);
check('report modal PDF download', dl.suggestedFilename() === 'report_aaa111.pdf', dl.suggestedFilename());
await page.mouse.click(5, 5);

state.failSessions = true;
await page.click('text=↺ Refresh');
await page.waitForFunction(() => document.querySelector('#doctor-dashboard tbody')?.textContent?.includes('Database not connected'));
check('session load failure message shown', true);
state.failSessions = false; await page.click('text=↺ Refresh');
await page.waitForSelector('#doctor-dashboard tbody .dash-pid');

await page.click('text=📊 Analytics');
await page.waitForSelector('#analytics-content canvas');
await shot('4-analytics'); const stats = await page.locator('#analytics-content .stat-num').allTextContents();
check('analytics summary cards', JSON.stringify(stats) === JSON.stringify(['3', '62.5', '35', '2']), JSON.stringify(stats));
const charts = await page.evaluate(() => window.__charts || null);
if (charts) {
  const byId = Object.fromEntries(charts.map((c) => [c.id, c]));
  check('4 charts drawn', Object.keys(byId).length === 4, Object.keys(byId).join());
  check('PANSS histogram bins', JSON.stringify(byId['chart-panss']?.data) === JSON.stringify([0, 1, 1, 0, 0, 0, 0, 0]));
  check('age histogram bins', JSON.stringify(byId['chart-age']?.data) === JSON.stringify([0, 0, 1, 1, 0, 0, 0]));
  check('daily labels sliced to MM-DD', JSON.stringify(byId['chart-daily']?.labels) === JSON.stringify(['10-24', '10-25']));
} else check('chart.js stub recorded charts (skipped: real chart.js in use)', true);
check('feature average card rendered', (await page.textContent('#analytics-content')).includes('SPEM HS4 H-Gain'));

const [popup] = await Promise.all([ctx.waitForEvent('page'), page.click('text=▶ Take Test')]);
await popup.waitForLoadState('domcontentloaded');
check('Take Test opens /battery.html?mode=test', new URL(popup.url()).pathname === '/battery.html' && new URL(popup.url()).search === '?mode=test', popup.url());
const popErrors = []; popup.on('pageerror', (e) => popErrors.push(e.message));
await popup.waitForFunction(() => document.getElementById('battery-intro')?.style.display === 'block', null, { timeout: 5000 });
check('battery.html boots to the intro screen in test mode', await popup.evaluate(() => document.body.classList.contains('headless-mode')));
check('battery.html: all 4 task scripts defined their globals', await popup.evaluate(() => typeof EyeTracker === 'object' && typeof RawGazeCollector === 'object' && typeof BatteryController === 'object'));
check('battery.html: no uncaught JS errors on load', popErrors.length === 0, popErrors.join(' | '));
await popup.close();

await page.click('text=Sign Out');
await page.waitForSelector('#login-screen');
check('sign out returns to login, clears stored identity, calls /logout', (await page.evaluate(() => localStorage.getItem('currentRole'))) === null && log.includes('POST /logout'));

// admin
await login('admin');
await page.waitForSelector('#admin-dashboard tbody .dash-pid');
await shot('5-admin'); check('admin stats: total / today / authors', JSON.stringify(await page.locator('#admin-stats-row .stat-num').allTextContents()) === JSON.stringify(['3', '2', '1']), JSON.stringify(await page.locator('#admin-stats-row .stat-num').allTextContents()));
check('admin table has Raw CSVs column, no Notes button', (await page.locator('#admin-dashboard th', { hasText: 'Raw CSVs' }).count()) === 1 && (await page.locator('#admin-dashboard button', { hasText: 'Notes' }).count()) === 0);
await page.locator('#admin-dashboard tbody tr').first().locator('button', { hasText: 'SPEM' }).click();
await page.waitForFunction(() => true); await page.waitForTimeout(300);
check('SPEM CSV link requests /sessions/<id>/csv/spem', log.includes('GET /sessions/aaa111/csv/spem'));
await page.locator('#admin-dashboard button', { hasText: 'Export All Features' }).first().click(); await page.waitForTimeout(300);
check('Export All Features requests the export route', log.includes('GET /sessions/export_all_features'));
await page.reload();
await page.waitForSelector('#admin-dashboard');
check('stored identity restores the dashboard after reload', true);
await page.click('text=Sign Out'); await page.waitForSelector('#login-screen');

// clinician
await login('clinician');
await page.waitForSelector('#clinician-dashboard');
await shot('6-clinician'); const [cp] = await Promise.all([ctx.waitForEvent('page'), page.click('text=▶ Launch Battery Protocol')]);
await cp.waitForLoadState('domcontentloaded');
check('clinician launch opens /battery.html?mode=test', new URL(cp.url()).pathname + new URL(cp.url()).search === '/battery.html?mode=test', cp.url());
await cp.close();
await page.click('text=Sign Out'); await page.waitForSelector('#login-screen');

// legacy URLs, in a real browser
const p2 = await ctx.newPage();
await p2.goto(base + '/?mode=test&token=abc#x'); await p2.waitForURL('**/battery.html**');
check('/?mode=test&token=abc#x → /battery.html with query + hash preserved', p2.url().endsWith('/battery.html?mode=test&token=abc#x'), p2.url());
await p2.goto(base + '/?token=zzz'); await p2.waitForURL('**/battery.html**');
check('/?token=zzz alone redirects (token keeps its value)', p2.url().endsWith('/battery.html?token=zzz'), p2.url());
await p2.goto(base + '/battery.html'); await p2.waitForURL((u) => u.pathname === '/');
check('/battery.html without test mode → React app (same gate as the old page)', await p2.isVisible('#login-screen'));
await p2.goto(base + '/embed');
const fr = p2.frame({ url: /battery\.html/ }) || (await (async () => { await p2.waitForTimeout(1500); return p2.frame({ url: /battery\.html/ }); })());
check('iframe embedding the root URL lands on /battery.html', !!fr, p2.frames().map((f) => f.url()).join(' | '));
await p2.close();

check('no uncaught JS errors in the React app', pageErrors.length === 0, pageErrors.join(' | '));
await browser.close(); server.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL E2E CHECKS PASSED (mock API; see README for what this does not cover)');
process.exit(failures ? 1 : 0);
