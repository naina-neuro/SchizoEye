"""/health — lightweight status probe used by uptime checks and the dashboards' connection banner."""
from flask import Blueprint, jsonify

import extensions

bp = Blueprint('health', __name__)


@bp.route('/health', methods=['GET'])
def health():
    """Report backend status and current MongoDB availability."""
    return jsonify({
        'status': 'ok',
        'mode': 'data_collection',
        'mongodb_connected': extensions.db is not None,
        'mongodb_db': extensions.db.name if extensions.db is not None else None
    })
