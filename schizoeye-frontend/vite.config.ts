import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Everything in public/ (battery.html, config.js, main.js, assessment modules, styles.css, stimuli/)
// is copied to dist/ verbatim — Vite never
// bundles, minifies or rewrites it. scripts/verify-integrity.mjs --dist proves that after each build.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
});
