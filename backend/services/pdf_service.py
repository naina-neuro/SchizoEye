"""Renders the clinical PDF report from session/result data via Jinja (templates/report_template.html) and
WeasyPrint. The template and its expected `data` shape (patient/panss_score/metrics/prediction/doctor_notes/
images) are unchanged from the original single-file app — only where this code lives has moved.
"""
import traceback
from datetime import datetime

from flask import render_template

from services.heatmap_service import generate_heatmap_base64

try:
    from weasyprint import HTML
except ImportError:
    HTML = None
    print("WARNING: weasyprint is not installed. PDF generation will fail.")


def generate_pdf(data):
    """Fill in report defaults (patient info, image placeholders, PANSS/notes fallbacks), render
    report_template.html, and return the finished PDF as bytes."""
    try:

        if 'patient' not in data: data['patient'] = {}
        data['patient'].setdefault('id', f"P_{datetime.now().strftime('%Y%m%d%H%M')}")
        data['patient'].setdefault('name', 'Unknown')
        data['patient'].setdefault('age_sex', 'N/A')
        data['patient'].setdefault('date', datetime.now().strftime('%Y-%m-%d'))

        if 'images' not in data: data['images'] = {}
        if data.get('fv_gaze'):
            data['images']['heatmap'] = generate_heatmap_base64(data['fv_gaze'])

        for key in ['spem_hs4', 'spem_ls2', 'spem_ls4', 'fix_pure', 'fix_dist']:
            data['images'].setdefault(key, "")

        if 'metrics' not in data: data['metrics'] = {}

        panss_val = data.get('panss_score')
        if panss_val is not None and panss_val != 'Not recorded':
            data['metrics']['panss_score'] = panss_val

        if 'doctor_notes' not in data:
            data['doctor_notes'] = ""

        if 'panss_score' not in data:
            data['panss_score'] = 'Not recorded'

        data.setdefault('prediction', None)

        rendered_html = render_template("report_template.html", data=data)

        return HTML(string=rendered_html).write_pdf()
    except Exception as e:
        traceback.print_exc()
        raise e
