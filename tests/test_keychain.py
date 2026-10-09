"""The keychain mode: a plate cut around the logo, with a ring tab.

Run with:  python -m unittest discover -s tests
"""
import sys
import tempfile
import unittest
from pathlib import Path

import trimesh

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import meshwork as mw  # noqa: E402

# A red bar on top, a blue ring below it, with a gap between them: the
# plate has to bridge the two, and the ring must keep its counter.
SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<rect x="0" y="0" width="100" height="20" fill="#ff0000"/>
<path fill="#0000ff" fill-rule="evenodd"
      d="M30 70 a20 20 0 1 0 40 0 a20 20 0 1 0 -40 0 Z M40 70 a10 10 0 1 0 20 0 a10 10 0 1 0 -20 0 Z"/>
</svg>"""


def load_shapes():
    with tempfile.NamedTemporaryFile("w", suffix=".svg", delete=False) as f:
        f.write(SVG)
    return mw.load_logo(f.name)


class KeychainTests(unittest.TestCase):
    def setUp(self):
        self.shapes = load_shapes()

    def test_everything_is_a_printable_volume(self):
        for angle in (0, 45, 90, 180, 270):
            for fill in (True, False):
                base, logos, _ = mw.keychain(
                    self.shapes, mw.KeychainParams(ring_angle_deg=angle, fill_holes=fill))
                self.assertTrue(base.is_volume, (angle, fill))
                self.assertEqual(len(base.split(only_watertight=False)), 1, (angle, fill))
                for mesh in logos.values():
                    self.assertTrue(mesh.is_volume, (angle, fill))

    def test_one_logo_object_per_color(self):
        _, logos, _ = mw.keychain(self.shapes, mw.KeychainParams())
        self.assertEqual(set(logos), {"#ff0000", "#0000ff"})

    def test_logo_reads_the_right_way_up(self):
        # The red bar is at the top of the SVG (y-down): it must end up at
        # the top of the plate seen from above (y-up).
        _, logos, _ = mw.keychain(self.shapes, mw.KeychainParams(ring=False))
        self.assertGreater(logos["#ff0000"].bounds[0][1], logos["#0000ff"].bounds[1][1])

    def test_border_and_size(self):
        p = mw.KeychainParams(width_mm=40, border_mm=3, ring=False)
        base, _, size = mw.keychain(self.shapes, p)
        self.assertAlmostEqual(size[0], 46.0, delta=0.2)
        self.assertAlmostEqual(base.bounds[1][2] - base.bounds[0][2], p.base_mm, places=5)

    def test_logo_sits_on_the_plate(self):
        p = mw.KeychainParams(base_mm=3, relief_mm=1.2)
        _, logos, _ = mw.keychain(self.shapes, p)
        for mesh in logos.values():
            self.assertAlmostEqual(mesh.bounds[0][2], 3 - mw.KEYCHAIN_SINK_MM, places=5)
            self.assertAlmostEqual(mesh.bounds[1][2], 3 + 1.2, places=5)

    def test_ring_hangs_off_the_edge_in_the_chosen_direction(self):
        _, _, plain = mw.keychain(self.shapes, mw.KeychainParams(ring=False))
        base, logos, ringed = mw.keychain(self.shapes, mw.KeychainParams(ring_angle_deg=90))
        self.assertGreater(ringed[1], plain[1])          # taller: the tab is on top
        self.assertAlmostEqual(ringed[0], plain[0], delta=0.2)
        # The hole goes through: a vertical ray down the tab hits nothing.
        top = base.bounds[1][1]
        hole_y = top - mw.KeychainParams().ring_wall_mm - mw.KeychainParams().hole_mm / 2
        hits = base.ray.intersects_any([[0, hole_y, 10]], [[0, 0, -1]])
        self.assertFalse(hits[0])

    def test_filling_holes_closes_the_counter(self):
        solid, _, _ = mw.keychain(self.shapes, mw.KeychainParams(ring=False, fill_holes=True))
        hollow, _, _ = mw.keychain(self.shapes, mw.KeychainParams(ring=False, fill_holes=False))
        self.assertGreater(solid.volume, hollow.volume)

    def test_export_round_trips(self):
        base, logos, _ = mw.keychain(self.shapes, mw.KeychainParams())
        data = mw.export_3mf({"porte-cle": base, **{f"logo_{i}": m for i, m in enumerate(logos.values())}})
        with tempfile.NamedTemporaryFile(suffix=".3mf", delete=False) as f:
            f.write(data)
        scene = trimesh.load(f.name)
        self.assertEqual(len(scene.geometry), 3)


if __name__ == "__main__":
    unittest.main()
