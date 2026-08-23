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

import io
import math
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass, field

import mapbox_earcut as earcut
import numpy as np
import trimesh
from shapely import affinity
from shapely.geometry import Polygon as ShapelyPolygon
from shapely.geometry import box as shapely_box
from shapely.ops import unary_union

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


_3MF_CORE_NS = "{http://schemas.microsoft.com/3dmanufacturing/core/2015/02}"
_3MF_MATERIAL_NS = "{http://schemas.microsoft.com/3dmanufacturing/material/2015/02}"
DEFAULT_PART_COLOR = (143, 166, 201)  # matches the viewer's flat default (0x8fa6c9)


def extract_3mf_colors(path: str) -> dict[str, tuple[int, int, int]]:
    """Best-effort: pull each named <object>'s display color out of a 3MF's
    <basematerials>/<m:colorgroup> resources. trimesh's own 3MF reader
    doesn't surface color at all (verified: every part comes back the same
    flat gray regardless of what the file actually says), so this parses
    the model XML directly. Never raises — a 3MF with no color info (most
    plain STL/engineering exports) just yields an empty dict, same as a
    non-3MF file."""
    try:
        with zipfile.ZipFile(path) as z:
            model_name = next((n for n in z.namelist() if n.lower().endswith(".model")), None)
            if not model_name:
                return {}
            root = ET.fromstring(z.read(model_name))
    except Exception:
        return {}

    def parse_hex(s):
        s = (s or "").lstrip("#")
        if len(s) < 6:
            return None
        try:
            return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
        except ValueError:
            return None

    groups: dict[str, list] = {}
    for bm in root.iter(f"{_3MF_CORE_NS}basematerials"):
        groups[bm.get("id")] = [parse_hex(b.get("displaycolor")) for b in bm]
    for cg in root.iter(f"{_3MF_MATERIAL_NS}colorgroup"):
        groups[cg.get("id")] = [parse_hex(c.get("color")) for c in cg]

    result: dict[str, tuple[int, int, int]] = {}
    for obj in root.iter(f"{_3MF_CORE_NS}object"):
        name, pid, pindex = obj.get("name"), obj.get("pid"), obj.get("pindex")
        if not name or pid not in groups or pindex is None:
            continue
        try:
            color = groups[pid][int(pindex)]
        except (ValueError, IndexError):
            continue
        if color:
            result[name] = color
    return result


def apply_part_colors(mesh: trimesh.Trimesh, parts: list[dict],
                       colors: dict[str, tuple[int, int, int]]) -> bool:
    """Paint an assembly's combined mesh with each part's extracted 3MF
    color (falling back to a neutral gray for parts with none), so the
    viewer shows something closer to the real product instead of one flat
    tone. Returns False (mesh untouched) when there's nothing to paint.

    Sets VERTEX colors, never face colors: trimesh converts face colors to
    vertex colors lazily (on .copy(), on export), and that conversion goes
    through scipy.sparse — a dependency this image deliberately doesn't
    carry. Parts never share vertices here (load_assembly stacks each
    part's vertices separately), so painting per-vertex is exact, not an
    averaged approximation."""
    if not colors:
        return False
    vertex_colors = np.tile(np.array([*DEFAULT_PART_COLOR, 255], dtype=np.uint8),
                             (len(mesh.vertices), 1))
    painted = False
    for part in parts:
        c = colors.get(part["name"])
        if c is None:
            continue
        fs, fc = part["face_start"], part["face_count"]
        vertex_colors[np.unique(mesh.faces[fs:fs + fc])] = [*c, 255]
        painted = True
    if painted:
        mesh.visual.vertex_colors = vertex_colors
    return painted


# How many distinct fill colors a logo may print in. Extra colors are
# merged into the nearest kept one rather than dropped — a 4th color is a
# design detail, not a reason to refuse the file.
MAX_LOGO_COLORS = 3
DEFAULT_LOGO_COLOR = "#36d17a"

