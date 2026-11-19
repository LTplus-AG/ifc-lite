# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""#9357: inspect exported geometry and measurements with an independent engine."""
import json
import math
import sys
import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.shape
import ifcopenshell.util.unit
import ifcopenshell.validate

model = ifcopenshell.file.from_string(sys.stdin.read())
logger = ifcopenshell.validate.json_logger()
ifcopenshell.validate.validate(model, logger, express_rules=True)
assert not logger.statements, json.dumps(logger.statements, default=str)
settings = ifcopenshell.geom.settings()
settings.set(settings.USE_WORLD_COORDS, True)
roof, = model.by_type('IfcRoof')
parts = [part for rel in roof.IsDecomposedBy if rel.is_a('IfcRelAggregates') for part in rel.RelatedObjects]
assert parts, 'No aggregated roof planes'
assert roof.Representation is None, 'Roof geometry belongs exclusively to its aggregated slab planes'
volume_scale = ifcopenshell.util.unit.calculate_unit_scale(model, 'VOLUMEUNIT')
angle_scale = ifcopenshell.util.unit.calculate_unit_scale(model, 'PLANEANGLEUNIT')
volumes = []
measured = []
bounds = []
areas = []
for part in parts:
    assert part.is_a('IfcSlab') and part.PredefinedType == 'ROOF'
    assert part.Representation is not None
    assert part.ObjectPlacement.PlacementRelTo == roof.ObjectPlacement
    shape = ifcopenshell.geom.create_shape(settings, part)
    vertices = [shape.geometry.verts[i:i + 3] for i in range(0, len(shape.geometry.verts), 3)]
    bounds.extend(vertices)
    upward = 0
    for i in range(0, len(shape.geometry.faces), 3):
        a, b, c = [vertices[j] for j in shape.geometry.faces[i:i + 3]]
        u, v = [b[k] - a[k] for k in range(3)], [c[k] - a[k] for k in range(3)]
        normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
        length = math.sqrt(sum(n * n for n in normal))
        if normal[2] > length * 1e-7:
            upward += length / 2
    areas.append(upward)
    mesh_volume = abs(ifcopenshell.util.shape.get_volume(shape.geometry))
    volumes.append(mesh_volume)
    qto = next(rel.RelatingPropertyDefinition for rel in part.IsDefinedBy
               if rel.is_a('IfcRelDefinesByProperties')
               and rel.RelatingPropertyDefinition.is_a('IfcElementQuantity')
               and rel.RelatingPropertyDefinition.Name == 'Qto_SlabBaseQuantities')
    volume = next(q.VolumeValue for q in qto.Quantities if q.Name == 'NetVolume') * volume_scale
    assert math.isclose(volume, mesh_volume, rel_tol=1e-6, abs_tol=1e-8), (volume, mesh_volume)
    measured.append(volume)
    pset = next(rel.RelatingPropertyDefinition for rel in part.IsDefinedBy
                if rel.is_a('IfcRelDefinesByProperties')
                and rel.RelatingPropertyDefinition.is_a('IfcPropertySet')
                and rel.RelatingPropertyDefinition.Name == 'Pset_SlabCommon')
    pitch = next(p for p in pset.HasProperties if p.Name == 'PitchAngle')
    assert pitch.NominalValue.is_a('IfcPlaneAngleMeasure')
    assert math.isclose(pitch.NominalValue.wrappedValue * angle_scale, math.pi / 6, abs_tol=1e-10)
for expected, actual in zip(sorted(volumes), sorted(measured), strict=True):
    assert math.isclose(actual, expected, rel_tol=1e-6, abs_tol=1e-8), (actual, expected)
root_volume = sum(volumes)
assert math.isclose(root_volume, sum(measured), rel_tol=1e-6, abs_tol=1e-8)
root_qto = next(rel.RelatingPropertyDefinition for rel in roof.IsDefinedBy
                if rel.is_a('IfcRelDefinesByProperties')
                and rel.RelatingPropertyDefinition.Name == 'Qto_RoofBaseQuantities')
root_area = next(q.AreaValue for q in root_qto.Quantities if q.Name == 'GrossArea')
area_scale = ifcopenshell.util.unit.calculate_unit_scale(model, 'AREAUNIT')
assert math.isclose(root_area * area_scale, sum(areas), rel_tol=1e-6)
box = [[min(p[k] for p in bounds) for k in range(3)], [max(p[k] for p in bounds) for k in range(3)]]
assert math.isclose(box[0][2], 3, abs_tol=1e-7)
assert math.isclose(box[1][2], 3 + 4 * math.tan(math.pi / 6) + .25 / math.cos(math.pi / 6), abs_tol=1e-7)
reopened = ifcopenshell.file.from_string(model.to_string())
assert len(reopened.by_type('IfcRoof')[0].IsDecomposedBy[0].RelatedObjects) == len(parts)
print(json.dumps({'planes': len(parts), 'volume': root_volume, 'area': sum(areas), 'bbox': box, 'schema': model.schema}))
