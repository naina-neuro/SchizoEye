// Static reference check: every local resource battery.html (and the scripts) point at must exist in public/.
//   node scripts/check-battery-refs.mjs                  -> stimuli reported but not fatal
//   node scripts/check-battery-refs.mjs --require-images -> missing stimuli are fatal
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'public');
const html = readFileSync(path.join(pub, 'battery.html'), 'utf8');
const bc = readFileSync(path.join(pub, 'battery-controller.js'), 'utf8');
let failed = false;

const refs = [...html.matchAll(/<(?:script|link)[^>]*(?:src|href)="([^"]+)"/g)].map((x) => x[1]).filter((u) => !/^https?:/.test(u));
for (const r of refs) {
  const ok = existsSync(path.join(pub, r));
  console.log(`${ok ? 'OK  ' : 'FAIL'} battery.html -> ${r}`);
  if (!ok) failed = true;
}

const folder = (bc.match(/FV_IMAGE_FOLDER\s*=\s*'([^']+)'/) || [])[1];
const n = Number((bc.match(/FV_NUM_IMAGES\s*=\s*(\d+)/) || [])[1]);
const ext = (bc.match(/\$\{i\}\.(\w+)`/) || [])[1];
console.log(`\nbattery-controller.js expects: ${folder}1.${ext} … ${folder}${n}.${ext}  (resolved from /battery.html => /${folder})`);
const missing = [];
for (let i = 1; i <= n; i++) if (!existsSync(path.join(pub, folder, `${i}.${ext}`))) missing.push(`${i}.${ext}`);
console.log(missing.length ? `MISSING ${missing.length}/${n} stimuli in public/${folder}: ${missing.join(', ')}` : `OK   all ${n} stimuli present in public/${folder}`);
if (missing.length && process.argv.includes('--require-images')) failed = true;
process.exit(failed ? 1 : 0);
