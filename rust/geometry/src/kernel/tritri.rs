// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Triangle–triangle intersection machinery (L2, M2) — exact, predicate-driven.
//!
//! M2 increment 1: classify a triangle against another's plane (via exact
//! `orient3d`), and construct the edge∩plane intersection points as LPI implicit
//! points. The full intersection segment (interval overlap along the planes'
//! crossing line) and the in-plane re-triangulation build on this.
//!
//! Every intersection point is an LPI carried symbolically over the original
//! input coordinates — never materialised — so downstream predicates stay exact
//! and platform-deterministic.

use super::predicates::orient3d;
use super::{ImplicitPoint, Lpi, Sign};

#[inline]
fn e(p: [f64; 3]) -> ImplicitPoint {
    ImplicitPoint::Explicit(p)
}

/// How a triangle sits relative to another triangle's (supporting) plane.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlaneCross {
    /// All three vertices strictly on one side — the triangles cannot intersect.
    Disjoint,
    /// All three vertices exactly on the plane (coplanar — a 2D-overlap case).
    Coplanar,
    /// Exactly one vertex (`apex`) alone on its side: the two edges from `apex`
    /// cross the plane. This is the proper-crossing case the segment is built from.
    Crosses { apex: usize },
    /// One or two vertices exactly on the plane (vertex/edge contact) — a
    /// degeneracy handled explicitly by a later increment.
    Touches,
}

/// Classify triangle `tri` against the plane through `plane` (its three points),
/// using exact `orient3d` signs of each vertex.
pub fn classify_vs_plane(tri: &[[f64; 3]; 3], plane: &[[f64; 3]; 3]) -> PlaneCross {
    let s = [
        orient3d(&e(plane[0]), &e(plane[1]), &e(plane[2]), &e(tri[0])),
        orient3d(&e(plane[0]), &e(plane[1]), &e(plane[2]), &e(tri[1])),
        orient3d(&e(plane[0]), &e(plane[1]), &e(plane[2]), &e(tri[2])),
    ];
    let zeros = s.iter().filter(|&&x| x == Sign::Zero).count();
    if zeros == 3 {
        return PlaneCross::Coplanar;
    }
    if zeros > 0 {
        return PlaneCross::Touches;
    }
    let pos = s.iter().filter(|&&x| x == Sign::Positive).count();
    if pos == 0 || pos == 3 {
        return PlaneCross::Disjoint;
    }
    // One vertex has the unique sign — that is the apex.
    let apex = if s[0] != s[1] && s[0] != s[2] {
        0
    } else if s[1] != s[0] && s[1] != s[2] {
        1
    } else {
        2
    };
    PlaneCross::Crosses { apex }
}

/// The implicit point where edge `a→b` crosses the plane through `plane`.
#[inline]
pub fn edge_plane_lpi(a: [f64; 3], b: [f64; 3], plane: &[[f64; 3]; 3]) -> Lpi {
    Lpi { p: a, q: b, r: plane[0], s: plane[1], t: plane[2] }
}

/// For a `Crosses { apex }` triangle, the two LPI points where the apex's two
/// edges cross `plane` — the triangle's interval endpoints on the crossing line.
pub fn crossing_lpis(tri: &[[f64; 3]; 3], apex: usize, plane: &[[f64; 3]; 3]) -> [Lpi; 2] {
    let o1 = (apex + 1) % 3;
    let o2 = (apex + 2) % 3;
    [
        edge_plane_lpi(tri[apex], tri[o1], plane),
        edge_plane_lpi(tri[apex], tri[o2], plane),
    ]
}

