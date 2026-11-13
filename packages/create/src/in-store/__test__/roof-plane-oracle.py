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
roof, = model.by_type('IfcRoof')
parts = [part for rel in model.by_type('IfcRelAssignsToProduct')
         if rel.RelatingProduct == roof and rel.Name == 'Footprint roof planes'
         for part in rel.RelatedObjects]
assert parts, 'No quantitative roof planes'
volume_scale = ifcopenshell.util.unit.calculate_unit_scale(model, 'VOLUMEUNIT')
angle_scale = ifcopenshell.util.unit.calculate_unit_scale(model, 'PLANEANGLEUNIT')
items = [item for rep in roof.Representation.Representations if rep.RepresentationIdentifier == 'Body'
         for item in rep.Items]
volumes = []
for item in items:
    shape = ifcopenshell.geom.create_shape(settings, item)
    geometry = getattr(shape, 'geometry', shape)
    volumes.append(abs(ifcopenshell.util.shape.get_volume(geometry)))
measured = []
for part in parts:
    assert part.is_a('IfcSlab') and part.PredefinedType == 'ROOF'
    assert part.Representation is None, 'Plane geometry must not be rendered twice'
    qto = next(rel.RelatingPropertyDefinition for rel in part.IsDefinedBy
               if rel.is_a('IfcRelDefinesByProperties')
               and rel.RelatingPropertyDefinition.is_a('IfcElementQuantity')
               and rel.RelatingPropertyDefinition.Name == 'Qto_SlabBaseQuantities')
    volume = next(q.VolumeValue for q in qto.Quantities if q.Name == 'NetVolume') * volume_scale
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
root_shape = ifcopenshell.geom.create_shape(settings, roof)
root_volume = abs(ifcopenshell.util.shape.get_volume(root_shape.geometry))
assert math.isclose(root_volume, sum(measured), rel_tol=1e-6, abs_tol=1e-8)
print(json.dumps({'planes': len(parts), 'volume': root_volume, 'schema': model.schema}))
