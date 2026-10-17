# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Golden hashes of the wheel's `entity_data` (C6-0, #7783; charter #7670 T3, gate G8).

`entity_data` reads the shared export model with type inheritance and schema
attributes ON by default, so it is the one consumer that sees both. Each
output (JSON, sorted keys, `Infinity` spelled as Python spells it) is pinned
as FNV-1a 64 plus byte length in `golden/entity-data.json`, in the same file
shape as `test_golden.py`. In-tree fixtures only, so the wheel job needs no
fetch. Re-pin with `IFC_LITE_REPIN_GOLDEN=1`; a re-pin under CI is refused.
"""

import json
import math
import os
from pathlib import Path

import ifclite_geom

from test_golden import fnv1a64, repin_requested

REPO = Path(__file__).resolve().parents[3]
GOLDEN = Path(__file__).resolve().parent / "golden" / "entity-data.json"
REPIN = "IFC_LITE_REPIN_GOLDEN=1 python -m pytest rust/python/tests/test_golden_entity_data.py"
SYNTHETIC = REPO / "rust/export/tests/fixtures/c6_data_model_synthetic.ifc"
FIXTURES = REPO / "rust/geometry/tests/fixtures"

# (case, path, entity_data kwargs)
CASES = [
    ("synthetic:defaults", SYNTHETIC, {}),
    ("synthetic:own-sets-only", SYNTHETIC, {"type_properties": False}),
    ("synthetic:no-attributes", SYNTHETIC, {"attributes": False}),
    ("synthetic:placements", SYNTHETIC, {"placements": True}),
    ("mapped_instances_synthetic:defaults", FIXTURES / "mapped_instances_synthetic.ifc", {}),
    ("issue_098_wall_V5C:defaults", FIXTURES / "issue_098_wall_V5C.ifc", {}),
]


def entities(path, **kwargs):
    return ifclite_geom.entity_data(path.read_bytes(), **kwargs)["entities"]


def prop(entity, pset, name):
    sets = [p for p in entity["property_sets"] if p["name"] == pset]
    return next(p for s in sets for p in s["properties"] if p["name"] == name)


def test_non_finite_values_keep_todays_tokens():
    wall = entities(SYNTHETIC)[330]
    assert (prop(wall, "Pset_NonFinite", "HugeReal")["value"], prop(wall, "Pset_NonFinite", "HugeReal")["value_type"]) == ("inf", "IFCREAL")
    assert prop(wall, "Pset_NonFinite", "HugeNegativeLength")["value"] == "-inf"
    assert prop(wall, "Pset_NonFinite", "Finite")["value"] == "1.5"
    huge = wall["quantity_sets"][0]["quantities"][0]
    assert (huge["name"], huge["kind"]) == ("Huge", "Length")
    assert math.isinf(huge["value"]) and huge["value"] > 0


def test_inheritance_and_attributes_are_on_by_default():
    ents = entities(SYNTHETIC)
    names = [p["name"] for p in ents[310]["property_sets"]]
    assert names == ["Pset_Occurrence", "Pset_AllKinds"]
    assert [a["name"] for a in ents[310]["attributes"]] == ["Tag", "PredefinedType"]
    own = entities(SYNTHETIC, type_properties=False, attributes=False)
    assert [p["name"] for p in own[310]["property_sets"]] == ["Pset_Occurrence"]
    assert own[310]["attributes"] == []
    # The double-typed #310 takes type A (the first relationship), never B.
    assert all(p["name"] != "Pset_TypeB" for p in ents[310]["property_sets"])


def test_entity_data_matches_its_pins():
    actual = {}
    for case, path, kwargs in CASES:
        out = ifclite_geom.entity_data(path.read_bytes(), **kwargs)
        data = json.dumps(out, sort_keys=True, ensure_ascii=False, allow_nan=True).encode("utf-8")
        actual[case] = {"fnv1a64": fnv1a64(data), "bytes": len(data)}

    if repin_requested():
        assert "CI" not in os.environ, f"IFC_LITE_REPIN_GOLDEN=1 under CI: refusing to rewrite {GOLDEN}"
        document = {
            "about": "FNV-1a 64 and byte length of each entity-data output, keyed by case. "
            "Written by rust/python/tests/test_golden_entity_data.py, never by hand.",
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
            report.append(f"  (entity-data, {case}) has no pin: got {pin['fnv1a64']} ({pin['bytes']} bytes)")
        elif want != pin:
            report.append(
                f"  (entity-data, {case}) MOVED: pinned {want['fnv1a64']} ({want['bytes']} bytes), "
                f"got {pin['fnv1a64']} ({pin['bytes']} bytes)"
            )
    report += [f"  (entity-data, {case}) is pinned but no longer produced (stale pin)" for case in pinned if case not in actual]
    assert not report, (
        f"\nentity-data output moved against {GOLDEN}:\n" + "\n".join(report) + "\n\nIf the change is "
        "intended, re-pin and justify each moved case in the PR (charter #7670 §1.2, class X):\n  " + REPIN
    )
