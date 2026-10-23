# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""#7661: finite coverage, exact distance, and conservative localization."""
from fractions import Fraction as Q
import importlib.util
import itertools
import json
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('surface_comparison',
    ROOT/'docs/architecture/evidence/issue-7292/compare_surface.py')
C = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(C)
F = C.finite


def mesh(tris):
    return [p for tri in tris for p in tri],list(range(3*len(tris)))


def horizontal(z=0,x=0):
    return [[x,0,z],[x+1,0,z],[x,1,z]]


def adjudicate(oracle,base,candidate):
    rows = C.adjudicate(dict(oracle=mesh(oracle),base=mesh(base),candidate=mesh(candidate)))
    return (all(r['oracle_versus_candidate']['contained'] for r in rows),
            all(r['delta']['no_new_disagreement'] for r in rows))


class FiniteCoverage(unittest.TestCase):
    def test_7732_engine_update_refuses_stale_surface_cache(self):
        raw = {'positions':[v for p in horizontal() for v in p], 'indices':[0,1,2],
               'fixture_sha256':'fixture', 'ifcopenshell':'different-engine-version'}
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            compact = folder/'compact.json'
            compact.write_text(json.dumps(raw))
            with self.assertRaisesRegex(ValueError, 'Oracle fixture hash/engine mismatch'):
                C.cached_oracle(compact, 'fixture')
            content = json.dumps(raw).encode()
            (folder/'oracle-raw-mesh.json').write_bytes(content)
            receipt = {'fixture_sha256':'fixture',
                       'engines':{'ifcopenshell':'different-engine-version', 'shapely':'2.0.7'},
                       'oracle_raw_mesh_sha256':hashlib.sha256(content).hexdigest()}
            (folder/'receipt.json').write_text(json.dumps(receipt))
            with self.assertRaisesRegex(ValueError, 'Oracle engine pins mismatch'):
                C.cached_oracle(folder, 'fixture')

    def test_7661_corpus_cli_requires_no_void_oracle_before_native_frame_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            fixture = C.default_fixture()
            raw = {'positions':[v for p in horizontal() for v in p],'indices':[0,1,2]}
            content = json.dumps(raw).encode()
            (folder/'oracle-raw-mesh.json').write_bytes(content)
            receipt = {'fixture_sha256':hashlib.sha256(fixture.read_bytes()).hexdigest(),
                       'engines':{'ifcopenshell':C.ifcopenshell.version,'shapely':'2.0.7'},
                       'oracle_raw_mesh_sha256':hashlib.sha256(content).hexdigest()}
            (folder/'receipt.json').write_text(json.dumps(receipt))
            result = subprocess.run([sys.executable,'-B',str(ROOT/'docs/architecture/evidence/issue-7292/compare_surface.py'),
                '--mode','corpus','--fixture',str(fixture),'--oracle-cache',str(folder),
                '--base',str(folder/'missing-base'),'--candidate',str(folder/'missing-candidate'),
                '--output',str(folder/'result')],capture_output=True,text=True,timeout=120)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('Corpus oracle cache requires a verified no-void mesh',result.stderr)
            self.assertFalse((folder/'result/receipt.json').exists())

    def test_7661_full_finite_comparison_without_baseline(self):
        oracle = mesh([horizontal()])
        for candidate,expected in [(oracle,True),(mesh([horizontal(x=2)]),False)]:
            with self.subTest(contained=expected):
                try:
                    rows = C.adjudicate({'oracle':oracle,'candidate':candidate})
                except KeyError as error:
                    self.fail(f'Full finite comparison must accept an absent baseline: {error}')
                self.assertTrue(rows)
                self.assertEqual(all(r['oracle_versus_candidate']['contained'] for r in rows),expected)
                self.assertTrue(all('delta' not in r for r in rows))

    def test_7661_directory_cache_requires_matching_mesh_hash(self):
        raw = {'positions':[v for p in horizontal() for v in p],'indices':[0,1,2]}
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            content = json.dumps(raw).encode()
            (folder/'oracle-raw-mesh.json').write_bytes(content)
            digest = hashlib.sha256(content).hexdigest()
            receipt = {'fixture_sha256':'fixture','engines':{'ifcopenshell':C.ifcopenshell.version,'shapely':'2.0.7'}}
            for field in ['oracle_raw_mesh_sha256','oracle_raw_sha256']:
                for expected in [None,'','0'*64,digest]:
                    with self.subTest(field=field,expected=expected):
                        recorded = dict(receipt)
                        if expected is not None:
                            recorded[field] = expected
                        (folder/'receipt.json').write_text(json.dumps(recorded))
                        if expected == digest:
                            oracle,_,provenance,_,_ = C.cached_oracle(folder,'fixture')
                            self.assertEqual(oracle,mesh([horizontal()]))
                            self.assertEqual(provenance['oracle_file_sha256'],digest)
                        else:
                            with self.assertRaisesRegex(ValueError,'Oracle mesh hash'):
                                C.cached_oracle(folder,'fixture')
                recorded = {**receipt,field:digest}
                (folder/'receipt.json').write_text(json.dumps(recorded))
                (folder/'oracle-raw-mesh.json').write_bytes(content+b' ')
                with self.assertRaisesRegex(ValueError,'Oracle mesh hash'):
                    C.cached_oracle(folder,'fixture')
                (folder/'oracle-raw-mesh.json').write_bytes(content)

    def test_7661_directory_cache_requires_matching_consumed_no_void_hash(self):
        raw = {'positions':[v for p in horizontal() for v in p],'indices':[0,1,2]}
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            content = json.dumps(raw).encode()
            digest = hashlib.sha256(content).hexdigest()
            for name in ['oracle-raw-mesh.json','oracle-no-void-raw-mesh.json']:
                (folder/name).write_bytes(content)
            receipt = {'fixture_sha256':'fixture','engines':{'ifcopenshell':C.ifcopenshell.version,'shapely':'2.0.7'},
                       'oracle_raw_mesh_sha256':digest}
            for expected in [None,'','0'*64,digest]:
                with self.subTest(expected=expected):
                    recorded = dict(receipt)
                    if expected is not None:
                        recorded['oracle_no_void_raw_mesh_sha256'] = expected
                    (folder/'receipt.json').write_text(json.dumps(recorded))
                    if expected == digest:
                        _,no_void,provenance,_,_ = C.cached_oracle(folder,'fixture')
                        self.assertEqual(no_void,mesh([horizontal()]))
                        self.assertEqual(provenance['oracle_no_void_file_sha256'],digest)
                    else:
                        with self.assertRaisesRegex(ValueError,'Oracle no-void hash'):
                            C.cached_oracle(folder,'fixture')
            (folder/'receipt.json').write_text(json.dumps({**receipt,'oracle_no_void_raw_mesh_sha256':digest}))
            (folder/'oracle-no-void-raw-mesh.json').write_bytes(content+b' ')
            with self.assertRaisesRegex(ValueError,'Oracle no-void hash'):
                C.cached_oracle(folder,'fixture')
            (folder/'oracle-no-void-raw-mesh.json').write_bytes(b'null')
            for expected,message in [(None,'Oracle no-void hash'),
                                     (hashlib.sha256(b'null').hexdigest(),'Malformed oracle no-void mesh')]:
                with self.subTest(nullHash=expected):
                    recorded = dict(receipt)
                    if expected is not None:
                        recorded['oracle_no_void_raw_mesh_sha256'] = expected
                    (folder/'receipt.json').write_text(json.dumps(recorded))
                    with self.assertRaisesRegex(ValueError,message):
                        C.cached_oracle(folder,'fixture')

    def test_7661_reporter_cli_default_fixture(self):
        # An actual reporter mesh in viewer coordinates exercises default
        # fixture discovery, frame conversion and the CLI receipt. This does
        # not certify native CSG: its candidate comes from the pinned oracle.
        model = C.ifcopenshell.open(str(C.default_fixture()))
        settings = C.ifcopenshell.geom.settings()
        settings.set('use-world-coords',True)
        shape = C.ifcopenshell.geom.create_shape(settings,model.by_id(107))
        xyz = list(shape.geometry.verts)
        candidate = {'expressId':107,'indices':list(shape.geometry.faces),
                     'positions':[v for i in range(0,len(xyz),3)
                                  for v in [xyz[i],xyz[i+2],-xyz[i+1]]]}
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder/'candidate.json').write_text(json.dumps(candidate))
            result = subprocess.run([sys.executable,'-B',str(ROOT/
                'docs/architecture/evidence/issue-7292/compare_surface.py'),
                '--candidate',str(folder/'candidate.json'),'--output',str(folder/'result')],
                cwd=ROOT,capture_output=True,text=True,check=False,timeout=300)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            receipt = json.loads((folder/'result/receipt.json').read_text())
            self.assertTrue(receipt['passed'])
            self.assertEqual(len(receipt['planes']),6)

    def test_7723_legacy_cache_is_explicitly_unverified_not_boolean_proof(self):
        raw = {'positions':[v for p in horizontal() for v in p],'indices':[0,1,2],
               'fixture_sha256':'fixture','ifcopenshell':C.ifcopenshell.version}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'legacy.json'
            path.write_text(json.dumps(raw))
            actual,_,provenance,_,_ = C.cached_oracle(path,'fixture')
            self.assertEqual(actual,mesh([horizontal()]))
            self.assertEqual(provenance['reference_validation']['status'],'UNVERIFIED_LEGACY_CACHE')

    def test_7723_explicit_invalid_cache_refused_despite_valid_hash_and_arrays(self):
        raw = {'positions':[v for p in horizontal() for v in p],'indices':[0,1,2],
               'fixture_sha256':'fixture','ifcopenshell':C.ifcopenshell.version}
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            compact = folder/'compact.json'
            compact.write_text(json.dumps({**raw,'reference_status':'INVALID_OR_UNRESOLVED'}))
            with self.assertRaisesRegex(ValueError,'Explicit invalid reference cache'):
                C.cached_oracle(compact,'fixture')
            content = json.dumps(raw).encode()
            (folder/'oracle-raw-mesh.json').write_bytes(content)
            receipt = {'fixture_sha256':'fixture','engines':{'ifcopenshell':C.ifcopenshell.version,'shapely':'2.0.7'},
                       'oracle_raw_mesh_sha256':hashlib.sha256(content).hexdigest(),
                       'reference_validation':{'status':'INVALID_REFERENCE'}}
            (folder/'receipt.json').write_text(json.dumps(receipt))
            with self.assertRaisesRegex(ValueError,'Explicit invalid reference cache'):
                C.cached_oracle(folder,'fixture')

    def test_7661_perpendicular_edge_and_order(self):
        t = [[0.,0.,0.],[1.,0.,0.],[0.,0.,1.]]
        r = [[0.,2.,0.],[0.,3.,0.],[0.,2.,1.]]
        d = [[0.,0.,0.],[0.,3e-6,0.],[0.,0.,1.]]
        for order in itertools.permutations([t,r,d]):
            with self.subTest(order=order):
                self.assertEqual(adjudicate(list(order),list(order),[t,r]),(True,True))

    def test_7661_split_target_same_finite_union(self):
        t = [[0.,0.,0.],[1.,0.,0.],[0.,0.,1.]]
        split = [[t[0],t[1],[0.,0.,.5]],[t[1],t[2],[0.,0.,.5]]]
        r = [[0.,2.,0.],[0.,3.,0.],[0.,2.,1.]]
        d = [[0.,0.,0.],[0.,3e-6,0.],[0.,0.,1.]]
        for order in itertools.permutations(split+[r]):
            self.assertEqual(adjudicate([t,r,d],[t,r,d],list(order)),(True,True))

    def test_7661_exact_boundary_and_beyond(self):
        for distance,expected in [(C.TOL,True),(.000100001,False)]:
            with self.subTest(distance=distance):
                self.assertEqual(adjudicate([horizontal()],[horizontal()],[horizontal(distance)]),
                                 (expected,expected))

    def test_7661_no_second_tolerance_in_localization(self):
        self.assertEqual(adjudicate([horizontal()],[horizontal(.000099)],
                                    [horizontal(.000198)]),(False,False))

    def test_7661_opposite_offsets_do_not_share_bin_tolerance(self):
        self.assertEqual(adjudicate([horizontal(.000099)],[horizontal(.000099)],
                                    [horizontal(-.000099)]),(False,False))

    def test_7661_unchanged_preexisting_error_is_localized_pass(self):
        self.assertEqual(adjudicate([horizontal()],[horizontal(.000198)],
                                    [horizontal(.000198)]),(False,True))

    def test_7661_wrong_finite_extent_and_deleted_island(self):
        for candidate in [[horizontal(x=2)],[horizontal()]]:
            oracle = [horizontal(),horizontal(x=4)]
            self.assertEqual(adjudicate(oracle,oracle,candidate),(False,False))

    def test_7661_separate_nearby_vertices_leave_interior_uncovered(self):
        donor = horizontal()
        targets = [[[x,y,0],[x+.00001,y,0],[x,y+.00001,0]] for x,y,_ in donor]
        self.assertEqual(adjudicate([donor],[donor],targets),(False,False))

    def test_7661_interior_hole(self):
        # Three corner triangles preserve every original corner; the central
        # triangle is a finite hole far larger than the positional allowance.
        a,b,c = horizontal()
        ab,bc,ca = [(.5,0,0),(.5,.5,0),(0,.5,0)]
        self.assertEqual(adjudicate([[a,b,c]],[[a,b,c]],
                                    [[a,ab,ca],[ab,b,bc],[ca,bc,c]]),(False,False))

    def test_exact_partition_preserves_area(self):
        source = [(Q(0),Q(0)),(Q(1),Q(0)),(Q(0),Q(1))]
        region = [(Q(1,4),Q(-1)),(Q(2),Q(-1)),(Q(2),Q(2)),(Q(1,4),Q(2))]
        inside,outside = F.partition(source,region)
        self.assertEqual(abs(F.area2(source)),abs(F.area2(inside))+sum(abs(F.area2(p)) for p in outside))

    def test_triangle_distance_detects_face_piercing(self):
        a = F.rational_triangle([[.2,.2,-1],[.2,.2,1],[2,2,1]])
        b = F.rational_triangle(horizontal())
        result = F.triangle_pair(a,b)
        self.assertTrue(result['resolved'])
        self.assertEqual(result['distanceSquared'],0)
        self.assertGreater(result['featureOnlyMinimumSquared'],0)

    def test_7661_tiny_positive_area_cannot_disappear(self):
        oracle = [horizontal(),horizontal(1)]
        tiny = [[.25,.25,.5],[.2500000001,.25,.5],[.25,.2500000001,.5]]
        self.assertEqual(adjudicate(oracle,oracle,oracle+[tiny]),(False,False))
        self.assertEqual(C.bounds(mesh(oracle)),C.bounds(mesh(oracle+[tiny])))

    def test_parallel_segment_avoids_parameter_shadowing(self):
        # Oblique geometry exercises nonzero endpoint heights distinct from
        # loop indices; the first real-model prototype exposed this bug.
        a = F.rational_triangle([[0,0,2],[1,0,2],[0,1,2]])
        b = F.rational_triangle(horizontal())
        self.assertEqual(F.triangle_pair(a,b)['distanceSquared'],4)

    def test_7661_exhausted_work_is_unresolved(self):
        data = {name:mesh([horizontal()]) for name in ['oracle','base','candidate']}
        with self.assertRaisesRegex(F.WorkLimit,'unresolved'):
            C.adjudicate(data,max_work_units=0)

    def test_7661_live_cell_exhaustion_is_unresolved(self):
        # A partially overlapping finite target leaves a real source remainder.
        # Lower the supported diagnostic bound to exercise exhaustion cheaply.
        budget = F.WorkBudget(max_live_cells=0)
        with self.assertRaisesRegex(F.WorkLimit,'live-cell.*unresolved'):
            F.unresolved_cells([horizontal()],[horizontal(x=.5)],
                               {'u':[1,0,0],'v':[0,1,0]},C.TOL,budget)

    def test_7721_thin_perpendicular_union_survives_different_triangulation(self):
        wall = [[0.,0.,0.],[0.,2.,0.],[0.,0.,2.]]
        thin = [[0.,3.,0.],[.000001,3.,0.],[0.,4.,0.]]
        midpoint = [0.,3.5,0.]
        split = [[thin[0],thin[1],midpoint],[thin[1],thin[2],midpoint]]
        # #7721: plane distance alone admits this horizontal donor to the
        # vertical wall bin. Both surfaces must retain their positive charts.
        for oracle in [[wall,thin],[thin,wall]]:
            for candidate in [[wall]+split,split+[wall]]:
                with self.subTest(oracle=oracle,candidate=candidate):
                    rows = C.adjudicate({'oracle':mesh(oracle),'candidate':mesh(candidate)})
                    self.assertTrue(all(r['oracle_versus_candidate']['contained'] for r in rows))
                    self.assertEqual(sum(r['datasets']['oracle']['triangles'] for r in rows),2)
                    self.assertEqual(sum(r['datasets']['candidate']['triangles'] for r in rows),3)
                    self.assertEqual(adjudicate(oracle,oracle,candidate),(True,True))

    def test_7721_perpendicular_positive_donor_is_not_discarded(self):
        wall = [[0.,0.,0.],[0.,2.,0.],[0.,0.,2.]]
        thin = [[0.,3.,0.],[.000001,3.,0.],[0.,4.,0.]]
        # The thin donor is near the INFINITE wall plane but over a metre
        # from the finite wall. Losing its singular projection must not pass.
        self.assertEqual(adjudicate([wall,thin],[wall,thin],[wall]),(False,False))

    def test_7721_actual_92642_positive_donor_gets_a_nonsingular_chart(self):
        thin = [[63.93844223022461,40.69706344604492,2.7300000190734863],
                [63.93844223022461,40.69703674316406,2.7300000190734863],
                [63.84844207763672,40.69706344604492,2.7300000190734863]]
        exact = F.rational_triangle(thin)
        self.assertEqual(F.cross(F.sub(exact[1],exact[0]),F.sub(exact[2],exact[0])),
                         (0,0,-Q(165151,68719476736)))
        y = 40.6970360544
        wall = [[60.,y,0.],[70.,y,0.],[60.,y,10.]]
        rows = C.adjudicate({'oracle':mesh([wall,thin]),'candidate':mesh([wall,thin])})
        self.assertTrue(all(r['oracle_versus_candidate']['contained'] for r in rows))
        self.assertEqual(sum(r['datasets']['candidate']['triangles'] for r in rows),2)

    def test_7661_positive_triangle_projection_collapse_is_unresolved(self):
        wall = [[0.,0.,0.],[0.,1.,0.],[0.,0.,1.]]
        # This real finite triangle has positive area, but lies edge-on to the
        # first plane's diagnostic projection. Its small X extent admits that
        # plane bin; losing its 2D area must not silently certify coverage.
        sliver = [[0.,0.,0.],[0.,0.,1.],[.000001,0.,0.]]
        # #7721: corpus discovery can add a faithful donor chart. Fixed
        # analytic reporter planes remain fixed and must still refuse if
        # none can represent a positive donor without collapsing it.
        with self.assertRaisesRegex(F.CoverageUnresolved,'singular diagnostic projection'):
            C.adjudicate({'oracle':mesh([wall,sliver]),'candidate':mesh([wall])},
                         analytic=[C.plane([1.,0.,0.],0.)])

    def test_7661_positive_area_outside_float_range_is_unresolved(self):
        for edge in [1e200,1e-200]:
            with self.subTest(edge=edge), self.assertRaisesRegex(F.CoverageUnresolved,'diagnostic range'):
                C.triangles(mesh([[[0.,0.,0.],[edge,0.,0.],[0.,edge,0.]]]))

    def test_7661_baseline_absence_requires_strict_finite_distance(self):
        cell = ([(Q(0),Q(0)),(Q(1),Q(0)),(Q(0),Q(1))],
                [(Q(0),Q(0)),(Q(1),Q(0)),(Q(0),Q(1))],
                F.rational_triangle(horizontal()))
        self.assertTrue(F.not_proven_absent([cell],[horizontal(C.TOL)],C.TOL))
        self.assertFalse(F.not_proven_absent([cell],[horizontal(.000100001)],C.TOL))


if __name__ == '__main__':
    unittest.main()
