# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""#9357: independently check skin planes, shared faces and quantities."""
import json
import math
import sys
import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element
import ifcopenshell.util.shape
import ifcopenshell.validate
from roof_aggregate_oracle import roof_planes, union_volume

model = ifcopenshell.file.from_string(sys.stdin.read())
logger = ifcopenshell.validate.json_logger()
ifcopenshell.validate.validate(model, logger, express_rules=True)
assert not logger.statements, json.dumps(logger.statements, default=str)
roof, = model.by_type('IfcRoof')
definition = ifcopenshell.util.element.get_psets(roof)['IfcLite_RoofFootprint']
outline = json.loads(definition['Footprint'])
slopes = json.loads(definition['EdgeSlopes'])
thickness, overhang = definition['Thickness'], definition['Overhang']
parts, items = roof_planes(roof)
assert len(items) == len(parts)
dot = lambda a, b: sum(x * y for x, y in zip(a, b, strict=True))
sub = lambda a, b: tuple(x - y for x, y in zip(a, b, strict=True))
cross = lambda a, b: (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])
area2 = sum(outline[i][0]*outline[(i+1)%len(outline)][1] - outline[(i+1)%len(outline)][0]*outline[i][1] for i in range(len(outline)))
winding = 1 if area2 > 0 else -1
eaves, planes = [], []
for i, p in enumerate(outline):
    q = outline[(i+1) % len(outline)]
    length = math.dist(p, q)
    inward = (-(q[1]-p[1])/length*winding, (q[0]-p[0])/length*winding, 0.)
    eaves.append((inward, dot(inward[:2], p) - overhang))
for part in parts:
    edge = int(part.Tag)
    inward = eaves[edge][0]
    normal = (-inward[0]*math.sin(slopes[edge]), -inward[1]*math.sin(slopes[edge]), math.cos(slopes[edge]))
    planes.append((normal, dot(normal[:2], outline[edge])))
settings = ifcopenshell.geom.settings()
shapes = [ifcopenshell.geom.create_shape(settings, item) for item in items]
meshes = [getattr(shape, 'geometry', shape) for shape in shapes]
vertices_by_part = [list(zip(*[iter(mesh.verts)]*3)) for mesh in meshes]
triangles_by_part = [[tuple(vertices_by_part[i][j] for j in face) for face in zip(*[iter(mesh.faces)]*3)] for i, mesh in enumerate(meshes)]

def on_triangle(p, triangle):
    a, b, c = triangle
    u, v, w = sub(b, a), sub(c, a), sub(p, a)
    n = cross(u, v)
    n2 = dot(n, n)
    if n2 < 1e-18 or abs(dot(n, w)) > 1e-6*math.sqrt(n2):
        return False
    uu, vv, uv, wu, wv = dot(u, u), dot(v, v), dot(u, v), dot(w, u), dot(w, v)
    denominator = uu*vv-uv*uv
    if denominator <= 1e-18:
        return False
    s, t = (wu*vv-wv*uv)/denominator, (wv*uu-wu*uv)/denominator
    return s >= -1e-6 and t >= -1e-6 and s+t <= 1+1e-6

pair_areas = {}
total_volume = 0.
bottom_area = 0.
for i, (part, item) in enumerate(zip(parts, items, strict=True)):
    styled, = item.StyledByItem
    style, = styled.Styles
    assert style.Name == f'Edge {part.Tag}', (part.Tag, style.Name)
    mesh = meshes[i]
    vertices = vertices_by_part[i]
    faces = list(zip(*[iter(mesh.faces)]*3))
    normal, k = planes[i]
    measured_volume = abs(ifcopenshell.util.shape.get_volume(mesh))
    qto = ifcopenshell.util.element.get_psets(part)['Qto_SlabBaseQuantities']
    assert math.isclose(measured_volume, qto['GrossVolume'], rel_tol=1e-6, abs_tol=1e-8), (i, measured_volume, qto)
    total_volume += measured_volume
    plane_bottom_area = 0.
    for face in faces:
        points = [vertices[j] for j in face]
        area = math.sqrt(dot(cross(sub(points[1], points[0]), sub(points[2], points[0])), cross(sub(points[1], points[0]), sub(points[2], points[0])))) / 2
        if area < 1e-9:
            continue
        distances = [dot(normal, p)-k for p in points]
        if max(abs(d) for d in distances) < 1e-6:
            bottom_area += area
            plane_bottom_area += area
            continue
        if max(abs(d-thickness) for d in distances) < 1e-6:
            continue
        if any(max(abs(dot(n, p)-c) for p in points) < 1e-6 for n, c in eaves):
            continue
        middle = tuple(sum(p[axis] for p in points)/3 for axis in range(3))
        matches = [j for j, (n, c) in enumerate(planes) if j != i
                   and max(abs(distances[t]-(dot(n, p)-c)) for t, p in enumerate(points)) < 1e-6
                   and any(on_triangle(middle, triangle) for triangle in triangles_by_part[j])]
        assert matches, f'Plane {i} has a side face outside any mitre or eave: {points}'
        j = matches[0]
        pair_areas[i, j] = pair_areas.get((i, j), 0.) + area
    assert math.isclose(plane_bottom_area, qto['GrossArea'], rel_tol=1e-6, abs_tol=1e-8), (i, plane_bottom_area, qto)
for (i, j), area in pair_areas.items():
    other = pair_areas.get((j, i), 0.)
    assert math.isclose(area, other, rel_tol=1e-6, abs_tol=1e-7), (i, j, area, other)
assert math.isclose(union_volume(model, settings, items), total_volume, rel_tol=1e-6)
roof_qto = ifcopenshell.util.element.get_psets(roof)['Qto_RoofBaseQuantities']
assert math.isclose(bottom_area, roof_qto['GrossArea'], rel_tol=1e-6), (bottom_area, roof_qto)
print(json.dumps({'planes': len(parts), 'volume': total_volume, 'sharedFaces': len(pair_areas)//2}))
