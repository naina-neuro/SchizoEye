"""
Export MongoDB sessions with CSVs organized in folders per subject
Structure:
  sessions_export/
    ├── Subject_01/
    │   ├── metadata.json
    │   ├── features.json
    │   ├── fv_raw.csv
    │   ├── spem_raw.csv
    │   ├── sz_raw.csv
    │   └── report.pdf
    ├── Subject_02/
    │   ├── ...
"""

import os
import json
from datetime import datetime
from pymongo import MongoClient
from dotenv import load_dotenv
import shutil

load_dotenv()

MONGODB_URI = os.getenv("MONGODB_URI")
MONGODB_DB_NAME = os.getenv("MONGODB_DB_NAME", "SchizoEye")

def export_sessions():
    # Connect to MongoDB
    client = MongoClient(MONGODB_URI)
    db = client.get_database(MONGODB_DB_NAME)
    fs_db = db  # GridFS uses the same database
    
    from gridfs import GridFS
    fs = GridFS(db)
    
    # Create export directory
    export_dir = "sessions_export"
    if os.path.exists(export_dir):
        shutil.rmtree(export_dir)
    os.makedirs(export_dir)
    
    # Get all sessions
    sessions = db.sessions.find().sort("metadata.timestamp", -1)
    count = 0
    
    for session in sessions:
        try:
            subject_id = session.get('metadata', {}).get('name', f"Subject_{count:02d}")
            subject_dir = os.path.join(export_dir, subject_id)
            os.makedirs(subject_dir, exist_ok=True)
            
            # 1. Export metadata (clean format)
            metadata = {
                "subject_id": subject_id,
                "name": session.get('metadata', {}).get('name', 'N/A'),
                "age": session.get('metadata', {}).get('age', 'N/A'),
                "gender": session.get('metadata', {}).get('gender', 'N/A'),
                "screen_size": session.get('metadata', {}).get('screen_size', 'N/A'),
                "timestamp": str(session.get('metadata', {}).get('timestamp', 'N/A')),
                "diagnosis": session.get('results', {}).get('diagnosis', 'N/A'),
                "panss_score": session.get('results', {}).get('panss_score', 0),
            }
            with open(os.path.join(subject_dir, 'metadata.json'), 'w') as f:
                json.dump(metadata, f, indent=2)
            
            # 2. Export features (59 features)
            features = session.get('results', {}).get('features', {})
            with open(os.path.join(subject_dir, 'features.json'), 'w') as f:
                json.dump(features, f, indent=2)
            
            # 3. Export CSVs from GridFS
            gridfs_refs = session.get('gridfs_refs', {})
            
            # FV CSV
            if 'fv_id' in gridfs_refs:
                fv_id = gridfs_refs['fv_id']
                try:
                    fv_data = fs.get(fv_id).read()
                    with open(os.path.join(subject_dir, 'fv_raw.csv'), 'wb') as f:
                        f.write(fv_data)
                    print(f"  Exported FV CSV for {subject_id}")
                except Exception as e:
                    print(f"  Failed to export FV CSV: {e}")
            
            # SPEM CSV
            if 'spem_id' in gridfs_refs:
                spem_id = gridfs_refs['spem_id']
                try:
                    spem_data = fs.get(spem_id).read()
                    with open(os.path.join(subject_dir, 'spem_raw.csv'), 'wb') as f:
                        f.write(spem_data)
                    print(f"  Exported SPEM CSV for {subject_id}")
                except Exception as e:
                    print(f"  Failed to export SPEM CSV: {e}")
            
            # Saccade CSV
            if 'sz_id' in gridfs_refs:
                sz_id = gridfs_refs['sz_id']
                try:
                    sz_data = fs.get(sz_id).read()
                    with open(os.path.join(subject_dir, 'sz_raw.csv'), 'wb') as f:
                        f.write(sz_data)
                    print(f"  Exported Saccade CSV for {subject_id}")
                except Exception as e:
                    print(f"  Failed to export Saccade CSV: {e}")
            
            # PDF Report
            if 'report_id' in gridfs_refs:
                report_id = gridfs_refs['report_id']
                try:
                    report_data = fs.get(report_id).read()
                    with open(os.path.join(subject_dir, 'report.pdf'), 'wb') as f:
                        f.write(report_data)
                    print(f"  Exported PDF report for {subject_id}")
                except Exception as e:
                    print(f"  Failed to export PDF: {e}")
            
            print(f" Session exported: {subject_id}\n")
            count += 1
            
        except Exception as e:
            print(f" Error exporting session: {e}\n")
            continue
    
    print(f"\n✅ Exported {count} sessions to '{export_dir}/' directory")
    print(f"Structure: Each subject has metadata.json, features.json, and CSV files")

if __name__ == "__main__":
    export_sessions()
