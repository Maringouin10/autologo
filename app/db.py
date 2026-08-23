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
    created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS zones (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id    TEXT NOT NULL REFERENCES products(id),
    part_name     TEXT NOT NULL,
    label         TEXT NOT NULL,
    face_json     TEXT NOT NULL,   -- serialized meshwork.FaceInfo (origin/normal/u/v/width/height)
    mode          TEXT NOT NULL,   -- emboss | deboss — vendor-locked, never shown to the customer
    depth_mm      REAL NOT NULL,
    sink_mm       REAL NOT NULL DEFAULT 0.3,
    fill_extra_mm REAL NOT NULL DEFAULT 0.0,
    sort_order    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_zones_product ON zones(product_id);

CREATE TABLE IF NOT EXISTS orders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    code         TEXT UNIQUE NOT NULL,
    product_id   TEXT NOT NULL REFERENCES products(id),
    created_at   TEXT NOT NULL,
    output_path  TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_product ON orders(product_id);
"""


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


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# --- products ------------------------------------------------------------
def create_product(product_id: str, name: str, model_ext: str, export_mode: str,
                    bounds_json: str = "{}") -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO products (id, name, model_ext, export_mode, bounds_json, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (product_id, name, model_ext, export_mode, bounds_json, _now()),
        )


def get_product(product_id: str) -> sqlite3.Row | None:
    with get_conn() as conn:
        return conn.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()


def list_products() -> list[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute("SELECT * FROM products ORDER BY created_at DESC").fetchall()


def delete_product(product_id: str) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM zones WHERE product_id = ?", (product_id,))
        conn.execute("DELETE FROM orders WHERE product_id = ?", (product_id,))
        conn.execute("DELETE FROM products WHERE id = ?", (product_id,))


# --- zones -----------------------------------------------------------------
def add_zone(product_id: str, part_name: str, label: str, face_json: str, mode: str,
             depth_mm: float, sink_mm: float, fill_extra_mm: float, sort_order: int) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO zones (product_id, part_name, label, face_json, mode, depth_mm, "
            "sink_mm, fill_extra_mm, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (product_id, part_name, label, face_json, mode, depth_mm, sink_mm,
             fill_extra_mm, sort_order),
        )
        return cur.lastrowid


def list_zones(product_id: str) -> list[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM zones WHERE product_id = ? ORDER BY sort_order, id", (product_id,)
        ).fetchall()


def get_zone(zone_id: int) -> sqlite3.Row | None:
    with get_conn() as conn:
        return conn.execute("SELECT * FROM zones WHERE id = ?", (zone_id,)).fetchone()


# --- orders ------------------------------------------------------------------
def create_order(code: str, product_id: str, output_path: str) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO orders (code, product_id, created_at, output_path) VALUES (?, ?, ?, ?)",
            (code, product_id, _now(), output_path),
        )
        return cur.lastrowid


def get_order(code: str) -> sqlite3.Row | None:
    with get_conn() as conn:
        return conn.execute("SELECT * FROM orders WHERE code = ?", (code,)).fetchone()


def list_orders(product_id: str) -> list[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM orders WHERE product_id = ? ORDER BY created_at DESC", (product_id,)
        ).fetchall()
