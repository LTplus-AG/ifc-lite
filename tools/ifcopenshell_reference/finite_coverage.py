# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Conservative finite-triangle coverage certificates for #7661.

Projection discovers pieces; only exact 3D certificates credit coverage. Each
piece must fit the closed distance neighborhood of ONE finite triangle. That
neighborhood is convex, so all polygon vertices certify its entire interior.
Failure to certify is unresolved coverage, never evidence of conformance.
"""
from fractions import Fraction as Q

from shapely.geometry import MultiPoint, Polygon
from shapely.ops import unary_union


class CoverageUnresolved(ValueError):
    """Finite coverage cannot be certified with the diagnostic representation."""


class WorkLimit(CoverageUnresolved):
    """Acceptance remains unresolved when exact arithmetic exhausts its bound."""


class WorkBudget:
    def __init__(self, limit=2000000, max_live_cells=4096):
        self.remaining = limit
        self.used = 0
        self.max_live_cells = max_live_cells

    def charge(self, count=1, points=()):
        self.remaining -= count
        self.used += count
        if self.remaining < 0:
            raise WorkLimit('Finite coverage work limit exhausted: unresolved')
        for point in points:
            for coordinate in point:
                value = Q(coordinate)
                if max(value.numerator.bit_length(),value.denominator.bit_length()) > 16384:
                    raise WorkLimit('Finite coverage rational size limit exhausted: unresolved')


def sub(a, b):
    return tuple(x-y for x, y in zip(a, b))


def dot(a, b):
    return sum(x*y for x, y in zip(a, b))


def cross(a, b):
    return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])


def segment_distance_squared(p, a, b):
    d = sub(b, a)
    length = dot(d, d)
    t = max(Q(0), min(Q(1), dot(sub(p, a), d)/length)) if length else Q(0)
    r = tuple(p[k]-a[k]-t*d[k] for k in range(3))
    return dot(r, r)


def triangle_distance_squared(p, triangle):
    a, b, c = triangle
    normal = cross(sub(b, a), sub(c, a))
    nn = dot(normal, normal)
    if nn:
        h = dot(sub(p, a), normal)
        foot = tuple(p[k]-normal[k]*h/nn for k in range(3))
        if all(dot(cross(sub(triangle[(i+1) % 3], triangle[i]),
                         sub(foot, triangle[i])), normal) >= 0 for i in range(3)):
            return h*h/nn
    return min(segment_distance_squared(p, triangle[i], triangle[(i+1) % 3]) for i in range(3))


def rational_triangle(triangle):
    return tuple(tuple(Q(x) for x in p) for p in triangle)


def affine_lift(uv, projected, donor):
    """Exact inverse of the affine parameterization through rounded 2D corners.

    This maps the whole parameter triangle onto the ACTUAL donor triangle;
    representative support planes and their tolerance never enter the lift.
    """
    a, b, c = projected
    x, y = sub(uv, a)
    bx, by = sub(b, a)
    cx, cy = sub(c, a)
    determinant = bx*cy-by*cx
    if not determinant:
        raise CoverageUnresolved('Singular donor parameterization')
    s, t = (x*cy-y*cx)/determinant, (bx*y-by*x)/determinant
    return tuple(donor[0][k]+s*(donor[1][k]-donor[0][k])+t*(donor[2][k]-donor[0][k]) for k in range(3))


def certified(points, target, tolerance_squared):
    return all(triangle_distance_squared(p, target) <= tolerance_squared for p in points)


def possibly_near(donor, target, tolerance):
    # Exact boxes also avoid false rejection at floating exponent boundaries.
    return all(min(p[k] for p in donor) <= max(p[k] for p in target)+tolerance
               and min(p[k] for p in target) <= max(p[k] for p in donor)+tolerance
               for k in range(3))


def area2(poly):
    return sum(a[0]*b[1]-a[1]*b[0] for a, b in zip(poly, poly[1:]+poly[:1]))


def half_plane(poly, a, b, inside):
    def side(p):
        return (b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0])
    result = []
    for p, q in zip(poly, poly[1:]+poly[:1]):
        sp, sq = side(p), side(q)
        keep_p, keep_q = (sp >= 0, sq >= 0) if inside else (sp <= 0, sq <= 0)
        if keep_p:
            result.append(p)
        if keep_p != keep_q:
            t = sp/(sp-sq)
            result.append(tuple(p[k]+t*(q[k]-p[k]) for k in range(2)))
    return result if len(result) >= 3 and area2(result) else []


def partition(poly, region):
    """Exact, exhaustive partition by a convex discovery polygon."""
    if area2(region) < 0:
        region = list(reversed(region))
    outside, inside = [], poly
    for a, b in zip(region, region[1:]+region[:1]):
        fragment = half_plane(inside, a, b, False)
        if fragment:
            outside.append(fragment)
        inside = half_plane(inside, a, b, True)
        if not inside:
            break
    return inside, outside


def projected_triangle(donor, plane):
    return [tuple(Q(dot(axis, p)) for axis in (plane['u'], plane['v'])) for p in donor]


def unresolved_cells(donors, targets, plane, tolerance, budget=None):
    """Exact partition; float geometry ONLY proposes convex discovery regions.

    Every surviving cell remains unresolved, even if its diagnostic floating
    polygon has zero area. No GEOS union/empty decision can certify coverage.
    """
    budget = budget if budget is not None else WorkBudget()
    tolerance_squared = Q(tolerance)**2
    budget.charge(len(targets))
    ordered_targets = sorted(targets,key=lambda t:tuple(sorted(tuple(p) for p in t)))
    exact_targets = [(t, rational_triangle(t)) for t in ordered_targets]
    remaining = []
    for donor in donors:
        budget.charge(points=donor)
        exact_donor = rational_triangle(donor)
        projected = projected_triangle(donor, plane)
        if not area2(projected):
            raise CoverageUnresolved('Nonzero donor has singular projected area')
        rest = [projected]
        for target, exact_target in exact_targets:
            budget.charge(points=target)
            if not possibly_near(exact_donor, exact_target, Q(tolerance)):
                continue
            if certified(exact_donor, exact_target, tolerance_squared):
                rest = []
                break
            footprint = MultiPoint([tuple(dot(axis, p) for axis in (plane['u'], plane['v']))
                                    for p in target]).convex_hull
            for region in (footprint, footprint.buffer(tolerance/2, quad_segs=2)):
                if region.geom_type != 'Polygon' or region.is_empty:
                    continue
                boundary = [tuple(Q(x) for x in uv) for uv in list(region.exterior.coords)[:-1]]
                next_rest = []
                for cell in rest:
                    budget.charge(len(cell)+len(boundary),points=cell)
                    inside, outside = partition(cell, boundary)
                    lifted = [affine_lift(uv, projected, exact_donor) for uv in inside]
                    budget.charge(len(lifted),points=lifted)
                    if inside and certified(lifted, exact_target, tolerance_squared):
                        next_rest.extend(outside)
                    else:
                        next_rest.append(cell)
                if len(next_rest) > budget.max_live_cells:
                    raise WorkLimit('Finite coverage live-cell limit exhausted: unresolved')
                rest = next_rest
                if not rest:
                    break
            if not rest:
                break
        remaining.extend((cell, projected, exact_donor) for cell in rest)
    return remaining


def cell_geometry(cells):
    # Areas/WKT are diagnostics. Authoritative coverage is exact cell count.
    return unary_union([Polygon([(float(x), float(y)) for x, y in cell]) for cell, _, _ in cells])


def segment_pair_distance(a, b, c, d):
    candidates = [segment_distance_squared(a,c,d),segment_distance_squared(b,c,d),
                  segment_distance_squared(c,a,b),segment_distance_squared(d,a,b)]
    u,v,w = sub(b,a),sub(d,c),sub(a,c)
    aa,bb,cc,dd,ee = dot(u,u),dot(u,v),dot(v,v),dot(u,w),dot(v,w)
    determinant = aa*cc-bb*bb
    if determinant:
        s,t = (bb*ee-cc*dd)/determinant,(aa*ee-bb*dd)/determinant
        if 0 <= s <= 1 and 0 <= t <= 1:
            r = tuple(w[k]+u[k]*s-v[k]*t for k in range(3))
            candidates.append(dot(r,r))
    return min(candidates)


def orient2(a,b,c):
    return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])


def inside_triangle2(p,triangle):
    signs = [orient2(triangle[i],triangle[(i+1)%3],p) for i in range(3)]
    return all(x >= 0 for x in signs) or all(x <= 0 for x in signs)


def segments_intersect2(a,b,c,d):
    o1,o2,o3,o4 = orient2(a,b,c),orient2(a,b,d),orient2(c,d,a),orient2(c,d,b)
    if o1*o2 < 0 and o3*o4 < 0:
        return True
    def on(p,start,end):
        return orient2(start,end,p) == 0 and all(min(start[k],end[k]) <= p[k] <= max(start[k],end[k]) for k in range(2))
    return ((o1 == 0 and on(c,a,b)) or (o2 == 0 and on(d,a,b)) or
            (o3 == 0 and on(a,c,d)) or (o4 == 0 and on(b,c,d)))


def segment_hits_triangle(a,b,triangle):
    normal = cross(sub(triangle[1],triangle[0]),sub(triangle[2],triangle[0]))
    height_a,height_b = dot(sub(a,triangle[0]),normal),dot(sub(b,triangle[0]),normal)
    if height_a*height_b > 0:
        return False
    axis = max(range(3),key=lambda i:abs(normal[i]))
    def project(p):
        return tuple(p[i] for i in range(3) if i != axis)
    projected = [project(p) for p in triangle]
    if height_a == height_b == 0:
        aa,bb = project(a),project(b)
        return (inside_triangle2(aa,projected) or inside_triangle2(bb,projected) or
                any(segments_intersect2(aa,bb,projected[i],projected[(i+1)%3]) for i in range(3)))
    t = height_a/(height_a-height_b)
    point = tuple(a[k]+(b[k]-a[k])*t for k in range(3))
    return inside_triangle2(project(point),projected)


def triangle_pair(a,b):
    for triangle in (a,b):
        n = cross(sub(triangle[1],triangle[0]),sub(triangle[2],triangle[0]))
        if not dot(n,n):
            return {'resolved':False,'lowerBoundSquared':Q(0)}
    hit = any(segment_hits_triangle(triangle[i],triangle[(i+1)%3],other)
              for triangle,other in [(a,b),(b,a)] for i in range(3))
    vertices = [triangle_distance_squared(p,other) for triangle,other in [(a,b),(b,a)] for p in triangle]
    edges = [segment_pair_distance(a[i],a[(i+1)%3],b[j],b[(j+1)%3]) for i in range(3) for j in range(3)]
    feature_minimum = min(vertices+edges)
    return {'resolved':True,'distanceSquared':Q(0) if hit else feature_minimum,
            'finiteIntersection':hit,'featureOnlyMinimumSquared':feature_minimum}


def lifted_triangles(cell):
    polygon, projected, donor = cell
    points = [affine_lift(uv, projected, donor) for uv in polygon]
    return [(points[0], points[i], points[i+1]) for i in range(1,len(points)-1)]


def not_proven_absent(cells, baseline, tolerance, budget=None):
    """Only genuine, whole-piece baseline absence may excuse a missing piece."""
    budget = budget if budget is not None else WorkBudget()
    targets = [rational_triangle(t) for t in baseline]
    threshold = Q(tolerance)**2
    unresolved = []
    for cell in cells:
        absent = True
        for triangle in lifted_triangles(cell):
            for target in targets:
                budget.charge(54,points=triangle)
                result = triangle_pair(triangle,target)
                if not result['resolved'] or result['distanceSquared'] <= threshold:
                    absent = False
                    break
            if not absent:
                break
        if not absent:
            unresolved.append(cell)
    return unresolved


def not_exactly_covered(cells, baseline, budget=None):
    """Identical baseline surface points cannot be newly introduced excess.

    Zero distance is essential: crediting a second tolerance here could turn
    oracle z=0/base z=99µm/candidate z=198µm into a localized false PASS.
    """
    budget = budget if budget is not None else WorkBudget()
    unresolved = []
    for cell in cells:
        covered = True
        for triangle in lifted_triangles(cell):
            n = cross(sub(triangle[1],triangle[0]),sub(triangle[2],triangle[0]))
            if not dot(n,n):
                continue
            axis = max(range(3),key=lambda k:abs(n[k]))
            axes = [tuple(int(k==i) for k in range(3)) for i in range(3) if i != axis]
            if unresolved_cells([triangle],baseline,{'u':axes[0],'v':axes[1]},0,budget):
                covered = False
                break
        if not covered:
            unresolved.append(cell)
    return unresolved


def comparison_result(missing,extra):
    a,b = cell_geometry(missing),cell_geometry(extra)
    return {'contained':not missing and not extra,
            'missing_beyond_tolerance_area_m2':a.area,'extra_beyond_tolerance_area_m2':b.area,
            'missing_beyond_tolerance_wkt':a.wkt,'extra_beyond_tolerance_wkt':b.wkt,
            'unresolved_missing_cells':len(missing),'unresolved_extra_cells':len(extra),
            'coverage_contract':'Exact finite 3D certificates; unresolved cells fail conservatively.'}


def delta_result(missing,extra,base_candidate):
    a,b = cell_geometry(missing),cell_geometry(extra)
    removed,added = map(cell_geometry,base_candidate)
    return {'added_coverage_m2':added.area,'removed_coverage_m2':removed.area,
            'added_not_in_oracle_beyond_tolerance_m2':b.area,
            'removed_oracle_required_inside_tolerance_margin_m2':a.area,
            'added_not_in_oracle_wkt':b.wkt,'removed_oracle_required_wkt':a.wkt,
            'newly_missing_oracle_coverage_m2':a.area,'newly_excess_oracle_coverage_m2':b.area,
            'newly_missing_oracle_wkt':a.wkt,'newly_excess_oracle_wkt':b.wkt,
            'no_new_disagreement':not missing and not extra,
            'unresolved_missing_cells':len(missing),'unresolved_extra_cells':len(extra),
            'localization_contract':'Missing: proved baseline absence. Excess: exact baseline coverage. Uncertainty fails.'}
