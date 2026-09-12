# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# Offline CC BY 4.0 CRAS correspondence extraction (#4381). Every landmark is
# the intersection of three named planar building faces. The IFC side is read
# from the published IFC2X3 geometry (IfcOpenShell, world coordinates); the scan
# side is fitted independently to the archive subsets written by
# cras-archive-subset.py, inside search boxes placed with a coarse initial
# offset, by seeded RANSAC with a least-squares refit. The offset only chooses which points are examined; it never enters a
# coordinate. Fit/check membership is frozen here, before any solve.
# Usage: python cras-landmarks.py IFC2X3.ifc SUBSET_DIRECTORY OUTPUT.json
import sys, json, hashlib, pathlib, struct
import numpy as np
import ifcopenshell, ifcopenshell.geom

ifc_path, subset_dir, out_path = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])

# ---------------------------------------------------------------- IFC features
f = ifcopenshell.open(ifc_path)
settings = ifcopenshell.geom.settings(); settings.set(settings.USE_WORLD_COORDS, True)
shapes = []  # retain native handles: a temporary shape yields empty arrays
def bbox(entity_id):
    shape = ifcopenshell.geom.create_shape(settings, f.by_id(entity_id)); shapes.append(shape)
    v = np.array(shape.geometry.verts).reshape(-1, 3)
    return v.min(0), v.max(0)
def guid(entity_id): return f.by_id(entity_id).GlobalId
W = {wid: bbox(wid) for wid in [703, 1273, 383, 1065, 517, 1117, 2408]}
O = {oid: bbox(oid) for oid in [1328391, 1328262, 1327917, 1327933, 1327949, 1327965, 1328061, 1328314, 1328449]}
FLOOR_TOP = 0.10  # slab 159 top; every storey wall starts here

# A feature: IFC point + three planes, each with a search box (IFC frame, relative
# to the point) and the axis of its normal. Boxes stay clear of the corner itself
# and of neighbouring construction (door recesses, mullions, ceilings).
def box_of(spec):
    b = [[0, 0], [0, 0], [0, 0]]
    for axis, rng_ in spec.items(): b[axis] = sorted(rng_)
    return b
def wall_wall_floor(name, x, y, sx, sy, walls, run_x=0.55, run_y=0.55):
    """Floor corner: x-face wall (interior toward sx), y-face wall (interior toward sy).
    `run_*` bounds how far along each face the support may reach."""
    return {'id': name, 'kind': 'wall-wall-floor', 'ifc': [x, y, FLOOR_TOP], 'entities': walls, 'planes': [
        {'name': 'x-face', 'axis': 0, 'box': box_of({0: [-0.14, 0.14], 1: [sy * 0.05, sy * run_y], 2: [0.06, 0.70]})},
        {'name': 'y-face', 'axis': 1, 'box': box_of({1: [-0.14, 0.14], 0: [sx * 0.05, sx * run_x], 2: [0.06, 0.70]})},
        {'name': 'floor', 'axis': 2, 'box': box_of({2: [-0.10, 0.10], 0: [sx * 0.05, sx * run_x], 1: [sy * 0.05, sy * run_y]})}]}
def jamb_floor(name, face_axis, face, jamb_axis, jamb, s_face, s_jamb, depth, entities):
    """Door jamb meeting the floor: wall face (interior toward s_face), jamb reveal
    (opening toward s_jamb) reaching `depth` into the wall, floor inside the room."""
    point = [0., 0., FLOOR_TOP]; point[face_axis] = face; point[jamb_axis] = jamb
    return {'id': name, 'kind': 'jamb-floor', 'ifc': point, 'entities': entities, 'planes': [
        {'name': 'wall-face', 'axis': face_axis, 'box': box_of({face_axis: [-0.14, 0.14], jamb_axis: [-s_jamb * 0.05, -s_jamb * 0.28], 2: [0.06, 0.70]})},
        {'name': 'jamb', 'axis': jamb_axis, 'box': box_of({jamb_axis: [-0.16, 0.16], face_axis: [-s_face * 0.01, -s_face * (depth - 0.01)], 2: [0.06, 0.70]})},
        {'name': 'floor', 'axis': 2, 'box': box_of({2: [-0.10, 0.10], face_axis: [s_face * 0.05, s_face * 0.40], jamb_axis: [-s_jamb * 0.05, -s_jamb * 0.28]})}]}
