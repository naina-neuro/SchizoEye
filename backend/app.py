from flask import Flask, request, jsonify, render_template, send_file
from flask_cors import CORS
import joblib
import pandas as pd
import json
import os
from datetime import datetime
import io
import re
import base64
import traceback
import uuid

# MongoDB Imports
from pymongo import MongoClient, errors
import gridfs
from bson.binary import Binary
from bson.objectid import ObjectId
from dotenv import load_dotenv

# Heatmap Imports
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
from scipy.ndimage import gaussian_filter

load_dotenv()

try:
    from weasyprint import HTML
except ImportError:
    print("WARNING: weasyprint is not installed. PDF generation will fail.")

import secrets

# The frontend is a separate Netlify deployment — this backend never serves
# its HTML/JS, only the API and generated PDFs. Templates must live inside
# THIS project's own folder (backend/templates/), because Render builds this
# Dockerfile with backend/ as the build context: a path that reaches out to
# a sibling ../frontend/ directory points at something that doesn't exist
# inside the image at all, which is why render_template('report_template.html')
# was raising TemplateNotFound even though the file existed in the repo.
BASE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_DIR = os.path.join(BASE, 'templates')

app = Flask(__name__, template_folder=TEMPLATE_DIR)
# ── CORS ─────────────────────────────────────────────────────────────────────
# The allowlist here used to name https://naina-assessment.netlify.app while the
# deployed frontend lives at https://naina-schizo.netlify.app. Any origin that is
# not on this list gets no Access-Control-Allow-Origin header, the browser
# discards the response before JS ever sees it, and fetch() rejects with
# "TypeError: Failed to fetch" — which is exactly what /sessions, /classify and
# /save_results were all reporting. Keep this list in sync with wherever the
# frontend is actually served from.
#
# Set CORS_ORIGINS in Render to add origins without a code change:
#   CORS_ORIGINS=https://partner.example.com,https://staging.example.com
# supports_credentials=True means "*" is not legal here — every origin must be
# listed explicitly (Netlify deploy previews are matched by regex below).
_DEFAULT_ORIGINS = [
    "https://naina-schizo.netlify.app",      # production frontend
    "https://naina-assessment.netlify.app",  # previous domain, kept for old links
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://localhost:5500",
    "http://127.0.0.1:5500",
]

_extra_origins = [o.strip().rstrip("/") for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]

# Netlify branch/deploy previews: https://<hash>--naina-schizo.netlify.app
_NETLIFY_PREVIEW_RE = re.compile(r"^https://[a-z0-9-]+--naina-schizo\.netlify\.app$")

ALLOWED_ORIGINS = list(dict.fromkeys(_DEFAULT_ORIGINS + _extra_origins))

CORS(
    app,
    resources={r"/*": {"origins": ALLOWED_ORIGINS + [_NETLIFY_PREVIEW_RE]}},
    supports_credentials=True,
    expose_headers=["Content-Disposition"],
    allow_headers=["Content-Type", "X-Test-Token", "X-Integration-Key", "Authorization"],
    methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
)
print(f"[CORS] allowed origins: {ALLOWED_ORIGINS} (+ netlify deploy previews)")

app.secret_key = os.getenv("SECRET_KEY", secrets.token_hex(32))

# A completed battery posts three raw gaze arrays plus the embedded figures.
# Without a ceiling Flask happily buffers the whole thing into a 512 MB dyno.
app.config["MAX_CONTENT_LENGTH"] = 48 * 1024 * 1024   # 48 MB

# Cross-site XHR from the Netlify frontend can only carry the session cookie if
# it is SameSite=None; Secure. Without this the cookie is dropped and every
# authenticated endpoint answers 401 from a different machine than the one that
# logged in.
app.config.update(
    SESSION_COOKIE_SAMESITE="None",
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_HTTPONLY=True,
)

# ── DISABLE BROWSER CACHING FOR ALL RESPONSES ──
@app.after_request
def add_no_cache_headers(response):
    """Prevent stale JS/CSS caching across browsers and systems."""
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response

# ── USER CREDENTIALS (admin, doctor, clinician) ──
USERS = {
    "admin":     {"password": os.getenv("ADMIN_PASSWORD",     "admin123"),     "role": "admin"},
    "doctor":    {"password": os.getenv("DOCTOR_PASSWORD",    "doctor123"),    "role": "doctor"},
    "clinician": {"password": os.getenv("CLINICIAN_PASSWORD", "clinician123"), "role": "clinician"},
}

@app.route('/login', methods=['POST'])
def login():
    data = request.get_json()
    username = data.get('username', '').strip()
    password = data.get('password', '').strip()
    user = USERS.get(username)
    if user and user['password'] == password:
        from flask import session as flask_session
        flask_session['user'] = username
        flask_session['role'] = user['role']
        return jsonify({'success': True, 'role': user['role'], 'username': username})
    return jsonify({'success': False, 'error': 'Invalid credentials'}), 401

@app.route('/logout', methods=['POST'])
def logout():
    from flask import session as flask_session
    flask_session.clear()
    return jsonify({'success': True})

# ── MONGODB SETUP ──
MONGODB_URI = os.getenv("MONGODB_URI")
MONGODB_DB_NAME = os.getenv("MONGODB_DB_NAME", "SchizoEye")
SESSIONS_COLLECTION = "sessions"
db = None
fs = None


