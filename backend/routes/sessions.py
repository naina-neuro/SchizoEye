"""Session listing/search/export routes: GET /sessions, /sessions/search, /sessions/<id>/pdf,
/sessions/<id>/csv/<type>, /sessions/export_all_features, and POST /sessions/<id>/notes."""
import csv
import io
from datetime import datetime

import gridfs
from bson import ObjectId
from flask import Blueprint, request, jsonify, Response

import extensions
from config import SESSIONS_COLLECTION
from constants import REQUIRED_FEATURES
from services.pdf_service import generate_pdf

bp = Blueprint('sessions', __name__)

# Projection shared by the session list and search endpoints, so both return identically-shaped documents.
_SESSION_PROJECTION = {
    '_id': 1, 'metadata': 1,
    'results.panss_score': 1,
    'results.features': 1,
    'notes': 1, 'notes_author': 1,
    'gridfs_refs.report_id': 1
}


def _session_summary(d):
    """Shape a raw session document into the summary dict the dashboard table expects."""
    sid = str(d['_id'])
    meta = d.get('metadata', {})
    res = d.get('results', {})
    ts = meta.get('timestamp')
    return {
        'id': sid,
        'patient_id': meta.get('patient_id', 'N/A'),
        'subject_id': meta.get('subject_id', meta.get('patient_id', 'N/A')),
        'name': meta.get('name', 'Unknown'),
        'age': meta.get('age', 'N/A'),
        'gender': meta.get('gender', 'N/A'),
        'date': ts.strftime('%d %b %Y, %H:%M') if ts else 'N/A',
        'panss': res.get('panss_score', 'N/A'),
        'features': res.get('features', {}),
        'notes': d.get('notes', ''),
        'notes_author': d.get('notes_author', ''),
        'has_report': bool(d.get('gridfs_refs', {}).get('report_id'))
    }


@bp.route('/sessions', methods=['GET', 'OPTIONS'])
def get_sessions():
    """Return recent session summaries for the dashboard (most recent 200)."""
    if extensions.db is None:
        return jsonify({'success': False, 'error': 'Database not connected'}), 503
    try:
        col = extensions.db[SESSIONS_COLLECTION]
        docs = list(col.find({}, _SESSION_PROJECTION).sort('metadata.timestamp', -1).limit(200))
        return jsonify({'success': True, 'sessions': [_session_summary(d) for d in docs]})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@bp.route('/sessions/search', methods=['GET'])
def search_sessions():
    """Search sessions by patient name or patient ID (case-insensitive substring match)."""
    if extensions.db is None:
        return jsonify({'success': False, 'error': 'Database not connected'}), 503
    try:
        query = request.args.get('q', '').strip()
        if not query:
            return jsonify({'success': True, 'sessions': []})

        col = extensions.db[SESSIONS_COLLECTION]
        search_filter = {
            '$or': [
                {'metadata.name': {'$regex': query, '$options': 'i'}},
                {'metadata.patient_id': {'$regex': query, '$options': 'i'}}
            ]
        }
        docs = list(col.find(search_filter, _SESSION_PROJECTION).sort('metadata.timestamp', -1).limit(50))
        return jsonify({'success': True, 'sessions': [_session_summary(d) for d in docs]})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@bp.route('/sessions/<session_id>/pdf', methods=['GET'])
