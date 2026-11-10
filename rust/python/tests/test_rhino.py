# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Rhino export contract: real IFC fixtures and archive read-back invariants."""
import json
import struct
import uuid
from pathlib import Path

import pytest
import ifclite_geom

REPO = Path(__file__).resolve().parents[3]
FIXTURES = REPO / "rust/geometry/tests/fixtures"


@pytest.mark.parametrize("fixture", ["mapped_instances_synthetic.ifc", "bath_csg_solid.ifc"])
def test_rhino_scene_wire_and_determinism(fixture):
    data = (FIXTURES / fixture).read_bytes()
    first = ifclite_geom.rhino_scene(data)
    assert set(first) == {"manifest", "blob"}
    assert isinstance(first["manifest"], str)
    assert isinstance(first["blob"], bytes)
    manifest = json.loads(first["manifest"])
    assert (manifest["format"], manifest["version"]) == ("ifc-lite.rhino-scene", 1)
    assert manifest["objects"] and first["blob"]
    assert first == ifclite_geom.rhino_scene(data)


@pytest.mark.parametrize("model", [
    # Which drifted default each model exposes; no small model exposes layer_slicing.
    FIXTURES / "mapped_instances_synthetic.ifc",  # coordinates, layer_scheme, instancing, normals, properties ("none")
    FIXTURES / "bath_csg_solid.ifc",  # units (millimetre source)
    REPO / "apps/viewer/public/samples/building-architecture-rev-b.ifc",  # units, include_spaces, properties ("attributes")
])
def test_rhino_documented_defaults_match_omitted_options(model):
    # The values below are the defaults the stub and README document; they must be
    # what Rust applies when an option is omitted.
    data = model.read_bytes()
    assert ifclite_geom.rhino_scene(
        data, units="source", coordinates="local", layer_scheme="spatial-class", instancing=True,
        properties="all", include_spaces=True, normals=True, layer_slicing=False,
    ) == ifclite_geom.rhino_scene(data)


def test_rhino_instance_xforms_are_row_major(writable_scene):
    # The wire format says `xform` is row-major. A column-major encoder would put the
    # translation in the bottom row, which a row-major affine transform keeps at (0, 0, 0, 1).
    xforms = [o["xform"] for o in json.loads(writable_scene["manifest"])["objects"] if o["kind"] == "instance"]
    assert xforms, "the fixture must produce block instances"
    assert all(x[12:] == [0, 0, 0, 1] for x in xforms)
    assert any(any(x[3:12:4]) for x in xforms), "some instance must be translated for the check to bite"


@pytest.mark.parametrize("key,values", [
    ("units", ["source", "meters", "millimeters", "centimeters", "feet", "inches"]),
    ("coordinates", ["local", "world"]),
    ("layer_scheme", ["spatial-class", "class", "presentation"]),
    ("properties", ["all", "attributes", "none"]),
])
def test_rhino_invalid_options_name_allowed_values(key, values):
    with pytest.raises(ValueError) as error:
        ifclite_geom.rhino_scene(b"", **{key: "bad"})
    assert key in str(error.value)
    assert all(value in str(error.value) for value in values)


def test_rhino_refuses_productless_model():
    with pytest.raises(ValueError, match="(?i)no.*render.*geometry"):
        ifclite_geom.rhino_scene(b"ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;ENDSEC;END-ISO-10303-21;")


def _layer_paths(manifest):
    paths = []
    for layer in manifest["layers"]:
        prefix = "" if layer["parent"] is None else paths[layer["parent"]] + "::"
        paths.append(prefix + layer["name"])
    return paths