def _get_scoped_database(client):
    scoped_db = client.get_database(MONGODB_DB_NAME)
    if scoped_db.name != "SchizoEye":
        raise errors.ConfigurationError(
            "MongoDB access must remain scoped to the SchizoEye database."
        )
    return scoped_db

def _legacy_init_mongodb():
    global db, fs
    try:
        # Use standard SRV connection string with retryWrites=true
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        # Scoped strictly to SchizoEye database
        db = client.get_database("SchizoEye")
        fs = gridfs.GridFS(db)
        # Trigger a connection check
        client.admin.command('ping')
        print("[OK] MongoDB Atlas connected successfully (SchizoEye)")
    except errors.ConfigurationError as ce:
        print(f"[ERROR] MongoDB Configuration Error: {ce}")
    except Exception as e:
        print(f"[ERROR] MongoDB Connection Error: {e}")

def init_mongodb():
    global db, fs
    try:
        if not MONGODB_URI:
            raise errors.ConfigurationError("MONGODB_URI is not configured.")

        # Connection pool optimized for web application (OLTP workload)
        # maxPoolSize: 50 handles concurrent test submissions
        # minPoolSize: 10 pre-warms connections for test completion spikes
        # maxIdleTimeMS: 300000 (5 min) balances connection reuse with server resources
        client = MongoClient(
            MONGODB_URI,
            maxPoolSize=50,
            minPoolSize=10,
            maxIdleTimeMS=300000,
            serverSelectionTimeoutMS=5000,
            connectTimeoutMS=10000,
            socketTimeoutMS=30000,
            retryWrites=True
        )
        db = _get_scoped_database(client)
        fs = gridfs.GridFS(db)
        client.admin.command('ping')
        print(f"MongoDB Atlas connected successfully ({db.name})")
        # Log connection pool stats
        print(f"Connection pool - max: 50, min: 10, idle timeout: 5min")
        # Initialize indexes
        _ensure_indexes()
    except errors.ConfigurationError as ce:
        db = None
        fs = None
        print(
            "MongoDB configuration issue. Check the Atlas SRV string, cluster region, "
            f"and network allowlist: {ce}"
        )
    except Exception as e:
        db = None
        fs = None
        print(f"MongoDB connection error: {e}")

def _ensure_indexes():
    """Create indexes for optimal query performance"""
    if db is None:
        return
    try:
        sessions = db[SESSIONS_COLLECTION]
        
        # Index 1: Query sessions by patient name (most common query)
        sessions.create_index("metadata.name", name="idx_patient_name", background=True)
        
        # Index 2: Query sessions by timestamp (for sorting/filtering by date)
        sessions.create_index("metadata.timestamp", name="idx_timestamp", background=True)
        
        # Index 3: Compound index for patient + timestamp queries
        sessions.create_index(
            [("metadata.name", 1), ("metadata.timestamp", -1)],
            name="idx_patient_time",
            background=True
        )
        
        print("[OK] Database indexes created/verified")
    except Exception as e:
        print(f"Warning: Could not create indexes: {e}")

init_mongodb()

# ── MODEL LOADING ──
# Drop {model_calibrated.pkl or model.pkl} / label_encoder.pkl / feature_names.pkl
# into backend/model_artifacts/ (next to this file) — see classify_endpoint_snippet.py
# and retrain_fixed.py, which this section and the /classify route are adapted from.
#
# model_calibrated.pkl is preferred over model.pkl when both exist: retrain_fixed.py
# wraps the plain XGBClassifier in a 5-fold isotonic CalibratedClassifierCV
# specifically "so confidence values are trustworthy" — raw tree-based
# probabilities tend to be overconfident, and the results screen now shows the
# Healthy/Schizophrenia percentages front and center, so the calibrated numbers
# are the ones worth showing. CalibratedClassifierCV exposes the same
# .predict_proba() interface as the plain model, so nothing else below needs to
# know which one actually loaded.
_MODEL_DIR = os.path.join(BASE, 'model_artifacts')
_MODEL_FILE_CANDIDATES = ['model_calibrated.pkl', 'model.pkl']
_clf = _label_encoder_clf = _feature_names = None
_model_source = None

for _candidate in _MODEL_FILE_CANDIDATES:
    _candidate_path = os.path.join(_MODEL_DIR, _candidate)
    if not os.path.exists(_candidate_path):
        continue
    try:
        _clf = joblib.load(_candidate_path)
        _model_source = _candidate
        break
    except Exception as e:
        print(f"[WARN] Found {_candidate} in {_MODEL_DIR} but could not load it: {e}")

try:
    _label_encoder_clf = joblib.load(os.path.join(_MODEL_DIR, 'label_encoder.pkl'))
    _feature_names     = joblib.load(os.path.join(_MODEL_DIR, 'feature_names.pkl'))
except Exception as e:
    print(f"[WARN] label_encoder.pkl / feature_names.pkl not loaded from {_MODEL_DIR}: {e}")

if _clf is not None and _label_encoder_clf is not None and _feature_names is not None:
    print(f"[OK] Classifier loaded from {_model_source} ({len(_feature_names)} features) in {_MODEL_DIR}")
