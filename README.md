# NAINA / SchizoEye — Oculomotor Diagnostic Battery

A browser-based eye-tracking research prototype that runs a three-task
oculomotor battery (smooth pursuit, fixation/antisaccade, free viewing),
extracts 59 gaze features client-side, and sends them to a Flask backend for
model inference (Healthy vs Schizophrenia), report generation, and storage.

No specialized eye-tracking hardware is required — gaze is estimated from a
regular webcam via [MediaPipe FaceMesh](https://developers.google.com/mediapipe)
iris landmarks and a per-session ridge-regression calibration.

> **Decision-support only.** The model output is not a standalone clinical
> diagnosis. The current model is trained on a synthetic dataset and has not
> been established as a clinically validated diagnostic tool. See
> [`backend/templates/report_template.html`](backend/templates/report_template.html)
> for the report disclaimer.

---

## Contents

- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [How a session works](#how-a-session-works)
- [The 59-feature pipeline](#the-59-feature-pipeline)
- [Model training](#model-training)
- [Local development](#local-development)
- [Environment variables](#environment-variables)
- [Deployment](#deployment)
- [API reference](#api-reference)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)

---

## Architecture

```
┌─────────────────────────┐        ┌──────────────────────────┐        ┌──────────────┐
│  Frontend (Netlify)     │  HTTPS │  Backend (Render)         │        │ MongoDB Atlas│
│  vanilla JS + HTML/CSS  │ ─────▶ │  Flask + Gunicorn         │ ─────▶ │ + GridFS     │
│  TF.js + MediaPipe      │ ◀───── │  XGBoost classifier       │ ◀───── │              │
│  FaceMesh, Plotly       │        │  WeasyPrint (PDF)         │        └──────────────┘
└─────────────────────────┘        └──────────────────────────┘
```

- **Frontend** — Gaze estimation, calibration, all three tasks, results
  rendering, and the 59-feature extraction pipeline run in the browser. The
  backend receives the features along with session details and, when saving,
  raw gaze data and rendered chart images.
- **Backend** — a single Flask app (`app.py`) that classifies feature
  vectors with a pre-trained XGBoost model, persists
  sessions to MongoDB Atlas (raw gaze as GridFS CSVs, generated PDF reports
  as GridFS binaries), and renders PDF reports with WeasyPrint from a Jinja
  template (`backend/templates/report_template.html`).
- **Model** — trained and exported by `retrain_fixed.ipynb`
  (`model.pkl`, `label_encoder.pkl`, `feature_names.pkl`), loaded once at
  backend startup from `backend/model_artifacts/`.

---

## Repository layout

| Path | Role |
|---|---|
| `frontend/index.html` | Application entry point: login, dashboards, assessment screens, results, and report/notes/feature views. |
| `frontend/config.js` | Selects the API base URL: localhost for local development and the configured Render backend otherwise. |
| `frontend/camera-check.js` | Camera framing and lighting check, infrared-camera detector, and camera picker. |
| `frontend/eye-tracker.js` | Webcam gaze estimation, MediaPipe FaceMesh detection, calibration, and gaze stream. |
| `frontend/gaze-collector.js` | Collects gaze samples from `EyeTracker`. |
| `frontend/battery-controller.js` | Runs the assessment tasks, extracts features, and calls the backend for inference and report generation. |
| `frontend/feature_extractor.html` | Offline tool for replaying recorded gaze CSVs through the feature extractor. |
| `frontend/stimuli/` | Images used in the free-viewing task. |
| `backend/app.py` | Flask API for login, classification, session storage and retrieval, analytics, and PDF generation. |
| `backend/templates/report_template.html` | Jinja template used to render PDF reports. |
| `backend/model_artifacts/` | Model, label encoder, and feature-name files loaded by the backend at startup. |
| `backend/requirements.txt` / `backend/Dockerfile` | Python dependencies and Docker deployment configuration. |
| `Models/retrain_fixed.py` / `Models/retrain_fixed.ipynb` | Script and notebook for evaluating and training the XGBoost model. |
| `Models/synthetic_eye_tracking_3class_59features_RESCALED.csv` | Synthetic dataset consumed by the model-training script. |

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
  ├─ POST /generate-report → downloads a PDF generated from the current results
  └─ POST /save_results → stores features, raw CSVs (GridFS), chart images, and
                          a PDF report when report generation succeeds
```

Every task is gated on `EyeTracker.isCalibrated()` and `EyeTracker.isEmitting()`
before it starts, and each task checks its own captured row count when it
ends — this is what prevents a silently-empty task (dead camera, lost face,
stalled detector) from reaching the results screen unnoticed.

---

## The 59-feature pipeline

`frontend/battery-controller.js` (and, for offline replay,
`frontend/feature_extractor.html`) extracts the 59 features expected by the
model:

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
  size), not a hardcoded reference value.
- **Bounds & data-quality flags** — every feature is clamped to a
  physiologically plausible range; a feature that had genuinely
  insufficient data to compute falls back to a neutral bound-midpoint
  value and is flagged in a separate `data_quality` map rather than
  silently reported as an extreme value.

The ordered feature names are defined as `FEATURE_ORDER` in
`frontend/battery-controller.js`, mirrored as `REQUIRED_FEATURES` in
`backend/app.py`, and also listed in the dashboard modal in
`frontend/index.html`. Keep these definitions in sync if the feature set
changes.

---

## Model training

The training data is the synthetic CSV in `Models/`; it is not a clinical
cohort. The training script maps `HC` to `Healthy` and combines `FES` and
`CSZ` as `Schizophrenia`, reports stratified five-fold out-of-fold metrics,
then fits one XGBoost classifier on the full dataset.

To retrain, install the backend Python dependencies, then run the script from
the `Models` directory so it can find the CSV:

```text
python -m pip install -r backend/requirements.txt
cd Models
python retrain_fixed.py
```

The script writes `model.pkl`, `label_encoder.pkl`, and `feature_names.pkl` to
the current directory. To use the newly trained model, copy those three files
to `backend/model_artifacts/` before starting or redeploying the backend. The
notebook performs the same evaluation and training workflow.

---

## Local development

Use a local or otherwise approved test database when developing. Do not send
real patient data to a production backend from a local development session.
The frontend needs to be served over HTTP (rather than opened as a `file://`
URL) for browser camera access and API requests.

```bash
python -m http.server 8000 --directory frontend
```

Open `http://localhost:8000`. `frontend/config.js` points the local frontend
at `http://localhost:5000`. In a second terminal, create and activate a
virtual environment:

```text
# Windows PowerShell
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# macOS/Linux
python3 -m venv .venv
source .venv/bin/activate
```

Create `backend/.env` with the local settings below (replace each placeholder;
the file is ignored by Git), then install the backend dependencies and start
Flask from the repository root:

```text
MONGODB_URI=<your-local-or-test-mongodb-uri>
MONGODB_DB_NAME=SchizoEye
ADMIN_PASSWORD=<local-admin-password>
DOCTOR_PASSWORD=<local-doctor-password>
CLINICIAN_PASSWORD=<local-clinician-password>
SECRET_KEY=<persistent-random-secret>
```

Then run:

```text
python -m pip install -r backend/requirements.txt
python backend/app.py
```

The model files must be present in `backend/model_artifacts/` for
`/classify`. A reachable MongoDB database named `SchizoEye` is needed for
session storage, dashboards, and analytics. Without MongoDB, `/health` still
responds and classification can work, but database-backed features are
unavailable.

---

## Environment variables

The backend loads `backend/.env` for local development and reads the same
variables from the deployment environment in production. Do not commit
credentials or production connection strings.

| Variable | Required | Purpose |
|---|---|---|
| `MONGODB_URI` | Required for database features | MongoDB connection string. Without a successful connection, session, storage, and analytics features are unavailable. |
| `MONGODB_DB_NAME` | No (default `SchizoEye`) | Database name. The backend rejects names other than `SchizoEye`. |
| `ADMIN_PASSWORD` | Required for admin login | Password for the built-in `admin` username. |
| `DOCTOR_PASSWORD` | Required for doctor login | Password for the built-in `doctor` username. |
| `CLINICIAN_PASSWORD` | Required for clinician login | Password for the built-in `clinician` username. |
| `SECRET_KEY` | Recommended | Persistent Flask session-signing key. If unset, a new random key is generated at each process start. |
| `CORS_ORIGINS` | Optional | Comma-separated additional browser origins. The production Netlify site, Netlify deploy previews, and the documented localhost origins are allowed by default. |
| `PORT` | No (default `5000`) | Port used by the local Flask server and the container; the hosting platform supplies it in deployment. |

The frontend API base can be overridden by defining
`window.SCHIZOEYE_API_BASE` before `frontend/config.js` loads, or by changing
the default in `frontend/config.js`:

| Variable | Purpose |
|---|---|
| `window.SCHIZOEYE_API_BASE` | Overrides the local/deployed API base URL selected by `config.js`. |

---

## Deployment

- **Frontend** — deploy the contents of `frontend/` as a static site (the
  current configuration allows the production Netlify domain and its deploy
  previews). There is no frontend build step.
- **Backend** — build `backend/Dockerfile` with `backend/` as the build
  context. The Docker image includes `backend/templates/report_template.html`
  and the model artifacts from `backend/model_artifacts/`. The container starts
  Gunicorn with one worker, four threads, a 120-second timeout, and request
  recycling; it binds to the platform-provided `PORT`:

  ```text
  gunicorn --bind 0.0.0.0:${PORT:-5000} --workers 1 --threads 4 --timeout 120 --max-requests 200 --max-requests-jitter 50 app:app
  ```

  Configure the database and login credentials in the hosting environment.
  `/health` reports whether MongoDB is connected; it does not itself establish
  or refresh a database connection.

---

## API reference

All routes are on the Flask backend (`app.py`).

| Route | Method | Purpose |
|---|---|---|
| `/health` | GET | Returns backend status and a `mongodb_connected` flag. A successful response does not mean MongoDB is connected or the model loaded. |
| `/login` / `/logout` | POST | Establishes or clears a Flask session for the `admin`, `doctor`, or `clinician` account. |
| `/classify` | POST | Accepts `{ "features": { ... } }`; returns the predicted label, confidence, class probabilities, and missing feature names. Requires the model artifacts at startup. |
| `/save_results` | POST | Stores session metadata and features in MongoDB, with gaze CSVs and a PDF in GridFS when those uploads/generation succeed. Returns a session ID and stored file references. |
| `/sessions` | GET | Returns up to 200 recent session summaries for the dashboards. |
| `/sessions/search?q=<query>` | GET | Searches session name and patient ID; returns up to 50 matches. |
| `/sessions/<session_id>/pdf` | GET | Downloads a stored report, regenerating it from saved session data if no report is stored. |
| `/sessions/<session_id>/csv/<fv\|spem\|sz>` | GET | Downloads the requested raw gaze CSV if it was stored. |
| `/sessions/<session_id>/notes` | POST | Updates clinician notes and attempts to regenerate the stored PDF. |
| `/sessions/export_all_features` | GET | Downloads saved session metadata and the 59 model features as CSV. |
| `/analytics` | GET | Returns aggregate session data for the dashboard charts. |
| `/generate-report` | POST | Generates a PDF from the supplied report payload and returns it as a download. |

The session and analytics endpoints require a working MongoDB connection.

---

## Limitations

- This is a research prototype, not a clinically validated diagnostic system.
- The current XGBoost model is trained from the synthetic dataset in `Models/`;
  high cross-validation scores on that dataset do not demonstrate performance
  on real patients or other devices.
- Gaze estimates depend on webcam quality, lighting, face visibility,
  calibration, screen measurements, and browser support.
- The frontend loads several libraries from public CDNs and needs internet
  access for those dependencies.
- MongoDB-backed features require database connectivity; `/health` can return
  successfully while reporting `mongodb_connected: false`.

---

## Troubleshooting

- **Camera does not start:** serve the frontend on `localhost` or over HTTPS,
  grant camera permission, and close other applications using the webcam.
- **Classification returns 503:** confirm `model.pkl`, `label_encoder.pkl`,
  and `feature_names.pkl` are present in `backend/model_artifacts/`, then
  restart the backend.
- **Session or analytics requests fail:** check `MONGODB_URI`, confirm the
  database is named `SchizoEye`, and verify that the database permits
  connections from the backend host. Check `mongodb_connected` at `/health`.
- **Browser reports a CORS error:** verify the frontend is using the intended
  API base and add its exact origin to `CORS_ORIGINS` if it is not in the
  backend defaults.
- **PDF generation fails:** confirm
  `backend/templates/report_template.html` is included in the deployment and
  install backend dependencies from `backend/requirements.txt` (the Dockerfile
  also installs the required system libraries).
