"""Validates a submitted 59-feature vector and runs it through the loaded XGBoost classifier.
Split out of the /classify route so the validation rules can be unit-tested without a Flask request."""
import math

import numpy as np
import pandas as pd

import model as model_module


def classify_features(features):
    """Validate `features` (a dict) against model_module.CLASSIFY_FEATURE_ORDER and return
    (response_body, http_status) — the exact shape the /classify route has always returned."""
    if model_module.clf is None or model_module.label_encoder is None:
        return {
            'success': False,
            'error': f'Classifier not available on this server (looked in {model_module.MODEL_DIR}). '
                     'Confirm model.pkl, label_encoder.pkl and feature_names.pkl were deployed there.'
        }, 503

    if not isinstance(features, dict) or not features:
        return {'success': False, 'error': 'No features provided'}, 400

    order = model_module.CLASSIFY_FEATURE_ORDER
    missing = [c for c in order if features.get(c) is None]

    # Validate every non-missing feature is numeric and finite before it ever reaches the model.
    # `missing` was previously computed but never checked, so incomplete/garbled payloads (NaN,
    # strings, None) were silently reindexed to NaN and passed straight into predict_proba.
    invalid = []
    for c in order:
        if c in missing:
            continue
        try:
            fv = float(features.get(c))
        except (TypeError, ValueError):
            invalid.append(c)
            continue
        if not math.isfinite(fv):
            invalid.append(c)

    if missing or invalid:
        return {
            'success': False,
            'error': 'Feature vector is incomplete or contains non-numeric/non-finite values.',
            'missing_features': missing,
            'invalid_features': invalid,
        }, 400

    row = pd.DataFrame([features]).reindex(columns=order)

    probs = model_module.clf.predict_proba(row)[0]
    classes = model_module.label_encoder.classes_
    prob_map = {str(c): float(p) for c, p in zip(classes, probs)}
    pred_idx = int(np.argmax(probs))
    pred_label = str(classes[pred_idx])
    confidence = float(probs[pred_idx])

    healthy_p = next((p for c, p in prob_map.items() if c.lower().startswith('health')), None)
    schizo_p = next((p for c, p in prob_map.items() if 'schiz' in c.lower()), None)

    return {
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
    }, 200
