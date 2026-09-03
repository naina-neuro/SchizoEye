# ─────────────────────────────────────────────────────────────────────────
# Add this to app.py. Drop model.pkl / label_encoder.pkl / feature_names.pkl
# (from this delivery) into a folder next to app.py, e.g. backend/model_artifacts/
# ─────────────────────────────────────────────────────────────────────────
import joblib
import numpy as np

_MODEL_DIR = os.path.join(BASE, 'model_artifacts')
_clf = _label_encoder_clf = _feature_names = None
try:
    _clf              = joblib.load(os.path.join(_MODEL_DIR, 'model.pkl'))
    _label_encoder_clf = joblib.load(os.path.join(_MODEL_DIR, 'label_encoder.pkl'))
    _feature_names    = joblib.load(os.path.join(_MODEL_DIR, 'feature_names.pkl'))
    print(f"[OK] XGBoost classifier loaded ({len(_feature_names)} features)")
except Exception as e:
    print(f"[WARN] Classifier not loaded: {e}")


@app.route('/classify', methods=['POST'])
def classify():
    """
    Body: { "features": { <59 feature_name>: <value>, ... } }
    Returns predicted_label, confidence, per-class probabilities, and which
    features (if any) were missing/None and therefore treated as NaN by the
    model rather than a real measurement.
    """
    if _clf is None:
        return jsonify({'success': False, 'error': 'Classifier not available on this server'}), 503
    try:
        data = request.get_json()
        features = data.get('features', {})

        missing = [c for c in _feature_names if features.get(c) is None]
        row = pd.DataFrame([features]).reindex(columns=_feature_names)

        probs = _clf.predict_proba(row)[0]
        classes = _label_encoder_clf.classes_
        prob_map = {str(c): float(p) for c, p in zip(classes, probs)}
        pred_idx = int(np.argmax(probs))

        return jsonify({
            'success': True,
            'predicted_label': str(classes[pred_idx]),
            'confidence': float(probs[pred_idx]),
            'class_probabilities': prob_map,
            'missing_features': missing,
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500