_SVG_SHAPE_TAGS = {"path", "circle", "rect", "ellipse", "polygon", "polyline", "line"}
_SVG_NS = "http://www.w3.org/2000/svg"
# The handful of CSS named colors worth resolving; anything else unparseable
# falls back to DEFAULT_LOGO_COLOR (the shape still prints, just in the
# default filament slot).
_NAMED_COLORS = {
    "black": "#000000", "white": "#ffffff", "red": "#ff0000", "green": "#008000",
    "blue": "#0000ff", "yellow": "#ffff00", "cyan": "#00ffff", "magenta": "#ff00ff",
    "gray": "#808080", "grey": "#808080", "orange": "#ffa500", "purple": "#800080",
    "silver": "#c0c0c0", "lime": "#00ff00", "navy": "#000080", "teal": "#008080",
}


@dataclass
class LogoShape:
    """One top-level closed shape from the SVG, plus the fill color it was
    drawn with — the unit both the shape picker and the multi-color export
    work in."""
    polygon: object
    color: str = DEFAULT_LOGO_COLOR


def _normalize_color(raw: str | None) -> str | None:
    """SVG fill -> '#rrggbb'. None means "no fill" (the shape isn't
    printable — e.g. a stroke-only guide line), which the caller drops."""
    if raw is None:
        return DEFAULT_LOGO_COLOR
    s = raw.strip().lower()
    if s in ("none", "transparent"):
        return None
    if s in _NAMED_COLORS:
        return _NAMED_COLORS[s]
    if s.startswith("#"):
        h = s[1:]
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        if len(h) == 6:
            try:
                int(h, 16)
                return f"#{h}"
            except ValueError:
                pass
    if s.startswith("rgb("):
        try:
            parts = [int(float(x)) for x in s[4:].rstrip(")").split(",")[:3]]
            return "#{:02x}{:02x}{:02x}".format(*(max(0, min(255, v)) for v in parts))
        except (ValueError, IndexError):
            pass
    return DEFAULT_LOGO_COLOR


def _element_fill(el, inherited: str | None) -> str | None:
    style = el.get("style") or ""
    for decl in style.split(";"):
        if ":" in decl:
            k, v = decl.split(":", 1)
            if k.strip() == "fill":
                return v.strip()
    return el.get("fill") or inherited


def _collect_svg_shapes(el, inherited: str | None, out: list) -> list:
    fill = _element_fill(el, inherited)
    if el.tag.split("}")[-1] in _SVG_SHAPE_TAGS:
        out.append((el, fill))
    for child in el:
        _collect_svg_shapes(child, fill, out)
    return out


def _polygons_of(path2d) -> list:
    """polygons_full with the documented fallbacks — see load_logo."""
    try:
        polygons = list(path2d.polygons_full)
    except Exception:
        polygons = list(path2d.polygons_closed)
    return [p for p in polygons if p is not None and _is_usable_polygon(p)]


def _hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _cap_colors(shapes: list) -> list:
    """Keep at most MAX_LOGO_COLORS distinct colors, chosen by how much
    area each covers; every other shape is re-tagged to whichever kept
    color is closest in RGB, so nothing silently disappears from a logo
    that happens to use a few near-identical shades."""
    area_by_color: dict[str, float] = {}
    for s in shapes:
        area_by_color[s.color] = area_by_color.get(s.color, 0.0) + float(s.polygon.area)
    if len(area_by_color) <= MAX_LOGO_COLORS:
        return shapes

    kept = sorted(area_by_color, key=lambda c: area_by_color[c], reverse=True)[:MAX_LOGO_COLORS]
    kept_rgb = {c: _hex_to_rgb(c) for c in kept}

    def nearest(color: str) -> str:
        r, g, b = _hex_to_rgb(color)
        return min(kept, key=lambda k: sum((a - c) ** 2 for a, c in zip(kept_rgb[k], (r, g, b))))

    return [s if s.color in kept_rgb else LogoShape(s.polygon, nearest(s.color)) for s in shapes]


