// 59-feature contract: FEATURE_ORDER in public/feature-extractor.js must equal REQUIRED_FEATURES in the
// Flask app.py (same names, same order, 59 unique). Usage: node scripts/check-feature-parity.mjs [path/to/app.py]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appPy = process.argv[2] || path.join(root, '..', 'backup_original', 'app.py');
const js = readFileSync(path.join(root, 'public', 'feature-extractor.js'), 'utf8');
const py = readFileSync(appPy, 'utf8');
const a = [...js.match(/const FEATURE_ORDER = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
const b = [...py.match(/REQUIRED_FEATURES = \[([\s\S]*?)\]/)[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
const checks = [
  ['feature-extractor.js has 59 features', a.length === 59],
  ['feature-extractor.js features unique', new Set(a).size === a.length],
  ['app.py has 59 features', b.length === 59],
  ['identical names and order', a.length === b.length && a.every((v, i) => v === b[i])],
];
let bad = 0;
for (const [t, ok] of checks) { console.log(`${ok ? 'OK  ' : 'FAIL'} ${t}`); if (!ok) bad++; }
console.log(`(app.py: ${appPy})`);
process.exit(bad ? 1 : 0);
