"""All the 3D geometry: loading models/logos, finding a flat face under a
click, placing an extruded SVG logo onto it, and exporting a multi-object
3MF (base + logo as separate objects, so a slicer can assign each its own
filament/color for multi-material printing).

Kept deliberately boolean-free for the interactive "preview" path (placing a
logo on a coplanar patch is pure linear algebra — fast enough to recompute on
every slider move) and boolean-based only for the "deboss" export, which runs
once, on demand, when the user hits Export.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import mapbox_earcut as earcut
import numpy as np
import trimesh
from shapely import affinity

# Faces are grouped into a "flat region" when their normals agree within this
# angle and they sit on (approximately) the same plane as the clicked face.
NORMAL_TOL_DEG = 5.0
# How far (as a fraction of the model's bounding-box diagonal) a face's plane
# may drift from the clicked face's plane and still count as "the same face".
PLANE_TOL_FRAC = 0.0015

class MeshError(Exception):
    pass


# --- loading -------------------------------------------------------------
def load_model(path: str, ext: str) -> trimesh.Trimesh:
    """Load with process=False so face order/count exactly matches what gets
    exported to GLB for the browser — the frontend's raycast faceIndex must
    line up 1:1 with this mesh's `.faces` array."""
    try:
        mesh = trimesh.load(path, file_type=ext.lstrip("."), process=False, force="mesh")
    except Exception as exc:
        raise MeshError(f"impossible de lire le modèle 3D ({exc})") from exc
    if not isinstance(mesh, trimesh.Trimesh) or len(mesh.faces) == 0:
        raise MeshError("le fichier ne contient pas de maillage triangulaire exploitable")
    return mesh


