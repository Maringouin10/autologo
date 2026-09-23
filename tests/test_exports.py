"""Exports the vendor actually files away: named after the object, and
re-readable as something the admin can look at.

Run with:  python -m unittest discover -s tests
"""
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import trimesh

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import meshwork as mw  # noqa: E402
from app.main import _slug  # noqa: E402


class SlugTests(unittest.TestCase):
    def test_accents_and_spaces_become_a_filename(self):
        self.assertEqual(_slug("Porte-clé Été 2026"), "porte-cle-ete-2026")

    def test_punctuation_collapses(self):
        self.assertEqual(_slug("Mug  //  V2 (final!)"), "mug-v2-final")

    def test_empty_falls_back(self):
        self.assertEqual(_slug(""), "objet")
        self.assertEqual(_slug("❤❤❤", "autologo"), "autologo")

    def test_length_is_bounded(self):
        self.assertLessEqual(len(_slug("a" * 200)), 60)


class PreviewTests(unittest.TestCase):
    def build_3mf(self) -> str:
        base = trimesh.creation.box((20, 20, 20))
        logo = trimesh.creation.box((5, 5, 2))
        logo.apply_translation([0, 0, 11])
        data = mw.export_3mf({"piece": base, "logo_1_f2c115": logo},
                              {"piece": "#2563eb", "logo_1_f2c115": "#f2c115"})
        path = Path(tempfile.mkdtemp()) / "order.3mf"
        path.write_bytes(data)
        return str(path)

    def test_preview_keeps_every_object_and_its_color(self):
        glb = mw.scene_to_glb(self.build_3mf())
        self.assertGreater(len(glb), 0)
        scene = trimesh.load(trimesh.util.wrap_as_stream(glb), file_type="glb", process=False)
        mesh = next(iter(scene.geometry.values()))
        # both boxes, merged into one mesh the viewer can show in one go
        self.assertEqual(len(mesh.faces), 24)
        colors = {tuple(c[:3]) for c in np.unique(mesh.visual.vertex_colors, axis=0)}
        self.assertIn((37, 99, 235), colors)    # the object's filament
        self.assertIn((242, 193, 21), colors)   # the logo's

    def test_a_colorless_3mf_still_previews(self):
        data = mw.export_3mf({"piece": trimesh.creation.box((10, 10, 10))})
        path = Path(tempfile.mkdtemp()) / "plain.3mf"
        path.write_bytes(data)
        self.assertGreater(len(mw.scene_to_glb(str(path))), 0)


if __name__ == "__main__":
    unittest.main()
