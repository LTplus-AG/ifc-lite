# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""#7661: finite coverage, exact distance, and conservative localization."""
from fractions import Fraction as Q
import importlib.util
import itertools
from pathlib import Path
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

    def test_7661_positive_triangle_projection_collapse_is_unresolved(self):
        wall = [[0.,0.,0.],[0.,1.,0.],[0.,0.,1.]]
        # This real finite triangle has positive area, but lies edge-on to the
        # first plane's diagnostic projection. Its small X extent admits that
        # plane bin; losing its 2D area must not silently certify coverage.
        sliver = [[0.,0.,0.],[0.,0.,1.],[.000001,0.,0.]]
        with self.assertRaisesRegex(F.CoverageUnresolved,'singular diagnostic projection'):
            adjudicate([wall,sliver],[wall,sliver],[wall])

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