def welded_copy(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    """A vertex-merged copy used only to compute face adjacency (STL/OBJ
    triangles are usually unwelded, so raw `mesh` has none). merge_vertices()
    keeps face count and order identical — only vertex indices change — so
    face indices from `mesh` and this copy are interchangeable."""
    w = mesh.copy()
    w.merge_vertices()
    return w


def face_adjacency_of(mesh: trimesh.Trimesh) -> np.ndarray:
    """Single-part shortcut for find_flat_region's adjacency argument."""
    return welded_copy(mesh).face_adjacency


def load_assembly(path: str, ext: str) -> tuple[trimesh.Trimesh, list[dict], dict]:
    """Load a multi-object 3MF/OBJ "kit" as ONE concatenated mesh (face
    order preserved) plus a manifest of each original part's name and
    face-index range within it, and the original per-part meshes.

    Concatenating lets the interactive viewer/raycaster treat a whole
    assembly exactly like the single-part case (one GLB, one faceIndex
    space) — find_flat_region needs no changes, just a face_adjacency
    array that never bridges two different parts even where their
    surfaces touch (see part_isolated_adjacency). The per-part meshes are
    kept separately for the final export, where each part becomes its own
    3MF object again."""
    try:
        loaded = trimesh.load(path, file_type=ext.lstrip("."), process=False)
    except Exception as exc:
        raise MeshError(f"impossible de lire l'assemblage 3D ({exc})") from exc

    if isinstance(loaded, trimesh.Trimesh):
        geoms = {"piece": loaded}
    elif isinstance(loaded, trimesh.Scene):
        geoms = {name: g for name, g in loaded.geometry.items()
                 if isinstance(g, trimesh.Trimesh) and len(g.faces) > 0}
    else:
        geoms = {}
    if not geoms:
        raise MeshError("l'assemblage ne contient aucune pièce triangulée exploitable")

    parts, all_v, all_f = [], [], []
    vertex_offset = face_offset = 0
    for name, g in geoms.items():
        all_v.append(g.vertices)
        all_f.append(g.faces + vertex_offset)
        parts.append({"name": name, "face_start": face_offset, "face_count": len(g.faces)})
        vertex_offset += len(g.vertices)
        face_offset += len(g.faces)

    combined = trimesh.Trimesh(vertices=np.vstack(all_v), faces=np.vstack(all_f), process=False)
    return combined, parts, geoms


def part_isolated_adjacency(combined: trimesh.Trimesh, parts: list[dict]) -> np.ndarray:
    """face_adjacency for an assembly's combined mesh, welded per part —
    two parts that happen to touch (a seam, a snug-fit joint) must never
    flood-fill into each other."""
    pieces = []
    for part in parts:
        fs, fc = part["face_start"], part["face_count"]
        sub = trimesh.Trimesh(vertices=combined.vertices, faces=combined.faces[fs:fs + fc],
                               process=False)
        sub.merge_vertices()
        if len(sub.face_adjacency):
            pieces.append(sub.face_adjacency + fs)
    return np.vstack(pieces) if pieces else np.empty((0, 2), dtype=np.int64)


def part_for_face(parts: list[dict], face_index: int) -> dict:
    for part in parts:
        if part["face_start"] <= face_index < part["face_start"] + part["face_count"]:
            return part
    raise MeshError("index de face hors de toute pièce connue")


def to_glb(mesh: trimesh.Trimesh) -> bytes:
    return mesh.export(file_type="glb")


def load_logo(path: str) -> list:
    """Parse an SVG into a list of shapely polygons (holes already resolved
    where possible). Returns polygons directly rather than the raw
    `Path2D` — accessing `Path2D.polygons_full` is exactly where this used
    to crash the whole request: a text-only SVG (trimesh's SVG parser
    silently drops `<text>`, leaving zero entities) raises `IndexError`, and
    a self-intersecting/degenerate path can make its hole-nesting step (an
    rtree query) raise `RTreeError` instead of returning something sane.
    Both are handled here, once, so callers downstream can trust the result."""
    try:
        path2d = trimesh.load_path(path)
    except Exception as exc:
        raise MeshError(f"impossible de lire le SVG ({exc})") from exc

    if len(path2d.entities) == 0:
        raise MeshError(
            "le SVG ne contient aucune forme reconnue. S'il contient du "
            "texte, convertissez-le d'abord en tracés (dans Inkscape : "
            "Chemin > Objet en chemin) avant de l'importer."
        )

    try:
        polygons = list(path2d.polygons_full)
    except Exception:
        try:
            polygons = list(path2d.polygons_closed)
        except Exception as exc:
            raise MeshError(
                "le SVG contient une géométrie invalide (tracés qui se "
                "croisent, points dupliqués…) que le moteur n'a pas pu "
                "interpréter. Essayez de le simplifier dans un éditeur "
                f"vectoriel (fusionner les tracés, supprimer les points "
                f"superflus). Détail: {exc}"
            ) from exc

    polygons = [p for p in polygons if p is not None and _is_usable_polygon(p)]
    if not polygons:
        raise MeshError("le SVG ne contient aucune forme fermée exploitable")
    return polygons


def _is_usable_polygon(p) -> bool:
    try:
        return bool(p.is_valid) and p.area > 1e-6
    except Exception:
        return False


def logo_bounds(polygons: list) -> tuple[float, float, float, float]:
    """(minx, miny, maxx, maxy) across every polygon."""
    xs_min, ys_min, xs_max, ys_max = zip(*(p.bounds for p in polygons))
    return min(xs_min), min(ys_min), max(xs_max), max(ys_max)


def shapes_payload(polygons: list) -> list[dict]:
    """One entry per top-level polygon, as plain point lists a browser can
    draw directly (`<path>` with fill-rule evenodd: exterior ring first,
    then each hole). This is what lets a user spot — and exclude — a shape
    that shouldn't be there: a background rectangle, a stray decorative
    piece, or a hole that failed to nest properly and came through as its
    own filled blob instead of a cut-out (e.g. the inside of an "O")."""
    out = []
    for i, p in enumerate(polygons):
        rings = [list(map(list, p.exterior.coords))]
        rings += [list(map(list, ring.coords)) for ring in p.interiors]
        minx, miny, maxx, maxy = p.bounds
        out.append({
            "index": i,
            "bbox": [round(minx, 3), round(miny, 3), round(maxx, 3), round(maxy, 3)],
            "area": round(float(p.area), 3),
            "rings": rings,
        })
    return out


def flip_polygons(polygons: list, flip_h: bool, flip_v: bool) -> list:
    """Mirror every polygon together around their shared bounding-box
    center — flipping each one individually around its own center would
    scramble a multi-piece logo instead of mirroring it as a whole."""
    if not flip_h and not flip_v:
        return polygons
    minx, miny, maxx, maxy = logo_bounds(polygons)
    origin = ((minx + maxx) / 2.0, (miny + maxy) / 2.0)
    xfact = -1.0 if flip_h else 1.0
    yfact = -1.0 if flip_v else 1.0
    return [affinity.scale(p, xfact=xfact, yfact=yfact, origin=origin) for p in polygons]


def fit_to_face(polygons: list, face_width: float, face_height: float,
                 margin_frac: float = 0.04) -> tuple[float, float]:
    """Largest (width_mm, rotation_deg) that fits the logo's bounding box
    inside a face_width x face_height rectangle, leaving a small margin.
    Coarse-scans rotation (bounding-box size is cheap to evaluate) rather
    than solving the minimum-bounding-rectangle problem exactly — the win
    from a better scale dwarfs the loss from a 1-2 degree granularity."""
    usable_w = face_width * (1.0 - margin_frac)
    usable_h = face_height * (1.0 - margin_frac)
    pts = np.vstack([np.asarray(p.exterior.coords) for p in polygons])
    center = pts.mean(axis=0)
    rel = pts - center

    def extent(theta: float) -> tuple[float, float]:
        c, s = math.cos(theta), math.sin(theta)
        rx = rel[:, 0] * c - rel[:, 1] * s
        ry = rel[:, 0] * s + rel[:, 1] * c
        return float(rx.max() - rx.min()), float(ry.max() - ry.min())

    orig_longer = max(*extent(0.0), 1e-6)

    def scale_at(theta: float) -> float:
        w, h = extent(theta)
        if w < 1e-9 or h < 1e-9:
            return 0.0
        return min(usable_w / w, usable_h / h)

    best_deg = max(range(0, 180, 2), key=lambda d: scale_at(math.radians(d)))
    for d in (best_deg - 1, best_deg + 1):
        if scale_at(math.radians(d)) > scale_at(math.radians(best_deg)):
            best_deg = d

    width_mm = scale_at(math.radians(best_deg)) * orig_longer
    return round(width_mm, 3), round(best_deg % 360, 1)


# --- flat-face detection ---------------------------------------------------
@dataclass
class FaceInfo:
    origin: np.ndarray   # world point at the center of the flat region
    normal: np.ndarray   # unit outward normal
    u: np.ndarray        # unit in-plane axis ("local x")
    v: np.ndarray        # unit in-plane axis ("local y")
    width: float          # region extent along u (mm)
    height: float         # region extent along v (mm)
    face_count: int = 0

    def to_json(self) -> dict:
        return {
            "origin": self.origin.tolist(),
            "normal": self.normal.tolist(),
            "u": self.u.tolist(),
            "v": self.v.tolist(),
            "width": round(float(self.width), 3),
            "height": round(float(self.height), 3),
            "face_count": self.face_count,
        }

    @classmethod
    def from_json(cls, data: dict) -> "FaceInfo":
        """Rebuild a FaceInfo a vendor resolved once when setting up a
        product zone — no need to re-run find_flat_region (or even have
        the mesh loaded) just to place a customer's logo on it."""
        return cls(
            origin=np.array(data["origin"], dtype=np.float64),
            normal=np.array(data["normal"], dtype=np.float64),
            u=np.array(data["u"], dtype=np.float64),
            v=np.array(data["v"], dtype=np.float64),
            width=float(data["width"]),
            height=float(data["height"]),
            face_count=int(data.get("face_count", 0)),
        )


def _plane_basis(normal: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    ref = np.array([1.0, 0.0, 0.0]) if abs(normal[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
    u = np.cross(normal, ref)
    u /= np.linalg.norm(u)
    v = np.cross(normal, u)
    return u, v


def find_flat_region(mesh: trimesh.Trimesh, face_adjacency: np.ndarray, face_index: int) -> FaceInfo:
    """`face_adjacency` is topology only (which faces share an edge) — the
    geometry measured is always the original, unwelded `mesh`. Pass
    `face_adjacency_of(mesh)` for a single part, or
    `part_isolated_adjacency(mesh, parts)` for an assembly (so the flood
    fill below can never cross from one part into another)."""
    if face_index < 0 or face_index >= len(mesh.faces):
        raise MeshError("index de face invalide")

    normals = mesh.face_normals
    centers = mesh.triangles_center
    n0 = normals[face_index]
    p0 = centers[face_index]
    scale = float(mesh.scale) if mesh.scale else 1.0
    plane_tol = max(scale * PLANE_TOL_FRAC, 1e-4)
    normal_cos_min = math.cos(math.radians(NORMAL_TOL_DEG))

    adj = face_adjacency
    neighbors: dict[int, list[int]] = {}
    for a, b in adj:
        neighbors.setdefault(int(a), []).append(int(b))
        neighbors.setdefault(int(b), []).append(int(a))

    visited = {face_index}
    stack = [face_index]
    while stack:
        f = stack.pop()
        for nb in neighbors.get(f, ()):
            if nb in visited:
                continue
            if float(np.dot(normals[nb], n0)) < normal_cos_min:
                continue
            if abs(float(np.dot(n0, centers[nb] - p0))) > plane_tol:
                continue
            visited.add(nb)
            stack.append(nb)

    region = np.fromiter(visited, dtype=np.int64)
    u, v = _plane_basis(n0)
    pts = mesh.vertices[mesh.faces[region]].reshape(-1, 3)
    rel = pts - p0
    pu = rel @ u
    pv = rel @ v
    width = float(pu.max() - pu.min())
    height = float(pv.max() - pv.min())
    center_u = float((pu.max() + pu.min()) / 2.0)
    center_v = float((pv.max() + pv.min()) / 2.0)
    origin = p0 + center_u * u + center_v * v

    return FaceInfo(origin=origin, normal=n0, u=u, v=v,
                     width=max(width, 0.01), height=max(height, 0.01),
                     face_count=len(region))


# --- logo placement ---------------------------------------------------------
@dataclass
class PlacementParams:
    width_mm: float = 20.0     # target size of the logo's LONGER side, in mm
    rotation_deg: float = 0.0
    offset_x_mm: float = 0.0    # along `u`
    offset_y_mm: float = 0.0    # along `v`


def _ring_points(coords) -> np.ndarray:
    """Ring coordinates, closing point dropped and consecutive near-duplicate
    points collapsed. SVG curves flattened to polylines occasionally emit a
    repeated point at a segment boundary (not just at the ring's own
    open/close seam) — a zero-length edge there produces a degenerate
    triangle and, with it, a non-manifold seam that breaks every boolean op
    downstream, so this has to be caught before triangulating."""
    pts = np.array(coords, dtype=np.float64)
    if len(pts) > 1 and np.allclose(pts[0], pts[-1]):
        pts = pts[:-1]
    if len(pts) < 3:
        return pts
    out = [pts[0]]
    for p in pts[1:]:
        if np.linalg.norm(p - out[-1]) > 1e-7:
            out.append(p)
    if len(out) > 1 and np.linalg.norm(out[-1] - out[0]) < 1e-7:
        out.pop()
    return np.array(out)


def _signed_area(pts: np.ndarray) -> float:
    x, y = pts[:, 0], pts[:, 1]
    return 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


def _extrude_polygon(polygon, height: float) -> trimesh.Trimesh:
    """Extrude a single (possibly holed) shapely polygon into a watertight
    solid. Hand-rolled instead of trimesh's own Path2D.extrude(): that path
    reliably produced non-manifold seams (duplicate/degenerate wall
    triangles where a ring's closing vertex repeats the first one) on plain
    closed shapes like a circle, which then made every boolean op downstream
    fail with "not a volume"."""
    ext = _ring_points(polygon.exterior.coords)
    if _signed_area(ext) < 0:
        ext = ext[::-1]
    holes = []
    for ring in polygon.interiors:
        h = _ring_points(ring.coords)
        if _signed_area(h) > 0:
            h = h[::-1]
        holes.append(h)

    rings = [ext] + holes
    verts2d = np.vstack(rings)
    ring_ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
    cap_faces = earcut.triangulate_float64(verts2d, ring_ends).reshape(-1, 3).astype(np.int64)

    n = len(verts2d)
    vertices = np.vstack([
        np.column_stack([verts2d, np.zeros(n)]),
        np.column_stack([verts2d, np.full(n, height)]),
    ])
    bottom_faces = cap_faces[:, ::-1]     # facing -z
    top_faces = cap_faces + n              # facing +z

    wall_faces = []
    offset = 0
    for ring in rings:
        m = len(ring)
        for i in range(m):
            a = offset + i
            b = offset + (i + 1) % m
            wall_faces.append((a, b, b + n))
            wall_faces.append((a, b + n, a + n))
        offset += m

    faces = np.vstack([bottom_faces, top_faces, np.array(wall_faces, dtype=np.int64)])
    return trimesh.Trimesh(vertices=vertices, faces=faces, process=False)


def _logo_local_mesh(polygons: list, params: PlacementParams, height: float) -> trimesh.Trimesh:
    """Extruded logo in its own local XY frame, centered on (0,0), z in
    [0, height]. Scale is derived from `width_mm` vs. the SVG's own bbox."""
    minx, miny, maxx, maxy = logo_bounds(polygons)
    bw, bh = float(maxx - minx), float(maxy - miny)
    longer = max(bw, bh, 1e-6)
    scale = params.width_mm / longer
    cx, cy = float(minx + maxx) / 2.0, float(miny + maxy) / 2.0

    theta = math.radians(params.rotation_deg)
    c, s = math.cos(theta), math.sin(theta)
    # shapely's affine_transform matrix: x' = a*x + b*y + xoff; y' = d*x + e*y + yoff
    # (center on the logo's own bbox, then scale, then rotate, then offset)
    a, b = scale * c, -scale * s
    d, e = scale * s, scale * c
    xoff = params.offset_x_mm - (a * cx + b * cy)
    yoff = params.offset_y_mm - (d * cx + e * cy)
    matrix = [a, b, d, e, xoff, yoff]

    parts = []
    for poly in polygons:
        transformed = affinity.affine_transform(poly, matrix)
        parts.append(_extrude_polygon(transformed, height))
    return trimesh.util.concatenate(parts) if len(parts) > 1 else parts[0]


def _to_world(mesh: trimesh.Trimesh, face: FaceInfo, z_shift: float) -> trimesh.Trimesh:
    mesh = mesh.copy()
    mesh.apply_translation([0.0, 0.0, z_shift])
    rot = np.eye(4)
    rot[:3, 0] = face.u
    rot[:3, 1] = face.v
    rot[:3, 2] = face.normal
    rot[:3, 3] = face.origin
    mesh.apply_transform(rot)
    return mesh


def preview_logo(polygons: list, face: FaceInfo, params: PlacementParams,
                  thickness: float = 0.6) -> trimesh.Trimesh:
    """Thin slab sitting just above the surface — fast to recompute on every
    slider tweak, purely for visual placement feedback."""
    local = _logo_local_mesh(polygons, params, thickness)
    return _to_world(local, face, z_shift=0.05)


def emboss(polygons: list, face: FaceInfo, params: PlacementParams,
           depth_mm: float, sink_mm: float) -> trimesh.Trimesh:
    """The logo as a standalone, raised object. `sink_mm` buries a sliver of
    its base in the model so the two parts overlap (and bond) instead of
    merely touching."""
    height = depth_mm + sink_mm
    local = _logo_local_mesh(polygons, params, height)
    return _to_world(local, face, z_shift=-sink_mm)


def deboss(base: trimesh.Trimesh, polygons: list, face: FaceInfo, params: PlacementParams,
           depth_mm: float, fill_extra_mm: float = 0.0
           ) -> tuple[trimesh.Trimesh, trimesh.Trimesh]:
    """Engrave the logo into `base` and return (pocketed_base, fill_piece).
    The fill piece is sized to exactly occupy the pocket (plus `fill_extra_mm`
    proud of the surface), so it can be printed in a different filament and
    fits back in. Requires `manifold3d` for the boolean cut."""
    cut_over = max(1.0, depth_mm * 0.5)  # tool must poke out past the surface to cut cleanly
    tool_local = _logo_local_mesh(polygons, params, depth_mm + cut_over)
    tool = _to_world(tool_local, face, z_shift=-depth_mm)
    # STL/OBJ triangles are usually unwelded (each face owns private vertex
    # copies), so an un-merged mesh never satisfies is_volume even when it is
    # geometrically closed — weld before handing it to the boolean engine.
    base_w = base.copy()
    base_w.merge_vertices()
    try:
        pocketed = base_w.difference(tool, engine="manifold")
    except Exception as exc:
        raise MeshError(
            "la découpe du logo a échoué — le modèle n'est probablement pas "
            "étanche (\"watertight\"). Essayez le mode relief (emboss) à la "
            f"place, ou réparez le maillage avant import. Détail: {exc}"
        ) from exc
    if pocketed.is_empty:
        raise MeshError("la découpe a supprimé tout le modèle — logo trop grand/profond ?")

    fill_local = _logo_local_mesh(polygons, params, depth_mm + fill_extra_mm)
    fill = _to_world(fill_local, face, z_shift=-depth_mm)
    return pocketed, fill


# --- export ------------------------------------------------------------------
def export_3mf(named_meshes: dict[str, trimesh.Trimesh]) -> bytes:
    scene = trimesh.Scene()
    for name, mesh in named_meshes.items():
        scene.add_geometry(mesh, node_name=name, geom_name=name)
    data = scene.export(file_type="3mf")
    if isinstance(data, str):
        data = data.encode("utf-8")
    return data