else:
    _still_missing = [
        label for label, val in (
            ('model_calibrated.pkl or model.pkl', _clf),
            ('label_encoder.pkl', _label_encoder_clf),
            ('feature_names.pkl', _feature_names),
        ) if val is None
    ]
    print(f"[WARN] Classifier not fully loaded from {_MODEL_DIR}; missing: {', '.join(_still_missing)}")
    _clf = None  # /classify checks this and refuses cleanly rather than half-loading

# Kept for anything elsewhere that still imports these names.
label_encoder = _label_encoder_clf
classifier = _clf
regressor = None

REQUIRED_FEATURES = [
    'fv_fnum_mean', 'fv_fdur_mean', 'fv_snum_mean', 'fv_sdur_mean', 'fv_samp_mean',
    'fv_spv_mean', 'fv_sav_mean', 'fv_spl_mean', 'fv_disp_mean', 'HS4_Mean_H_logSNR',
    'HS4_Mean_H_RMSE', 'HS4_Mean_H_gain', 'HS4_FixNum', 'HS4_FixDur', 'HS4_SacNum',
    'HS4_SacDur', 'HS4_SacAmp', 'HS4_SacPV', 'HS4_SacAV', 'LS2_Mean_H_logSNR',
    'LS2_Mean_H_RMSE', 'LS2_Mean_H_gain', 'LS2_Mean_V_logSNR', 'LS2_Mean_V_RMSE',
    'LS2_Mean_V_gain', 'LS2_FixNum', 'LS2_FixDur', 'LS2_SacNum', 'LS2_SacDur',
    'LS2_SacAmp', 'LS2_SacPV', 'LS2_SacAV', 'LS4_Mean_H_logSNR', 'LS4_Mean_H_RMSE',
    'LS4_Mean_H_gain', 'LS4_Mean_V_logSNR', 'LS4_Mean_V_RMSE', 'LS4_Mean_V_gain',
    'LS4_FixNum', 'LS4_FixDur', 'LS4_SacNum', 'LS4_SacDur', 'LS4_SacAmp',
    'LS4_SacPV', 'LS4_SacAV', 'fix_fs_fn', 'fix_fs_fd', 'fix_fs_sn', 'fix_fs_sa',
    'fix_fs_spl', 'fix_fd_fn', 'fix_fd_fd', 'fix_fd_sn', 'fix_fd_sa', 'fix_fd_spl',
    'antisaccade_error_rate', 'antisaccade_correction_error_rate',
    'antisaccade_latency', 'antisaccade_accuracy'
]

# Column order the model was actually trained on, when available — this is
# what predict_proba() must be fed in, and it is not guaranteed to match the
# hand-maintained REQUIRED_FEATURES list above if the model is ever retrained
# with a different feature set.
_CLASSIFY_FEATURE_ORDER = _feature_names if _feature_names else REQUIRED_FEATURES


