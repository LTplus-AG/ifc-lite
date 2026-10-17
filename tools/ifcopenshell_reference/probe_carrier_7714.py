# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Independent source / IfcOpenShell receipt for #7714; never imports ifc-lite.

Run with the original fetched SOffice file, or the committed isolated source
shell. Fraction uses the decoded binary64 coordinates, matching the source
domain under examination. This is a bounded witness, not a general IFC reader.
"""
import argparse
from fractions import Fraction as F
import hashlib
from itertools import combinations, permutations
import json
from pathlib import Path

import ifcopenshell
import ifcopenshell.geom
from shapely.geometry import Polygon, MultiPoint
from shapely.ops import unary_union


def sub(a, b):
    return tuple(x-y for x, y in zip(a, b))


def cross(a, b):
    return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])


def dot(a, b):
    return sum(x*y for x, y in zip(a, b))


def det(rows):
    return sum((-1 if sum(p[i] > p[j] for i in range(3) for j in range(i+1, 3)) % 2 else 1)
               * rows[0][p[0]]*rows[1][p[1]]*rows[2][p[2]] for p in permutations(range(3)))


def carrier(points):
    for a, b, c in combinations(points, 3):
        n = cross(sub(b, a), sub(c, a))
        if any(n):
            return (*n, dot(n, a))
    raise AssertionError('degenerate source face')


def on(plane, p):
    return dot(plane[:3], p) == plane[3]


def probe(path, brep_dir=None):
    raw = path.read_bytes()
    model = ifcopenshell.open(str(path))
    brep = model.by_id(489635)
    faces = brep.Outer.CfsFaces
    loops = [[p.id() for p in f.Bounds[0].Bound.Polygon][::1 if f.Bounds[0].Orientation else -1] for f in faces]
    points = {i: tuple(F(v) for v in model.by_id(i).Coordinates) for r in loops for i in r}
    original = points.copy()
    planes = [carrier([points[i] for i in r]) for r in loops]
    healthy = [all(on(p, points[i]) for i in r) for p, r in zip(planes, loops)]
    assert len(points) == 10 and sum(healthy) == 6
    bad = healthy.index(False)
    candidates = []
    for j, r in enumerate(loops):
        edges = set(zip(r, r[1:]+r[:1]))
        shared = any((b, a) in edges for a, b in zip(loops[bad], loops[bad][1:]+loops[bad][:1]))
        if healthy[j] and shared:
            vertices = [points[i] for i in loops[bad] if on(planes[j], points[i])]
            if len(vertices) >= 3 and any(cross(sub(b, a), sub(c, a)) != (0, 0, 0)
                                        for a, b, c in combinations(vertices, 3)):
                candidates.append(j)
    assert [faces[j].id() for j in candidates] == [489589]
    planes[bad] = planes[candidates[0]]
    incident = [p for p, r in zip(planes, loops) if 489593 in r]
    assert len(incident) == 3
    matrix = [p[:3] for p in incident]
    denominator = det(matrix)
    assert denominator
    corrected = tuple(det([tuple(p[3] if k == axis else p[k] for k in range(3)) for p in incident]) / denominator
                      for axis in range(3))
    assert corrected == (F(95), original[489593][1], F(-325))
    points[489593] = corrected
    assert all(on(p, points[i]) for p, r in zip(planes, loops) for i in r)
    edges = [(a, b) for r in loops for a, b in zip(r, r[1:]+r[:1])]
    assert all(a != b and points[a] != points[b] and edges.count((b, a)) == 1 for a, b in edges)
    volume6 = sum(dot(points[r[0]], cross(points[r[i]], points[r[i+1]])) for r in loops for i in range(1, len(r)-1))
    assert volume6 > 0
    for plane in planes:
        assert all(dot(plane[:3], p) <= plane[3] for p in points.values())
    finite = []
    for p in planes:
        group = [r for q, r in zip(planes, loops) if all(on(p, points[i]) for i in r)]
        axis = next(i for i in range(3) if p[i])
        project = lambda point: [float(point[i]) for i in range(3) if i != axis]
        polygons = [Polygon([project(points[i]) for i in r]) for r in group]
        union = unary_union(polygons)
        hull = MultiPoint([project(points[i]) for r in group for i in r]).convex_hull
        assert union.symmetric_difference(hull).area == 0 and sum(s.area for s in polygons) == union.area
        finite.append({'faces': len(group), 'area_file_units2': union.area})
    settings = ifcopenshell.geom.settings()
    shape = ifcopenshell.geom.create_shape(settings, brep)
    vertices = list(zip(*(iter(shape.verts),)*3))
    # Direct-item coordinates are SI metres. Preserve the oracle's warped
    # corner; its fitted internal carrier does not authorize our candidate.
    old = tuple(float(v)*0.001 for v in original[489593])
    assert any(sum((v[i]-old[i])**2 for i in range(3)) < 1e-24 for v in vertices)
    source_ids = {}
    for index, vertex in enumerate(vertices):
        matches = [i for i, point in original.items()
                   if sum((vertex[k]-float(point[k])*0.001)**2 for k in range(3)) < 1e-24]
        if len(matches) == 1:
            source_ids[index] = matches[0]
    target = set(loops[bad])
    triangles = [[source_ids.get(i) for i in triangle] for triangle in zip(*(iter(shape.faces),)*3)]
    warped_triangles = [t for t in triangles if set(t) <= target]
    assert len(warped_triangles) == 2
    diagonal = sorted(set(warped_triangles[0]) & set(warped_triangles[1]))
    assert diagonal == [489584, 489593], 'oracle retains authored 0-2 diagonal'
    serialized_hashes = {}
    if brep_dir:
        brep_dir.mkdir(parents=True, exist_ok=True)
        settings.set('iterator-output', ifcopenshell.ifcopenshell_wrapper.SERIALIZED)
        for entity in [brep, model.by_id(489647)]:
            serialized = ifcopenshell.geom.create_shape(settings, entity)
            data = getattr(serialized, 'geometry', serialized).brep_data.encode()
            (brep_dir / f'{entity.id()}.brep').write_bytes(data)
            serialized_hashes[str(entity.id())] = hashlib.sha256(data).hexdigest()
    return {'source_sha256': hashlib.sha256(raw).hexdigest(), 'ifcopenshell': ifcopenshell.version,
            'brep': brep.id(), 'face': faces[bad].id(), 'adjacent_carrier': faces[candidates[0]].id(),
            'source_point': 489593, 'original': list(map(float, original[489593])),
            'corrected': list(map(float, corrected)), 'movement_metres': float(original[489593][0]-corrected[0])*0.001,
            'volume_file_units3': float(volume6/6), 'finite_coverage': finite,
            'oracle_retains_warped_corner': True, 'oracle_triangles': len(shape.faces)//3,
            'oracle_warped_face_triangles_source_ids': warped_triangles,
            'oracle_warped_face_diagonal_source_ids': diagonal,
            'serialized_brep_sha256': serialized_hashes,
            'limits': 'No OCC-equivalence, product Boolean branch, or product-tolerance claim.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('--brep-dir', type=Path, help='retain independent item and original-product BReps (original file required)')
    args = parser.parse_args()
    print(json.dumps(probe(args.source, args.brep_dir), indent=2))