/// Necessary condition for a proper (segment) intersection: each triangle
/// properly crosses the other's plane. (Coplanar / touching are separate cases.)
pub fn planes_mutually_cross(t1: &[[f64; 3]; 3], t2: &[[f64; 3]; 3]) -> bool {
    matches!(classify_vs_plane(t1, t2), PlaneCross::Crosses { .. })
        && matches!(classify_vs_plane(t2, t1), PlaneCross::Crosses { .. })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ZPLANE: [[f64; 3]; 3] = [[0., 0., 0.], [2., 0., 0.], [0., 2., 0.]]; // z = 0

    #[test]
    fn classify_above_below_crossing_coplanar() {
        let above = [[0., 0., 1.], [1., 0., 1.], [0., 1., 1.]];
        assert_eq!(classify_vs_plane(&above, &ZPLANE), PlaneCross::Disjoint);
        let below = [[0., 0., -1.], [1., 0., -2.], [0., 1., -0.5]];
        assert_eq!(classify_vs_plane(&below, &ZPLANE), PlaneCross::Disjoint);
        let crossing = [[0.3, 0.3, -1.], [0.3, 0.3, 1.], [1., 1., 1.]];
        assert!(matches!(classify_vs_plane(&crossing, &ZPLANE), PlaneCross::Crosses { .. }));
        let coplanar = [[0.1, 0.1, 0.], [1., 0., 0.], [0., 1., 0.]];
        assert_eq!(classify_vs_plane(&coplanar, &ZPLANE), PlaneCross::Coplanar);
    }

    #[test]
    fn apex_is_the_odd_vertex_out() {
        // verts at z = -1, +1, +1  -> apex 0
        let t = [[0.5, 0.5, -1.], [0., 0., 1.], [1., 0., 1.]];
        assert_eq!(classify_vs_plane(&t, &ZPLANE), PlaneCross::Crosses { apex: 0 });
        // z = +1, -1, +1  -> apex 1
        let t = [[0., 0., 1.], [0.5, 0.5, -1.], [1., 0., 1.]];
        assert_eq!(classify_vs_plane(&t, &ZPLANE), PlaneCross::Crosses { apex: 1 });
    }

    #[test]
    fn edge_crossing_lpi_lies_exactly_on_the_plane() {
        // The defining property: orient3d(LPI, plane[0], plane[1], plane[2]) == 0
        // (the edge∩plane point is coplanar with the plane). This ties the M2
        // construction to the M1 exact LPI-orient3d.
        let lpi = edge_plane_lpi([0.5, 0.5, -1.], [0.5, 0.5, 3.], &ZPLANE);
        assert_eq!(
            orient3d(&ImplicitPoint::Lpi(lpi), &e(ZPLANE[0]), &e(ZPLANE[1]), &e(ZPLANE[2])),
            Sign::Zero,
            "edge∩plane LPI is not exactly on the plane"
        );
        // tilted plane + tilted edge
        let tilted = [[0., 0., 1.], [3., 0., 2.], [0., 3., 2.]];
        let lpi2 = edge_plane_lpi([1., 1., 0.], [1.5, 0.5, 5.], &tilted);
        assert_eq!(
            orient3d(&ImplicitPoint::Lpi(lpi2), &e(tilted[0]), &e(tilted[1]), &e(tilted[2])),
            Sign::Zero,
            "tilted edge∩plane LPI is not exactly on the plane"
        );
    }

    #[test]
    fn crossing_lpis_both_on_plane_and_planes_mutually_cross() {
        // Two triangles that properly skewer each other (no vertex on the
        // other's plane — that would be the deferred `Touches` case).
        let t1 = [[-2., 0., -1.], [2., 0., -1.], [0., 0., 2.]]; // plane y=0
        let t2 = [[1., -2., 1.], [1., 2., 1.], [1., 0.5, -3.]]; // plane x=1
        // both planes mutually cross
        assert!(planes_mutually_cross(&t1, &t2));
        // each apex's two crossing LPIs lie on the other plane
        if let PlaneCross::Crosses { apex } = classify_vs_plane(&t1, &t2) {
            for lpi in crossing_lpis(&t1, apex, &t2) {
                assert_eq!(
                    orient3d(&ImplicitPoint::Lpi(lpi), &e(t2[0]), &e(t2[1]), &e(t2[2])),
                    Sign::Zero
                );
            }
        } else {
            panic!("expected t1 to cross t2's plane");
        }
    }
}
