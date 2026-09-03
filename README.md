# SchizoEye Classification

SchizoEye is a browser-based oculomotor assessment application. The static frontend runs the webcam test and extracts 59 features. The Flask backend performs binary model inference, stores results in MongoDB Atlas, stores raw files and reports in GridFS, and generates PDF reports.

## Architecture

- `frontend/`: static application for Netlify or Vercel.
- `backend/`: Flask API for Render or Docker.
- `backend/model_artifacts/`: production model files. These must remain server-side.
- `Models/`: offline training scripts, notebooks, and training data.

The current model uses two output classes:

- `Healthy`
- `Schizophrenia`

The source dataset contains `HC`, `FES`, and `CSZ`, but training intentionally merges `FES` and `CSZ` into `Schizophrenia`.

## Local Backend

From the repository root:

```text
py -m pip install -r backend/requirements.txt
py -m backend.app
```

Configure `backend/.env` using `backend/.env.example`. MongoDB is required for persistence; model inference can be checked independently with `/classify`.

## Frontend

Serve `frontend/` using a static server. Configure the backend URL in `frontend/config.js`.

The browser must use HTTPS in production for webcam access.

## Production Backend

The Docker image is defined in `backend/Dockerfile`. A Render service can use:

```text
gunicorn --chdir backend app:app
```

Required deployment variables are documented in `backend/.env.example`.

## Main API Endpoints

- `GET /health`: service, database, and model status.
- `POST /classify`: validate and classify exactly 59 features.
- `POST /save_results`: classify, persist the session, and generate the PDF report.
- `GET /sessions/<session_id>/pdf`: download the stored PDF.
- `POST /integration/test-sessions`: create a signed dashboard-free test URL for an external application.
