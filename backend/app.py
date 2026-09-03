from flask import Flask, request, jsonify, render_template, send_file, session
from flask_cors import CORS
import joblib
import pandas as pd
import json
import os
from datetime import datetime
import io
import base64
import traceback
import uuid

# MongoDB Imports
from pymongo import MongoClient, errors
import gridfs
from bson.binary import Binary
from bson.objectid import ObjectId
from dotenv import load_dotenv
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

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

# ── FLASK APP SETUP ──────────────────────────────────────────────────────────
# template_folder defaults to 'templates/' relative to this file (backend/templates/)
app = Flask(__name__, template_folder="templates")
app.secret_key = os.getenv("SECRET_KEY", secrets.token_hex(32))

# CORS: restrict origins in production via the CORS_ORIGINS env var.
# Set CORS_ORIGINS=https://your-app.vercel.app in Render dashboard.
# Multiple origins: CORS_ORIGINS=https://a.vercel.app,https://b.com
_cors_origins = os.getenv("CORS_ORIGINS", "*")
if _cors_origins != "*":
    _cors_origins = [o.strip() for o in _cors_origins.split(",")]
CORS(app, origins=_cors_origins, supports_credentials=True)

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

INTEGRATION_API_KEY = os.getenv("INTEGRATION_API_KEY")
TEST_FRONTEND_URL = os.getenv("TEST_FRONTEND_URL", "https://your-frontend.example.com/index.html")
TEST_TOKEN_MAX_AGE = int(os.getenv("TEST_TOKEN_MAX_AGE", "3600"))
test_token_serializer = URLSafeTimedSerializer(app.secret_key, salt="schizoeye-test")


def _test_token_is_valid():
    token = request.headers.get("X-Test-Token", "")
    if not token:
        return False
    try:
        test_token_serializer.loads(token, max_age=TEST_TOKEN_MAX_AGE)
        return True
    except (BadSignature, SignatureExpired):
        return False


def _caller_is_authorized():
    return _test_token_is_valid() or bool(session.get("user"))


@app.route('/integration/test-sessions', methods=['POST'])
def create_test_session():
    if not INTEGRATION_API_KEY or request.headers.get("X-Integration-Key") != INTEGRATION_API_KEY:
        return jsonify({'success': False, 'error': 'Invalid integration credentials'}), 401
    data = request.get_json(silent=True) or {}
    payload = {
        'external_reference': str(data.get('external_reference', ''))[:200],
        'issued_at': datetime.utcnow().isoformat()
    }
    token = test_token_serializer.dumps(payload)
    separator = '&' if '?' in TEST_FRONTEND_URL else '?'
    return jsonify({
        'success': True,
        'test_url': f'{TEST_FRONTEND_URL}{separator}mode=test&token={token}',
        'expires_in': TEST_TOKEN_MAX_AGE
    })

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

BASE = os.path.dirname(os.path.abspath(__file__))

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

# ── MODEL LOADING ────────────────────────────────────────────────────────────
# The deployed artifacts are the binary model produced by retrain_fixed.py:
# Healthy versus Schizophrenia. The source dataset still contains HC/FES/CSZ.
MODEL_DIR = os.getenv("MODEL_DIR", os.path.join(BASE, "model_artifacts"))
MODEL_FILE = os.getenv("MODEL_FILE", "model_calibrated.pkl")
MODEL_PATH = os.path.join(MODEL_DIR, MODEL_FILE)
LABEL_ENCODER_PATH = os.path.join(MODEL_DIR, "label_encoder.pkl")
FEATURE_NAMES_PATH = os.path.join(MODEL_DIR, "feature_names.pkl")
label_encoder = classifier = None
MODEL_FEATURES = []
try:
    classifier = joblib.load(MODEL_PATH)
    label_encoder = joblib.load(LABEL_ENCODER_PATH)
    MODEL_FEATURES = list(joblib.load(FEATURE_NAMES_PATH))
    if len(MODEL_FEATURES) != 59:
        raise ValueError(f"Expected 59 model features, found {len(MODEL_FEATURES)}")
    print(f"[OK] Model loaded: {MODEL_FILE} ({len(MODEL_FEATURES)} features)")
except Exception as e:
    print(f"[WARN] Model not loaded: {e}")

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

if REQUIRED_FEATURES != MODEL_FEATURES and MODEL_FEATURES:
    raise RuntimeError("Application feature schema does not match feature_names.pkl")


def _validated_features(features):
    if not isinstance(features, dict):
        raise ValueError("features must be an object containing exactly 59 named values")
    expected = MODEL_FEATURES or REQUIRED_FEATURES
    missing = [name for name in expected if name not in features]
    extra = [name for name in features if name not in expected]
    if missing or extra:
        raise ValueError(f"Feature schema mismatch; missing={missing}, extra={extra}")
    cleaned = {}
    for name in expected:
        value = features[name]
        if value is None or not isinstance(value, (int, float)) or not np.isfinite(value):
            raise ValueError(f"Feature {name} must be a finite number")
        cleaned[name] = float(value)
    return cleaned


