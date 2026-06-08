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

#[inline]
fn sub_f64(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline]
fn cross_f64(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
#[inline]
fn plane_normal(t: &[[f64; 3]; 3]) -> [f64; 3] {
    cross_f64(sub_f64(t[1], t[0]), sub_f64(t[2], t[0]))
}
/// Approximate direction of the crossing line L = t1.plane ∩ t2.plane (n1 × n2).
/// Only the direction matters — the exact ordering predicate tolerates rounding.
fn line_direction(t1: &[[f64; 3]; 3], t2: &[[f64; 3]; 3]) -> [f64; 3] {
    cross_f64(plane_normal(t1), plane_normal(t2))
}

/// Result of an exact triangle–triangle intersection test.
#[derive(Clone, Debug)]
pub enum TriTri {
    /// No intersection.
    None,
    /// The triangles are coplanar (a 2D-overlap case — handled in `coplanar.rs`).
    Coplanar,
    /// Contact at a single point (a vertex touch) — no cutting segment.
    Point(ImplicitPoint),
    /// The intersection segment; endpoints lie on line L = plane(T1) ∩ plane(T2).
    /// An endpoint is `Explicit` (an on-plane vertex) or `Lpi` (an edge crossing).
    Segment([ImplicitPoint; 2]),
}

#[inline]
fn cmp_along(a: &ImplicitPoint, b: &ImplicitPoint, u: [f64; 3]) -> Sign {
    super::rational::cmp_along(a, b, u)
}

/// A triangle's intersection with another triangle's supporting plane — the
/// generalisation that admits on-plane vertices (Touches), not just clean
/// edge crossings. Every endpoint lies on BOTH planes ⇒ on line L.
enum PlaneInterval {
    /// Triangle strictly on one side — no plane intersection.
    None,
    /// Triangle lies in the plane.
    Coplanar,
    /// Touches the plane at a single vertex only (no chord).
    Point(ImplicitPoint),
    /// A chord (2 on-plane endpoints): 2 edge crossings, vertex + edge crossing,
    /// or an on-plane edge.
    Chord([ImplicitPoint; 2]),
}

fn plane_interval(tri: &[[f64; 3]; 3], plane: &[[f64; 3]; 3]) -> PlaneInterval {
    let s = [
        orient3d(&e(plane[0]), &e(plane[1]), &e(plane[2]), &e(tri[0])),
        orient3d(&e(plane[0]), &e(plane[1]), &e(plane[2]), &e(tri[1])),
        orient3d(&e(plane[0]), &e(plane[1]), &e(plane[2]), &e(tri[2])),
    ];
    let zeros: Vec<usize> = (0..3).filter(|&i| s[i] == Sign::Zero).collect();
    match zeros.len() {
        3 => PlaneInterval::Coplanar,
        2 => PlaneInterval::Chord([e(tri[zeros[0]]), e(tri[zeros[1]])]), // an on-plane edge
        1 => {
            let vz = zeros[0];
            let (o1, o2) = ((vz + 1) % 3, (vz + 2) % 3);
            if s[o1] == s[o2] {
                PlaneInterval::Point(e(tri[vz])) // both others same side: single vertex touch
            } else {
                // the far edge crosses: chord [on-plane vertex, edge∩plane]
                PlaneInterval::Chord([e(tri[vz]), ImplicitPoint::Lpi(edge_plane_lpi(tri[o1], tri[o2], plane))])
            }
        }
        _ => {
            let pos = s.iter().filter(|&&x| x == Sign::Positive).count();
            if pos == 0 || pos == 3 {
                PlaneInterval::None
            } else {
                let apex = if s[0] != s[1] && s[0] != s[2] {
                    0
                } else if s[1] != s[0] && s[1] != s[2] {
                    1
                } else {
                    2
                };
                let [a, b] = crossing_lpis(tri, apex, plane);
                PlaneInterval::Chord([ImplicitPoint::Lpi(a), ImplicitPoint::Lpi(b)])
            }
        }
    }
}

/// Exact triangle–triangle intersection: the overlap of each triangle's
/// plane-interval along line L = `[max(lo1,lo2), min(hi1,hi2)]`. Handles clean
/// crossings AND Touches (on-plane vertices/edges). Coplanar is deferred to
/// `coplanar.rs`; a single shared point returns `Point` (no cut).
pub fn tri_tri_intersection(t1: &[[f64; 3]; 3], t2: &[[f64; 3]; 3]) -> TriTri {
    use PlaneInterval as PI;
    let (i1, i2) = (plane_interval(t1, t2), plane_interval(t2, t1));
    let ends = |pi: &PI| -> Option<[ImplicitPoint; 2]> {
        match pi {
            PI::Point(p) => Some([p.clone(), p.clone()]),
            PI::Chord([a, b]) => Some([a.clone(), b.clone()]),
            _ => None,
        }
    };
    if matches!(i1, PI::Coplanar) || matches!(i2, PI::Coplanar) {
        return TriTri::Coplanar;
    }
    let ([a1, b1], [a2, b2]) = match (ends(&i1), ends(&i2)) {
        (Some(s1), Some(s2)) => (s1, s2),
        _ => return TriTri::None,
    };
    let u = line_direction(t1, t2);
    let order = |a: ImplicitPoint, b: ImplicitPoint| {
        if cmp_along(&a, &b, u) == Sign::Positive {
            (b, a)
        } else {
            (a, b)
        }
    };
    let (lo1, hi1) = order(a1, b1);
    let (lo2, hi2) = order(a2, b2);
    let lo = if cmp_along(&lo1, &lo2, u) == Sign::Positive { lo1 } else { lo2 };
    let hi = if cmp_along(&hi1, &hi2, u) == Sign::Negative { hi1 } else { hi2 };
    match cmp_along(&lo, &hi, u) {
        Sign::Positive => TriTri::None,           // intervals disjoint
        Sign::Zero => TriTri::Point(lo),          // a single shared point
        Sign::Negative => TriTri::Segment([lo, hi]),
    }
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

    #[test]
    fn proper_crossing_yields_segment_on_both_planes() {
        let t1 = [[-2., 0., -1.], [2., 0., -1.], [0., 0., 2.]]; // plane y=0
        let t2 = [[1., -2., 1.], [1., 2., 1.], [1., 0.5, -3.]]; // plane x=1
        match tri_tri_intersection(&t1, &t2) {
            TriTri::Segment([a, b]) => {
                // The two endpoints are distinct (a non-degenerate segment).
                assert_ne!(
                    super::cmp_along(&a, &b, super::line_direction(&t1, &t2)),
                    Sign::Zero,
                    "segment collapsed to a point"
                );
                // Every segment endpoint lies on BOTH triangles' planes (on L).
                for ep in [&a, &b] {
                    assert_eq!(
                        orient3d(ep, &e(t1[0]), &e(t1[1]), &e(t1[2])),
                        Sign::Zero,
                        "segment endpoint off t1's plane"
                    );
                    assert_eq!(
                        orient3d(ep, &e(t2[0]), &e(t2[1]), &e(t2[2])),
                        Sign::Zero,
                        "segment endpoint off t2's plane"
                    );
                }
            }
            other => panic!("expected a segment, got {other:?}"),
        }
    }

    #[test]
    fn touches_vertex_on_plane_yields_segment_with_explicit_endpoint() {
        // M1: t2 crosses t1's plane (y=0) but with ONE vertex EXACTLY on it.
        let t1 = [[-2., 0., -1.], [2., 0., -1.], [0., 0., 2.]]; // plane y=0
        let t2 = [[0., 0., 0.5], [0.5, -1., 0.5], [0.5, 1., 0.5]]; // v0 at y=0, in plane z=0.5
        match tri_tri_intersection(&t1, &t2) {
            TriTri::Segment([a, b]) => {
                // exactly one endpoint is the Explicit on-plane vertex (0,0,0.5)
                let explicits = [&a, &b]
                    .iter()
                    .filter(|p| matches!(p, ImplicitPoint::Explicit(_)))
                    .count();
                assert_eq!(explicits, 1, "expected one Explicit (on-plane vertex) endpoint");
                // both endpoints lie on BOTH planes (on L)
                for ep in [&a, &b] {
                    assert_eq!(orient3d(ep, &e(t1[0]), &e(t1[1]), &e(t1[2])), Sign::Zero);
                    assert_eq!(orient3d(ep, &e(t2[0]), &e(t2[1]), &e(t2[2])), Sign::Zero);
                }
            }
            other => panic!("Touches case should yield a Segment, got {other:?}"),
        }
    }

    #[test]
    fn planes_cross_but_intervals_disjoint_is_none() {
        let t1 = [[-2., 0., -1.], [2., 0., -1.], [0., 0., 2.]]; // y=0, crosses x=1 at z∈[-1,0.5]
        let t2 = [[1., -2., 5.], [1., 2., 5.], [1., 0.5, 9.]]; // x=1, crosses y=0 at z∈[5,8.2]
        assert!(planes_mutually_cross(&t1, &t2)); // both planes DO cross
        assert!(
            matches!(tri_tri_intersection(&t1, &t2), TriTri::None),
            "disjoint intervals along L should give no intersection"
        );
    }
}
