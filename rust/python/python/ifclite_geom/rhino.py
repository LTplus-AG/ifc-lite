# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Translate the version-1 Rhino scene wire format using rhino3dm 8.35.0."""
import json
import math
import os
import struct
import sys
import tempfile
import uuid
from array import array

_UNIT_SYSTEMS = ("Millimeters", "Centimeters", "Meters", "Feet", "Inches")


def _add_table_entry(table, kind, name, *args):
    """Check indexed adds and the void-returning File3dmGroupTable.Add."""
    count = len(table)
    index = table.Add(*args)
    if len(table) != count + 1 or (index is not None and index < 0):
        raise ValueError(f"could not add {kind} {name!r}")
    return count if index is None else index


def _section(blob, section, code):
    """Unpack a section that _validate_manifest already bounds-checked."""
    offset, count = section["offset"], section["count"]
    return memoryview(blob)[offset:offset + count * struct.calcsize("<" + code)]


def _triples(blob, section, code):
    return struct.iter_unpack("<3" + code, _section(blob, section, code))


def _values(blob, section, code):
    """A section as a compact array (C-level copy, not one Python object per value)."""
    values = array(code)
    values.frombytes(_section(blob, section, code))
    if sys.byteorder != "little":
        values.byteswap()
    return values


def _finite(values):
    # Per value: a sum of large finite values can overflow to inf.
    return all(map(math.isfinite, values))


def _validate_manifest(manifest, blob):
    """Reject invalid table and binary references before loading rhino3dm."""
    def index(value, length, field):
        if type(value) is not int or not 0 <= value < length:
            raise ValueError(f"{field} index out of range")

    def buffer(section, width, field):
        offset, count = section["offset"], section["count"]
        if type(offset) is not int or offset < 0 or offset % width:
            raise ValueError(f"{field}.offset must be non-negative and aligned to {width}")
        if type(count) is not int or count < 0 or count % 3:
            raise ValueError(f"{field}.count must be a non-negative multiple of three")
        if offset + count * width > len(blob):
            raise ValueError(f"{field} buffer is outside the blob")
        return count

    if manifest["settings"]["unitSystem"] not in _UNIT_SYSTEMS:
        raise ValueError(f"settings.unitSystem must be one of {', '.join(_UNIT_SYSTEMS)}")
    for i, layer in enumerate(manifest["layers"]):
        if layer["parent"] is not None:
            index(layer["parent"], i, f"layers[{i}].parent (must precede child)")
    for i, mesh in enumerate(manifest["meshes"]):
        field = f"meshes[{i}]"
        count = buffer(mesh["positions"], 8, f"{field}.positions")
        if not _finite(_values(blob, mesh["positions"], "d")):
            raise ValueError(f"{field}.positions must be finite")
        buffer(mesh["indices"], 4, f"{field}.indices")
        if mesh["normals"] is not None:
            normals = buffer(mesh["normals"], 4, f"{field}.normals")
            if normals != count:
                raise ValueError(f"{field}.normals count must match positions")
            if not _finite(_values(blob, mesh["normals"], "f")):
                raise ValueError(f"{field}.normals must be finite")
        # One C-level max instead of a Python call per vertex index.
        indices = _values(blob, mesh["indices"], "I")
        if indices and max(indices) >= count // 3:
            raise ValueError(f"{field}.indices triangle vertex index out of range")
    for i, block in enumerate(manifest["blocks"]):
        index(block["layer"], len(manifest["layers"]), f"blocks[{i}].layer")
        for mesh in block["meshes"]:
            index(mesh, len(manifest["meshes"]), f"blocks[{i}].meshes")
    for i, obj in enumerate(manifest["objects"]):
        field = f"objects[{i}]"
        for key, table in (("layer", "layers"), ("material", "materials")):
            index(obj[key], len(manifest[table]), f"{field}.{key}")
        for group in obj["groups"]:
            index(group, len(manifest["groups"]), f"{field}.groups")
        if obj["kind"] == "mesh":
            index(obj["mesh"], len(manifest["meshes"]), f"{field}.mesh")
        elif obj["kind"] == "instance":
            index(obj["block"], len(manifest["blocks"]), f"{field}.block")
            xform = obj["xform"]
            if (not isinstance(xform, list) or len(xform) != 16
                    or not all(type(v) in (int, float) and math.isfinite(v) for v in xform)):
                raise ValueError(f"{field}.xform must be 16 finite numbers")
        else:
            raise ValueError(f"{field}.kind: unknown geometry kind {obj['kind']!r}")


def _output_mode(target):
    """Keep an existing target's permissions, else 0666 minus the umask."""
    try:
        return os.stat(target).st_mode & 0o7777
    except FileNotFoundError:
        umask = os.umask(0)
        os.umask(umask)
        return 0o666 & ~umask


