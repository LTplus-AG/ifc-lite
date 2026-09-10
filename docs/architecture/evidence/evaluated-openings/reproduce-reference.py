# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Reproduce #4433 from the real fixture using an independent reader.

Usage: python reproduce-reference.py AC20-FZK-Haus.ifc output-dir
Requires IfcOpenShell and numpy. This evidence helper is not an authoring API.
"""
import collections
import json
from pathlib import Path
import sys
import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.unit
import ifcopenshell.validate
import numpy as np

source, output = map(Path, sys.argv[1:])
output.mkdir(parents=True, exist_ok=True)
original = ifcopenshell.open(source)
model = ifcopenshell.open(source)
product = model.by_id(59290)
# Independent reader supplies an already-cut, occurrence-local closed host.
# The regression is how native readers consume that ordinary IFC, not a claim
# that the appearance planner can yet publish post-opening conversion.
shape = ifcopenshell.geom.create_shape(ifcopenshell.geom.settings(), product)
unit = ifcopenshell.util.unit.calculate_unit_scale(model)
local = np.asarray(shape.geometry.verts).reshape(-1, 3) / unit
points = model.create_entity('IfcCartesianPointList3D', local.tolist())
triangles = (np.asarray(shape.geometry.faces).reshape(-1, 3) + 1).tolist()
item = model.create_entity('IfcTriangulatedFaceSet', Coordinates=points, Closed=True, CoordIndex=triangles)
body, = [r for r in product.Representation.Representations if r.RepresentationIdentifier == 'Body']
# The real source Body is also used by a type map. Clone occurrence wrappers.
replacement = model.create_entity('IfcShapeRepresentation', body.ContextOfItems, 'Body', 'Tessellation', [item])
pds = product.Representation
assert model.get_total_inverses(pds) == 1
pds.Representations = [replacement if r == body else r for r in pds.Representations]
changed_ids = [pds.id()]
for relation in product.HasOpenings:
    opening = relation.RelatedOpeningElement
    for representation in opening.Representation.Representations:
        if representation.RepresentationIdentifier == 'Body':
            assert model.get_total_inverses(representation) == 1
            representation.RepresentationIdentifier = 'Reference'
            changed_ids.append(representation.id())
path = output / 'reference-opening.ifc'
model.write(str(path))
reopened = ifcopenshell.open(path)
assert sorted(e.id() for e in original if str(e) != str(reopened.by_id(e.id()))) == sorted(changed_ids)

def geometry(file):
    shape = ifcopenshell.geom.create_shape(ifcopenshell.geom.settings(), file.by_id(59290))
    vertices = np.asarray(shape.geometry.verts).reshape(-1, 3)
    faces = np.asarray(shape.geometry.faces).reshape(-1, 3)
    volume = abs(np.einsum('ij,ij->i', vertices[faces[:, 0]], np.cross(vertices[faces[:, 1]], vertices[faces[:, 2]])).sum() / 6)
    return {'triangles': len(faces), 'volumeCubicMetres': float(volume)}

def findings(file):
    logger = ifcopenshell.validate.json_logger()
    ifcopenshell.validate.validate(file, logger, express_rules=True)
    # EXPRESS diagnostics embed referenced rows; changing a PDS prints different
    # text for the same pre-existing Box/type-map rule violation. Compare rule
    # identity on the same entity, retaining the invariant expression.
    return collections.Counter((e['instance'].id(), e.get('attribute'), e['message'].split('\n\nViolated by:')[0])
                               for e in logger.statements)

before, after = geometry(original), geometry(reopened)
assert before['triangles'] == after['triangles'] == 32
assert abs(before['volumeCubicMetres'] - after['volumeCubicMetres']) < 1e-6
old, new = findings(original), findings(reopened)
assert not new - old, list((new - old).elements())
result = {'reader': 'IfcOpenShell', 'version': ifcopenshell.version, 'product': 59290,
          'GlobalId': product.GlobalId, 'source': before, 'reference': after,
          'changedExistingEntities': sorted(changed_ids), 'sourceSchemaFindings': sum(old.values()),
          'referenceSchemaFindings': sum(new.values()), 'newSchemaFindings': []}
(output / 'independent-reader.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