@app.route('/classify', methods=['POST'])
def classify():
    """
    Body: { "features": { <feature_name>: <value>, ... } }
    Returns the predicted label, its confidence, per-class probabilities
    (so the frontend can show a Healthy-vs-Schizophrenia split), and which
    features (if any) were missing and therefore treated as NaN by the model
    rather than a real measurement.

    This route did not exist before, which is why calls to it were coming
    back as HTTP 405: with static_url_path='/', a POST to an unmatched path
    still matches Flask's static-file route (methods GET/HEAD/OPTIONS only),
    so it fails with "Method Not Allowed" instead of a plain 404.
    """
    if _clf is None or _label_encoder_clf is None:
        return jsonify({
            'success': False,
            'error': f'Classifier not available on this server (looked in {_MODEL_DIR}). '
                     'Confirm model_calibrated.pkl (or model.pkl), label_encoder.pkl and feature_names.pkl were deployed there.'
        }), 503
    try:
        data = request.get_json(force=True, silent=True) or {}
        features = data.get('features', {})
        if not isinstance(features, dict) or not features:
            return jsonify({'success': False, 'error': 'No features provided'}), 400

        missing = [c for c in _CLASSIFY_FEATURE_ORDER if features.get(c) is None]
        row = pd.DataFrame([features]).reindex(columns=_CLASSIFY_FEATURE_ORDER)

        probs = _clf.predict_proba(row)[0]
        classes = _label_encoder_clf.classes_
        prob_map = {str(c): float(p) for c, p in zip(classes, probs)}
        pred_idx = int(np.argmax(probs))
        pred_label = str(classes[pred_idx])
        confidence = float(probs[pred_idx])

        # Pull out Healthy / Schizophrenia explicitly (rather than making the
        # frontend guess at label spelling) so the result card can show both
        # percentages regardless of how label_encoder.classes_ is ordered.
        healthy_p = next((p for c, p in prob_map.items() if c.lower().startswith('health')), None)
        schizo_p  = next((p for c, p in prob_map.items() if 'schiz' in c.lower()), None)

        return jsonify({
            'success': True,
            'prediction': {
                'label': pred_label,
                'confidence': confidence,
                'healthy_probability': healthy_p,
                'schizophrenia_probability': schizo_p,
            },
            'predicted_label': pred_label,
            'confidence': confidence,
            'class_probabilities': prob_map,
            'missing_features': missing,
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500



# ── HEATMAP GENERATION FUNCTION ──
def generate_heatmap_base64(fv_gaze_data):
    if not fv_gaze_data:
        return ""
        
    df = pd.DataFrame(fv_gaze_data)
    if 'is_blink' in df.columns:
        df_clean = df[df['is_blink'] == 0].copy()
    else:
        df_clean = df.copy()

    if df_clean.empty:
        return ""

    width = int(df_clean['x'].max()) + 100 
    height = int(df_clean['y'].max()) + 100
    
    width = min(max(width, 800), 3000)
    height = min(max(height, 600), 3000)
    
    heatmap_data = np.zeros((height, width))

    for _, row in df_clean.iterrows():
        x, y = int(row['x']), int(row['y'])
        if 0 <= x < width and 0 <= y < height:
            heatmap_data[y, x] += 1

    heatmap_smoothed = gaussian_filter(heatmap_data, sigma=30)

    plt.style.use('dark_background')
    fig, ax = plt.subplots(figsize=(10, 5.625), dpi=150)
    
    ax.imshow(heatmap_smoothed, cmap='turbo', interpolation='bilinear', 
              extent=[0, width, height, 0], aspect='auto', 
              vmin=0.001 * np.max(heatmap_smoothed)) 

    ax.set_xticks(np.arange(0, width, 100))
    ax.set_yticks(np.arange(0, height, 100))
    ax.grid(which='major', color='#333333', linestyle='-', linewidth=0.6, alpha=0.4)
    
    ax.set_xticklabels([])
    ax.set_yticklabels([])
    ax.tick_params(axis='both', which='both', length=0)
    for spine in ax.spines.values():
        spine.set_visible(False)

    buf = io.BytesIO()
    plt.tight_layout(pad=0)
    plt.savefig(buf, format='png', facecolor='black', bbox_inches='tight', pad_inches=0)
    plt.close(fig)
    buf.seek(0)
    
    b64_str = base64.b64encode(buf.read()).decode('utf-8')
    return f"data:image/png;base64,{b64_str}"

def _internal_generate_pdf(data):
    """Helper to generate PDF bytes for both report download and GridFS storage"""
    try:
        # Enforce defaults for report structure
        if 'patient' not in data: data['patient'] = {}
        data['patient'].setdefault('id', f"P_{datetime.now().strftime('%Y%m%d%H%M')}")
        data['patient'].setdefault('name', 'Unknown')
        data['patient'].setdefault('age_sex', 'N/A')
        data['patient'].setdefault('date', datetime.now().strftime('%Y-%m-%d'))
        
        if 'images' not in data: data['images'] = {}
        if data.get('fv_gaze'):
            data['images']['heatmap'] = generate_heatmap_base64(data['fv_gaze'])
        
        for key in ['spem_hs4', 'spem_ls2', 'spem_ls4', 'fix_pure', 'fix_dist']:
            data['images'].setdefault(key, "")

        if 'metrics' not in data: data['metrics'] = {}
        
        # Add PANSS score to metrics for template access
        panss_val = data.get('panss_score')
        if panss_val is not None and panss_val != 'Not recorded':
            data['metrics']['panss_score'] = panss_val
        
        # Add doctor's notes to data
        if 'doctor_notes' not in data:
            data['doctor_notes'] = ""
        
        # Add PANSS score to data (ensure it's present)
        if 'panss_score' not in data:
            data['panss_score'] = 'Not recorded'
        
        # No AI predictions in data collection mode — omit predictions block

        rendered_html = render_template("report_template.html", data=data)
        return HTML(string=rendered_html).write_pdf(pdf_variant='pdf/a-1b')
    except Exception as e:
        traceback.print_exc()
        raise e


def _ensure_binary_payload(payload, file_label):
    if isinstance(payload, Binary):
        return payload
    if isinstance(payload, (bytes, bytearray)):
        return Binary(bytes(payload))
    raise TypeError(f"{file_label} must be uploaded as Binary-compatible bytes.")


def _json_rows_to_csv_binary(json_data):
    output = io.StringIO()
    pd.DataFrame(json_data).to_csv(output, index=False)
    return _ensure_binary_payload(output.getvalue().encode('utf-8'), "CSV payload")


def _serialize_sz_csv(sz_data):
    if isinstance(sz_data, list) and sz_data and isinstance(sz_data[0], str):
        sz_csv_str = "Timestamp_ms,Phase,Gaze_X,Gaze_Y,Target_X,Target_Y\n" + "\n".join(sz_data)
        return _ensure_binary_payload(sz_csv_str.encode('utf-8'), "SZ CSV payload")
    return _json_rows_to_csv_binary(sz_data)


def _upload_to_gridfs(binary_payload, filename, content_type, metadata):
    payload = _ensure_binary_payload(binary_payload, filename)
    return fs.put(payload, filename=filename, content_type=content_type, metadata=metadata)

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok', 
        'mode': 'data_collection',
        'mongodb_connected': db is not None,
        'mongodb_db': db.name if db is not None else None
    })

# ── SESSION DATA ROUTES ──────────────────────────────────────────────────────

