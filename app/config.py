import os
from pathlib import Path


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
SESSIONS_DIR = DATA_DIR / "sessions"

DASHBOARD_PASSWORD = os.environ.get("DASHBOARD_PASSWORD", "")
SECRET_KEY = os.environ.get("SECRET_KEY", "")

SESSION_TTL_HOURS = _float("SESSION_TTL_HOURS", 6.0)
MAX_UPLOAD_MB = _int("MAX_UPLOAD_MB", 200)

MODEL_EXTS = {".stl", ".obj", ".ply", ".3mf", ".off"}
LOGO_EXTS = {".svg"}
