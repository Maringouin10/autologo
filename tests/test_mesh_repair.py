"""A boolean cut ("gravé") needs watertight input, and most real models
aren't. These cover the breakages that used to surface as
"Not all meshes are volumes!" and now get repaired automatically.

Run with:  python -m unittest discover -s tests
"""
import sys
import unittest
from pathlib import Path

import numpy as np
import trimesh
from shapely.geometry import Point, Polygon
from shapely.geometry import box as shapely_box

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import meshwork as mw  # noqa: E402

SIZE = 20.0


def box():
    return trimesh.creation.box((SIZE, SIZE, SIZE))


def missing_face():
    m = box()
    m.update_faces(np.arange(len(m.faces)) != 3)
    return m


def flipped_winding():
    m = box()
    faces = m.faces.copy()
    faces[2] = faces[2][::-1]
    faces[5] = faces[5][::-1]
    return trimesh.Trimesh(m.vertices.copy(), faces, process=False)


def duplicate_faces():
    m = box()
    return trimesh.Trimesh(m.vertices.copy(), np.vstack([m.faces, m.faces[:2]]), process=False)


def unwelded():
    """How an STL actually arrives: every triangle owns its own vertices."""
    m = box()
    return trimesh.Trimesh(m.triangles.reshape(-1, 3),
                            np.arange(len(m.faces) * 3).reshape(-1, 3), process=False)


def floating_debris():
    m = box()
    n = len(m.vertices)
    vertices = np.vstack([m.vertices, [[50, 50, 50], [51, 50, 50], [50, 51, 50]]])
    faces = np.vstack([m.faces, [[n, n + 1, n + 2]]])
    return trimesh.Trimesh(vertices, faces, process=False)


def hairline_crack():
    m = box()
    vertices = np.vstack([m.vertices, m.vertices[0] + 1e-4])
    faces = m.faces.copy()
    faces[faces == 0] = len(vertices) - 1
    faces[0] = m.faces[0]
    return trimesh.Trimesh(vertices, faces, process=False)


def degenerate_face():
    m = box()
    return trimesh.Trimesh(m.vertices.copy(), np.vstack([m.faces, [[0, 0, 1]]]), process=False)


BROKEN = {
    "missing face": missing_face,
    "flipped winding": flipped_winding,
    "duplicate faces": duplicate_faces,
    "unwelded vertices": unwelded,
    "floating debris": floating_debris,
    "hairline crack": hairline_crack,
    "degenerate face": degenerate_face,
}


class RepairTests(unittest.TestCase):
    def test_every_breakage_becomes_a_volume(self):
        for name, build in BROKEN.items():
            with self.subTest(name):
                broken = build()
                self.assertFalse(broken.is_volume, "test case should start broken")
                fixed, steps = mw.repair_for_boolean(broken)
                self.assertTrue(fixed.is_volume, f"{name}: still not a volume ({steps})")
                self.assertTrue(steps, f"{name}: repaired but reported no steps")

    def test_repair_preserves_the_shape(self):
        for name, build in BROKEN.items():
            with self.subTest(name):
                fixed, _ = mw.repair_for_boolean(build())
                self.assertAlmostEqual(float(fixed.volume), SIZE ** 3, delta=SIZE ** 3 * 0.02)

    def test_healthy_mesh_is_untouched_and_costs_nothing(self):
        healthy = box()
        fixed, steps = mw.repair_for_boolean(healthy)
        self.assertEqual(steps, [])
        self.assertIs(fixed, healthy)

    def test_open_surface_cannot_be_repaired_but_never_raises(self):
        plane = trimesh.Trimesh(
            vertices=[[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]],
            faces=[[0, 1, 2], [0, 2, 3]], process=False)
        fixed, steps = mw.repair_for_boolean(plane)
        self.assertFalse(fixed.is_volume)
        self.assertTrue(steps)