@pytest.mark.parametrize("version", [7, 8])
@pytest.mark.parametrize("fixture,instancing", [
    ("mapped_instances_synthetic.ifc", True),
    ("mapped_instances_synthetic.ifc", False),
    ("issue_098_wall_V5C.ifc", False),
    ("mapped_instances_multi_item.ifc", True),
])
def test_rhino_round_trip(tmp_path, version, fixture, instancing):
    r = pytest.importorskip("rhino3dm")
    scene = ifclite_geom.rhino_scene((FIXTURES / fixture).read_bytes(), instancing=instancing)
    manifest = json.loads(scene["manifest"])
    path = tmp_path / "model.3dm"
    ifclite_geom.write_3dm(scene, path, version=version)
    doc = r.File3dm.Read(str(path))
    assert doc is not None
    assert [layer.FullPath for layer in doc.Layers] == _layer_paths(manifest)
    for obj in manifest["objects"]:
        actual = doc.Objects.FindId(uuid.UUID(obj["objectId"]))
        assert actual is not None
        assert str(actual.Attributes.Id) == obj["objectId"]
        assert actual.Attributes.GetUserString("IFC::GlobalId") == dict(obj["userStrings"])["IFC::GlobalId"]
        assert actual.Attributes.LayerIndex == obj["layer"]
        assert actual.Attributes.Name == obj["name"]
        assert actual.Attributes.ObjectColor == tuple(obj["color"])
        assert actual.Attributes.ColorSource == r.ObjectColorSource.ColorFromObject
        assert actual.Attributes.MaterialSource == r.ObjectMaterialSource.MaterialFromObject
        assert actual.Attributes.MaterialIndex == obj["material"]
        assert list(actual.Attributes.GetGroupList()) == obj["groups"]
        for key, value in obj["userStrings"]:
            assert actual.Attributes.GetUserString(key) == value
        if obj["kind"] == "instance":
            assert isinstance(actual.Geometry, r.InstanceReference)
            assert [getattr(actual.Geometry.Xform, f"M{i}{j}") for i in range(4) for j in range(4)] == obj["xform"]
    assert len(doc.InstanceDefinitions) == len(manifest["blocks"])
    for index, block in enumerate(manifest["blocks"]):
        definition = doc.InstanceDefinitions.FindIndex(index)
        for object_id in definition.GetObjectIds():
            attributes = doc.Objects.FindId(object_id).Attributes
            assert attributes.ColorSource == r.ObjectColorSource.ColorFromParent
            assert attributes.MaterialSource == r.ObjectMaterialSource.MaterialFromParent
    assert len(doc.Materials) == len(manifest["materials"])
    assert len(doc.Groups) == len(manifest["groups"])
    assert doc.Settings.ModelAbsoluteTolerance == manifest["settings"]["absoluteTolerance"]
    for key, value in manifest["documentStrings"]:
        assert doc.Strings[key] == value


def test_rhino_double_precision_round_trip(tmp_path):
    r = pytest.importorskip("rhino3dm")
    scene = ifclite_geom.rhino_scene((FIXTURES / "bath_csg_solid.ifc").read_bytes(), instancing=False)
    manifest = json.loads(scene["manifest"])
    mesh = manifest["meshes"][manifest["objects"][0]["mesh"]]
    blob = bytearray(scene["blob"])
    # Stated adapter invariant: a world-coordinate double must survive writing.
    # Inject at the wire boundary to isolate rhino3dm from the f32 geometry pipeline.
    expected = 2600000.123
    struct.pack_into("<d", blob, mesh["positions"]["offset"], expected)
    scene["blob"] = bytes(blob)
    path = tmp_path / "precise.3dm"
    ifclite_geom.write_3dm(scene, path)
    doc = r.File3dm.Read(str(path))
    obj = doc.Objects.FindId(uuid.UUID(manifest["objects"][0]["objectId"]))
    assert obj.Geometry.Vertices.Point3dAt(0).X == expected


