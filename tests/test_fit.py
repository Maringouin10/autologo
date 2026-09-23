"""Fitting a logo to a plate, with and without letting it turn.

Run with:  python -m unittest discover -s tests
"""
import sys
import unittest
from pathlib import Path

import numpy as np
from shapely.geometry import box

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import meshwork as mw  # noqa: E402

MARGIN = 1.0


def face(width, height):
    return mw.FaceInfo(
        origin=np.array([0.0, 0.0, 0.0]), normal=np.array([0.0, 0.0, 1.0]),
        u=np.array([1.0, 0.0, 0.0]), v=np.array([0.0, 1.0, 0.0]),
        width=float(width), height=float(height),
    )


def wide_logo():
    """Four times wider than tall — the shape a turn would help most."""
    return [mw.LogoShape(box(0, 0, 40, 10), "#ff0000")]


class FitTests(unittest.TestCase):
    def test_a_fixed_rotation_is_honoured_exactly(self):
        for deg in (0, 45, 90, 180, 270):
            with self.subTest(deg):
                _, got = mw.fit_to_face(wide_logo(), face(60, 30), MARGIN, rotation_deg=deg)
                self.assertAlmostEqual(got, deg % 360, places=1)

    def test_keeping_the_rotation_fills_the_plate_in_that_direction(self):
        plate = face(60, 30)
        flat, _ = mw.fit_to_face(wide_logo(), plate, MARGIN, rotation_deg=0)
        turned, _ = mw.fit_to_face(wide_logo(), plate, MARGIN, rotation_deg=90)
        # 60 and 30 wide, less the margin on both sides
        self.assertAlmostEqual(flat, 58.0, delta=0.2)
        self.assertAlmostEqual(turned, 28.0, delta=0.2)

    def test_letting_it_turn_is_never_worse(self):
        plate = face(30, 80)
        auto_width, _ = mw.fit_to_face(wide_logo(), plate, MARGIN)
        for deg in (0, 30, 90, 150):
            fixed, _ = mw.fit_to_face(wide_logo(), plate, MARGIN, rotation_deg=deg)
            self.assertGreaterEqual(auto_width + 1e-6, fixed)

    def test_a_square_plate_fits_the_same_either_way(self):
        square = face(40, 40)
        flat, _ = mw.fit_to_face(wide_logo(), square, MARGIN, rotation_deg=0)
        turned, _ = mw.fit_to_face(wide_logo(), square, MARGIN, rotation_deg=90)
        self.assertAlmostEqual(flat, turned, delta=0.1)

    def test_the_result_really_fits_inside_the_margin(self):
        plate = face(60, 30)
        for deg in (0, 90, 33):
            with self.subTest(deg):
                width, _ = mw.fit_to_face(wide_logo(), plate, MARGIN, rotation_deg=deg)
                params = mw.PlacementParams(width_mm=width, rotation_deg=deg,
                                             offset_x_mm=0.0, offset_y_mm=0.0)
                placed = mw._extrude_shapes(wide_logo(), mw._placement_matrix(wide_logo(), params), 1.0)
                half_w, half_h = 60 / 2 - MARGIN, 30 / 2 - MARGIN
                corners = placed.bounds
                self.assertLessEqual(corners[1][0], half_w + 1e-6)
                self.assertGreaterEqual(corners[0][0], -half_w - 1e-6)
                self.assertLessEqual(corners[1][1], half_h + 1e-6)
                self.assertGreaterEqual(corners[0][1], -half_h - 1e-6)


if __name__ == "__main__":
    unittest.main()
