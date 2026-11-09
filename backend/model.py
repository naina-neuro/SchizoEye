"""Loads the trained XGBoost classifier, its label encoder, and the feature-name list the /classify route
needs. Importing this module is what triggers the (one-time, at-startup) load from backend/model_artifacts/.
"""
import os
import joblib

from constants import REQUIRED_FEATURES

BASE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(BASE, 'model_artifacts')

clf = label_encoder = feature_names = None

try:
    clf = joblib.load(os.path.join(MODEL_DIR, 'model.pkl'))
except Exception as e:
    print(f"[WARN] model.pkl not loaded from {MODEL_DIR}: {e}")

try:
    label_encoder = joblib.load(os.path.join(MODEL_DIR, 'label_encoder.pkl'))
    feature_names = joblib.load(os.path.join(MODEL_DIR, 'feature_names.pkl'))
except Exception as e:
    print(f"[WARN] label_encoder.pkl / feature_names.pkl not loaded from {MODEL_DIR}: {e}")

if clf is not None and label_encoder is not None and feature_names is not None:
    print(f"[OK] XGBoost classifier loaded from model.pkl ({len(feature_names)} features) in {MODEL_DIR}")
else:
    _still_missing = [
        label for label, val in (
            ('model.pkl', clf),
            ('label_encoder.pkl', label_encoder),
            ('feature_names.pkl', feature_names),
        ) if val is None
    ]
    print(f"[WARN] Classifier not fully loaded from {MODEL_DIR}; missing: {', '.join(_still_missing)}")
    clf = None

# Feature order used to build the DataFrame row fed to predict_proba: prefer the order baked into
# feature_names.pkl (matches exactly how the model was trained), falling back to REQUIRED_FEATURES
# if that artifact is missing.
CLASSIFY_FEATURE_ORDER = feature_names if feature_names else REQUIRED_FEATURES
