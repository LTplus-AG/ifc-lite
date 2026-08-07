# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Smoke tests for the ifclite_geom wheel, run against the installed artifact.

These run in `python-wheels.yml` after the Linux x86_64 wheel is built, so they
exercise the same binary that ships to PyPI rather than a local cargo build.
"""

import json
import struct
from pathlib import Path

import pytest

# A hard import, deliberately not `pytest.importorskip`: if the wheel failed to
# install, these tests must fail rather than skip into a green run.
import ifclite_geom

# Fixtures are resolved from this file, not the working directory, so the suite
# runs the same from the repo root, from rust/python, or from anywhere else.
REPO = Path(__file__).resolve().parents[3]

# A single reinforcing-style bar: IfcSweptDiskSolid over a composite arc, i.e.
# the curve-heavy shape the quality knob exists for.
REBAR = REPO / "rust/geometry/tests/fixtures/swept_disk_composite_arc_ubar.ifc"
# 4 walls with geometry, placements, and psets attached to their IfcWallType.
WALLS = REPO / (
    "packages/ids/src/__corpus__/buildingsmart-ids/property/"
    "fail-properties_can_be_associated_to_relevant_object_types.ifc"
)
# One IfcWall carrying an occurrence-level pset via IfcRelDefinesByProperties.
OCCURRENCE_PSET = REPO / (
    "packages/ids/src/__corpus__/buildingsmart-ids/property/"
    "pass-all_matching_properties_must_satisfy_requirements_1_3.ifc"
)
# Georeferenced: rtc_offset is ~[1508050, 5039449, 0], so any frame mismatch
# between placements and vertices shows up as a ~1.5e6 metre separation.
GEOREFERENCED = REPO / "rust/geometry/tests/fixtures/issue_098_wall_V5C.ifc"
# Millimetre file whose IfcWall carries Qto-style IfcQuantityLength 'Foo' = 42.
# The only fixture here with a quantity set, so without it the whole
# quantity_sets branch is unexercised.
QUANTITIES = REPO / (
    "packages/ids/src/__corpus__/buildingsmart-ids/property/"
    "pass-a_name_check_will_match_any_quantity_with_any_value.ifc"
)
# Occurrence AND its type both carry a 'Foo_Bar' set defining 'Foo', so the
# per-property collision rule is observable: occurrence 'Bar' beats type 'Baz'.
OVERRIDE = REPO / (
    "packages/ids/src/__corpus__/buildingsmart-ids/property/"
    "pass-properties_can_be_overriden_by_an_occurrence_1_2.ifc"
)

QUALITIES = ["lowest", "low", "medium", "high", "highest"]


def read(path):
    # Fail loudly if a fixture moves, rather than erroring somewhere downstream.
    assert path.is_file(), f"missing fixture: {path}"
    return path.read_bytes()


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


def test_entity_data_reads_quantity_sets_in_file_units():
    data = ifclite_geom.entity_data(read(QUANTITIES))

    # A millimetre file, so the raw value must NOT be converted to metres.
    assert data["length_unit_scale"] == pytest.approx(0.001)

    rows = [r for r in data["entities"].values() if r["quantity_sets"]]
    assert rows, "expected at least one entity with a quantity set"

    qset = rows[0]["quantity_sets"][0]
    assert qset["name"] == "Foo_Bar"
    assert qset["quantities"] == [{"name": "Foo", "value": 42.0, "kind": "Length"}]
    # Pins the documented reconciliation: 42 mm is 0.042 m, not 42 m.
    assert qset["quantities"][0]["value"] * data["length_unit_scale"] == pytest.approx(0.042)


def test_entity_count_matches_the_entities_it_returns():
    for path in (WALLS, QUANTITIES, GEOREFERENCED):
        data = ifclite_geom.entity_data(read(path))
        assert data["entity_count"] == len(data["entities"]), path.name


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

    # Assert VALUES, not just the shape: an implementation returning identity
    # for everything would satisfy a length check. Column-major means the
    # translation is at 12/13/14 and indices 3/7/11 are the bottom row.
    walls = {r["name"]: r["placement"] for r in with_["entities"].values()
             if r["ifc_type"] == "IfcWall"}
    assert sorted(walls) == ["WALL 1", "WALL 2", "WALL 3", "WALL 4"]
    for name, m in walls.items():
        assert (m[3], m[7], m[11]) == (0.0, 0.0, 0.0), f"{name} is not column-major"
        assert m[15] == 1.0
    # The four walls step along +Y. The file is millimetres (1000, 2000, 3000),
    # so these values also pin the documented metre conversion on placements,
    # which is the opposite of the raw file units used for property values.
    assert without["length_unit_scale"] == pytest.approx(0.001)
    assert sorted(round(m[13], 6) for m in walls.values()) == [0.0, 1.0, 2.0, 3.0]
    assert all(m[12] == 0.0 and m[14] == 0.0 for m in walls.values())

    # Resolving placements must not change anything else about the rows.
    assert [r["property_sets"] for r in without["entities"].values()] == [
        r["property_sets"] for r in with_["entities"].values()
    ]


def test_placements_share_the_frame_of_the_geometry_vertices():
    """Pins the coordinate contract on a georeferenced model.

    Both exports are absolute IFC world metres: the geometry export adds
    `rtc_offset` back into every vertex, and placements are never RTC-rebased.
    A caller must NOT fold the offset into either. If that ever inverts, a
    product's placement origin lands ~1.5e6 metres from its own mesh.
    """
    ifc = read(GEOREFERENCED)
    geom = ifclite_geom.geometry_data_buffers(ifc)
    ents = ifclite_geom.entity_data(ifc, placements=True)

    rtc = geom["rtc_offset"]
    rtc_magnitude = sum(c * c for c in rtc) ** 0.5
    # Guard the premise: a fixture that lost its georeferencing would make
    # every assertion below pass trivially.
    assert rtc_magnitude > 1e6, f"fixture is no longer georeferenced: {rtc}"

    pairs = [
        (k, geom["elements"][k], ents["entities"][k])
        for k in geom["elements"]
        if ents["entities"].get(k, {}).get("placement")
    ]
    assert pairs, "expected products with both a mesh and a placement"

    for step_id, el, row in pairs:
        n = len(el["vertices"]) // 8
        v = struct.unpack(f"<{n}d", el["vertices"])
        axes = (v[0::3], v[1::3], v[2::3])
        t = row["placement"][12:15]

        # Same frame: the placement origin sits within its own mesh bounds,
        # widened by the mesh's own size to tolerate off-centre origins.
        for axis, lo_hi, origin in zip("xyz", axes, t):
            lo, hi = min(lo_hi), max(lo_hi)
            slack = max(hi - lo, 1.0)
            assert lo - slack <= origin <= hi + slack, (
                f"#{step_id} {axis}: placement {origin} outside mesh "
                f"[{lo}, {hi}] widened by {slack}; frames disagree"
            )

        # And specifically NOT offset by rtc, which is the failure this guards.
        shifted = [origin - c for origin, c in zip(t, rtc)]
        drift = sum(
            (s - (min(a) + max(a)) / 2) ** 2 for s, a in zip(shifted, axes)
        ) ** 0.5
        assert drift > 1e5, (
            f"#{step_id}: placement matches the mesh only after subtracting "
            "rtc_offset, so the two exports are in different frames"
        )


def test_type_held_properties_reach_the_occurrences_that_inherit_them():
    """The gap this replaces: these psets used to be unreachable entirely.

    All four walls carry their Pset_WallCommon on their IfcWallType, and a type
    with no geometry gets no row of its own, so before inheritance landed there
    was no way to read them. WALL 1's type is the control: it declares
    HasPropertySets as $, so it must still come back empty.
    """
    rows = list(ifclite_geom.entity_data(read(WALLS))["entities"].values())
    walls = {r["name"]: r for r in rows if r["ifc_type"] == "IfcWall"}
    assert sorted(walls) == ["WALL 1", "WALL 2", "WALL 3", "WALL 4"]

    # Still no type row: inheritance is a merge into occurrences, not a new row.
    assert not any(r["ifc_type"].endswith("Type") for r in rows)

    def fire_rating(name):
        sets = walls[name]["property_sets"]
        return next(
            (p["value"] for ps in sets for p in ps["properties"]
             if ps["name"] == "Pset_WallCommon" and p["name"] == "FireRating"),
            None,
        )

    assert fire_rating("WALL 2") == "-/-/-"
    assert fire_rating("WALL 3") == "120/120/120"
    assert fire_rating("WALL 4") == "FOOBAR"
    assert fire_rating("WALL 1") is None, "its type declares no property sets"


def test_type_specific_attributes_are_returned():
    """The rebar case: these are attributes, not property sets.

    REBAR's IfcReinforcingBar carries NominalDiameter in the file. No pset
    setting surfaces it, which is exactly why `attributes` exists.
    """
    data = ifclite_geom.entity_data(read(REBAR))
    bar = next(
        r for r in data["entities"].values() if r["ifc_type"] == "IfcReinforcingBar"
    )
    attrs = {a["name"]: a["value"] for a in bar["attributes"]}

    assert attrs["NominalDiameter"] == "29"
    assert "PredefinedType" in attrs
    # Not duplicated from the row's own fields.
    assert "GlobalId" not in attrs and "Name" not in attrs
    assert bar["name"] == "U-bar"
    # And genuinely not reachable as a property, however psets are configured.
    assert not bar["property_sets"]


def test_attributes_can_be_turned_off():
    data = ifclite_geom.entity_data(read(REBAR), attributes=False)
    assert all(not r["attributes"] for r in data["entities"].values())


def test_type_properties_can_be_turned_off():
    """`type_properties=False` reproduces 4.3.0's own-sets-only behaviour."""
    rows = ifclite_geom.entity_data(read(WALLS), type_properties=False)["entities"]
    assert all(not r["property_sets"] for r in rows.values())


def test_the_occurrence_wins_a_collision_and_type_only_props_survive():
    """Per property, not per set: the #1913 rule, end to end through the wheel."""
    ifc = read(OVERRIDE)
    own_only = ifclite_geom.entity_data(ifc, type_properties=False)["entities"]
    merged = ifclite_geom.entity_data(ifc)["entities"]

    def props(entities):
        return {
            (ps["name"], p["name"]): p["value"]
            for r in entities.values()
            for ps in r["property_sets"]
            for p in ps["properties"]
        }

    # The occurrence defines Foo itself, so the type's value must not win.
    assert props(own_only)[("Foo_Bar", "Foo")] == "Bar"
    assert props(merged)[("Foo_Bar", "Foo")] == "Bar"

    # And the merge must not duplicate the same-named set.
    for r in merged.values():
        names = [ps["name"] for ps in r["property_sets"]]
        assert len(names) == len(set(names)), f"duplicated sets: {names}"
