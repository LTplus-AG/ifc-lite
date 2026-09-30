# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Independent sampled point-to-triangle surface distances; no nearest-vertex proxy.
Discrete vertex/centroid/edge-midpoint samples do not bound the whole surface.
"""
import hashlib
import heapq
import json
import math
from pathlib import Path
import time
import numpy as np


def leaf_distances(point, triangles):
    a, b, c = triangles[:, 0], triangles[:, 1], triangles[:, 2]
    ab, ac = b - a, c - a
    ap = point - a
    # Cross products avoid cancellation of nearly equal Gram products on thin
    # triangles. A nonzero represented area remains a valid plane projection.
    normal = np.cross(ab, ac)
    denom = np.einsum('ij,ij->i', normal, normal)
    valid = denom > 0
    u = np.zeros_like(denom)
    v = np.zeros_like(denom)
    np.divide(np.einsum('ij,ij->i', np.cross(ap, ac), normal), denom, out=u, where=valid)
    np.divide(np.einsum('ij,ij->i', np.cross(ab, ap), normal), denom, out=v, where=valid)
    inside = valid & (u >= 0) & (v >= 0) & (u + v <= 1)
    plane_dist = np.full_like(denom, np.inf)
    numerator = np.einsum('ij,ij->i', ap, normal)
    np.divide(numerator * numerator, denom, out=plane_dist, where=valid)
    best = np.where(inside, plane_dist, np.inf)
    for start, end in ((a, b), (b, c), (c, a)):
        delta = end - start
        length2 = np.einsum('ij,ij->i', delta, delta)
        t = np.zeros_like(length2)
        np.divide(np.einsum('ij,ij->i', point - start, delta), length2, out=t, where=length2 > 0)
        t = np.clip(t, 0, 1)
        offset = point - (start + t[:, None] * delta)
        best = np.minimum(best, np.einsum('ij,ij->i', offset, offset))
    return best

class Surface:
    def __init__(self, vertices, faces):
        self.vertices = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
        self.faces = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
        if not np.isfinite(self.vertices).all() or self.faces.min() < 0 or self.faces.max() >= len(self.vertices):
            raise ValueError('Non-finite vertices or invalid triangle indices')
        self.triangles = self.vertices[self.faces]
        self.referenced_vertices = np.unique(self.triangles.reshape(-1, 3), axis=0)
        self.lower = self.triangles.min(axis=1)
        self.upper = self.triangles.max(axis=1)
        self.centers = (self.lower + self.upper) * 0.5
        self.nodes = []
        self.root = self._build(np.arange(len(self.faces)))

    def _build(self, ids):
        lo, hi = self.lower[ids].min(axis=0), self.upper[ids].max(axis=0)
        index = len(self.nodes)
        self.nodes.append(None)
        if len(ids) <= 16:
            self.nodes[index] = (lo, hi, ids, None, None)
        else:
            axis = int(np.argmax(hi - lo))
            ordered = ids[np.argsort(self.centers[ids, axis], kind='stable')]
            mid = len(ids) // 2
            left, right = self._build(ordered[:mid]), self._build(ordered[mid:])
            self.nodes[index] = (lo, hi, None, left, right)
        return index

    def nearest_squared(self, point):
        def bound(index):
            lo, hi = self.nodes[index][:2]
            dx = max(float(lo[0] - point[0]), 0.0, float(point[0] - hi[0]))
            dy = max(float(lo[1] - point[1]), 0.0, float(point[1] - hi[1]))
            dz = max(float(lo[2] - point[2]), 0.0, float(point[2] - hi[2]))
            return dx * dx + dy * dy + dz * dz
        # An actual referenced vertex lies on the surface and supplies only an upper bound.
        # The final search still computes point-to-triangle distances, never a vertex proxy.
        offsets = self.referenced_vertices - point
        best = float(np.einsum('ij,ij->i', offsets, offsets).min())
        queue = [(bound(self.root), self.root)]
        while queue:
            lower, index = heapq.heappop(queue)
            if lower > best:
                continue
            _, _, ids, left, right = self.nodes[index]
            if ids is not None:
                best = min(best, float(leaf_distances(point, self.triangles[ids]).min()))
            else:
                for child in (left, right):
                    distance = bound(child)
                    if distance <= best:
                        heapq.heappush(queue, (distance, child))
        return best

    def nearest_squared_batch(self, points):
        # Vectorize the same geometric queries; upper bounds remain referenced vertices.
        best = np.full(len(points), np.inf)
        for start in range(0, len(points), 64):
            chunk = points[start:start + 64]
            offsets = chunk[:, None, :] - self.referenced_vertices[None, :, :]
            best[start:start + len(chunk)] = np.einsum('ijk,ijk->ij', offsets, offsets).min(axis=1)
        stack = [(self.root, np.arange(len(points)))]
        while stack:
            node_index, candidates = stack.pop()
            lo, hi, ids, left, right = self.nodes[node_index]
            offsets = np.maximum(np.maximum(lo - points[candidates], points[candidates] - hi), 0)
            lower = np.einsum('ij,ij->i', offsets, offsets)
            active = candidates[lower <= best[candidates]]
            if not len(active):
                continue
            if ids is not None:
                triangles = self.triangles[ids]
                for start in range(0, len(active), 128):
                    selected = active[start:start + 128]
                    repeated_points = np.repeat(points[selected], len(ids), axis=0)
                    tiled_triangles = np.tile(triangles, (len(selected), 1, 1))
                    squared = leaf_distances(repeated_points, tiled_triangles).reshape(len(selected), len(ids)).min(axis=1)
                    best[selected] = np.minimum(best[selected], squared)
            else:
                # Child ordering affects only work; each child reapplies its bound after updates.
                center = points[active].mean(axis=0)
                children = sorted((left, right), key=lambda child: float(np.sum(((self.nodes[child][0] + self.nodes[child][1]) * .5 - center) ** 2)))
                stack.extend((child, active) for child in reversed(children))
        return best

    def sample_sets(self):
        yield 'unique_vertices', self.referenced_vertices
        yield 'triangle_centroids', self.triangles.mean(axis=1)
        # Each geometric edge midpoint, deduplicated; no randomized sampling.
        edges = np.concatenate([(self.triangles[:, 0] + self.triangles[:, 1]) / 2,
                                (self.triangles[:, 1] + self.triangles[:, 2]) / 2,
                                (self.triangles[:, 2] + self.triangles[:, 0]) / 2])
        yield 'unique_edge_midpoints', np.unique(edges, axis=0)

def known_answer_checks():
    triangle = np.array([[[0., 0., 0.], [2., 0., 0.], [0., 2., 0.]]])
    for point, expected in (([.5, .5, 0], 0), ([.5, .5, 3], 9), ([2, 2, 0], 2), ([-1, 0, 0], 1)):
        actual = float(leaf_distances(np.asarray(point), triangle)[0])
        if not math.isclose(actual, expected, abs_tol=1e-12):
            raise AssertionError((point, actual, expected))
    degenerate = np.array([[[0., 0., 0.], [1., 0., 0.], [1., 0., 0.]]])
    assert math.isclose(float(leaf_distances(np.array([.5, 2, 0]), degenerate)[0]), 4)
    # PR #6536: valid thin triangles must retain interior plane projections.
    thin = np.array([[[0., 0., 0.], [1000., 0., 0.], [1000., 1e-5, 0.]]])
    centroid = thin.mean(axis=1)[0]
    assert float(leaf_distances(centroid, thin)[0]) == 0
    assert math.isclose(float(leaf_distances(centroid + [0, 0, 2], thin)[0]), 4)
    thin_surface = Surface(thin.reshape(-1, 3), [[0, 1, 2]])
    assert thin_surface.nearest_squared(centroid) == 0
    assert thin_surface.nearest_squared_batch(np.array([centroid]))[0] == 0
    # Retained but unreferenced buffer positions are not part of a surface.
    padded = Surface(np.vstack((thin.reshape(-1, 3), [1e6, 1e6, 1e6])), [[0, 1, 2]])
    assert np.array_equal(next(padded.sample_sets())[1], thin_surface.referenced_vertices)
    assert geometry_report(padded) == geometry_report(thin_surface)
    for _, points in padded.sample_sets():
        assert np.all(thin_surface.nearest_squared_batch(points) < 1e-24)
    # BVH result equals brute-force actual triangle distances over deterministic queries.
    rng = np.random.default_rng(6516)
    vertices = rng.uniform(-2, 2, (180, 3))
    surface = Surface(vertices, np.arange(180).reshape(-1, 3))
    for point in rng.uniform(-3, 3, (100, 3)):
        actual = surface.nearest_squared(point)
        expected = float(leaf_distances(point, surface.triangles).min())
        assert math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-12), (actual, expected)
    queries = rng.uniform(-3, 3, (100, 3))
    batched = surface.nearest_squared_batch(queries)
    brute = np.array([float(leaf_distances(point, surface.triangles).min()) for point in queries])
    assert np.allclose(batched, brute, rtol=1e-12, atol=1e-12)
    return 'passed: plane interior, outside edge, endpoint, degenerate segment, thin triangle interior and offset, unused buffer vertex exclusion, 100 scalar BVH/brute-force queries and 100 batched BVH/brute-force queries'

def compare(source, target, label):
    sets = {}
    for name, points in source.sample_sets():
        began = time.monotonic()
        distances = np.sqrt(target.nearest_squared_batch(points))
        largest = int(np.argmax(distances))
        sets[name] = {'sample_count': len(points), 'distance_m': {'max': float(distances.max()), 'p99': float(np.quantile(distances, .99)), 'p95': float(np.quantile(distances, .95)), 'median': float(np.median(distances))}, 'counts_over_distance_m': {str(threshold): int((distances > threshold).sum()) for threshold in (1e-6, 1e-5, 1e-4, 1e-3)}, 'largest_sample_ifc_world_coords': points[largest].tolist(), 'elapsed_seconds_diagnostic_only': time.monotonic() - began}
        print(json.dumps({'comparison': label, 'sample_set': name, **sets[name]}), flush=True)
    return sets

def typed_values(value):
    return value['values'] if isinstance(value, dict) else value

def canonical_rtc(data, metadata_path):
    """Read actual canonical browser/stream metadata; never guess from mesh bounds."""
    if metadata_path:
        events = [json.loads(line) for line in metadata_path.read_text().splitlines()]
        data = next(event for event in events if event.get('type') == 'complete')
    info = data.get('coordinateInfo', {}) if isinstance(data, dict) else {}
    shift = info.get('originShift', {'x': 0, 'y': 0, 'z': 0})
    if any(shift[axis] != 0 for axis in ('x', 'y', 'z')):
        raise ValueError('Nonzero originShift requires an explicit audited coordinate adapter')
    rtc = info.get('wasmRtcOffset', info.get('wasmRtcFrame'))
    if rtc is None:
        if metadata_path:
            raise ValueError('Supplied metadata has no RTC frame')
        return np.zeros(3), 'explicit unrebased viewer kind; no RTC metadata supplied'
    return np.array([rtc[axis] for axis in ('x', 'y', 'z')]), 'actual canonical coordinateInfo RTC'

def load_capture(path, kind, host_id, metadata_path=None):
    data = json.loads(path.read_text())
    if kind == 'ifcopenshell-world':
        return Surface(data['verts'], data['faces']), {'coordinates': 'pinned engine USE_WORLD_COORDS; metres'}
    if kind == 'native-model-frame':
        if data['axis'] != 'IFC Z-up' or 'rtcOffset' not in data:
            raise ValueError('Expected explicit RTC-configured native ModelFrame capture')
        if host_id is not None and data['id'] != host_id:
            raise ValueError('Native capture host differs from requested id')
        points = np.asarray(data['positions']).reshape(-1, 3) + np.asarray(data['origin']) + np.asarray(data['rtcOffset'])
        return Surface(points, data['indices']), {'coordinates': 'native RTC-configured ModelFrame: IFC Z-up positions + origin + actual rtcOffset', 'rtc': data['rtcOffset'], 'rtcApplied_metadata': data.get('rtcApplied'), 'limitation': 'This adapter requires the documented ModelFrame collector; rtcApplied alone does not authorize reconstruction.'}
    rtc, provenance = canonical_rtc(data, metadata_path)
    meshes = data if isinstance(data, list) else data['meshes']
    selected = [mesh for mesh in meshes if host_id is None or mesh['id'] == host_id]
    if not selected:
        raise ValueError('Requested host has no captured mesh')
    vertices, faces, offset = [], [], 0
    for mesh in selected:
        # Browser / canonical MeshData arrays already contain METRES.
        viewer = np.asarray(typed_values(mesh['positions'])).reshape(-1, 3) + np.asarray(mesh.get('origin', [0, 0, 0]))
        world = np.column_stack((viewer[:, 0], -viewer[:, 2], viewer[:, 1])) + rtc
        vertices.append(world)
        faces.append(np.asarray(typed_values(mesh['indices'])).reshape(-1, 3) + offset)
        offset += len(world)
    return Surface(np.concatenate(vertices), np.concatenate(faces)), {'coordinates': 'canonical viewer metres [x,z,-y] reversed to IFC [x,y,z], plus part origin and actual IFC RTC; buildingRotation stays metadata, units are not reapplied', 'rtc': rtc.tolist(), 'rtc_provenance': provenance, 'parts': len(selected)}

def geometry_report(surface):
    vertices, inverse = np.unique(surface.triangles.reshape(-1, 3), axis=0, return_inverse=True)
    faces = inverse.reshape(-1, 3)
    edges = np.concatenate((faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]))
    _, undirected_counts = np.unique(np.sort(edges, axis=1), axis=0, return_counts=True)
    directed, counts = np.unique(edges, axis=0, return_counts=True)
    counter = {tuple(edge): int(count) for edge, count in zip(directed, counts)}
    unmatched = sum(count for edge, count in counter.items() if count != counter.get(edge[::-1], 0))
    reference = vertices.min(axis=0) + (vertices.max(axis=0) - vertices.min(axis=0)) * 0.5
    local = surface.triangles - reference
    terms = np.einsum('ij,ij->i', local[:, 0], np.cross(local[:, 1], local[:, 2]))
    boundary = int((undirected_counts == 1).sum())
    nonmanifold = int((undirected_counts > 2).sum())
    degenerate_edges = int((edges[:, 0] == edges[:, 1]).sum())
    return {'bounds': {'min': vertices.min(axis=0).tolist(), 'max': vertices.max(axis=0).tolist()}, 'triangles': len(faces), 'boundary_edges': boundary, 'nonmanifold_edges': nonmanifold, 'unmatched_directed_edge_occurrences': unmatched, 'degenerate_edges': degenerate_edges, 'signed_centered_volume_diagnostic_m3': math.fsum(float(term) for term in terms) / 6, 'closed_coherent_edge_incidence': boundary == nonmanifold == unmatched == degenerate_edges == 0, 'limitation': 'Closed coherent edge incidence is not proof against self-intersections or invalid nested solids; volume remains diagnostic.'}

def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path)
    parser.add_argument('--candidate', type=Path)
    parser.add_argument('--oracle', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--host-id', type=int)
    kinds = ('viewer-canonical', 'native-model-frame', 'ifcopenshell-world')
    parser.add_argument('--base-kind', choices=kinds, default='viewer-canonical')
    parser.add_argument('--candidate-kind', choices=kinds, default='viewer-canonical')
    parser.add_argument('--base-metadata', type=Path)
    parser.add_argument('--candidate-metadata', type=Path)
    parser.add_argument('--checks-only', action='store_true')
    args = parser.parse_args()
    checks = known_answer_checks()
    if args.checks_only:
        print(checks)
        return
    if any(value is None for value in (args.base, args.candidate, args.oracle, args.output)):
        parser.error('--base, --candidate, --oracle and --output are required')
    inputs = {'base': args.base, 'candidate': args.candidate, 'oracle': args.oracle}
    loaded = {'base': load_capture(args.base, args.base_kind, args.host_id, args.base_metadata), 'candidate': load_capture(args.candidate, args.candidate_kind, args.host_id, args.candidate_metadata), 'oracle': load_capture(args.oracle, 'ifcopenshell-world', args.host_id)}
    surfaces = {key: value[0] for key, value in loaded.items()}
    result = {'method': 'actual floating-point nearest triangle distances, triangle-AABB BVH seeded with referenced-vertex upper bounds; every unique vertex, triangle centroid and unique edge midpoint, both directions', 'limitation': 'Finite samples do not prove continuous Hausdorff bounds or valid solids. Split material parts include inner interfaces; compare same parts separately when needed.', 'known_answer_checks': checks, 'reproducer_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'input_sha256': {key: hashlib.sha256(path.read_bytes()).hexdigest() for key, path in inputs.items()}, 'metadata_sha256': {key: hashlib.sha256(path.read_bytes()).hexdigest() for key, path in (('base', args.base_metadata), ('candidate', args.candidate_metadata)) if path}, 'coordinate_provenance': {key: value[1] for key, value in loaded.items()}, 'geometry': {key: geometry_report(surface) for key, surface in surfaces.items()}, 'comparisons': {}}
    for source, target in (('base', 'oracle'), ('oracle', 'base'), ('candidate', 'oracle'), ('oracle', 'candidate'), ('base', 'candidate'), ('candidate', 'base')):
        label = source + '_to_' + target
        result['comparisons'][label] = compare(surfaces[source], surfaces[target], label)
        args.output.write_text(json.dumps(result, indent=2) + '\n')

if __name__ == '__main__':
    main()
