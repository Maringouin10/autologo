"""Per-session file + geometry cache.

A "session" is one upload-to-export workflow: a model, optionally a logo,
and whatever the browser last asked us to compute. Files live on disk (so a
worker restart doesn't lose an in-progress upload); the parsed trimesh
objects are cached in memory next to them since re-parsing a large STL on
every slider tweak would make the live preview unusable.
"""
from __future__ import annotations

import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from . import config, meshwork as mw

_lock = threading.Lock()
_sessions: dict[str, "Session"] = {}


@dataclass
class Session:
    id: str
    dir: Path
    created_at: float = field(default_factory=time.time)
    model_ext: str | None = None
    logo_name: str | None = None
    # set True *before* the first mesh() call to load the model as a
    # multi-part assembly (vendor's product-zone builder) instead of a
    # single mesh (the plain single-piece tool)
    is_assembly: bool = False
    # in-memory caches, lazily populated
    _mesh: object | None = field(default=None, repr=False)
    _face_adjacency: object | None = field(default=None, repr=False)
    _logo_polygons: list | None = field(default=None, repr=False)
    parts: list | None = field(default=None, repr=False)   # assembly only
    geoms: dict | None = field(default=None, repr=False)   # assembly only, name -> Trimesh
    part_colors: dict = field(default_factory=dict, repr=False)  # part name -> (r,g,b), from the 3MF if any
    # logo edits (SVG "edit" step): which top-level shapes to skip, and
    # whether to mirror the (remaining) logo before it's placed
    excluded_shapes: set = field(default_factory=set)
    flip_h: bool = False
    flip_v: bool = False

    def touch(self) -> None:
        self.created_at = time.time()

    @property
    def model_path(self) -> Path:
        return self.dir / f"model{self.model_ext}"

    @property
    def logo_path(self) -> Path:
        return self.dir / "logo.svg"

    @property
    def glb_path(self) -> Path:
        return self.dir / "model.glb"

    def mesh(self):
        if self._mesh is None:
            if self.is_assembly:
                self._mesh, self.parts, self.geoms = mw.load_assembly(
                    str(self.model_path), self.model_ext)
            else:
                self._mesh = mw.load_model(str(self.model_path), self.model_ext)
            if self.model_ext == ".3mf":
                self.part_colors = mw.extract_3mf_colors(str(self.model_path))
                if self.is_assembly:
                    mw.apply_part_colors(self._mesh, self.parts, self.part_colors)
                elif self.part_colors:
                    # Vertex, not face, colors — see apply_part_colors: the
                    # lazy face->vertex conversion needs scipy, which this
                    # image doesn't carry.
                    color = next(iter(self.part_colors.values()))
                    self._mesh.visual.vertex_colors = [*color, 255]
        return self._mesh

    def face_adjacency(self):
        if self._face_adjacency is None:
            self.mesh()  # populates self.parts for assemblies
            if self.is_assembly:
                self._face_adjacency = mw.part_isolated_adjacency(self._mesh, self.parts)
            else:
                self._face_adjacency = mw.face_adjacency_of(self._mesh)
        return self._face_adjacency

    def logo_polygons(self) -> list:
        """Every top-level shape parsed from the SVG, unedited — the stable
        base a shape's `index` (from the edit step) refers to."""
        if self._logo_polygons is None:
            self._logo_polygons = mw.load_logo(str(self.logo_path))
        return self._logo_polygons

    def active_logo_polygons(self) -> list:
        """What placement/preview/export should actually use: excluded
        shapes dropped, flip applied."""
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


def create() -> Session:
    sid = uuid.uuid4().hex
    sdir = config.SESSIONS_DIR / sid
    sdir.mkdir(parents=True, exist_ok=True)
    sess = Session(id=sid, dir=sdir)
    with _lock:
        _sessions[sid] = sess
    return sess


def get(session_id: str) -> Session | None:
    with _lock:
        sess = _sessions.get(session_id)
    if sess is not None:
        sess.touch()
        return sess
    # Fall back to disk (e.g. process restarted but the volume persisted).
    sdir = config.SESSIONS_DIR / session_id
    if not sdir.is_dir():
        return None
    model_files = [p for p in sdir.glob("model.*")]
    if not model_files:
        return None
    sess = Session(id=session_id, dir=sdir, model_ext=model_files[0].suffix)
    if (sdir / "logo.svg").exists():
        sess.logo_name = "logo.svg"
    with _lock:
        _sessions[session_id] = sess
    return sess


def cleanup_loop() -> None:
    while True:
        time.sleep(1800)
        cutoff = time.time() - config.SESSION_TTL_HOURS * 3600
        with _lock:
            stale = [sid for sid, s in _sessions.items() if s.created_at < cutoff]
            for sid in stale:
                _sessions.pop(sid, None)
        for sid in stale:
            shutil.rmtree(config.SESSIONS_DIR / sid, ignore_errors=True)
        # also sweep orphaned directories from a previous process
        if config.SESSIONS_DIR.exists():
            for d in config.SESSIONS_DIR.iterdir():
                try:
                    if d.is_dir() and d.stat().st_mtime < cutoff:
                        shutil.rmtree(d, ignore_errors=True)
                except OSError:
                    pass


def start_cleanup_thread() -> None:
    threading.Thread(target=cleanup_loop, daemon=True).start()