class DebossTests(unittest.TestCase):
    face = mw.FaceInfo(
        origin=np.array([0.0, 0.0, SIZE / 2]), normal=np.array([0.0, 0.0, 1.0]),
        u=np.array([1.0, 0.0, 0.0]), v=np.array([0.0, 1.0, 0.0]),
        width=SIZE, height=SIZE,
    )
    shapes = [mw.LogoShape(Point(0, 0).buffer(4.0), "#ff0000")]
    params = mw.PlacementParams(width_mm=8.0, rotation_deg=0.0,
                                 offset_x_mm=0.0, offset_y_mm=0.0)

    def test_cut_succeeds_on_every_broken_mesh(self):
        for name, build in BROKEN.items():
            with self.subTest(name):
                pocketed, fills = mw.deboss(build(), self.shapes, self.face, self.params,
                                             depth_mm=1.5)
                self.assertTrue(pocketed.is_volume)
                self.assertEqual(len(fills), 1)
                # the pocket removed material, and only the pocket
                self.assertLess(float(pocketed.volume), SIZE ** 3)
                self.assertGreater(float(pocketed.volume), SIZE ** 3 * 0.95)

    def test_repairs_are_reported_on_the_result(self):
        pocketed, _ = mw.deboss(unwelded(), self.shapes, self.face, self.params, depth_mm=1.5)
        self.assertTrue(pocketed.metadata.get("autologo_repairs"))

    def test_healthy_mesh_reports_no_repairs(self):
        pocketed, _ = mw.deboss(box(), self.shapes, self.face, self.params, depth_mm=1.5)
        self.assertEqual(pocketed.metadata.get("autologo_repairs"), [])

    def test_unrepairable_mesh_explains_itself(self):
        plane = trimesh.Trimesh(
            vertices=[[-20, -20, 10], [20, -20, 10], [20, 20, 10], [-20, 20, 10]],
            faces=[[0, 1, 2], [0, 2, 3]], process=False)
        with self.assertRaises(mw.MeshError) as ctx:
            mw.deboss(plane, self.shapes, self.face, self.params, depth_mm=1.5)
        message = str(ctx.exception)
        self.assertIn("relief", message)
        self.assertIn("le modèle 3D", message)       # names the guilty side
        self.assertNotIn("le logo", message)         # and not the innocent one
        self.assertIn("réparation déjà tentée", message)


class LogoSolidTests(unittest.TestCase):
    """The cutting tool is the other half of "Not all meshes are volumes!".
    Each of these outlines used to extrude into something no boolean would
    touch — and, unlike a broken model, the user had done nothing wrong."""

    HEIGHT = 2.0

    def solid(self, polygon):
        return mw._extrude_polygon(polygon, self.HEIGHT)

    def test_hole_touching_the_outline_at_a_point(self):
        # a letter counter that kisses the outline: valid geometry, and the
        # single most common way a real logo pinched the extrusion
        poly = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)],
                        [[(2, 1), (5, 0), (8, 1), (5, 6)]])
        self.assertTrue(poly.is_valid, "case should be valid geometry")
        self.assertTrue(self.solid(poly).is_volume)

    def test_hole_touching_the_outline_along_an_edge(self):
        poly = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)],
                        [[(2, 0), (2, 8), (8, 8), (8, 0)]])
        self.assertTrue(self.solid(poly).is_volume)

    def test_two_holes_touching_each_other(self):
        poly = Polygon([(0, 0), (12, 0), (12, 12), (0, 12)],
                        [[(1, 1), (5, 1), (5, 5), (1, 5)],
                         [(5, 5), (9, 5), (9, 9), (5, 9)]])
        self.assertTrue(self.solid(poly).is_volume)

    def test_self_crossing_outline_is_recovered_not_dropped(self):
        bowtie = Polygon([(0, 0), (10, 10), (10, 0), (0, 10)])
        self.assertFalse(bowtie.is_valid)
        self.assertTrue(mw._repaired_polygons(bowtie), "should recover pieces")
        self.assertTrue(self.solid(bowtie).is_volume)

    def test_overlapping_shapes_extrude_together(self):
        shapes = [mw.LogoShape(Point(0, 0).buffer(10), "#f00"),
                  mw.LogoShape(Point(8, 0).buffer(10), "#00f")]
        params = mw.PlacementParams(width_mm=30.0, rotation_deg=0.0,
                                     offset_x_mm=0.0, offset_y_mm=0.0)
        self.assertTrue(mw._logo_local_mesh(shapes, params, self.HEIGHT).is_volume)

    def test_extrusion_volume_matches_the_outline(self):
        for name, poly in {
            "square": shapely_box(0, 0, 10, 10),
            "circle": Point(0, 0).buffer(8, resolution=64),
            "ring": Point(0, 0).buffer(8).difference(Point(0, 0).buffer(4)),
            "two holes": Polygon([(0, 0), (20, 0), (20, 10), (0, 10)],
                                  [[(2, 2), (6, 2), (6, 8), (2, 8)],
                                   [(12, 2), (18, 2), (18, 8), (12, 8)]]),
        }.items():
            with self.subTest(name):
                solid = self.solid(poly)
                self.assertAlmostEqual(float(solid.volume), poly.area * self.HEIGHT,
                                        delta=poly.area * self.HEIGHT * 0.002)

    def test_cut_with_a_pinched_logo(self):
        """End to end: the exact shape that produced the report."""
        poly = Polygon([(-4, -4), (4, -4), (4, 4), (-4, 4)],
                        [[(-2, -1), (0, -4), (2, -1), (0, 2)]])
        pocketed, fills = mw.deboss(box(), [mw.LogoShape(poly, "#ff0000")],
                                     DebossTests.face, DebossTests.params, depth_mm=1.5)
        self.assertTrue(pocketed.is_volume)
        self.assertEqual(len(fills), 1)
        self.assertLess(float(pocketed.volume), SIZE ** 3)


if __name__ == "__main__":
    unittest.main()