@app.route('/sessions', methods=['GET','OPTIONS'])
def get_sessions():
    """Return summary list of all sessions for the dashboard."""
    if db is None:
        return jsonify({'success': False, 'error': 'Database not connected'}), 503
    try:
        col = db[SESSIONS_COLLECTION]
        docs = list(col.find({}, {
            '_id': 1, 'metadata': 1,
            'results.panss_score': 1,
            'results.features': 1,
            'notes': 1, 'notes_author': 1,
            'gridfs_refs.report_id': 1
        }).sort('metadata.timestamp', -1).limit(200))
        sessions = []
        for d in docs:
            sid = str(d['_id'])
            meta = d.get('metadata', {})
            res  = d.get('results', {})
            ts   = meta.get('timestamp')
            sessions.append({
                'id': sid,
                'patient_id': meta.get('patient_id', 'N/A'),
                'subject_id': meta.get('subject_id', meta.get('patient_id', 'N/A')),
                'name':    meta.get('name', 'Unknown'),
                'age':     meta.get('age', 'N/A'),
                'gender':  meta.get('gender', 'N/A'),
                'date':    ts.strftime('%d %b %Y, %H:%M') if ts else 'N/A',
                'panss':   res.get('panss_score', 'N/A'),
                'features': res.get('features', {}),
                'notes':   d.get('notes', ''),
                'notes_author': d.get('notes_author', ''),
                'has_report': bool(d.get('gridfs_refs', {}).get('report_id'))
            })
        return jsonify({'success': True, 'sessions': sessions})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/sessions/search', methods=['GET'])
def search_sessions():
    """Search sessions by patient name or patient_id."""
    if db is None:
        return jsonify({'success': False, 'error': 'Database not connected'}), 503
    try:
        query = request.args.get('q', '').strip()
        if not query:
            return jsonify({'success': True, 'sessions': []})
        
        col = db[SESSIONS_COLLECTION]
        # Search by patient name or patient_id (case-insensitive)
        search_filter = {
            '$or': [
                {'metadata.name': {'$regex': query, '$options': 'i'}},
                {'metadata.patient_id': {'$regex': query, '$options': 'i'}}
            ]
        }
        docs = list(col.find(search_filter, {
            '_id': 1, 'metadata': 1,
            'results.panss_score': 1,
            'results.features': 1,
            'notes': 1, 'notes_author': 1,
            'gridfs_refs.report_id': 1
        }).sort('metadata.timestamp', -1).limit(50))
        
        sessions = []
        for d in docs:
            sid = str(d['_id'])
            meta = d.get('metadata', {})
            res  = d.get('results', {})
            ts   = meta.get('timestamp')
            sessions.append({
                'id': sid,
                'patient_id': meta.get('patient_id', 'N/A'),
                'subject_id': meta.get('subject_id', meta.get('patient_id', 'N/A')),
                'name':    meta.get('name', 'Unknown'),
                'age':     meta.get('age', 'N/A'),
                'gender':  meta.get('gender', 'N/A'),
                'date':    ts.strftime('%d %b %Y, %H:%M') if ts else 'N/A',
                'panss':   res.get('panss_score', 'N/A'),
                'features': res.get('features', {}),
                'notes':   d.get('notes', ''),
                'notes_author': d.get('notes_author', ''),
                'has_report': bool(d.get('gridfs_refs', {}).get('report_id'))
            })
        return jsonify({'success': True, 'sessions': sessions})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/sessions/<session_id>/pdf', methods=['GET'])
