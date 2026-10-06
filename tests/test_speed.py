"""A complicated logo must stay quick to preview and to engrave.

What made it slow: every curve came out of the SVG parser as hundreds of
points, and every preview re-triangulated the whole logo. These pin down
that the shortcuts taken against that change nothing about the result.

Run with:  python -m unittest discover -s tests
"""
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import trimesh
from shapely.geometry import Point

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import meshwork as mw  # noqa: E402
from app.store import Session  # noqa: E402

CIRCLES = "".join(
    f'<circle cx="{40 + 60 * (i % 5)}" cy="{40 + 60 * (i // 5)}" r="25" fill="#{"ff0000" if i % 2 else "0000ff"}"/>'
    for i in range(10))
SVG = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 340 160">{CIRCLES}</svg>'


def load(svg: str):
    with tempfile.NamedTemporaryFile("w", suffix=".svg", delete=False) as f:
        f.write(svg)
        path = f.name
    try:
        return mw.load_logo(path)
    finally:
        Path(path).unlink(missing_ok=True)


def top_face():
    base = trimesh.creation.box((120, 120, 10))
    adjacency = mw.face_adjacency_of(base)
    return base, mw.find_flat_region(base, adjacency, int(np.argmax(base.triangles_center[:, 2])))


class SimplifyTests(unittest.TestCase):
    def test_curves_lose_points_not_shape(self):
        shapes = load(SVG)
        self.assertEqual(len(shapes), 10)
        for s in shapes:
            exact = Point(s.polygon.centroid).buffer(25, quad_segs=256)
            # Far fewer points than the parser's ~80 per curve segment...
            self.assertLess(len(s.polygon.exterior.coords), 200)
            # ...and still within the tolerance of the true circle.
            self.assertLess(s.polygon.symmetric_difference(exact).area / exact.area, 0.01)

    def test_simplification_never_breaks_a_polygon(self):
        for s in load(SVG):
            self.assertTrue(s.polygon.is_valid)


class ExtrusionCacheTests(unittest.TestCase):
    def test_cached_extrusion_matches_a_fresh_one(self):
        shapes = load(SVG)
        params = mw.PlacementParams(width_mm=50, rotation_deg=33, offset_x_mm=4, offset_y_mm=-2)
        matrix = mw._placement_matrix(shapes, params)
        cached = mw._extrude_shapes(shapes, matrix, 1.5)
        fresh = trimesh.util.concatenate([
            mw._extrude_polygon(mw.affinity.affine_transform(s.polygon, matrix), 1.5)
            for s in shapes])
        self.assertTrue(cached.is_volume)
        self.assertAlmostEqual(cached.volume, fresh.volume, places=4)
        np.testing.assert_allclose(cached.bounds, fresh.bounds, atol=1e-6)

    def test_deboss_still_cuts_with_cached_shapes(self):
        shapes = load(SVG)
        base, face = top_face()
        params = mw.PlacementParams(width_mm=80)
        mw.preview_logo(shapes, face, params)          # warms the cache
        pocketed, fills = mw.deboss(base, shapes, face, params, depth_mm=1.0)
        self.assertTrue(pocketed.is_volume)
        self.assertLess(pocketed.volume, base.volume)
        self.assertEqual(set(fills), {"#ff0000", "#0000ff"})
        removed = base.volume - pocketed.volume
        filled = sum(m.volume for m in fills.values())
        self.assertAlmostEqual(removed, filled, delta=filled * 0.01)


class ActivePolygonsTests(unittest.TestCase):
    def test_same_shapes_come_back_until_the_edit_changes(self):
        with tempfile.TemporaryDirectory() as d:
            sess = Session(id="t", dir=Path(d))
            sess.logo_path.write_text(SVG)
            sess.flip_h = True
            first = sess.active_logo_polygons()
            self.assertIs(sess.active_logo_polygons(), first)
            sess.excluded_shapes = {0}
            second = sess.active_logo_polygons()
            self.assertIsNot(second, first)
            self.assertEqual(len(second), 9)
            sess.invalidate_logo()
            self.assertEqual(len(sess.active_logo_polygons()), 10)


if __name__ == "__main__":
    unittest.main()
