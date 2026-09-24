"""Fitting a logo to a plate, with and without letting it turn.

Run with:  python -m unittest discover -s tests
"""
import sys
import unittest
from pathlib import Path

import numpy as np
from shapely import affinity
from shapely.geometry import Point, box
from shapely.ops import unary_union

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


def keyring_face(disc_radius=20.0):
    """A keyring: a disc with a hanging tab and its hole — the shape whose
    bounding-box centre is nowhere near where a logo belongs."""
    disc = Point(0, 0).buffer(disc_radius, resolution=64)
    tab = box(-6, disc_radius - 2, 6, disc_radius + 10).union(
        Point(0, disc_radius + 8).buffer(6))
    plate = unary_union([disc, tab]).difference(Point(0, disc_radius + 8).buffer(2.5))
    minx, miny, maxx, maxy = plate.bounds
    outline = affinity.translate(plate, -(minx + maxx) / 2.0, -(miny + maxy) / 2.0)
    return mw.FaceInfo(
        origin=np.array([0.0, 0.0, 0.0]), normal=np.array([0.0, 0.0, 1.0]),
        u=np.array([1.0, 0.0, 0.0]), v=np.array([0.0, 1.0, 0.0]),
        width=maxx - minx, height=maxy - miny,
        outline=[[x, y] for x, y in outline.exterior.coords],
    ), (miny + maxy) / 2.0


class CenteringTests(unittest.TestCase):
    def test_a_keyring_centres_on_its_disc_not_its_bounding_box(self):
        plate, disc_offset = keyring_face(20.0)
        center = plate.centering_offset()
        # the disc's middle sits below the bbox middle by exactly that much
        self.assertAlmostEqual(center["x"], 0.0, delta=0.15)
        self.assertAlmostEqual(center["y"], -disc_offset, delta=0.15)
        self.assertAlmostEqual(center["radius"], 20.0, delta=0.15)

    def test_a_plain_rectangle_needs_no_correction(self):
        center = face(60, 30).centering_offset()
        self.assertAlmostEqual(center["x"], 0.0, delta=0.05)
        self.assertAlmostEqual(center["y"], 0.0, delta=0.05)
        self.assertAlmostEqual(center["radius"], 15.0, delta=0.05)

    def test_centring_leaves_room_for_a_much_bigger_logo(self):
        plate, _ = keyring_face(20.0)
        logo = [mw.LogoShape(box(0, 0, 30, 30), "#ff0000")]
        center = plate.centering_offset()
        on_bbox, _ = mw.fit_to_face(logo, plate, MARGIN, rotation_deg=0)
        on_disc, _ = mw.fit_to_face(logo, plate, MARGIN, rotation_deg=0,
                                     center=(center["x"], center["y"]))
        self.assertGreater(on_disc, on_bbox * 1.2)

    def test_a_fit_around_a_centre_stays_inside_the_piece(self):
        plate, _ = keyring_face(20.0)
        logo = [mw.LogoShape(box(0, 0, 30, 30), "#ff0000")]
        center = plate.centering_offset()
        width, _ = mw.fit_to_face(logo, plate, MARGIN, rotation_deg=0,
                                   center=(center["x"], center["y"]))
        params = mw.PlacementParams(width_mm=width, rotation_deg=0.0,
                                     offset_x_mm=center["x"], offset_y_mm=center["y"])
        placed = mw._extrude_shapes(logo, mw._placement_matrix(logo, params), 1.0)
        region = mw._outline_polygon(plate).buffer(-MARGIN)
        corners = placed.bounds
        from shapely.geometry import box as shapely_box
        footprint = shapely_box(corners[0][0], corners[0][1], corners[1][0], corners[1][1])
        # The fit converges until the logo touches the margin exactly, so
        # `contains` is too strict — what matters is that nothing real spills
        # out. 1e-6 mm² is a square a thousandth of a millimetre on a side.
        self.assertLess(footprint.difference(region).area, 1e-6)
        # and it is where we asked it to be
        self.assertAlmostEqual(footprint.centroid.x, center["x"], places=3)
        self.assertAlmostEqual(footprint.centroid.y, center["y"], places=3)


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
