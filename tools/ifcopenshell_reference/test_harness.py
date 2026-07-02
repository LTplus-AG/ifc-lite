# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Known-answer tests for the shared stat functions and the comparator.

Run: python -m unittest test_harness  (stdlib only, no engine required)
"""

import unittest

import canonical
import compare


def unit_cube() -> tuple[list[float], list[int]]:
    # 8 vertices, 12 triangles, consistently outward-wound unit cube.
    v = [
        0, 0, 0,  1, 0, 0,  1, 1, 0,  0, 1, 0,
        0, 0, 1,  1, 0, 1,  1, 1, 1,  0, 1, 1,
    ]
    f = [
        0, 2, 1, 0, 3, 2,  # bottom (z=0, wound to face -z)
        4, 5, 6, 4, 6, 7,  # top
        0, 1, 5, 0, 5, 4,  # y=0
        1, 2, 6, 1, 6, 5,  # x=1
        2, 3, 7, 2, 7, 6,  # y=1
        3, 0, 4, 3, 4, 7,  # x=0
    ]
    return [float(x) for x in v], f


class CanonicalKnownAnswers(unittest.TestCase):
    def test_unit_cube_stats(self):
        v, f = unit_cube()
        self.assertEqual(canonical.vertex_count(v), 8)
        self.assertEqual(canonical.tri_count(f), 12)
        self.assertEqual(canonical.bbox(v), {"min": [0.0, 0.0, 0.0], "max": [1.0, 1.0, 1.0]})
        self.assertTrue(canonical.is_closed(f))
        self.assertAlmostEqual(abs(canonical.signed_volume(v, f)), 1.0, places=9)

    def test_open_mesh_not_closed(self):
        v, f = unit_cube()
        self.assertFalse(canonical.is_closed(f[:-6]))  # drop two triangles

    def test_element_record_shape(self):
        v, f = unit_cube()
        rec = canonical.element_record(42, "IfcWall", v, f)
        self.assertEqual(rec["status"], "ok")
        self.assertEqual(rec["volume"], 1.0)
        self.assertEqual(rec["tri_count"], 12)

    def test_rounding_kills_negative_zero(self):
        self.assertEqual(canonical.bbox([-0.0000001, 0, 0, 0, 0, 0])["min"][0], 0.0)


class ComparatorClassification(unittest.TestCase):
    def ok(self, **over):
        base = {
            "express_id": 1, "ifc_type": "IfcWall", "status": "ok",
            "bbox": {"min": [0, 0, 0], "max": [1, 1, 1]},
            "vertex_count": 8, "tri_count": 12, "volume": 1.0, "closed": True,
        }
        base.update(over)
        return base

    def test_match(self):
        cls, failing, advisory = compare.classify(self.ok(), self.ok())
        self.assertEqual((cls, failing, advisory), ("MATCH", [], []))

    def test_bbox_gates(self):
        other = self.ok(bbox={"min": [0, 0, 0], "max": [1, 1, 1.01]})
        cls, failing, _ = compare.classify(self.ok(), other)
        self.assertEqual(cls, "MISMATCH")
        self.assertIn("bbox", failing)

    def test_volume_gates_when_both_closed_and_plausible(self):
        cls, failing, _ = compare.classify(self.ok(), self.ok(volume=0.8))
        self.assertEqual(cls, "MISMATCH")
        self.assertIn("volume", failing)

    def test_implausible_volume_is_advisory_not_gating(self):
        # volume exceeding the bbox volume = mixed-winding artifact, not evidence
        cls, failing, advisory = compare.classify(self.ok(volume=35.0), self.ok())
        self.assertEqual(cls, "MATCH")
        self.assertEqual(failing, [])
        self.assertIn("volume-unverifiable", advisory)

    def test_tri_density_is_advisory(self):
        cls, failing, advisory = compare.classify(self.ok(tri_count=92), self.ok(tri_count=308))
        self.assertEqual(cls, "MATCH")
        self.assertIn("tri_count", advisory)

    def test_reference_only_fails(self):
        skipped = canonical.skip_record(1, "IfcWall", "RuntimeError")
        cls, _, _ = compare.classify(self.ok(), skipped)
        self.assertEqual(cls, "REFERENCE_ONLY")

    def test_ifclite_only_and_both_skip(self):
        skipped = canonical.skip_record(1, "IfcWall", "x")
        self.assertEqual(compare.classify(skipped, self.ok())[0], "IFCLITE_ONLY")
        self.assertEqual(compare.classify(skipped, skipped)[0], "BOTH_SKIP")


if __name__ == "__main__":
    unittest.main()