def download_session_pdf(session_id):
    """Stream the stored PDF report for a session."""
    if db is None:
        return jsonify({'error': 'DB not connected'}), 503
    try:
        from bson import ObjectId
        import gridfs
        col = db[SESSIONS_COLLECTION]
        doc = col.find_one({'_id': ObjectId(session_id)})
        if not doc:
            return jsonify({'error': 'Session not found'}), 404
        report_id = doc.get('gridfs_refs', {}).get('report_id')
        if not report_id:
            # No stored PDF — regenerate on the fly with current data including PANSS
            meta = doc.get('metadata', {})
            res  = doc.get('results', {})
            # In download_session_pdf(), replace the pdf_data block:
            pdf_data = {
                'patient': {
                    'id': meta.get('patient_id', session_id),
                    'name': meta.get('name', 'Unknown'),
                    'age_sex': f"{meta.get('age','N/A')} / {meta.get('gender','N/A')}",
                    'date': meta.get('timestamp', datetime.now()).strftime('%d %b %Y') if hasattr(meta.get('timestamp', ''), 'strftime') else str(meta.get('timestamp', ''))
                },
                'panss_score': res.get('panss_score') or 'Not recorded',   # ← WAS MISSING
                'metrics': res.get('features', {}),
                'doctor_notes': doc.get('notes', ''),                       # ← WAS MISSING
                'fv_gaze': [],
                'images': {}
            }
            try:
                pdf_bytes = _internal_generate_pdf(pdf_data)
                from flask import Response
                return Response(pdf_bytes, mimetype='application/pdf',
                    headers={'Content-Disposition': f'attachment; filename=report_{session_id}.pdf'})
            except Exception as gen_err:
                return jsonify({'error': f'No PDF stored and regeneration failed: {gen_err}'}), 404
        fs_local = gridfs.GridFS(db)
        grid_file = fs_local.get(report_id)
        from flask import Response
        return Response(
            grid_file.read(),
            mimetype='application/pdf',
            headers={'Content-Disposition': f'attachment; filename=report_{session_id}.pdf'}
        )
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/sessions/<session_id>/csv/<csv_type>', methods=['GET'])
def download_session_csv(session_id, csv_type):
    """Download fv / spem / sz raw gaze CSV for a session."""
    if db is None:
        return jsonify({'error': 'DB not connected'}), 503
    try:
        from bson import ObjectId
        import gridfs
        col = db[SESSIONS_COLLECTION]
        doc = col.find_one({'_id': ObjectId(session_id)})
        if not doc:
            return jsonify({'error': 'Session not found'}), 404
        key_map = {'fv': 'fv_id', 'spem': 'spem_id', 'sz': 'sz_id'}
        ref_key = key_map.get(csv_type)
        if not ref_key:
            return jsonify({'error': f'Unknown csv_type {csv_type}'}), 400
        gid = doc.get('gridfs_refs', {}).get(ref_key)
        if not gid:
            return jsonify({'error': f'No {csv_type} CSV for this session'}), 404
        fs = gridfs.GridFS(db)
        grid_file = fs.get(gid)
        from flask import Response
        return Response(
            grid_file.read(),
            mimetype='text/csv',
            headers={'Content-Disposition': f'attachment; filename={csv_type}_{session_id}.csv'}
        )
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/sessions/export_all_features', methods=['GET'])
def export_all_features():
    """Export all sessions' 59 features as one big CSV."""
    if db is None:
        return jsonify({'error': 'DB not connected'}), 503
    try:
        import csv, io
        col = db[SESSIONS_COLLECTION]
        docs = list(col.find({}, {'metadata': 1, 'results.features': 1, 'results.panss_score': 1}).sort('metadata.timestamp', -1))
        output = io.StringIO()
        fieldnames = ['session_id', 'name', 'date', 'panss_score'] + REQUIRED_FEATURES
        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()
        for d in docs:
            meta = d.get('metadata', {})
            res  = d.get('results', {})
            feats = res.get('features', {})
            row = {
                'session_id': str(d['_id']),
                'name': meta.get('name', ''),
                'date': meta.get('timestamp', ''),
                'panss_score': res.get('panss_score', '')
            }
            for f in REQUIRED_FEATURES:
                row[f] = feats.get(f, '')
            writer.writerow(row)
        from flask import Response
        return Response(
            output.getvalue(),
            mimetype='text/csv',
            headers={'Content-Disposition': 'attachment; filename=all_features_export.csv'}
        )
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/save_results', methods=['POST'])
def save_results():
    global db, fs
    print("[DEBUG] /save_results called. Checking DB connection...")
    if db is None or fs is None:
        print("[DEBUG] DB is None! Attempting to reconnect...")
        init_mongodb()
        
    if db is None or fs is None:
        print("[DEBUG] DB is still None after reconnection attempt!")
        return jsonify({'error': 'MongoDB not connected'}), 500
    
    try:
        print("[DEBUG] Attempting to parse JSON payload...")
        data = request.get_json()
        print(f"[DEBUG] JSON parsed successfully. Payload keys: {list(data.keys())}")
        
        subject_id = data.get('subject_id', 'Unknown')
        timestamp = datetime.now()
        gridfs_refs = {}
        storage_metadata = {
            'database': db.name,
            'subject_id': subject_id,
            'stored_at': timestamp
        }

        # 1. Upload GridFS assets before creating the clinical session record.
        if 'fv_gaze' in data:
            try:
                print("[DEBUG] Converting fv_gaze to CSV...")
                fv_csv = _json_rows_to_csv_binary(data['fv_gaze'])
                print("[DEBUG] Uploading fv_gaze to GridFS...")
                gridfs_refs['fv_id'] = _upload_to_gridfs(
                    fv_csv,
                    filename=f"fv_{subject_id}_{timestamp.strftime('%Y%m%d%H%M')}.csv",
                    content_type='text/csv',
                    metadata={**storage_metadata, 'kind': 'fv_csv'}
                )
                print(f"[DEBUG] fv_gaze uploaded: {gridfs_refs['fv_id']}")
            except Exception as e:
                print(f"[WARN] FV CSV upload failed; session data will still be saved: {e}")

        if 'spem_gaze' in data:
            try:
                print("[DEBUG] Converting spem_gaze to CSV...")
                spem_csv = _json_rows_to_csv_binary(data['spem_gaze'])
                print("[DEBUG] Uploading spem_gaze to GridFS...")
                gridfs_refs['spem_id'] = _upload_to_gridfs(
                    spem_csv,
                    filename=f"spem_{subject_id}_{timestamp.strftime('%Y%m%d%H%M')}.csv",
                    content_type='text/csv',
                    metadata={**storage_metadata, 'kind': 'spem_csv'}
                )
                print(f"[DEBUG] spem_gaze uploaded: {gridfs_refs['spem_id']}")
            except Exception as e:
                print(f"[WARN] SPEM CSV upload failed; session data will still be saved: {e}")

        if 'sz_gaze' in data:
            try:
                print("[DEBUG] Converting sz_gaze to CSV...")
                sz_csv = _serialize_sz_csv(data['sz_gaze'])
                print("[DEBUG] Uploading sz_gaze to GridFS...")
                gridfs_refs['sz_id'] = _upload_to_gridfs(
                    sz_csv,
                    filename=f"sz_{subject_id}_{timestamp.strftime('%Y%m%d%H%M')}.csv",
                    content_type='text/csv',
                    metadata={**storage_metadata, 'kind': 'sz_csv'}
                )
                print(f"[DEBUG] sz_gaze uploaded: {gridfs_refs['sz_id']}")
            except Exception as e:
                print(f"[WARN] SZ CSV upload failed; session data will still be saved: {e}")

        # 2. Generate and Upload PDF Report
        try:
            print("[DEBUG] Preparing PDF payload...")
            # In save_results(), replace the pdf_payload block:
            pdf_payload = {
                'patient': {
                    'id': subject_id,
                    'name': data.get('patient_name', subject_id),
                    'age_sex': f"{data.get('patient_age', 'N/A')} / {data.get('patient_gender', 'N/A')}",
                    'date': timestamp.strftime('%d %b %Y')
                },
                'panss_score': data.get('panss_score') or 'Not recorded',   # ← ADD THIS LINE
                'metrics': data.get('features', {}),
                'fv_gaze': data.get('fv_gaze', []),
                'doctor_notes': data.get('notes', ''),
                'images': {
                    'spem_hs4': data.get('image_spem_hs4', ''),
                    'spem_ls2': data.get('image_spem_ls2', ''),
                    'spem_ls4': data.get('image_spem_ls4', ''),
                    'fix_pure': data.get('image_fix_pure', ''),
                    'fix_dist': data.get('image_fix_dist', '')
                }
            }
            print("[DEBUG] Generating PDF bytes...")
            pdf_bytes = _internal_generate_pdf(pdf_payload)
            print("[DEBUG] Uploading PDF to GridFS...")
            gridfs_refs['report_id'] = _upload_to_gridfs(
                pdf_bytes,
                filename=f"Report_{subject_id}_{timestamp.strftime('%Y%m%d%H%M')}.pdf",
                content_type='application/pdf',
                metadata={**storage_metadata, 'kind': 'pdf_report'}
            )
            print(f"[DEBUG] PDF uploaded: {gridfs_refs['report_id']}")
        except Exception as pdf_err:
            print(f"Warning: PDF generation/upload failed: {pdf_err}")

        # 3. Create Main Session Document
        print("[DEBUG] Creating main session document...")
        # Generate unique patient_id if not provided
        patient_id = data.get('patient_id') or f"PAT-{uuid.uuid4().hex[:8].upper()}"
        
        session_doc = {
            "metadata": {
                "patient_id": patient_id,
                "subject_id": subject_id,
                "name": data.get('patient_name', subject_id),
                "age": data.get('patient_age', 'N/A'),
                "gender": data.get('patient_gender', 'N/A'),
                "screen_size": data.get('screen_size', 'N/A'),
                "timestamp": timestamp
            },
            "results": {
                "panss_score": data.get('panss_score'),  # store as-is (None/null → None in Mongo)
                "features": data.get('features', {})
            },
            "notes": data.get('notes', ""),
            "notes_author": data.get('notes_author', "unknown"),
            "gridfs_refs": {
                key: value for key, value in (
                    ('fv_id', gridfs_refs.get('fv_id')),
                    ('spem_id', gridfs_refs.get('spem_id')),
                    ('sz_id', gridfs_refs.get('sz_id')),
                    ('report_id', gridfs_refs.get('report_id'))
                ) if value is not None
            }
        }

        print("[DEBUG] Inserting session into MongoDB...")
        insert_result = db[SESSIONS_COLLECTION].insert_one(session_doc)
        print(f"[DEBUG] Session inserted with ID: {insert_result.inserted_id}")
        return jsonify({
            'success': True,
            'message': 'Session saved to MongoDB Atlas successfully',
            'session_id': str(insert_result.inserted_id),
            'patient_id': patient_id,
            'gridfs_refs': {key: str(value) for key, value in session_doc['gridfs_refs'].items()}
        })

    except errors.ConfigurationError as e:
        print(f"[ERROR] ConfigurationError: {e}")
        return jsonify({
            'error': (
                'MongoDB Atlas configuration issue detected. '
                'Please verify the SRV region or cluster accessibility.'
            ),
            'details': str(e)
        }), 503
    except errors.PyMongoError as e:
        print(f"[ERROR] PyMongoError: {e}")
        if "quota exceeded" in str(e).lower() or "WriteError" in str(e):
            return jsonify({'error': 'Storage limit reached (512MB). Please archive old data.', 'limit_error': True}), 507
        return jsonify({'error': f'Database error: {str(e)}'}), 500
    except Exception as e:
        print(f"[ERROR] General Exception: {e}")
        return jsonify({'error': f'Server error: {str(e)}'}), 500

