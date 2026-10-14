#!/usr/bin/env python3
"""Compare #7292 candidate and independent IFC oracle boundary polygon unions.
Install ifcopenshell==0.8.5 shapely==2.0.7 in a Python 3.12 venv.
Example: python compare_surface.py --candidate native-2pct.json --slope .02 --output /tmp/7292-replay
Candidate meshes use Y-up positions plus origin; fixture RTC must be zero.
No topology/winding claim. See inputs.json for capture provenance.
"""
import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import ifcopenshell
import ifcopenshell.geom
import shapely
from shapely.geometry import Polygon
from shapely.ops import unary_union

POSITION_TOLERANCE = 1e-4
SLOPE = 0.02
WIDTH = 0.025
DEPTH = 0.054
PROFILE_LENGTH = 1.1
LENGTH_Y = PROFILE_LENGTH / math.sqrt(1 + SLOPE**2)
NORMAL_LENGTH = math.sqrt(1 + SLOPE**2)
def analytic_faces():
    return [
    ('x_min', (1, 0, 0), -3.025, DEPTH * LENGTH_Y, 2 * (PROFILE_LENGTH + DEPTH)),
    ('x_max', (1, 0, 0), -3, DEPTH * LENGTH_Y, 2 * (PROFILE_LENGTH + DEPTH)),
    ('y_min', (0, 1, 0), 0, WIDTH * DEPTH, 2 * (WIDTH + DEPTH)),
    ('y_max', (0, 1, 0), LENGTH_Y, WIDTH * DEPTH, 2 * (WIDTH + DEPTH)),
    ('bottom', (0, -SLOPE / NORMAL_LENGTH, 1 / NORMAL_LENGTH), 4.548 / NORMAL_LENGTH,
     WIDTH * PROFILE_LENGTH, 2 * (WIDTH + PROFILE_LENGTH)),
    ('top', (0, -SLOPE / NORMAL_LENGTH, 1 / NORMAL_LENGTH), 4.602 / NORMAL_LENGTH,
     WIDTH * PROFILE_LENGTH, 2 * (WIDTH + PROFILE_LENGTH)),
    ]


FACES = analytic_faces()


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def classify(triangle):
    a, b, c = triangle
    u = [b[k] - a[k] for k in range(3)]
    v = [c[k] - a[k] for k in range(3)]
    cross = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
    candidates = []
    for face, (_, normal, offset, _, _) in enumerate(FACES):
        if all(abs(dot(normal, vertex) - offset) <= POSITION_TOLERANCE for vertex in triangle):
            candidates.append((abs(dot(normal, cross)), -face))
    if not candidates:
        raise ValueError(f'Triangle outside all analytic strip boundary planes: {triangle}')
    return -max(candidates)[1]


def project(face, vertex):
    x, y, z = vertex
    if face < 2:
        return y, z
    if face < 4:
        return x, z
    # Orthogonal face coordinates: signed arclength along (0,1,slope).
    return x, (y + SLOPE * z) / NORMAL_LENGTH


def face_unions(triangles):
    polygons = [[] for _ in FACES]
    degenerate = 0
    for triangle in triangles:
        if any(len(vertex) != 3 or not all(math.isfinite(v) for v in vertex) for vertex in triangle):
            raise ValueError('Invalid/nonfinite triangle')
        face = classify(triangle)
        polygon = Polygon([project(face, vertex) for vertex in triangle])
        if polygon.area <= 1e-18:
            degenerate += 1
            continue
        if not polygon.is_valid:
            raise ValueError(f'Invalid projected triangle on {FACES[face][0]}')
        polygons[face].append(polygon)
    return [unary_union(items) for items in polygons], degenerate


def find_raw_meshes(payload):
    if isinstance(payload, dict):
        if 'rawMeshes' in payload:
            return payload['rawMeshes']
        for value in payload.values():
            found = find_raw_meshes(value)
            if found is not None:
                return found
    return None