def window_corner(name, face_axis, face, jamb_axis, jamb, z, s_face, s_jamb, s_z, depth, entities, z_run=0.30, jamb_run=0.40, face_run=0.45):
    """Opening corner on a wall face: wall face (interior toward s_face), jamb reveal
    (opening toward s_jamb), sill/head reveal (opening toward s_z). `depth` bounds
    how far into the wall the reveal boxes reach: only the first centimetres
    behind the face belong to the wall opening the IFC models; deeper surfaces
    are the window frame."""
    point = [0., 0., z]; point[face_axis] = face; point[jamb_axis] = jamb
    return {'id': name, 'kind': 'window-corner', 'ifc': point, 'entities': entities, 'planes': [
        {'name': 'wall-face', 'axis': face_axis, 'box': box_of({face_axis: [-0.14, 0.14], jamb_axis: [-s_jamb * 0.05, -s_jamb * face_run], 2: [-0.22, 0.22]})},
        {'name': 'jamb', 'axis': jamb_axis, 'box': box_of({jamb_axis: [-0.12, 0.12], face_axis: [-s_face * 0.01, -s_face * (depth - 0.01)], 2: [s_z * 0.04, s_z * z_run]})},
        {'name': 'sill-or-head', 'axis': 2, 'box': box_of({2: [-0.06, 0.06], face_axis: [-s_face * 0.01, -s_face * (depth - 0.01)], jamb_axis: [s_jamb * 0.04, s_jamb * jamb_run]})}]}
def wall_wall_head(name, face_axis, face, jamb_axis, other_face, z, s_face, s_other, entities, depth):
    """Clerestory band ending against a return wall: band wall face (interior toward
    s_face), return wall face (interior toward s_other) and the opening head reveal."""
    point = [0., 0., z]; point[face_axis] = face; point[jamb_axis] = other_face
    return {'id': name, 'kind': 'wall-wall-head', 'ifc': point, 'entities': entities, 'planes': [
        {'name': 'wall-face', 'axis': face_axis, 'box': box_of({face_axis: [-0.14, 0.14], jamb_axis: [s_other * 0.05, s_other * 0.45], 2: [-1.0, -0.55]})},
        {'name': 'return-face', 'axis': jamb_axis, 'box': box_of({jamb_axis: [-0.14, 0.14], face_axis: [s_face * 0.05, s_face * 0.45], 2: [-0.45, 0.02]})},
        {'name': 'head', 'axis': 2, 'box': box_of({2: [-0.06, 0.06], face_axis: [-s_face * 0.01, -s_face * (depth - 0.01)], jamb_axis: [s_other * 0.04, s_other * 0.40]})}]}

features = []
# Room B faces: wall 703 south (room face y=3.0085), wall 1273 north (room face y=10.8615), wall 383 east (room face x=7.9862).
south, north, east = W[703][1][1], W[1273][0][1], W[383][0][0]
# Clerestory bands: only the west end of each band is a wall reveal (the mullions
# between adjacent openings are frame members the IFC does not model).
# Sills are not used: from inside the room the sill reveal is hidden behind the
# sloped bottom frame member on every window, so no planar sill face exists.
for wall_id, opening_id, face, s_face, label in [(1273, 1328391, north, -1, 'north'), (703, 1328262, south, +1, 'south')]:
    lo, hi = O[opening_id]
    features.append(window_corner(f'B-{label}-band-W-head', 1, face, 0, lo[0], hi[2], s_face, +1, -1, 0.06, [guid(wall_id), guid(opening_id)], z_run=0.20))
    features.append(wall_wall_head(f'B-{label}-band-E-head', 1, face, 0, east, hi[2], s_face, -1, [guid(wall_id), guid(383)], 0.06))
