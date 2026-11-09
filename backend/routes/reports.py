"""POST /generate-report — renders an ad-hoc PDF report straight from a payload (not tied to a saved
session; used for one-off/preview report generation)."""
import io

from flask import Blueprint, request, jsonify, send_file

from services.pdf_service import generate_pdf

bp = Blueprint('reports', __name__)


@bp.route('/generate-report', methods=['POST'])
def generate_report():
    """Generate and return a PDF built directly from the posted report payload."""
    try:
        data = request.get_json()
        pdf = generate_pdf(data)

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