def write_3dm(scene, path, *, version=8):
    """Write manifest/blob to a .3dm path (version 7 or 8).

    Requires ``pip install 'ifclite-geom[3dm]'``. Scene warnings remain in the
    manifest for callers to present. Object ids and IFC user text are preserved.
    Raises ValueError for unsupported formats/versions and OSError on write failure.
    """
    if version not in (7, 8):
        raise ValueError("3dm version must be 7 or 8")
    manifest = json.loads(scene["manifest"])
    if manifest.get("format") != "ifc-lite.rhino-scene" or manifest.get("version") != 1:
        raise ValueError("expected ifc-lite.rhino-scene version 1")
    _validate_manifest(manifest, scene["blob"])
    import rhino3dm as r

    doc = r.File3dm()
    settings = manifest["settings"]
    doc.Settings.ModelUnitSystem = getattr(r.UnitSystem, settings["unitSystem"])
    doc.Settings.ModelAbsoluteTolerance = settings["absoluteTolerance"]
    doc.Settings.ModelAngleToleranceDegrees = settings["angleToleranceDegrees"]
    anchor = settings.get("earthAnchor")
    if anchor is not None:
        earth = doc.Settings.EarthAnchorPoint
        earth.EarthBasepointLatitude = anchor["latitude"]
        earth.EarthBasepointLongitude = anchor["longitude"]
        earth.EarthBasepointElevation = anchor["elevation"]
        earth.EarthBasepointElevationZero = r.BasepointZero.MeanSeaLevel
        earth.ModelBasePoint = r.Point3d(*anchor["modelBasePoint"])
        earth.ModelNorth = r.Vector3d(*anchor["modelNorth"])
        earth.ModelEast = r.Vector3d(*anchor["modelEast"])
        earth.Name = anchor["name"]
        doc.Settings.EarthAnchorPoint = earth
    for key, value in manifest["documentStrings"]:
        doc.Strings[key] = value
    layers = []
    for item in manifest["layers"]:
        layer = r.Layer()
        layer.Name, layer.Color = item["name"], tuple(item["color"])
        layer.Visible, layer.Locked = item["visible"], item["locked"]
        if item["parent"] is not None:
            layer.ParentLayerId = doc.Layers[layers[item["parent"]]].Id
        layers.append(_add_table_entry(doc.Layers, "layer", item["name"], layer))
    materials = []
    for item in manifest["materials"]:
        material = r.Material()
        material.Name = item["name"]
        material.DiffuseColor = (*item["diffuse"], 255)
        material.Transparency = item["transparency"]
        materials.append(_add_table_entry(doc.Materials, "material", item["name"], material))
    groups = []
    for item in manifest["groups"]:
        group = r.Group()
        group.Name = item["name"]
        index = _add_table_entry(doc.Groups, "group", item["name"], group)
        groups.append(doc.Groups[index].Index)
    def build_mesh(index):
        item = manifest["meshes"][index]
        mesh = r.Mesh()
        mesh.Vertices.UseDoublePrecisionVertices = True
        for xyz in _triples(scene["blob"], item["positions"], "d"):
            mesh.Vertices.AddPoint3d(*xyz)
        for abc in _triples(scene["blob"], item["indices"], "I"):
            mesh.Faces.AddFace(*abc)
        if item["normals"] is not None:
            for xyz in _triples(scene["blob"], item["normals"], "f"):
                mesh.Normals.Add(*xyz)
        return mesh

    blocks = []
    for item in manifest["blocks"]:
        geometry = tuple(build_mesh(i) for i in item["meshes"])
        attributes = tuple(r.ObjectAttributes() for _ in geometry)
        for attr in attributes:
            attr.LayerIndex = layers[item["layer"]]
            attr.ColorSource = r.ObjectColorSource.ColorFromParent
            attr.MaterialSource = r.ObjectMaterialSource.MaterialFromParent
        index = _add_table_entry(
            doc.InstanceDefinitions, "block", item["name"],
            item["name"], item["description"], "", "", r.Point3d(0, 0, 0),
            geometry, attributes,
        )
        blocks.append(doc.InstanceDefinitions.FindIndex(index).Id)
        del geometry, attributes
    for item in manifest["objects"]:
        attr = r.ObjectAttributes()
        attr.Id = uuid.UUID(item["objectId"])
        attr.Name, attr.LayerIndex = item["name"], layers[item["layer"]]
        attr.ObjectColor = tuple(item["color"])
        attr.ColorSource = r.ObjectColorSource.ColorFromObject
        attr.MaterialIndex = materials[item["material"]]
        attr.MaterialSource = r.ObjectMaterialSource.MaterialFromObject
        for index in item["groups"]:
            attr.AddToGroup(groups[index])
        for key, value in item["userStrings"]:
            attr.SetUserString(key, value)
        if item["kind"] == "mesh":
            object_id = doc.Objects.AddMesh(build_mesh(item["mesh"]), attr)
        else:  # "instance"; _validate_manifest rejected any other kind
            xform = r.Transform(1.0)
            for i, value in enumerate(item["xform"]):
                setattr(xform, f"M{i // 4}{i % 4}", value)
            instance = r.InstanceReference(blocks[item["block"]], xform)
            object_id = doc.Objects.AddInstanceObject(instance, attr)
        if object_id.int == 0:
            raise ValueError("could not add scene object")
    target = os.path.abspath(os.fsdecode(path))
    # Close before Write so rhino3dm can open the file on Windows too.
    with tempfile.NamedTemporaryFile(dir=os.path.dirname(target), suffix=".3dm", delete=False) as temp:
        temporary = temp.name
    try:
        if not doc.Write(temporary, version):
            raise OSError(f"could not write 3dm: {path}")
        # mkstemp creates the file 0600; give it the mode a plain open() would.
        os.chmod(temporary, _output_mode(target))
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