def candidate_triangles(payload):
    meshes = find_raw_meshes(payload)
    if not isinstance(meshes, list):
        raise ValueError('Candidate JSON must contain rawMeshes array')
    triangles = []
    for mesh in meshes:
        if mesh.get('expressId') != 107:
            continue
        positions, indices = mesh['positions'], mesh['indices']
        origin = mesh.get('origin') or [0, 0, 0]
        if len(indices) % 3 or len(positions) % 3:
            raise ValueError('Invalid mesh buffer lengths')
        def world(index):
            if not isinstance(index, int) or index < 0 or index * 3 + 2 >= len(positions):
                raise ValueError('Invalid mesh index')
            r = [positions[index * 3 + k] + origin[k] for k in range(3)]
            return [r[0], -r[2], r[1]]  # Y-up -> IFC Z-up; fixture needs no RTC.
        triangles.extend([[world(index) for index in indices[start:start + 3]]
                          for start in range(0, len(indices), 3)])
    if not triangles:
        raise ValueError('Candidate has no indexed geometry for element #107')
    return triangles



def fixture_at_slope(content, slope):
    """Preserve reporter bytes at 2%; otherwise change only axes and prism z.
    A axes become (0, +/-slope/sqrt(1+slope²), 1/sqrt(1+slope²)).
    B points #43..62 become z=48+slope*y or 128.9+slope*y in mm.
    Footprints, layer depths, units, and model placement are unchanged.
    """
    if slope == 0.02:
        return content
    lines = []
    normal = math.sqrt(1 + slope * slope)
    for line in content.splitlines():
        token = line.split('=', 1)[0]
        entity_id = int(token[1:]) if token.startswith('#') and token[1:].isdigit() else None
        if entity_id in (37, 41):
            y = (-1 if entity_id == 37 else 1) * slope / normal
            line = f'#{entity_id}=IFCDIRECTION((0.000000000000000,{y:.15f},{1 / normal:.15f}));'
        elif entity_id is not None and 43 <= entity_id <= 62:
            x, y, _ = map(float, line.split('((', 1)[1].removesuffix('));').split(','))
            z = (48 if (entity_id - 43) % 2 == 0 else 128.9) + slope * y
            line = f'#{entity_id}=IFCCARTESIANPOINT(({x:.4f},{y:.4f},{z:.4f}));'
        lines.append(line)
    return '\n'.join(lines) + '\n'