def download_session_pdf(session_id):
    """Download a session's stored PDF, or regenerate it on the fly if none was stored."""
    if extensions.db is None:
        return jsonify({'error': 'DB not connected'}), 503
    try:
        col = extensions.db[SESSIONS_COLLECTION]
        doc = col.find_one({'_id': ObjectId(session_id)})
        if not doc:
            return jsonify({'error': 'Session not found'}), 404
        report_id = doc.get('gridfs_refs', {}).get('report_id')
        if not report_id:

            meta = doc.get('metadata', {})
            res = doc.get('results', {})

            pdf_data = {
                'patient': {
                    'id': meta.get('patient_id', session_id),
                    'name': meta.get('name', 'Unknown'),
                    'age_sex': f"{meta.get('age','N/A')} / {meta.get('gender','N/A')}",
                    'date': meta.get('timestamp', datetime.now()).strftime('%d %b %Y') if hasattr(meta.get('timestamp', ''), 'strftime') else str(meta.get('timestamp', ''))
                },
                'panss_score': res.get('panss_score') or 'Not recorded',
                'metrics': res.get('features', {}),
                'prediction': res.get('prediction'),
                'doctor_notes': doc.get('notes', ''),

                'images': res.get('images', {})
            }
            try:
                pdf_bytes = generate_pdf(pdf_data)
                return Response(pdf_bytes, mimetype='application/pdf',
                    headers={'Content-Disposition': f'attachment; filename=report_{session_id}.pdf'})
            except Exception as gen_err:
                return jsonify({'error': f'No PDF stored and regeneration failed: {gen_err}'}), 404
        fs_local = gridfs.GridFS(extensions.db)
        grid_file = fs_local.get(report_id)
        return Response(
            grid_file.read(),
            mimetype='application/pdf',
            headers={'Content-Disposition': f'attachment; filename=report_{session_id}.pdf'}
        )
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/sessions/<session_id>/csv/<csv_type>', methods=['GET'])
def download_session_csv(session_id, csv_type):
    """Download a session's raw gaze CSV by type (fv / spem / sz)."""
    if extensions.db is None:
        return jsonify({'error': 'DB not connected'}), 503
    try:
        col = extensions.db[SESSIONS_COLLECTION]
        doc = col.find_one({'_id': ObjectId(session_id)})
        if not doc:
            return jsonify({'error': 'Session not found'}), 404
        key_map = {'fv': 'fv_id', 'spem': 'spem_id', 'sz': 'sz_id'}
        ref_key = key_map.get(csv_type)
        if not ref_key:
            return jsonify({'error': f'Unknown csv_type {csv_type}'}), 400
        gid = doc.get('gridfs_refs', {}).get(ref_key)
        if not gid:
            return jsonify({'error': f'No {csv_type} CSV for this session'}), 404
        fs_local = gridfs.GridFS(extensions.db)
        grid_file = fs_local.get(gid)
        return Response(
            grid_file.read(),
            mimetype='text/csv',
            headers={'Content-Disposition': f'attachment; filename={csv_type}_{session_id}.csv'}
        )
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/sessions/export_all_features', methods=['GET'])
def export_all_features():
    """Export every saved session's metadata and 59 model features as one CSV."""
    if extensions.db is None:
        return jsonify({'error': 'DB not connected'}), 503
    try:
        col = extensions.db[SESSIONS_COLLECTION]
        docs = list(col.find({}, {'metadata': 1, 'results.features': 1, 'results.panss_score': 1}).sort('metadata.timestamp', -1))
        output = io.StringIO()
        fieldnames = ['session_id', 'name', 'date', 'panss_score'] + REQUIRED_FEATURES
        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()
        for d in docs:
            meta = d.get('metadata', {})
            res = d.get('results', {})
            feats = res.get('features', {})
            row = {
                'session_id': str(d['_id']),
                'name': meta.get('name', ''),
                'date': meta.get('timestamp', ''),
                'panss_score': res.get('panss_score', '')
            }
            for f in REQUIRED_FEATURES:
                row[f] = feats.get(f, '')
            writer.writerow(row)
        return Response(
            output.getvalue(),
            mimetype='text/csv',
            headers={'Content-Disposition': 'attachment; filename=all_features_export.csv'}
        )
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/sessions/<session_id>/notes', methods=['POST'])
def save_notes(session_id):
    """Update a session's clinician notes and regenerate its stored PDF report to include them."""
    if extensions.db is None:
        return jsonify({'success': False, 'error': 'Database not connected'}), 503
    try:
        data = request.get_json()
        notes = data.get('notes', '')
        author = data.get('author', 'unknown')
        col = extensions.db[SESSIONS_COLLECTION]

        doc = col.find_one({'_id': ObjectId(session_id)})
        if not doc:
            return jsonify({'success': False, 'error': 'Session not found'}), 404

        meta = doc.get('metadata', {})
        res = doc.get('results', {})
        ts = meta.get('timestamp', datetime.now())

        col.update_one(
            {'_id': ObjectId(session_id)},
            {'$set': {'notes': notes, 'notes_author': author, 'notes_updated_at': datetime.now()}}
        )

        try:
            pdf_payload = {
                'patient': {
                    'id': meta.get('patient_id', session_id),
                    'name': meta.get('name', 'Unknown'),
                    'age_sex': f"{meta.get('age','N/A')} / {meta.get('gender','N/A')}",
                    'date': ts.strftime('%d %b %Y') if hasattr(ts, 'strftime') else str(ts)
                },
                'panss_score': res.get('panss_score') or 'Not recorded',
                'metrics': res.get('features', {}),
                'prediction': res.get('prediction'),
                'doctor_notes': notes,

                'images': res.get('images', {})
            }
            pdf_bytes = generate_pdf(pdf_payload)

            old_report_id = doc.get('gridfs_refs', {}).get('report_id')
            if old_report_id:
                try:
                    extensions.fs.delete(old_report_id)
                except Exception:
                    pass

            subject_id = meta.get('subject_id', session_id)
            new_report_id = extensions.fs.put(
                pdf_bytes,
                filename=f"Report_{subject_id}_{datetime.now().strftime('%Y%m%d%H%M')}.pdf",
                content_type='application/pdf',
                metadata={'kind': 'pdf_report', 'subject_id': subject_id}
            )
            col.update_one(
                {'_id': ObjectId(session_id)},
                {'$set': {'gridfs_refs.report_id': new_report_id}}
            )
        except Exception as pdf_err:
            print(f"Warning: PDF regeneration failed after notes save: {pdf_err}")

        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500
