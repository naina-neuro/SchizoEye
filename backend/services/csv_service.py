"""Serializes gaze/session row data into GridFS-ready CSV binary payloads."""
import io
import pandas as pd
from bson.binary import Binary


def ensure_binary_payload(payload, file_label):
    """Convert a bytes-like payload to BSON Binary, raising if it isn't bytes-compatible."""
    if isinstance(payload, Binary):
        return payload
    if isinstance(payload, (bytes, bytearray)):
        return Binary(bytes(payload))
    raise TypeError(f"{file_label} must be uploaded as Binary-compatible bytes.")


def json_rows_to_csv_binary(json_data):
    """Serialize a list of row-dicts (e.g. free-viewing gaze samples) as a GridFS-compatible CSV payload."""
    output = io.StringIO()
    pd.DataFrame(json_data).to_csv(output, index=False)
    return ensure_binary_payload(output.getvalue().encode('utf-8'), "CSV payload")


def serialize_sz_csv(sz_data):
    """Serialize SchizoEye-task gaze data as a GridFS-compatible CSV payload. Accepts either the legacy
    pre-formatted "Timestamp_ms,Phase,..." string-row list, or plain row-dicts like the other tasks."""
    if isinstance(sz_data, list) and sz_data and isinstance(sz_data[0], str):
        sz_csv_str = "Timestamp_ms,Phase,Gaze_X,Gaze_Y,Target_X,Target_Y\n" + "\n".join(sz_data)
        return ensure_binary_payload(sz_csv_str.encode('utf-8'), "SZ CSV payload")
    return json_rows_to_csv_binary(sz_data)
