"""Customer-facing order workflow: place a logo on the zone(s) a vendor
marked as customizable on a product, then generate the final 3MF.

A ZoneWork only ever needs a zone's stored FaceInfo (resolved once by the
vendor when building the product) plus whatever logo/placement the customer
chose — never the actual part mesh, so uploading a logo and previewing its
placement stays as cheap as the single-tool flow. The part meshes are only
loaded once, at submit time, to cut/emboss them for real and build the
final export.
"""
from __future__ import annotations

import json
import random
import shutil
import string
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from . import config, db, meshwork as mw

_lock = threading.Lock()
_order_sessions: dict[str, "OrderSession"] = {}


@dataclass
class ZoneWork:
    zone_id: int
    dir: Path
    _logo_polygons: list | None = field(default=None, repr=False)
    excluded_shapes: set = field(default_factory=set)
    flip_h: bool = False
    flip_v: bool = False
    width_mm: float = 20.0
    rotation_deg: float = 0.0
    offset_x_mm: float = 0.0
    offset_y_mm: float = 0.0

    @property
    def logo_path(self) -> Path:
        return self.dir / f"zone_{self.zone_id}.svg"

    def has_logo(self) -> bool:
        return self.logo_path.exists()

    def logo_polygons(self) -> list:
        if self._logo_polygons is None:
            self._logo_polygons = mw.load_logo(str(self.logo_path))
        return self._logo_polygons

    def active_logo_polygons(self) -> list:
        polys = self.logo_polygons()
        active = [p for i, p in enumerate(polys) if i not in self.excluded_shapes]
        if not active:
            raise mw.MeshError("toutes les formes du logo sont exclues — incluez-en au moins une")
        return mw.flip_polygons(active, self.flip_h, self.flip_v)

    def invalidate_logo(self) -> None:
        self._logo_polygons = None
        self.excluded_shapes = set()
        self.flip_h = False
        self.flip_v = False

    def placement_params(self) -> "mw.PlacementParams":
        return mw.PlacementParams(width_mm=self.width_mm, rotation_deg=self.rotation_deg,
                                   offset_x_mm=self.offset_x_mm, offset_y_mm=self.offset_y_mm)


@dataclass
class OrderSession:
    id: str
    dir: Path
    product_id: str
    created_at: float = field(default_factory=time.time)
    zones: dict = field(default_factory=dict)  # zone_id -> ZoneWork

    def touch(self) -> None:
        self.created_at = time.time()

    def zone(self, zone_id: int) -> ZoneWork:
        if zone_id not in self.zones:
            self.zones[zone_id] = ZoneWork(zone_id=zone_id, dir=self.dir)
        return self.zones[zone_id]


def start(product_id: str) -> OrderSession:
    sid = uuid.uuid4().hex
    sdir = config.DATA_DIR / "order_sessions" / sid
    sdir.mkdir(parents=True, exist_ok=True)
    sess = OrderSession(id=sid, dir=sdir, product_id=product_id)
    with _lock:
        _order_sessions[sid] = sess
    return sess


def get(order_session_id: str) -> OrderSession | None:
    with _lock:
        sess = _order_sessions.get(order_session_id)
    if sess is not None:
        sess.touch()
    return sess


def cleanup_loop() -> None:
    while True:
        time.sleep(1800)
        cutoff = time.time() - config.SESSION_TTL_HOURS * 3600
        with _lock:
            stale = [sid for sid, s in _order_sessions.items() if s.created_at < cutoff]
            for sid in stale:
                _order_sessions.pop(sid, None)
        for sid in stale:
            shutil.rmtree(config.DATA_DIR / "order_sessions" / sid, ignore_errors=True)


def start_cleanup_thread() -> None:
    threading.Thread(target=cleanup_loop, daemon=True).start()


def _new_order_code() -> str:
    alphabet = string.ascii_uppercase + string.digits
    for _ in range(20):
        code = "".join(random.choices(alphabet, k=8))
        if db.get_order(code) is None:
            return code
    raise RuntimeError("impossible de générer un numéro de commande unique")


def submit(sess: OrderSession) -> str:
    """Build the final 3MF for every zone in the order and persist it.
    Returns the order code shown to the customer."""
    product = db.get_product(sess.product_id)
    if product is None:
        raise mw.MeshError("produit introuvable")
    zone_rows = {z["id"]: z for z in db.list_zones(sess.product_id)}
    if not zone_rows:
        raise mw.MeshError("ce produit n'a aucune zone personnalisable")

    missing = [z["label"] for zid, z in zone_rows.items() if zid not in sess.zones
               or not sess.zones[zid].has_logo()]
    if missing:
        raise mw.MeshError("logo manquant pour: " + ", ".join(missing))

    model_path = config.PRODUCTS_DIR / product["id"] / f"model{product['model_ext']}"
    _, _, geoms = mw.load_assembly(str(model_path), product["model_ext"])

    # Parts get customized (and possibly cut) in place across zones that
    # share the same part, so work on private copies, applied zone by zone.
    working_parts = {name: mesh.copy() for name, mesh in geoms.items()}
    touched_parts: set[str] = set()
    named: dict = {}

    for zone_id, work in sess.zones.items():
        row = zone_rows[zone_id]
        part_name = row["part_name"]
        if part_name not in working_parts:
            raise mw.MeshError(f"pièce '{part_name}' introuvable dans le modèle")
        face = mw.FaceInfo.from_json(json.loads(row["face_json"]))
        polygons = work.active_logo_polygons()
        params = work.placement_params()
        touched_parts.add(part_name)

        if row["mode"] == "emboss":
            logo = mw.emboss(polygons, face, params, depth_mm=row["depth_mm"], sink_mm=row["sink_mm"])
            named[f"{part_name}_logo_{zone_id}"] = logo
        else:
            pocketed, fill = mw.deboss(working_parts[part_name], polygons, face, params,
                                        depth_mm=row["depth_mm"], fill_extra_mm=row["fill_extra_mm"])
            working_parts[part_name] = pocketed
            named[f"{part_name}_logo_{zone_id}"] = fill

    for name in touched_parts:
        named[name] = working_parts[name]
    if product["export_mode"] == "assembly":
        for name, mesh in working_parts.items():
            if name not in touched_parts:
                named[name] = mesh

    data_3mf = mw.export_3mf(named)

    code = _new_order_code()
    order_dir = config.ORDERS_DIR / code
    order_dir.mkdir(parents=True, exist_ok=True)
    output_path = order_dir / "output.3mf"
    output_path.write_bytes(data_3mf)
    db.create_order(code, sess.product_id, str(output_path))
    return code