# East brick wall 383 (35 cm): five 0.5 m fixed windows, head 2.76; the fifth
# (y 9.71..10.21) stands above cabinets and only its head corners are visible.
for oid in [1328061, 1327917, 1327933, 1327949, 1327965]:
    lo, hi = O[oid]
    for side, jamb, s_jamb in [('S', lo[1], +1), ('N', hi[1], -1)]:
        features.append(window_corner(f'B-east-{oid}-{side}-head', 0, east, 1, jamb, hi[2], -1, s_jamb, -1, 0.06, [guid(383), guid(oid)], z_run=0.20, jamb_run=0.44))
# Room B floor corner at the south-east: the only floor corner not hidden by benches or cabinets.
features.append(wall_wall_floor('B-floor-SE', east, south, -1, +1, [guid(383), guid(703)], run_x=0.30, run_y=0.30))
# West drywall 2408 (room face x=1.1807) with door opening 1328449 (y 9.359..10.859, head 2.30): south jamb at floor and head.
west = W[2408][1][0]
od = O[1328449]
features.append(jamb_floor('B-west-door-S-floor', 0, west, 1, od[0][1], +1, +1, 0.45, [guid(2408), guid(1328449)]))
features.append(window_corner('B-west-door-S-head', 0, west, 1, od[0][1], od[1][2], +1, +1, -1, 0.45, [guid(2408), guid(1328449)], z_run=0.30, jamb_run=0.40))
# Corridor A: west face x=-2.0197 (walls 517/857), east face x=0.3907 (wall 1117),
# south end wall 1065 face y=-4.3335 with the recessed door 1328314 (x -1.6721..0.0479).
aw, ae, asouth = W[517][1][0], W[1117][0][0], W[1065][1][1]
door = O[1328314]
features.append(wall_wall_floor('A-floor-SW', aw, asouth, +1, +1, [guid(517), guid(1065)], run_x=0.28))
features.append(wall_wall_floor('A-floor-SE', ae, asouth, -1, +1, [guid(1117), guid(1065)], run_x=0.28))
features.append(jamb_floor('A-door-W-floor', 1, asouth, 0, door[0][0], +1, +1, 0.12, [guid(1065), guid(1328314)]))
features.append(jamb_floor('A-door-E-floor', 1, asouth, 0, door[1][0], +1, -1, 0.12, [guid(1065), guid(1328314)]))

# ------------------------------------------------------------- scan subsets
def read_ply(path):
    with open(path, 'rb') as fh:
        header = b''
        while not header.endswith(b'end_header\n'): header += fh.readline()
        n = int([l for l in header.decode().split('\n') if l.startswith('element vertex')][0].split()[-1])
        dt = np.dtype([('x', '<f8'), ('y', '<f8'), ('z', '<f8'), ('r', 'u1'), ('g', 'u1'), ('b', 'u1'), ('label', 'u1'), ('idx', '<u4')])
        a = np.frombuffer(fh.read(n * dt.itemsize), dtype=dt)
    return np.column_stack([a['x'], a['y'], a['z']]), a['idx'], hashlib.sha256(path.read_bytes()).hexdigest()
clouds = {name: read_ply(subset_dir / f'{name}.ply') for name in ['cras-room-a-corridor', 'cras-wall-1273-strip', 'cras-wall-383-dense', 'cras-wall-703-strip', 'cras-wall-2408-strip', 'cras-window-1327933-N', 'cras-window-1327965-S']}
def cloud_of(fid):
    if fid.startswith('A-'): return 'cras-room-a-corridor'
    # Two jambs seen at grazing angles keep too few points at any decimation; they read the undecimated window boxes.
    if fid.startswith('B-east-1327933-N'): return 'cras-window-1327933-N'
    if fid.startswith('B-east-1327965-S'): return 'cras-window-1327965-S'
    if fid.startswith('B-east-') or fid == 'B-floor-SE': return 'cras-wall-383-dense'
    if fid.startswith('B-south-'): return 'cras-wall-703-strip'
    if fid.startswith('B-west-'): return 'cras-wall-2408-strip'
    return 'cras-wall-1273-strip'
