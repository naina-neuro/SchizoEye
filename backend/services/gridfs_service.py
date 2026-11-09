"""Uploads binary assets (gaze CSVs, PDF reports) to the active session's GridFS bucket."""
import extensions
from services.csv_service import ensure_binary_payload


def upload_to_gridfs(binary_payload, filename, content_type, metadata):
    """Store a binary asset in GridFS and return its file ID. Requires extensions.fs to be connected."""
    payload = ensure_binary_payload(binary_payload, filename)
    return extensions.fs.put(payload, filename=filename, content_type=content_type, metadata=metadata)
