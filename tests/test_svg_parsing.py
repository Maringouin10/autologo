"""Regression tests for the SVG reader.

Real logos come out of Illustrator/Inkscape/Figma wrapped in transformed
groups, with hidden scratch layers and <defs> the file never draws. Each
case here corresponds to a way a shape used to land somewhere it shouldn't
(or appear when it shouldn't at all).

Run with:  python -m unittest discover -s tests
"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import meshwork as mw  # noqa: E402


def shapes_of(svg: str):
    with tempfile.NamedTemporaryFile("w", suffix=".svg", delete=False) as f:
        f.write(svg)
        path = f.name
    try:
        return mw.load_logo(path)
    finally:
        Path(path).unlink(missing_ok=True)


def bounds_of(shapes):
    return sorted(tuple(round(v, 3) for v in s.polygon.bounds) for s in shapes)


SVG = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 400 200">{}</svg>'
RECT = '<rect x="0" y="0" width="20" height="20" fill="#ff0000"/>'


class TransformTests(unittest.TestCase):
    def test_group_transform_is_applied(self):
        shapes = shapes_of(SVG.format(f'<g transform="translate(120,40)">{RECT}</g>'))
        self.assertEqual(bounds_of(shapes), [(120.0, 40.0, 140.0, 60.0)])

    def test_nested_transforms_compose(self):
        shapes = shapes_of(SVG.format(
            f'<g transform="translate(-20,-15)"><g transform="scale(2)">{RECT}</g></g>'))
        self.assertEqual(bounds_of(shapes), [(-20.0, -15.0, 20.0, 25.0)])

    def test_element_transform_applied_once(self):
        shapes = shapes_of(SVG.format(
            '<rect x="0" y="0" width="20" height="20" fill="#f00" transform="translate(30,0)"/>'))
        self.assertEqual(bounds_of(shapes), [(30.0, 0.0, 50.0, 20.0)])

    def test_translate_with_one_argument_leaves_y_alone(self):
        shapes = shapes_of(SVG.format(f'<g transform="translate(40)">{RECT}</g>'))
        self.assertEqual(bounds_of(shapes), [(40.0, 0.0, 60.0, 20.0)])

    def test_rotate_is_degrees_not_radians(self):
        # A square rotated a half-turn about its own centre covers itself.
        shapes = shapes_of(SVG.format(
            f'<g transform="rotate(180 10 10)">{RECT}</g>'))
        self.assertEqual(bounds_of(shapes), [(0.0, 0.0, 20.0, 20.0)])

    def test_rotate_about_a_point(self):
        shapes = shapes_of(SVG.format(f'<g transform="rotate(90 0 0)">{RECT}</g>'))
        self.assertEqual(bounds_of(shapes), [(-20.0, 0.0, 0.0, 20.0)])

    def test_matrix(self):
        shapes = shapes_of(SVG.format(f'<g transform="matrix(1,0,0,1,30,40)">{RECT}</g>'))
        self.assertEqual(bounds_of(shapes), [(30.0, 40.0, 50.0, 60.0)])

    def test_transform_list_applies_left_to_right(self):
        shapes = shapes_of(SVG.format(f'<g transform="translate(10,10) scale(2)">{RECT}</g>'))
        self.assertEqual(bounds_of(shapes), [(10.0, 10.0, 50.0, 50.0)])


class VisibilityTests(unittest.TestCase):
    def test_defs_content_is_not_drawn(self):
        shapes = shapes_of(SVG.format(
            '<defs><rect x="0" y="0" width="400" height="200" fill="#f00"/></defs>'
            '<rect x="10" y="10" width="30" height="30" fill="#00f"/>'))
        self.assertEqual(bounds_of(shapes), [(10.0, 10.0, 40.0, 40.0)])

    def test_clip_path_content_is_not_drawn(self):
        shapes = shapes_of(SVG.format(
            '<clipPath id="c"><circle cx="50" cy="50" r="40"/></clipPath>'
            '<rect x="10" y="10" width="30" height="30" fill="#00f"/>'))
        self.assertEqual(len(shapes), 1)

    def test_hidden_elements_are_skipped(self):
        shapes = shapes_of(SVG.format(
            '<rect x="10" y="10" width="30" height="30" fill="#00f"/>'
            '<rect x="60" y="10" width="30" height="30" fill="#f00" display="none"/>'
            '<rect x="120" y="10" width="30" height="30" fill="#0f0" style="display:none"/>'
            '<g visibility="hidden"><rect x="200" y="10" width="30" height="30" fill="#ff0"/></g>'))
        self.assertEqual(bounds_of(shapes), [(10.0, 10.0, 40.0, 40.0)])

    def test_fill_none_is_ignored(self):
        shapes = shapes_of(SVG.format(
            '<rect x="10" y="10" width="30" height="30" fill="none" stroke="#000"/>'
            '<rect x="60" y="10" width="30" height="30" fill="#00f"/>'))
        self.assertEqual(bounds_of(shapes), [(60.0, 10.0, 90.0, 40.0)])


class UseTests(unittest.TestCase):
    def test_use_is_drawn_at_its_own_position(self):
        shapes = shapes_of(SVG.format(
            f'<defs><g id="tile">{RECT}</g></defs>'
            '<use xlink:href="#tile" transform="translate(10,10)"/>'
            '<use href="#tile" x="100" y="40"/>'))
        self.assertEqual(bounds_of(shapes),
                         [(10.0, 10.0, 30.0, 30.0), (100.0, 40.0, 120.0, 60.0)])

    def test_use_of_a_symbol_draws_its_children(self):
        shapes = shapes_of(SVG.format(
            f'<defs><symbol id="s">{RECT}</symbol></defs>'
            '<use href="#s" transform="translate(60,10) scale(2)"/>'))
        self.assertEqual(bounds_of(shapes), [(60.0, 10.0, 100.0, 50.0)])

    def test_dangling_reference_is_ignored(self):
        shapes = shapes_of(SVG.format(
            '<use href="#nope" x="10" y="10"/>'
            '<rect x="10" y="10" width="30" height="30" fill="#00f"/>'))
        self.assertEqual(len(shapes), 1)


class OverlapTests(unittest.TestCase):
    """SVG paints in document order, so a shape hides what is under it. Two
    solids in the same place made the 3D view show both colors at once and
    would have handed a slicer two filaments for one volume."""

    def areas(self, shapes):
        return sorted(round(s.polygon.area, 2) for s in shapes)

    def test_shapes_no_longer_overlap(self):
        shapes = shapes_of(SVG.format(
            '<rect x="0" y="0" width="100" height="100" fill="#ffffff"/>'
            '<rect x="10" y="10" width="40" height="40" fill="#ff0000"/>'
            '<rect x="30" y="10" width="40" height="40" fill="#0000ff"/>'))
        for i in range(len(shapes)):
            for j in range(i + 1, len(shapes)):
                overlap = shapes[i].polygon.intersection(shapes[j].polygon).area
                self.assertAlmostEqual(overlap, 0.0, places=6)

    def test_total_area_equals_what_is_visible(self):
        shapes = shapes_of(SVG.format(
            '<rect x="0" y="0" width="100" height="100" fill="#ffffff"/>'
            '<rect x="10" y="10" width="40" height="40" fill="#ff0000"/>'))
        self.assertAlmostEqual(sum(s.polygon.area for s in shapes), 100 * 100, places=3)

    def test_the_top_shape_keeps_all_of_itself(self):
        shapes = shapes_of(SVG.format(
            '<rect x="0" y="0" width="40" height="40" fill="#ff0000"/>'
            '<rect x="20" y="20" width="40" height="40" fill="#0000ff"/>'))
        by_color = {s.color: s.polygon.area for s in shapes}
        self.assertAlmostEqual(by_color["#0000ff"], 1600.0, places=3)
        self.assertAlmostEqual(by_color["#ff0000"], 1600.0 - 400.0, places=3)

    def test_a_fully_hidden_shape_disappears(self):
        shapes = shapes_of(SVG.format(
            '<rect x="10" y="10" width="20" height="20" fill="#ff0000"/>'
            '<rect x="0" y="0" width="100" height="100" fill="#0000ff"/>'))
        self.assertEqual([s.color for s in shapes], ["#0000ff"])

    def test_a_shape_cut_in_two_becomes_two_pieces(self):
        shapes = shapes_of(SVG.format(
            '<rect x="0" y="0" width="100" height="20" fill="#ff0000"/>'
            '<rect x="40" y="-5" width="20" height="30" fill="#0000ff"/>'))
        reds = [s for s in shapes if s.color == "#ff0000"]
        self.assertEqual(len(reds), 2)
        self.assertAlmostEqual(sum(r.polygon.area for r in reds), 100 * 20 - 20 * 20, places=3)

    def test_touching_shapes_are_left_alone(self):
        shapes = shapes_of(SVG.format(
            '<rect x="0" y="0" width="20" height="20" fill="#ff0000"/>'
            '<rect x="20" y="0" width="20" height="20" fill="#0000ff"/>'))
        self.assertEqual(self.areas(shapes), [400.0, 400.0])


class ColorTests(unittest.TestCase):
    def test_css_class_fill_survives_nested_transforms(self):
        shapes = shapes_of(SVG.format(
            '<style>.cls-1{fill:#e4002b}</style>'
            f'<g transform="translate(50,25)"><path class="cls-1" d="M0,0 H40 V40 H0 Z"/></g>'))
        self.assertEqual([s.color for s in shapes], ["#e4002b"])
        self.assertEqual(bounds_of(shapes), [(50.0, 25.0, 90.0, 65.0)])

    def test_group_fill_is_inherited(self):
        shapes = shapes_of(SVG.format(
            '<g fill="#123456"><rect x="0" y="0" width="10" height="10"/></g>'))
        self.assertEqual([s.color for s in shapes], ["#123456"])


if __name__ == "__main__":
    unittest.main()
