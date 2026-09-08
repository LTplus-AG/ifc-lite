// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for [`super`] — triangle-triangle intersection. Split out of
//! tritri.rs so that file stays under the module-size rule.

use super::*;

const ZPLANE: [[f64; 3]; 3] = [[0., 0., 0.], [2., 0., 0.], [0., 2., 0.]]; // z = 0

/// Approximate f64 coordinates of an [`ImplicitPoint`], for asserting WHERE
/// a segment endpoint actually lands (not just that it is on-plane) — the
/// on-plane-only checks below cannot distinguish the true overlap interval
/// from e.g. an accidentally inverted lo/hi selection, since a wrong-but-
/// still-on-both-planes point passes them just as well.
fn approx(p: &ImplicitPoint) -> [f64; 3] {
    match p {
        ImplicitPoint::Explicit(c) => *c,
        ImplicitPoint::Lpi(l) => {
            let sub = |a: [f64; 3], b: [f64; 3]| [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
            let cross = |a: [f64; 3], b: [f64; 3]| {
                [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
            };
            let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
            let n = cross(sub(l.s, l.r), sub(l.t, l.r));
            let d = sub(l.q, l.p);
            let t = dot(n, sub(l.r, l.p)) / dot(n, d);
            [l.p[0] + t * d[0], l.p[1] + t * d[1], l.p[2] + t * d[2]]
        }
        ImplicitPoint::Tpi(_) => panic!("unexpected Tpi in a triangle-triangle segment endpoint"),
    }
}

#[test]
fn edge_crossing_lpi_lies_exactly_on_the_plane() {
    // The defining property: orient3d(LPI, plane[0], plane[1], plane[2]) == 0
    // (the edge∩plane point is coplanar with the plane). This ties the LPI
    // construction to the exact LPI-orient3d predicate.
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
            // L = plane(y=0) ∩ plane(x=1) = the line {x=1, y=0, z free}.
            // t1's chord on L spans z ∈ [-1, 0.5] (edges AB and BC);
            // t2's chord on L spans z ∈ [-2.2, 1] (edges DE and DF).
            // Overlap is z ∈ [-1, 0.5] — the ACTUAL interval, not just "some
            // pair of on-plane points". A lo/hi selection bug (e.g. picking
            // the union's outer bound instead of the overlap's inner bound)
            // still produces two distinct, on-both-planes points and would
            // pass every assertion above while landing at the wrong z.
            let mut zs = [approx(&a)[2], approx(&b)[2]];
            zs.sort_by(|x, y| x.partial_cmp(y).unwrap());
            assert!(
                (zs[0] - (-1.0)).abs() < 1e-9 && (zs[1] - 0.5).abs() < 1e-9,
                "expected overlap interval z ∈ [-1, 0.5], got z ∈ [{}, {}]",
                zs[0],
                zs[1]
            );
            for ep in [&a, &b] {
                let p = approx(ep);
                assert!((p[0] - 1.0).abs() < 1e-9 && p[1].abs() < 1e-9, "endpoint off L: {p:?}");
            }
        }
        other => panic!("expected a segment, got {other:?}"),
    }
}

#[test]
fn touches_vertex_on_plane_yields_segment_with_explicit_endpoint() {
    // t2 crosses t1's plane (y=0) but with ONE vertex EXACTLY on it.
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
    // both planes DO cross (checked via tri_tri_intersection's own plane_interval
    // path below); the disjoint-intervals-along-L outcome is the real assertion.
    assert!(
        matches!(tri_tri_intersection(&t1, &t2), TriTri::None),
        "disjoint intervals along L should give no intersection"
    );
}
