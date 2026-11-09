"""Registers every route blueprint with the Flask app. One module per route group, named after the
URL area it owns (auth, health, classify, sessions, results, analytics, reports)."""
from routes.auth import bp as auth_bp
from routes.health import bp as health_bp
from routes.classify import bp as classify_bp
from routes.sessions import bp as sessions_bp
from routes.results import bp as results_bp
from routes.analytics import bp as analytics_bp
from routes.reports import bp as reports_bp


def register_routes(app):
    """Attach all blueprints to `app`. Called once from create_app()."""
    app.register_blueprint(auth_bp)
    app.register_blueprint(health_bp)
    app.register_blueprint(classify_bp)
    app.register_blueprint(sessions_bp)
    app.register_blueprint(results_bp)
    app.register_blueprint(analytics_bp)
    app.register_blueprint(reports_bp)
