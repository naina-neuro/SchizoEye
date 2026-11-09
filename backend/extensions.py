"""MongoDB connection state shared across the whole app: the `db` and `fs` (GridFS) handles, and the
(re)connect logic. Routes read `extensions.db` / `extensions.fs` directly (not a copied reference) so they
always see the latest connection after a reconnect.
"""
from pymongo import MongoClient, errors
import gridfs

import config

db = None
fs = None


def _get_scoped_database(client):
    """Return the configured database after checking its name matches SchizoEye."""
    scoped_db = client.get_database(config.MONGODB_DB_NAME)
    if scoped_db.name != "SchizoEye":
        raise errors.ConfigurationError(
            "MongoDB access must remain scoped to the SchizoEye database."
        )
    return scoped_db


def _legacy_init_mongodb():
    """Legacy MongoDB initializer retained for compatibility."""
    global db, fs
    try:
        client = MongoClient(config.MONGODB_URI, serverSelectionTimeoutMS=5000)
        db = client.get_database("SchizoEye")
        fs = gridfs.GridFS(db)
        client.admin.command('ping')
        print("[OK] MongoDB Atlas connected successfully (SchizoEye)")
    except errors.ConfigurationError as ce:
        print(f"[ERROR] MongoDB Configuration Error: {ce}")
    except Exception as e:
        print(f"[ERROR] MongoDB Connection Error: {e}")


def init_mongodb():
    """Connect to MongoDB, initialize GridFS, and ensure indexes. Sets the module-level db/fs handles;
    on any failure both are reset to None so callers can check `extensions.db is None` to detect it."""
    global db, fs
    try:
        if not config.MONGODB_URI:
            raise errors.ConfigurationError("MONGODB_URI is not configured.")

        client = MongoClient(
            config.MONGODB_URI,
            maxPoolSize=50,
            minPoolSize=10,
            maxIdleTimeMS=300000,
            serverSelectionTimeoutMS=5000,
            connectTimeoutMS=10000,
            socketTimeoutMS=30000,
            retryWrites=True
        )
        db = _get_scoped_database(client)
        fs = gridfs.GridFS(db)
        client.admin.command('ping')
        print(f"MongoDB Atlas connected successfully ({db.name})")

        print(f"Connection pool - max: 50, min: 10, idle timeout: 5min")

        _ensure_indexes()
    except errors.ConfigurationError as ce:
        db = None
        fs = None
        print(
            "MongoDB configuration issue. Check the Atlas SRV string, cluster region, "
            f"and network allowlist: {ce}"
        )
    except Exception as e:
        db = None
        fs = None
        print(f"MongoDB connection error: {e}")


def _ensure_indexes():
    """Create indexes used by session queries and sorting."""
    if db is None:
        return
    try:
        sessions = db[config.SESSIONS_COLLECTION]

        sessions.create_index("metadata.name", name="idx_patient_name", background=True)

        sessions.create_index("metadata.timestamp", name="idx_timestamp", background=True)

        sessions.create_index(
            [("metadata.name", 1), ("metadata.timestamp", -1)],
            name="idx_patient_time",
            background=True
        )

        print("[OK] Database indexes created/verified")
    except Exception as e:
        print(f"Warning: Could not create indexes: {e}")