@app.route('/sessions/<session_id>/notes', methods=['POST'])
def save_notes(session_id):
    if db is None:
        return jsonify({'success': False, 'error': 'Database not connected'}), 503
    try:
        from bson import ObjectId
        data = request.get_json()
        notes = data.get('notes', '')
        author = data.get('author', 'unknown')
        col = db[SESSIONS_COLLECTION]

        # Fetch the session to rebuild the PDF
        doc = col.find_one({'_id': ObjectId(session_id)})
        if not doc:
            return jsonify({'success': False, 'error': 'Session not found'}), 404

        meta = doc.get('metadata', {})
        res  = doc.get('results', {})
        ts   = meta.get('timestamp', datetime.now())

        # Update notes first
        col.update_one(
            {'_id': ObjectId(session_id)},
            {'$set': {'notes': notes, 'notes_author': author, 'notes_updated_at': datetime.now()}}
        )

        # Regenerate PDF with updated notes
        try:
            pdf_payload = {
                'patient': {
                    'id': meta.get('patient_id', session_id),
                    'name': meta.get('name', 'Unknown'),
                    'age_sex': f"{meta.get('age','N/A')} / {meta.get('gender','N/A')}",
                    'date': ts.strftime('%d %b %Y') if hasattr(ts, 'strftime') else str(ts)
                },
                'panss_score': res.get('panss_score') or 'Not recorded',
                'metrics': res.get('features', {}),
                'doctor_notes': notes,   # ← the NEW notes
                'fv_gaze': [],
                'images': {}
            }
            pdf_bytes = _internal_generate_pdf(pdf_payload)

            # Delete old PDF from GridFS if it exists
            old_report_id = doc.get('gridfs_refs', {}).get('report_id')
            if old_report_id:
                try:
                    fs.delete(old_report_id)
                except Exception:
                    pass

            # Store new PDF
            subject_id = meta.get('subject_id', session_id)
            new_report_id = fs.put(
                pdf_bytes,
                filename=f"Report_{subject_id}_{datetime.now().strftime('%Y%m%d%H%M')}.pdf",
                content_type='application/pdf',
                metadata={'kind': 'pdf_report', 'subject_id': subject_id}
            )
            col.update_one(
                {'_id': ObjectId(session_id)},
                {'$set': {'gridfs_refs.report_id': new_report_id}}
            )
        except Exception as pdf_err:
            print(f"Warning: PDF regeneration failed after notes save: {pdf_err}")
            # Notes are already saved; PDF regeneration failure is non-fatal

        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/analytics', methods=['GET'])