def main():
    global SLOPE, LENGTH_Y, NORMAL_LENGTH, FACES
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture', type=Path, default=Path(__file__).resolve().parents[4] / 'rust/geometry/tests/fixtures/issue_7292_sloped_coplanar_difference.ifc')
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path('/tmp/7292-surface-comparison'))
    parser.add_argument('--slope', type=float, choices=(0.02, 0.05), default=0.02)
    args = parser.parse_args()
    SLOPE = args.slope
    NORMAL_LENGTH = math.sqrt(1 + SLOPE**2)
    LENGTH_Y = PROFILE_LENGTH / NORMAL_LENGTH
    FACES = analytic_faces()
    if ifcopenshell.version != '0.8.5' or shapely.__version__ != '2.0.7':
        raise RuntimeError(f'Unpinned engines: IfcOpenShell {ifcopenshell.version}, Shapely {shapely.__version__}')
    original_fixture_bytes = args.fixture.read_bytes()
    fixture_bytes = fixture_at_slope(original_fixture_bytes.decode(), SLOPE).encode()
    candidate_bytes = args.candidate.read_bytes()
    payload = json.loads(candidate_bytes)
    if payload.get('hasRtcOffset', False):
        raise ValueError('These fixture comparisons require zero RTC translation')
    candidate = candidate_triangles(payload)
    model = ifcopenshell.file.from_string(fixture_bytes.decode())
    settings = ifcopenshell.geom.settings()
    settings.set('use-world-coords', True)
    shape = ifcopenshell.geom.create_shape(settings, model.by_id(107))
    positions, indices = list(shape.geometry.verts), list(shape.geometry.faces)
    oracle = [[positions[index * 3:index * 3 + 3] for index in indices[start:start + 3]]
              for start in range(0, len(indices), 3)]
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / 'oracle-triangles.json').write_text(json.dumps({'positions': positions, 'indices': indices, 'triangles': oracle}, indent=2) + '\n')
    (args.output / 'candidate-input.json').write_bytes(candidate_bytes)
    oracle_faces, oracle_degenerate = face_unions(oracle)
    candidate_faces, candidate_degenerate = face_unions(candidate)
    results = []
    for face, (name, _, _, analytic_area, perimeter) in enumerate(FACES):
        expected, actual = oracle_faces[face], candidate_faces[face]
        if expected.is_empty or actual.is_empty:
            raise ValueError(f'Missing boundary face: {name}')
        symmetric_difference = expected.symmetric_difference(actual).area
        # Densify each boundary edge: vertex-only Hausdorff can miss a gap
        # between existing vertices (observed on the candidate bottom face).
        hausdorff = float(shapely.hausdorff_distance(expected, actual, densify=0.01))
        area_tolerance = perimeter * POSITION_TOLERANCE + analytic_area * 1e-6
        # Filled-region containment is the positional contract: a tiny
        # interior slit may have a boundary far from the oracle exterior,
        # while every actual surface point remains within tolerance.
        missing_beyond_tolerance = expected.difference(actual.buffer(POSITION_TOLERANCE))
        excess_beyond_tolerance = actual.difference(expected.buffer(POSITION_TOLERANCE))
        contained = missing_beyond_tolerance.is_empty and excess_beyond_tolerance.is_empty
        passed = (symmetric_difference <= area_tolerance and contained
                  and abs(expected.area - analytic_area) <= area_tolerance
                  and abs(actual.area - analytic_area) <= area_tolerance)
        results.append({'face': name, 'oracle_union_area_m2': expected.area,
                        'candidate_union_area_m2': actual.area, 'analytic_area_m2': analytic_area,
                        'symmetric_difference_area_m2': symmetric_difference,
                        'symmetric_difference_tolerance_m2': area_tolerance,
                        'boundary_hausdorff_distance_m': hausdorff, 'boundary_hausdorff_diagnostic_only': True,
                        'symmetric_filled_region_containment': contained,
                        'filled_region_containment_tolerance_m': POSITION_TOLERANCE,
                        'missing_beyond_tolerance_area_m2': missing_beyond_tolerance.area,
                        'excess_beyond_tolerance_area_m2': excess_beyond_tolerance.area,
                        'missing_beyond_tolerance_wkt': missing_beyond_tolerance.wkt,
                        'excess_beyond_tolerance_wkt': excess_beyond_tolerance.wkt,
                        'oracle_union_wkt': expected.wkt, 'candidate_union_wkt': actual.wkt, 'passed': passed})
    receipt = {'fixture': 'rust/geometry/tests/fixtures/issue_7292_sloped_coplanar_difference.ifc', 'slope': SLOPE,
               'original_fixture_sha256': hashlib.sha256(original_fixture_bytes).hexdigest(), 'fixture_sha256': hashlib.sha256(fixture_bytes).hexdigest(),
               'candidate': args.candidate.name, 'candidate_sha256': hashlib.sha256(candidate_bytes).hexdigest(),
               'ifcopenshell': ifcopenshell.version, 'shapely': shapely.__version__,
               'coordinate_frame': 'IFC Z-up world metres; candidate Y-up positions plus origins inverse-rotated; RTC none',
               'position_tolerance_m': POSITION_TOLERANCE,
               'hausdorff_method': 'DIAGNOSTIC ONLY: GEOS symmetric boundary Hausdorff with edges densified at 1% spacing',
               'positional_acceptance': 'oracle minus candidate.buffer(0.0001) and candidate minus oracle.buffer(0.0001) must both be empty',
               'area_tolerance_rule': 'analytic face perimeter * position tolerance + analytic area * 1e-6',
               'oracle_triangles': len(oracle), 'candidate_triangles': len(candidate),
               'oracle_degenerate_triangles': oracle_degenerate, 'candidate_degenerate_triangles': candidate_degenerate,
               'limitations': 'Boundary polygon union comparison makes no topology, watertightness, winding, or multiplicity claim. Union discards overlapping duplicate coverage.',
               'faces': results, 'passed': all(row['passed'] for row in results)}
    (args.output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({key: value for key, value in receipt.items() if key != 'faces'}, indent=2))
    for row in results:
        print(f"{row['face']}: symmetric difference={row['symmetric_difference_area_m2']:.12g}m², boundary Hausdorff={row['boundary_hausdorff_distance_m']:.12g}m, region containment={row['symmetric_filled_region_containment']}, missing beyond tolerance={row['missing_beyond_tolerance_area_m2']:.12g}m², passed={row['passed']}")
    return 0 if receipt['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