# Coarse initial offset scan = ifc + offset, read from the wall-face histogram
# peaks of the subsets (room B east face 17.89 vs 7.9862, north face 11.08 vs
# 10.8615, floor -1.15 vs 0.10). It only places search boxes.
OFFSET = np.array([9.90, 0.22, -1.245])

rng = np.random.default_rng(4381)
def ransac_plane(points, axis, iterations=600, threshold=0.006):
    """Dominant plane whose normal lies within 30 degrees of `axis`: seeded RANSAC
    picks the hypothesis with the most points within `threshold`, then five
    rounds of least-squares refit on the inliers. Fewer than 20 supporting
    points is no measurement."""
    if len(points) < 20: return None
    best = None
    for _ in range(iterations):
        sample = points[rng.choice(len(points), 3, replace=False)]
        n = np.cross(sample[1] - sample[0], sample[2] - sample[0]); norm = np.linalg.norm(n)
        if norm < 1e-12: continue
        n /= norm
        if abs(n[axis]) < np.cos(np.radians(30)): continue
        d = -n @ sample[0]
        count = int((np.abs(points @ n + d) <= threshold).sum())
        if best is None or count > best[0]: best = (count, n, d)
    if best is None or best[0] < 20: return None
    n, d = best[1], best[2]
    for _ in range(5):
        inliers = np.abs(points @ n + d) <= threshold
        sel = points[inliers]
        if len(sel) < 20: return None
        centroid = sel.mean(0)
        _, _, vt = np.linalg.svd(sel - centroid, full_matrices=False); n = vt[2]
        if n[axis] < 0: n = -n
        d = -n @ centroid
    inliers = np.abs(points @ n + d) <= threshold
    if inliers.sum() < 20 or abs(n[axis]) < np.cos(np.radians(30)): return None
    residual = (points @ n + d)[inliers]
    return {'normal': n.tolist(), 'd': float(d), 'inliers': int(inliers.sum()), 'candidates': int(len(points)), 'rms_m': float(np.sqrt(np.mean(residual ** 2)))}

def fit_feature(feature, guess_offset):
    xyz, idx, _ = clouds[cloud_of(feature['id'])]
    guess = np.array(feature['ifc']) + guess_offset
    planes = []
    for plane in feature['planes']:
        # Boxes are placed from the running guess: once a plane is fitted, its
        # crossing replaces the coarse coordinate along that axis, so a reveal box
        # sits inside the wall the fitted face actually bounds.
        lo = guess + np.array([b[0] for b in plane['box']]); hi = guess + np.array([b[1] for b in plane['box']])
        inside = np.all((xyz >= lo) & (xyz <= hi), axis=1)
        fit = ransac_plane(xyz[inside], plane['axis'])
        if fit is None:
            feature.setdefault('failure', []).append(f"{plane['name']}: {int(inside.sum())} candidates")
            return None
        # Second pass: re-centre the normal window on the fitted plane so a 10-20 cm
        # as-built deviation cannot truncate the support.
        n = np.array(fit['normal']); a = plane['axis']
        others = sum(n[k] * guess[k] for k in range(3) if k != a)
        crossing = -(fit['d'] + others) / n[a]
        lo2, hi2 = lo.copy(), hi.copy(); lo2[a] = crossing - 0.05; hi2[a] = crossing + 0.05
        inside = np.all((xyz >= lo2) & (xyz <= hi2), axis=1)
        refit = ransac_plane(xyz[inside], plane['axis'])
        if refit is None:
            feature.setdefault('failure', []).append(f"{plane['name']} refit: {int(inside.sum())} candidates")
            return None
        rows = idx[inside][np.abs(xyz[inside] @ np.array(refit['normal']) + refit['d']) <= 0.006]
        refit['support_rows_sha256'] = hashlib.sha256(np.sort(rows).astype('<i8').tobytes()).hexdigest()
        refit['box_scan'] = [lo2.tolist(), hi2.tolist()]
        planes.append(refit)
        n2 = np.array(refit['normal'])
        guess[a] = -(refit['d'] + sum(n2[k] * guess[k] for k in range(3) if k != a)) / n2[a]
    A = np.array([p['normal'] for p in planes]); b = -np.array([p['d'] for p in planes])
    cond = np.linalg.cond(A)
    if cond > 50:
        feature.setdefault('failure', []).append(f'ill-conditioned intersection {cond:.1f}')
        return None
    point = np.linalg.solve(A, b)
    return {'scan': point.tolist(), 'planes': planes, 'condition': float(cond)}

