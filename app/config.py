import json
import os
import re
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
PRODUCTS_DIR = DATA_DIR / "products"
ORDERS_DIR = DATA_DIR / "orders"
DB_PATH = Path(os.environ.get("DB_PATH", str(DATA_DIR / "autologo.db")))

DASHBOARD_PASSWORD = os.environ.get("DASHBOARD_PASSWORD", "")
SECRET_KEY = os.environ.get("SECRET_KEY", "")

SESSION_TTL_HOURS = _float("SESSION_TTL_HOURS", 6.0)
MAX_UPLOAD_MB = _int("MAX_UPLOAD_MB", 200)

MODEL_EXTS = {".stl", ".obj", ".ply", ".3mf", ".off"}
LOGO_EXTS = {".svg"}

# --- print colors ---------------------------------------------------------
# The filament colors a customer may pick from, for the object itself and for
# each color group of their logo. Override the whole list with the
# FILAMENT_COLORS env var (JSON: [{"name": "Noir", "hex": "#1c1c1e"}, ...])
# to match what you actually keep in stock.
DEFAULT_PALETTE = [
    {"name": "Noir", "hex": "#1c1c1e"},
    {"name": "Blanc", "hex": "#f2f3f5"},
    {"name": "Gris", "hex": "#9aa3b2"},
    {"name": "Rouge", "hex": "#d92b2b"},
    {"name": "Orange", "hex": "#f07316"},
    {"name": "Jaune", "hex": "#f2c115"},
    {"name": "Vert", "hex": "#2fa84f"},
    {"name": "Bleu", "hex": "#2563eb"},
    {"name": "Bleu ciel", "hex": "#38bdf8"},
    {"name": "Violet", "hex": "#7c3aed"},
    {"name": "Rose", "hex": "#ec4899"},
    {"name": "Bois", "hex": "#c8a06a"},
    {"name": "Or", "hex": "#c9a227"},
    {"name": "Argent", "hex": "#b9c1cd"},
]


def _palette() -> list[dict]:
    raw = os.environ.get("FILAMENT_COLORS", "").strip()
    if not raw:
        return DEFAULT_PALETTE
    try:
        parsed = json.loads(raw)
    except ValueError:
        return DEFAULT_PALETTE
    colors = []
    for entry in parsed if isinstance(parsed, list) else []:
        if not isinstance(entry, dict):
            continue
        hex_value = str(entry.get("hex", "")).strip().lower()
        if not re.fullmatch(r"#[0-9a-f]{6}", hex_value):
            continue
        colors.append({"name": str(entry.get("name") or hex_value), "hex": hex_value})
    return colors or DEFAULT_PALETTE


PALETTE = _palette()

# How many distinct filament colors one order may use in total — the object's
# color plus every logo color. Four is one AMS/MMU's worth.
MAX_PRINT_COLORS = _int("MAX_PRINT_COLORS", 4)


def color_name(hex_value: str | None) -> str:
    """The palette's name for a color, or the raw hex for anything custom."""
    if not hex_value:
        return ""
    target = hex_value.strip().lower()
    for entry in PALETTE:
        if entry["hex"] == target:
            return entry["name"]
    return target