def test_writer_rejects_unknown_contract_before_importing_optional_dependency(tmp_path):
    scene = {"manifest": json.dumps({"format": "other", "version": 1}), "blob": b""}
    with pytest.raises(ValueError, match="version must be 7 or 8"):
        ifclite_geom.write_3dm(scene, tmp_path / "bad.3dm", version=6)
    with pytest.raises(ValueError, match="ifc-lite.rhino-scene version 1"):
        ifclite_geom.write_3dm(scene, tmp_path / "bad.3dm")
    scene["manifest"] = json.dumps({"format": "ifc-lite.rhino-scene", "version": 2})
    with pytest.raises(ValueError, match="version 1"):
        ifclite_geom.write_3dm(scene, tmp_path / "bad.3dm")


@pytest.mark.parametrize("version", [7, 8])
def test_writer_preserves_earth_anchor(tmp_path, version):
    r = pytest.importorskip("rhino3dm")
    scene = ifclite_geom.rhino_scene((FIXTURES / "bath_csg_solid.ifc").read_bytes())
    manifest = json.loads(scene["manifest"])
    # Stated wire-adapter invariant, independent of IFC georeference resolution.
    anchor = {"latitude": 47.3, "longitude": 8.5, "elevation": 400.0,
              "modelBasePoint": [1.0, 2.0, 3.0], "modelNorth": [0.0, 1.0, 0.0],
              "modelEast": [1.0, 0.0, 0.0], "name": "Survey site"}
    manifest["settings"]["earthAnchor"] = anchor
    scene["manifest"] = json.dumps(manifest)
    path = tmp_path / "anchor.3dm"
    ifclite_geom.write_3dm(scene, path, version=version)
    actual = r.File3dm.Read(str(path)).Settings.EarthAnchorPoint
    assert actual.Name == anchor["name"]
    assert actual.EarthBasepointLatitude == anchor["latitude"]
    assert actual.EarthBasepointLongitude == anchor["longitude"]
    assert actual.EarthBasepointElevation == anchor["elevation"]
    assert [actual.ModelBasePoint.X, actual.ModelBasePoint.Y, actual.ModelBasePoint.Z] == anchor["modelBasePoint"]
    assert [actual.ModelNorth.X, actual.ModelNorth.Y, actual.ModelNorth.Z] == anchor["modelNorth"]
    assert [actual.ModelEast.X, actual.ModelEast.Y, actual.ModelEast.Z] == anchor["modelEast"]


@pytest.mark.parametrize("kind", ["layer", "material", "block"])
def test_writer_rejects_negative_table_index(kind):
    # Review regression: a rejected layer's -1 must never resolve its last sibling.
    from ifclite_geom.rhino import _add_table_entry

    class RejectedTable:
        def __init__(self):
            self.entries = []

        def __len__(self):
            return len(self.entries)

        def Add(self, entry):
            # Review finding 3: growth passes the length check; -1 must still fail.
            self.entries.append(entry)
            return -1

    with pytest.raises(ValueError, match=f"could not add {kind} 'Rejected entry'"):
        _add_table_entry(RejectedTable(), kind, "Rejected entry", object())


def test_writer_rejects_duplicate_group(tmp_path):
    # Review regression: GroupTable.Add returns None even when it rejects a duplicate.
    pytest.importorskip("rhino3dm")
    scene = ifclite_geom.rhino_scene((FIXTURES / "bath_csg_solid.ifc").read_bytes())
    manifest = json.loads(scene["manifest"])
    manifest["groups"] = [{"name": "Duplicate group"}, {"name": "Duplicate group"}]
    scene["manifest"] = json.dumps(manifest)
    with pytest.raises(ValueError, match="could not add group 'Duplicate group'"):
        ifclite_geom.write_3dm(scene, tmp_path / "rejected.3dm")
    assert not (tmp_path / "rejected.3dm").exists()


@pytest.mark.xfail(strict=True, reason=(
    "openNURBS 8.35 does not persist the earth anchor's elevation zero: on write the unset "
    "coordinate system overrides the legacy field on read "
    "(https://github.com/mcneel/opennurbs/blob/8.x/opennurbs_3dm_settings.cpp#L4088-L4091). "
    "The writer still sets MeanSeaLevel; this flips to a pass when upstream fixes it."))
