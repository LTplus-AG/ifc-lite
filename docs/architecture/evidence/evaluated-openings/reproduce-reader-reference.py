# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Reproduce Reference re-subtraction in pinned IfcOpenShell 0.8.2.

Usage: python reproduce-reader-reference.py output-directory
Creates controlled IFC4 cube variants; does not modify a supplied BIM model.
"""
from pathlib import Path
import json
import sys
import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.guid
import numpy as np

output = Path(sys.argv[1])
output.mkdir(parents=True, exist_ok=True)
assert ifcopenshell.version == '0.8.2', ifcopenshell.version
model = ifcopenshell.file(schema='IFC4')
point = lambda p: model.create_entity('IfcCartesianPoint', tuple(float(v) for v in p))
axes = model.create_entity('IfcAxis2Placement3D', point((0, 0, 0)))
placement = model.create_entity('IfcLocalPlacement', None, axes)
context = model.create_entity('IfcGeometricRepresentationContext', None, 'Model', 3, 1e-5, axes)
unit = model.create_entity('IfcSIUnit', None, 'LENGTHUNIT', None, 'METRE')
model.create_entity('IfcProject', GlobalId=ifcopenshell.guid.new(), Name='Reference reader repro',
                    RepresentationContexts=[context], UnitsInContext=model.create_entity('IfcUnitAssignment', [unit]))
points = [(0.,0.,0.),(1.,0.,0.),(1.,1.,0.),(0.,1.,0.),(0.,0.,1.),(1.,0.,1.),(1.,1.,1.),(0.,1.,1.)]
triangles = [(1,3,2),(1,4,3),(5,6,7),(5,7,8),(1,2,6),(1,6,5),(2,3,7),(2,7,6),(3,4,8),(3,8,7),(4,1,5),(4,5,8)]
item = model.create_entity('IfcTriangulatedFaceSet', Coordinates=model.create_entity('IfcCartesianPointList3D', points), Closed=True, CoordIndex=triangles)
body = model.create_entity('IfcShapeRepresentation', context, 'Body', 'Tessellation', [item])
pds = model.create_entity('IfcProductDefinitionShape', None, None, [body])
host = model.create_entity('IfcBuildingElementProxy', GlobalId=ifcopenshell.guid.new(), Name='Cube', ObjectPlacement=placement, Representation=pds)
profile = model.create_entity('IfcRectangleProfileDef', 'AREA', None, None, 0.2, 0.2)
opening_axes = model.create_entity('IfcAxis2Placement3D', point((0.1, 0.1, 0.)))
solid = model.create_entity('IfcExtrudedAreaSolid', profile, opening_axes, model.create_entity('IfcDirection', (0.,0.,1.)), 0.2)
opening_body = model.create_entity('IfcShapeRepresentation', context, 'Body', 'SweptSolid', [solid])
opening = model.create_entity('IfcOpeningElement', GlobalId=ifcopenshell.guid.new(), ObjectPlacement=placement,
    Representation=model.create_entity('IfcProductDefinitionShape', None, None, [opening_body]), PredefinedType='RECESS')
model.create_entity('IfcRelVoidsElement', GlobalId=ifcopenshell.guid.new(), RelatingBuildingElement=host, RelatedOpeningElement=opening)

def shape(file, disable=False):
    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)
    settings.set(settings.DISABLE_OPENING_SUBTRACTIONS, disable)
    # Keep the owning shape alive while reading its borrowed geometry buffers.
    result = ifcopenshell.geom.create_shape(settings, file.by_id(host.id()))
    vertices = np.asarray(result.geometry.verts).reshape(-1, 3).copy()
    faces = np.asarray(result.geometry.faces, dtype=np.int64).reshape(-1, 3).copy()
    volume = abs(np.einsum('ij,ij->i',vertices[faces[:,0]],np.cross(vertices[faces[:,1]],vertices[faces[:,2]])).sum()/6)
    return vertices, faces, {'triangles': len(faces), 'volumeCubicMetres': float(volume)}

original_text = model.to_string()
_, _, original = shape(model)
_, _, no_cut = shape(model, True)
model.write(str(output/'original-body.ifc'))
opening_body.RepresentationIdentifier = 'Reference'
_, _, reference_default = shape(model)
_, _, reference_no_cut = shape(model, True)
model.write(str(output/'reference-uncut-control.ifc'))
# A precut control alone does not prove non-subtraction: recutting the same exact
# hole is idempotent, concealing a reader that incorrectly consumes Reference.
original_model = ifcopenshell.file.from_string(original_text)
vertices, faces, _ = shape(original_model)
body.Items = [model.create_entity('IfcTriangulatedFaceSet', Coordinates=model.create_entity('IfcCartesianPointList3D', vertices.tolist()), Closed=True, CoordIndex=(faces+1).tolist())]
_, _, precut_default = shape(model)
_, _, precut_no_cut = shape(model, True)
model.write(str(output/'precut-reference.ifc'))
report = {'reader':'IfcOpenShell', 'version':ifcopenshell.version,
    'schema':'IFC4', 'originalBody':original, 'originalNoSubtraction':no_cut,
    'referenceUncutControlDefault':reference_default, 'referenceUncutControlNoSubtraction':reference_no_cut,
    'precutReferenceDefault':precut_default, 'precutReferenceNoSubtraction':precut_no_cut,
    'meaning':'Reference-only subtraction is forbidden by IFC semantics. The uncut control isolates routing; matching precut geometry alone cannot prove the reader skipped subtraction.'}
assert abs(no_cut['volumeCubicMetres']-1.) < 1e-9
assert abs(original['volumeCubicMetres']-0.992) < 1e-9
assert abs(reference_default['volumeCubicMetres']-reference_no_cut['volumeCubicMetres']) > 0.001
(output/'reader-reference-repro.json').write_text(json.dumps(report, indent=2)+'\n')
print(json.dumps(report))
