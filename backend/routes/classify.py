"""/classify — validates an eye-tracking feature vector and returns the XGBoost model's prediction.
Used standalone (e.g. by integration partners posting features directly); /save_results covers the normal
in-app flow where the prediction is computed client-side and submitted together with the raw gaze data."""
import traceback

from flask import Blueprint, request, jsonify

from services.classify_service import classify_features

bp = Blueprint('classify', __name__)


@bp.route('/classify', methods=['POST'])
def classify():
    """Parse the request body, validate the feature vector, and return the classifier's prediction."""
    try:
        data = request.get_json(force=True, silent=True) or {}
        features = data.get('features', {})
        result, status = classify_features(features)
        return jsonify(result), status
    except Exception as e:
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500
