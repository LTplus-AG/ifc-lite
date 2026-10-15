#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Pinned #7292 filled-surface comparison: analytic reporter or captured corpus.
Reporter CLI: --candidate <Y-up rawMeshes.json> --slope .02/.05 --output <dir>.
Add --oracle-cache <verified prior directory or compact oracle JSON> to avoid parsing.
Corpus CLI: --mode corpus --fixture <IFC> --base <capture directory> --candidate
<capture directory> --oracle-cache <verified prior output directory> --output <dir>.
Corpus arrays use IFC Z-up metres plus origins in the recorded RTC frame.
Full conformance and localized delta verdicts are separate; no topology claim.
"""
import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path

import ifcopenshell
import ifcopenshell.geom
import shapely
from shapely.geometry import Polygon
from shapely.ops import unary_union

TOL = 1e-4
COMPARATOR_VERSION = 'finite-coverage-v2'
_helper_path = Path(__file__).with_name('finite_coverage.py')
_spec = importlib.util.spec_from_file_location('issue_7661_finite_coverage', _helper_path)
finite = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(finite)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def default_fixture():
    roots = list(Path(__file__).resolve().parents)+[Path.cwd()]+list(Path.cwd().parents)
    root = next((p for p in roots if (p/'Cargo.toml').is_file() and (p/'rust').is_dir()), None)
    if root is None:
        return None
    return root/'rust/geometry/tests/fixtures/issue_7292_sloped_coplanar_difference.ifc'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    data = path.read_bytes()
    return json.loads(data), sha(data)


def save(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + '\n')


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def cross(a, b):
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]


def mesh_data(raw, frame='z-up', element=None):
    if 'rawMeshes' in raw:
        meshes = raw['rawMeshes']
    else:
        meshes = [raw]
    vertices, indices = [], []
    for mesh in meshes:
        if element is not None and mesh.get('expressId', element) != element:
            continue
        positions = mesh.get('positions_native_rtc_frame', mesh.get('positions'))
        origin = mesh.get('origin') or [0, 0, 0]
        if len(positions) % 3 or len(mesh['indices']) % 3:
            raise ValueError('Malformed mesh buffer')
        offset = len(vertices)
        for start in range(0, len(positions), 3):
            p = [positions[start+k]+origin[k] for k in range(3)]
            vertices.append([p[0], -p[2], p[1]] if frame == 'y-up' else p)
        for i in mesh['indices']:
            if not isinstance(i, int) or i < 0 or i*3 >= len(positions):
                raise ValueError('Invalid mesh index')
            indices.append(i+offset)
    if not indices or not all(all(math.isfinite(x) for x in vertices[i]) for i in indices):
        raise ValueError('Missing or nonfinite indexed geometry')
    return vertices, indices


def bounds(data):
    vertices, indices = data
    return [[min(vertices[i][k] for i in indices) for k in range(3)],
            [max(vertices[i][k] for i in indices) for k in range(3)]]


def bound_check(a, b):
    error = max(abs(a[s][k]-b[s][k]) for s in range(2) for k in range(3))
    return {'a': a, 'b': b, 'maximum_error_m': error, 'passed': error <= TOL}


def fixture_at_slope(content, slope):
    """2% bytes unchanged; derive other slope by axes #37/#41 and B z #43..62.
    B z=48+slope*y or128.9+slope*y in mm; footprints/depths/placement unchanged.
    """
    if slope == .02:
        return content
    lines, length = [], math.sqrt(1+slope*slope)
    for line in content.splitlines():
        token = line.split('=', 1)[0]
        entity = int(token[1:]) if token.startswith('#') and token[1:].isdigit() else None
        if entity in (37, 41):
            y = (-1 if entity == 37 else 1)*slope/length
            line = f'#{entity}=IFCDIRECTION((0.000000000000000,{y:.15f},{1/length:.15f}));'
        elif entity is not None and 43 <= entity <= 62:
            x, y, _ = map(float, line.split('((', 1)[1].removesuffix('));').split(','))
            z = (48 if (entity-43) % 2 == 0 else 128.9)+slope*y
            line = f'#{entity}=IFCCARTESIANPOINT(({x:.4f},{y:.4f},{z:.4f}));'
        lines.append(line)
    return '\n'.join(lines)+'\n'


def cached_oracle(path, fixture_hash):
    if path.is_file():
        raw, digest = read(path)
        require(raw['fixture_sha256'] == fixture_hash and raw['ifcopenshell'] == '0.8.5','Oracle fixture hash/engine mismatch')
        return mesh_data(raw), None, {'oracle_file_sha256': digest}, raw, None
    receipt, receipt_hash = read(path/'receipt.json')
    require(receipt['fixture_sha256'] == fixture_hash,'Oracle fixture hash mismatch')
    engines = receipt.get('engines') or {'ifcopenshell': receipt['ifcopenshell'], 'shapely': receipt['shapely']}
    require(engines == {'ifcopenshell': '0.8.5', 'shapely': '2.0.7'},'Oracle engine pins mismatch')
    filename = 'oracle-raw-mesh.json' if (path/'oracle-raw-mesh.json').exists() else 'oracle-triangles.json'
    raw, digest = read(path/filename)
    expected = receipt.get('oracle_raw_mesh_sha256') or receipt.get('oracle_raw_sha256')
    if expected:
        require(digest == expected,'Oracle mesh hash mismatch')
    no_void = read(path/'oracle-no-void-raw-mesh.json')[0] if (path/'oracle-no-void-raw-mesh.json').exists() else None
    if no_void and receipt.get('oracle_no_void_raw_mesh_sha256'):
        require(sha((path/'oracle-no-void-raw-mesh.json').read_bytes()) == receipt['oracle_no_void_raw_mesh_sha256'],'Oracle no-void hash mismatch')
    return mesh_data(raw), mesh_data(no_void) if no_void else None, {'oracle_cache_receipt_sha256': receipt_hash,
            'oracle_file_sha256': digest, 'oracle_no_void_file_sha256':sha((path/'oracle-no-void-raw-mesh.json').read_bytes()) if no_void else None, 'cache_receipt': receipt}, raw, no_void


def triangles(data):
    vertices, indices = data
    rows = []
    for start in range(0, len(indices), 3):
        tri = [vertices[i] for i in indices[start:start+3]]
        exact = finite.rational_triangle(tri)
        n = finite.cross(finite.sub(exact[1],exact[0]),finite.sub(exact[2],exact[0]))
        scale = max(abs(x) for x in n)
        if not scale:  # Exact zero area has no filled two-dimensional surface.
            continue
        normalized = [float(x/scale) for x in n]
        length = math.sqrt(dot(normalized,normalized))
        area = float(scale)*length/2
        require(math.isfinite(area) and area > 0,'Positive triangle area outside representable diagnostic range')
        rows.append((tri,[x/length for x in normalized],area))
    return rows


def plane(normal, offset, expected_area=None, perimeter=None):
    helper = [0., 0., 0.]
    helper[min(range(3), key=lambda k: abs(normal[k]))] = 1.
    u = cross(normal, helper)
    length = math.sqrt(dot(u, u))
    u = [x/length for x in u]
    return {'normal': normal, 'offset': offset, 'u': u, 'v': cross(normal, u),
            'analytic_area': expected_area, 'perimeter': perimeter}


def reporter_planes(slope):
    length = math.sqrt(1+slope*slope)
    y = 1.1/length
    return [plane([1,0,0], x, .054*y, 2*(1.1+.054)) for x in [-3.025,-3]] + [
        plane([0,1,0], x, .025*.054, 2*(.025+.054)) for x in [0,y]] + [
        plane([0,-slope/length,1/length], z/length, .025*1.1, 2*(.025+1.1)) for z in [4.548,4.602]]


def residual(tri, p):
    return max(abs(dot(p['normal'], vertex)-p['offset']) for vertex in tri)


def assigned_plane(tri, normal, area, planes):
    eligible = [k for k,p in enumerate(planes) if residual(tri,p) <= TOL]
    if not eligible:
        raise ValueError(f'Triangle outside all expected boundary planes: {tri}')
    return min(eligible,key=lambda k: (-abs(dot(normal,planes[k]['normal']))*area,residual(tri,planes[k]),k))


def union_groups(datasets, analytic=None):
    rows = {name: triangles(data) for name, data in datasets.items()}
    planes = list(analytic) if analytic else []
    if analytic is None:
        for name in ['oracle','base','candidate']:
            for tri, normal, area in sorted(rows[name], key=lambda item: (-item[2],tuple(tuple(p) for p in item[0]))):
                if not any(residual(tri,p) <= TOL for p in planes):
                    k = max(range(3), key=lambda k: abs(normal[k]))
                    if normal[k] < 0:
                        normal = [-x for x in normal]
                    planes.append(plane(normal,dot(normal,tri[0])))
    polygons = {name: [[] for _ in planes] for name in datasets}
    for name, ts in rows.items():
        for tri, normal, area in ts:
            k = assigned_plane(tri, normal, area, planes)
            p = planes[k]
            poly = Polygon([(dot(p['u'],v),dot(p['v'],v)) for v in tri])
            require(poly.area > 0,'Positive triangle has singular diagnostic projection')
            if not poly.is_valid:
                raise ValueError('Invalid projected triangle')
            polygons[name][k].append(poly)
    return planes, polygons


def compare(a,b):
    missing, extra = a.difference(b.buffer(TOL)), b.difference(a.buffer(TOL))
    return {'symmetric_difference_area_m2': a.symmetric_difference(b).area,
            'missing_beyond_tolerance_area_m2': missing.area,'extra_beyond_tolerance_area_m2':extra.area,
            'missing_beyond_tolerance_wkt':missing.wkt,'extra_beyond_tolerance_wkt':extra.wkt,
            'contained':missing.is_empty and extra.is_empty,
            'boundary_hausdorff_diagnostic_m':float(shapely.hausdorff_distance(a,b,densify=.01)) if not a.is_empty and not b.is_empty else None}


def delta_checks(o,a,b):
    added,removed = b.difference(a.buffer(TOL)),a.difference(b.buffer(TOL))
    bad_added,bad_removed = added.difference(o.buffer(TOL)),removed.intersection(o.buffer(-TOL))
    missing_before,missing_after = o.difference(a.buffer(TOL)),o.difference(b.buffer(TOL))
    excess_before,excess_after = a.difference(o.buffer(TOL)),b.difference(o.buffer(TOL))
    newly_missing = missing_after.difference(missing_before.buffer(TOL))
    newly_excess = excess_after.difference(excess_before.buffer(TOL))
    return {'added_coverage_m2':added.area,'removed_coverage_m2':removed.area,
        'added_not_in_oracle_beyond_tolerance_m2':bad_added.area,
        'removed_oracle_required_inside_tolerance_margin_m2':bad_removed.area,
        'added_not_in_oracle_wkt':bad_added.wkt,'removed_oracle_required_wkt':bad_removed.wkt,
        'newly_missing_oracle_coverage_m2':newly_missing.area,'newly_excess_oracle_coverage_m2':newly_excess.area,
        'newly_missing_oracle_wkt':newly_missing.wkt,'newly_excess_oracle_wkt':newly_excess.wkt,
        'no_new_disagreement':bad_added.is_empty and bad_removed.is_empty and newly_missing.is_empty and newly_excess.is_empty}


def adjudicate(datasets, analytic=None, *, max_work_units=2000000):
    budget = finite.WorkBudget(max_work_units)
    planes, polygons = union_groups(datasets,analytic)
    all_triangles = {name:[tri for tri, _, _ in triangles(data)] for name,data in datasets.items()}
    donors = {name:[[] for _ in planes] for name in datasets}
    for name, data in datasets.items():
        for tri, normal, area in triangles(data):
            donors[name][assigned_plane(tri,normal,area,planes)].append(tri)
    # Only baseline points not proved present at EXACTLY the same candidate
    # positions can introduce new missing coverage. Keeping unresolved zero-
    # distance cells here is conservative: it enlarges the possible change.
    baseline_changed = []
    if 'base' in datasets:
        for k,p in enumerate(planes):
            cells = finite.unresolved_cells(donors['base'][k],all_triangles['candidate'],p,0,budget)
            baseline_changed.extend(tri for cell in cells for tri in finite.lifted_triangles(cell))
    rows = []
    for k,p in enumerate(planes):
        unions = {name:unary_union(items[k]) for name,items in polygons.items()}
        row = {'plane':p,'datasets':{name:{'triangles':len(polygons[name][k]),'area_m2':u.area,
             'summed_area_m2':sum(poly.area for poly in polygons[name][k]),'union_wkt':u.wkt,
             'polygon_sha256':sha(u.wkt.encode())} for name,u in unions.items()}}
        row['oracle_versus_candidate'] = compare(unions['oracle'],unions['candidate'])
        if analytic:
            area = p['analytic_area']
            tolerance = p['perimeter']*TOL+area*1e-6
            row['analytic_area_gate'] = {'expected_area_m2':area,'tolerance_m2':tolerance,
                'passed':abs(unions['oracle'].area-area)<=tolerance and abs(unions['candidate'].area-area)<=tolerance
                and row['oracle_versus_candidate']['symmetric_difference_area_m2']<=tolerance}
        if 'base' in unions:
            o,a,b = [unions[name] for name in ['oracle','base','candidate']]
            row['oracle_versus_base'],row['base_versus_candidate'] = compare(o,a),compare(a,b)
            row['delta'] = delta_checks(o,a,b)
        # Keep the original plane-bin calculations as versioned diagnostics.
        # Acceptance now requires finite 3D certificates across ALL bins.
        row['exclusive_plane_bin_diagnostics'] = {name:row[name] for name in
            ['oracle_versus_candidate','oracle_versus_base','base_versus_candidate','delta'] if name in row}
        unresolved = {}
        for left,right in [('oracle','candidate'),('oracle','base'),('base','candidate')]:
            if left not in datasets or right not in datasets:
                continue
            missing = finite.unresolved_cells(donors[left][k],all_triangles[right],p,TOL,budget)
            extra = finite.unresolved_cells(donors[right][k],all_triangles[left],p,TOL,budget)
            unresolved[left,right] = missing,extra
            row[left+'_versus_'+right] = finite.comparison_result(missing,extra)
        if 'base' in datasets:
            missing,extra = unresolved['oracle','candidate']
            newly_missing = finite.not_proven_absent(missing,baseline_changed,TOL,budget)
            newly_extra = finite.not_exactly_covered(extra,all_triangles['base'],budget)
            row['delta'] = finite.delta_result(newly_missing,newly_extra,unresolved['base','candidate'])
        row['comparator_version'] = COMPARATOR_VERSION
        row['cumulative_exact_work_units'] = budget.used
        rows.append(row)
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode',choices=['reporter','corpus'],default='reporter')
    parser.add_argument('--fixture',type=Path,default=default_fixture())
    parser.add_argument('--prepared-fixture',type=Path,help='Reporter model emitted externally: consume exact supplied bytes without slope transformation')
    parser.add_argument('--candidate',type=Path,required=True)
    parser.add_argument('--base',type=Path)
    parser.add_argument('--oracle-cache',type=Path)
    parser.add_argument('--slope',type=float,choices=(.02,.05),default=.02)
    parser.add_argument('--output',type=Path,default=Path('/tmp/7292-unified-replay'))
    args = parser.parse_args()
    require(ifcopenshell.version=='0.8.5' and shapely.__version__=='2.0.7','Unpinned engines')
    require(args.prepared_fixture is None or args.mode=='reporter','Prepared fixture is a reporter-mode option')
    fixture_path = args.prepared_fixture or args.fixture
    require(fixture_path is not None,'Cannot locate reporter fixture; provide --fixture')
    original = fixture_path.read_bytes()
    fixture = fixture_at_slope(original.decode(),args.slope).encode() if args.mode=='reporter' and args.prepared_fixture is None else original
    fixture_hash = sha(fixture)
    args.output.mkdir(parents=True,exist_ok=True)
    receipt = {'mode':args.mode,'fixture':fixture_path.name,'fixture_input_mode':'prepared exact bytes' if args.prepared_fixture else 'default reporter derivation' if args.mode=='reporter' else 'exact corpus bytes','fixture_sha256':fixture_hash,
        'original_fixture_sha256':sha(original),'script_sha256':sha(Path(__file__).read_bytes()),
        'comparator_version':COMPARATOR_VERSION,'finite_coverage_helper_sha256':sha(_helper_path.read_bytes()),
        'engines':{'ifcopenshell':ifcopenshell.version,'shapely':shapely.__version__},'position_tolerance_m':TOL,
        'limitations':'Unresolved finite coverage fails conservatively; diagnostic areas may include covered points. No multiplicity, topology, closure, or winding claim.'}
    if args.oracle_cache:
        ov,nv,oracle_meta,raw,no_void = cached_oracle(args.oracle_cache,fixture_hash)
    else:
        if args.mode!='reporter':
            raise ValueError('Corpus mode requires retained verified oracle arrays')
        model = ifcopenshell.file.from_string(fixture.decode())
        settings = ifcopenshell.geom.settings()
        settings.set('use-world-coords',True)
        shape = ifcopenshell.geom.create_shape(settings,model.by_id(107))
        raw={'positions':list(shape.geometry.verts),'indices':list(shape.geometry.faces)}
        ov,nv,oracle_meta,no_void = mesh_data(raw),None,{'settings':{'use-world-coords':True}},None
    receipt['oracle_provenance'] = oracle_meta
    save(args.output/'oracle-raw-mesh.json',raw)
    datasets={'oracle':ov}
    if args.mode=='reporter':
        candidate,digest = read(args.candidate)
        if candidate.get('hasRtcOffset',False):
            raise ValueError('Reporter requires zero RTC')
        datasets['candidate']=mesh_data(candidate,'y-up',107)
        receipt.update(candidate=args.candidate.name,candidate_sha256=digest,slope=args.slope,coordinate_frame='Y-up + origin, inverse rotated to IFC Z-up metres; RTC zero')
        length_y = 1.1/math.sqrt(1+args.slope**2)
        frame={'candidate_bounds':bound_check(bounds(datasets['candidate']),[[-3.025,0,4.548],[-3,length_y,4.602+args.slope*length_y]])}
        analytic=reporter_planes(args.slope)
    else:
        cache = oracle_meta['cache_receipt']
        receipt['entity_id']=cache.get('entity_id',cache.get('element_id'))
        analytic=None
        frame={}
        for name,directory in [('base',args.base),('candidate',args.candidate)]:
            capture,capture_hash=read(directory/'receipt.json')
            mesh,mesh_hash=read(directory/'produced-mesh.json')
            require(capture['fixtureSha256']==fixture_hash and capture['rtcOffsetMetres']==cache['rtc_metres'],'Native fixture hash/RTC mismatch')
            require(capture['lengthUnitScale']==cache['unit_scale'],'Native/oracle unit mismatch')
            require('resolvedPlacement' in capture,'Each native capture must supply its own resolved placement')
            placement=capture['resolvedPlacement']
            require(placement['translationAlreadyRtcRebased'] is False,'Native world placement must not already subtract RTC')
            expected=cache['placement'].get('oracle_scaled_matrix') or cache['placement']['oracle_matrix']
            flat=placement['matrixColumnMajor16Metres']
            error=max(abs(expected[i][j]-flat[j*4+i]) for i in range(4) for j in range(4))
            require(error<=TOL,'Resolved placement mismatch')
            datasets[name]=mesh_data(mesh)
            receipt[name]={'capture_sha256':capture_hash,'mesh_sha256':mesh_hash,'variant':capture['variant'],
                           'placement_error':error,'placement':placement,
                           'placement_source':'own capture',
                           'no_void_mesh_sha256':sha((directory/'no-voids-mesh.json').read_bytes())}
            frame[name+'_whole_bounds']=bound_check(bounds(ov),bounds(datasets[name]))
            frame[name+'_no_void_bounds']=bound_check(bounds(nv),bounds(mesh_data(read(directory/'no-voids-mesh.json')[0])))
        receipt.update(rtc_metres=cache['rtc_metres'],unit_scale=cache['unit_scale'],coordinate_frame='IFC Z-up metres + origin, in recorded RTC frame')
    receipt['frame_checks']=frame
    try:
        rows=adjudicate(datasets,analytic)
    except finite.WorkLimit as error:
        receipt.update(passed=False,unresolved=str(error),planes=[],summary={})
        save(args.output/'receipt.json',receipt)
        print(json.dumps({'passed':False,'unresolved':str(error)}))
        return 2
    receipt['planes']=rows
    summary={}
    for label in ['oracle_versus_candidate','oracle_versus_base','base_versus_candidate']:
        if label in rows[0]:
            summary[label]={'contained':all(r[label]['contained'] for r in rows),
              'missing_beyond_tolerance_m2':sum(r[label]['missing_beyond_tolerance_area_m2'] for r in rows),
              'extra_beyond_tolerance_m2':sum(r[label]['extra_beyond_tolerance_area_m2'] for r in rows)}
    if 'base' in datasets:
        summary['delta']={key:sum(r['delta'][key] for r in rows) for key in ['added_coverage_m2','removed_coverage_m2',
            'added_not_in_oracle_beyond_tolerance_m2','removed_oracle_required_inside_tolerance_margin_m2',
            'newly_missing_oracle_coverage_m2','newly_excess_oracle_coverage_m2']}
        summary['localized_delta_passed']=all(r['delta']['no_new_disagreement'] for r in rows)
    passed=all(v['passed'] for v in frame.values()) and summary['oracle_versus_candidate']['contained']
    if analytic:
        passed=passed and all(r['analytic_area_gate']['passed'] for r in rows)
    receipt.update(summary=summary,passed=passed)
    save(args.output/'receipt.json',receipt)
    print(json.dumps({'mode':args.mode,'passed':passed,'planes':len(rows),'summary':summary}))
    return 0 if passed else 1


if __name__=='__main__':
    raise SystemExit(main())
