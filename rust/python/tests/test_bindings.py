# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Smoke tests for the ifclite_geom wheel, run against the installed artifact.

These run in `python-wheels.yml` after the Linux x86_64 wheel is built, so they
exercise the same binary that ships to PyPI rather than a local cargo build.
Fixtures come from the repo, so pytest must run from the repository root.
"""

import json

import pytest

# A hard import, deliberately not `pytest.importorskip`: if the wheel failed to
# install, these tests must fail rather than skip into a green run.
import ifclite_geom

# A single reinforcing-style bar: IfcSweptDiskSolid over a composite arc, i.e.
# the curve-heavy shape the quality knob exists for.
REBAR = "rust/geometry/tests/fixtures/swept_disk_composite_arc_ubar.ifc"
# 4 walls with geometry, placements, and psets attached to their IfcWallType.
WALLS = (
    "packages/ids/src/__corpus__/buildingsmart-ids/property/"
    "fail-properties_can_be_associated_to_relevant_object_types.ifc"
)
# One IfcWall carrying an occurrence-level pset via IfcRelDefinesByProperties.
OCCURRENCE_PSET = (
    "packages/ids/src/__corpus__/buildingsmart-ids/property/"
    "pass-all_matching_properties_must_satisfy_requirements_1_3.ifc"
)

QUALITIES = ["lowest", "low", "medium", "high", "highest"]


def read(path):
    with open(path, "rb") as f:
        return f.read()


def triangle_count(data):
    # 4 bytes per u32 index, 3 indices per triangle.
    return sum(len(el["faces"]) // 12 for el in data["elements"].values())


def test_quality_is_monotonic_and_defaults_to_medium():
    ifc = read(REBAR)
    counts = {
        q: triangle_count(ifclite_geom.geometry_data_buffers(ifc, q)) for q in QUALITIES
    }

    # Each step is a factor-of-two density change, so counts strictly increase.
    assert [counts[q] for q in QUALITIES] == sorted(counts.values())
    assert len(set(counts.values())) == len(QUALITIES), counts

    # Omitting the argument must not change what existing callers already get.
    assert triangle_count(ifclite_geom.geometry_data_buffers(ifc)) == counts["medium"]

    # The point of the knob: a real reduction on curve-heavy elements.
    assert counts["lowest"] < counts["medium"] / 2


def test_unknown_quality_raises_rather_than_falling_back():
    with pytest.raises(ValueError, match="unknown tessellation quality"):
        ifclite_geom.geometry_data_buffers(read(REBAR), "ultra")


def test_quality_applies_to_the_json_path_too():
    ifc = read(REBAR)

    def indices(doc):
        return sum(len(el["faces"]) for el in doc["elements"].values())

    low = json.loads(ifclite_geom.geometry_data_json(ifc, "lowest"))
    high = json.loads(ifclite_geom.geometry_data_json(ifc, "highest"))
    assert indices(low) < indices(high)


def test_entity_data_reads_occurrence_property_sets():
    data = ifclite_geom.entity_data(read(OCCURRENCE_PSET))

    assert data["length_unit_scale"] == pytest.approx(0.001)  # millimetre file
    rows = [r for r in data["entities"].values() if r["property_sets"]]
    assert rows, "expected at least one entity with a property set"

    pset = rows[0]["property_sets"][0]
    assert pset["name"] == "Foo_Bar"
    assert pset["properties"] == [
        {"name": "Foobar", "value": "x", "value_type": "IFCLABEL"}
    ]


def test_entity_data_keys_join_against_geometry():
    ifc = read(WALLS)
    geom = ifclite_geom.geometry_data_buffers(ifc)
    ents = ifclite_geom.entity_data(ifc)

    shared = set(geom["elements"]) & set(ents["entities"])
    assert len(shared) == 4, "the 4 walls should appear in both exports"
    for step_id in shared:
        assert isinstance(step_id, int)
        assert geom["elements"][step_id]["ifc_type"] == ents["entities"][step_id]["ifc_type"]


def test_placements_are_opt_in_and_do_not_disturb_properties():
    ifc = read(WALLS)
    without = ifclite_geom.entity_data(ifc)
    with_ = ifclite_geom.entity_data(ifc, placements=True)

    assert all(r["placement"] is None for r in without["entities"].values())
    placed = [r["placement"] for r in with_["entities"].values() if r["placement"]]
    assert placed, "expected some resolved placements"
    assert all(len(m) == 16 for m in placed)

    # Resolving placements must not change anything else about the rows.
    assert [r["property_sets"] for r in without["entities"].values()] == [
        r["property_sets"] for r in with_["entities"].values()
    ]


def test_type_held_properties_are_absent():
    """Pins the documented gap so it cannot change silently.

    Both fixtures define psets on an IfcWallType. Neither the type row nor the
    inheriting occurrences carry them today. When type-property support lands,
    this test should fail and be rewritten -- that is the intent.
    """
    rows = list(ifclite_geom.entity_data(read(WALLS))["entities"].values())

    # Anchor the absence claims against presence, so this cannot pass by
    # returning nothing at all.
    assert [r["name"] for r in rows if r["ifc_type"] == "IfcWall"] == [
        "WALL 1",
        "WALL 2",
        "WALL 3",
        "WALL 4",
    ]

    assert not any(r["ifc_type"].endswith("Type") for r in rows)
    assert all(not r["property_sets"] for r in rows)