def test_writer_elevation_zero_survives_round_trip(tmp_path):
    r = pytest.importorskip("rhino3dm")
    scene = ifclite_geom.rhino_scene((FIXTURES / "bath_csg_solid.ifc").read_bytes())
    manifest = json.loads(scene["manifest"])
    manifest["settings"]["earthAnchor"] = {"latitude": 47.3, "longitude": 8.5, "elevation": 400.0,
        "modelBasePoint": [0.0, 0.0, 0.0], "modelNorth": [0.0, 1.0, 0.0], "modelEast": [1.0, 0.0, 0.0], "name": "s"}
    scene["manifest"] = json.dumps(manifest)
    path = tmp_path / "zero.3dm"
    ifclite_geom.write_3dm(scene, path)
    assert r.File3dm.Read(str(path)).Settings.EarthAnchorPoint.EarthBasepointElevationZero == r.BasepointZero.MeanSeaLevel


@pytest.fixture
def writable_scene():
    return ifclite_geom.rhino_scene((FIXTURES / "mapped_instances_synthetic.ifc").read_bytes())


@pytest.mark.parametrize("field", [
    "layer.parent", "object.layer", "object.material", "object.groups",
    "object.mesh", "object.block", "block.layer", "block.meshes",
])
@pytest.mark.parametrize("value", [-1, 1000000, True, 0.5])
def test_writer_validates_references_before_import(tmp_path, monkeypatch, writable_scene, field, value):
    # Review regression: Python's negative indexing must not silently select a sibling.
    import sys
    manifest = json.loads(writable_scene["manifest"])
    table, key = field.split(".")
    item = manifest[{"layer": "layers", "object": "objects", "block": "blocks"}[table]][0]
    if key == "mesh":
        item["kind"] = "mesh"
    item[key] = [value] if key in ("groups", "meshes") else value
    writable_scene["manifest"] = json.dumps(manifest)
    monkeypatch.setitem(sys.modules, "rhino3dm", None)
    with pytest.raises(ValueError, match=key):
        ifclite_geom.write_3dm(writable_scene, tmp_path / "invalid.3dm")
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("section", ["positions", "normals", "indices"])
@pytest.mark.parametrize("change", ["negative_offset", "unaligned", "outside", "negative_count", "fractional_count", "incomplete_triple"])
def test_writer_validates_buffer_references(tmp_path, writable_scene, section, change):
    # Stated wire invariant: each section is aligned, complete and inside the blob.
    manifest = json.loads(writable_scene["manifest"])
    mesh = manifest["meshes"][0]
    if section == "normals":
        mesh[section] = {"offset": 0, "count": mesh["positions"]["count"]}
    ref = mesh[section]
    if change == "negative_offset":
        ref["offset"] = -8
    elif change == "unaligned":
        ref["offset"] = 1
    elif change == "outside":
        ref["offset"] = (len(writable_scene["blob"]) // 8 + 1) * 8
    else:
        ref["count"] = {"negative_count": -3, "fractional_count": 3.5, "incomplete_triple": 1}[change]
    writable_scene["manifest"] = json.dumps(manifest)
    with pytest.raises(ValueError, match=section):
        ifclite_geom.write_3dm(writable_scene, tmp_path / "invalid.3dm")
    assert not list(tmp_path.iterdir())


def test_writer_rejects_out_of_range_triangle(tmp_path, writable_scene):
    # Review regression: no triangle may refer beyond its mesh's vertex count.
    mesh = json.loads(writable_scene["manifest"])["meshes"][0]
    blob = bytearray(writable_scene["blob"])
    struct.pack_into("<I", blob, mesh["indices"]["offset"], mesh["positions"]["count"] // 3)
    writable_scene["blob"] = bytes(blob)
    with pytest.raises(ValueError, match="indices triangle vertex"):
        ifclite_geom.write_3dm(writable_scene, tmp_path / "invalid.3dm")


@pytest.mark.parametrize("xform", [[1.0] * 12, [1.0] * 17, [float("nan")] + [1.0] * 15, ["1"] * 16])
def test_writer_rejects_invalid_instance_xform(tmp_path, writable_scene, xform):
    # Review regression: an instance transform is exactly 16 finite numbers, as in the TS writer.
    manifest = json.loads(writable_scene["manifest"])
    instance = next(o for o in manifest["objects"] if o["kind"] == "instance")
    instance["xform"] = xform
    writable_scene["manifest"] = json.dumps(manifest)
    with pytest.raises(ValueError, match="xform"):
        ifclite_geom.write_3dm(writable_scene, tmp_path / "invalid.3dm")


def test_writer_rejects_non_finite_positions(tmp_path, writable_scene):
    mesh = json.loads(writable_scene["manifest"])["meshes"][0]
    blob = bytearray(writable_scene["blob"])
    struct.pack_into("<d", blob, mesh["positions"]["offset"], float("inf"))
    writable_scene["blob"] = bytes(blob)
    with pytest.raises(ValueError, match="positions must be finite"):
        ifclite_geom.write_3dm(writable_scene, tmp_path / "invalid.3dm")


def test_writer_rejects_unknown_unit_system(tmp_path, writable_scene):
    manifest = json.loads(writable_scene["manifest"])
    manifest["settings"]["unitSystem"] = "Furlongs"
    writable_scene["manifest"] = json.dumps(manifest)
    with pytest.raises(ValueError, match="unitSystem"):
        ifclite_geom.write_3dm(writable_scene, tmp_path / "invalid.3dm")


@pytest.mark.parametrize("existing", [None, 0o640])
def test_writer_output_mode_matches_plain_open(tmp_path, writable_scene, existing):
    # Review regression: the temp file is 0600; the result must not be.
    pytest.importorskip("rhino3dm")
    import os
    target = tmp_path / "model.3dm"
    if existing is not None:
        target.write_bytes(b"previous archive")
        os.chmod(target, existing)
    previous = os.umask(0o022)
    try:
        ifclite_geom.write_3dm(writable_scene, target)
    finally:
        os.umask(previous)
    assert target.stat().st_mode & 0o777 == (existing if existing is not None else 0o644)


def test_writer_rejects_mismatched_normals(tmp_path, writable_scene):
    # Review regression: normals must contain exactly one triple per vertex.
    manifest = json.loads(writable_scene["manifest"])
    manifest["meshes"][0]["normals"] = {"offset": 0, "count": 0}
    writable_scene["manifest"] = json.dumps(manifest)
    with pytest.raises(ValueError, match="normals count must match positions"):
        ifclite_geom.write_3dm(writable_scene, tmp_path / "invalid.3dm")


@pytest.mark.parametrize("raises", [False, True])
@pytest.mark.parametrize("existing", [False, True])
def test_writer_partial_failure_is_atomic(tmp_path, monkeypatch, writable_scene, raises, existing):
    # Review regression: a partially written archive must never replace the target.
    r = pytest.importorskip("rhino3dm")
    target = tmp_path / "model.3dm"
    if existing:
        target.write_bytes(b"previous archive")

    def partial_write(doc, path, version):
        assert Path(path).parent == tmp_path
        assert Path(path) != target
        Path(path).write_bytes(b"partial archive")
        if raises:
            raise OSError("simulated write failure")
        return False

    monkeypatch.setattr(r.File3dm, "Write", partial_write)
    with pytest.raises(OSError, match="write"):
        ifclite_geom.write_3dm(writable_scene, target)
    if existing:
        assert target.read_bytes() == b"previous archive"
        assert list(tmp_path.iterdir()) == [target]
    else:
        assert not target.exists()
        assert not list(tmp_path.iterdir())
