"""GET /analytics — aggregates saved sessions into the dashboard's summary stats and charts."""
from collections import defaultdict

from flask import Blueprint, jsonify

import extensions
from config import SESSIONS_COLLECTION

bp = Blueprint('analytics', __name__)

# The subset of the 59 features surfaced as summary stat cards on the analytics dashboard.
KEY_FEATURES = [
    'fv_fnum_mean', 'fv_fdur_mean', 'fv_samp_mean',
    'HS4_Mean_H_gain', 'HS4_SacNum',
    'antisaccade_error_rate', 'antisaccade_accuracy',
    'fix_fs_fn', 'fix_fd_fn'
]


@bp.route('/analytics', methods=['GET'])
def get_analytics():
    """Aggregate the most recent 500 saved sessions for dashboard analytics."""
    if extensions.db is None:
        return jsonify({'success': False, 'error': 'Database not connected'}), 503
    try:
        col = extensions.db[SESSIONS_COLLECTION]
        docs = list(col.find({}, {
            'metadata': 1,
            'results.panss_score': 1,
            'results.features': 1
        }).sort('metadata.timestamp', -1).limit(500))

        daily_counts = defaultdict(int)
        panss_scores = []
        feature_avgs = defaultdict(list)
        genders = defaultdict(int)
        ages = []

        for d in docs:
            meta = d.get('metadata', {})
            res = d.get('results', {})
            ts = meta.get('timestamp')
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
                if v is not None and v != '' and v == v:
                    try:
                        feature_avgs[k].append(float(v))
                    except (ValueError, TypeError):
                        pass

        sorted_days = sorted(daily_counts.items())[-30:]

        feat_summary = {}
        for k in KEY_FEATURES:
            vals = feature_avgs.get(k, [])
            if vals:
                feat_summary[k] = {
                    'mean': round(sum(vals)/len(vals), 3),
                    'min': round(min(vals), 3),
                    'max': round(max(vals), 3),
                    'n': len(vals)
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