def load_logo(path: str) -> list:
    """Parse an SVG into a list of LogoShape (polygon + its fill color).

    Each drawable SVG element is parsed on its own (wrapped in a minimal
    standalone SVG) rather than letting trimesh flatten the whole file at
    once: trimesh's Path2D keeps no link between an entity and the fill it
    was drawn with, so per-element parsing is the only way to know which
    polygon is which color. Holes still nest correctly because a hole and
    its outer ring live in the *same* element (an "O" is one path), and
    that element is parsed as a unit.

    Handled here so callers downstream can trust the result: a text-only
    SVG (trimesh's parser silently drops `<text>`, leaving zero entities)
    used to raise IndexError, and a self-intersecting/degenerate path can
    make the hole-nesting step (an rtree query) raise RTreeError."""
    try:
        with open(path, "rb") as f:
            root = ET.fromstring(f.read())
    except Exception as exc:
        raise MeshError(f"impossible de lire le SVG ({exc})") from exc

    elements = _collect_svg_shapes(root, None, [])
    if not elements:
        raise MeshError(
            "le SVG ne contient aucune forme reconnue. S'il contient du "
            "texte, convertissez-le d'abord en tracés (dans Inkscape : "
            "Chemin > Objet en chemin) avant de l'importer."
        )

    root_attrs = {k: v for k, v in root.attrib.items() if k in ("width", "height", "viewBox")}
    shapes: list[LogoShape] = []
    failures = 0
    for el, raw_fill in elements:
        color = _normalize_color(raw_fill)
        if color is None:          # fill="none": a guide/stroke-only shape
            continue
        mini = ET.Element(f"{{{_SVG_NS}}}svg", root_attrs)
        mini.append(el)
        try:
            path2d = trimesh.load_path(io.BytesIO(ET.tostring(mini)), file_type="svg")
            polys = _polygons_of(path2d)
        except Exception:
            failures += 1
            continue
        shapes.extend(LogoShape(p, color) for p in polys)

    if not shapes:
        if failures:
            raise MeshError(
                "le SVG contient une géométrie invalide (tracés qui se "
                "croisent, points dupliqués…) que le moteur n'a pas pu "
                "interpréter. Essayez de le simplifier dans un éditeur "
                "vectoriel (fusionner les tracés, supprimer les points "
                "superflus)."
            )
        raise MeshError("le SVG ne contient aucune forme fermée exploitable")
    return _cap_colors(shapes)


def _is_usable_polygon(p) -> bool:
    try:
        return bool(p.is_valid) and p.area > 1e-6
    except Exception:
        return False


def logo_colors(shapes: list) -> list[str]:
    """Distinct colors present, in first-seen order — the filament slots
    this logo needs."""
    seen = []
    for s in shapes:
        if s.color not in seen:
            seen.append(s.color)
    return seen


def logo_bounds(shapes: list) -> tuple[float, float, float, float]:
    """(minx, miny, maxx, maxy) across every shape."""
    xs_min, ys_min, xs_max, ys_max = zip(*(s.polygon.bounds for s in shapes))
    return min(xs_min), min(ys_min), max(xs_max), max(ys_max)


def shapes_payload(shapes: list) -> list[dict]:
    """One entry per top-level shape, as plain point lists a browser can
    draw directly (`<path>` with fill-rule evenodd: exterior ring first,
    then each hole) plus its color. This is what lets a user spot — and
    exclude — a shape that shouldn't be there: a background rectangle, a
    stray decorative piece, or a hole that failed to nest properly and came
    through as its own filled blob instead of a cut-out (e.g. inside an "O")."""
    out = []
    for i, s in enumerate(shapes):
        p = s.polygon
        rings = [list(map(list, p.exterior.coords))]
        rings += [list(map(list, ring.coords)) for ring in p.interiors]
        minx, miny, maxx, maxy = p.bounds
        out.append({
            "index": i,
            "bbox": [round(minx, 3), round(miny, 3), round(maxx, 3), round(maxy, 3)],
            "area": round(float(p.area), 3),
            "color": s.color,
            "rings": rings,
        })
    return out


