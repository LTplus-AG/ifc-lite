# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Smoke tests for the ifclite_geom wheel, run against the installed artifact.

These run in `python-wheels.yml` after the Linux x86_64 wheel is built, so they
exercise the same binary that ships to PyPI rather than a local cargo build.
"""

import json
import math
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
# One wall cut by seven IfcOpeningElements. Filtering to the wall alone must
# retain those dependency entities for CSG even though they are not output.
OPENING_HOST = REPO / "rust/geometry/tests/fixtures/issue_098_wall_W.ifc"
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


def test_swept_disk_directrix_is_opt_in_and_analytic():
    ifc = read(REBAR)
    plain = ifclite_geom.geometry_data_buffers(ifc)
    assert "swept_disks" not in plain
    assert "directrix_diagnostics" not in plain

    with_curves = ifclite_geom.geometry_data_buffers(ifc, include_directrices=True)
    assert with_curves["elements"] == plain["elements"]
    assert set(with_curves["swept_disks"]) == {125}
    (sweep,) = with_curves["swept_disks"][125]
    assert sweep["solid_id"] == 72
    assert sweep["directrix_id"] == 71
    assert sweep["Radius"] == pytest.approx(0.0145)
    assert sweep["InnerRadius"] is None
    assert sweep["status"] == {"type": "complete"}
    assert sweep["source_modified"] is False
    assert [piece["type"] for piece in sweep["Directrix"]] == [
        "line", "arc", "line", "arc", "line"
    ]
    arc_radii = [piece["radius"] for piece in sweep["Directrix"] if piece["type"] == "arc"]
    assert arc_radii == pytest.approx([0.1015, 0.1015])
    assert with_curves["directrix_diagnostics"] == []

    document = json.loads(ifclite_geom.geometry_data_json(ifc, include_directrices=True))
    assert document["swept_disks"]["125"] == with_curves["swept_disks"][125]
    assert document["directrix_diagnostics"] == with_curves["directrix_diagnostics"]


def test_issue_5754_rebar_directrix_metrics_use_world_metres_and_radians():
    (sweep,) = ifclite_geom.geometry_data_buffers(
        read(REBAR), include_directrices=True
    )["swept_disks"][125]
    metrics = sweep["directrix_metrics"]
    assert metrics is not None
    # The millimetre fixture authors 322, 245.685..., and 250 mm straight
    # runs, with two 101.5 mm radius quarter-circle bends.
    straight_lengths = [0.322, 0.245685133619932, 0.250]
    quarter_arc_length = 0.1015 * math.pi / 2
    assert [part["segment_index"] for part in metrics["segments"]] == list(range(5))
    assert [part["length"] for part in metrics["segments"]] == pytest.approx(
        [straight_lengths[0], quarter_arc_length, straight_lengths[1],
         quarter_arc_length, straight_lengths[2]]
    )
    assert [part["bend_angle"] for part in metrics["segments"][::2]] == [None] * 3
    assert [part["bend_angle"] for part in metrics["segments"][1::2]] == pytest.approx(
        [math.pi / 2, math.pi / 2]
    )
    assert metrics["total_length"] == pytest.approx(
        sum(straight_lengths) + 2 * quarter_arc_length
    )


def test_swept_disk_directrix_respects_id_filter():
    ifc = read(REBAR)
    empty = ifclite_geom.geometry_data_buffers(ifc, ids=set(), include_directrices=True)
    assert empty["swept_disks"] == {}
    assert empty["elements"] == {}
    unknown = ifclite_geom.geometry_data_buffers(ifc, ids={999_999}, include_directrices=True)
    assert unknown["swept_disks"] == {}


def test_issue_4803_id_filter_none_empty_subset_and_unknown():
    ifc = read(WALLS)
    full = ifclite_geom.geometry_data_buffers(ifc)
    ids = sorted(full["elements"])
    assert len(ids) == 4, "fixture must contain multiple meshes to exercise a subset"

    # Explicit None is the backward-compatible unfiltered path.
    assert ifclite_geom.geometry_data_buffers(ifc, ids=None) == full

    # An empty set is an active filter, not another spelling of no filter.
    empty = ifclite_geom.geometry_data_buffers(ifc, ids=set())
    assert empty["element_count"] == 0
    assert empty["elements"] == {}

    subset_ids = {ids[0], ids[-1]}
    subset = ifclite_geom.geometry_data_buffers(ifc, ids=subset_ids)
    assert set(subset["elements"]) == subset_ids
    assert subset["element_count"] == len(subset_ids)
    assert subset["elements"] == {step_id: full["elements"][step_id] for step_id in subset_ids}

    unknown = max(ids) + 1
    assert ifclite_geom.geometry_data_buffers(ifc, ids={unknown})["elements"] == {}
    mixed = ifclite_geom.geometry_data_buffers(ifc, ids={ids[0], unknown})
    assert set(mixed["elements"]) == {ids[0]}


def test_issue_4803_buffers_and_json_filters_are_geometry_identical():
    ifc = read(WALLS)
    all_ids = sorted(ifclite_geom.geometry_data_buffers(ifc)["elements"])
    selected = {all_ids[1], all_ids[2]}

    buffers = ifclite_geom.geometry_data_buffers(ifc, "low", selected)
    document = json.loads(ifclite_geom.geometry_data_json(ifc, "low", selected))

    assert set(buffers["elements"]) == selected
    assert set(document["elements"]) == {str(step_id) for step_id in selected}
    assert buffers["element_count"] == document["element_count"] == len(selected)
    assert buffers["rtc_offset"] == document["rtc_offset"]

    for step_id, buffered in buffers["elements"].items():
        encoded = document["elements"][str(step_id)]
        vertex_values = struct.unpack(
            f"<{len(buffered['vertices']) // 8}d", buffered["vertices"]
        )
        face_values = struct.unpack(
            f"<{len(buffered['faces']) // 4}I", buffered["faces"]
        )
        vertices = [list(vertex_values[i:i + 3]) for i in range(0, len(vertex_values), 3)]
        faces = [list(face_values[i:i + 3]) for i in range(0, len(face_values), 3)]

        assert encoded["vertices"] == vertices
        assert encoded["faces"] == faces
        assert encoded["ifc_type"] == buffered["ifc_type"]
        assert encoded.get("global_id") == buffered["global_id"]
        assert encoded.get("name") == buffered["name"]
        # JSON prints the shortest decimal that round-trips to the source f32,
        # while PyO3 widens the same f32 to a Python float.
        assert encoded["color"] == pytest.approx(buffered["color"])


def test_issue_4803_filtered_host_keeps_unselected_opening_dependencies():
    ifc = read(OPENING_HOST)
    host_id = 928204
    full = ifclite_geom.geometry_data_buffers(ifc)
    assert host_id in full["elements"], "fixture wall must produce geometry"

    selected = ifclite_geom.geometry_data_buffers(ifc, ids={host_id})
    assert set(selected["elements"]) == {host_id}
    # Exact equality proves the seven unselected opening cutters still reached
    # the selected wall's CSG path; filtering dependencies would change its mesh.
    assert selected["elements"][host_id] == full["elements"][host_id]


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

    # Schema order is part of the contract, so assert the list, not a dict:
    # a dict comparison would pass with the order reversed.
    assert [(a["name"], a["value"], a["value_type"]) for a in bar["attributes"]] == [
        ("NominalDiameter", "29", "IFCREAL"),
        ("CrossSectionArea", "0", "IFCREAL"),
        # An enumeration, NOT a boolean: a consumer keying off value_type would
        # otherwise try to parse NOTDEFINED as true/false.
        ("BarRole", "NOTDEFINED", "IFCENUM"),
    ]

    # Not duplicated from the row's own fields.
    names = [a["name"] for a in bar["attributes"]]
    assert "GlobalId" not in names and "Name" not in names
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


def test_the_occurrence_wins_a_collision_on_the_corpus_fixture():
    """Collision precedence through the wheel, on the buildingSMART file.

    Its type defines only Foo (as 'Baz') and the occurrence redefines it, so
    this pins precedence but cannot show a type-only property surviving. The
    test below does that on a fixture built for it.
    """
    ifc = read(OVERRIDE)
    for kwargs in ({"type_properties": False}, {}):
        entities = ifclite_geom.entity_data(ifc, **kwargs)["entities"]
        values = {
            (ps["name"], p["name"]): p["value"]
            for r in entities.values()
            for ps in r["property_sets"]
            for p in ps["properties"]
        }
        assert values[("Foo_Bar", "Foo")] == "Bar", kwargs

        for r in entities.values():
            names = [ps["name"] for ps in r["property_sets"]]
            assert len(names) == len(set(names)), f"duplicated sets: {names}"


# A collision AND a type-only property in one set, which no corpus fixture has.
# The occurrence must win 'Shared' while still gaining 'TypeOnly'; replacing the
# whole set instead would silently drop the latter.
COLLIDING_IFC = b"""ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#2=IFCUNITASSIGNMENT((#1));
#3=IFCPROJECT('0PROJECT00000000000000',$,'P',$,$,$,$,$,#2);
#5=IFCWALL('0WALL0000000000000000',$,'W',$,$,$,$,$,$);
#10=IFCPROPERTYSINGLEVALUE('Shared',$,IFCLABEL('from-type'),$);
#11=IFCPROPERTYSINGLEVALUE('TypeOnly',$,IFCLABEL('kept'),$);
#12=IFCPROPERTYSET('0TYPEPSET000000000000',$,'Pset_WallCommon',$,(#10,#11));
#13=IFCWALLTYPE('0WALLTYPE00000000000',$,'WT',$,$,(#12),$,$,$,.NOTDEFINED.);
#14=IFCRELDEFINESBYTYPE('0TYPEREL000000000000',$,$,$,(#5),#13);
#20=IFCPROPERTYSINGLEVALUE('Shared',$,IFCLABEL('from-occurrence'),$);
#21=IFCPROPERTYSET('0OWNPSET0000000000000',$,'Pset_WallCommon',$,(#20));
#22=IFCRELDEFINESBYPROPERTIES('0OWNREL0000000000000',$,$,$,(#5),#21);
ENDSEC;
END-ISO-10303-21;
"""


def test_a_type_only_property_survives_a_set_name_collision():
    def values(**kwargs):
        entities = ifclite_geom.entity_data(COLLIDING_IFC, **kwargs)["entities"]
        return {
            p["name"]: p["value"]
            for r in entities.values()
            for ps in r["property_sets"]
            for p in ps["properties"]
        }

    own_only = values(type_properties=False)
    merged = values()

    assert own_only == {"Shared": "from-occurrence"}
    # The occurrence still wins Shared, AND the type-only property arrives.
    assert merged == {"Shared": "from-occurrence", "TypeOnly": "kept"}
    assert set(merged) > set(own_only)