def get_analytics():
    """Return aggregated analytics data for charts."""
    if db is None:
        return jsonify({'success': False, 'error': 'Database not connected'}), 503
    try:
        col = db[SESSIONS_COLLECTION]
        docs = list(col.find({}, {
            'metadata': 1,
            'results.panss_score': 1,
            'results.features': 1
        }).sort('metadata.timestamp', -1).limit(500))

        # Build timeline: sessions per day (last 30 days)
        from collections import defaultdict
        daily_counts = defaultdict(int)
        panss_scores = []
        feature_avgs = defaultdict(list)
        genders = defaultdict(int)
        ages = []

        for d in docs:
            meta = d.get('metadata', {})
            res  = d.get('results', {})
            ts   = meta.get('timestamp')
            if ts:
                day = ts.strftime('%Y-%m-%d')
                daily_counts[day] += 1
            panss = res.get('panss_score')
            if panss is not None and panss != 'N/A':
                try:
                    panss_scores.append(float(panss))
                except (ValueError, TypeError):
                    pass
            gender = meta.get('gender', 'Unknown')
            genders[gender] += 1
            age = meta.get('age')
            if age and age != 'N/A':
                try:
                    ages.append(int(age))
                except (ValueError, TypeError):
                    pass
            feats = res.get('features', {})
            for k, v in feats.items():
                if v is not None and v != '' and v == v:  # not NaN
                    try:
                        feature_avgs[k].append(float(v))
                    except (ValueError, TypeError):
                        pass

        # Sort daily counts
        sorted_days = sorted(daily_counts.items())[-30:]

        # Feature averages (for key features)
        KEY_FEATURES = [
            'fv_fnum_mean', 'fv_fdur_mean', 'fv_samp_mean',
            'HS4_Mean_H_gain', 'HS4_SacNum',
            'antisaccade_error_rate', 'antisaccade_accuracy',
            'fix_fs_fn', 'fix_fd_fn'
        ]
        feat_summary = {}
        for k in KEY_FEATURES:
            vals = feature_avgs.get(k, [])
            if vals:
                feat_summary[k] = {
                    'mean': round(sum(vals)/len(vals), 3),
                    'min':  round(min(vals), 3),
                    'max':  round(max(vals), 3),
                    'n':    len(vals)
                }

        return jsonify({
            'success': True,
            'total_sessions': len(docs),
            'daily_counts': [{'date': d, 'count': c} for d, c in sorted_days],
            'panss_distribution': panss_scores,
            'gender_distribution': dict(genders),
            'age_distribution': ages,
            'feature_averages': feat_summary
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/generate-report', methods=['POST'])
def generate_report():
    try:
        data = request.get_json()
        pdf = _internal_generate_pdf(data)
        
        safe_id = str(data.get('patient', {}).get('id', 'report')).replace('/', '_').replace('\\', '_')
        filename = f"Report_{safe_id}.pdf"
        
        return send_file(
            io.BytesIO(pdf),
            mimetype='application/pdf',
            as_attachment=True,
            download_name=filename
        )
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    port = int(os.getenv('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)