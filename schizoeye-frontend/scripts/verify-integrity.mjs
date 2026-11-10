// File-integrity guard for the static (non-bundled) files.
//   node scripts/verify-integrity.mjs          -> public/ files vs INTEGRITY.json (drift detection)
//   node scripts/verify-integrity.mjs --write  -> (re)generate INTEGRITY.json from public/
//   node scripts/verify-integrity.mjs --dist   -> dist/ files must be byte-identical to public/ (run after build)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'battery.html',
  'config.js',
  'main.js',
  'eye-tracker.js',
  'assessment-tasks.js',
  'feature-extractor.js',
  'battery-controller.js',
  'api-service.js',
  'report-manager.js',
  'styles.css',
];
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const manifestPath = path.join(root, 'INTEGRITY.json');
const mode = process.argv[2];
let failed = false;

if (mode === '--write') {
  const m = Object.fromEntries(FILES.map((f) => [f, sha(path.join(root, 'public', f))]));
  writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');
  console.log('INTEGRITY.json written:\n' + JSON.stringify(m, null, 2));
} else if (mode === '--dist') {
  if (!existsSync(path.join(root, 'dist'))) { console.error('dist/ not found — run `npm run build` first'); process.exit(1); }
  for (const f of FILES) {
    const a = sha(path.join(root, 'public', f));
    const dp = path.join(root, 'dist', f);
    const ok = existsSync(dp) && sha(dp) === a;
    console.log(`${ok ? 'OK  ' : 'FAIL'} dist/${f} == public/${f}`);
    if (!ok) failed = true;
  }
} else {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const f of FILES) {
    const ok = sha(path.join(root, 'public', f)) === m[f];
    console.log(`${ok ? 'OK  ' : 'FAIL'} public/${f} matches INTEGRITY.json`);
    if (!ok) failed = true;
  }
  if (failed) console.error('\nIf git changed line endings (autocrlf), compare against your originals, then re-run with --write.');
}
process.exit(failed ? 1 : 0);