def _classify_features(features):
    cleaned = _validated_features(features)
    row = pd.DataFrame([[cleaned[name] for name in MODEL_FEATURES or REQUIRED_FEATURES]],
                       columns=MODEL_FEATURES or REQUIRED_FEATURES)
    probabilities = classifier.predict_proba(row)[0]
    classes = label_encoder.classes_
    probability_map = {str(label): float(probability)
                       for label, probability in zip(classes, probabilities)}
    predicted_index = int(np.argmax(probabilities))
    return {
        "label": str(classes[predicted_index]),
        "confidence": float(probabilities[predicted_index]),
        "probabilities": probability_map,
    }, cleaned

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
        
        # Prediction is optional for direct report generation, but is included
        # automatically for reports created by /save_results.

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
        'mode': 'inference',
        'model_loaded': classifier is not None,
        'model_file': MODEL_FILE if classifier is not None else None,
        'mongodb_connected': db is not None,
        'mongodb_db': db.name if db is not None else None
    })

@app.route('/classify', methods=['POST'])
def classify():
    if not _caller_is_authorized():
        return jsonify({'success': False, 'error': 'Authentication required'}), 401
    if classifier is None or label_encoder is None:
        return jsonify({'success': False, 'error': 'Classifier not available'}), 503
    try:
        data = request.get_json(silent=True) or {}
        prediction, cleaned = _classify_features(data.get('features'))
        return jsonify({
            'success': True,
            'prediction': prediction,
            'features': cleaned,
            'feature_order': MODEL_FEATURES or REQUIRED_FEATURES
        })
    except ValueError as e:
        return jsonify({'success': False, 'error': str(e)}), 400
    except Exception as e:
        traceback.print_exc()
        return jsonify({'success': False, 'error': 'Inference failed'}), 500

# ── SESSION DATA ROUTES ──────────────────────────────────────────────────────

@app.route('/sessions', methods=['GET'])
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
        docs = list(col.find(
            {},
            {'metadata': 1, 'results.features': 1, 'results.panss_score': 1,
             'results.feature_quality': 1, 'results.capture_diagnostics': 1}
        ).sort('metadata.timestamp', -1))
        output = io.StringIO()
        # FIX ACC-3 / ACC-4: surface per-session data-quality/capture-rate summary
        # columns alongside the 59 features, instead of exporting the numbers with
        # no way to tell which ones are real measurements vs missing-data floor
        # substitutes vs clipped values, or how fast each session was actually
        # captured. Anyone building a training set from this CSV needs this to
        # avoid learning from silently-injected artifacts (see battery-controller.js
        # finalizeFeature() comments for why that risk is concrete, not theoretical).
        summary_cols = ['n_features_missing', 'n_features_clipped',
                         'capture_hz_free_viewing', 'capture_hz_spem_min', 'capture_hz_sz_min']
        fieldnames = ['session_id', 'name', 'date', 'panss_score'] + summary_cols + REQUIRED_FEATURES
        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()
        for d in docs:
            meta = d.get('metadata', {})
            res  = d.get('results', {})
            feats = res.get('features', {})
            quality = res.get('feature_quality', {}) or {}
            capture = res.get('capture_diagnostics', {}) or {}

            def _min_hz(phase_map):
                hz_vals = [v.get('hz') for v in (phase_map or {}).values() if isinstance(v, dict) and v.get('hz')]
                return round(min(hz_vals), 1) if hz_vals else ''

            row = {
                'session_id': str(d['_id']),
                'name': meta.get('name', ''),
                'date': meta.get('timestamp', ''),
                'panss_score': res.get('panss_score', ''),
                'n_features_missing': sum(1 for q in quality.values() if q == 'missing'),
                'n_features_clipped': sum(1 for q in quality.values() if q in ('clipped_low', 'clipped_high')),
                'capture_hz_free_viewing': (capture.get('freeViewing') or {}).get('hz', ''),
                'capture_hz_spem_min': _min_hz(capture.get('spem')),
                'capture_hz_sz_min': _min_hz(capture.get('sz')),
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
    if not _caller_is_authorized():
        return jsonify({'success': False, 'error': 'Authentication required'}), 401
    print("[DEBUG] /save_results called. Checking DB connection...")
    if db is None or fs is None:
        print("[DEBUG] DB is None! Attempting to reconnect...")
        init_mongodb()
        
    if db is None or fs is None:
        print("[DEBUG] DB is still None after reconnection attempt!")
        return jsonify({'error': 'MongoDB not connected'}), 500
    
    try:
        print("[DEBUG] Attempting to parse JSON payload...")
        data = request.get_json(silent=True) or {}
        print(f"[DEBUG] JSON parsed successfully. Payload keys: {list(data.keys())}")
        prediction, validated_features = _classify_features(data.get('features'))
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

        if 'spem_gaze' in data:
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

        if 'sz_gaze' in data:
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
                'metrics': validated_features,
                'prediction': prediction,
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
                "features": validated_features,
                "feature_order": MODEL_FEATURES or REQUIRED_FEATURES,
                "prediction": prediction,
                # FIX ACC-3 / ACC-4 (battery-controller.js): persist the per-feature
                # data-quality flags (real vs missing-floor vs clipped) and the
                # empirical per-task capture-rate diagnostics that the frontend now
                # computes and sends. Previously these were silently dropped here
                # even after the frontend started sending them, which would have
                # made the fix a no-op for anything actually saved to the database.
                "feature_quality": data.get('feature_quality', data.get('data_quality', {})),
                "capture_diagnostics": data.get('capture_diagnostics', {})
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
            'prediction': prediction,
            'features': validated_features,
            'feature_order': MODEL_FEATURES or REQUIRED_FEATURES,
            'report_url': f"/sessions/{insert_result.inserted_id}/pdf",
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
