"""POST /save_results — the assessment-completion endpoint: uploads raw gaze CSVs and task images to
GridFS, renders and stores the PDF report, and inserts the session document into MongoDB."""
import uuid
from datetime import datetime

from flask import Blueprint, request, jsonify
from pymongo import errors

import extensions
from config import SESSIONS_COLLECTION
from constants import REQUIRED_FEATURES
from services.csv_service import json_rows_to_csv_binary, serialize_sz_csv
from services.gridfs_service import upload_to_gridfs
from services.heatmap_service import generate_heatmap_base64
from services.pdf_service import generate_pdf

bp = Blueprint('results', __name__)


@bp.route('/save_results', methods=['POST'])
def save_results():
    """Save assessment results, raw gaze data, task figures, and the generated report."""
    print("[DEBUG] /save_results called. Checking DB connection...")
    if extensions.db is None or extensions.fs is None:
        print("[DEBUG] DB is None! Attempting to reconnect...")
        extensions.init_mongodb()

    if extensions.db is None or extensions.fs is None:
        print("[DEBUG] DB is still None after reconnection attempt!")
        return jsonify({'error': 'MongoDB not connected'}), 500

    try:
        print("[DEBUG] Attempting to parse JSON payload...")
        data = request.get_json()
        print(f"[DEBUG] JSON parsed successfully. Payload keys: {list(data.keys())}")

        subject_id = data.get('subject_id', 'Unknown')
        timestamp = datetime.now()
        gridfs_refs = {}
        storage_metadata = {
            'database': extensions.db.name,
            'subject_id': subject_id,
            'stored_at': timestamp
        }

        if 'fv_gaze' in data:
            try:
                print("[DEBUG] Converting fv_gaze to CSV...")
                fv_csv = json_rows_to_csv_binary(data['fv_gaze'])
                print("[DEBUG] Uploading fv_gaze to GridFS...")
                gridfs_refs['fv_id'] = upload_to_gridfs(
                    fv_csv,
                    filename=f"fv_{subject_id}_{timestamp.strftime('%Y%m%d%H%M')}.csv",
                    content_type='text/csv',
                    metadata={**storage_metadata, 'kind': 'fv_csv'}
                )
                print(f"[DEBUG] fv_gaze uploaded: {gridfs_refs['fv_id']}")
            except Exception as e:
                print(f"[WARN] FV CSV upload failed; session data will still be saved: {e}")

        if 'spem_gaze' in data:
            try:
                print("[DEBUG] Converting spem_gaze to CSV...")
                spem_csv = json_rows_to_csv_binary(data['spem_gaze'])
                print("[DEBUG] Uploading spem_gaze to GridFS...")
                gridfs_refs['spem_id'] = upload_to_gridfs(
                    spem_csv,
                    filename=f"spem_{subject_id}_{timestamp.strftime('%Y%m%d%H%M')}.csv",
                    content_type='text/csv',
                    metadata={**storage_metadata, 'kind': 'spem_csv'}
                )
                print(f"[DEBUG] spem_gaze uploaded: {gridfs_refs['spem_id']}")
            except Exception as e:
                print(f"[WARN] SPEM CSV upload failed; session data will still be saved: {e}")

        if 'sz_gaze' in data:
            try:
                print("[DEBUG] Converting sz_gaze to CSV...")
                sz_csv = serialize_sz_csv(data['sz_gaze'])
                print("[DEBUG] Uploading sz_gaze to GridFS...")
                gridfs_refs['sz_id'] = upload_to_gridfs(
                    sz_csv,
                    filename=f"sz_{subject_id}_{timestamp.strftime('%Y%m%d%H%M')}.csv",
                    content_type='text/csv',
                    metadata={**storage_metadata, 'kind': 'sz_csv'}
                )
                print(f"[DEBUG] sz_gaze uploaded: {gridfs_refs['sz_id']}")
            except Exception as e:
                print(f"[WARN] SZ CSV upload failed; session data will still be saved: {e}")

        session_images = {
            'spem_hs4': data.get('image_spem_hs4', ''),
            'spem_ls2': data.get('image_spem_ls2', ''),
            'spem_ls4': data.get('image_spem_ls4', ''),
            'fix_pure': data.get('image_fix_pure', ''),
            'fix_dist': data.get('image_fix_dist', ''),
            'heatmap': ''
        }
        if data.get('fv_gaze'):
            try:
                session_images['heatmap'] = generate_heatmap_base64(data['fv_gaze'])
            except Exception as heatmap_err:
                print(f"[WARN] Heatmap generation failed; continuing without it: {heatmap_err}")

        try:
            print("[DEBUG] Preparing PDF payload...")
            pdf_payload = {
                'patient': {
                    'id': subject_id,
                    'name': data.get('patient_name', subject_id),
                    'age_sex': f"{data.get('patient_age', 'N/A')} / {data.get('patient_gender', 'N/A')}",
                    'date': timestamp.strftime('%d %b %Y')
                },
                'panss_score': data.get('panss_score') or 'Not recorded',
                'metrics': data.get('features', {}),
                'prediction': data.get('prediction'),
                'doctor_notes': data.get('notes', ''),

                'images': dict(session_images)
            }
            print("[DEBUG] Generating PDF bytes...")
            pdf_bytes = generate_pdf(pdf_payload)
            print("[DEBUG] Uploading PDF to GridFS...")
            gridfs_refs['report_id'] = upload_to_gridfs(
                pdf_bytes,
                filename=f"Report_{subject_id}_{timestamp.strftime('%Y%m%d%H%M')}.pdf",
                content_type='application/pdf',
                metadata={**storage_metadata, 'kind': 'pdf_report'}
            )
            print(f"[DEBUG] PDF uploaded: {gridfs_refs['report_id']}")
        except Exception as pdf_err:
            print(f"Warning: PDF generation/upload failed: {pdf_err}")

        print("[DEBUG] Creating main session document...")

        patient_id = data.get('patient_id') or f"PAT-{uuid.uuid4().hex[:8].upper()}"

        session_doc = {
            "metadata": {
                "patient_id": patient_id,
                "subject_id": subject_id,
                "name": data.get('patient_name', subject_id),
                "age": data.get('patient_age', 'N/A'),
                "gender": data.get('patient_gender', 'N/A'),
                "screen_size": data.get('screen_size', 'N/A'),
                "timestamp": timestamp
            },
             "acquisition": {
                            "calibration_error_px": data.get('calibration_error'),
                            "px_per_deg_used": data.get('px_per_deg_used'),
                            "tracker_performance": data.get('tracker_performance'),
                            "data_quality": data.get('data_quality'),
                        },
            "results": {
                "panss_score": data.get('panss_score'),
                "features": data.get('features', {}),
                "prediction": data.get('prediction'),

                "images": session_images

            },
            "notes": data.get('notes', ""),
            "notes_author": data.get('notes_author', "unknown"),
            "gridfs_refs": {
                key: value for key, value in (
                    ('fv_id', gridfs_refs.get('fv_id')),
                    ('spem_id', gridfs_refs.get('spem_id')),
                    ('sz_id', gridfs_refs.get('sz_id')),
                    ('report_id', gridfs_refs.get('report_id'))
                ) if value is not None
            }
        }

        print("[DEBUG] Inserting session into MongoDB...")
        insert_result = extensions.db[SESSIONS_COLLECTION].insert_one(session_doc)
        print(f"[DEBUG] Session inserted with ID: {insert_result.inserted_id}")
        session_id_str = str(insert_result.inserted_id)
        # The frontend's completion payload (postMessage to a parent/opener, used by embedding
        # partners) reads prediction/features/feature_order/report_url off this response. Those
        # fields were never returned, so reportUrl was built as "<API_BASE>undefined" and
        # prediction/features silently fell back to whatever the frontend already had in memory.
        # /sessions/<id>/pdf already regenerates the PDF on demand if the GridFS upload above
        # failed, so report_url is always safe to return.
        return jsonify({
            'success': True,
            'message': 'Session saved to MongoDB Atlas successfully',
            'session_id': session_id_str,
            'subject_id': subject_id,
            'patient_id': patient_id,
            'prediction': session_doc['results'].get('prediction'),
            'features': session_doc['results'].get('features', {}),
            'feature_order': REQUIRED_FEATURES,
            'report_url': f'/sessions/{session_id_str}/pdf',
            'gridfs_refs': {key: str(value) for key, value in session_doc['gridfs_refs'].items()}
        })

    except errors.ConfigurationError as e:
        print(f"[ERROR] ConfigurationError: {e}")
        return jsonify({
            'error': (
                'MongoDB Atlas configuration issue detected. '
                'Please verify the SRV region or cluster accessibility.'
            ),
            'details': str(e)
        }), 503
    except errors.PyMongoError as e:
        print(f"[ERROR] PyMongoError: {e}")
        if "quota exceeded" in str(e).lower() or "WriteError" in str(e):
            return jsonify({'error': 'Storage limit reached (512MB). Please archive old data.', 'limit_error': True}), 507
        return jsonify({'error': f'Database error: {str(e)}'}), 500
    except Exception as e:
        print(f"[ERROR] General Exception: {e}")
        return jsonify({'error': f'Server error: {str(e)}'}), 500
