"""Tiny SQLite layer for the vendor platform: products (an uploaded
assembly + the zones a customer is allowed to customize) and the orders
customers submit against them. One short-lived connection per operation,
same pattern as shortgen's db.py in the sibling app."""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS products (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    model_ext    TEXT NOT NULL,
    export_mode  TEXT NOT NULL DEFAULT 'assembly',  -- assembly | part
    bounds_json  TEXT NOT NULL DEFAULT '{}',        -- {"min":[x,y,z],"max":[x,y,z]} for the viewer camera
    colors_json  TEXT NOT NULL DEFAULT '{}',        -- {part_name: [r,g,b]}, extracted from the 3MF if any
    created_at   TEXT NOT NULL,
    family       TEXT NOT NULL DEFAULT '',          -- products sharing one non-empty key are variants of each other
    variant_label TEXT NOT NULL DEFAULT ''          -- how the customer's variant chooser names this one
);

CREATE TABLE IF NOT EXISTS zones (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id    TEXT NOT NULL REFERENCES products(id),
    part_name     TEXT NOT NULL,
    label         TEXT NOT NULL,
    face_index    INTEGER NOT NULL DEFAULT -1,  -- triangle the vendor clicked; -1 = legacy zone
    face_json     TEXT NOT NULL,   -- serialized meshwork.FaceInfo (origin/normal/u/v/width/height/outline)
    mode          TEXT NOT NULL,   -- emboss | deboss — vendor-locked, never shown to the customer
    depth_mm      REAL NOT NULL,
    sink_mm       REAL NOT NULL DEFAULT 0.3,
    fill_extra_mm REAL NOT NULL DEFAULT 0.0,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    group_key     TEXT NOT NULL DEFAULT '',  -- zones sharing one non-empty key are identical faces
    kind          TEXT NOT NULL DEFAULT 'logo',  -- logo (customer places it) | qr (vendor places it)
    qr_text       TEXT NOT NULL DEFAULT '',      -- qr zones: what the code encodes
    qr_width_mm   REAL NOT NULL DEFAULT 20.0,    -- qr zones: placement, fixed by the vendor
    qr_rotation_deg REAL NOT NULL DEFAULT 0.0,
    qr_offset_x_mm  REAL NOT NULL DEFAULT 0.0,
    qr_offset_y_mm  REAL NOT NULL DEFAULT 0.0
);
CREATE INDEX IF NOT EXISTS idx_zones_product ON zones(product_id);