def flip_polygons(shapes: list, flip_h: bool, flip_v: bool) -> list:
    """Mirror every shape together around their shared bounding-box
    center — flipping each one individually around its own center would
    scramble a multi-piece logo instead of mirroring it as a whole."""
    if not flip_h and not flip_v:
        return shapes
    minx, miny, maxx, maxy = logo_bounds(shapes)
    origin = ((minx + maxx) / 2.0, (miny + maxy) / 2.0)
    xfact = -1.0 if flip_h else 1.0
    yfact = -1.0 if flip_v else 1.0
    return [LogoShape(affinity.scale(s.polygon, xfact=xfact, yfact=yfact, origin=origin), s.color)
            for s in shapes]


def _outline_polygon(face: "FaceInfo") -> ShapelyPolygon:
    if face.outline:
        poly = ShapelyPolygon(face.outline)
        if poly.is_valid and poly.area > 1e-6:
            return poly
    # No usable outline on file (older stored zone, or the region's
    # geometry didn't merge into one clean polygon) — the old behaviour,
    # treating the region as its own bounding rectangle, is still a sane
    # fallback for what's normally an actually-rectangular flat spot.
    return shapely_box(-face.width / 2.0, -face.height / 2.0, face.width / 2.0, face.height / 2.0)


def fit_to_face(shapes: list, face: "FaceInfo", margin_mm: float = 1.0) -> tuple[float, float]:
    """Largest (width_mm, rotation_deg), logo centered on the face's own
    origin, that fits entirely *inside the face's actual shape* — not its
    bounding box, which overestimates the available space on anything
    that isn't itself a rectangle (round, L-shaped, chamfered…) — leaving
    `margin_mm` clear on every side. Coarse-scans rotation, binary-searches
    the max scale at each: exact containment, cheap because each check is
    just one shapely `.contains()` call."""
    region = _outline_polygon(face)
    usable = region.buffer(-margin_mm)
    if usable.is_empty:
        usable = region  # the margin alone ate the whole region — still better than refusing

    logo_union = unary_union([s.polygon for s in shapes])
    minx, miny, maxx, maxy = logo_union.bounds
    orig_longer = max(maxx - minx, maxy - miny, 1e-6)
    centered = affinity.translate(logo_union, xoff=-(minx + maxx) / 2.0, yoff=-(miny + maxy) / 2.0)

    def fits(theta_deg: float, scale: float) -> bool:
        if scale <= 0:
            return True
        shape = affinity.rotate(centered, theta_deg, origin=(0, 0))
        shape = affinity.scale(shape, xfact=scale, yfact=scale, origin=(0, 0))
        return usable.contains(shape)

    ubx0, uby0, ubx1, uby1 = usable.bounds
    # Generously large — just needs to be past any scale that could
    # possibly fit, so the binary search always converges on the real edge.
    hi = 2.0 * max(ubx1 - ubx0, uby1 - uby0, 1.0) / max(orig_longer, 1e-6) + 1.0

    def max_scale_at(theta_deg: float) -> float:
        lo, top = 0.0, hi
        for _ in range(20):
            mid = (lo + top) / 2.0
            if fits(theta_deg, mid):
                lo = mid
            else:
                top = mid
        return lo

    best_scale, best_deg = 0.0, 0.0
    for deg in range(0, 180, 4):
        s = max_scale_at(deg)
        if s > best_scale:
            best_scale, best_deg = s, deg
    for d in (best_deg - 2, best_deg - 1, best_deg + 1, best_deg + 2):
        s = max_scale_at(d)
        if s > best_scale:
            best_scale, best_deg = s, d

    width_mm = best_scale * orig_longer
    return round(width_mm, 3), round(best_deg % 360, 1)


