# schizoeye-frontend — migration Stage 2 (React login + dashboards)

React + TypeScript + Vite for **login and the doctor / admin / clinician dashboards**.
The assessment itself is the static page `public/battery.html` (unchanged camera, calibration, tasks, 59-feature
extraction). Dashboards open it in a new tab (`/battery.html?mode=test`), exactly as before.

## Stimulus images (you copy these; filenames unchanged)
    public/stimuli/1.jpg … public/stimuli/25.jpg

## Run locally
    npm install
    npm run check          # integrity, redirect, references, 59-feature parity, unit tests
    npm run dev            # http://localhost:5173
Flask on port 5000 (`python app.py`). Allow the Vite origin without editing app.py:
    CORS_ORIGINS=http://localhost:5173
Dev logins are whatever ADMIN_PASSWORD / DOCTOR_PASSWORD / CLINICIAN_PASSWORD are set to on your Flask process.

## Build
    npm run build          # tsc --noEmit, vite build, then proves dist/ static files == public/ byte for byte

## Tests
    npm test               # 18 unit tests: API contracts (mocked fetch), binning, report formatting, auth storage, 59-feature parity
    npm run test:e2e       # optional: real Chromium vs a MOCK Flask API (needs: npm i -D playwright; npx playwright install chromium)
                           # SHOTS=/some/dir npm run test:e2e   also saves screenshots
`test:e2e` does NOT test Flask, MongoDB, the camera, MediaPipe, calibration or PDF generation.

## Where things are
    src/api/*          fetch wrappers (one per Flask endpoint group) — credentials: 'include' on every call
    src/lib/*          pure logic (analytics bins, report groups, admin stats, search) — unit-tested without React
    src/types/featureOrder.ts   GENERATED from public/battery-controller.js (npm run gen:features); never hand-edit
    src/pages, src/components   UI
    src/styles/legacy.css       login + dashboard CSS copied from the original index.html (+ classes replacing inline styles)
    public/styles.css           original stylesheet, linked from index.html untouched (CSS variables, report-modal styles)

## Do not deploy to production yet
naina-schizo.netlify.app is still the old single-file app. Deploy this build to a separate Netlify site / branch preview first.
