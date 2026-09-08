# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Tests for validate_export.py (#4043).

Two things need proving, mirroring test_harness.py's EndToEndFaultInjection
philosophy for the geometry parity harness ("proof the red path has teeth,
not just that classify() is correct in isolation"):

  1. The vacuity refusals (zero files, missing file) fire WITHOUT needing
     ifcopenshell installed — always run.
  2. The actual schema-conformance check has teeth: a hand-built minimal
     valid IFC4 model (IfcProject -aggregates-> IfcSite) passes, and the
     same model with a duplicated GlobalId — the same defect class as
     regression #1839, just a different rule — fails with the offending
     entities and rule named in the output. Requires ifcopenshell, so those
     two are skipped (loudly, not silently) when it is not importable.

Run: python -m unittest test_validate_export
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

try:
    import ifcopenshell  # noqa: F401

    HAVE_IFCOPENSHELL = True
except ImportError:
    HAVE_IFCOPENSHELL = False

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "validate_export.py"


def run_script(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
    )


def build_minimal_ifc4(tmp_dir: Path, *, duplicate_global_id: bool) -> Path:
    """A hand-built minimal-but-valid IFC4 model: IfcProject aggregating one
    IfcSite. Built through the ifcopenshell API (not hand-typed STEP text) so
    its validity is generated, not assumed."""
    import ifcopenshell
    import ifcopenshell.guid as guid

    f = ifcopenshell.file(schema="IFC4")
    project = f.create_entity("IfcProject", GlobalId=guid.new(), Name="P")
    site = f.create_entity(
        "IfcSite",
        GlobalId=project.GlobalId if duplicate_global_id else guid.new(),
        Name="S",
    )
    f.create_entity(
        "IfcRelAggregates",
        GlobalId=guid.new(),
        RelatingObject=project,
        RelatedObjects=[site],
    )
    out = tmp_dir / ("corrupt.ifc" if duplicate_global_id else "clean.ifc")
    f.write(str(out))
    return out


class VacuityRefusals(unittest.TestCase):
    """These must fire in EVERY environment, ifcopenshell installed or not —
    a caller that points this script at nothing must never see exit 0."""

    def test_zero_files_is_a_failure(self) -> None:
        result = run_script()
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("refusing to validate zero files", result.stderr)

    def test_missing_file_is_a_failure(self) -> None:
        result = run_script("/nonexistent/path/does-not-exist.ifc")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("missing fixture", result.stderr)


@unittest.skipUnless(HAVE_IFCOPENSHELL, "ifcopenshell not installed — see requirements.lock")
class SchemaConformanceHasTeeth(unittest.TestCase):
    """Positive control (clean passes) and fault injection (corrupt fails),
    the same pairing test_harness.py's EndToEndFaultInjection uses for
    compare.py — a check never shown to fail is not a check."""

    def test_clean_model_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = build_minimal_ifc4(Path(tmp), duplicate_global_id=False)
            result = run_script(str(path))
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("0 issues", result.stdout)

    def test_duplicate_global_id_is_caught(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = build_minimal_ifc4(Path(tmp), duplicate_global_id=True)
            result = run_script(str(path))
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            # Names the rule and both offending entities, not just "invalid".
            self.assertIn("IfcRoot.UR1", result.stdout)
            self.assertIn("IfcProject", result.stdout)
            self.assertIn("IfcSite", result.stdout)

    def test_multiple_files_one_bad_one_good(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            good = build_minimal_ifc4(tmp_path, duplicate_global_id=False)
            bad = build_minimal_ifc4(tmp_path, duplicate_global_id=True)
            result = run_script(str(good), str(bad))
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn(f"OK   {good}", result.stdout)
            self.assertIn(f"FAIL {bad}", result.stdout)


if __name__ == "__main__":
    unittest.main()