# --- flat-face detection ---------------------------------------------------
@dataclass
class FaceInfo:
    origin: np.ndarray   # world point at the center of the flat region
    normal: np.ndarray   # unit outward normal
    u: np.ndarray        # unit in-plane axis ("local x")
    v: np.ndarray        # unit in-plane axis ("local y")
    width: float          # region's bounding-box extent along u (mm)
    height: float         # region's bounding-box extent along v (mm)
    face_count: int = 0
    # the region's *true* outline in (u, v) mm, centered on `origin` — a
    # list of [x, y] points, or None if it couldn't be computed (fit_to_face
    # then falls back to treating the region as its own bounding rectangle)
    outline: list | None = field(default=None)

    def to_json(self) -> dict:
        return {
            "origin": self.origin.tolist(),
            "normal": self.normal.tolist(),
            "u": self.u.tolist(),
            "v": self.v.tolist(),
            "width": round(float(self.width), 3),
            "height": round(float(self.height), 3),
            "face_count": self.face_count,
            "outline": self.outline,
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
            outline=data.get("outline"),
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
    tri_pts = mesh.vertices[mesh.faces[region]]        # (n, 3, 3): n triangles, 3 verts, xyz
    rel = tri_pts - p0
    pu = rel @ u                                        # (n, 3)
    pv = rel @ v
    width = float(pu.max() - pu.min())
    height = float(pv.max() - pv.min())
    center_u = float((pu.max() + pu.min()) / 2.0)
    center_v = float((pv.max() + pv.min()) / 2.0)
    origin = p0 + center_u * u + center_v * v
    outline = _region_outline(pu, pv, center_u, center_v)

    return FaceInfo(origin=origin, normal=n0, u=u, v=v,
                     width=max(width, 0.01), height=max(height, 0.01),
                     face_count=len(region), outline=outline)


def locate_face_index(mesh: trimesh.Trimesh, origin, normal) -> int:
    """Find the triangle a stored FaceInfo came from, by matching its plane.

    Used to repair zones saved before the region outline was recorded: the
    origin/normal are known, so the flat patch can be re-derived (and its
    real outline computed) without asking the vendor to rebuild the
    product. Picks, among triangles facing the same way and lying on the
    same plane, the one whose center is nearest the stored origin."""
    origin = np.asarray(origin, dtype=np.float64)
    normal = np.asarray(normal, dtype=np.float64)
    normals, centers = mesh.face_normals, mesh.triangles_center
    scale = float(mesh.scale) if mesh.scale else 1.0
    plane_tol = max(scale * PLANE_TOL_FRAC, 1e-4)

    aligned = normals @ normal >= math.cos(math.radians(NORMAL_TOL_DEG))
    on_plane = np.abs((centers - origin) @ normal) <= plane_tol
    candidates = np.flatnonzero(aligned & on_plane)
    if len(candidates) == 0:
        candidates = np.flatnonzero(aligned)
    if len(candidates) == 0:
        raise MeshError("impossible de retrouver la face d'origine de cette zone")
    return int(candidates[np.argmin(np.linalg.norm(centers[candidates] - origin, axis=1))])


def _region_outline(pu: np.ndarray, pv: np.ndarray,
                     center_u: float, center_v: float) -> list | None:
    """Merge a flat region's triangles (already projected onto its own u/v
    plane) into their true outline — a round, L-shaped, or otherwise
    non-rectangular flat spot is smaller than its own bounding box, and
    fit_to_face() needs the real shape to not oversize a logo into
    something that actually pokes off the edge."""
    polys = []
    for i in range(len(pu)):
        tri = ShapelyPolygon(zip(pu[i].tolist(), pv[i].tolist()))
        if not tri.is_valid or tri.area < 1e-9:
            tri = tri.buffer(0)
        if not tri.is_empty:
            polys.append(tri)
    if not polys:
        return None
    merged = unary_union(polys)
    if merged.geom_type == "MultiPolygon":
        merged = max(merged.geoms, key=lambda g: g.area)
    if merged.is_empty or merged.geom_type != "Polygon" or merged.area < 1e-6:
        return None
    return [[round(x - center_u, 4), round(y - center_v, 4)] for x, y in merged.exterior.coords]


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


def _placement_matrix(shapes: list, params: PlacementParams) -> list[float]:
    """The affine that takes SVG coordinates to face-local mm. Derived from
    the WHOLE logo's bbox (not per color group) so every color group stays
    in register with the others."""
    minx, miny, maxx, maxy = logo_bounds(shapes)
    longer = max(float(maxx - minx), float(maxy - miny), 1e-6)
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
    return [a, b, d, e, xoff, yoff]


def _extrude_shapes(shapes: list, matrix: list[float], height: float) -> trimesh.Trimesh:
    parts = [_extrude_polygon(affinity.affine_transform(s.polygon, matrix), height)
             for s in shapes]
    return trimesh.util.concatenate(parts) if len(parts) > 1 else parts[0]


def _logo_local_mesh(shapes: list, params: PlacementParams, height: float) -> trimesh.Trimesh:
    """Extruded logo in its own local XY frame, centered on (0,0), z in
    [0, height]. Scale is derived from `width_mm` vs. the SVG's own bbox."""
    return _extrude_shapes(shapes, _placement_matrix(shapes, params), height)


def _by_color(shapes: list) -> dict[str, list]:
    groups: dict[str, list] = {}
    for s in shapes:
        groups.setdefault(s.color, []).append(s)
    return groups


def _logo_meshes_by_color(shapes: list, params: PlacementParams,
                           height: float) -> dict[str, trimesh.Trimesh]:
    """One extruded mesh per fill color, all sharing the whole logo's
    placement — each becomes its own object in the 3MF so a slicer can put
    a different filament in each."""
    matrix = _placement_matrix(shapes, params)
    return {color: _extrude_shapes(group, matrix, height)
            for color, group in _by_color(shapes).items()}


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


def preview_logo(shapes: list, face: FaceInfo, params: PlacementParams,
                  thickness: float = 0.6) -> trimesh.Trimesh:
    """Thin slab sitting just above the surface — fast to recompute on every
    slider tweak, purely for visual placement feedback. Painted with each
    shape's own fill color so the preview shows the real multi-color logo."""
    matrix = _placement_matrix(shapes, params)
    meshes, colors = [], []
    for color, group in _by_color(shapes).items():
        m = _extrude_shapes(group, matrix, thickness)
        meshes.append(m)
        # Per-VERTEX, not per-face: trimesh converts face colors to vertex
        # colors lazily (on .copy(), which _to_world does, and on export)
        # and that conversion needs scipy.sparse, which this image doesn't
        # carry. Each color group is its own mesh with its own vertices, so
        # coloring every vertex of the group is exact.
        colors.append(np.tile(np.array([*_hex_to_rgb(color), 255], dtype=np.uint8),
                               (len(m.vertices), 1)))
    local = trimesh.util.concatenate(meshes) if len(meshes) > 1 else meshes[0]
    local.visual.vertex_colors = np.vstack(colors)
    return _to_world(local, face, z_shift=0.05)


def emboss(shapes: list, face: FaceInfo, params: PlacementParams,
           depth_mm: float, sink_mm: float) -> dict[str, trimesh.Trimesh]:
    """The logo as standalone raised objects, one per fill color. `sink_mm`
    buries a sliver of each in the model so the parts overlap (and bond)
    instead of merely touching."""
    height = depth_mm + sink_mm
    return {color: _to_world(mesh, face, z_shift=-sink_mm)
            for color, mesh in _logo_meshes_by_color(shapes, params, height).items()}


def deboss(base: trimesh.Trimesh, shapes: list, face: FaceInfo, params: PlacementParams,
           depth_mm: float, fill_extra_mm: float = 0.0
           ) -> tuple[trimesh.Trimesh, dict[str, trimesh.Trimesh]]:
    """Engrave the logo into `base` and return (pocketed_base, fills_by_color).
    One pocket is cut for the whole logo; the fill pieces are split per color
    so each can print in its own filament and drop back into the pocket.
    Requires `manifold3d` for the boolean cut."""
    cut_over = max(1.0, depth_mm * 0.5)  # tool must poke out past the surface to cut cleanly
    tool_local = _logo_local_mesh(shapes, params, depth_mm + cut_over)
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

    fills = {color: _to_world(mesh, face, z_shift=-depth_mm)
             for color, mesh in _logo_meshes_by_color(
                 shapes, params, depth_mm + fill_extra_mm).items()}
    return pocketed, fills


# --- export ------------------------------------------------------------------
def export_3mf(named_meshes: dict[str, trimesh.Trimesh]) -> bytes:
    scene = trimesh.Scene()
    for name, mesh in named_meshes.items():
        scene.add_geometry(mesh, node_name=name, geom_name=name)
    data = scene.export(file_type="3mf")
    if isinstance(data, str):
        data = data.encode("utf-8")
    return data
