# NAINA / SchizoEye — Oculomotor Diagnostic Battery

A browser-based eye-tracking assessment that runs a three-task oculomotor
battery (smooth pursuit, fixation/antisaccade, free viewing), extracts 59
clinically-motivated gaze features entirely client-side, and sends them to a
Flask backend for model inference (Healthy vs Schizophrenia), report
generation, and storage.

No specialized eye-tracking hardware is required — gaze is estimated from a
regular webcam via [MediaPipe FaceMesh](https://developers.google.com/mediapipe)
iris landmarks and a per-session ridge-regression calibration.

> **Decision-support only.** The model output is not a standalone clinical
> diagnosis. See `report_template.html` for the disclaimer shown on every
> generated report.

---

## Contents

- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [How a session works](#how-a-session-works)
- [The 59-feature pipeline](#the-59-feature-pipeline)
- [Local development](#local-development)
- [Environment variables](#environment-variables)
- [Deployment](#deployment)
- [API reference](#api-reference)
- [Known limitations / roadmap](#known-limitations--roadmap)
- [Where to look when something breaks](#where-to-look-when-something-breaks)

---

## Architecture

```
┌─────────────────────────┐        ┌──────────────────────────┐        ┌──────────────┐
│  Frontend (Netlify)     │  HTTPS │  Backend (Render)         │        │ MongoDB Atlas│
│  vanilla JS + HTML/CSS  │ ─────▶ │  Flask + Gunicorn         │ ─────▶ │ + GridFS     │
│  TF.js + MediaPipe      │ ◀───── │  XGBoost (calibrated)     │ ◀───── │              │
│  FaceMesh, Plotly       │        │  WeasyPrint (PDF)         │        └──────────────┘
└─────────────────────────┘        └──────────────────────────┘
```

- **Frontend** — a single-page app (`index.html`) with no build step and no
  framework. Gaze estimation, calibration, all three tasks, results
  rendering, and the entire 59-feature extraction pipeline run in the
  browser. The backend only ever sees the final extracted features (plus raw
  gaze CSVs and rendered chart images) over HTTPS.
- **Backend** — a single Flask app (`app.py`) that classifies feature
  vectors with a pre-trained, isotonic-calibrated XGBoost model, persists
  sessions to MongoDB Atlas (raw gaze as GridFS CSVs, generated PDF reports
  as GridFS binaries), and renders PDF reports with WeasyPrint from a Jinja
  template (`report_template.html`).
- **Model** — trained and exported by `retrain_fixed.ipynb`
  (`model.pkl` / `model_calibrated.pkl`, `label_encoder.pkl`,
  `feature_names.pkl`), loaded once at backend startup from
  `backend/model_artifacts/`.

---

## Repository layout

| File | Role |
|---|---|
| `index.html` | Entry point. Login, doctor/admin/clinician dashboards, all in-battery screens (camera check, calibration guide, SPEM canvas, SchizoEye canvas, free-viewing stage, results screen), and the dashboard's report/notes/feature modals. |
| `config.js` | Resolves the backend API base URL (`localhost:5000` in local dev, the deployed Render URL otherwise). |
| `camera-check.js` | Step 1 of the protocol: live framing/lighting scoring against the real camera feed EyeTracker is already using (no second `getUserMedia` call), plus an infrared-camera detector and camera picker. |
| `eye-tracker.js` | The gaze engine (`EyeTracker` global). Owns the camera, the MediaPipe FaceMesh detection loop, the 20-point calibration UI + held-out validation, the Kalman-filtered gaze stream, and `onGaze()`/`isEmitting()` for consumers. |
| `gaze-collector.js` | `RawGazeCollector` — records raw gaze samples during the free-viewing task via a push subscription to `EyeTracker.onGaze()`. |
| `battery-controller.js` | The main orchestrator (`BatteryController`). Runs all three tasks, renders the results screen (Plotly graphs, scatter plots, clinical flags), and contains the full 59-feature extraction pipeline (a pure-JS port of the training-time feature code) plus the classify/save/PDF pipeline. |
| `feature_extractor.html` | Standalone offline tool: replay three raw gaze CSVs from a past session through the same extraction pipeline (useful for auditing feature math without re-running a live test). |
| `app.py` | Flask backend: auth, `/classify`, `/save_results`, `/sessions*`, `/analytics`, `/generate-report`. |
| `report_template.html` | Jinja/HTML template WeasyPrint renders into the clinical PDF report. |
| `retrain_fixed.ipynb` | Model training notebook — trains a plain and an isotonic-calibrated XGBoost classifier on the 59-feature synthetic dataset and exports the artifacts `app.py` loads. |
| `INTEGRATION.md` | Historical fix log for a specific past integration pass (calibration rewrite, camera-check rewrite, sampling-rate unification, backend wake/retry, `/classify` 405→200, model-file and template-path fixes). Kept as a detailed record of *why* things are shaped the way they are; this README is the current-state map. |

---

## How a session works

```
Begin protocol (subject/patient details, screen diagonal → px-per-degree)
  └─ Step 1: Camera check          live FRAMING % + LIGHTING /100 from real pixels
  └─ Step 2: Calibration guide     instructions video
  └─ Step 3: Grid calibration      20 points (auto-captured) + 5 held-out validation points
                                   → mean gaze error in px → "Start the tasks" / "Recalibrate"

Task 1 — SPEM (Smooth Pursuit)     practice trial + 3× 20s sequences
                                   (Horizontal 0.4Hz, Lissajous 0.2Hz, Lissajous 0.4Hz)

Task 2 — SchizoEye                 Phase I: 6 fixation trials (none/single/multi distractor)
                                   Phase II: 10 antisaccade trials (random eccentricity/side)

Task 3 — Free Viewing              25 images × 8s, natural viewing, raw gaze recorded

Results screen
  ├─ renders SPEM graphs, SZ scatter/waterfall plots, FV sample-count table
  ├─ extracts 59 oculomotor features from the three raw gaze streams (client-side)
  ├─ POST /classify   → Healthy vs Schizophrenia probabilities
  └─ POST /save_results → stores features, raw CSVs (GridFS), chart images, and a
                          generated PDF report; returns a downloadable PDF
```

Every task is gated on `EyeTracker.isCalibrated()` and `EyeTracker.isEmitting()`
before it starts, and each task checks its own captured row count when it
ends — this is what prevents a silently-empty task (dead camera, lost face,
stalled detector) from reaching the results screen unnoticed.

---

## The 59-feature pipeline

`battery-controller.js` (and, for offline replay, `feature_extractor.html`)
implements the same feature-extraction pipeline that produced the model's
training data:

- **Event detection** — an adaptive, noise-scaled velocity-threshold
  detector (Engbert & Kliegl style) classifies each gaze sample as
  fixation/saccade, replacing a fixed-dispersion (I-DT) approach so
  detection stays reliable across sessions with different camera/tracking
  noise levels.
- **Free viewing** — per-image fixation count/duration, saccade
  count/duration/amplitude/velocity, scanpath length, and dispersion,
  averaged (or summed, for scanpath) across all 25 images.
- **Smooth pursuit (SPEM)** — for each of the three sequences: gain, log
  SNR, and RMSE computed on the *desaccaded* pursuit signal (Hann-windowed
  DFT), plus fixation/saccade counts and kinematics from the residual
  (gaze − target) signal.
- **Fixation stability** — separately for the no-distractor and
  distractor conditions: fixation count/duration, saccade count/amplitude,
  scanpath length.
- **Antisaccade** — error rate, self-correction rate, mean latency
  (excluding anticipatory responses <80ms), and accuracy, from a
  robust smoothed-velocity saccade-onset detector with minimum
  duration/amplitude guards.
- **Units** — everything spatial is converted from pixels to degrees of
  visual angle using the session's own `pxPerDeg` (derived from the
  screen-diagonal input the operator provides and the actual viewport
  size), not a hardcoded reference value — this was a real bug
  (`FIX BC-MATH-6`) that silently skewed every session where the real
  screen differed from the ~15.6"-at-60cm assumption.
- **Bounds & data-quality flags** — every feature is clamped to a
  physiologically plausible range; a feature that had genuinely
  insufficient data to compute falls back to a neutral bound-midpoint
  value and is flagged in a separate `data_quality` map rather than
  silently reported as an extreme value.

All 59 feature names, in the exact order the model expects them, live in
`FEATURE_ORDER` (duplicated in `battery-controller.js`, `app.py`, and
`index.html`'s dashboard modal — keep these in sync if the feature set ever
changes).

---

## Local development

The backend is never run locally against production data — point the
frontend at the deployed Render backend and just serve the static frontend
files:

```bash
python -m http.server 8000
# open http://localhost:8000
```

`config.js` auto-detects `localhost`/`127.0.0.1` and points at
`http://localhost:5000` in that case — so if you *do* want to run the Flask
backend locally too:

```bash
cd backend
pip install -r requirements.txt
python app.py            # serves on :5000, needs the env vars below
```

You'll need `backend/model_artifacts/{model_calibrated.pkl or model.pkl,
label_encoder.pkl, feature_names.pkl}` present locally (see
[retrain_fixed.ipynb](#repository-layout)) and a reachable `MONGODB_URI` for
anything beyond `/classify` to work.

---

## Environment variables

Set these on the backend (Render):

| Variable | Required | Purpose |
|---|---|---|
| `MONGODB_URI` | Yes | Atlas connection string. Without it, every DB-backed route (`/sessions*`, `/save_results`, `/analytics`) returns 503. |
| `MONGODB_DB_NAME` | No (default `SchizoEye`) | Must resolve to a database literally named `SchizoEye` — `_get_scoped_database()` refuses anything else. |
| `SECRET_KEY` | Recommended | Flask session signing key. A random one is generated per-process if unset, which invalidates sessions on every restart. |
| `ADMIN_PASSWORD` / `DOCTOR_PASSWORD` / `CLINICIAN_PASSWORD` | Recommended | Override the `admin123`/`doctor123`/`clinician123` defaults for the three built-in accounts. |
| `CORS_ORIGINS` | If frontend origin changes | Comma-separated extra allowed origins, added on top of the hardcoded Netlify/localhost defaults. Netlify deploy previews (`https://<hash>--naina-schizo.netlify.app`) are already matched by regex. |
| `INTEGRATION_API_KEY` | For partner-site embedding | Required header (`X-Integration-Key`) on `POST /integration/test-sessions` to mint a `?token=` test link for a patient with no login session. |
| `TEST_FRONTEND_URL` | For partner-site embedding | Base URL used to build the `test_url` returned by the integration endpoint. |
| `PORT` | No (default `5000`) | Local dev only — Render sets this itself. |

Set this on the frontend (Netlify), or edit `config.js` directly:

| Variable | Purpose |
|---|---|
| `SCHIZOEYE_API_BASE` (`window.SCHIZOEYE_API_BASE`) | Overrides the auto-detected backend base URL. |

---

## Deployment

- **Frontend** — static deploy on Netlify, no build step.
- **Backend** — Render, Docker build with `backend/` as the build context
  (so `backend/templates/report_template.html` must exist *inside*
  `backend/`, not only in a sibling `frontend/templates/` — a real past
  bug, see `INTEGRATION.md` §9b). Start command:

  ```
  gunicorn app:app --workers 1 --threads 4 --timeout 180 --graceful-timeout 30
  ```

  One worker, because matplotlib + WeasyPrint inside Render's free-tier
  512 MB will not reliably survive two. Render's free tier also sleeps
  after ~15 minutes idle; the frontend pings `/health` periodically during
  a session and warms/retries before `/save_results` to avoid the first
  post-battery request landing on a sleeping instance.

---

## API reference

All routes are on the Flask backend (`app.py`).

| Route | Method | Purpose |
|---|---|---|
| `/health` | GET | Liveness + Mongo connection status. Also used as a keep-alive ping during a session. |
| `/login` / `/logout` | POST | Session-cookie auth for the three built-in roles. |
| `/classify` | POST | `{features: {...59 names...}}` → predicted label, confidence, per-class probabilities. 503 if the model artifacts didn't load; 405-turned-404 issues here usually mean the route itself isn't deployed. |
| `/save_results` | POST | Persists a full session: raw gaze CSVs (GridFS), chart/scatter/heatmap images, the 59 features, the prediction, and a generated PDF report (GridFS). Returns the new session id and a `report_url`. |
| `/sessions` | GET | Summary list for the dashboards. |
| `/sessions/search?q=` | GET | Name/patient-ID search. |
| `/sessions/<id>/pdf` | GET | Streams the stored PDF; regenerates on the fly if none was ever stored. |
| `/sessions/<id>/csv/<fv\|spem\|sz>` | GET | Raw gaze CSV download. |
| `/sessions/<id>/notes` | POST | Updates clinician notes and regenerates the stored PDF to include them. |
| `/sessions/export_all_features` | GET | One CSV of all sessions' 59 features, for offline analysis. |
| `/analytics` | GET | Aggregates for the admin dashboard's charts (daily volume, PANSS/age/gender distributions, feature averages). |
| `/generate-report` | POST | Stateless PDF generation from a caller-supplied payload — used by the results screen's "Download PDF Report" button, which already has fresh chart images in the DOM. |

---

## Known limitations / roadmap

- **Synthetic training data gain-variance artifact.** The pursuit "gain"
  features are nearly constant across classes in the current synthetic
  training set, which both candidate models (XGBoost, CatBoost) can latch
  onto as a spurious signal — CatBoost more so. Needs a data-generator fix
  and a retrain before either model's `gain`-feature reliance can be
  trusted. XGBoost (the currently deployed model) is the safer choice in
  the meantime.
- **Decision-support only.** No model output here should be treated as a
  standalone diagnosis — see the disclaimer baked into
  `report_template.html` and the results-screen prediction card.
- **Single-worker backend.** WeasyPrint + matplotlib inside a free-tier
  Render dyno constrains the backend to one gunicorn worker; a burst of
  concurrent `/save_results` calls will queue rather than parallelize.

---

## Where to look when something breaks

- **Camera opens twice / a second calibration screen appears / lighting
  card shows words instead of numbers / `FV:0 SPEM:0 SZ:0`** — these were
  all real bugs, fixed and explained in detail (root cause, not just the
  patch) in `INTEGRATION.md` §§1–3.
- **`Failed to fetch` on save, `/classify` 405 or 503, `TemplateNotFound`
  for the PDF template** — `INTEGRATION.md` §§4, 8, 9.
- **A generated PDF has no images from the dashboard even though it did
  right after the test** — chart/scatter/heatmap images were historically
  only ever embedded directly into the PDF binary at save time, never
  persisted anywhere else; any later PDF regeneration (most commonly
  saving clinician notes) rebuilt the PDF with no images to embed and
  discarded the original. Fixed by persisting the images on the session
  document (`results.images`) so every regeneration path reuses them.
- **Anything involving the 59-feature math itself** (thresholds, bounds,
  unit conversions) — every non-obvious constant in `battery-controller.js`
  and `feature_extractor.html` is commented in place with a `FIX BC-MATH-N`
  tag explaining what was wrong and why the new value is right; search for
  that prefix before changing a threshold.