CREATE TABLE IF NOT EXISTS orders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    code         TEXT UNIQUE NOT NULL,
    product_id   TEXT NOT NULL REFERENCES products(id),
    created_at   TEXT NOT NULL,
    output_path  TEXT,
    status       TEXT NOT NULL DEFAULT 'new',  -- new | done
    colors_json  TEXT NOT NULL DEFAULT '{}'    -- filament colors the customer picked
);
CREATE INDEX IF NOT EXISTS idx_orders_product ON orders(product_id);
"""

# Columns added after the initial release — applied to existing DBs on startup
# (same pattern as the sibling shortgen app's db.py). `CREATE TABLE IF NOT
# EXISTS` only creates a *new* table; a column added to SCHEMA later never
# reaches a database whose `products`/`orders` table already existed, hence
# these ALTER TABLEs run every startup (each one a no-op once applied).
_MIGRATIONS = {
    "products": {
        "bounds_json": "TEXT NOT NULL DEFAULT '{}'",
        "colors_json": "TEXT NOT NULL DEFAULT '{}'",
        "family": "TEXT NOT NULL DEFAULT ''",
        "variant_label": "TEXT NOT NULL DEFAULT ''",
    },
    "orders": {
        "status": "TEXT NOT NULL DEFAULT 'new'",
        "colors_json": "TEXT NOT NULL DEFAULT '{}'",
    },
    "zones": {
        "face_index": "INTEGER NOT NULL DEFAULT -1",
        "group_key": "TEXT NOT NULL DEFAULT ''",
        "kind": "TEXT NOT NULL DEFAULT 'logo'",
        "qr_text": "TEXT NOT NULL DEFAULT ''",
        "qr_width_mm": "REAL NOT NULL DEFAULT 20.0",
        "qr_rotation_deg": "REAL NOT NULL DEFAULT 0.0",
        "qr_offset_x_mm": "REAL NOT NULL DEFAULT 0.0",
        "qr_offset_y_mm": "REAL NOT NULL DEFAULT 0.0",
    },
}


@contextmanager
def get_conn():
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(config.DB_PATH), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript(SCHEMA)
        for table, cols in _MIGRATIONS.items():
            existing = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
            for col, col_type in cols.items():
                if col not in existing:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {col_type}")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# --- products ------------------------------------------------------------
def create_product(product_id: str, name: str, model_ext: str, export_mode: str,
                    bounds_json: str = "{}", colors_json: str = "{}",
                    family: str = "", variant_label: str = "") -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO products (id, name, model_ext, export_mode, bounds_json, "
            "colors_json, created_at, family, variant_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (product_id, name, model_ext, export_mode, bounds_json, colors_json, _now(),
             family, variant_label),
        )


def get_product(product_id: str) -> sqlite3.Row | None:
    with get_conn() as conn:
        return conn.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()


def list_products() -> list[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute("SELECT * FROM products ORDER BY created_at DESC").fetchall()


def update_product(product_id: str, name: str, export_mode: str,
                    family: str | None = None, variant_label: str | None = None) -> None:
    with get_conn() as conn:
        conn.execute("UPDATE products SET name = ?, export_mode = ? WHERE id = ?",
                      (name, export_mode, product_id))
        if family is not None:
            conn.execute("UPDATE products SET family = ? WHERE id = ?", (family, product_id))
        if variant_label is not None:
            conn.execute("UPDATE products SET variant_label = ? WHERE id = ?",
                          (variant_label, product_id))


def list_variants(family: str) -> list[sqlite3.Row]:
    """Every product of a family, oldest first (the order the customer sees them in)."""
    if not family:
        return []
    with get_conn() as conn:
        return conn.execute("SELECT * FROM products WHERE family = ? ORDER BY created_at, id",
                             (family,)).fetchall()


def set_family(product_id: str, family: str) -> None:
    with get_conn() as conn:
        conn.execute("UPDATE products SET family = ? WHERE id = ?", (family, product_id))


def replace_zones(product_id: str, zones: list[dict]) -> None:
    """Swap a product's whole zone list in one transaction, so a failed edit
    can't leave it half-updated (or, worse, with no zones at all — which
    would 404 its public page)."""
    with get_conn() as conn:
        conn.execute("DELETE FROM zones WHERE product_id = ?", (product_id,))
        for i, z in enumerate(zones):
            conn.execute(
                "INSERT INTO zones (product_id, part_name, label, face_index, face_json, mode, "
                "depth_mm, sink_mm, fill_extra_mm, sort_order, group_key, kind, qr_text, "
                "qr_width_mm, qr_rotation_deg, qr_offset_x_mm, qr_offset_y_mm) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (product_id, z["part_name"], z["label"], z["face_index"], z["face_json"],
                 z["mode"], z["depth_mm"], z["sink_mm"], z["fill_extra_mm"], i,
                 z.get("group_key", ""), z.get("kind", "logo"), z.get("qr_text", ""),
                 z.get("qr_width_mm", 20.0), z.get("qr_rotation_deg", 0.0),
                 z.get("qr_offset_x_mm", 0.0), z.get("qr_offset_y_mm", 0.0)),
            )


def delete_product(product_id: str) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM zones WHERE product_id = ?", (product_id,))
        conn.execute("DELETE FROM orders WHERE product_id = ?", (product_id,))
        conn.execute("DELETE FROM products WHERE id = ?", (product_id,))


# --- zones -----------------------------------------------------------------
def add_zone(product_id: str, part_name: str, label: str, face_json: str, mode: str,
             depth_mm: float, sink_mm: float, fill_extra_mm: float, sort_order: int,
             face_index: int = -1, group_key: str = "") -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO zones (product_id, part_name, label, face_index, face_json, mode, "
            "depth_mm, sink_mm, fill_extra_mm, sort_order, group_key) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (product_id, part_name, label, face_index, face_json, mode, depth_mm, sink_mm,
             fill_extra_mm, sort_order, group_key),
        )
        return cur.lastrowid


def update_zone_face(zone_id: int, face_json: str, face_index: int) -> None:
    """Persist a repaired face (see main._zone_face) so the recomputation
    only ever happens once per legacy zone."""
    with get_conn() as conn:
        conn.execute("UPDATE zones SET face_json = ?, face_index = ? WHERE id = ?",
                      (face_json, face_index, zone_id))


def list_zones(product_id: str) -> list[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM zones WHERE product_id = ? ORDER BY sort_order, id", (product_id,)
        ).fetchall()


def list_logo_zones(product_id: str) -> list[sqlite3.Row]:
    """The zones a customer places a logo on (everything but the vendor's QR codes)."""
    return [z for z in list_zones(product_id) if z["kind"] != "qr"]


def list_qr_zones(product_id: str) -> list[sqlite3.Row]:
    return [z for z in list_zones(product_id) if z["kind"] == "qr"]


def get_zone(zone_id: int) -> sqlite3.Row | None:
    with get_conn() as conn:
        return conn.execute("SELECT * FROM zones WHERE id = ?", (zone_id,)).fetchone()


def count_zones_by_product() -> dict[str, int]:
    """{product_id: number of customer-facing zones} in one query — the admin
    product list shows it for every product at once. QR zones are the
    vendor's own and are not counted."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT product_id, COUNT(*) AS n FROM zones WHERE kind != 'qr' "
            "GROUP BY product_id").fetchall()
    return {r["product_id"]: r["n"] for r in rows}


def count_pending_orders_by_product() -> dict[str, int]:
    """{product_id: number of orders still to process}, same idea."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT product_id, COUNT(*) AS n FROM orders WHERE status != 'done' "
            "GROUP BY product_id").fetchall()
    return {r["product_id"]: r["n"] for r in rows}


