# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Known-answer tests for the shared stat functions and the comparator.

Run: python -m unittest test_harness  (stdlib only, no engine required)
"""

from __future__ import annotations

import contextlib
import copy
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

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


class EndToEndFaultInjection(unittest.TestCase):
    """Proves the RED path end to end, not just the classify() helper.

    ``ComparatorClassification`` above exercises ``classify()`` in isolation
    against hand-built dicts - it proves the classification RULES are
    correct, but not that the CLI entry point CI actually runs
    (``compare.py --reference ... --ifclite ...``, exit code, the
    committed-reference file, the shipped allowlist.json) fires red on a
    real divergence. A gate that is only proven correct in a unit and never
    proven to fire in its own binary is not evidence the "quick" job in
    ifcopenshell-parity.yml is fit to be promoted to a required check.

    This suite loads an ACTUAL committed reference dump (never mutated on
    disk), perturbs an in-memory copy the way a genuine kernel regression
    would, feeds the perturbed copy through ``compare.main()`` exactly as
    the workflow invokes it (same argv shape, same allowlist.json), and
    asserts the process reports failure. A positive control (unperturbed
    copy stays green) rules out "always red"; the shipped allowlist.json is
    used unmodified so an allowlisted fixture couldn't silently mask a
    fault-injection failure.
    """

    FIXTURE = "bath_csg_solid"
    HERE = Path(__file__).resolve().parent

    def setUp(self):
        self.ref_path = self.HERE / "reference" / f"{self.FIXTURE}.reference.json"
        self.allowlist_path = self.HERE / "allowlist.json"
        self.doc = json.loads(self.ref_path.read_text())
        # Fixture must stay outside allowlist.json, or a perturbation could
        # be silently absorbed instead of failing the gate.
        allow = json.loads(self.allowlist_path.read_text())
        self.assertNotIn(
            self.doc["fixture"],
            allow,
            f"{self.FIXTURE} must stay unlisted in allowlist.json for this "
            "fault-injection suite to prove anything",
        )
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)

    def _write_lite(self, doc: dict) -> Path:
        path = Path(self.tmpdir.name) / "perturbed.ifclite.json"
        path.write_text(json.dumps(doc))
        return path

    def _run_compare(self, lite_path: Path, report_path: Path | None = None) -> tuple[int, dict | None]:
        argv = [
            "compare.py",
            "--reference",
            str(self.ref_path),
            "--ifclite",
            str(lite_path),
            "--allowlist",
            str(self.allowlist_path),
        ]
        if report_path is not None:
            argv += ["--report", str(report_path)]
        old_argv = sys.argv
        sys.argv = argv
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(
                io.StringIO()
            ):
                rc = compare.main()
        finally:
            sys.argv = old_argv
        report = json.loads(report_path.read_text()) if report_path else None
        return rc, report

    def test_unperturbed_copy_is_green(self):
        # Positive control: an untouched copy of the reference must exit 0,
        # so the two failing tests below prove the gate reacts to the
        # perturbation, not that it is unconditionally red.
        lite = self._write_lite(copy.deepcopy(self.doc))
        rc, _ = self._run_compare(lite)
        self.assertEqual(rc, 0)

    def test_bbox_divergence_reds(self):
        doc = copy.deepcopy(self.doc)
        eid = doc["elements"][0]["express_id"]
        # 50 mm >> the 1 mm BBOX_TOL_M gate.
        doc["elements"][0]["bbox"]["max"][0] += 0.05
        lite = self._write_lite(doc)
        report_path = Path(self.tmpdir.name) / "bbox.report.json"
        rc, report = self._run_compare(lite, report_path)
        self.assertNotEqual(
            rc, 0, "compare.py must exit non-zero when bbox diverges beyond the 1mm gate"
        )
        failure = next(
            (f for f in report["failures"] if f["express_id"] == eid), None
        )
        self.assertIsNotNone(
            failure, f"element {eid} must appear in report failures on a bbox divergence"
        )
        self.assertIn("bbox", failure["failing"])

    def test_volume_divergence_reds(self):
        doc = copy.deepcopy(self.doc)
        elem = doc["elements"][0]
        eid = elem["express_id"]
        # +50% >> the 1% VOLUME_REL_TOL gate. The perturbed volume must stay
        # INSIDE the bbox volume (see compare.usable_volume): a value above it
        # is a mixed-winding artifact that downgrades to the advisory path,
        # so the gate would exit 0 and this test would fail confusingly
        # rather than proving the volume gate reds. Lock that precondition in
        # so a future reference regeneration with a more voluminous shape
        # fails loudly here instead of silently defanging the test.
        perturbed = round(elem["volume"] * 1.5, 6)
        ext = [elem["bbox"]["max"][i] - elem["bbox"]["min"][i] for i in range(3)]
        bbox_vol = ext[0] * ext[1] * ext[2]
        self.assertTrue(
            elem.get("closed") and perturbed <= bbox_vol * 1.001,
            f"perturbed volume {perturbed} must stay a *usable* (closed, "
            f"<= bbox volume {bbox_vol}) comparison for this test to exercise "
            "the volume gate rather than the mixed-winding advisory path",
        )
        elem["volume"] = perturbed
        lite = self._write_lite(doc)
        report_path = Path(self.tmpdir.name) / "volume.report.json"
        rc, report = self._run_compare(lite, report_path)
        self.assertNotEqual(
            rc, 0, "compare.py must exit non-zero when volume diverges beyond the 1% gate"
        )
        failure = next(
            (f for f in report["failures"] if f["express_id"] == eid), None
        )
        self.assertIsNotNone(
            failure, f"element {eid} must appear in report failures on a volume divergence"
        )
        self.assertIn("volume", failure["failing"])

    def test_dropped_element_reds_as_reference_only(self):
        # Simulates the kernel silently failing to produce geometry for an
        # element the reference engine handled - REFERENCE_ONLY, which
        # compare.py treats as a failure (docstring: "-> fails").
        doc = copy.deepcopy(self.doc)
        doc["elements"] = []
        lite = self._write_lite(doc)
        rc, _ = self._run_compare(lite)
        self.assertNotEqual(
            rc, 0, "a dropped element (REFERENCE_ONLY) must fail the gate"
        )


if __name__ == "__main__":
    unittest.main()
