"""App factory: wires together config, CORS, MongoDB, the classifier, and every route blueprint.

Run directly for local dev exactly as before:  python app.py
The module-level `app` object is also what a production WSGI server should point at (e.g. `app:app`).
"""
import os

from flask import Flask
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv()

import config
import extensions
import model  # noqa: F401 — side effect: loads the classifier/label encoder, prints OK/WARN
from routes import register_routes

BASE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_DIR = os.path.join(BASE, 'templates')


def create_app():
    """Build and configure the Flask app: CORS, secret/session/upload settings, MongoDB, routes."""
    app = Flask(__name__, template_folder=TEMPLATE_DIR)

    # --- CORS configuration ---
    origins = config.allowed_origins()
    CORS(
        app,
        resources={r"/*": {"origins": origins + [config.NETLIFY_PREVIEW_RE]}},
        supports_credentials=True,
        expose_headers=["Content-Disposition"],
        allow_headers=["Content-Type", "X-Test-Token", "X-Integration-Key", "Authorization"],
        methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    )
    print(f"[CORS] allowed origins: {origins} (+ netlify deploy previews)")

    app.secret_key = config.SECRET_KEY
    app.config["MAX_CONTENT_LENGTH"] = config.MAX_CONTENT_LENGTH
    app.config.update(config.SESSION_COOKIE_SETTINGS)

    # --- Response caching ---
    @app.after_request
    def add_no_cache_headers(response):
        """Disable browser caching for API responses."""
        response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'
        return response

    extensions.init_mongodb()
    register_routes(app)
    return app


app = create_app()

if __name__ == '__main__':
    port = int(os.getenv('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