# --- orders ------------------------------------------------------------------
def create_order(code: str, product_id: str, output_path: str,
                  colors_json: str = "{}") -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO orders (code, product_id, created_at, output_path, colors_json) "
            "VALUES (?, ?, ?, ?, ?)",
            (code, product_id, _now(), output_path, colors_json),
        )
        return cur.lastrowid


def get_order(code: str) -> sqlite3.Row | None:
    with get_conn() as conn:
        return conn.execute("SELECT * FROM orders WHERE code = ?", (code,)).fetchone()


def list_orders(product_id: str, include_done: bool = False) -> list[sqlite3.Row]:
    with get_conn() as conn:
        query = "SELECT * FROM orders WHERE product_id = ?"
        if not include_done:
            query += " AND status != 'done'"
        return conn.execute(query + " ORDER BY created_at DESC", (product_id,)).fetchall()


def list_all_orders(include_done: bool = False) -> list[sqlite3.Row]:
    """Every order across every product, newest first, with the product's
    name joined in — for the cross-product admin orders page."""
    with get_conn() as conn:
        query = ("SELECT orders.*, products.name AS product_name FROM orders "
                 "JOIN products ON products.id = orders.product_id")
        if not include_done:
            query += " WHERE orders.status != 'done'"
        return conn.execute(query + " ORDER BY orders.created_at DESC").fetchall()


def mark_order_done(code: str) -> None:
    with get_conn() as conn:
        conn.execute("UPDATE orders SET status = 'done' WHERE code = ?", (code,))
