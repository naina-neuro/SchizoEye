FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpango-1.0-0 \
    libpangoft2-1.0-0 \
    libharfbuzz0b \
    libpango1.0-dev \
    libcairo2 \
    libgdk-pixbuf-2.0-0 \
    libffi-dev \
    shared-mime-info \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=5000
EXPOSE 5000

# NOTE ON WORKER COUNT:
# This process imports pandas, numpy, scikit-learn, xgboost, matplotlib, scipy,
# and weasyprint at module load. That import graph alone commonly sits at
# 250-400MB RSS per worker before a single request is served. On a
# memory-constrained instance (e.g. Render free/starter, 512MB), running
# --workers 2 doubles that baseline and leaves little headroom for the actual
# inference (/classify) or PDF/heatmap generation (/save_results) requests,
# which are the two heaviest per-request code paths in this app. If those two
# routes fail with connection-level errors (browser "Failed to fetch", no HTTP
# status code) while lightweight DB-read routes (/sessions, /analytics,
# /health) keep working, that split is the signature of a worker being
# OOM-killed mid-request rather than a CORS or code bug.
#
# --workers 1 keeps a single import footprint; --threads handles concurrent
# requests within that one process instead of forking a second full copy.
# --max-requests recycles the worker periodically as a safety net against any
# slow memory creep across many requests. If you have headroom to raise
# --workers back up (e.g. after upgrading the Render plan), do that instead of
# reverting this file, since single-worker means requests queue behind each
# other under real concurrent load.
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "1", "--threads", "4", \
     "--timeout", "120", "--max-requests", "200", "--max-requests-jitter", "50", \
     "app:app"]
