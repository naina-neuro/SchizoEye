// Executes the REAL inline #legacy-redirect script from index.html against simulated URLs.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const m = html.match(/<script id="legacy-redirect">([\s\S]*?)<\/script>/);
if (!m) { console.error('FAIL: #legacy-redirect script not found in index.html'); process.exit(1); }

function run(search, hash = '', embedded = false) {
  let replaced = null;
  const win = { location: { search, hash, replace: (u) => { replaced = u; } } };
  win.parent = embedded ? {} : win;
  vm.runInNewContext(m[1], { window: win, URLSearchParams, console });
  return { replaced, flag: !!win.__SCHIZOEYE_REDIRECTING__ };
}

const cases = [
  ['?mode=test',                     '',     false, '/battery.html?mode=test'],
  ['?mode=test&token=abc123',        '',     false, '/battery.html?mode=test&token=abc123'],
  ['?token=abc123',                  '',     false, '/battery.html?token=abc123'],
  ['?mode=test',                     '#x',   false, '/battery.html?mode=test#x'],
  ['',                               '',     true,  '/battery.html'],            // iframe embed, no params
  ['?foo=1',                         '',     true,  '/battery.html?foo=1'],
  ['',                               '',     false, null],                       // normal visit -> React app
  ['?mode=other',                    '',     false, null],
  ['?token=',                        '',     false, null],                       // empty token = falsy, like original Boolean('')
];
let bad = 0;
for (const [s, h, e, want] of cases) {
  const r = run(s, h, e);
  const ok = r.replaced === want && r.flag === (want !== null);
  if (!ok) bad++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} search=${JSON.stringify(s)} hash=${JSON.stringify(h)} embedded=${e} -> ${r.replaced}`);
}
process.exit(bad ? 1 : 0);
