"""QR codes the vendor places on a product: generated as printable shapes,
placed with the same pipeline as a logo, and — the part that matters —
still scannable once they are 3D geometry on a face.

Run with:  python -m unittest discover -s tests
"""
import sys
import unittest
from pathlib import Path

import numpy as np
import trimesh

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import meshwork as mw  # noqa: E402

try:
    import cv2
    from PIL import Image, ImageDraw
except ImportError:   # decoding is only checked where an image stack is around
    cv2 = None


def top_face(box: trimesh.Trimesh) -> mw.FaceInfo:
    index = int(np.argmax(box.triangles_center[:, 2] + box.face_normals[:, 2] * 100))
    return mw.find_flat_region(box, mw.face_adjacency_of(box), index)


class QrShapeTests(unittest.TestCase):
    def test_shapes_are_valid_and_centred(self):
        shapes = mw.qr_shapes("https://example.com/abc")
        self.assertTrue(shapes)
        for s in shapes:
            self.assertTrue(s.polygon.is_valid)
            self.assertEqual(s.color, mw.QR_COLOR)
        minx, miny, maxx, maxy = mw.logo_bounds(shapes)
        self.assertAlmostEqual((minx + maxx) / 2, 0, delta=0.6)
        self.assertAlmostEqual((miny + maxy) / 2, 0, delta=0.6)

    def test_pieces_do_not_overlap(self):
        shapes = mw.qr_shapes("hello")
        total = sum(s.polygon.area for s in shapes)
        from shapely.ops import unary_union
        self.assertAlmostEqual(unary_union([s.polygon for s in shapes]).area, total, places=3)

    def test_empty_and_oversized_are_refused(self):
        with self.assertRaises(mw.MeshError):
            mw.qr_shapes("   ")
        with self.assertRaises(mw.MeshError):
            mw.qr_shapes("x" * (mw.QR_MAX_CHARS + 1))

    def test_emboss_makes_one_solid_object(self):
        box = trimesh.creation.box((60, 60, 10))
        face = top_face(box)
        out = mw.emboss(mw.qr_shapes("hello"), face, mw.PlacementParams(width_mm=40),
                        depth_mm=1.0, sink_mm=0.3)
        self.assertEqual(list(out), [mw.QR_COLOR])
        mesh = out[mw.QR_COLOR]
        self.assertGreater(mesh.volume, 0)
        self.assertAlmostEqual(mesh.bounds[1][2], 5 + 1.0, places=2)

    def test_deboss_cuts_a_pocket(self):
        box = trimesh.creation.box((60, 60, 10))
        face = top_face(box)
        pocketed, fills = mw.deboss(box, mw.qr_shapes("hello"), face,
                                    mw.PlacementParams(width_mm=40), depth_mm=1.0)
        self.assertLess(pocketed.volume, box.volume)
        self.assertGreater(fills[mw.QR_COLOR].volume, 0)


@unittest.skipIf(cv2 is None, "opencv not installed")
class QrScansTests(unittest.TestCase):
    def render_top(self, mesh: trimesh.Trimesh, size_mm: float, px_per_mm: int = 12) -> np.ndarray:
        """Look straight down at the raised geometry: x to the right, y up."""
        top = mesh.bounds[1][2] - 1e-3
        img = Image.new("L", (int(size_mm * px_per_mm), int(size_mm * px_per_mm)), 255)
        draw = ImageDraw.Draw(img)
        half = size_mm / 2
        for tri in mesh.triangles:
            if np.all(tri[:, 2] > top):
                pts = [((x + half) * px_per_mm, (half - y) * px_per_mm) for x, y, _ in tri]
                draw.polygon(pts, fill=0)
        return np.array(img.convert("RGB"))

    def decode(self, text: str, **params) -> str:
        box = trimesh.creation.box((80, 80, 10))
        out = mw.emboss(mw.qr_shapes(text), top_face(box),
                        mw.PlacementParams(**{"width_mm": 50, **params}),
                        depth_mm=1.0, sink_mm=0.3)
        image = self.render_top(out[mw.QR_COLOR], 80)
        image = cv2.copyMakeBorder(image, 60, 60, 60, 60, cv2.BORDER_CONSTANT, value=(255, 255, 255))
        value, _, _ = cv2.QRCodeDetector().detectAndDecode(image)
        return value

    def test_relief_qr_reads_back(self):
        self.assertEqual(self.decode("https://example.com/commande/42"), "https://example.com/commande/42")

    def test_rotated_and_offset_qr_still_reads(self):
        self.assertEqual(self.decode("hello", rotation_deg=90, offset_x_mm=5, offset_y_mm=-4), "hello")


if __name__ == "__main__":
    unittest.main()
