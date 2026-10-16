# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Golden hashes of the wheel's `geometry_data_json` (#7671, charter #7670 T3, gate G8).

The wheel composes its JSON itself (RTC + site-rotation choice, swept-disk
splice), so the Rust oracles do not reach it, and `rust/python` is outside the
cargo workspace. Each output is pinned as FNV-1a 64 plus byte length in
`golden/geometry-data-json.json`, the same file shape as the Rust golden files
(`rust/export/tests/support/golden.rs`). Re-pin with `IFC_LITE_REPIN_GOLDEN=1`
(only "1" is on, only unset/""/"0" is off); a re-pin under CI is refused.
Runs against the installed wheel in `python-wheels.yml`, Linux x86_64.
"""

import json
import os
from pathlib import Path

import ifclite_geom

REPO = Path(__file__).resolve().parents[3]
GOLDEN = Path(__file__).resolve().parent / "golden" / "geometry-data-json.json"
REPIN = "IFC_LITE_REPIN_GOLDEN=1 python -m pytest rust/python/tests/test_golden.py"
FIXTURES = REPO / "rust/geometry/tests/fixtures"

# (case, fixture, include_directrices): in-tree only, so the wheel job needs no fetch.
CASES = [
    ("mapped_instances_synthetic", "mapped_instances_synthetic.ifc", False),
    ("bath_csg_solid", "bath_csg_solid.ifc", False),
    ("issue_098_wall_V5C", "issue_098_wall_V5C.ifc", False),
    ("swept_disk_composite_arc_ubar+directrices", "swept_disk_composite_arc_ubar.ifc", True),
]


def fnv1a64(data: bytes) -> str:
    h = 0xCBF29CE484222325
    for b in data:
        h = ((h ^ b) * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"{h:016x}"


def repin_requested() -> bool:
    value = os.environ.get("IFC_LITE_REPIN_GOLDEN")
    if value in (None, "", "0"):
        return False
    if value == "1":
        return True
    raise AssertionError(f'IFC_LITE_REPIN_GOLDEN={value!r} is not recognised (use "1" or "0")')


def test_fnv1a64_matches_the_rust_vectors():
    assert fnv1a64(b"") == "cbf29ce484222325"
    assert fnv1a64(b"a") == "af63dc4c8601ec8c"
    assert fnv1a64(b"foobar") == "85944171f73967e8"


def test_geometry_data_json_matches_its_pins():
    actual = {}
    for case, fixture, directrices in CASES:
        out = ifclite_geom.geometry_data_json((FIXTURES / fixture).read_bytes(), include_directrices=directrices)
        data = out.encode("utf-8")
        actual[case] = {"fnv1a64": fnv1a64(data), "bytes": len(data)}

    if repin_requested():
        assert "CI" not in os.environ, f"IFC_LITE_REPIN_GOLDEN=1 under CI: refusing to rewrite {GOLDEN}"
        document = {
            "about": "FNV-1a 64 and byte length of each geometry-data-json output, keyed by case. "
            "Written by rust/python/tests/test_golden.py, never by hand.",
            "repin": REPIN,
            "cases": dict(sorted(actual.items())),
        }
        GOLDEN.parent.mkdir(parents=True, exist_ok=True)
        GOLDEN.write_text(json.dumps(document, indent=2) + "\n")
        return

    pinned = json.loads(GOLDEN.read_text())["cases"]
    report = []
    for case, pin in actual.items():
        want = pinned.get(case)
        if want is None:
            report.append(f"  (geometry-data-json, {case}) has no pin: got {pin['fnv1a64']} ({pin['bytes']} bytes)")
        elif want != pin:
            report.append(
                f"  (geometry-data-json, {case}) MOVED: pinned {want['fnv1a64']} ({want['bytes']} bytes), "
                f"got {pin['fnv1a64']} ({pin['bytes']} bytes)"
            )
    report += [f"  (geometry-data-json, {case}) is pinned but no longer produced (stale pin)" for case in pinned if case not in actual]
    assert not report, (
        f"\ngeometry-data-json output moved against {GOLDEN}:\n" + "\n".join(report) + "\n\nIf the change is "
        "intended, re-pin and justify each moved case in the PR (charter #7670 §1.2, class X):\n  " + REPIN
    )
