"""Builds the USERS table (username -> password/role) from the ADMIN_PASSWORD / DOCTOR_PASSWORD /
CLINICIAN_PASSWORD env vars. Imported once at startup by routes/auth.py.
"""
import os

AUTH_CONFIG = {
    "admin": ("ADMIN_PASSWORD", "admin"),
    "doctor": ("DOCTOR_PASSWORD", "doctor"),
    "clinician": ("CLINICIAN_PASSWORD", "clinician"),
}


def load_users():
    """Read each role's password from the environment; a role with no password set is disabled (left out)."""
    users = {}
    for username, (env_name, role) in AUTH_CONFIG.items():
        password = os.getenv(env_name)
        if password:
            users[username] = {"password": password, "role": role}
        else:
            print(f"[WARN] {env_name} is not configured; {username} login is disabled.")
    return users


USERS = load_users()
