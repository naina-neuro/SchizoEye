"""/login and /logout — session-cookie authentication for the admin/doctor/clinician dashboard roles."""
from flask import Blueprint, request, jsonify, session as flask_session

from services.auth_service import USERS

bp = Blueprint('auth', __name__)


@bp.route('/login', methods=['POST'])
def login():
    """Authenticate a configured user and establish a Flask session."""
    data = request.get_json()
    username = data.get('username', '').strip()
    password = data.get('password', '').strip()
    user = USERS.get(username)
    if user and user['password'] == password:
        flask_session['user'] = username
        flask_session['role'] = user['role']
        return jsonify({'success': True, 'role': user['role'], 'username': username})
    return jsonify({'success': False, 'error': 'Invalid credentials'}), 401


@bp.route('/logout', methods=['POST'])
def logout():
    """Clear the current user session."""
    flask_session.clear()
    return jsonify({'success': True})
