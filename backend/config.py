"""Environment-driven configuration: CORS origins, Flask secrets/session/upload settings, MongoDB target.

Nothing here talks to the network or the filesystem beyond os.getenv — it's pure settings, read once at
import time, so every module that needs a setting imports this module instead of re-reading os.environ.
"""
import os
import re
import secrets

# --- CORS ---
DEFAULT_ORIGINS = [
    "https://naina-schizo.netlify.app",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://localhost:5500",
]

# Netlify deploy-preview URLs for this site (e.g. https://deploy-preview-12--naina-schizo.netlify.app).
NETLIFY_PREVIEW_RE = re.compile(r"^https://[a-z0-9-]+--naina-schizo\.netlify\.app$")


def _extra_origins():
    """Parse the CORS_ORIGINS env var (comma-separated) into a clean list of origins."""
    raw = os.getenv("CORS_ORIGINS", "")
    return [o.strip().rstrip("/") for o in raw.split(",") if o.strip()]


def allowed_origins():
    """Return the de-duplicated list of allowed CORS origins: the defaults plus any CORS_ORIGINS extras."""
    return list(dict.fromkeys(DEFAULT_ORIGINS + _extra_origins()))


# --- Flask app settings ---
SECRET_KEY = os.getenv("SECRET_KEY", secrets.token_hex(32))
MAX_CONTENT_LENGTH = 48 * 1024 * 1024  # 48MB cap: gaze CSVs + task images + rendered PDF in one payload
SESSION_COOKIE_SETTINGS = dict(
    SESSION_COOKIE_SAMESITE="None",
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_HTTPONLY=True,
)

# --- MongoDB target ---
MONGODB_URI = os.getenv("MONGODB_URI")
MONGODB_DB_NAME = os.getenv("MONGODB_DB_NAME", "SchizoEye")
SESSIONS_COLLECTION = "sessions"
