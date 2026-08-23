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


def to_glb(mesh: trimesh.Trimesh) -> bytes:
    return mesh.export(file_type="glb")


def load_logo(path: str) -> "trimesh.path.Path2D":
    try:
        path2d = trimesh.load_path(path)
    except Exception as exc:
        raise MeshError(f"impossible de lire le SVG ({exc})") from exc
    if path2d.polygons_full is None or len(path2d.polygons_full) == 0:
        raise MeshError("le SVG ne contient aucune forme fermée exploitable")
    return path2d


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


def _plane_basis(normal: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    ref = np.array([1.0, 0.0, 0.0]) if abs(normal[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
    u = np.cross(normal, ref)
    u /= np.linalg.norm(u)
    v = np.cross(normal, u)
    return u, v


def find_flat_region(mesh: trimesh.Trimesh, welded: trimesh.Trimesh, face_index: int) -> FaceInfo:
    if face_index < 0 or face_index >= len(mesh.faces):
        raise MeshError("index de face invalide")

    normals = mesh.face_normals
    centers = mesh.triangles_center
    n0 = normals[face_index]
    p0 = centers[face_index]
    scale = float(mesh.scale) if mesh.scale else 1.0
    plane_tol = max(scale * PLANE_TOL_FRAC, 1e-4)
    normal_cos_min = math.cos(math.radians(NORMAL_TOL_DEG))

    # Adjacency graph over the welded copy (topology only — the geometry we
    # measure always comes from the original, unwelded `mesh`).
    adj = welded.face_adjacency
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


def _logo_local_mesh(path2d, params: PlacementParams, height: float) -> trimesh.Trimesh:
    """Extruded logo in its own local XY frame, centered on (0,0), z in
    [0, height]. Scale is derived from `width_mm` vs. the SVG's own bbox."""
    polygons = path2d.polygons_full
    if not polygons:
        raise MeshError("le SVG ne contient aucune forme fermée exploitable")

    minx, miny, maxx, maxy = path2d.bounds[0][0], path2d.bounds[0][1], path2d.bounds[1][0], path2d.bounds[1][1]
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


def preview_logo(path2d, face: FaceInfo, params: PlacementParams,
                  thickness: float = 0.6) -> trimesh.Trimesh:
    """Thin slab sitting just above the surface — fast to recompute on every
    slider tweak, purely for visual placement feedback."""
    local = _logo_local_mesh(path2d, params, thickness)
    return _to_world(local, face, z_shift=0.05)


def emboss(path2d, face: FaceInfo, params: PlacementParams,
           depth_mm: float, sink_mm: float) -> trimesh.Trimesh:
    """The logo as a standalone, raised object. `sink_mm` buries a sliver of
    its base in the model so the two parts overlap (and bond) instead of
    merely touching."""
    height = depth_mm + sink_mm
    local = _logo_local_mesh(path2d, params, height)
    return _to_world(local, face, z_shift=-sink_mm)


def deboss(base: trimesh.Trimesh, path2d, face: FaceInfo, params: PlacementParams,
           depth_mm: float, fill_extra_mm: float = 0.0
           ) -> tuple[trimesh.Trimesh, trimesh.Trimesh]:
    """Engrave the logo into `base` and return (pocketed_base, fill_piece).
    The fill piece is sized to exactly occupy the pocket (plus `fill_extra_mm`
    proud of the surface), so it can be printed in a different filament and
    fits back in. Requires `manifold3d` for the boolean cut."""
    cut_over = max(1.0, depth_mm * 0.5)  # tool must poke out past the surface to cut cleanly
    tool_local = _logo_local_mesh(path2d, params, depth_mm + cut_over)
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

    fill_local = _logo_local_mesh(path2d, params, depth_mm + fill_extra_mm)
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
