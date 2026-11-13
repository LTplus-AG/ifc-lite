# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""#9357: independently inspect the shared face of a 30/45 degree ridge."""
import json
import math
import sys
import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.shape
import ifcopenshell.validate

model = ifcopenshell.file.from_string(sys.stdin.read())
logger = ifcopenshell.validate.json_logger()
ifcopenshell.validate.validate(model, logger, express_rules=True)
assert not logger.statements, json.dumps(logger.statements, default=str)
roof, = model.by_type('IfcRoof')
items = [item for rep in roof.Representation.Representations
         if rep.RepresentationIdentifier == 'Body' for item in rep.Items]
assert len(items) == 2
settings = ifcopenshell.geom.settings()
meshes = [ifcopenshell.geom.create_shape(settings, item) for item in items]
meshes = [getattr(mesh, 'geometry', mesh) for mesh in meshes]
width, depth, thickness = 10., 8., .25
a, b = math.pi / 6, math.pi / 4
ta, tb = math.tan(a), math.tan(b)
va, vb = thickness / math.cos(a), thickness / math.cos(b)
bottom_y = depth * tb / (ta + tb)
top_y = (depth * tb + vb - va) / (ta + tb)
top_z = ta * top_y + va
for index, mesh in enumerate(meshes):
    points = list(zip(*[iter(mesh.verts)] * 3))
    for x in (0., width):
        expected = (x, top_y, top_z)
        error = min(math.dist(p, expected) for p in points)
        assert error < 1e-6, f'Plane {index} misses shared top ridge {expected}: {error}'
    # Every side face on the internal joint lies on d_a == d_b, from
    # the original underside ridge to the intersection of the offset tops.
    joint = [(x, y, z) for x, y, z in points
             if bottom_y - .001 <= y <= top_y + .001]
    assert len(joint) >= 4
    for x, y, z in joint:
        da = math.cos(a) * (z - ta * y)
        db = math.cos(b) * (z - tb * (depth - y))
        assert math.isclose(da, db, abs_tol=1e-6), (index, (x, y, z), da, db)
bottom_integral = ta * bottom_y ** 2 / 2 + tb * (depth - bottom_y) ** 2 / 2
top_integral = ta * top_y ** 2 / 2 + va * top_y + tb * (depth - top_y) ** 2 / 2 + vb * (depth - top_y)
expected_volume = width * (top_integral - bottom_integral)
volumes = [abs(ifcopenshell.util.shape.get_volume(mesh)) for mesh in meshes]
assert math.isclose(sum(volumes), expected_volume, rel_tol=1e-7), (volumes, expected_volume)
root = ifcopenshell.geom.create_shape(settings, roof)
assert math.isclose(abs(ifcopenshell.util.shape.get_volume(root.geometry)), expected_volume, rel_tol=1e-7)
print(json.dumps({'planes': len(meshes), 'volume': sum(volumes), 'top': [top_y, top_z]}))