results = []
measured_count = 0
for feature in features:
    fit = fit_feature(feature, OFFSET)
    row = {**feature, 'partition': None, 'scan': None, 'planes_fit': None, 'status': 'no-fit'}
    if fit:
        row.update(scan=fit['scan'], planes_fit=fit['planes'], condition=fit['condition'], status='ok', coarse_delta=(np.array(fit['scan']) - np.array(feature['ifc']) - OFFSET).round(4).tolist(),
                   partition='fit' if measured_count % 2 == 0 else 'check')
        measured_count += 1
    results.append(row)
    print(f"{feature['id']:28s} {row['status']:6s} ifc={np.round(feature['ifc'],4).tolist()} scan={None if not fit else np.round(fit['scan'],4).tolist()} {feature.get('failure', '') if not fit else 'inliers=' + str([p['inliers'] for p in fit['planes']]) + ' rms_mm=' + str([round(p['rms_m']*1000,1) for p in fit['planes']]) + ' delta=' + str(row['coarse_delta'])}", flush=True)
# Fixed-point check: refit every landmark with the median measured offset in place
# of the coarse one; a landmark that moves by more than 1 mm depended on its box.
ok = [r for r in results if r['status'] == 'ok']
measured = np.median([np.array(r['scan']) - np.array(r['ifc']) for r in ok], axis=0)
drift = []
for r in ok:
    again = fit_feature({k: r[k] for k in ('id', 'kind', 'ifc', 'entities', 'planes')}, measured)
    drift.append(None if again is None else float(np.linalg.norm(np.array(again['scan']) - np.array(r['scan']))))
    r['refit_with_measured_offset_drift_m'] = drift[-1]
report = {
    'ifc': {'file': ifc_path.name, 'sha256': hashlib.sha256(ifc_path.read_bytes()).hexdigest(), 'schema': f.schema, 'ifcopenshell': ifcopenshell.version, 'floor_top_z': FLOOR_TOP},
    'subsets': {name: {'sha256': sha, 'points': int(len(xyz))} for name, (xyz, _, sha) in clouds.items()},
    'coarse_search_offset_scan_minus_ifc': OFFSET.tolist(), 'measured_median_offset_scan_minus_ifc': measured.round(4).tolist(),
    'plane_fit': {'method': 'seeded RANSAC (600 hypotheses) selecting the dominant plane, then 5 least-squares refits on the inliers', 'inlier_threshold_m': 0.006, 'normal_cone_degrees': 30, 'min_support': 20, 'seed': 4381},
    'partition_rule': 'features in the fixed list order above; landmarks that could be measured alternate fit, check, fit, ... starting with fit; frozen here before any solve and never revised against residuals',
    'features': results,
    'summary': {'total': len(results), 'fitted': len(ok), 'fit': sum(1 for r in ok if r['partition'] == 'fit'), 'check': sum(1 for r in ok if r['partition'] == 'check'),
                'max_refit_drift_m': max([d for d in drift if d is not None], default=None)},
}
out_path.write_text(json.dumps(report, indent=1) + '\n')
print(json.dumps(report['summary'], indent=1), 'measured offset', measured.round(4).tolist())
